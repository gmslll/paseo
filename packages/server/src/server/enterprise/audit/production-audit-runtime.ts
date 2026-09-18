import path from "node:path";
import { NodeContextSchema } from "@getpaseo/protocol/messages";
import type {
  AuditAppendOptions,
  AuditClock,
  AuditEvent,
  AuditEventInput,
  AuditHash,
  AuditIdSource,
  AuditSink,
  AuditSequence,
  NodeContext,
} from "@getpaseo/protocol/messages";
import {
  DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON,
  DarwinAuditFileSystem,
} from "./darwin-audit-file-system.js";
import {
  IncrementalAuditSequence,
  JsonlAuditStorage,
  LocalAuditSink,
  RandomAuditIdSource,
  Sha256AuditHash,
  UtcClock,
} from "./local-audit-sink.js";

export const AUDIT_RUNTIME_RESTORE_FAILED_REASON = "audit_storage_restore_failed" as const;
export const AUDIT_RUNTIME_CLOSED_REASON = "audit_runtime_closed" as const;
export const AUDIT_RUNTIME_CLOSE_FAILED_REASON = "audit_runtime_close_failed" as const;
export const AUDIT_RUNTIME_OPTIONS_CAPTURE_FAILED_REASON =
  "audit_runtime_options_capture_failed" as const;
export const AUDIT_FILE_SYSTEM_NOT_RELEASE_READY_REASON =
  "audit_file_system_not_release_ready" as const;
export const AUDIT_STORAGE_NOT_RELEASE_READY_REASON = "audit_storage_not_release_ready" as const;
export const AUDIT_STORAGE_CONSTRUCTION_FAILED_REASON =
  "audit_storage_construction_failed" as const;

export interface ProductionAuditRuntimeObserver {
  onDegraded?(error: unknown): void;
  onRecovered?(): void;
}

export interface ProductionAuditRuntimeOptions {
  readonly node: NodeContext;
  readonly auditRoot: string;
  readonly nativeAddonPath?: string;
  readonly clock?: AuditClock;
  readonly idSource?: AuditIdSource;
  readonly hash?: AuditHash;
  readonly sequence?: AuditSequence;
  readonly maxBuffered?: number;
  readonly observer?: ProductionAuditRuntimeObserver;
}

const PRODUCTION_AUDIT_CAPABILITY_BRAND: unique symbol = Symbol(
  "paseo.production-audit-capability",
);

/**
 * A capability issued only after the Darwin dirfd storage has restored and verified its complete
 * chain. The private symbol makes the type nominal; the issuer registry is the runtime authority.
 */
