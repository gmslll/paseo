import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  normalizeResourceGrants,
  OrganizationIdSchema,
  PrincipalIdSchema,
  ResourceGrantSchema,
  type ResourceGrant,
  type PrincipalContext,
  type AuditSink,
  AuditEventInputSchema,
  PrincipalContextSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  GrantFsError,
  NodeGrantFileSystem,
  grantDirectoryOpenFlags,
  grantReadOpenFlags,
  type GrantFileHandle,
  type GrantFileSystem,
} from "./secure-fs.js";

export const GrantRecordSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  organizationId: OrganizationIdSchema,
  grants: z.array(ResourceGrantSchema),
  grantVersion: z.string().min(1),
});

export type GrantRecord = z.infer<typeof GrantRecordSchema>;

export interface GrantStorage {
  get(principalId: string): Promise<GrantRecord | null>;
  put(record: GrantRecord): Promise<void>;
}

const GrantFileSchema = z.strictObject({}).catchall(GrantRecordSchema);

export class GrantStoragePoisonedError extends Error {
  constructor(
    public readonly primaryError: unknown = null,
    public readonly rollbackError: unknown = null,
  ) {
    super("Grant storage is poisoned");
    this.name = "GrantStoragePoisonedError";
  }
}

export class GrantFileValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly reason: "not_regular" | "insecure_mode",
  ) {
    super(
      reason === "not_regular"
        ? "Grant storage target must be a regular file"
        : "Grant storage target must have mode 0600",
    );
    this.name = "GrantFileValidationError";
  }
}

export class FileBackedGrantStorage implements GrantStorage {
  private readonly records = new Map<string, GrantRecord>();
  private loadPromise: Promise<void> | null = null;
  private readonly poisonPath: string;
  private operationQueue: Promise<void> = Promise.resolve();
  private persistedData: string | null = null;
  private poisoned = false;

  constructor(
    private readonly filePath: string,
    private readonly fileSystem: GrantFileSystem = new NodeGrantFileSystem(),
  ) {
    this.poisonPath = `${filePath}.poison`;
  }

  get(principalId: string): Promise<GrantRecord | null> {
    return this.enqueue(async () => {
      this.assertAvailable();
      await this.ensureLoaded();
      this.assertAvailable();
      const record = this.records.get(principalId);
      return record ? cloneRecord(record) : null;
    });
  }

  put(record: GrantRecord): Promise<void> {
    return this.enqueue(() => this.putSerial(record));
  }

  private async putSerial(record: GrantRecord): Promise<void> {
    this.assertAvailable();
    await this.ensureLoaded();
    this.assertAvailable();
    const parsed = GrantRecordSchema.parse(record);
    validateOrganizationSelectors(parsed);
    const next = new Map(this.records);
    next.set(parsed.principalId, cloneRecord(parsed));
    const data = JSON.stringify(Object.fromEntries(next), null, 2);
    await this.ensureSecureDirectory();
    try {
      await this.fileSystem.writeAtomic(this.filePath, data);
    } catch (error) {
      if (error instanceof GrantFsError && error.commitState === "commit_unknown") {
        await this.rollbackAfterUncertainCommit(error);
      }
      throw error;
    }
    this.records.clear();
    for (const [key, value] of next) this.records.set(key, value);
    this.persistedData = data;
  }

  private async ensureLoaded(): Promise<void> {
    this.assertAvailable();
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    await this.ensureSecureDirectory();
    const poison = await this.readSecureFile(this.poisonPath);
    if (poison !== null) {
      this.poisoned = true;
      throw new GrantStoragePoisonedError();
    }
    const raw = await this.readSecureFile(this.filePath);
    if (raw === null) return;
    const parsed = GrantFileSchema.parse(JSON.parse(raw));
    const loaded = new Map<string, GrantRecord>();
    for (const [key, record] of Object.entries(parsed)) {
      if (key !== record.principalId) throw new Error("Grant storage key mismatch");
      loaded.set(key, cloneRecord(record));
    }
    this.records.clear();
    for (const [key, record] of loaded) this.records.set(key, record);
    this.persistedData = raw;
  }

