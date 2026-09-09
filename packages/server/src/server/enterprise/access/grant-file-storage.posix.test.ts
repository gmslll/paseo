import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  FileBackedGrantStorage,
  GrantStoragePoisonedError,
  type GrantRecord,
} from "./grant-store.js";
import {
  GrantFsError,
  NodeGrantFileSystem,
  grantNoFollowFlag,
  grantTemporaryPath,
  type GrantDirectoryCreateOptions,
  type GrantFileHandle,
  type GrantTempSuffixSource,
} from "./secure-fs.js";

const principalId = "usr_0123456789abcdef";
const organizationId = "org_0123456789abcdef";

function record(grantVersion: string, principal = principalId): GrantRecord {
  return {
    principalId: principal,
    organizationId,
    grants:
      grantVersion === "grv_1" ? [] : [{ action: "workspace.write", selector: { kind: "self" } }],
    grantVersion,
  };
}

class SequenceSuffixSource implements GrantTempSuffixSource {
  private index = 0;

  constructor(private readonly values: readonly string[]) {}

  next(): string {
    const value = this.values[this.index];
    this.index += 1;
    if (!value) throw new Error("Test suffix source exhausted");
    return value;
  }
}

class FaultGrantFileSystem extends NodeGrantFileSystem {
  readonly operations: string[] = [];
  readonly opens: Array<{ path: string; flags: number; mode?: number }> = [];
  private readonly faults = new Map<string, Error>();
  private atomicAttempt: "primary" | "rollback" | "marker" | null = null;
  private targetAtomicWrites = 0;

  constructor(
    private readonly targetPath: string,
    suffixSource: GrantTempSuffixSource = new SequenceSuffixSource(
      Array.from({ length: 40 }, (_, index) => `test-${index}`),
    ),
  ) {
    super(suffixSource);
  }

  beginMutation(): void {
    this.targetAtomicWrites = 0;
    this.operations.length = 0;
    this.opens.length = 0;
    this.faults.clear();
  }

  fail(point: string): Error {
    const error = new Error(`Injected ${point} failure`);
    this.faults.set(point, error);
    return error;
  }

  override async mkdir(directory: string, options: GrantDirectoryCreateOptions): Promise<void> {
    this.hit("directory.mkdir");
    await super.mkdir(directory, options);
  }

  override async open(filePath: string, flags: number, mode?: number): Promise<GrantFileHandle> {
    this.opens.push({ path: filePath, flags, ...(mode === undefined ? {} : { mode }) });
    const role = this.openRole(filePath, flags);
    this.hit(`${role}.open`);
    const handle = await super.open(filePath, flags, mode);
    return {
      fd: handle.fd,
      stat: async () => {
        this.hit(`${role}.stat`);
        return handle.stat();
      },
      chmod: async (value) => {
        this.hit(`${role}.chmod`);
        await handle.chmod(value);
      },
      readFile: async () => {
        this.hit(`${role}.read`);
        return handle.readFile();
      },
      writeFile: async (data) => {
        this.hit(`${role}.write`);
        await handle.writeFile(data);
      },
      sync: async () => {
        this.hit(`${role}.sync`);
        await handle.sync();
      },
      close: async () => {
        await handle.close();
        this.hit(`${role}.close`);
      },
    };
  }

  override async rename(source: string, target: string): Promise<void> {
    this.hit(`${this.atomicAttempt ?? "direct"}.rename`);
    await super.rename(source, target);
  }

  override async unlink(filePath: string): Promise<void> {
    this.hit(`${this.atomicAttempt ?? "direct"}.unlink`);
    await super.unlink(filePath);
  }

  override async writeAtomic(filePath: string, data: string): Promise<void> {
    const previousAttempt = this.atomicAttempt;
    if (filePath === `${this.targetPath}.poison`) {
      this.atomicAttempt = "marker";
    } else {
      this.atomicAttempt = this.targetAtomicWrites === 0 ? "primary" : "rollback";
      this.targetAtomicWrites += 1;
    }
    try {
      await super.writeAtomic(filePath, data);
    } finally {
      this.atomicAttempt = previousAttempt;
    }
  }

