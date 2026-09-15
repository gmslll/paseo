import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  MANAGED_RUNTIME_COMPLETE_MARKER,
  MANAGED_RUNTIME_METADATA_FILE,
  type ManagedRuntimeArtifact,
  type ManagedRuntimeInstallMetadata,
  ManagedRuntimeInstallMetadataSchema,
  type ManagedRuntimePin,
  managedRuntimeMetadataMatchesPin,
} from "@getpaseo/protocol/managed-runtimes";

import { probeExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";
import { writeFileAtomic, writeJsonFileAtomic } from "../atomic-file.js";
import {
  type ManagedRuntimePaths,
  runtimeCommandLinkPath,
  runtimeInstallDirectory,
  runtimeVersionsDirectory,
} from "./runtime-paths.js";

const ARCHIVE_LIST_MAX_BUFFER_BYTES = 16 * 1_048_576;
const ARCHIVE_COMMAND_TIMEOUT_MS = 120_000;

export interface ManagedRuntimeArtifactSource {
  open(artifact: ManagedRuntimeArtifact, signal?: AbortSignal): Promise<Readable>;
}

export class ManagedRuntimeIntegrityError extends Error {
  constructor(
    public readonly runtimeName: string,
    public readonly check: "sha256" | "size",
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`${runtimeName} artifact ${check} mismatch: expected ${expected}, received ${actual}`);
    this.name = "ManagedRuntimeIntegrityError";
  }
}

export class ManagedRuntimeArchiveEntryError extends Error {
  constructor(
    public readonly runtimeName: string,
    public readonly entry: string,
  ) {
    super(`${runtimeName} archive entry escapes the install directory: ${entry}`);
    this.name = "ManagedRuntimeArchiveEntryError";
  }
}

export class ManagedRuntimeCommandError extends Error {
  constructor(
    public readonly runtimeName: string,
    public readonly command: string,
    public readonly reason: "missing" | "not_executable" | "node_too_old",
  ) {
    super(`${runtimeName} command ${command} failed verification: ${reason}`);
    this.name = "ManagedRuntimeCommandError";
  }
}

export class ManagedRuntimeInstallInProgressError extends Error {
  constructor(
    public readonly runtimeName: string,
    public readonly ownerPid: number,
  ) {
    super(`${runtimeName} is already being installed by process ${ownerPid}`);
    this.name = "ManagedRuntimeInstallInProgressError";
  }
}

export type InstalledRuntimeState =
  | { state: "installed"; commandPath: string; metadata: ManagedRuntimeInstallMetadata }
  | { state: "mismatch" }
  | { state: "missing" };

export async function readInstalledRuntime(input: {
  paths: ManagedRuntimePaths;
  pin: ManagedRuntimePin;
  artifact: ManagedRuntimeArtifact;
}): Promise<InstalledRuntimeState> {
  const installDirectory = runtimeInstallDirectory(input.paths, {
    runtimeName: input.pin.runtimeName,
    version: input.pin.version,
    platformArch: input.artifact.platformArch,
  });
  if (!(await pathExists(path.join(installDirectory, MANAGED_RUNTIME_COMPLETE_MARKER)))) {
    return { state: "missing" };
  }
  let metadata: ManagedRuntimeInstallMetadata;
  try {
    const raw = await readFile(path.join(installDirectory, MANAGED_RUNTIME_METADATA_FILE), "utf8");
    metadata = ManagedRuntimeInstallMetadataSchema.parse(JSON.parse(raw));
  } catch {
    return { state: "mismatch" };
  }
  if (!managedRuntimeMetadataMatchesPin({ metadata, pin: input.pin, artifact: input.artifact })) {
    return { state: "mismatch" };
  }
  return {
    state: "installed",
    commandPath: path.join(installDirectory, input.artifact.command),
    metadata,
  };
}