export interface ProductionAuditCapability extends AuditSink {
  readonly [PRODUCTION_AUDIT_CAPABILITY_BRAND]: true;
  readonly adapterKind: "local";
  readonly node: NodeContext;
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  ready(): Promise<void>;
  snapshotEvents(): Promise<readonly AuditEvent[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type ProductionAuditRuntime = ProductionAuditCapability;

export class ProductionAuditRuntimeUnavailableError extends Error {
  readonly unsupportedReason: string;

  constructor(unsupportedReason: string, cause?: unknown) {
    super(`enterprise audit runtime unavailable: ${unsupportedReason}`, { cause });
    this.name = "ProductionAuditRuntimeUnavailableError";
    this.unsupportedReason = unsupportedReason;
  }
}

export class ProductionAuditRuntimeCleanupError extends AggregateError {
  readonly unsupportedReason = AUDIT_RUNTIME_RESTORE_FAILED_REASON;

  constructor(restoreError: unknown, closeError: unknown) {
    super([restoreError, closeError], "enterprise audit restore and cleanup failed", {
      cause: restoreError,
    });
    this.name = "ProductionAuditRuntimeCleanupError";
  }
}

type RuntimeState =
  | { status: "initializing" }
  | { status: "ready" }
  | { status: "closing" | "closed"; reason: typeof AUDIT_RUNTIME_CLOSED_REASON }
  | {
      status: "restore_failed" | "close_failed";
      reason: typeof AUDIT_RUNTIME_RESTORE_FAILED_REASON | typeof AUDIT_RUNTIME_CLOSE_FAILED_REASON;
      error: unknown;
    };

interface RuntimeRecord {
  state: RuntimeState;
  readonly append: LocalAuditSink["append"];
  readonly snapshotEvents: LocalAuditSink["snapshotEvents"];
  readonly flush: LocalAuditSink["flush"];
  readonly close: LocalAuditSink["close"];
  closePromise: Promise<void> | null;
}

const runtimeRecords = new WeakMap<object, RuntimeRecord>();
const issuedCapabilities = new WeakSet<object>();
const currentCapabilities = new WeakSet<object>();

function captureOptions(options: ProductionAuditRuntimeOptions): ProductionAuditRuntimeOptions {
  try {
    const node = options.node;
    const auditRoot = options.auditRoot;
    const nativeAddonPath = options.nativeAddonPath;
    const clock = options.clock;
    const idSource = options.idSource;
    const hash = options.hash;
    const sequence = options.sequence;
    const maxBuffered = options.maxBuffered;
    const observer = options.observer;
    return Object.freeze({
      node,
      auditRoot,
      nativeAddonPath,
      clock,
      idSource,
      hash,
      sequence,
      maxBuffered,
      observer,
    });
  } catch (error) {
    throw unavailable(AUDIT_RUNTIME_OPTIONS_CAPTURE_FAILED_REASON, error);
  }
}

function parseProductionNode(value: NodeContext): NodeContext {
  const parsed = NodeContextSchema.strict().parse(structuredClone(value));
  return Object.freeze(parsed);
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

function parseTrustedAbsolutePath(value: string, subject: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasControlCharacter(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new Error(`invalid trusted ${subject}`);
  }
  return value;
}

function isSafeReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !hasControlCharacter(value)
  );
}

function captureUnavailableReason(
  source: { readonly releaseReady: boolean; readonly unsupportedReason?: string },
  fallbackReason: string,
): string | undefined {
  try {
    const releaseReady: unknown = source.releaseReady;
    const unsupportedReason: unknown = source.unsupportedReason;
    if (releaseReady === true && unsupportedReason === undefined) return undefined;
    if (releaseReady === false && isSafeReason(unsupportedReason)) return unsupportedReason;
  } catch {
    // A throwing readiness getter is an unavailable storage boundary.
  }
  return fallbackReason;
}

function unavailable(reason: string, cause?: unknown): ProductionAuditRuntimeUnavailableError {
  return new ProductionAuditRuntimeUnavailableError(reason, cause);
}

function recordFor(value: object): RuntimeRecord {
  const record = runtimeRecords.get(value);
  if (!record) throw unavailable(AUDIT_STORAGE_NOT_RELEASE_READY_REASON);
  return record;
}

class IssuedProductionAuditCapability implements ProductionAuditCapability {
  readonly [PRODUCTION_AUDIT_CAPABILITY_BRAND] = true as const;
  readonly adapterKind = "local" as const;
  readonly node: NodeContext;

  constructor(node: NodeContext, sink: LocalAuditSink) {
    this.node = node;
    runtimeRecords.set(this, {
      state: { status: "initializing" },
      append: sink.append.bind(sink),
      snapshotEvents: sink.snapshotEvents.bind(sink),
      flush: sink.flush.bind(sink),
      close: sink.close.bind(sink),
      closePromise: null,
    });
    Object.freeze(this);
  }

  get releaseReady(): boolean {
    return recordFor(this).state.status === "ready";
  }

  get unsupportedReason(): string | undefined {
    const state = recordFor(this).state;
    return "reason" in state ? state.reason : undefined;
  }

  ready(): Promise<void> {
    return this.requireCurrent();
  }

  append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent> {
    const record = recordFor(this);
    if (!currentCapabilities.has(this) || record.state.status !== "ready") {
      return Promise.reject(this.inactiveError(record.state));
    }
    return record.append(input, options);
  }

  snapshotEvents(): Promise<readonly AuditEvent[]> {
    const record = recordFor(this);
    if (!currentCapabilities.has(this) || record.state.status !== "ready") {
      return Promise.reject(this.inactiveError(record.state));
    }
    return record.snapshotEvents();
  }

  flush(): Promise<void> {
    const record = recordFor(this);
    if (!currentCapabilities.has(this) || record.state.status !== "ready") {
      return Promise.reject(this.inactiveError(record.state));
    }
    return record.flush();
  }

  close(): Promise<void> {
    const record = recordFor(this);
    if (record.closePromise) return record.closePromise;

    currentCapabilities.delete(this);
    record.state = { status: "closing", reason: AUDIT_RUNTIME_CLOSED_REASON };
    let close: Promise<void>;
    try {
      close = record.close();
    } catch (error) {
      close = Promise.reject(error);
    }
    record.closePromise = close.then(
      () => {
        record.state = { status: "closed", reason: AUDIT_RUNTIME_CLOSED_REASON };
        return undefined;
      },
      (error: unknown) => {
        record.state = {
          status: "close_failed",
          reason: AUDIT_RUNTIME_CLOSE_FAILED_REASON,
          error,
        };
        throw error;
      },
    );
    return record.closePromise;
  }

  private requireCurrent(): Promise<void> {
    const record = recordFor(this);
    if (currentCapabilities.has(this) && record.state.status === "ready") {
      return Promise.resolve();
    }
    return Promise.reject(this.inactiveError(record.state));
  }

