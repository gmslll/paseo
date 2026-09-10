import { constants as fileConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AuditAppendOptions,
  AuditClock,
  AuditEvent,
  AuditEventInput,
  AuditSequence,
  AuditStorage,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  IncrementalAuditSequence,
  JsonlAuditStorage,
  LocalAuditSink,
  MAX_BUFFERED_AUDIT_EVENTS,
  NodeAuditFileSystem,
  PORTABLE_AUDIT_STORAGE_RELEASE_READY,
  PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON,
  Sha256AuditHash,
  type AuditDirectoryHandle,
  type AuditFileHandle,
  type AuditFileSystem,
} from "./local-audit-sink.js";

class MemoryStorage implements AuditStorage {
  readonly events: AuditEvent[] = [];
  readonly attempts: number[] = [];
  fail = false;

  async readAll(): Promise<readonly AuditEvent[]> {
    return this.events;
  }

  async append(event: Readonly<AuditEvent>): Promise<void> {
    this.attempts.push(event.nodeEventSeq);
    if (this.fail) throw new Error("storage unavailable");
    this.events.push({ ...event });
  }
}

class FaultStorage extends MemoryStorage {
  failAt: number | null = null;
  throwAfterWrite = false;
  private writes = 0;

  override async append(event: Readonly<AuditEvent>): Promise<void> {
    this.attempts.push(event.nodeEventSeq);
    if (this.fail) throw new Error("storage unavailable");
    if (
      this.events.some(
        (item) => item.eventId === event.eventId && item.nodeEventSeq === event.nodeEventSeq,
      )
    ) {
      return;
    }
    this.writes += 1;
    if (this.failAt === this.writes) throw new Error(`failure-${this.writes}`);
    this.events.push({ ...event });
    if (this.throwAfterWrite) throw new Error("post-write failure");
  }
}

class BlockingStorage extends MemoryStorage {
  readonly appendStarted: Promise<void>;
  private releaseAppend: () => void = () => undefined;

  constructor() {
    super();
    let markStarted: () => void = () => undefined;
    this.appendStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    this.waitForRelease = new Promise((resolve) => {
      this.releaseAppend = resolve;
    });
    this.markStarted = markStarted;
  }

  private readonly waitForRelease: Promise<void>;
  private readonly markStarted: () => void;

  release(): void {
    this.releaseAppend();
  }

  override async append(event: Readonly<AuditEvent>): Promise<void> {
    this.markStarted();
    await this.waitForRelease;
    await super.append(event);
  }
}

class DeferredReadStorage extends MemoryStorage {
  readonly readStarted: Promise<void>;
  private readonly waitForRelease: Promise<void>;
  private readonly markStarted: () => void;
  private releaseRead: () => void = () => undefined;

  constructor() {
    super();
    let markStarted: () => void = () => undefined;
    this.readStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    this.waitForRelease = new Promise((resolve) => {
      this.releaseRead = resolve;
    });
    this.markStarted = markStarted;
  }

  release(): void {
    this.releaseRead();
  }

  override async readAll(): Promise<readonly AuditEvent[]> {
    this.markStarted();
    await this.waitForRelease;
    return super.readAll();
  }
}

class FirstBlockingThenFailStorage extends BlockingStorage {
  failLater = true;
  private call = 0;

  override async append(event: Readonly<AuditEvent>): Promise<void> {
    this.call += 1;
    if (this.call === 1) {
      await super.append(event);
      return;
    }
    this.attempts.push(event.nodeEventSeq);
    if (this.failLater) throw new Error("later storage failure");
    this.events.push({ ...event });
  }
}

class SharedReadStorage implements AuditStorage {
  readonly appended: AuditEvent[] = [];

  constructor(readonly returned: AuditEvent[]) {}

  async readAll(): Promise<readonly AuditEvent[]> {
    return this.returned;
  }

  async append(event: Readonly<AuditEvent>): Promise<void> {
    this.appended.push({
      ...event,
      resource: { ...event.resource },
      ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
    });
  }
}

class DeferredFirstHash extends Sha256AuditHash {
  readonly firstStarted: Promise<void>;
  calls = 0;
  private readonly waitForRelease: Promise<void>;
  private readonly markStarted: () => void;
  private releaseHash: () => void = () => undefined;

  constructor() {
    super();
    let markStarted: () => void = () => undefined;
    this.firstStarted = new Promise((resolve) => {
      markStarted = resolve;
    });
    this.waitForRelease = new Promise((resolve) => {
      this.releaseHash = resolve;
    });
    this.markStarted = markStarted;
  }

  release(): void {
    this.releaseHash();
  }

  override async hash(event: Parameters<Sha256AuditHash["hash"]>[0]): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) {
      this.markStarted();
      await this.waitForRelease;
    }
    return super.hash(event);
  }
}

type FaultMode = "before" | "after" | "short" | "noop";

interface FileFault {
  readonly operation: string;
  readonly occurrence?: number;
  readonly mode?: FaultMode;
}

interface OpenRecord {
  readonly kind: "file" | "directory";
  readonly name: string;
  readonly flags: number;
  readonly mode?: number;
}

const SYNTHETIC_NOFOLLOW_FLAG = 0x40000000;
const TEST_NOFOLLOW_FLAG = fileConstants.O_NOFOLLOW || SYNTHETIC_NOFOLLOW_FLAG;

class FaultFiles implements AuditFileSystem {
  readonly trace: string[] = [];
  readonly opens: OpenRecord[] = [];
  readonly noFollowFlag: number;
  readonly releaseReady = false;
  readonly unsupportedReason = PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON;
  private readonly node: NodeAuditFileSystem;
  private readonly delegateNoFollowFlag: number;
  private readonly counts = new Map<string, number>();
  private readonly projectedDirectoryIdentitiesByPath = new Map<
    string,
    { readonly dev: number; readonly ino: number }
  >();
  private readonly projectedModesByPath = new Map<string, number>();
  private nextHandleId = 0;
  private nextProjectedDirectoryIno = 1;

  constructor(
    private readonly faults: readonly FileFault[] = [],
    noFollowFlag?: number,
  ) {
    this.noFollowFlag = noFollowFlag ?? TEST_NOFOLLOW_FLAG;
    this.delegateNoFollowFlag = fileConstants.O_NOFOLLOW === 0 ? SYNTHETIC_NOFOLLOW_FLAG : 0;
    this.node = new NodeAuditFileSystem(TEST_NOFOLLOW_FLAG);
  }

  async ensureDirectory(directory: string, mode: number): Promise<void> {
    const fault = this.record("ensure", "ensure");
    this.throwBefore(fault, "ensure");
    await this.node.ensureDirectory(directory, mode);
    this.throwAfter(fault, "ensure");
  }

  async openDirectory(directory: string, flags: number): Promise<AuditDirectoryHandle> {
    const fault = this.record("directory.open", "open:directory");
    this.opens.push({ kind: "directory", name: path.basename(directory), flags });
    this.throwBefore(fault, "directory.open");
    await this.rejectSyntheticSymlink(directory, flags);
    const handle = await this.node.openDirectory(directory, flags & ~this.delegateNoFollowFlag);
    this.throwAfter(fault, "directory.open");
    const label = `directory${++this.nextHandleId}`;
    return this.wrapDirectory(handle, label, directory);
  }

