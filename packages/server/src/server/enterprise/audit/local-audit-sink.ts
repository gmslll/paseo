import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AuditAppendOptionsSchema,
  AuditEventInputSchema,
  AuditEventSchema,
  NodeContextSchema,
  PrincipalIdSchema,
} from "@getpaseo/protocol/messages";
import type {
  AuditAppendOptions,
  AuditClock,
  AuditEvent,
  AuditEventInput,
  AuditHash,
  AuditHashInput,
  AuditIdSource,
  LocalAuditSinkContract,
  LocalAuditSinkDependencies,
  AuditSequence,
  AuditStorage,
  StandaloneNodeContext,
} from "@getpaseo/protocol/messages";

/* eslint-disable complexity */

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export const MAX_BUFFERED_AUDIT_EVENTS = 4096;
export const PORTABLE_AUDIT_STORAGE_RELEASE_READY = false;
export const PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON =
  "portable_parent_openat_unavailable" as const;
const POISON_PAYLOAD = "paseo-audit-poisoned-v1\n";
const AUDIT_FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const ALLOWED_SCALAR_METADATA_KEYS = new Set([
  "count",
  "source",
  "mode",
  "reason",
  "attempt",
  "durationMs",
  "status",
]);
const OWNERSHIP_TRANSFER_ACTION = "enterprise.resource.ownership.transfer";
const OWNERSHIP_TRANSFER_PHASES = new Set(["intent", "storage"]);
const OWNERSHIP_TRANSFER_METADATA_KEYS = new Set([
  "phase",
  "newOwnerPrincipalId",
  "revision",
  "intentEventId",
]);