  private inactiveError(state: RuntimeState): ProductionAuditRuntimeUnavailableError {
    if ("reason" in state) {
      return unavailable(state.reason, "error" in state ? state.error : undefined);
    }
    return unavailable(AUDIT_STORAGE_NOT_RELEASE_READY_REASON);
  }
}

Object.freeze(IssuedProductionAuditCapability.prototype);

async function initializeCapability(capability: IssuedProductionAuditCapability): Promise<void> {
  const record = recordFor(capability);
  try {
    await record.flush();
    record.state = { status: "ready" };
  } catch (restoreError) {
    record.state = {
      status: "restore_failed",
      reason: AUDIT_RUNTIME_RESTORE_FAILED_REASON,
      error: restoreError,
    };
    let close: Promise<void>;
    try {
      close = record.close();
    } catch (error) {
      close = Promise.reject(error);
    }
    record.closePromise = close;
    try {
      await close;
    } catch (closeError) {
      throw new ProductionAuditRuntimeCleanupError(restoreError, closeError);
    }
    throw unavailable(AUDIT_RUNTIME_RESTORE_FAILED_REASON, restoreError);
  }
}

export function isCurrentProductionAuditCapability(
  value: unknown,
): value is ProductionAuditCapability {
  if (typeof value !== "object" || value === null) return false;
  const record = runtimeRecords.get(value);
  return (
    record?.state.status === "ready" &&
    issuedCapabilities.has(value) &&
    currentCapabilities.has(value)
  );
}

export function requireCurrentProductionAuditCapability(value: unknown): ProductionAuditCapability {
  if (!isCurrentProductionAuditCapability(value)) {
    throw new Error("current runtime-issued production audit capability required");
  }
  return value;
}

/**
 * Synchronously rejects unsupported adapters and returns no sink until the real Darwin storage has
 * restored and verified the complete persisted chain.
 */
export function createProductionAuditRuntime(
  options: ProductionAuditRuntimeOptions,
): Promise<ProductionAuditCapability> {
  const captured = captureOptions(options);
  const node = parseProductionNode(captured.node);
  const auditRoot = parseTrustedAbsolutePath(captured.auditRoot, "audit root");
  const nativeAddonPath =
    captured.nativeAddonPath === undefined
      ? undefined
      : parseTrustedAbsolutePath(captured.nativeAddonPath, "native addon path");
  const clock = captured.clock ?? new UtcClock();
  const idSource = captured.idSource ?? new RandomAuditIdSource();
  const hash = captured.hash ?? new Sha256AuditHash();
  const sequence = captured.sequence ?? new IncrementalAuditSequence();
  const maxBuffered = captured.maxBuffered;
  const observer = captured.observer;

  const fileSystem = new DarwinAuditFileSystem(
    nativeAddonPath === undefined ? undefined : { addonPath: nativeAddonPath },
  );
  const fileSystemReason = captureUnavailableReason(
    fileSystem,
    DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON,
  );
  if (fileSystemReason) throw unavailable(fileSystemReason);

  let storage: JsonlAuditStorage;
  try {
    storage = new JsonlAuditStorage(auditRoot, fileSystem);
  } catch (error) {
    throw unavailable(AUDIT_STORAGE_CONSTRUCTION_FAILED_REASON, error);
  }
  const storageReason = captureUnavailableReason(storage, AUDIT_STORAGE_NOT_RELEASE_READY_REASON);
  if (storageReason) throw unavailable(storageReason);

  const sink = new LocalAuditSink(
    {
      // LocalAuditSink's public contract represents the standalone adapter. The production
      // capability above retains the exact managed/standalone authority while this private sink
      // persists only the shared nodeId audit chain.
      node: { ...node, mode: "standalone" },
      clock,
      idSource,
      hash,
      sequence,
      storage,
    },
    maxBuffered,
    observer,
  );
  const capability = new IssuedProductionAuditCapability(node, sink);
  return initializeCapability(capability).then(() => {
    issuedCapabilities.add(capability);
    currentCapabilities.add(capability);
    return capability;
  });
}

export interface ProductionAuditCapabilityIssuer {
  issue(options: ProductionAuditRuntimeOptions): Promise<ProductionAuditCapability>;
  current(value: unknown): value is ProductionAuditCapability;
  requireCurrent(value: unknown): ProductionAuditCapability;
}

export const productionAuditCapabilityIssuer: ProductionAuditCapabilityIssuer = Object.freeze({
  issue: createProductionAuditRuntime,
  current: isCurrentProductionAuditCapability,
  requireCurrent: requireCurrentProductionAuditCapability,
});