  private wrapFile(
    handle: AuditFileHandle,
    kind: string,
    label: string,
    filePath: string,
  ): AuditFileHandle {
    return {
      stat: async () => {
        const fault = this.record(`${kind}.stat`, `${label}:stat`);
        this.throwBefore(fault, `${kind}.stat`);
        const value = await handle.stat();
        this.throwAfter(fault, `${kind}.stat`);
        return this.projectStat(value, filePath);
      },
      chmod: async (mode) => {
        const fault = this.record(`${kind}.chmod`, `${label}:chmod`);
        this.throwBefore(fault, `${kind}.chmod`);
        if (fault?.mode === "noop") return;
        await this.chmod(handle, filePath, mode);
        this.throwAfter(fault, `${kind}.chmod`);
      },
      readFile: async (encoding) => {
        const fault = this.record(`${kind}.read`, `${label}:read`);
        this.throwBefore(fault, `${kind}.read`);
        const value = await handle.readFile(encoding);
        this.throwAfter(fault, `${kind}.read`);
        return value;
      },
      write: async (data) => {
        const fault = this.record(`${kind}.write`, `${label}:write`);
        this.throwBefore(fault, `${kind}.write`);
        if (fault?.mode === "short") return handle.write(data.slice(0, -1));
        const value = await handle.write(data);
        this.throwAfter(fault, `${kind}.write`);
        return value;
      },
      truncate: async (size) => {
        const fault = this.record(`${kind}.truncate`, `${label}:truncate`);
        this.throwBefore(fault, `${kind}.truncate`);
        await handle.truncate(size);
        this.throwAfter(fault, `${kind}.truncate`);
      },
      sync: async () => {
        const fault = this.record(`${kind}.sync`, `${label}:sync`);
        this.throwBefore(fault, `${kind}.sync`);
        await handle.sync();
        this.throwAfter(fault, `${kind}.sync`);
      },
      close: async () => {
        const fault = this.record(`${kind}.close`, `${label}:close`);
        this.throwBefore(fault, `${kind}.close`);
        await handle.close();
        this.throwAfter(fault, `${kind}.close`);
      },
    };
  }

  private wrapDirectory(
    handle: AuditDirectoryHandle,
    label: string,
    directory: string,
  ): AuditDirectoryHandle {
    return {
      stat: async () => {
        const fault = this.record("directory.stat", `${label}:stat`);
        this.throwBefore(fault, "directory.stat");
        const value = await handle.stat();
        this.throwAfter(fault, "directory.stat");
        return this.projectStat(value, directory, true);
      },
      chmod: async (mode) => {
        const fault = this.record("directory.chmod", `${label}:chmod`);
        this.throwBefore(fault, "directory.chmod");
        if (fault?.mode === "noop") return;
        await this.chmod(handle, directory, mode);
        this.throwAfter(fault, "directory.chmod");
      },
      openFile: async (name, flags, mode) => {
        const kind = this.fileKind(name);
        const fault = this.record(`${kind}.open`, `open:${kind}`);
        this.opens.push({ kind: "file", name, flags, mode });
        this.throwBefore(fault, `${kind}.open`);
        const filePath = path.join(directory, name);
        await this.rejectSyntheticSymlink(filePath, flags);
        const fileHandle = await handle.openFile(name, flags & ~this.delegateNoFollowFlag, mode);
        this.throwAfter(fault, `${kind}.open`);
        const fileLabel = `${kind}${++this.nextHandleId}`;
        return this.wrapFile(fileHandle, kind, fileLabel, filePath);
      },
      readEntries: async () => {
        const fault = this.record("directory.read", `${label}:read`);
        this.throwBefore(fault, "directory.read");
        const value = await handle.readEntries();
        this.throwAfter(fault, "directory.read");
        return value;
      },
      rename: async (sourceName, destinationName) => {
        const fault = this.record("rename", "rename");
        this.throwBefore(fault, "rename");
        await handle.rename(sourceName, destinationName);
        if (process.platform === "win32") {
          const sourcePath = path.join(directory, sourceName);
          const destinationPath = path.join(directory, destinationName);
          const mode = this.projectedModesByPath.get(sourcePath);
          this.projectedModesByPath.delete(sourcePath);
          if (mode !== undefined) this.projectedModesByPath.set(destinationPath, mode);
        }
        this.throwAfter(fault, "rename");
      },
      unlink: async (name) => {
        const fault = this.record("unlink", "unlink");
        this.throwBefore(fault, "unlink");
        await handle.unlink(name);
        if (process.platform === "win32") {
          this.projectedModesByPath.delete(path.join(directory, name));
        }
        this.throwAfter(fault, "unlink");
      },
      sync: async () => {
        const fault = this.record("directory.sync", `${label}:sync`);
        this.throwBefore(fault, "directory.sync");
        // Windows rejects fsync on directory handles; keep injected faults real,
        // but model successful directory durability in this test fixture.
        if (process.platform === "win32") {
          this.throwAfter(fault, "directory.sync");
          return;
        }
        await handle.sync();
        this.throwAfter(fault, "directory.sync");
      },
      close: async () => {
        const fault = this.record("directory.close", `${label}:close`);
        this.throwBefore(fault, "directory.close");
        await handle.close();
        this.throwAfter(fault, "directory.close");
      },
    };
  }

  private fileKind(file: string): "data" | "pending" | "poison" {
    const name = path.basename(file);
    if (name === ".audit-poisoned") return "poison";
    if (name === ".audit-poisoned.pending") return "pending";
    return "data";
  }

