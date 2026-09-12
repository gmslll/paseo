import { execFile } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AuditEvent } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON,
  DarwinAuditFileSystem,
} from "./darwin-audit-file-system.js";
import {
  JsonlAuditStorage,
  NodeAuditFileSystem,
  type AuditDirectoryHandle,
  type AuditFileHandle,
  type AuditFileSystem,
} from "./local-audit-sink.js";

const executeFile = promisify(execFile);

interface DirectDarwinAuditBinding {
  openAt(dirfd: unknown, name: unknown, flags: unknown, mode?: unknown): number;
  readDirectory(dirfd: unknown): unknown;
  renameAt(dirfd: unknown, sourceName: unknown, destinationName: unknown): void;
  unlinkAt(dirfd: unknown, name: unknown): void;
}

function finalized(): AuditEvent {
  return {
    eventId: "evt_native_1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org_0000000000000001",
    nodeId: "nod_0000000000000001",
    nodeEventSeq: 1,
    actorPrincipalId: "usr_0000000000000001",
    action: "workspace.read",
    resource: { kind: "workspace", id: "ws_1" },
    outcome: "allowed",
    eventHash: "sha256:native-1",
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function aggregateMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(aggregateMessages);
  if (error instanceof Error) return [error.message];
  return [String(error)];
}

class DirectorySwapFileSystem implements AuditFileSystem {
  readonly noFollowFlag: number;
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  private swapped = false;

  constructor(
    private readonly targetDirectory: string,
    private readonly movedDirectory: string,
    private readonly replacementDirectory: string,
    private readonly delegate: AuditFileSystem,
    private readonly wrapDirectory: (handle: AuditDirectoryHandle) => AuditDirectoryHandle = (
      handle,
    ) => handle,
  ) {
    this.noFollowFlag = delegate.noFollowFlag;
    this.releaseReady = delegate.releaseReady;
    this.unsupportedReason = delegate.unsupportedReason;
  }

  ensureDirectory(directory: string, mode: number): Promise<void> {
    return this.delegate.ensureDirectory(directory, mode);
  }

  async openDirectory(directory: string, flags: number): Promise<AuditDirectoryHandle> {
    const handle = await this.delegate.openDirectory(directory, flags);
    if (!this.swapped && directory === this.targetDirectory) {
      this.swapped = true;
      await rename(this.targetDirectory, this.movedDirectory);
      await symlink(this.replacementDirectory, this.targetDirectory);
    }
    return this.wrapDirectory(handle);
  }
}

function withShortWriteAndFailedRollback(
  handle: AuditDirectoryHandle,
  trace: string[],
): AuditDirectoryHandle {
  let faultData = true;
  return {
    stat: () => handle.stat(),
    chmod: (mode) => handle.chmod(mode),
    openFile: async (name, flags, mode) => {
      trace.push(`open:${name}`);
      const fileHandle = await handle.openFile(name, flags, mode);
      if (!name.startsWith("audit-") || !faultData) return fileHandle;
      faultData = false;
      return withShortWrite(fileHandle, trace);
    },
    readEntries: () => handle.readEntries(),
    rename: async (sourceName, destinationName) => {
      trace.push(`rename:${sourceName}:${destinationName}`);
      await handle.rename(sourceName, destinationName);
    },
    unlink: async (name) => {
      trace.push(`unlink:${name}`);
      await handle.unlink(name);
    },
    sync: async () => {
      trace.push("directory:sync");
      await handle.sync();
    },
    close: () => handle.close(),
  };
}

function withShortWrite(handle: AuditFileHandle, trace: string[]): AuditFileHandle {
  return {
    stat: () => handle.stat(),
    chmod: (mode) => handle.chmod(mode),
    readFile: (encoding) => handle.readFile(encoding),
    write: async (data) => {
      trace.push("data:short-write");
      return handle.write(data.slice(0, -1));
    },
    truncate: async () => {
      trace.push("data:truncate-failed");
      throw new Error("native rollback fault");
    },
    sync: () => handle.sync(),
    close: () => handle.close(),
  };
}

describe("DarwinAuditFileSystem availability", () => {
  it("fails closed when its native binding cannot be loaded", async () => {
    const files = new DarwinAuditFileSystem({ addonPath: "/missing/darwin-audit-fs.node" });
    expect(files.releaseReady).toBe(false);
    expect(files.unsupportedReason).toBe(DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON);
    await expect(files.openDirectory("/unused", fileConstants.O_RDONLY)).rejects.toThrow(
      DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON,
    );
  });
});

describe.runIf(process.platform !== "darwin")("DarwinAuditFileSystem unsupported platform", () => {
  it("cannot become release-ready from a binding path on a non-Darwin runtime", () => {
    const files = new DarwinAuditFileSystem({ addonPath: "/tmp/darwin-audit-fs.node" });
    expect(files.releaseReady).toBe(false);
    expect(files.unsupportedReason).toBe(DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON);
  });
});

describe.runIf(process.platform === "darwin")("DarwinAuditFileSystem dirfd boundaries", () => {
  let buildDirectory = "";
  let addonPath = "";

  beforeAll(async () => {
    buildDirectory = await temporaryDirectory("paseo-audit-native-build-");
    addonPath = path.join(buildDirectory, "darwin-audit-fs.node");
    await executeFile(process.execPath, [
      fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      addonPath,
    ]);
  });

  afterAll(async () => {
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
  });

  it("becomes release-ready only with the validated native binding", () => {
    const files = new DarwinAuditFileSystem({ addonPath });
    const storage = new JsonlAuditStorage("/unused", files);
    expect(files.releaseReady).toBe(true);
    expect(files.unsupportedReason).toBeUndefined();
    expect(storage.releaseReady).toBe(true);
    expect(storage.unsupportedReason).toBeUndefined();
  });

  it("strictly rejects malformed native integer arguments without coercion", async () => {
    const root = await temporaryDirectory("paseo-audit-native-arguments-");
    const binding = createRequire(import.meta.url)(addonPath) as DirectDarwinAuditBinding;
    const directory = await open(root, fileConstants.O_RDONLY | fileConstants.O_DIRECTORY);
    try {
      const invalidDescriptors: readonly unknown[] = [
        -1,
        -2_147_483_649,
        2_147_483_648,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        "0",
      ];
      for (const value of invalidDescriptors) {
        expect(() => binding.openAt(value, "entry", fileConstants.O_RDONLY, 0)).toThrow(
          "dirfd must be an integer from 0 to 2147483647",
        );
        expect(() => binding.readDirectory(value)).toThrow(
          "dirfd must be an integer from 0 to 2147483647",
        );
        expect(() => binding.renameAt(value, "source", "destination")).toThrow(
          "dirfd must be an integer from 0 to 2147483647",
        );
        expect(() => binding.unlinkAt(value, "entry")).toThrow(
          "dirfd must be an integer from 0 to 2147483647",
        );
      }

      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "0"]) {
        expect(() => binding.openAt(directory.fd, "entry", value, 0)).toThrow(
          "flags must be an integer from 0 to 2147483647",
        );
      }
      for (const value of [
        fileConstants.O_WRONLY,
        fileConstants.O_RDWR | fileConstants.O_TRUNC,
        fileConstants.O_RDWR | fileConstants.O_EXCL,
      ]) {
        expect(() => binding.openAt(directory.fd, "entry", value, 0)).toThrow(
          "invalid audit open flags",
        );
      }
      for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0o10000, "0"]) {
        expect(() => binding.openAt(directory.fd, "entry", fileConstants.O_RDONLY, value)).toThrow(
          "mode must be an integer from 0 to 4095",
        );
      }
      expect(() => binding.openAt(directory.fd, "entry", fileConstants.O_RDONLY, 0o600)).toThrow(
        "invalid audit open mode",
      );
      expect(() =>
        binding.openAt(directory.fd, "entry", fileConstants.O_CREAT | fileConstants.O_RDWR, 0o644),
      ).toThrow("invalid audit open mode");
      expect(() => binding.openAt(directory.fd, "entry", fileConstants.O_RDONLY)).toThrow(
        "openAt requires dirfd, name, flags, and mode",
      );
    } finally {
      await directory.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reproduces the portable path-reopen write into a replacement target", async () => {
    const root = await temporaryDirectory("paseo-audit-portable-race-");
    const auditDirectory = path.join(root, "audit");
    const movedDirectory = path.join(root, "audit-original");
    const attackerDirectory = path.join(root, "attacker");
    const portableFiles = new NodeAuditFileSystem();
    try {
      await portableFiles.ensureDirectory(attackerDirectory, 0o700);
      const files = new DirectorySwapFileSystem(
        auditDirectory,
        movedDirectory,
        attackerDirectory,
        portableFiles,
      );
      await new JsonlAuditStorage(auditDirectory, files).append(finalized());
      expect(portableFiles.releaseReady).toBe(false);
      expect(await readdir(movedDirectory)).toEqual([]);
      expect(await readdir(attackerDirectory)).toEqual(["audit-2026-01-01.jsonl"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps open, fstat, fchmod, read, write, rename, unlink, enumeration, and fsync on the original dirfd", async () => {
    const root = await temporaryDirectory("paseo-audit-native-direct-");
    const auditDirectory = path.join(root, "audit");
    const movedDirectory = path.join(root, "audit-original");
    const attackerDirectory = path.join(root, "attacker");
    const files = new DarwinAuditFileSystem({ addonPath });
    try {
      await files.ensureDirectory(auditDirectory, 0o700);
      await files.ensureDirectory(attackerDirectory, 0o700);
      const directory = await files.openDirectory(
        auditDirectory,
        fileConstants.O_RDONLY | files.noFollowFlag,
      );
      const before = await directory.stat();
      await rename(auditDirectory, movedDirectory);
      await symlink(attackerDirectory, auditDirectory);

      const child = await directory.openFile(
        "entry.pending",
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR | files.noFollowFlag,
        0o600,
      );
      expect((await child.stat()).size).toBe(0);
      await child.chmod(0o600);
      expect((await child.stat()).mode & 0o777).toBe(0o600);
      expect(await child.readFile("utf8")).toBe("");
      expect(await child.write("anchored\n")).toEqual({ bytesWritten: 9 });
      await child.sync();
      await child.close();
      const reader = await directory.openFile(
        "entry.pending",
        fileConstants.O_RDONLY | files.noFollowFlag,
      );
      expect(await reader.readFile("utf8")).toBe("anchored\n");
      await reader.close();
      await directory.rename("entry.pending", "entry.committed");
      expect(await directory.readEntries()).toEqual(["entry.committed"]);
      const descriptorsBefore = (await readdir("/dev/fd")).length;
      for (let index = 0; index < 32; index += 1) {
        expect(await directory.readEntries()).toEqual(["entry.committed"]);
      }
      expect((await readdir("/dev/fd")).length).toBe(descriptorsBefore);
      await directory.unlink("entry.committed");
      await directory.sync();
      const after = await directory.stat();
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      await directory.close();
      await expect(directory.readEntries()).rejects.toThrow("already closed");
      await expect(directory.close()).rejects.toThrow("already closed");

      expect(await readdir(movedDirectory)).toEqual([]);
      expect(await readdir(attackerDirectory)).toEqual([]);
      expect((await lstat(auditDirectory)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads and appends the original audit directory after its published path is replaced", async () => {
    const root = await temporaryDirectory("paseo-audit-native-storage-");
    const auditDirectory = path.join(root, "audit");
    const movedDirectory = path.join(root, "audit-original");
    const attackerDirectory = path.join(root, "attacker");
    const nativeFiles = new DarwinAuditFileSystem({ addonPath });
    try {
      await nativeFiles.ensureDirectory(attackerDirectory, 0o700);
      const swappingFiles = new DirectorySwapFileSystem(
        auditDirectory,
        movedDirectory,
        attackerDirectory,
        nativeFiles,
      );
      await new JsonlAuditStorage(auditDirectory, swappingFiles).append(finalized());
      expect(await readdir(attackerDirectory)).toEqual([]);
      expect(await readdir(movedDirectory)).toEqual(["audit-2026-01-01.jsonl"]);

      await rm(auditDirectory);
      await rename(movedDirectory, auditDirectory);
      const readSwap = new DirectorySwapFileSystem(
        auditDirectory,
        movedDirectory,
        attackerDirectory,
        nativeFiles,
      );
      expect(await new JsonlAuditStorage(auditDirectory, readSwap).readAll()).toEqual([
        finalized(),
      ]);
      expect(await readdir(attackerDirectory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back and publishes the poison marker only inside the original dirfd after replacement", async () => {
    const root = await temporaryDirectory("paseo-audit-native-poison-");
    const auditDirectory = path.join(root, "audit");
    const movedDirectory = path.join(root, "audit-original");
    const attackerDirectory = path.join(root, "attacker");
    const trace: string[] = [];
    const nativeFiles = new DarwinAuditFileSystem({ addonPath });
    try {
      await nativeFiles.ensureDirectory(attackerDirectory, 0o700);
      const files = new DirectorySwapFileSystem(
        auditDirectory,
        movedDirectory,
        attackerDirectory,
        nativeFiles,
        (handle) => withShortWriteAndFailedRollback(handle, trace),
      );
      let failure: unknown;
      try {
        await new JsonlAuditStorage(auditDirectory, files).append(finalized());
      } catch (error) {
        failure = error;
      }

      expect(aggregateMessages(failure)).toEqual(["audit short write", "native rollback fault"]);
      expect(await readdir(attackerDirectory)).toEqual([]);
      expect(await readdir(movedDirectory)).toEqual([".audit-poisoned"]);
      expect(await readFile(path.join(movedDirectory, ".audit-poisoned"), "utf8")).toBe(
        "paseo-audit-poisoned-v1\n",
      );
      expect(trace).toContain("unlink:audit-2026-01-01.jsonl");
      expect(trace).toContain("rename:.audit-poisoned.pending:.audit-poisoned");
      expect(trace.at(-1)).toBe("directory:sync");

      await rm(auditDirectory);
      await rename(movedDirectory, auditDirectory);
      await expect(new JsonlAuditStorage(auditDirectory, nativeFiles).readAll()).rejects.toThrow(
        "audit storage poisoned",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects final-component audit and marker symlinks without touching their targets", async () => {
    const root = await temporaryDirectory("paseo-audit-native-symlink-");
    const auditDirectory = path.join(root, "audit");
    const external = path.join(root, "external");
    const files = new DarwinAuditFileSystem({ addonPath });
    try {
      await files.ensureDirectory(auditDirectory, 0o700);
      await writeFile(external, "untouched\n", { mode: 0o600 });
      await symlink(external, path.join(auditDirectory, "audit-2026-01-01.jsonl"));
      const directory = await files.openDirectory(auditDirectory, fileConstants.O_RDONLY);
      await expect(
        directory.openFile("audit-2026-01-01.jsonl", fileConstants.O_RDONLY),
      ).rejects.toThrow();
      await directory.close();
      await expect(
        new JsonlAuditStorage(auditDirectory, files).append(finalized()),
      ).rejects.toThrow();
      expect(await readFile(external, "utf8")).toBe("untouched\n");
      await rm(path.join(auditDirectory, "audit-2026-01-01.jsonl"));
      await symlink(external, path.join(auditDirectory, ".audit-poisoned"));
      await expect(new JsonlAuditStorage(auditDirectory, files).readAll()).rejects.toThrow();
      expect(await readFile(external, "utf8")).toBe("untouched\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