export interface AuditFileStat {
  readonly size: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface AuditFileHandle {
  stat(): Promise<AuditFileStat>;
  chmod(mode: number): Promise<void>;
  readFile(encoding: "utf8"): Promise<string>;
  write(data: string): Promise<{ bytesWritten: number }>;
  truncate(size: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AuditDirectoryHandle {
  stat(): Promise<AuditFileStat>;
  chmod(mode: number): Promise<void>;
  openFile(name: string, flags: number, mode?: number): Promise<AuditFileHandle>;
  readEntries(): Promise<readonly string[]>;
  rename(sourceName: string, destinationName: string): Promise<void>;
  unlink(name: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AuditFileSystem {
  readonly noFollowFlag: number;
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  ensureDirectory(directory: string, mode: number): Promise<void>;
  openDirectory(directory: string, flags: number): Promise<AuditDirectoryHandle>;
}

class NodeAuditDirectoryHandle implements AuditDirectoryHandle {
  constructor(
    private readonly directory: string,
    private readonly handle: FileHandle,
  ) {}

  stat(): Promise<AuditFileStat> {
    return this.handle.stat();
  }

  chmod(mode: number): Promise<void> {
    return this.handle.chmod(mode);
  }

  openFile(name: string, flags: number, mode?: number): Promise<AuditFileHandle> {
    assertAuditEntryName(name);
    // This path join is the portable adapter's release blocker. The Darwin adapter replaces it
    // with openat(2) against the already validated directory descriptor.
    return fs.open(path.join(this.directory, name), flags, mode);
  }

  readEntries(): Promise<readonly string[]> {
    // Node has no portable readdir/openat operation relative to this validated handle. This is
    // the sole path reopen in the adapter and keeps it release-blocked by ADR 0019.
    return fs.readdir(this.directory);
  }

  async rename(sourceName: string, destinationName: string): Promise<void> {
    assertAuditEntryName(sourceName);
    assertAuditEntryName(destinationName);
    await fs.rename(
      path.join(this.directory, sourceName),
      path.join(this.directory, destinationName),
    );
  }

  async unlink(name: string): Promise<void> {
    assertAuditEntryName(name);
    await fs.unlink(path.join(this.directory, name));
  }

  sync(): Promise<void> {
    return this.handle.sync();
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

export class NodeAuditFileSystem implements AuditFileSystem {
  readonly noFollowFlag: number;
  readonly releaseReady = PORTABLE_AUDIT_STORAGE_RELEASE_READY;
  readonly unsupportedReason = PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON;

  constructor(noFollowFlag = fileConstants.O_NOFOLLOW) {
    this.noFollowFlag = noFollowFlag;
    assertNoFollowFlag(this.noFollowFlag);
  }

  async ensureDirectory(directory: string, mode: number): Promise<void> {
    await fs.mkdir(directory, { recursive: true, mode });
  }

  async openDirectory(directory: string, flags: number): Promise<AuditDirectoryHandle> {
    const handle = await fs.open(directory, flags);
    return new NodeAuditDirectoryHandle(directory, handle);
  }
}

export function assertAuditEntryName(name: string): void {
  if (
    name.length < 1 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    hasControlCharacter(name)
  ) {
    throw new Error("invalid audit directory entry name");
  }
}

function assertNoFollowFlag(flag: number): void {
  if (!Number.isInteger(flag) || flag === 0) {
    throw new Error("audit storage requires a non-zero O_NOFOLLOW");
  }
}

function assertFileStat(stat: AuditFileStat, mode: number, subject: string): void {
  assertRegularFile(stat, subject);
  if (!Number.isSafeInteger(stat.mode) || stat.mode < 0 || (stat.mode & 0o7777) !== mode) {
    throw new Error(`${subject} mode is not ${mode.toString(8)}`);
  }
}

function assertRegularFile(stat: AuditFileStat, subject: string): void {
  if (!stat.isFile()) throw new Error(`${subject} is not regular`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
    throw new Error(`${subject} size is invalid`);
  }
}

function assertDirectoryStat(stat: AuditFileStat): void {
  if (!stat.isDirectory()) throw new Error("audit directory is not a directory");
  if (
    !Number.isSafeInteger(stat.dev) ||
    stat.dev < 0 ||
    !Number.isSafeInteger(stat.ino) ||
    stat.ino < 1
  ) {
    throw new Error("audit directory identity is invalid");
  }
  if (
    !Number.isSafeInteger(stat.mode) ||
    stat.mode < 0 ||
    (stat.mode & 0o7777) !== DIRECTORY_MODE
  ) {
    throw new Error("audit directory mode is not 700");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function pushError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    const reasons: readonly unknown[] = error.errors;
    for (const reason of reasons) errors.push(reason);
    return;
  }
  errors.push(error);
}

function aggregateError(errors: readonly unknown[], message: string): AggregateError {
  return new AggregateError(errors, message, { cause: errors[0] });
}

function throwCollected(errors: readonly unknown[], message: string): never {
  if (errors.length === 1) throw errors[0];
  throw aggregateError(errors, message);
}

function compareCanonicalEntries(left: [string, unknown], right: [string, unknown]): number {
  if (left[0] < right[0]) return -1;
  if (left[0] > right[0]) return 1;
  return 0;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(compareCanonicalEntries)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("unsupported canonical audit value");
  return serialized;
}

function parseTimestamp(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`invalid audit ${source} timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`invalid audit ${source} timestamp`);
  }
  return value;
}

function parseEventId(value: unknown): string {
  const parsed = AuditEventSchema.shape.eventId.safeParse(value);
  if (!parsed.success) throw new Error("invalid audit id source output");
  assertSafeOpenString(parsed.data, "eventId");
  return parsed.data;
}

function parseSequence(value: unknown, previous: number | null): number {
  const parsed = AuditEventSchema.shape.nodeEventSeq.safeParse(value);
  const expected = (previous ?? 0) + 1;
  if (!parsed.success || !Number.isSafeInteger(parsed.data) || parsed.data !== expected) {
    throw new Error("invalid audit sequence output");
  }
  return parsed.data;
}

function parseHash(value: unknown): string {
  const parsed = AuditEventSchema.shape.eventHash.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new Error("invalid audit hash output");
  }
  assertSafeOpenString(parsed.data, "eventHash");
  return parsed.data;
}

function parseStoredEvent(value: unknown): AuditEvent {
  const parsed = AuditEventSchema.strict().safeParse(value);
  if (!parsed.success || !parsed.data.eventHash) {
    throw new Error("invalid finalized audit event");
  }
  parseTimestamp(parsed.data.occurredAt, "event");
  if (!Number.isSafeInteger(parsed.data.nodeEventSeq) || parsed.data.nodeEventSeq < 1) {
    throw new Error("invalid finalized audit event");
  }
  validateFinalizedSafety(parsed.data);
  return cloneFrozenEvent(parsed.data);
}

function snapshotStoredEvents(value: unknown): readonly AuditEvent[] {
  if (!Array.isArray(value)) throw new Error("invalid audit storage read output");
  const length = value.length;
  const events: AuditEvent[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error("invalid sparse audit storage read output");
    }
    events.push(parseStoredEvent(value[index]));
  }
  if (value.length !== length) throw new Error("audit storage read output mutated during snapshot");
  return Object.freeze(events);
}

function cloneFrozenEvent(event: AuditEvent): AuditEvent {
  const resource = Object.freeze({ ...event.resource });
  const metadata = event.metadata ? Object.freeze({ ...event.metadata }) : undefined;
  return Object.freeze({ ...event, resource, metadata });
}

function sameAuditEvent(left: AuditEvent | null, right: AuditEvent | null): boolean {
  if (left === null || right === null) return left === right;
  return stable(left) === stable(right);
}

function cloneFrozenHashInput(event: AuditEvent): Readonly<AuditHashInput> {
  const { eventHash: _eventHash, ...input } = cloneFrozenEvent(event);
  return Object.freeze(input);
}

export class UtcClock implements AuditClock {
  now(): string {
    return new Date().toISOString();
  }
}

export class RandomAuditIdSource implements AuditIdSource {
  next(): string {
    return `evt_${randomUUID()}`;
  }
}

export class Sha256AuditHash implements AuditHash {
  async hash(event: Readonly<AuditHashInput>): Promise<string> {
    return `sha256:${createHash("sha256").update(stable(event)).digest("hex")}`;
  }
}

export class IncrementalAuditSequence implements AuditSequence {
  async next(previousSequence: number | null): Promise<number> {
    return (previousSequence ?? 0) + 1;
  }
}

interface AppendHandle {
  readonly handle: AuditFileHandle;
  readonly created: boolean;
}

interface AuditDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OpenedAuditDirectory {
  readonly handle: AuditDirectoryHandle;
  readonly identity: AuditDirectoryIdentity;
}

interface CapturedAuditFileSystem {
  readonly noFollowFlag: number;
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  readonly ensureDirectory: (directory: string, mode: number) => Promise<void>;
  readonly openDirectory: (directory: string, flags: number) => Promise<AuditDirectoryHandle>;
}

function captureAuditFileSystem(fileSystem: AuditFileSystem): CapturedAuditFileSystem {
  const noFollowFlag = fileSystem.noFollowFlag;
  const releaseReady = fileSystem.releaseReady;
  const unsupportedReason = fileSystem.unsupportedReason;
  const ensureDirectory = fileSystem.ensureDirectory.bind(fileSystem);
  const openDirectory = fileSystem.openDirectory.bind(fileSystem);
  return Object.freeze({
    noFollowFlag,
    releaseReady,
    unsupportedReason,
    ensureDirectory,
    openDirectory,
  });
}

export class JsonlAuditStorage implements AuditStorage {
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  private readonly noFollowFlag: number;
  private readonly files: CapturedAuditFileSystem;
  private poisoned = false;

  constructor(
    private readonly directory: string,
    fileSystem: AuditFileSystem = new NodeAuditFileSystem(),
  ) {
    this.files = captureAuditFileSystem(fileSystem);
    this.noFollowFlag = this.files.noFollowFlag;
    this.releaseReady = this.files.releaseReady;
    this.unsupportedReason = this.files.unsupportedReason;
    assertNoFollowFlag(this.noFollowFlag);
  }

  private get poisonName(): string {
    return ".audit-poisoned";
  }

  private get pendingPoisonName(): string {
    return ".audit-poisoned.pending";
  }

  async readAll(): Promise<readonly AuditEvent[]> {
    this.assertNotPoisoned();
    let directoryHandle: AuditDirectoryHandle;
    try {
      directoryHandle = (await this.openDirectory(false)).handle;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    const errors: unknown[] = [];
    const events: AuditEvent[] = [];
    try {
      await this.assertNoPoisonMarker(directoryHandle);
      const names = (await directoryHandle.readEntries())
        .filter((name) => AUDIT_FILE_PATTERN.test(name))
        .sort();
      for (const name of names) {
        const date = AUDIT_FILE_PATTERN.exec(name)?.[1];
        if (!date) throw new Error("invalid audit file name");
        const text = await this.readFile(directoryHandle, name);
        if (text && !text.endsWith("\n")) throw new Error("truncated audit line");
        for (const line of text.split("\n")) {
          if (!line) continue;
          const event = parseStoredEvent(JSON.parse(line));
          if (event.occurredAt.slice(0, 10) !== date) throw new Error("audit date mismatch");
          events.push(event);
        }
      }
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await directoryHandle.close();
    } catch (error) {
      pushError(errors, error);
    }
    if (errors.length > 0) throwCollected(errors, "audit read failed");
    return events;
  }

  async append(event: Readonly<AuditEvent>): Promise<void> {
    this.assertNotPoisoned();
    const finalized = parseStoredEvent(event);
    const date = finalized.occurredAt.slice(0, 10);
    const fileName = `audit-${date}.jsonl`;
    const errors: unknown[] = [];
    let directoryHandle: AuditDirectoryHandle | null = null;
    let fileHandle: AuditFileHandle | null = null;
    const markerErrors: unknown[] = [];
    let fileCloseAttempted = false;
    let directoryCloseAttempted = false;
    let created = false;
    let mutationStarted = false;
    let commitDurable = false;
    let needsPoison = false;
    let poisonAttempted = false;
    let poisonPersisted = false;
    let originalSize = 0;
    let directoryIdentity: AuditDirectoryIdentity | null = null;

    try {
      const openedDirectory = await this.openDirectory(true);
      directoryHandle = openedDirectory.handle;
      directoryIdentity = openedDirectory.identity;
      await this.assertNoPoisonMarker(directoryHandle);
      const appendHandle = await this.openAppendHandle(directoryHandle, fileName);
      fileHandle = appendHandle.handle;
      created = appendHandle.created;
      const stat = await fileHandle.stat();
      assertRegularFile(stat, "audit file");
      originalSize = stat.size;
      await fileHandle.chmod(FILE_MODE);
      const securedStat = await fileHandle.stat();
      assertFileStat(securedStat, FILE_MODE, "audit file");
      if (securedStat.size !== originalSize)
        throw new Error("audit file changed during validation");
      const text = await fileHandle.readFile("utf8");
      if (text && !text.endsWith("\n")) throw new Error("audit file is truncated");
      const alreadyAppended = this.isAlreadyAppended(text, finalized, date);
      if (!alreadyAppended) {
        const payload = `${stable(finalized)}\n`;
        mutationStarted = true;
        const write = await fileHandle.write(payload);
        if (write.bytesWritten !== Buffer.byteLength(payload)) throw new Error("audit short write");
        await fileHandle.sync();
        await directoryHandle.sync();
        commitDurable = true;
      }
    } catch (error) {
      pushError(errors, error);
    }

    const mustRestoreFile = mutationStarted || created;
    if (errors.length > 0 && mustRestoreFile && !commitDurable && fileHandle) {
      const rollbackErrors: unknown[] = [];
      try {
        await fileHandle.truncate(originalSize);
      } catch (error) {
        pushError(rollbackErrors, error);
      }
      try {
        await fileHandle.sync();
      } catch (error) {
        pushError(rollbackErrors, error);
      }
      if (created) {
        fileCloseAttempted = true;
        try {
          await fileHandle.close();
        } catch (error) {
          pushError(rollbackErrors, error);
        }
        try {
          if (!directoryHandle) throw new Error("audit directory handle unavailable for rollback");
          await directoryHandle.unlink(fileName);
        } catch (error) {
          pushError(rollbackErrors, error);
        }
        if (directoryHandle) {
          try {
            await directoryHandle.sync();
          } catch (error) {
            pushError(rollbackErrors, error);
          }
        }
      }
      if (rollbackErrors.length > 0) {
        needsPoison = true;
        for (const error of rollbackErrors) pushError(errors, error);
      }
    }

    if (fileHandle && !fileCloseAttempted) {
      fileCloseAttempted = true;
      try {
        await fileHandle.close();
      } catch (error) {
        needsPoison = true;
        pushError(errors, error);
      }
    }

    if (needsPoison && directoryHandle) {
      this.poisoned = true;
      poisonAttempted = true;
      try {
        await this.persistPoisonMarkerWithHandle(directoryHandle);
        poisonPersisted = true;
      } catch (error) {
        pushError(markerErrors, error);
      }
    }
    if (directoryHandle && !directoryCloseAttempted) {
      directoryCloseAttempted = true;
      try {
        await directoryHandle.close();
      } catch (error) {
        needsPoison = true;
        pushError(errors, error);
      }
    }

    if (commitDurable && errors.length > 0) needsPoison = true;
    if (needsPoison && !poisonAttempted) {
      this.poisoned = true;
      try {
        if (!directoryIdentity) throw new Error("audit directory identity unavailable for poison");
        await this.persistPoisonMarker(directoryIdentity);
        poisonPersisted = true;
      } catch (error) {
        pushError(markerErrors, error);
      }
    }
    if (needsPoison) {
      const orderedErrors = [...errors, ...markerErrors];
      if (!poisonPersisted) {
        throw aggregateError(orderedErrors, "audit failure and poison marker persistence failed");
      }
      throwCollected(orderedErrors, "audit storage poisoned after uncertain append");
    }
    if (errors.length > 0) throwCollected(errors, "audit append failed");
  }

  private assertNotPoisoned(): void {
    if (this.poisoned) throw new Error("audit storage poisoned");
  }

  private async openDirectory(create: boolean): Promise<OpenedAuditDirectory> {
    if (create) await this.files.ensureDirectory(this.directory, DIRECTORY_MODE);
    const handle = await this.files.openDirectory(
      this.directory,
      fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | this.noFollowFlag,
    );
    const errors: unknown[] = [];
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory()) throw new Error("audit directory is not a directory");
      await handle.chmod(DIRECTORY_MODE);
      const securedStat = await handle.stat();
      assertDirectoryStat(securedStat);
      return {
        handle,
        identity: Object.freeze({ dev: securedStat.dev, ino: securedStat.ino }),
      };
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await handle.close();
    } catch (error) {
      pushError(errors, error);
    }
    throwCollected(errors, "audit directory validation failed");
  }

  private async openAppendHandle(
    directoryHandle: AuditDirectoryHandle,
    fileName: string,
  ): Promise<AppendHandle> {
    try {
      const handle = await directoryHandle.openFile(
        fileName,
        fileConstants.O_RDWR |
          fileConstants.O_APPEND |
          fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          this.noFollowFlag,
        FILE_MODE,
      );
      return { handle, created: true };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    const handle = await directoryHandle.openFile(
      fileName,
      fileConstants.O_RDWR | fileConstants.O_APPEND | this.noFollowFlag,
    );
    return { handle, created: false };
  }

  private async readFile(directoryHandle: AuditDirectoryHandle, fileName: string): Promise<string> {
    const handle = await directoryHandle.openFile(
      fileName,
      fileConstants.O_RDONLY | this.noFollowFlag,
    );
    const errors: unknown[] = [];
    let text = "";
    try {
      const stat = await handle.stat();
      assertRegularFile(stat, "audit file");
      await handle.chmod(FILE_MODE);
      const securedStat = await handle.stat();
      assertFileStat(securedStat, FILE_MODE, "audit file");
      if (securedStat.size !== stat.size) throw new Error("audit file changed during validation");
      text = await handle.readFile("utf8");
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await handle.close();
    } catch (error) {
      pushError(errors, error);
    }
    if (errors.length > 0) throwCollected(errors, "audit file read failed");
    return text;
  }

  private isAlreadyAppended(text: string, event: AuditEvent, date: string): boolean {
    for (const line of text.split("\n")) {
      if (!line) continue;
      const existing = parseStoredEvent(JSON.parse(line));
      if (existing.occurredAt.slice(0, 10) !== date) throw new Error("audit date mismatch");
      const hasIdentityCollision =
        existing.eventId === event.eventId || existing.nodeEventSeq === event.nodeEventSeq;
      if (!hasIdentityCollision) continue;
      if (stable(existing) === stable(event)) return true;
      throw new Error("audit append identity conflict");
    }
    return false;
  }

  private async readMarker(
    directoryHandle: AuditDirectoryHandle,
    markerName: string,
  ): Promise<boolean> {
    let handle: AuditFileHandle;
    try {
      handle = await directoryHandle.openFile(
        markerName,
        fileConstants.O_RDONLY | this.noFollowFlag,
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }
    const errors: unknown[] = [];
    let text = "";
    try {
      const stat = await handle.stat();
      assertRegularFile(stat, "audit poison marker");
      await handle.chmod(FILE_MODE);
      const securedStat = await handle.stat();
      assertFileStat(securedStat, FILE_MODE, "audit poison marker");
      if (securedStat.size !== stat.size) {
        throw new Error("audit poison marker changed during validation");
      }
      text = await handle.readFile("utf8");
      if (text !== POISON_PAYLOAD) throw new Error("invalid audit poison marker");
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await handle.close();
    } catch (error) {
      pushError(errors, error);
    }
    if (errors.length > 0) throwCollected(errors, "audit poison marker read failed");
    return true;
  }

  private async assertNoPoisonMarker(directoryHandle: AuditDirectoryHandle): Promise<void> {
    const hasMarker =
      (await this.readMarker(directoryHandle, this.poisonName)) ||
      (await this.readMarker(directoryHandle, this.pendingPoisonName));
    if (!hasMarker) return;
    this.poisoned = true;
    throw new Error("audit storage poisoned");
  }

  private async persistPoisonMarker(expectedIdentity: AuditDirectoryIdentity): Promise<void> {
    const errors: unknown[] = [];
    let directoryHandle: AuditDirectoryHandle | null = null;
    try {
      const openedDirectory = await this.openDirectory(false);
      directoryHandle = openedDirectory.handle;
      if (
        openedDirectory.identity.dev !== expectedIdentity.dev ||
        openedDirectory.identity.ino !== expectedIdentity.ino
      ) {
        throw new Error("audit directory identity changed before poison persistence");
      }
      await this.persistPoisonMarkerWithHandle(directoryHandle);
    } catch (error) {
      pushError(errors, error);
    }

    if (directoryHandle) {
      try {
        await directoryHandle.close();
      } catch (error) {
        pushError(errors, error);
      }
    }
    if (errors.length > 0) {
      throw aggregateError(errors, "failed to persist audit poison marker");
    }
  }

  private async persistPoisonMarkerWithHandle(
    directoryHandle: AuditDirectoryHandle,
  ): Promise<void> {
    const errors: unknown[] = [];
    try {
      if (await this.readMarker(directoryHandle, this.poisonName)) return;
    } catch (error) {
      pushError(errors, error);
    }

    let pendingExists = false;
    if (errors.length === 0) {
      try {
        pendingExists = await this.readMarker(directoryHandle, this.pendingPoisonName);
      } catch (error) {
        pushError(errors, error);
      }
    }

    if (!pendingExists && errors.length === 0) {
      try {
        await this.createPendingPoisonMarker(directoryHandle);
        pendingExists = true;
      } catch (error) {
        pushError(errors, error);
      }
    }

    if (pendingExists && errors.length === 0) {
      try {
        await directoryHandle.rename(this.pendingPoisonName, this.poisonName);
        await directoryHandle.sync();
      } catch (error) {
        pushError(errors, error);
      }
    }
    if (errors.length > 0) {
      throw aggregateError(errors, "failed to persist audit poison marker");
    }
  }

  private async createPendingPoisonMarker(directoryHandle: AuditDirectoryHandle): Promise<void> {
    const errors: unknown[] = [];
    let markerHandle: AuditFileHandle | null = null;
    try {
      markerHandle = await directoryHandle.openFile(
        this.pendingPoisonName,
        fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR | this.noFollowFlag,
        FILE_MODE,
      );
    } catch (error) {
      pushError(errors, error);
    }
    if (!markerHandle) {
      throw aggregateError(errors, "failed to open audit poison marker");
    }

    try {
      const stat = await markerHandle.stat();
      assertRegularFile(stat, "audit poison marker");
      if (stat.size !== 0) {
        throw new Error("invalid new audit poison marker");
      }
      await markerHandle.chmod(FILE_MODE);
      const securedStat = await markerHandle.stat();
      assertFileStat(securedStat, FILE_MODE, "audit poison marker");
      if (securedStat.size !== 0) throw new Error("invalid new audit poison marker");
      const write = await markerHandle.write(POISON_PAYLOAD);
      if (write.bytesWritten !== Buffer.byteLength(POISON_PAYLOAD)) {
        throw new Error("audit poison marker short write");
      }
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await markerHandle.sync();
    } catch (error) {
      pushError(errors, error);
    }
    try {
      await markerHandle.close();
    } catch (error) {
      pushError(errors, error);
    }
    if (errors.length > 0) {
      throw aggregateError(errors, "failed to prepare audit poison marker");
    }
  }
}

function redact(input: AuditEventInput): AuditEventInput {
  const metadata = input.metadata
    ? Object.fromEntries(
        Object.entries(input.metadata).filter(([key, value]) =>
          isCanonicalMetadataEntry(input.action, key, value),
        ),
      )
    : undefined;
  const resource = Object.freeze({ kind: input.resource.kind, id: input.resource.id });
  const frozenMetadata = metadata ? Object.freeze({ ...metadata }) : undefined;
  return Object.freeze({
    organizationId: input.organizationId,
    actorPrincipalId: input.actorPrincipalId,
    ...(input.actorCredentialId !== undefined
      ? { actorCredentialId: input.actorCredentialId }
      : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    action: input.action,
    resource,
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    outcome: input.outcome,
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    ...(frozenMetadata !== undefined ? { metadata: frozenMetadata } : {}),
  });
}

function isSafeOpenString(value: string): boolean {
  return !(
    value.length > 256 ||
    hasControlCharacter(value) ||
    /bearer|token|canary|secret|password/i.test(value) ||
    /[\\/]/.test(value) ||
    value.includes("..")
  );
}

function assertSafeOpenString(value: string, field: string): void {
  if (!isSafeOpenString(value)) throw new Error(`unsafe audit ${field}`);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function validateOpenStrings(input: AuditEventInput): void {
  for (const [field, value] of [
    ["organizationId", input.organizationId],
    ["actorPrincipalId", input.actorPrincipalId],
    ["actorCredentialId", input.actorCredentialId],
    ["action", input.action],
    ["reasonCode", input.reasonCode],
    ["resource.kind", input.resource.kind],
    ["resource.id", input.resource.id],
    ["sessionId", input.sessionId],
    ["workspaceId", input.workspaceId],
    ["agentId", input.agentId],
  ] as const) {
    if (value !== undefined) assertSafeOpenString(value, field);
  }
}

function isOwnershipRevision(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function isOwnershipTransferMetadataEntry(key: string, value: unknown): boolean {
  if (!OWNERSHIP_TRANSFER_METADATA_KEYS.has(key) || typeof value !== "string") return false;
  if (key === "phase") return OWNERSHIP_TRANSFER_PHASES.has(value);
  if (key === "newOwnerPrincipalId") return PrincipalIdSchema.safeParse(value).success;
  if (key === "revision") return isOwnershipRevision(value);
  return AuditEventSchema.shape.eventId.safeParse(value).success && isSafeOpenString(value);
}

function isCanonicalMetadataEntry(action: string, key: string, value: unknown): boolean {
  if (
    ALLOWED_SCALAR_METADATA_KEYS.has(key) &&
    (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
  ) {
    return true;
  }
  return action === OWNERSHIP_TRANSFER_ACTION && isOwnershipTransferMetadataEntry(key, value);
}

function validateCanonicalMetadata(event: AuditEvent): void {
  if (!event.metadata) return;
  for (const [key, value] of Object.entries(event.metadata)) {
    if (!isCanonicalMetadataEntry(event.action, key, value))
      throw new Error("unsafe audit metadata");
  }
}

function validateFinalizedSafety(event: AuditEvent): void {
  validateOpenStrings(event);
  for (const [field, value] of [
    ["nodeId", event.nodeId],
    ["eventId", event.eventId],
    ["previousHash", event.previousHash],
    ["eventHash", event.eventHash],
  ] as const) {
    if (value !== undefined) assertSafeOpenString(value, field);
  }
  validateCanonicalMetadata(event);
}

interface AuditAppendSnapshot {
  readonly input: AuditEventInput;
  readonly options: AuditAppendOptions;
}

function snapshotAppend(input: AuditEventInput, options: AuditAppendOptions): AuditAppendSnapshot {
  const parsedInput = AuditEventInputSchema.parse(input);
  const parsedOptions = AuditAppendOptionsSchema.parse(options);
  validateOpenStrings(parsedInput);
  const clean = redact(parsedInput);
  const frozenOptions = Object.freeze({ durability: parsedOptions.durability });
  return Object.freeze({ input: clean, options: frozenOptions });
}

interface CapturedAuditPorts {
  readonly clockNow: () => unknown;
  readonly nextId: () => unknown;
  readonly nextSequence: (previous: number | null) => Promise<unknown>;
  readonly hash: (input: Readonly<AuditHashInput>) => Promise<unknown>;
  readonly readAll: () => Promise<unknown>;
  readonly append: (event: Readonly<AuditEvent>) => Promise<unknown>;
}

function capturePorts(deps: LocalAuditSinkDependencies): CapturedAuditPorts {
  const clockNow = deps.clock.now.bind(deps.clock);
  const nextId = deps.idSource.next.bind(deps.idSource);
  const nextSequence = deps.sequence.next.bind(deps.sequence);
  const hash = deps.hash.hash.bind(deps.hash);
  const readAll = deps.storage.readAll.bind(deps.storage);
  const append = deps.storage.append.bind(deps.storage);
  return Object.freeze({
    clockNow: () => clockNow(),
    nextId: () => nextId(),
    nextSequence: async (previous: number | null) => nextSequence(previous),
    hash: async (hashInput: Readonly<AuditHashInput>) => hash(hashInput),
    readAll: async () => readAll(),
    append: async (event: Readonly<AuditEvent>) => append(event),
  });
}

interface AuditObserver {
  onDegraded?(error: unknown): void;
  onRecovered?(): void;
}

function captureObserver(observer: AuditObserver | undefined): AuditObserver {
  const onDegraded = observer?.onDegraded?.bind(observer);
  const onRecovered = observer?.onRecovered?.bind(observer);
  return Object.freeze({ onDegraded, onRecovered });
}

export class LocalAuditSink implements LocalAuditSinkContract {
  readonly adapterKind = "local" as const;
  readonly node: StandaloneNodeContext;
  private readonly ports: CapturedAuditPorts;
  private readonly maxBuffered: number;
  private readonly observer: AuditObserver;
  private chainTail: AuditEvent | null = null;
  private durableTail: AuditEvent | null = null;
  private queue: AuditEvent[] = [];
  private readonly eventIds = new Set<string>();
  private degradation: { readonly error: unknown } | null = null;
  private running: Promise<void> = Promise.resolve();
  private readonly initialized: Promise<void>;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(deps: LocalAuditSinkDependencies, maxBuffered = 1024, observer?: AuditObserver) {
    const node = NodeContextSchema.strict().parse(deps.node);
    if (node.mode !== "standalone") throw new Error("local audit sink requires standalone node");
    this.node = Object.freeze({ ...node, mode: "standalone" });
    if (
      !Number.isSafeInteger(maxBuffered) ||
      maxBuffered < 1 ||
      maxBuffered > MAX_BUFFERED_AUDIT_EVENTS
    ) {
      throw new Error(
        `maxBuffered must be a positive safe integer no greater than ${MAX_BUFFERED_AUDIT_EVENTS}`,
      );
    }
    this.maxBuffered = maxBuffered;
    this.ports = capturePorts(deps);
    this.observer = captureObserver(observer);
    this.initialized = this.restore();
  }

  append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent> {
    if (this.closed) return Promise.reject(new Error("audit sink closed"));
    let snapshot: AuditAppendSnapshot;
    try {
      snapshot = snapshotAppend(input, options);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      if (snapshot.options.durability === "buffered" && this.queue.length > 0) {
        try {
          const flushed = await this.flushQueued();
          if (flushed > 0) this.markRecovered();
        } catch {
          // The accepted queue retains finalized records for the next retry.
        }
      }
      const occurredAt = parseTimestamp(this.ports.clockNow(), "clock");
      if (this.chainTail && Date.parse(occurredAt) < Date.parse(this.chainTail.occurredAt)) {
        throw new Error("audit clock moved backwards");
      }
      const previousSequence = this.chainTail?.nodeEventSeq ?? null;
      const eventId = parseEventId(this.ports.nextId());
      if (this.eventIds.has(eventId)) throw new Error("duplicate audit event id");
      const nodeEventSeq = parseSequence(
        await this.ports.nextSequence(previousSequence),
        previousSequence,
      );
      const event: AuditEvent = {
        ...snapshot.input,
        eventId,
        occurredAt,
        nodeId: this.node.nodeId,
        nodeEventSeq,
        ...(this.chainTail?.eventHash ? { previousHash: this.chainTail.eventHash } : {}),
      };
      event.eventHash = await this.computeHash(event);
      this.validateFinalized(event);
      const finalized = cloneFrozenEvent(event);

      if (snapshot.options.durability === "required") {
        try {
          const flushed = await this.flushQueued();
          if (flushed > 0) this.markRecovered();
          await this.persist(finalized);
          this.accept(finalized);
          this.markRecovered();
        } catch (error) {
          this.markDegraded(error);
          throw error;
        }
      } else if (this.queue.length > 0) {
        if (this.queue.length >= this.maxBuffered) throw new Error("audit buffer full");
        this.queue.push(finalized);
        this.accept(finalized);
      } else {
        try {
          await this.persist(finalized);
          this.accept(finalized);
          this.markRecovered();
        } catch (error) {
          if (this.queue.length >= this.maxBuffered) throw error;
          this.queue.push(finalized);
          this.accept(finalized);
          this.markDegraded(error);
        }
      }
      return finalized;
    });
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("audit sink closed"));
    return this.enqueue(async () => {
      try {
        const flushed = await this.flushQueued();
        this.requireRecoveryEvidence(flushed);
      } catch (error) {
        this.markDegraded(error);
        throw error;
      }
    });
  }

  snapshotEvents(): Promise<readonly AuditEvent[]> {
    if (this.closed) return Promise.reject(new Error("audit sink closed"));
    return this.enqueue(async () => {
      const persisted = snapshotStoredEvents(await this.ports.readAll());
      const persistedState = await this.verifyHistory(persisted);
      if (!sameAuditEvent(persistedState.tail, this.durableTail)) {
        throw new Error("audit durable tail changed outside the sink");
      }

      const events = [...persisted];
      let previous = persistedState.tail;
      const eventIds = new Set(persistedState.eventIds);
      for (const queued of this.queue) {
        if (
          queued.previousHash !== (previous?.eventHash ?? undefined) ||
          queued.nodeEventSeq !== (previous?.nodeEventSeq ?? 0) + 1 ||
          eventIds.has(queued.eventId) ||
          (previous !== null && Date.parse(queued.occurredAt) < Date.parse(previous.occurredAt)) ||
          (await this.computeHash(queued)) !== queued.eventHash
        ) {
          throw new Error("audit queued chain continuity failure");
        }
        events.push(queued);
        eventIds.add(queued.eventId);
        previous = queued;
      }
      if (!sameAuditEvent(previous, this.chainTail)) {
        throw new Error("audit chain tail changed outside the sink");
      }
      return Object.freeze(events.map(cloneFrozenEvent));
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.enqueue(async () => {
      try {
        const flushed = await this.flushQueued();
        this.requireRecoveryEvidence(flushed);
      } catch (error) {
        this.markDegraded(error);
        throw error;
      }
    });
    return this.closePromise;
  }

  private async restore(): Promise<void> {
    // Snapshot and validate the complete returned history before the first async hash boundary.
    const events = snapshotStoredEvents(await this.ports.readAll());
    const restored = await this.verifyHistory(events);
    this.chainTail = restored.tail;
    this.durableTail = restored.tail;
    for (const eventId of restored.eventIds) this.eventIds.add(eventId);
  }

  private async verifyHistory(events: readonly AuditEvent[]): Promise<{
    readonly tail: AuditEvent | null;
    readonly eventIds: ReadonlySet<string>;
  }> {
    let previous: AuditEvent | null = null;
    const restoredIds = new Set<string>();
    for (const event of events) {
      const hasClockRollback =
        previous !== null && Date.parse(event.occurredAt) < Date.parse(previous.occurredAt);
      if (
        event.previousHash !== (previous?.eventHash ?? undefined) ||
        event.nodeId !== this.node.nodeId ||
        restoredIds.has(event.eventId) ||
        event.nodeEventSeq !== (previous?.nodeEventSeq ?? 0) + 1 ||
        hasClockRollback
      ) {
        throw new Error("audit chain continuity failure");
      }
      const hash = await this.computeHash(event);
      if (hash !== event.eventHash) throw new Error("audit hash verification failure");
      previous = event;
      restoredIds.add(event.eventId);
    }
    return Object.freeze({ tail: previous, eventIds: restoredIds });
  }

  private async persist(event: AuditEvent): Promise<void> {
    if (event.nodeEventSeq !== (this.durableTail?.nodeEventSeq ?? 0) + 1) {
      throw new Error("audit durable sequence discontinuity");
    }
    if (event.previousHash !== (this.durableTail?.eventHash ?? undefined)) {
      throw new Error("audit durable chain discontinuity");
    }
    const output = await this.ports.append(cloneFrozenEvent(event));
    if (output !== undefined) throw new Error("invalid audit storage append output");
    this.durableTail = event;
  }

  private accept(event: AuditEvent): void {
    this.eventIds.add(event.eventId);
    this.chainTail = event;
  }

  private validateFinalized(event: AuditEvent): void {
    const parsed = AuditEventSchema.strict().safeParse(event);
    if (
      !parsed.success ||
      !event.eventHash ||
      event.nodeEventSeq !== (this.chainTail?.nodeEventSeq ?? 0) + 1 ||
      event.previousHash !== (this.chainTail?.eventHash ?? undefined)
    ) {
      throw new Error("invalid finalized audit event");
    }
    validateFinalizedSafety(parsed.data);
  }

  private markDegraded(error: unknown): void {
    if (!this.degradation) {
      this.degradation = Object.freeze({ error });
      try {
        this.observer.onDegraded?.(error);
      } catch {
        // Observer failures do not alter audit acceptance or recovery.
      }
    }
  }

  private markRecovered(): void {
    if (this.degradation) {
      this.degradation = null;
      try {
        this.observer.onRecovered?.();
      } catch {
        // Observer failures do not alter audit acceptance or recovery.
      }
    }
  }

  private requireRecoveryEvidence(successfulAppends: number): void {
    if (successfulAppends > 0) {
      this.markRecovered();
      return;
    }
    if (this.degradation) {
      throw aggregateError([this.degradation.error], "audit storage recovery is unverified");
    }
  }

  private async computeHash(event: AuditEvent): Promise<string> {
    return parseHash(await this.ports.hash(cloneFrozenHashInput(event)));
  }

  private async flushQueued(): Promise<number> {
    let successfulAppends = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next) throw new Error("audit queue state invalid");
      await this.persist(next);
      this.queue.shift();
      successfulAppends += 1;
    }
    return successfulAppends;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.running.then(async () => {
      await this.initialized;
      return operation();
    });
    this.running = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