  private async ensureSecureDirectory(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle: GrantFileHandle | null = null;
    let failure: unknown = null;
    try {
      handle = await this.fileSystem.open(directory, grantDirectoryOpenFlags());
      let stat = await handle.stat();
      if (!stat.isDirectory()) throw new Error("Grant storage parent must be a directory");
      await handle.chmod(0o700);
      stat = await handle.stat();
      if (!stat.isDirectory() || stat.mode !== 0o700) {
        throw new Error("Grant storage parent must have mode 0700");
      }
    } catch (error) {
      failure = error;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          failure = combineFailures(failure, error, "Grant storage parent close failed");
        }
      }
    }
    if (failure) throw failure;
  }

  private async readSecureFile(filePath: string): Promise<string | null> {
    let handle: GrantFileHandle;
    try {
      handle = await this.fileSystem.open(filePath, grantReadOpenFlags());
    } catch (error) {
      if (isFileNotFound(error)) return null;
      throw error;
    }

    let content: string | null = null;
    let failure: unknown = null;
    try {
      let stat = await handle.stat();
      if (!stat.isFile()) throw new GrantFileValidationError(filePath, "not_regular");
      await handle.chmod(0o600);
      stat = await handle.stat();
      if (!stat.isFile()) throw new GrantFileValidationError(filePath, "not_regular");
      if (stat.mode !== 0o600) throw new GrantFileValidationError(filePath, "insecure_mode");
      content = await handle.readFile();
    } catch (error) {
      failure = error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        failure = combineFailures(failure, error, "Grant storage file close failed");
      }
    }
    if (failure) throw failure;
    return content;
  }

  private async rollbackAfterUncertainCommit(primaryError: GrantFsError): Promise<never> {
    try {
      if (this.persistedData === null) {
        try {
          await this.fileSystem.unlink(this.filePath);
        } catch (error) {
          if (!isFileNotFound(error)) throw error;
        }
        await this.fileSystem.syncDirectory(path.dirname(this.filePath));
      } else {
        await this.fileSystem.writeAtomic(this.filePath, this.persistedData);
      }
    } catch (rollbackError) {
      await this.poisonAfterRollbackFailure(primaryError, rollbackError);
    }
    throw primaryError;
  }

  private async poisonAfterRollbackFailure(
    primaryError: GrantFsError,
    rollbackError: unknown,
  ): Promise<never> {
    this.poisoned = true;
    try {
      await this.fileSystem.writeAtomic(
        this.poisonPath,
        JSON.stringify({ reason: "grant_rollback_failed" }),
      );
    } catch (markerError) {
      // oxlint-disable-next-line preserve-caught-error
      throw new AggregateError(
        [primaryError, rollbackError, markerError],
        "Grant rollback and poison marker persistence failed",
        { cause: primaryError },
      );
    }
    throw new GrantStoragePoisonedError(primaryError, rollbackError);
  }

  private assertAvailable(): void {
    if (this.poisoned) throw new GrantStoragePoisonedError();
  }

  private enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const queued = this.operationQueue.then(operation);
    this.operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

export interface GrantVersionSource {
  next(previousVersion: string | null): string;
}

export interface GrantUpdateInput {
  actor: PrincipalContext;
  principalId: string;
  organizationId: string;
  grants: readonly ResourceGrant[];
  expectedVersion: string | null;
}

const GrantUpdateInputSchema = z.strictObject({
  actor: PrincipalContextSchema,
  principalId: PrincipalIdSchema,
  organizationId: OrganizationIdSchema,
  grants: z.array(ResourceGrantSchema),
  expectedVersion: z.string().nullable(),
});

export interface GrantChange {
  changed: boolean;
  previous: GrantRecord | null;
  current: GrantRecord;
}

export class GrantInvalidationError extends Error {
  constructor(
    public readonly change: GrantChange,
    public readonly failures: readonly unknown[],
  ) {
    super("Grant invalidation failed after persistence");
    this.name = "GrantInvalidationError";
  }
}