  private async rejectSyntheticSymlink(filePath: string, flags: number): Promise<void> {
    if (this.delegateNoFollowFlag === 0 || (flags & this.noFollowFlag) === 0) return;
    try {
      if ((await lstat(filePath)).isSymbolicLink()) {
        const error = new Error(`ELOOP: synthetic O_NOFOLLOW rejected '${filePath}'`);
        Object.assign(error, { code: "ELOOP" });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private projectStat<T extends Awaited<ReturnType<AuditFileHandle["stat"]>>>(
    value: T,
    filePath: string,
    isDirectory = false,
  ): T {
    if (process.platform !== "win32") return value;
    const mode = this.projectedModesByPath.get(filePath);
    const identity = isDirectory ? this.projectedDirectoryIdentity(filePath) : undefined;
    if (mode === undefined && identity === undefined) return value;
    return Object.assign(Object.create(value), {
      ...(mode === undefined ? {} : { mode: (value.mode & ~0o7777) | mode }),
      ...identity,
    }) as T;
  }

  private projectedDirectoryIdentity(filePath: string): {
    readonly dev: number;
    readonly ino: number;
  } {
    const existing = this.projectedDirectoryIdentitiesByPath.get(filePath);
    if (existing) return existing;
    const identity = Object.freeze({ dev: 1, ino: this.nextProjectedDirectoryIno++ });
    this.projectedDirectoryIdentitiesByPath.set(filePath, identity);
    return identity;
  }

  private async chmod(
    handle: Pick<AuditFileHandle, "chmod"> | Pick<AuditDirectoryHandle, "chmod">,
    filePath: string,
    mode: number,
  ): Promise<void> {
    try {
      await handle.chmod(mode);
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
        throw error;
      }
    }
    if (process.platform === "win32") this.projectedModesByPath.set(filePath, mode);
  }

  async mode(filePath: string): Promise<number> {
    if (process.platform === "win32") {
      const projected = this.projectedModesByPath.get(filePath);
      if (projected !== undefined) return projected;
    }
    return (await stat(filePath)).mode & 0o7777;
  }

  private record(operation: string, trace: string): FileFault | undefined {
    this.trace.push(trace);
    const occurrence = (this.counts.get(operation) ?? 0) + 1;
    this.counts.set(operation, occurrence);
    return this.faults.find(
      (fault) => fault.operation === operation && (fault.occurrence ?? 1) === occurrence,
    );
  }

  private throwBefore(fault: FileFault | undefined, operation: string): void {
    if (fault && (fault.mode ?? "before") === "before") throw new Error(`fault:${operation}`);
  }

  private throwAfter(fault: FileFault | undefined, operation: string): void {
    if (fault?.mode === "after") throw new Error(`fault:${operation}`);
  }
}

const input: AuditEventInput = {
  organizationId: "org_0000000000000001",
  actorPrincipalId: "usr_0000000000000001",
  action: "workspace.read",
  resource: { kind: "workspace", id: "ws_1" },
  outcome: "allowed",
  metadata: { prompt: "do not persist", innocent: "token-canary", count: 1 },
};

function dependencies(storage: AuditStorage, start = 0) {
  let tick = start;
  return {
    node: {
      nodeId: "nod_0000000000000001",
      paseoServerId: "srv_test",
      mode: "standalone" as const,
    },
    clock: {
      now: () => `2026-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    },
    idSource: { next: () => `evt_${tick}` },
    hash: new Sha256AuditHash(),
    sequence: new IncrementalAuditSequence(),
    storage,
  };
}

function finalized(sequence = 1, outcome: AuditEvent["outcome"] = "allowed"): AuditEvent {
  return {
    eventId: `evt_direct_${sequence}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org_0000000000000001",
    nodeId: "nod_0000000000000001",
    nodeEventSeq: sequence,
    actorPrincipalId: "usr_0000000000000001",
    action: "workspace.read",
    resource: { kind: "workspace", id: "ws_1" },
    outcome,
    ...(sequence > 1 ? { previousHash: `sha256:${sequence - 1}` } : {}),
    eventHash: `sha256:${sequence}`,
  };
}

async function withRecomputedHash(event: AuditEvent): Promise<AuditEvent> {
  const { eventHash: _eventHash, ...hashInput } = event;
  return { ...event, eventHash: await new Sha256AuditHash().hash(hashInput) };
}

function mutableEvent(event: AuditEvent): AuditEvent {
  return {
    ...event,
    resource: { ...event.resource },
    ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
  };
}

function aggregateMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    const reasons: readonly unknown[] = error.errors;
    return reasons.flatMap(aggregateMessages);
  }
  if (error instanceof Error) return [error.message];
  return [String(error)];
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("LocalAuditSink", () => {
  it("round-trips high priority and preserves legacy undefined priority", async () => {
    const storage = new MemoryStorage();
    const sink = new LocalAuditSink(dependencies(storage));
    const high = await sink.append({ ...input, priority: "high" }, { durability: "required" });
    const legacy = await sink.append(input, { durability: "required" });

    expect(high.priority).toBe("high");
    expect(legacy).not.toHaveProperty("priority");
    expect(storage.events.map((event) => event.priority)).toEqual(["high", undefined]);
  });

  it("owns authority fields, redacts metadata, and resumes the verified chain", async () => {
    const storage = new MemoryStorage();
    const first = new LocalAuditSink(dependencies(storage));
    const one = await first.append(input, { durability: "required" });
    const two = await first.append({ ...input, outcome: "denied" }, { durability: "required" });
    const resumed = new LocalAuditSink(dependencies(storage, 3));
    const three = await resumed.append({ ...input, outcome: "failed" }, { durability: "required" });

    expect(one).toMatchObject({
      eventId: "evt_1",
      nodeId: "nod_0000000000000001",
      nodeEventSeq: 1,
      metadata: { count: 1 },
    });
    expect(two.previousHash).toBe(one.eventHash);
    expect(three).toMatchObject({ nodeEventSeq: 3, previousHash: two.eventHash });
    expect(storage.events).toEqual([one, two, three]);
    expect(() => Object.assign(one.resource, { id: "mutated" })).toThrow();
    expect(() => Object.assign(first.node, { nodeId: "mutated" })).toThrow();
  });

  it("snapshots caller input and durability before a blocked initialization", async () => {
    const storage = new DeferredReadStorage();
    storage.fail = true;
    const mutableInput: AuditEventInput = {
      ...input,
      action: "workspace.snapshot",
      resource: { kind: "workspace", id: "ws_snapshot" },
      metadata: { count: 7, status: true },
    };
    const mutableOptions: AuditAppendOptions = { durability: "buffered" };
    const sink = new LocalAuditSink(dependencies(storage));
    await storage.readStarted;

    const append = sink.append(mutableInput, mutableOptions);
    mutableInput.action = "token-canary";
    mutableInput.resource.id = "../mutated";
    if (mutableInput.metadata) mutableInput.metadata.count = 99;
    mutableOptions.durability = "required";
    storage.release();

    const event = await append;
    expect(event).toMatchObject({
      action: "workspace.snapshot",
      resource: { kind: "workspace", id: "ws_snapshot" },
      metadata: { count: 7, status: true },
    });
    expect(storage.events).toEqual([]);
    expect(storage.attempts).toEqual([1]);
    storage.fail = false;
    await sink.flush();
    expect(storage.events).toEqual([event]);
  });

  it("isolates concurrent queued appends from later caller and option mutation", async () => {
    const storage = new FirstBlockingThenFailStorage();
    const sink = new LocalAuditSink(dependencies(storage));
    const first = sink.append(input, { durability: "required" });
    await storage.appendStarted;
    const mutableInput: AuditEventInput = {
      ...input,
      action: "workspace.concurrent",
      resource: { kind: "workspace", id: "ws_concurrent" },
      metadata: { count: 2 },
    };
    const mutableOptions: AuditAppendOptions = { durability: "buffered" };
    const second = sink.append(mutableInput, mutableOptions);
    mutableInput.action = "secret";
    mutableInput.resource.id = "../replaced";
    if (mutableInput.metadata) mutableInput.metadata.count = 200;
    mutableOptions.durability = "required";

    storage.release();
    const firstEvent = await first;
    const secondEvent = await second;
    expect(secondEvent).toMatchObject({
      action: "workspace.concurrent",
      resource: { kind: "workspace", id: "ws_concurrent" },
      metadata: { count: 2 },
    });
    expect(storage.events).toEqual([firstEvent]);
    expect(storage.attempts).toEqual([1, 2]);
    storage.failLater = false;
    await sink.flush();
    expect(storage.events).toEqual([firstEvent, secondEvent]);
  });

  it("freezes cloned hash and storage inputs and captures dependency ports", async () => {
    const storage = new MemoryStorage();
    const hash = new Sha256AuditHash();
    let hashMutationRejected = false;
    let storageMutationRejected = false;
    const originalAppend = storage.append.bind(storage);
    storage.append = async (event) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.resource)).toBe(true);
      expect(Object.isFrozen(event.metadata)).toBe(true);
      try {
        Object.assign(event.resource, { id: "mutated-by-storage" });
      } catch {
        storageMutationRejected = true;
      }
      await originalAppend(event);
    };
    const deps = {
      ...dependencies(storage),
      hash: {
        hash: async (candidate: Parameters<Sha256AuditHash["hash"]>[0]) => {
          await Promise.resolve();
          expect(Object.isFrozen(candidate)).toBe(true);
          expect(Object.isFrozen(candidate.resource)).toBe(true);
          expect(Object.isFrozen(candidate.metadata)).toBe(true);
          try {
            Object.assign(candidate.resource, { id: "mutated-by-hash" });
          } catch {
            hashMutationRejected = true;
          }
          return hash.hash(candidate);
        },
      },
    };
    const sink = new LocalAuditSink(deps);
    const replacementStorage = new MemoryStorage();
    deps.storage = replacementStorage;
    deps.hash = { hash: async () => "sha256:canary" };
    deps.clock.now = () => "2025-01-01T00:00:00.000Z";

    const event = await sink.append(
      { ...input, resource: { ...input.resource }, metadata: { count: 3 } },
      { durability: "required" },
    );
    expect(event.resource.id).toBe("ws_1");
    expect(hashMutationRejected).toBe(true);
    expect(storageMutationRejected).toBe(true);
    expect(storage.events).toEqual([event]);
    expect(replacementStorage.events).toEqual([]);
  });

