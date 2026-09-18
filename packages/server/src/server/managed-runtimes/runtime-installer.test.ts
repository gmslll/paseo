import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  ManagedRuntimeArtifact,
  ManagedRuntimePin,
} from "@getpaseo/protocol/managed-runtimes";

import {
  ManagedRuntimeArchiveEntryError,
  type ManagedRuntimeArtifactSource,
  ManagedRuntimeInstallInProgressError,
  ManagedRuntimeIntegrityError,
  installManagedRuntime,
  listInstalledRuntimeVersions,
  readInstalledRuntime,
  removeUnusedRuntimeVersions,
} from "./runtime-installer.js";
import { type ManagedRuntimePaths, managedRuntimePaths } from "./runtime-paths.js";
import {
  type TestArchiveEntry,
  createTestTarGz,
  sha256Hex,
  versionScript,
} from "./test-archive.js";

const PLATFORM_ARCH = "darwin-arm64";
let paseoHome: string;
let paths: ManagedRuntimePaths;

beforeEach(async () => {
  paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-runtime-"));
  paths = managedRuntimePaths(paseoHome);
});

afterEach(async () => {
  await rm(paseoHome, { recursive: true, force: true });
});

interface Fixture {
  pin: ManagedRuntimePin;
  artifact: ManagedRuntimeArtifact;
  source: ManagedRuntimeArtifactSource & { opens: number };
}

function fixture(input: {
  entries?: readonly TestArchiveEntry[];
  bytes?: Buffer;
  archiveFormat?: ManagedRuntimeArtifact["archiveFormat"];
  command?: string;
  version?: string;
  declaredSha256?: string;
  declaredSize?: number;
}): Fixture {
  const bytes =
    input.bytes ??
    createTestTarGz(
      input.entries ?? [
        { name: "bin/", type: "directory" },
        { name: "bin/claude", content: versionScript("2.1.258 (Claude Code)"), mode: 0o755 },
      ],
    );
  const artifact: ManagedRuntimeArtifact = {
    platformArch: PLATFORM_ARCH,
    fileName: "claude.tar.gz",
    archiveFormat: input.archiveFormat ?? "tar.gz",
    sha256: input.declaredSha256 ?? sha256Hex(bytes),
    sizeBytes: input.declaredSize ?? bytes.length,
    command: input.command ?? "bin/claude",
    launcher: "exec",
  };
  const source = {
    opens: 0,
    async open() {
      source.opens += 1;
      return Readable.from([bytes]);
    },
  };
  return {
    pin: {
      runtimeName: "claude-code",
      version: input.version ?? "2.1.258",
      providerIds: ["claude"],
      artifacts: [artifact],
    },
    artifact,
    source,
  };
}

function install(f: Fixture) {
  return installManagedRuntime({
    paths,
    pin: f.pin,
    artifact: f.artifact,
    source: f.source,
    installSource: "local_policy",
    policyVersion: 7,
    now: () => new Date("2026-09-16T00:00:00.000Z"),
  });
}

async function exists(filePath: string): Promise<boolean> {
  return (await stat(filePath).catch(() => null)) !== null;
}