export class GrantMutationFailedError extends Error {
  constructor(
    public readonly previous: GrantRecord | null,
    public readonly attempted: GrantRecord,
    public readonly causeError: unknown,
  ) {
    super("Grant mutation failed before commit");
    this.name = "GrantMutationFailedError";
  }
}

export interface GrantInvalidation {
  readonly principalId: string;
  readonly organizationId: string;
  readonly grantVersion: string;
}
export interface GrantInvalidationAudit {
  append(input: {
    principalId: string;
    organizationId: string;
    grantVersion: string;
    listenerFailures: number;
  }): Promise<void>;
}

export class GrantRevisionConflictError extends Error {
  constructor(
    public readonly principalId: string,
    public readonly expectedVersion: string | null,
    public readonly actualVersion: string | null,
  ) {
    super(`Grant revision conflict for ${principalId}`);
    this.name = "GrantRevisionConflictError";
  }
}

export class GrantOrganizationMismatchError extends Error {
  constructor(public readonly principalId: string) {
    super(`Grant organization mismatch for ${principalId}`);
    this.name = "GrantOrganizationMismatchError";
  }
}

export class GrantVersionSourceError extends Error {
  constructor(public readonly previousVersion: string | null) {
    super("Grant version source returned an invalid or unchanged version");
    this.name = "GrantVersionSourceError";
  }
}

export class RandomGrantVersionSource implements GrantVersionSource {
  next(): string {
    return `grv_${randomBytes(16).toString("hex")}`;
  }
}

interface AuthoritativeGrantStoreRecord {
  readonly audit: AuditSink;
}

const authoritativeGrantStores = new WeakMap<object, AuthoritativeGrantStoreRecord>();
const authoritativeGrantStoreSynchronizers = new WeakMap<
  object,
  (records: readonly GrantRecord[]) => Promise<void>
>();