export interface InstallManagedRuntimeInput {
  paths: ManagedRuntimePaths;
  pin: ManagedRuntimePin;
  artifact: ManagedRuntimeArtifact;
  source: ManagedRuntimeArtifactSource;
  installSource: ManagedRuntimeInstallMetadata["source"];
  policyVersion: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface InstalledManagedRuntime {
  installDirectory: string;
  commandPath: string;
  linkPath: string;
  metadata: ManagedRuntimeInstallMetadata;
}

export async function installManagedRuntime(
  input: InstallManagedRuntimeInput,
): Promise<InstalledManagedRuntime> {
  const { paths, pin, artifact } = input;
  const runtimeName = pin.runtimeName;
  const installDirectory = runtimeInstallDirectory(paths, {
    runtimeName,
    version: pin.version,
    platformArch: artifact.platformArch,
  });
  const linkPath = runtimeCommandLinkPath(paths, runtimeName);

  const existing = await readInstalledRuntime({ paths, pin, artifact });
  if (existing.state === "installed") {
    await linkRuntimeCommand(linkPath, existing.commandPath);
    return {
      installDirectory,
      commandPath: existing.commandPath,
      linkPath,
      metadata: existing.metadata,
    };
  }

  await mkdir(paths.downloads, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireInstallLock(runtimeName, paths.downloads);
  const archivePath = path.join(paths.downloads, `${artifact.sha256}.archive`);
  const stagingDirectory = path.join(
    paths.downloads,
    `${runtimeName}-${randomBytes(8).toString("hex")}.staging`,
  );
  try {
    await removeInterruptedInstalls(runtimeName, paths.downloads);
    await downloadVerifiedArchive({ runtimeName, artifact, archivePath, input });
    if (artifact.archiveFormat !== "raw") {
      for (const entry of await listArchiveEntries(artifact, archivePath)) {
        assertSafeArchiveEntry(runtimeName, entry);
      }
    }
    await mkdir(stagingDirectory, { recursive: true });
    await extractArchive(artifact, archivePath, stagingDirectory);
    await assertTreeStaysInside(runtimeName, stagingDirectory);
    await verifyCommand(runtimeName, stagingDirectory, artifact);

    const metadata = ManagedRuntimeInstallMetadataSchema.parse({
      schemaVersion: 1,
      runtimeName,
      runtimeVersion: pin.version,
      platformArch: artifact.platformArch,
      command: artifact.command,
      archiveSha256: artifact.sha256,
      archiveSize: artifact.sizeBytes,
      ...(artifact.minNodeVersion ? { minNodeVersion: artifact.minNodeVersion } : {}),
      installedAt: (input.now?.() ?? new Date()).toISOString(),
      source: input.installSource,
      policyVersion: input.policyVersion,
    });
    await writeJsonFileAtomic(path.join(stagingDirectory, MANAGED_RUNTIME_METADATA_FILE), metadata);
    await writeFile(
      path.join(stagingDirectory, MANAGED_RUNTIME_COMPLETE_MARKER),
      `${metadata.installedAt}\n`,
    );

    // Only an incomplete or mismatched install of this exact version reaches this point.
    await rm(installDirectory, { recursive: true, force: true });
    await mkdir(path.dirname(installDirectory), { recursive: true });
    await rename(stagingDirectory, installDirectory);

    const commandPath = path.join(installDirectory, artifact.command);
    await linkRuntimeCommand(linkPath, commandPath);
    return { installDirectory, commandPath, linkPath, metadata };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(archivePath, { force: true });
    await releaseLock();
  }
}

export async function listInstalledRuntimeVersions(
  paths: ManagedRuntimePaths,
  runtimeName: string,
): Promise<string[]> {
  try {
    const entries = await readdir(runtimeVersionsDirectory(paths, runtimeName), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
}

export async function removeUnusedRuntimeVersions(input: {
  paths: ManagedRuntimePaths;
  runtimeName: string;
  keepVersions: ReadonlySet<string>;
}): Promise<string[]> {
  const removed: string[] = [];
  for (const version of await listInstalledRuntimeVersions(input.paths, input.runtimeName)) {
    if (input.keepVersions.has(version)) continue;
    await rm(path.join(runtimeVersionsDirectory(input.paths, input.runtimeName), version), {
      recursive: true,
      force: true,
    });
    removed.push(version);
  }
  return removed;
}

async function downloadVerifiedArchive(params: {
  runtimeName: string;
  artifact: ManagedRuntimeArtifact;
  archivePath: string;
  input: InstallManagedRuntimeInput;
}): Promise<void> {
  const { runtimeName, artifact, archivePath, input } = params;
  const hash = createHash("sha256");
  let receivedBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > artifact.sizeBytes) {
        callback(
          new ManagedRuntimeIntegrityError(
            runtimeName,
            "size",
            String(artifact.sizeBytes),
            `more than ${artifact.sizeBytes}`,
          ),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const partialPath = `${archivePath}.partial`;
  try {
    await pipeline(
      await input.source.open(artifact, input.signal),
      meter,
      createWriteStream(partialPath, { mode: 0o600 }),
      { signal: input.signal },
    );
    if (receivedBytes !== artifact.sizeBytes) {
      throw new ManagedRuntimeIntegrityError(
        runtimeName,
        "size",
        String(artifact.sizeBytes),
        String(receivedBytes),
      );
    }
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) {
      throw new ManagedRuntimeIntegrityError(runtimeName, "sha256", artifact.sha256, digest);
    }
    await rename(partialPath, archivePath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}

async function listArchiveEntries(
  artifact: ManagedRuntimeArtifact,
  archivePath: string,
): Promise<string[]> {
  const listing =
    artifact.archiveFormat === "zip"
      ? await execCommand("unzip", ["-Z1", archivePath], archiveCommandOptions())
      : await execCommand("tar", ["-tzf", archivePath], archiveCommandOptions());
  return listing.stdout.split("\n").filter((line) => line.length > 0);
}

async function extractArchive(
  artifact: ManagedRuntimeArtifact,
  archivePath: string,
  stagingDirectory: string,
): Promise<void> {
  switch (artifact.archiveFormat) {
    case "tar.gz":
      await execCommand("tar", ["-xzf", archivePath, "-C", stagingDirectory], {
        timeout: ARCHIVE_COMMAND_TIMEOUT_MS,
      });
      return;
    case "zip":
      await execCommand("unzip", ["-q", archivePath, "-d", stagingDirectory], {
        timeout: ARCHIVE_COMMAND_TIMEOUT_MS,
      });
      return;
    case "raw": {
      const target = path.join(stagingDirectory, artifact.command);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(archivePath, target);
      return;
    }
  }
}

function archiveCommandOptions() {
  return { timeout: ARCHIVE_COMMAND_TIMEOUT_MS, maxBuffer: ARCHIVE_LIST_MAX_BUFFER_BYTES };
}

function assertSafeArchiveEntry(runtimeName: string, entry: string): void {
  const normalized = entry.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new ManagedRuntimeArchiveEntryError(runtimeName, entry);
  }
}

// Archive listings cannot show where a symlink points, so walk the extracted tree as well.
async function assertTreeStaysInside(runtimeName: string, root: string): Promise<void> {
  const rootRealPath = await realpath(root);
  const pending = [rootRealPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(directory, await readlink(entryPath));
        if (!isInsideDirectory(rootRealPath, target)) {
          throw new ManagedRuntimeArchiveEntryError(
            runtimeName,
            path.relative(rootRealPath, entryPath),
          );
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
}

async function verifyCommand(
  runtimeName: string,
  stagingDirectory: string,
  artifact: ManagedRuntimeArtifact,
): Promise<void> {
  const commandPath = path.join(stagingDirectory, artifact.command);
  const commandStat = await stat(commandPath).catch(() => null);
  if (!commandStat?.isFile()) {
    throw new ManagedRuntimeCommandError(runtimeName, artifact.command, "missing");
  }
  if (artifact.launcher === "node") {
    if (
      artifact.minNodeVersion &&
      !nodeVersionAtLeast(process.versions.node, artifact.minNodeVersion)
    ) {
      throw new ManagedRuntimeCommandError(runtimeName, artifact.command, "node_too_old");
    }
    return;
  }
  await chmod(commandPath, 0o755);
  if (!(await probeExecutable(commandPath))) {
    throw new ManagedRuntimeCommandError(runtimeName, artifact.command, "not_executable");
  }
}

async function linkRuntimeCommand(linkPath: string, commandPath: string): Promise<void> {
  if (process.platform === "win32") {
    await writeFileAtomic(`${linkPath}.cmd`, `@"${commandPath}" %*\r\n`);
    return;
  }
  await mkdir(path.dirname(linkPath), { recursive: true });
  const temporaryLink = `${linkPath}.${randomBytes(6).toString("hex")}.tmp`;
  await symlink(commandPath, temporaryLink);
  try {
    await rename(temporaryLink, linkPath);
  } catch (error) {
    await rm(temporaryLink, { force: true });
    throw error;
  }
}

async function acquireInstallLock(
  runtimeName: string,
  downloadsDirectory: string,
): Promise<() => Promise<void>> {
  const lockPath = path.join(downloadsDirectory, `${runtimeName}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => rm(lockPath, { force: true });
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
      const ownerPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        throw new ManagedRuntimeInstallInProgressError(runtimeName, ownerPid);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new ManagedRuntimeInstallInProgressError(runtimeName, 0);
}

async function removeInterruptedInstalls(
  runtimeName: string,
  downloadsDirectory: string,
): Promise<void> {
  for (const entry of await readdir(downloadsDirectory)) {
    const interruptedStaging = entry.startsWith(`${runtimeName}-`) && entry.endsWith(".staging");
    if (interruptedStaging || entry.endsWith(".archive.partial")) {
      await rm(path.join(downloadsDirectory, entry), { recursive: true, force: true });
    }
  }
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function nodeVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrnoCode(error, "EPERM");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return (await stat(filePath).catch(() => null)) !== null;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