  it("retains finalized buffered records through a partial flush and replays them in order", async () => {
    const storage = new FaultStorage();
    storage.fail = true;
    const sink = new LocalAuditSink(dependencies(storage), 4);
    const one = await sink.append(input, { durability: "buffered" });
    const two = await sink.append({ ...input, outcome: "denied" }, { durability: "buffered" });
    storage.fail = false;
    storage.failAt = 2;
    await expect(
      sink.append({ ...input, outcome: "failed" }, { durability: "required" }),
    ).rejects.toThrow("failure-2");
    storage.failAt = null;
    const three = await sink.append({ ...input, outcome: "failed" }, { durability: "buffered" });

    expect(storage.events).toEqual([one, two, three]);
    expect(storage.attempts).toEqual([1, 1, 1, 2, 2, 3]);
    expect(new Set(storage.events.map((event) => event.eventId)).size).toBe(3);
  });

  it("snapshots accepted buffered and durable events without duplicating or mutating the queue", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const sink = new LocalAuditSink(dependencies(storage));
    const buffered = await sink.append(input, { durability: "buffered" });
    storage.fail = false;

    const queuedSnapshot = await sink.snapshotEvents();
    expect(queuedSnapshot).toEqual([buffered]);
    expect(storage.events).toEqual([]);
    expect(storage.attempts).toEqual([1]);
    expect(Object.isFrozen(queuedSnapshot)).toBe(true);
    expect(Object.isFrozen(queuedSnapshot[0])).toBe(true);

    await sink.flush();
    expect(await sink.snapshotEvents()).toEqual([buffered]);
    expect(storage.events).toEqual([buffered]);
    expect(storage.attempts).toEqual([1, 1]);

    await sink.close();
    await expect(sink.snapshotEvents()).rejects.toThrow("audit sink closed");

    const resumed = new LocalAuditSink(dependencies(storage, 2));
    expect(await resumed.snapshotEvents()).toEqual([buffered]);
    await resumed.close();
  });

  it("releases rejected event IDs after required failure and buffer overflow", async () => {
    const requiredStorage = new MemoryStorage();
    requiredStorage.fail = true;
    const requiredDeps = {
      ...dependencies(requiredStorage),
      idSource: { next: () => "evt_reused" },
    };
    const requiredSink = new LocalAuditSink(requiredDeps);
    await expect(requiredSink.append(input, { durability: "required" })).rejects.toThrow(
      "storage unavailable",
    );
    requiredStorage.fail = false;
    const retried = await requiredSink.append(input, { durability: "required" });
    expect(retried.eventId).toBe("evt_reused");
    expect(requiredStorage.events).toEqual([retried]);

    const bufferedStorage = new MemoryStorage();
    bufferedStorage.fail = true;
    const ids = ["evt_accepted", "evt_recycled", "evt_recycled"];
    const bufferedSink = new LocalAuditSink(
      {
        ...dependencies(bufferedStorage),
        idSource: { next: () => ids.shift() ?? "evt_exhausted" },
      },
      1,
    );
    const accepted = await bufferedSink.append(input, { durability: "buffered" });
    await expect(bufferedSink.append(input, { durability: "buffered" })).rejects.toThrow(
      "audit buffer full",
    );
    bufferedStorage.fail = false;
    const recycled = await bufferedSink.append(input, { durability: "required" });
    expect(bufferedStorage.events).toEqual([accepted, recycled]);
    expect(recycled.eventId).toBe("evt_recycled");
  });

  it("shares one close promise, waits for current work, and rejects new work permanently", async () => {
    const storage = new BlockingStorage();
    const sink = new LocalAuditSink(dependencies(storage));
    const append = sink.append(input, { durability: "required" });
    await storage.appendStarted;
    const firstClose = sink.close();
    const secondClose = sink.close();

    expect(secondClose).toBe(firstClose);
    await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
      "audit sink closed",
    );
    await expect(sink.flush()).rejects.toThrow("audit sink closed");
    storage.release();
    const event = await append;
    await firstClose;
    expect(storage.events).toEqual([event]);
    expect(storage.attempts).toEqual([1]);
  });

  it("keeps a failed close terminal and does not retry its queued record", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const sink = new LocalAuditSink(dependencies(storage));
    await sink.append(input, { durability: "buffered" });
    const firstClose = sink.close();
    await expect(firstClose).rejects.toThrow("storage unavailable");
    storage.fail = false;

    expect(sink.close()).toBe(firstClose);
    await expect(sink.close()).rejects.toThrow("storage unavailable");
    await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
      "audit sink closed",
    );
    await expect(sink.flush()).rejects.toThrow("audit sink closed");
    expect(storage.events).toEqual([]);
    expect(storage.attempts).toEqual([1, 1]);
  });

  it("flushes an accepted queue during close", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const sink = new LocalAuditSink(dependencies(storage));
    const event = await sink.append(input, { durability: "buffered" });
    storage.fail = false;
    await sink.close();
    expect(storage.events).toEqual([event]);
    expect(storage.attempts).toEqual([1, 1]);
  });

  it("does not recover an empty degraded sink without a successful storage append", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const degraded: unknown[] = [];
    let recovered = 0;
    const sink = new LocalAuditSink(dependencies(storage), 4, {
      onDegraded: (error) => degraded.push(error),
      onRecovered: () => {
        recovered += 1;
      },
    });
    await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
      "storage unavailable",
    );
    await expect(sink.flush()).rejects.toThrow("audit storage recovery is unverified");
    const close = sink.close();
    expect(sink.close()).toBe(close);
    await expect(close).rejects.toThrow("audit storage recovery is unverified");
    await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
      "audit sink closed",
    );
    await expect(sink.flush()).rejects.toThrow("audit sink closed");
    expect(storage.attempts).toEqual([1]);
    expect(degraded).toHaveLength(1);
    expect(recovered).toBe(0);

    const recoveringStorage = new MemoryStorage();
    recoveringStorage.fail = true;
    const transitions: string[] = [];
    const recovering = new LocalAuditSink(dependencies(recoveringStorage), 4, {
      onDegraded: () => transitions.push("degraded"),
      onRecovered: () => transitions.push("recovered"),
    });
    await expect(recovering.append(input, { durability: "required" })).rejects.toThrow();
    recoveringStorage.fail = false;
    await recovering.append(input, { durability: "required" });
    expect(transitions).toEqual(["degraded", "recovered"]);
  });

  it("rejects invalid runtime values from NodeContext, clock, sequence, id, and hash ports", async () => {
    const storage = new MemoryStorage();
    const base = dependencies(storage);
    expect(
      () => new LocalAuditSink({ ...base, node: { ...base.node, nodeId: "wrong" } }),
    ).toThrow();
    const nodeWithExtra = { ...base.node, injectedAuthority: "wrong" };
    expect(() => new LocalAuditSink({ ...base, node: nodeWithExtra })).toThrow();

    const invalidPorts: Array<{ dependency: object; error: string }> = [
      { dependency: { clock: { now: () => JSON.parse("null") } }, error: "clock timestamp" },
      { dependency: { sequence: { next: async () => 2 } }, error: "sequence output" },
      { dependency: { idSource: { next: () => "" } }, error: "id source output" },
      { dependency: { hash: { hash: async () => JSON.parse("null") } }, error: "hash output" },
    ];
    for (const testCase of invalidPorts) {
      const sink = new LocalAuditSink({
        ...dependencies(new MemoryStorage()),
        ...testCase.dependency,
      });
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow(testCase.error);
    }
  });

  it("rejects unsafe id and hash canaries plus invalid storage outputs", async () => {
    for (const dependency of [
      { idSource: { next: () => "evt_token_canary" } },
      { idSource: { next: () => "evt_control\u0085" } },
      { hash: { hash: async () => "sha256:token-canary" } },
      { hash: { hash: async () => "sha256:control\u007f" } },
    ]) {
      const sink = new LocalAuditSink({
        ...dependencies(new MemoryStorage()),
        ...dependency,
      });
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow("unsafe audit");
    }

    const invalidRead = new LocalAuditSink({
      ...dependencies(new MemoryStorage()),
      storage: {
        readAll: async () => ({}) as never,
        append: async () => undefined,
      },
    });
    await expect(invalidRead.flush()).rejects.toThrow("invalid audit storage read output");

    const invalidAppend = new LocalAuditSink({
      ...dependencies(new MemoryStorage()),
      storage: {
        readAll: async () => [],
        append: async () => "unexpected" as never,
      },
    });
    await expect(invalidAppend.append(input, { durability: "required" })).rejects.toThrow(
      "invalid audit storage append output",
    );
  });

  it("enforces a positive safe maxBuffered hard cap", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4097, 2 ** 53]) {
      expect(() => new LocalAuditSink(dependencies(new MemoryStorage()), value)).toThrow(
        "maxBuffered",
      );
    }
    expect(
      () => new LocalAuditSink(dependencies(new MemoryStorage()), MAX_BUFFERED_AUDIT_EVENTS),
    ).not.toThrow();
  });

  it("rejects clock rollback and a valid-but-nonmonotonic sequence", async () => {
    const storage = new MemoryStorage();
    const sink = new LocalAuditSink(dependencies(storage));
    await sink.append(input, { durability: "required" });
    const clock: AuditClock = { now: () => "2025-01-01T00:00:00.000Z" };
    const restarted = new LocalAuditSink({ ...dependencies(storage), clock });
    await expect(restarted.append(input, { durability: "required" })).rejects.toThrow(
      "clock moved backwards",
    );

    const sequence: AuditSequence = { next: async () => 9 };
    const invalidSequence = new LocalAuditSink({
      ...dependencies(new MemoryStorage()),
      sequence,
    });
    await expect(invalidSequence.append(input, { durability: "required" })).rejects.toThrow(
      "sequence output",
    );
  });

  it("rejects tampered, duplicate, gapped, and time-reversed restored history", async () => {
    const mutations = [
      (events: AuditEvent[]) => ({ ...events[1], nodeEventSeq: 9 }),
      (events: AuditEvent[]) => ({ ...events[1], previousHash: "tampered" }),
      (events: AuditEvent[]) => ({ ...events[1], eventHash: "tampered" }),
      (events: AuditEvent[]) => ({ ...events[1], eventId: events[0]?.eventId ?? "missing" }),
      (events: AuditEvent[]) => ({ ...events[1], occurredAt: "2025-01-01T00:00:00.000Z" }),
    ];
    for (const mutate of mutations) {
      const storage = new MemoryStorage();
      const sink = new LocalAuditSink(dependencies(storage));
      await sink.append(input, { durability: "required" });
      await sink.append(input, { durability: "required" });
      storage.events[1] = mutate(storage.events);
      const restored = new LocalAuditSink(dependencies(storage));
      await expect(restored.flush()).rejects.toThrow();
    }
  });

  it("snapshots every restored row before a deferred hash can mutate returned history", async () => {
    const seedStorage = new MemoryStorage();
    const seed = new LocalAuditSink(dependencies(seedStorage));
    const first = await seed.append(input, { durability: "required" });
    const second = await seed.append({ ...input, outcome: "denied" }, { durability: "required" });
    const mutations: Array<(rows: AuditEvent[]) => void> = [
      (rows) => {
        rows.splice(1);
      },
      (rows) => {
        rows.reverse();
      },
      (rows) => {
        const future = rows[1];
        if (!future) throw new Error("missing future audit row");
        future.action = "token-canary";
        future.resource.id = "../mutated";
        future.eventHash = "sha256:mutated";
      },
      (rows) => {
        const future = rows[1];
        if (!future) throw new Error("missing future audit row");
        rows.push({ ...mutableEvent(future), nodeEventSeq: 99 });
      },
    ];

    for (const mutate of mutations) {
      const returned = [mutableEvent(first), mutableEvent(second)];
      const storage = new SharedReadStorage(returned);
      const hash = new DeferredFirstHash();
      const restored = new LocalAuditSink({ ...dependencies(storage, 3), hash });
      await hash.firstStarted;
      mutate(returned);
      hash.release();

      await restored.flush();
      const next = await restored.append(input, { durability: "required" });
      expect(next).toMatchObject({ nodeEventSeq: 3, previousHash: second.eventHash });
      expect(storage.appended).toEqual([next]);
      expect(hash.calls).toBe(3);
    }
  });

  it("strictly snapshots and validates future restored rows before the first hash await", async () => {
    const seedStorage = new MemoryStorage();
    const seed = new LocalAuditSink(dependencies(seedStorage));
    const first = await seed.append(input, { durability: "required" });
    const second = await seed.append({ ...input, outcome: "denied" }, { durability: "required" });
    const unsafeFuture = await withRecomputedHash({
      ...mutableEvent(second),
      action: "token-canary",
    });
    const invalidFuture = { ...mutableEvent(second), injected: true } as AuditEvent;

    for (const future of [unsafeFuture, invalidFuture]) {
      const hash = new DeferredFirstHash();
      const restored = new LocalAuditSink({
        ...dependencies(new SharedReadStorage([mutableEvent(first), future]), 3),
        hash,
      });
      await expect(restored.flush()).rejects.toThrow();
      expect(hash.calls).toBe(0);
    }
  });

  it("rejects hash-consistent restored records that violate canonical safety", async () => {
    const unsafeEvents = [
      { ...finalized(), action: "Bearer token-canary" },
      { ...finalized(), resource: { kind: "workspace", id: "../private/key" } },
      { ...finalized(), reasonCode: "control\u0085character" },
      { ...finalized(), metadata: { count: 1, status: "string-is-not-canonical" } },
      { ...finalized(), eventId: "evt_control\u007f" },
    ];
    for (const unsafe of unsafeEvents) {
      const storage = new MemoryStorage();
      storage.events.push(await withRecomputedHash(unsafe));
      const restored = new LocalAuditSink(dependencies(storage));
      await expect(restored.flush()).rejects.toThrow("unsafe audit");
    }
  });

  it("hashes canonical object order without including eventHash", async () => {
    const hash = new Sha256AuditHash();
    const base = {
      eventId: "evt_1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      organizationId: "org_0000000000000001",
      nodeId: "nod_0000000000000001",
      nodeEventSeq: 1,
      actorPrincipalId: "usr_0000000000000001",
      action: "workspace.read",
      resource: { kind: "workspace", id: "ws_1" },
      outcome: "allowed" as const,
      metadata: { count: 1, source: "test" },
    };
    const reordered = { ...base, metadata: { source: "test", count: 1 } };
    expect(await hash.hash(base)).toBe(await hash.hash(reordered));
  });

  it("strictly rejects caller authority fields and unsafe open strings", async () => {
    const sink = new LocalAuditSink(dependencies(new MemoryStorage()));
    const withAuthority = { ...input, previousHash: "caller" };
    await expect(sink.append(withAuthority, { durability: "required" })).rejects.toThrow();
    for (const candidate of [
      { ...input, action: "Bearer abc" },
      { ...input, action: "../etc/passwd" },
      { ...input, reasonCode: "line\nfeed" },
      { ...input, resource: { kind: "workspace", id: "token-canary" } },
    ]) {
      await expect(sink.append(candidate, { durability: "required" })).rejects.toThrow(
        "unsafe audit",
      );
    }
  });
});