export class GrantStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: GrantInvalidation) => void | Promise<void>>();
  private readonly authoritative = new Map<string, GrantRecord>();

  constructor(
    private readonly storage: GrantStorage,
    private readonly versionSource: GrantVersionSource = new RandomGrantVersionSource(),
    audit: AuditSink,
  ) {
    authoritativeGrantStores.set(this, Object.freeze({ audit }));
    authoritativeGrantStoreSynchronizers.set(this, (records) =>
      this.synchronizeAuthoritativeRecords(records),
    );
  }

  async get(principalId: string): Promise<GrantRecord | null> {
    const operation = this.mutationQueue.then(async () => {
      const cached = this.authoritative.get(principalId);
      if (cached) return cloneRecord(cached);
      const record = await this.readRecord(principalId);
      if (record) this.authoritative.set(principalId, cloneRecord(record));
      return record;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async readRecord(principalId: string): Promise<GrantRecord | null> {
    const record = await this.storage.get(principalId);
    if (!record) return null;
    const parsed = GrantRecordSchema.parse(record);
    return cloneRecord(parsed);
  }

  currentVersion(organizationId: string, principalId: string): string | null {
    const record = this.authoritative.get(principalId);
    return record?.organizationId === organizationId ? record.grantVersion : null;
  }

  subscribe(listener: (change: GrantInvalidation) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(input: GrantUpdateInput): Promise<GrantChange> {
    const parsed = GrantUpdateInputSchema.parse(input);
    const operation = this.mutationQueue.then(() => this.updateSerial(parsed));
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private synchronizeAuthoritativeRecords(records: readonly GrantRecord[]): Promise<void> {
    const captured = records.map((record) => {
      const parsed = GrantRecordSchema.parse(structuredClone(record));
      validateOrganizationSelectors(parsed);
      return cloneRecord(parsed);
    });
    const principalIds = new Set(captured.map((record) => record.principalId));
    if (principalIds.size !== captured.length) {
      return Promise.reject(new Error("duplicate authoritative grant record"));
    }
    const operation = this.mutationQueue.then(() =>
      this.synchronizeAuthoritativeRecordsSerial(captured),
    );
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async synchronizeAuthoritativeRecordsSerial(
    records: readonly GrantRecord[],
  ): Promise<void> {
    const listenerFailures: unknown[] = [];
    for (const record of records) {
      const previous =
        this.authoritative.get(record.principalId) ?? (await this.readRecord(record.principalId));
      if (previous && JSON.stringify(previous) === JSON.stringify(record)) {
        this.authoritative.set(record.principalId, cloneRecord(record));
        continue;
      }
      await this.storage.put(record);
      this.authoritative.set(record.principalId, cloneRecord(record));
      const invalidation = frozenInvalidation(record);
      for (const listener of this.listeners) {
        try {
          await listener(invalidation);
        } catch (error) {
          listenerFailures.push(error);
        }
      }
    }
    if (listenerFailures.length > 0) {
      throw new AggregateError(listenerFailures, "Authoritative grant synchronization failed");
    }
  }

  // oxlint-disable-next-line complexity
  private async updateSerial(input: GrantUpdateInput): Promise<GrantChange> {
    const actor = input.actor;
    if (actor.organizationId !== input.organizationId)
      throw new GrantOrganizationMismatchError(input.principalId);
    const previous = await this.readRecord(input.principalId);
    if (previous && previous.organizationId !== input.organizationId) {
      throw new GrantOrganizationMismatchError(input.principalId);
    }
    const actualVersion = previous?.grantVersion ?? null;
    if (actualVersion !== input.expectedVersion) {
      throw new GrantRevisionConflictError(input.principalId, input.expectedVersion, actualVersion);
    }

    const grants = normalizeResourceGrants(input.grants);
    validateOrganizationSelectors({
      principalId: input.principalId,
      organizationId: input.organizationId,
      grants,
      grantVersion: "pending",
    });
    if (previous && JSON.stringify(previous.grants) === JSON.stringify(grants)) {
      return { changed: false, previous: cloneRecord(previous), current: cloneRecord(previous) };
    }
    const grantVersion = nextGrantVersion(this.versionSource, actualVersion);
    const current: GrantRecord = previous
      ? { ...previous, grants, grantVersion }
      : {
          principalId: input.principalId,
          organizationId: input.organizationId,
          grants,
          grantVersion,
        };

    const result = {
      changed: true,
      previous: previous ? cloneRecord(previous) : null,
      current: cloneRecord(current),
    };
    const intent = AuditEventInputSchema.parse({
      organizationId: current.organizationId,
      actorPrincipalId: actor.principalId,
      actorCredentialId: actor.credentialId,
      action: "access.grants.update",
      resource: { kind: "principal_grants", id: current.principalId },
      outcome: "allowed",
      metadata: { grantVersion: current.grantVersion, phase: "intent" },
    });
    await authoritativeGrantStoreAudit(this).append(intent, { durability: "required" });

    try {
      await this.storage.put(GrantRecordSchema.parse(current));
    } catch (error) {
      const auditError = await this.appendFailureAudit(actor, current, "storage", error);
      if (auditError) throw new GrantMutationFailedError(previous, current, [error, auditError]);
      throw new GrantMutationFailedError(previous, current, error);
    }
    this.authoritative.set(current.principalId, cloneRecord(current));
    const invalidationFailures: unknown[] = [];
    for (const listener of this.listeners) {
      try {
        await listener(frozenInvalidation(current));
      } catch (error) {
        invalidationFailures.push(error);
      }
    }
    if (invalidationFailures.length > 0) {
      const auditError = await this.appendFailureAudit(
        actor,
        current,
        "invalidation",
        invalidationFailures[0],
      );
      if (auditError) invalidationFailures.push(auditError);
    }
    if (invalidationFailures.length > 0)
      throw new GrantInvalidationError(result, invalidationFailures);
    return result;
  }

  private async appendFailureAudit(
    actor: PrincipalContext,
    current: GrantRecord,
    phase: string,
    error: unknown,
  ): Promise<unknown | null> {
    try {
      await authoritativeGrantStoreAudit(this).append(
        AuditEventInputSchema.parse({
          organizationId: current.organizationId,
          actorPrincipalId: actor.principalId,
          actorCredentialId: actor.credentialId,
          action: "access.grants.update",
          resource: { kind: "principal_grants", id: current.principalId },
          outcome: "failed",
          reasonCode: "grant_update_failed",
          metadata: {
            grantVersion: current.grantVersion,
            phase,
            error: error instanceof Error ? error.name : "unknown",
          },
        }),
        { durability: "required" },
      );
    } catch (auditError) {
      return auditError;
    }
    return null;
  }
}

export function isAuthoritativeGrantStore(value: unknown): value is GrantStore {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    authoritativeGrantStores.has(value)
  );
}

export function isAuthoritativeGrantStoreForAudit(store: GrantStore, audit: AuditSink): boolean {
  if (!isAuthoritativeGrantStore(store)) return false;
  return authoritativeGrantStores.get(store)?.audit === audit;
}

export function readAuthoritativeGrantRecord(
  store: GrantStore,
  principalId: string,
): Promise<GrantRecord | null> {
  if (!isAuthoritativeGrantStore(store)) return Promise.reject(new Error("invalid GrantStore"));
  return GrantStore.prototype.get.call(store, principalId);
}

export function updateAuthoritativeGrantRecord(
  store: GrantStore,
  input: GrantUpdateInput,
): Promise<GrantChange> {
  if (!isAuthoritativeGrantStore(store)) return Promise.reject(new Error("invalid GrantStore"));
  return GrantStore.prototype.update.call(store, input);
}

export function currentAuthoritativeGrantVersion(
  store: GrantStore,
  organizationId: string,
  principalId: string,
): string | null {
  if (!isAuthoritativeGrantStore(store)) return null;
  return GrantStore.prototype.currentVersion.call(store, organizationId, principalId);
}

export function subscribeAuthoritativeGrantInvalidation(
  store: GrantStore,
  listener: (change: GrantInvalidation) => void | Promise<void>,
): () => void {
  if (!isAuthoritativeGrantStore(store)) throw new Error("invalid GrantStore");
  return GrantStore.prototype.subscribe.call(store, listener);
}

/** Applies grant records received from the central management authority without minting versions locally. */
export function synchronizeAuthoritativeGrantRecords(
  store: GrantStore,
  audit: AuditSink,
  records: readonly GrantRecord[],
): Promise<void> {
  if (!isAuthoritativeGrantStoreForAudit(store, audit)) {
    return Promise.reject(new Error("invalid GrantStore authority"));
  }
  const synchronize = authoritativeGrantStoreSynchronizers.get(store);
  if (!synchronize) return Promise.reject(new Error("invalid GrantStore"));
  return synchronize(records);
}

function authoritativeGrantStoreAudit(store: GrantStore): AuditSink {
  const record = authoritativeGrantStores.get(store);
  if (!record) throw new Error("invalid GrantStore");
  return record.audit;
}

function nextGrantVersion(source: GrantVersionSource, previousVersion: string | null): string {
  const parsed = GrantRecordSchema.shape.grantVersion.safeParse(source.next(previousVersion));
  if (!parsed.success || parsed.data === previousVersion) {
    throw new GrantVersionSourceError(previousVersion);
  }
  return parsed.data;
}

function frozenInvalidation(record: GrantRecord): GrantInvalidation {
  return Object.freeze({
    principalId: record.principalId,
    organizationId: record.organizationId,
    grantVersion: record.grantVersion,
  });
}

function cloneRecord(record: GrantRecord): GrantRecord {
  return {
    ...record,
    grants: record.grants.map((grant) => ({
      ...grant,
      selector:
        grant.selector.kind === "workspace"
          ? { ...grant.selector, workspaceIds: [...grant.selector.workspaceIds] }
          : { ...grant.selector },
    })),
  };
}

function validateOrganizationSelectors(record: GrantRecord): void {
  for (const grant of record.grants) {
    if (
      grant.selector.kind === "organization" &&
      grant.selector.organizationId !== record.organizationId
    ) {
      throw new GrantOrganizationMismatchError(record.principalId);
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function combineFailures(primary: unknown, secondary: unknown, message: string): unknown {
  if (!primary) return secondary;
  return new AggregateError([primary, secondary], message, { cause: primary });
}