  private openRole(filePath: string, flags: number): string {
    if ((flags & constants.O_DIRECTORY) !== 0) {
      return this.atomicAttempt ? `${this.atomicAttempt}.parent` : "directory";
    }
    if ((flags & constants.O_EXCL) !== 0) {
      return `${this.atomicAttempt ?? "direct"}.temp`;
    }
    return filePath === this.targetPath ? "target" : "poison";
  }

  private hit(point: string): void {
    this.operations.push(point);
    const error = this.faults.get(point);
    if (!error) return;
    this.faults.delete(point);
    throw error;
  }
}

async function writePrivateFile(filePath: string, data: string): Promise<void> {
  await fs.writeFile(filePath, data, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function expectNoTemporaryFiles(directory: string): Promise<void> {
  const entries = await fs.readdir(directory);
  expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
}

function expectCommitError(
  error: unknown,
  phase: GrantFsError["phase"],
  commitState: GrantFsError["commitState"],
): void {
  expect(error).toBeInstanceOf(GrantFsError);
  if (!(error instanceof GrantFsError)) throw error;
  expect(error.phase).toBe(phase);
  expect(error.commitState).toBe(commitState);
}

describe("FileBackedGrantStorage secure persistence", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-grants-"));
    filePath = path.join(directory, "enterprise", "grants.json");
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("uses same-handle validation and private durable atomic writes", async () => {
    const fileSystem = new FaultGrantFileSystem(filePath);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);

    fileSystem.beginMutation();
    await storage.put(record("grv_1"));
    fileSystem.beginMutation();
    await storage.put(record("grv_2"));

    expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(grantNoFollowFlag()).not.toBe(0);
    expect(fileSystem.opens.every((entry) => (entry.flags & grantNoFollowFlag()) !== 0)).toBe(true);
    const tempOpens = fileSystem.opens.filter((entry) => (entry.flags & constants.O_EXCL) !== 0);
    expect(tempOpens).toHaveLength(1);
    expect(tempOpens[0]?.mode).toBe(0o600);
    expect(fileSystem.operations).toEqual(
      expect.arrayContaining([
        "directory.mkdir",
        "directory.stat",
        "directory.chmod",
        "primary.temp.stat",
        "primary.temp.chmod",
        "primary.temp.write",
        "primary.temp.sync",
        "primary.temp.close",
        "primary.rename",
        "primary.parent.sync",
        "primary.parent.close",
      ]),
    );

    const restartedFileSystem = new FaultGrantFileSystem(filePath);
    const restarted = new FileBackedGrantStorage(filePath, restartedFileSystem);
    const loaded = await restarted.get(principalId);
    expect(loaded).toEqual(record("grv_2"));
    loaded?.grants.push({ action: "workspace.metadata.read", selector: { kind: "self" } });
    await expect(restarted.get(principalId)).resolves.toEqual(record("grv_2"));
    expect(restartedFileSystem.operations).toEqual(
      expect.arrayContaining(["target.stat", "target.read", "target.close"]),
    );
  });

  test.each([
    ["primary.temp.write", "write"],
    ["primary.temp.chmod", "chmod"],
    ["primary.temp.sync", "file_sync"],
    ["primary.temp.close", "temp_close"],
    ["primary.rename", "rename"],
  ] as const)(
    "keeps disk and cache unchanged without poison when %s fails",
    async (faultPoint, phase) => {
      const fileSystem = new FaultGrantFileSystem(filePath);
      const storage = new FileBackedGrantStorage(filePath, fileSystem);
      await storage.put(record("grv_1"));
      fileSystem.beginMutation();
      fileSystem.fail(faultPoint);

      const error = await storage.put(record("grv_2")).catch((value: unknown) => value);

      expectCommitError(error, phase, "uncommitted");
      await expect(storage.get(principalId)).resolves.toEqual(record("grv_1"));
      await expect(new FileBackedGrantStorage(filePath).get(principalId)).resolves.toEqual(
        record("grv_1"),
      );
      await expect(fs.access(`${filePath}.poison`)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoTemporaryFiles(path.dirname(filePath));
    },
  );

  test("keeps pre-commit phase typing when cleanup also fails", async () => {
    const fileSystem = new FaultGrantFileSystem(filePath);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);
    await storage.put(record("grv_1"));
    fileSystem.beginMutation();
    fileSystem.fail("primary.temp.write");
    fileSystem.fail("primary.temp.close");

    const error = await storage.put(record("grv_2")).catch((value: unknown) => value);

    expectCommitError(error, "write", "uncommitted");
    if (!(error instanceof GrantFsError)) throw error;
    expect(error.cause).toBeInstanceOf(AggregateError);
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).resolves.toEqual(
      record("grv_1"),
    );
    await expectNoTemporaryFiles(path.dirname(filePath));
  });

  test.each(["primary.parent.sync", "primary.parent.close"])(
    "rolls back the previous file when post-commit %s fails",
    async (faultPoint) => {
      const fileSystem = new FaultGrantFileSystem(filePath);
      const storage = new FileBackedGrantStorage(filePath, fileSystem);
      await storage.put(record("grv_1"));
      fileSystem.beginMutation();
      fileSystem.fail(faultPoint);

      const error = await storage.put(record("grv_2")).catch((value: unknown) => value);

      expectCommitError(error, "parent_sync", "commit_unknown");
      await expect(storage.get(principalId)).resolves.toEqual(record("grv_1"));
      await expect(new FileBackedGrantStorage(filePath).get(principalId)).resolves.toEqual(
        record("grv_1"),
      );
      await expect(fs.access(`${filePath}.poison`)).rejects.toMatchObject({ code: "ENOENT" });
      await expectNoTemporaryFiles(path.dirname(filePath));
    },
  );

  test("removes a newly committed target when post-commit sync fails", async () => {
    const fileSystem = new FaultGrantFileSystem(filePath);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);
    fileSystem.beginMutation();
    fileSystem.fail("primary.parent.sync");

    const error = await storage.put(record("grv_1")).catch((value: unknown) => value);

    expectCommitError(error, "parent_sync", "commit_unknown");
    await expect(storage.get(principalId)).resolves.toBeNull();
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).resolves.toBeNull();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fileSystem.operations).toEqual(
      expect.arrayContaining(["direct.unlink", "directory.sync", "directory.close"]),
    );
    await expectNoTemporaryFiles(path.dirname(filePath));
  });

  test("persists poison and fails closed when rollback fails", async () => {
    const fileSystem = new FaultGrantFileSystem(filePath);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);
    await storage.put(record("grv_1"));
    fileSystem.beginMutation();
    fileSystem.fail("primary.parent.sync");
    fileSystem.fail("rollback.temp.write");

    const error = await storage.put(record("grv_2")).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GrantStoragePoisonedError);
    expect((await fs.stat(`${filePath}.poison`)).mode & 0o777).toBe(0o600);
    expect(fileSystem.operations).toEqual(
      expect.arrayContaining([
        "marker.temp.chmod",
        "marker.temp.write",
        "marker.temp.sync",
        "marker.temp.close",
        "marker.rename",
        "marker.parent.sync",
        "marker.parent.close",
      ]),
    );
    await expect(storage.get(principalId)).rejects.toBeInstanceOf(GrantStoragePoisonedError);
    await expect(storage.put(record("grv_3"))).rejects.toBeInstanceOf(GrantStoragePoisonedError);
    const restarted = new FileBackedGrantStorage(filePath);
    await expect(restarted.get(principalId)).rejects.toBeInstanceOf(GrantStoragePoisonedError);
    await expect(restarted.put(record("grv_3"))).rejects.toBeInstanceOf(GrantStoragePoisonedError);
    await expectNoTemporaryFiles(path.dirname(filePath));
  });

  test("retains primary, rollback, and marker failures when poison cannot persist", async () => {
    const fileSystem = new FaultGrantFileSystem(filePath);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);
    await storage.put(record("grv_1"));
    fileSystem.beginMutation();
    const primaryFault = fileSystem.fail("primary.parent.sync");
    const rollbackFault = fileSystem.fail("rollback.temp.write");
    const markerFault = fileSystem.fail("marker.temp.write");

    const error = await storage.put(record("grv_2")).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.errors).toHaveLength(3);
    expect(error.cause).toBe(error.errors[0]);
    for (const [index, fault] of [primaryFault, rollbackFault, markerFault].entries()) {
      const retained = error.errors[index];
      expect(retained).toBeInstanceOf(GrantFsError);
      if (!(retained instanceof GrantFsError)) throw retained;
      expect(retained.cause).toBe(fault);
    }
    await expect(storage.get(principalId)).rejects.toBeInstanceOf(GrantStoragePoisonedError);
    await expectNoTemporaryFiles(path.dirname(filePath));
  });

  test("closes the target handle when a read fails", async () => {
    await new FileBackedGrantStorage(filePath).put(record("grv_1"));
    const fileSystem = new FaultGrantFileSystem(filePath);
    fileSystem.fail("target.read");
    const storage = new FileBackedGrantStorage(filePath, fileSystem);

    await expect(storage.get(principalId)).rejects.toThrow("Injected target.read failure");
    expect(fileSystem.operations).toContain("target.close");
  });

  test("rejects symlinks and non-regular targets while tightening wider modes", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const victim = path.join(directory, "victim.json");
    await writePrivateFile(victim, JSON.stringify({ [principalId]: record("grv_1") }));
    await fs.symlink(victim, filePath);
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).rejects.toThrow();
    await fs.unlink(filePath);

    await fs.mkdir(filePath);
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).rejects.toThrow(
      "regular file",
    );
    await fs.rm(filePath, { recursive: true });

    await writePrivateFile(filePath, JSON.stringify({ [principalId]: record("grv_1") }));
    await fs.chmod(filePath, 0o640);
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).resolves.toEqual(
      record("grv_1"),
    );
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects corrupt and key-mismatched private files", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writePrivateFile(filePath, "not-json");
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).rejects.toThrow();

    await writePrivateFile(filePath, JSON.stringify({ usr_wrong: record("grv_1") }));
    await expect(new FileBackedGrantStorage(filePath).get(principalId)).rejects.toThrow(
      "key mismatch",
    );
  });

  test("uses exclusive unique temporary paths without deleting a collision", async () => {
    const suffixSource = new SequenceSuffixSource(["collision"]);
    const fileSystem = new FaultGrantFileSystem(filePath, suffixSource);
    const temporaryPath = grantTemporaryPath(filePath, "collision");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writePrivateFile(temporaryPath, "owned by another writer");
    const storage = new FileBackedGrantStorage(filePath, fileSystem);

    const error = await storage.put(record("grv_1")).catch((value: unknown) => value);

    expectCommitError(error, "temp_open", "uncommitted");
    await expect(fs.readFile(temporaryPath, "utf8")).resolves.toBe("owned by another writer");
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("injects a new temporary suffix for every atomic attempt", async () => {
    const suffixSource = new SequenceSuffixSource(["first", "second"]);
    const fileSystem = new FaultGrantFileSystem(filePath, suffixSource);
    const storage = new FileBackedGrantStorage(filePath, fileSystem);

    await storage.put(record("grv_1"));
    await storage.put(record("grv_2"));

    const temporaryOpens = fileSystem.opens.filter(
      (entry) => (entry.flags & constants.O_EXCL) !== 0,
    );
    expect(temporaryOpens.map((entry) => entry.path)).toEqual([
      grantTemporaryPath(filePath, "first"),
      grantTemporaryPath(filePath, "second"),
    ]);
  });

  test("serializes concurrent puts and reads without losing cache or disk records", async () => {
    const storage = new FileBackedGrantStorage(filePath);
    const otherPrincipal = "usr_fedcba9876543210";
    const first = storage.put(record("grv_1"));
    const second = storage.put(record("grv_1", otherPrincipal));
    const readSecond = storage.get(otherPrincipal);

    await expect(Promise.all([first, second, readSecond])).resolves.toEqual([
      undefined,
      undefined,
      record("grv_1", otherPrincipal),
    ]);
    const restarted = new FileBackedGrantStorage(filePath);
    await expect(restarted.get(principalId)).resolves.toEqual(record("grv_1"));
    await expect(restarted.get(otherPrincipal)).resolves.toEqual(record("grv_1", otherPrincipal));
    await expectNoTemporaryFiles(path.dirname(filePath));
  });
});