describe("JsonlAuditStorage", () => {
  it("requires an explicit non-zero O_NOFOLLOW capability", () => {
    const files = new FaultFiles([], 0);
    expect(() => new JsonlAuditStorage("/unused", files)).toThrow("non-zero O_NOFOLLOW");
  });

  it("exports a fail-closed release marker for the portable parent-openat gap", () => {
    const files = new NodeAuditFileSystem(TEST_NOFOLLOW_FLAG);
    const storage = new JsonlAuditStorage("/unused", files);
    expect(PORTABLE_AUDIT_STORAGE_RELEASE_READY).toBe(false);
    expect(PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON).toBe("portable_parent_openat_unavailable");
    expect(files.releaseReady).toBe(false);
    expect(files.unsupportedReason).toBe(PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON);
    expect(storage.releaseReady).toBe(false);
    expect(storage.unsupportedReason).toBe(PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON);
  });

  it("uses typed same-handle file operations and parent fsync in exact append order", async () => {
    const directory = await temporaryDirectory("paseo-audit-order-");
    const files = new FaultFiles();
    try {
      await new JsonlAuditStorage(directory, files).append(finalized());
      expect(files.trace).toEqual([
        "ensure",
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "open:pending",
        "open:data",
        "data2:stat",
        "data2:chmod",
        "data2:stat",
        "data2:read",
        "data2:write",
        "data2:sync",
        "directory1:sync",
        "data2:close",
        "directory1:close",
      ]);
      expect(files.opens.every((record) => (record.flags & files.noFollowFlag) !== 0)).toBe(true);
      const dataOpen = files.opens.find((record) => record.name.endsWith(".jsonl"));
      expect(dataOpen?.flags).toBe(
        fileConstants.O_RDWR |
          fileConstants.O_APPEND |
          fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          files.noFollowFlag,
      );
      expect(dataOpen?.mode).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the typed directory adapter and one validated handle per audit file", async () => {
    const directory = await temporaryDirectory("paseo-audit-read-");
    await new JsonlAuditStorage(directory, new FaultFiles()).append(finalized());
    const files = new FaultFiles();
    try {
      const events = await new JsonlAuditStorage(directory, files).readAll();
      expect(events).toEqual([finalized()]);
      expect(files.trace).toEqual([
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "open:pending",
        "directory1:read",
        "open:data",
        "data2:stat",
        "data2:chmod",
        "data2:stat",
        "data2:read",
        "data2:close",
        "directory1:close",
      ]);
      expect(files.opens.every((record) => (record.flags & files.noFollowFlag) !== 0)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats canonically identical reordered JSON as an idempotent same-handle append", async () => {
    const directory = await temporaryDirectory("paseo-audit-idempotent-");
    const event = finalized();
    const file = path.join(directory, "audit-2026-01-01.jsonl");
    const reordered = {
      eventHash: event.eventHash,
      outcome: event.outcome,
      resource: { id: event.resource.id, kind: event.resource.kind },
      action: event.action,
      actorPrincipalId: event.actorPrincipalId,
      nodeEventSeq: event.nodeEventSeq,
      nodeId: event.nodeId,
      organizationId: event.organizationId,
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    };
    await writeFile(file, `${JSON.stringify(reordered)}\n`, { mode: 0o600 });
    const before = await readFile(file, "utf8");
    const files = new FaultFiles();
    try {
      await new JsonlAuditStorage(directory, files).append(event);
      expect(await readFile(file, "utf8")).toBe(before);
      expect(files.trace).toEqual([
        "ensure",
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "open:pending",
        "open:data",
        "open:data",
        "data2:stat",
        "data2:chmod",
        "data2:stat",
        "data2:read",
        "data2:close",
        "directory1:close",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls an existing file back to its original size and syncs after a short write", async () => {
    const directory = await temporaryDirectory("paseo-audit-short-existing-");
    const file = path.join(directory, "audit-2026-01-01.jsonl");
    await new JsonlAuditStorage(directory, new FaultFiles()).append(finalized());
    const before = await readFile(file, "utf8");
    const files = new FaultFiles([{ operation: "data.write", mode: "short" }]);
    const storage = new JsonlAuditStorage(directory, files);
    try {
      await expect(storage.append(finalized(2, "denied"))).rejects.toThrow("audit short write");
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await readdir(directory)).toEqual(["audit-2026-01-01.jsonl"]);
      expect(files.trace).toEqual([
        "ensure",
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "open:pending",
        "open:data",
        "open:data",
        "data2:stat",
        "data2:chmod",
        "data2:stat",
        "data2:read",
        "data2:write",
        "data2:truncate",
        "data2:sync",
        "data2:close",
        "directory1:close",
      ]);

      await storage.append(finalized(2, "denied"));
      expect((await storage.readAll()).map((event) => event.nodeEventSeq)).toEqual([1, 2]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes and parent-syncs a newly created file after a short write", async () => {
    const directory = await temporaryDirectory("paseo-audit-short-new-");
    const files = new FaultFiles([{ operation: "data.write", mode: "short" }]);
    try {
      await expect(new JsonlAuditStorage(directory, files).append(finalized())).rejects.toThrow(
        "audit short write",
      );
      expect(await readdir(directory)).toEqual([]);
      expect(files.trace).toEqual([
        "ensure",
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "open:pending",
        "open:data",
        "data2:stat",
        "data2:chmod",
        "data2:stat",
        "data2:read",
        "data2:write",
        "data2:truncate",
        "data2:sync",
        "data2:close",
        "unlink",
        "directory1:sync",
        "directory1:close",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls back a file-fsync or parent-fsync failure before reporting it", async () => {
    const cases: Array<{ fault: FileFault; error: string }> = [
      { fault: { operation: "data.sync" }, error: "fault:data.sync" },
      { fault: { operation: "directory.sync" }, error: "fault:directory.sync" },
    ];
    for (const testCase of cases) {
      const directory = await temporaryDirectory("paseo-audit-sync-rollback-");
      const files = new FaultFiles([testCase.fault]);
      const storage = new JsonlAuditStorage(directory, files);
      try {
        await expect(storage.append(finalized())).rejects.toThrow(testCase.error);
        expect(await readdir(directory)).toEqual([]);
        await storage.append(finalized());
        expect(await storage.readAll()).toEqual([finalized()]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("covers ensure, fstat, fchmod, read, and write faults without advancing disk state", async () => {
    const faults: FileFault[] = [
      { operation: "ensure" },
      { operation: "directory.stat" },
      { operation: "directory.chmod" },
      { operation: "directory.stat", occurrence: 2 },
      { operation: "data.stat" },
      { operation: "data.chmod" },
      { operation: "data.stat", occurrence: 2 },
      { operation: "data.read" },
      { operation: "data.write" },
    ];
    for (const fault of faults) {
      const directory = await temporaryDirectory("paseo-audit-stage-");
      const files = new FaultFiles([fault]);
      const storage = new JsonlAuditStorage(directory, files);
      try {
        await expect(storage.append(finalized())).rejects.toThrow(`fault:${fault.operation}`);
        expect(await readdir(directory)).toEqual([]);
        await storage.append(finalized());
        expect(await storage.readAll()).toEqual([finalized()]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects chmod success when same-handle post-stat still reports wide modes", async () => {
    const directory = await temporaryDirectory("paseo-audit-mode-directory-");
    await chmod(directory, 0o777);
    try {
      await expect(
        new JsonlAuditStorage(
          directory,
          new FaultFiles([{ operation: "directory.chmod", mode: "noop" }]),
        ).readAll(),
      ).rejects.toThrow("audit directory mode is not 700");
      expect((await stat(directory)).mode & 0o777).toBe(0o777);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const dataDirectory = await temporaryDirectory("paseo-audit-mode-data-");
    const dataFile = path.join(dataDirectory, "audit-2026-01-01.jsonl");
    await new JsonlAuditStorage(dataDirectory, new FaultFiles()).append(finalized());
    await chmod(dataFile, 0o666);
    const before = await readFile(dataFile, "utf8");
    try {
      await expect(
        new JsonlAuditStorage(
          dataDirectory,
          new FaultFiles([{ operation: "data.chmod", mode: "noop" }]),
        ).append(finalized(2, "denied")),
      ).rejects.toThrow("audit file mode is not 600");
      expect(await readFile(dataFile, "utf8")).toBe(before);
      expect((await stat(dataFile)).mode & 0o777).toBe(0o666);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }

    const markerDirectory = await temporaryDirectory("paseo-audit-mode-marker-");
    const markerFile = path.join(markerDirectory, ".audit-poisoned");
    await writeFile(markerFile, "paseo-audit-poisoned-v1\n", { mode: 0o666 });
    await chmod(markerFile, 0o666);
    try {
      await expect(
        new JsonlAuditStorage(
          markerDirectory,
          new FaultFiles([{ operation: "poison.chmod", mode: "noop" }]),
        ).readAll(),
      ).rejects.toThrow("audit poison marker mode is not 600");
      expect((await stat(markerFile)).mode & 0o777).toBe(0o666);
    } finally {
      await rm(markerDirectory, { recursive: true, force: true });
    }
  });

  it("faults every post-chmod fstat boundary during read and marker handling", async () => {
    const dataDirectory = await temporaryDirectory("paseo-audit-post-stat-data-");
    await new JsonlAuditStorage(dataDirectory, new FaultFiles()).append(finalized());
    try {
      await expect(
        new JsonlAuditStorage(
          dataDirectory,
          new FaultFiles([{ operation: "data.stat", occurrence: 2 }]),
        ).readAll(),
      ).rejects.toThrow("fault:data.stat");
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }

    const markerDirectory = await temporaryDirectory("paseo-audit-post-stat-marker-");
    await writeFile(path.join(markerDirectory, ".audit-poisoned"), "paseo-audit-poisoned-v1\n", {
      mode: 0o600,
    });
    try {
      await expect(
        new JsonlAuditStorage(
          markerDirectory,
          new FaultFiles([{ operation: "poison.stat", occurrence: 2 }]),
        ).readAll(),
      ).rejects.toThrow("fault:poison.stat");
    } finally {
      await rm(markerDirectory, { recursive: true, force: true });
    }
  });

  it("closes exactly once and aggregates directory enumeration plus close failures", async () => {
    const directory = await temporaryDirectory("paseo-audit-directory-errors-");
    const files = new FaultFiles([
      { operation: "directory.read" },
      { operation: "directory.close", mode: "after" },
    ]);
    try {
      let failure: unknown;
      try {
        await new JsonlAuditStorage(directory, files).readAll();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(aggregateMessages(failure)).toEqual(["fault:directory.read", "fault:directory.close"]);
      const aggregate = failure as AggregateError;
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(files.trace.filter((entry) => entry === "directory1:close")).toEqual([
        "directory1:close",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a strict poison marker when rollback fails and preserves the damaged tail", async () => {
    const directory = await temporaryDirectory("paseo-audit-poison-");
    const dataFile = path.join(directory, "audit-2026-01-01.jsonl");
    const poisonFile = path.join(directory, ".audit-poisoned");
    await new JsonlAuditStorage(directory, new FaultFiles()).append(finalized());
    const before = await readFile(dataFile, "utf8");
    const files = new FaultFiles([
      { operation: "data.write", mode: "short" },
      { operation: "data.truncate" },
    ]);
    try {
      let failure: unknown;
      try {
        await new JsonlAuditStorage(directory, files).append(finalized(2, "denied"));
      } catch (error) {
        failure = error;
      }
      expect(aggregateMessages(failure)).toEqual(["audit short write", "fault:data.truncate"]);
      const damaged = await readFile(dataFile, "utf8");
      expect(damaged.startsWith(before)).toBe(true);
      expect(damaged.length).toBeGreaterThan(before.length);
      expect(damaged.endsWith("\n")).toBe(false);
      expect(await readFile(poisonFile, "utf8")).toBe("paseo-audit-poisoned-v1\n");
      expect(files.trace.slice(-16)).toEqual([
        "data2:write",
        "data2:truncate",
        "data2:sync",
        "data2:close",
        "open:poison",
        "open:pending",
        "open:pending",
        "pending3:stat",
        "pending3:chmod",
        "pending3:stat",
        "pending3:write",
        "pending3:sync",
        "pending3:close",
        "rename",
        "directory1:sync",
        "directory1:close",
      ]);
      const pendingOpen = files.opens.find(
        (record) => record.name === ".audit-poisoned.pending" && record.mode === 0o600,
      );
      expect(pendingOpen?.flags).toBe(
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR | files.noFollowFlag,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("poisons when unlink or repeated parent fsync makes new-file rollback uncertain", async () => {
    const cases: readonly FileFault[][] = [
      [{ operation: "data.write", mode: "short" }, { operation: "unlink" }],
      [
        { operation: "directory.sync", occurrence: 1 },
        { operation: "directory.sync", occurrence: 2 },
      ],
    ];
    for (const faults of cases) {
      const directory = await temporaryDirectory("paseo-audit-poison-rollback-");
      try {
        await expect(
          new JsonlAuditStorage(directory, new FaultFiles(faults)).append(finalized()),
        ).rejects.toThrow();
        expect(await readFile(path.join(directory, ".audit-poisoned"), "utf8")).toBe(
          "paseo-audit-poisoned-v1\n",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("poisons a durably written file when file or directory close reports uncertainty", async () => {
    const cases = [
      { operation: "data.close", mode: "after" as const },
      { operation: "directory.close", mode: "after" as const },
    ];
    for (const fault of cases) {
      const directory = await temporaryDirectory("paseo-audit-close-");
      const files = new FaultFiles([fault]);
      try {
        await expect(new JsonlAuditStorage(directory, files).append(finalized())).rejects.toThrow(
          `fault:${fault.operation}`,
        );
        expect(await readFile(path.join(directory, ".audit-poisoned"), "utf8")).toBe(
          "paseo-audit-poisoned-v1\n",
        );
        expect(await readFile(path.join(directory, "audit-2026-01-01.jsonl"), "utf8")).toContain(
          '"eventId":"evt_direct_1"',
        );
        if (fault.operation === "data.close") {
          expect(files.trace.filter((entry) => entry === "data2:close")).toEqual(["data2:close"]);
        } else {
          expect(files.trace.filter((entry) => entry === "directory1:close")).toEqual([
            "directory1:close",
          ]);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps a required failure against poisoned storage degraded through empty flush and close", async () => {
    const directory = await temporaryDirectory("paseo-audit-sink-poisoned-");
    const files = new FaultFiles([{ operation: "data.close", mode: "after" }]);
    const storage = new JsonlAuditStorage(directory, files);
    const transitions: string[] = [];
    const sink = new LocalAuditSink(dependencies(storage), 4, {
      onDegraded: () => transitions.push("degraded"),
      onRecovered: () => transitions.push("recovered"),
    });
    try {
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
        "fault:data.close",
      );
      await expect(sink.flush()).rejects.toThrow("audit storage recovery is unverified");
      const close = sink.close();
      expect(sink.close()).toBe(close);
      await expect(close).rejects.toThrow("audit storage recovery is unverified");
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
        "audit sink closed",
      );
      await expect(sink.flush()).rejects.toThrow("audit sink closed");
      expect(transitions).toEqual(["degraded"]);
      expect(await readFile(path.join(directory, ".audit-poisoned"), "utf8")).toBe(
        "paseo-audit-poisoned-v1\n",
      );
      expect(await readFile(path.join(directory, "audit-2026-01-01.jsonl"), "utf8")).toContain(
        '"nodeEventSeq":1',
      );
      expect(files.trace.filter((entry) => /^data\d+:close$/.test(entry))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("orders primary, rollback/close, and marker failures in one AggregateError", async () => {
    const directory = await temporaryDirectory("paseo-audit-marker-errors-");
    const files = new FaultFiles([
      { operation: "data.write", mode: "short" },
      { operation: "data.truncate" },
      { operation: "pending.write", mode: "short" },
      { operation: "pending.sync" },
      { operation: "pending.close", mode: "after" },
      { operation: "directory.close", mode: "after" },
    ]);
    try {
      let failure: unknown;
      try {
        await new JsonlAuditStorage(directory, files).append(finalized());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(aggregateMessages(failure)).toEqual([
        "audit short write",
        "fault:data.truncate",
        "fault:directory.close",
        "audit poison marker short write",
        "fault:pending.sync",
        "fault:pending.close",
      ]);
      const aggregate = failure as AggregateError;
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(aggregate.cause).toBeInstanceOf(Error);
      expect((aggregate.cause as Error).message).toBe("audit short write");
      expect(await readdir(directory)).toEqual([".audit-poisoned.pending"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces marker fstat, fchmod, rename, and parent-fsync failures as aggregates", async () => {
    const markerFaults: FileFault[] = [
      { operation: "pending.stat" },
      { operation: "pending.chmod" },
      { operation: "pending.stat", occurrence: 2 },
      { operation: "rename" },
      { operation: "directory.sync", occurrence: 2 },
    ];
    for (const markerFault of markerFaults) {
      const directory = await temporaryDirectory("paseo-audit-marker-stage-");
      const files = new FaultFiles([
        { operation: "data.write", mode: "short" },
        { operation: "data.truncate" },
        markerFault,
      ]);
      try {
        let failure: unknown;
        try {
          await new JsonlAuditStorage(directory, files).append(finalized());
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        expect(aggregateMessages(failure)).toContain(`fault:${markerFault.operation}`);
        const names = await readdir(directory);
        expect(names.includes(".audit-poisoned") || names.includes(".audit-poisoned.pending")).toBe(
          true,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("strictly reads a persisted poison marker on restart and rejects every public operation", async () => {
    const directory = await temporaryDirectory("paseo-audit-restart-poison-");
    const poisonFile = path.join(directory, ".audit-poisoned");
    await writeFile(poisonFile, "paseo-audit-poisoned-v1\n", { mode: 0o600 });
    const files = new FaultFiles();
    try {
      await expect(new JsonlAuditStorage(directory, files).readAll()).rejects.toThrow(
        "audit storage poisoned",
      );
      expect(files.trace).toEqual([
        "open:directory",
        "directory1:stat",
        "directory1:chmod",
        "directory1:stat",
        "open:poison",
        "poison2:stat",
        "poison2:chmod",
        "poison2:stat",
        "poison2:read",
        "poison2:close",
        "directory1:close",
      ]);

      await expect(
        new JsonlAuditStorage(directory, new FaultFiles()).append(finalized()),
      ).rejects.toThrow("audit storage poisoned");
      const sink = new LocalAuditSink(
        dependencies(new JsonlAuditStorage(directory, new FaultFiles())),
      );
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
        "audit storage poisoned",
      );
      await expect(sink.flush()).rejects.toThrow("audit storage poisoned");
      const close = sink.close();
      expect(sink.close()).toBe(close);
      await expect(close).rejects.toThrow("audit storage poisoned");
      await expect(sink.append(input, { durability: "required" })).rejects.toThrow(
        "audit sink closed",
      );
      await expect(sink.flush()).rejects.toThrow("audit sink closed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed poison markers and never follows marker or audit-file symlinks", async () => {
    const directory = await temporaryDirectory("paseo-audit-symlink-");
    const external = await temporaryDirectory("paseo-audit-external-");
    try {
      await writeFile(path.join(directory, ".audit-poisoned"), "poisoned\n", { mode: 0o600 });
      await expect(new JsonlAuditStorage(directory, new FaultFiles()).readAll()).rejects.toThrow(
        "invalid audit poison marker",
      );
      await rm(path.join(directory, ".audit-poisoned"));

      const externalFile = path.join(external, "untouched");
      await writeFile(externalFile, "external\n");
      await symlink(externalFile, path.join(directory, ".audit-poisoned"));
      await expect(new JsonlAuditStorage(directory, new FaultFiles()).readAll()).rejects.toThrow();
      await rm(path.join(directory, ".audit-poisoned"));

      await symlink(externalFile, path.join(directory, "audit-2026-01-01.jsonl"));
      await expect(
        new JsonlAuditStorage(directory, new FaultFiles()).append(finalized()),
      ).rejects.toThrow();
      expect(await readFile(externalFile, "utf8")).toBe("external\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked audit directory without reading its target", async () => {
    const parent = await temporaryDirectory("paseo-audit-directory-link-");
    const external = await temporaryDirectory("paseo-audit-directory-target-");
    const linkedDirectory = path.join(parent, "audit");
    try {
      await writeFile(path.join(external, "audit-2026-01-01.jsonl"), "external\n");
      await symlink(external, linkedDirectory);
      await expect(
        new JsonlAuditStorage(linkedDirectory, new FaultFiles()).readAll(),
      ).rejects.toThrow();
      expect(await readFile(path.join(external, "audit-2026-01-01.jsonl"), "utf8")).toBe(
        "external\n",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it("rejects truncated, malformed, date-mismatched, and identity-conflicting JSONL", async () => {
    const corruptions = [
      `${JSON.stringify(finalized())}`,
      "not-json\n",
      `${JSON.stringify({ ...finalized(), occurredAt: "2026-01-02T00:00:00.000Z" })}\n`,
    ];
    for (const contents of corruptions) {
      const directory = await temporaryDirectory("paseo-audit-corrupt-");
      try {
        await writeFile(path.join(directory, "audit-2026-01-01.jsonl"), contents, {
          mode: 0o600,
        });
        await expect(
          new JsonlAuditStorage(directory, new FaultFiles()).readAll(),
        ).rejects.toThrow();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    const directory = await temporaryDirectory("paseo-audit-conflict-");
    try {
      const storage = new JsonlAuditStorage(directory, new FaultFiles());
      await storage.append(finalized());
      await expect(storage.append({ ...finalized(), outcome: "failed" })).rejects.toThrow(
        "audit append identity conflict",
      );
      expect(await storage.readAll()).toEqual([finalized()]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tightens directory and file modes and maintains a cross-day chain on real disk", async () => {
    const directory = await temporaryDirectory("paseo-audit-days-");
    try {
      const files = new FaultFiles();
      const storage = new JsonlAuditStorage(directory, files);
      let clockIndex = 0;
      const clock: AuditClock = {
        now: () =>
          ["2026-01-01T23:59:59.000Z", "2026-01-02T00:00:01.000Z"][clockIndex++] ??
          "2026-01-02T00:00:02.000Z",
      };
      let idIndex = 0;
      const idSource = { next: () => `evt_day_${++idIndex}` };
      const sink = new LocalAuditSink({ ...dependencies(storage), clock, idSource });
      const first = await sink.append(input, { durability: "required" });
      const second = await sink.append(input, { durability: "required" });
      await chmod(directory, 0o777);
      for (const name of await readdir(directory)) await chmod(path.join(directory, name), 0o666);
      const restoredFiles = new FaultFiles();
      const restoredStorage = new JsonlAuditStorage(directory, restoredFiles);
      const restored = new LocalAuditSink({
        ...dependencies(restoredStorage, 3),
        clock: { now: () => "2026-01-02T00:00:02.000Z" },
        idSource,
      });
      const third = await restored.append(input, { durability: "required" });

      expect(second.previousHash).toBe(first.eventHash);
      expect(third).toMatchObject({ nodeEventSeq: 3, previousHash: second.eventHash });
      expect(await readdir(directory)).toEqual([
        "audit-2026-01-01.jsonl",
        "audit-2026-01-02.jsonl",
      ]);
      expect((await restoredFiles.mode(directory)) & 0o077).toBe(0);
      for (const name of await readdir(directory)) {
        expect((await restoredFiles.mode(path.join(directory, name))) & 0o077).toBe(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