describe("installManagedRuntime", () => {
  test("installs a verified archive, links the command, and records matching metadata", async () => {
    const f = fixture({});

    const installed = await install(f);

    expect(installed.installDirectory).toBe(
      path.join(paseoHome, "runtimes", "claude-code", "2.1.258", PLATFORM_ARCH),
    );
    expect(installed.metadata).toMatchObject({
      runtimeName: "claude-code",
      runtimeVersion: "2.1.258",
      archiveSha256: f.artifact.sha256,
      source: "local_policy",
      policyVersion: 7,
    });
    expect(await readlink(installed.linkPath)).toBe(installed.commandPath);
    expect(execFileSync(installed.linkPath, ["--version"]).toString()).toContain("2.1.258");
    expect(await readInstalledRuntime({ paths, pin: f.pin, artifact: f.artifact })).toMatchObject({
      state: "installed",
      commandPath: installed.commandPath,
    });
    expect(await exists(paths.downloads)).toBe(true);
    expect(await listInstalledRuntimeVersions(paths, "claude-code")).toEqual(["2.1.258"]);
  });

  test("a second install of the same pin reuses the install without downloading", async () => {
    const f = fixture({});
    await install(f);

    await install(f);

    expect(f.source.opens).toBe(1);
  });

  test("rejects a SHA-256 mismatch and leaves no install or partial archive", async () => {
    const f = fixture({ declaredSha256: "0".repeat(64) });

    await expect(install(f)).rejects.toBeInstanceOf(ManagedRuntimeIntegrityError);

    expect(await exists(path.join(paths.root, "claude-code"))).toBe(false);
    expect(
      (await readdirNames(paths.downloads)).filter((name) => name.includes("archive")),
    ).toEqual([]);
  });

  test("stops reading once the stream exceeds the declared size", async () => {
    const f = fixture({});
    const oversized = fixture({ declaredSize: 16, declaredSha256: f.artifact.sha256 });

    await expect(install(oversized)).rejects.toMatchObject({
      name: "ManagedRuntimeIntegrityError",
      check: "size",
    });
  });

  test("rejects an archive entry that names a parent directory before extracting", async () => {
    const f = fixture({
      entries: [
        { name: "bin/claude", content: versionScript("1"), mode: 0o755 },
        { name: "../escaped.txt", content: "outside" },
      ],
    });

    await expect(install(f)).rejects.toBeInstanceOf(ManagedRuntimeArchiveEntryError);
    expect(await exists(path.join(paths.root, "escaped.txt"))).toBe(false);
    expect(await exists(path.join(paths.downloads, "escaped.txt"))).toBe(false);
  });

  test("rejects a symlink that points outside the install directory", async () => {
    const f = fixture({
      entries: [
        { name: "bin/claude", content: versionScript("1"), mode: 0o755 },
        { name: "bin/outside", type: "symlink", linkName: "../../../../outside" },
      ],
    });

    await expect(install(f)).rejects.toBeInstanceOf(ManagedRuntimeArchiveEntryError);
    expect(await exists(path.join(paths.root, "claude-code"))).toBe(false);
  });

  test("installs a raw artifact at its command path", async () => {
    const script = Buffer.from(versionScript("0.153.4"));
    const f = fixture({ bytes: script, archiveFormat: "raw", command: "codex" });

    const installed = await install(f);

    expect(execFileSync(installed.commandPath, ["--version"]).toString()).toContain("0.153.4");
  });

  test("clears an interrupted install left by a crashed daemon", async () => {
    const f = fixture({});
    await mkdir(path.join(paths.downloads, "claude-code-deadbeef.staging", "bin"), {
      recursive: true,
    });
    await writeFile(path.join(paths.downloads, `${"a".repeat(64)}.archive.partial`), "partial");

    await install(f);

    expect(await readdirNames(paths.downloads)).toEqual([]);
  });

  test("refuses to start while a live process holds the install lock", async () => {
    const f = fixture({});
    await mkdir(paths.downloads, { recursive: true });
    await writeFile(path.join(paths.downloads, "claude-code.lock"), String(process.pid));

    await expect(install(f)).rejects.toBeInstanceOf(ManagedRuntimeInstallInProgressError);
    expect(f.source.opens).toBe(0);
  });

  test("reclaims a lock left by a process that no longer exists", async () => {
    const f = fixture({});
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]),
    );
    await mkdir(paths.downloads, { recursive: true });
    await writeFile(path.join(paths.downloads, "claude-code.lock"), String(deadPid));

    await install(f);

    expect(await readFile(path.join(paths.bin, "claude-code")).catch(() => null)).not.toBeNull();
  });
});

describe("removeUnusedRuntimeVersions", () => {
  test("removes only versions outside the keep set", async () => {
    await install(fixture({ version: "1.0.0" }));
    await install(fixture({ version: "1.1.0" }));
    await install(fixture({ version: "1.2.0" }));

    const removed = await removeUnusedRuntimeVersions({
      paths,
      runtimeName: "claude-code",
      keepVersions: new Set(["1.1.0", "1.2.0"]),
    });

    expect(removed).toEqual(["1.0.0"]);
    expect(await listInstalledRuntimeVersions(paths, "claude-code")).toEqual(["1.1.0", "1.2.0"]);
  });
});

async function readdirNames(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(directory).catch(() => [])).sort();
}
