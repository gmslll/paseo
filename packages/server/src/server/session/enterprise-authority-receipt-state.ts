import { z } from "zod";
import { OrganizationIdSchema, PrincipalIdSchema } from "@getpaseo/protocol/messages";
/* oxlint-disable max-depth -- binding replacement prunes nested session records atomically. */
import {
  AuthorizedRequestReceiptSchema,
  AuthoritySessionBindingRecordSchema,
  type AuthorizedRequestReceipt,
  type AuthoritySessionBindingRecord,
} from "../enterprise/access/authority-receipt-verifier.js";
import type {
  AuthorityReceiptClock,
  AuthorityReceiptStatePort,
} from "../enterprise/access/authority-receipt-verifier.js";
import type {
  ActiveAuthorizedRequestCloseReason,
  FreshAuthorityReceiptMaterializer,
  OutboundAuthorityEmissionStatePort,
} from "../enterprise/access/outbound-authority-emission-authorizer.js";
import type { ActiveAuthorizedRequestHandle } from "../enterprise/access/inbound-authority-request-authorizer.js";
import type { OutboundAuthorityReceiptPolicy } from "../enterprise/access/event-action-map.js";

const BindingLookupSchema = z
  .object({ sessionBindingKey: z.string().min(1), sessionBindingGeneration: z.string().min(1) })
  .strict();
const CorrelationSchema = z
  .object({
    sessionId: z.string().min(1),
    sessionBindingKey: z.string().min(1),
    sessionBindingGeneration: z.string().min(1),
    requestId: z.string().min(1),
  })
  .strict();
const SessionScopeSchema = z
  .object({
    sessionId: z.string().min(1),
    sessionBindingKey: z.string().min(1),
    sessionBindingGeneration: z.string().min(1),
  })
  .strict();
const EmissionLookupSchema = z
  .object({ sessionBindingKey: z.string().min(1), sessionBindingGeneration: z.string().min(1) })
  .strict();
const CredentialSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    principalId: PrincipalIdSchema,
    credentialId: z.string().min(1),
  })
  .strict();
const PrincipalSchema = z
  .object({ organizationId: OrganizationIdSchema, principalId: PrincipalIdSchema })
  .strict();
const GrantSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    principalId: PrincipalIdSchema,
    grantVersion: z.string().min(1),
  })
  .strict();
export const AUTHORITY_RECEIPT_CAPACITY_HARD_MAX = 10_000;
export const AUTHORITY_RECEIPT_ID_MAX_ATTEMPTS = 4;
export const AUTHORITY_RECEIPT_TTL_MAX_MS = 60_000;
export const AUTHORITY_RECEIPT_ID_MIN_LENGTH = 16;
export const AUTHORITY_RECEIPT_ID_MAX_LENGTH = 256;
/** Minimal Session-owned binding lifecycle seam; receipt consumption remains W2-owned. */
export interface AuthoritySessionBindingLifecycle {
  registerSessionBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord;
  endRequest(input: {
    sessionId: string;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
    requestId: string;
  }): void;
  releaseSession(input: {
    sessionId: string;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }): void;
}

export interface AuthorityReceiptStateOptions {
  readonly maxReceipts?: number;
  readonly clock?: AuthorityReceiptClock;
  readonly receiptIdFactory?: () => string;
  readonly receiptTtlMs?: number;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }

  return value;
}
function clone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
function parseInput<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> | null {
  try {
    const result = schema.safeParse(structuredClone(input));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function strictOwnDataSnapshot(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const object = input as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(object);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}
function parseStrictOwnData<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  keys: readonly string[],
): z.output<T> | null {
  const snapshot = strictOwnDataSnapshot(input, keys);
  return snapshot === null ? null : parseInput(schema, snapshot);
}
const BINDING_KEYS = [
  "sessionId",
  "sessionBindingKey",
  "sessionBindingGeneration",
  "organizationId",
  "principalId",
  "principalType",
  "credentialId",
  "grantVersion",
  "nodeId",
  "clientId",
] as const;
const LOOKUP_KEYS = ["sessionBindingKey", "sessionBindingGeneration"] as const;
const CORRELATION_KEYS = [
  "sessionId",
  "sessionBindingKey",
  "sessionBindingGeneration",
  "requestId",
] as const;
const SESSION_KEYS = ["sessionId", "sessionBindingKey", "sessionBindingGeneration"] as const;
const CREDENTIAL_KEYS = ["organizationId", "principalId", "credentialId"] as const;
const PRINCIPAL_KEYS = ["organizationId", "principalId"] as const;
const GRANT_KEYS = ["organizationId", "principalId", "grantVersion"] as const;
interface EmissionReferenceSnapshot {
  readonly handle: ActiveAuthorizedRequestHandle;
  readonly sessionBindingKey: string;
  readonly sessionBindingGeneration: string;
}
interface EmissionMintSnapshot extends EmissionReferenceSnapshot {
  readonly emission: "repeatable" | "terminal";
  readonly materializeReceipt: FreshAuthorityReceiptMaterializer;
}
interface EmissionCloseSnapshot extends EmissionReferenceSnapshot {
  readonly reason: ActiveAuthorizedRequestCloseReason;
}
const CLOSE_REASONS = [
  "end",
  "cancel",
  "revoked",
  "release",
  "invalidate",
  "authorization_failed",
] as const;
function isCloseReason(value: unknown): value is ActiveAuthorizedRequestCloseReason {
  return typeof value === "string" && CLOSE_REASONS.some((reason) => reason === value);
}
function isReceiptMaterializer(value: unknown): value is FreshAuthorityReceiptMaterializer {
  return typeof value === "function";
}
function snapshotReference(input: unknown): EmissionReferenceSnapshot | null {
  const own = strictOwnDataSnapshot(input, [
    "handle",
    "sessionBindingKey",
    "sessionBindingGeneration",
  ]);
  if (!own || !own.handle || (typeof own.handle !== "object" && typeof own.handle !== "function"))
    return null;
  const parsed = parseInput(EmissionLookupSchema, {
    sessionBindingKey: own.sessionBindingKey,
    sessionBindingGeneration: own.sessionBindingGeneration,
  });
  return parsed ? { handle: own.handle as ActiveAuthorizedRequestHandle, ...parsed } : null;
}
function snapshotMint(input: unknown): EmissionMintSnapshot | null {
  const own = strictOwnDataSnapshot(input, [
    "handle",
    "sessionBindingKey",
    "sessionBindingGeneration",
    "emission",
    "materializeReceipt",
  ]);
  const reference = snapshotReference({
    handle: own?.handle,
    sessionBindingKey: own?.sessionBindingKey,
    sessionBindingGeneration: own?.sessionBindingGeneration,
  });
  if (
    !reference ||
    (own?.emission !== "repeatable" && own?.emission !== "terminal") ||
    !isReceiptMaterializer(own?.materializeReceipt)
  )
    return null;
  return {
    ...reference,
    emission: own.emission,
    materializeReceipt: own.materializeReceipt,
  };
}
function snapshotClose(input: unknown): EmissionCloseSnapshot | null {
  const own = strictOwnDataSnapshot(input, [
    "handle",
    "sessionBindingKey",
    "sessionBindingGeneration",
    "reason",
  ]);
  const reference = snapshotReference({
    handle: own?.handle,
    sessionBindingKey: own?.sessionBindingKey,
    sessionBindingGeneration: own?.sessionBindingGeneration,
  });
  const reason = own?.reason;
  if (!reference || !isCloseReason(reason)) return null;
  return { ...reference, reason };
}

export class MemoryAuthorityReceiptState
  implements
    AuthorityReceiptStatePort,
    AuthoritySessionBindingLifecycle,
    OutboundAuthorityEmissionStatePort
{
  private readonly receipts = new Map<string, AuthorizedRequestReceipt>();
  private readonly bindings = new Map<string, Map<string, AuthoritySessionBindingRecord>>();
  private readonly maxReceipts: number;
  private readonly clock: AuthorityReceiptClock;
  private readonly receiptIdFactory: () => string;
  private readonly receiptTtlMs: number;
  private lastClock: number | undefined;
  private readonly emissionEntries = new WeakMap<
    object,
    {
      handle: ActiveAuthorizedRequestHandle;
      binding: AuthoritySessionBindingRecord;
      receiptIds: Set<string>;
      historyReceiptIds: Set<string>;
      requestId?: string;
      requestType?: string;
      status: "open" | "terminal" | "closed";
    }
  >();
  private readonly emissionEntryIndex = new Set<{
    handle: ActiveAuthorizedRequestHandle;
    binding: AuthoritySessionBindingRecord;
    receiptIds: Set<string>;
    status: "open" | "terminal" | "closed";
    historyReceiptIds: Set<string>;
    requestId?: string;
    requestType?: string;
  }>();

  constructor(options: AuthorityReceiptStateOptions = {}) {
    const configuredCapacity = options.maxReceipts;
    const configuredTtl = options.receiptTtlMs;
    const maxReceipts = configuredCapacity ?? 1024;
    const receiptTtlMs = configuredTtl ?? 30_000;
    if (
      !Number.isSafeInteger(maxReceipts) ||
      maxReceipts < 1 ||
      maxReceipts > AUTHORITY_RECEIPT_CAPACITY_HARD_MAX
    )
      throw new Error("Invalid receipt capacity");
    if (
      !Number.isSafeInteger(receiptTtlMs) ||
      receiptTtlMs < 1 ||
      receiptTtlMs > AUTHORITY_RECEIPT_TTL_MAX_MS
    )
      throw new Error("Invalid receipt TTL");
    this.maxReceipts = maxReceipts;
    this.receiptTtlMs = receiptTtlMs;
    const configuredClock = options.clock;
    const clock = configuredClock ?? { now: () => Date.now() };
    this.clock = { now: clock.now.bind(clock) };
    const defaultRandomUUID = globalThis.crypto?.randomUUID;
    const configuredFactory = options.receiptIdFactory;
    if (!configuredFactory && typeof defaultRandomUUID !== "function")
      throw new Error("Receipt ID factory unavailable");
    const factory = configuredFactory ?? defaultRandomUUID.bind(globalThis.crypto);
    this.receiptIdFactory = factory.bind(undefined);
  }

  async register(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly binding: AuthoritySessionBindingRecord;
  }) {
    try {
      const snapshot = strictOwnDataSnapshot(input, ["handle", "binding"]);
      if (!snapshot) return null;
      const handle = snapshot.handle;
      if (
        !handle ||
        (typeof handle !== "object" && typeof handle !== "function") ||
        this.emissionEntries.has(handle as object)
      )
        return null;
      const binding = parseStrictOwnData(
        AuthoritySessionBindingRecordSchema,
        snapshot.binding,
        BINDING_KEYS,
      );
      if (!binding) return null;
      const current = this.bindings
        .get(binding.sessionBindingKey)
        ?.get(binding.sessionBindingGeneration);
      if (!current || !sameBindingRecord(current, binding)) return null;
      const entry = {
        handle: handle as ActiveAuthorizedRequestHandle,
        binding,
        receiptIds: new Set<string>(),
        historyReceiptIds: new Set<string>(),
        status: "open" as const,
      };
      this.emissionEntries.set(handle as object, entry);
      this.emissionEntryIndex.add(entry);
      return clone(binding);
    } catch {
      return null;
    }
  }

  async resolveOpen(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
  }) {
    try {
      const parsed = snapshotReference(input);
      if (!parsed) return null;
      const entry = this.emissionEntries.get(parsed.handle as object);
      if (
        !entry ||
        entry.status !== "open" ||
        entry.binding.sessionBindingKey !== parsed.sessionBindingKey ||
        entry.binding.sessionBindingGeneration !== parsed.sessionBindingGeneration
      )
        return null;
      const current = this.bindings
        .get(parsed.sessionBindingKey)
        ?.get(parsed.sessionBindingGeneration);
      if (!current || !sameBindingRecord(current, entry.binding)) return null;
      return clone(entry.binding);
    } catch {
      return null;
    }
  }

  // oxlint-disable-next-line complexity -- mint validates binding, clock, capacity, and materializer atomically.
  async mintFreshReceipt(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
    readonly emission: OutboundAuthorityReceiptPolicy["emission"];
    readonly materializeReceipt: FreshAuthorityReceiptMaterializer;
  }) {
    try {
      const parsed = snapshotMint(input);
      if (!parsed) return null;
      if (parsed.emission !== "repeatable" && parsed.emission !== "terminal") return null;
      const entry = this.emissionEntries.get(parsed.handle as object);
      if (
        !entry ||
        entry.status !== "open" ||
        entry.binding.sessionBindingKey !== parsed.sessionBindingKey ||
        entry.binding.sessionBindingGeneration !== parsed.sessionBindingGeneration
      )
        return null;
      const current = this.bindings
        .get(parsed.sessionBindingKey)
        ?.get(parsed.sessionBindingGeneration);
      if (!current || !sameBindingRecord(current, entry.binding)) return null;
      const now = this.now();
      this.purgeExpired(now);
      if (!Number.isSafeInteger(now) || now > Number.MAX_SAFE_INTEGER - this.receiptTtlMs)
        return null;
      if (this.receipts.size >= this.maxReceipts) return null;
      let receiptId: string | null = null;
      for (let attempt = 0; attempt < AUTHORITY_RECEIPT_ID_MAX_ATTEMPTS; attempt++) {
        const candidate = this.receiptIdFactory();
        if (
          typeof candidate === "string" &&
          new RegExp(
            `^[A-Za-z0-9._~-]{${AUTHORITY_RECEIPT_ID_MIN_LENGTH},${AUTHORITY_RECEIPT_ID_MAX_LENGTH}}$`,
          ).test(candidate) &&
          !entry.historyReceiptIds.has(candidate) &&
          !this.receipts.has(candidate)
        ) {
          receiptId = candidate;
          break;
        }
      }
      if (!receiptId) return null;
      entry.historyReceiptIds.add(receiptId);
      const materializer = parsed.materializeReceipt;
      if (typeof materializer !== "function") return null;
      const receipt = materializer({ receiptId, expiresAt: now + this.receiptTtlMs });
      if (!receipt) return null;
      const stored = clone(AuthorizedRequestReceiptSchema.parse(receipt));
      if (
        stored.receiptId !== receiptId ||
        stored.expiresAt !== now + this.receiptTtlMs ||
        !sameReceiptBinding(stored, entry.binding) ||
        this.receipts.has(stored.receiptId)
      )
        return null;
      if (
        (entry.requestId !== undefined && entry.requestId !== stored.requestId) ||
        (entry.requestType !== undefined && entry.requestType !== stored.requestType)
      )
        return null;
      entry.requestId ??= stored.requestId;
      entry.requestType ??= stored.requestType;
      this.receipts.set(stored.receiptId, stored);
      entry.receiptIds.add(stored.receiptId);
      if (parsed.emission === "terminal") entry.status = "terminal";
      return clone(stored);
    } catch {
      return null;
    }
  }

  async burnFreshReceipts(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
  }) {
    const parsed = snapshotReference(input);
    if (!parsed) return;
    const entry = this.emissionEntries.get(parsed?.handle as object);
    if (
      !entry ||
      entry.binding.sessionBindingKey !== parsed.sessionBindingKey ||
      entry.binding.sessionBindingGeneration !== parsed.sessionBindingGeneration
    )
      return;
    for (const receiptId of entry.receiptIds) this.receipts.delete(receiptId);
    entry.receiptIds.clear();
  }

  async close(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
    readonly reason: ActiveAuthorizedRequestCloseReason;
  }) {
    const parsed = snapshotClose(input);
    if (!parsed) return;
    if (
      !["end", "cancel", "revoked", "release", "invalidate", "authorization_failed"].includes(
        String(parsed.reason),
      )
    )
      return;
    const entry = this.emissionEntries.get(parsed?.handle as object);
    if (
      !entry ||
      entry.binding.sessionBindingKey !== parsed.sessionBindingKey ||
      entry.binding.sessionBindingGeneration !== parsed.sessionBindingGeneration
    )
      return;
    entry.status = "closed";
    for (const receiptId of entry.receiptIds) this.receipts.delete(receiptId);
    entry.receiptIds.clear();
    this.emissionEntries.delete(parsed.handle as object);
    this.emissionEntryIndex.delete(entry);
  }

  private closeEmissionEntries(
    predicate: (
      binding: AuthoritySessionBindingRecord,
      entry: { requestId?: string; requestType?: string },
    ) => boolean,
  ): void {
    for (const entry of this.emissionEntryIndex) {
      if (!predicate(entry.binding, entry)) continue;
      entry.status = "closed";
      for (const receiptId of entry.receiptIds) this.receipts.delete(receiptId);
      entry.receiptIds.clear();
      this.emissionEntries.delete(entry.handle as object);
      this.emissionEntryIndex.delete(entry);
    }
  }

  // oxlint-disable-next-line max-depth -- replacement atomically prunes prior session receipts.
  registerSessionBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord {
    const binding = parseStrictOwnData(AuthoritySessionBindingRecordSchema, input, BINDING_KEYS);
    if (!binding) throw new Error("Invalid binding");
    const same = this.bindings
      .get(binding.sessionBindingKey)
      ?.get(binding.sessionBindingGeneration);
    if (same && JSON.stringify(same) !== JSON.stringify(binding))
      throw new Error("Binding collision");
    for (const [key, generations] of this.bindings) {
      for (const [generation, prior] of generations)
        if (prior.sessionId === binding.sessionId) {
          this.closeEmissionEntries(
            (active) =>
              active.sessionId === prior.sessionId &&
              active.sessionBindingKey === prior.sessionBindingKey &&
              active.sessionBindingGeneration === prior.sessionBindingGeneration,
          );
          generations.delete(generation);
          for (const [receiptId, receipt] of this.receipts)
            if (
              receipt.sessionId === prior.sessionId &&
              receipt.sessionBindingKey === prior.sessionBindingKey &&
              receipt.sessionBindingGeneration === prior.sessionBindingGeneration
            )
              this.receipts.delete(receiptId);
        }
      if (generations.size === 0) this.bindings.delete(key);
    }
    let generations = this.bindings.get(binding.sessionBindingKey);
    if (!generations) {
      generations = new Map();
      this.bindings.set(binding.sessionBindingKey, generations);
    }
    generations.set(binding.sessionBindingGeneration, clone(binding));
    return clone(binding);
  }

  async consumeAuthorizedRequest(receiptId: string): Promise<{
    receipt: AuthorizedRequestReceipt;
    currentBinding: AuthoritySessionBindingRecord;
  } | null> {
    if (typeof receiptId !== "string" || !receiptId) return null;
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return null;
    this.receipts.delete(receiptId);
    const now = this.now();
    this.purgeExpired(now);
    const binding = this.bindings
      .get(receipt.sessionBindingKey)
      ?.get(receipt.sessionBindingGeneration);
    if (!binding || receipt.expiresAt <= now) return null;
    return clone({ receipt, currentBinding: binding });
  }

  async resolveCurrentSessionBinding(input: {
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }): Promise<AuthoritySessionBindingRecord | null> {
    const parsed = parseStrictOwnData(BindingLookupSchema, input, LOOKUP_KEYS);
    if (!parsed) return null;
    const binding = this.bindings
      .get(parsed.sessionBindingKey)
      ?.get(parsed.sessionBindingGeneration);
    return binding ? clone(binding) : null;
  }

  endRequest(input: {
    sessionId: string;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
    requestId: string;
  }): void {
    const parsed = parseStrictOwnData(CorrelationSchema, input, CORRELATION_KEYS);
    if (!parsed) return;
    this.endRequestCanonical(parsed);
  }
  private endRequestCanonical(parsed: z.output<typeof CorrelationSchema>): void {
    this.closeEmissionEntries(
      (binding, entry) =>
        binding.sessionId === parsed.sessionId &&
        binding.sessionBindingKey === parsed.sessionBindingKey &&
        binding.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        entry.requestId === parsed.requestId,
    );
    for (const [id, receipt] of this.receipts)
      if (
        receipt.sessionId === parsed.sessionId &&
        receipt.sessionBindingKey === parsed.sessionBindingKey &&
        receipt.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        receipt.requestId === parsed.requestId
      )
        this.receipts.delete(id);
  }
  cancelRequest(input: {
    sessionId: string;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
    requestId: string;
  }): void {
    const parsed = parseStrictOwnData(CorrelationSchema, input, CORRELATION_KEYS);
    if (parsed) this.endRequestCanonical(parsed);
  }
  invalidateSession(input: {
    sessionId: string;
    sessionBindingGeneration: string;
    sessionBindingKey: string;
  }): void {
    const parsed = parseStrictOwnData(SessionScopeSchema, input, SESSION_KEYS);
    if (!parsed) return;
    this.invalidateSessionCanonical(parsed);
  }
  private invalidateSessionCanonical(parsed: z.output<typeof SessionScopeSchema>): void {
    this.closeEmissionEntries(
      (binding) =>
        binding.sessionId === parsed.sessionId &&
        binding.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        binding.sessionBindingKey === parsed.sessionBindingKey,
    );
    this.invalidate(
      (r) =>
        r.sessionId === parsed.sessionId &&
        r.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        r.sessionBindingKey === parsed.sessionBindingKey,
      (b) =>
        b.sessionId === parsed.sessionId &&
        b.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        b.sessionBindingKey === parsed.sessionBindingKey,
    );
  }
  invalidateGeneration(input: {
    sessionId: string;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }): void {
    const parsed = parseStrictOwnData(SessionScopeSchema, input, SESSION_KEYS);
    if (parsed) this.invalidateSessionCanonical(parsed);
  }
  invalidateCredential(input: {
    organizationId: string;
    principalId: string;
    credentialId: string;
  }): void {
    const parsed = parseStrictOwnData(CredentialSchema, input, CREDENTIAL_KEYS);
    if (!parsed) return;
    this.closeEmissionEntries(
      (binding) =>
        binding.organizationId === parsed.organizationId &&
        binding.principalId === parsed.principalId &&
        binding.credentialId === parsed.credentialId,
    );
    this.invalidate(
      (r) =>
        r.organizationId === parsed.organizationId &&
        r.principalId === parsed.principalId &&
        r.credentialId === parsed.credentialId,
      (b) =>
        b.organizationId === parsed.organizationId &&
        b.principalId === parsed.principalId &&
        b.credentialId === parsed.credentialId,
    );
  }
  invalidatePrincipal(input: { organizationId: string; principalId: string }): void {
    const parsed = parseStrictOwnData(PrincipalSchema, input, PRINCIPAL_KEYS);
    if (!parsed) return;
    this.closeEmissionEntries(
      (binding) =>
        binding.organizationId === parsed.organizationId &&
        binding.principalId === parsed.principalId,
    );
    this.invalidate(
      (r) => r.principalId === parsed.principalId && r.organizationId === parsed.organizationId,
      (b) => b.principalId === parsed.principalId && b.organizationId === parsed.organizationId,
    );
  }
  invalidateGrant(input: {
    organizationId: string;
    principalId: string;
    grantVersion: string;
  }): void {
    const parsed = parseStrictOwnData(GrantSchema, input, GRANT_KEYS);
    if (!parsed) return;
    this.closeEmissionEntries(
      (binding) =>
        binding.organizationId === parsed.organizationId &&
        binding.principalId === parsed.principalId &&
        binding.grantVersion === parsed.grantVersion,
    );
    this.invalidate(
      (r) =>
        r.organizationId === parsed.organizationId &&
        r.principalId === parsed.principalId &&
        r.grantVersion === parsed.grantVersion,
      (b) =>
        b.organizationId === parsed.organizationId &&
        b.principalId === parsed.principalId &&
        b.grantVersion === parsed.grantVersion,
    );
  }
  releaseSession(input: {
    sessionId: string;
    sessionBindingGeneration: string;
    sessionBindingKey: string;
  }): void {
    const parsed = parseStrictOwnData(SessionScopeSchema, input, SESSION_KEYS);
    if (!parsed) return;
    this.closeEmissionEntries(
      (binding) =>
        binding.sessionId === parsed.sessionId &&
        binding.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        binding.sessionBindingKey === parsed.sessionBindingKey,
    );
    this.invalidate(
      (r) =>
        r.sessionId === parsed.sessionId &&
        r.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        r.sessionBindingKey === parsed.sessionBindingKey,
      (b) =>
        b.sessionId === parsed.sessionId &&
        b.sessionBindingGeneration === parsed.sessionBindingGeneration &&
        b.sessionBindingKey === parsed.sessionBindingKey,
    );
  }

  private invalidate(
    receiptMatch: (receipt: AuthorizedRequestReceipt) => boolean,
    bindingMatch: (binding: AuthoritySessionBindingRecord) => boolean,
  ): void {
    for (const [id, receipt] of this.receipts) if (receiptMatch(receipt)) this.receipts.delete(id);
    for (const [key, generations] of this.bindings) {
      for (const [generation, binding] of generations)
        if (bindingMatch(binding)) generations.delete(generation);
      if (generations.size === 0) this.bindings.delete(key);
    }
  }
  private purgeExpired(now: number): void {
    for (const [id, receipt] of this.receipts)
      if (receipt.expiresAt <= now) this.receipts.delete(id);
  }
  private now(): number {
    const value = this.clock.now();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (this.lastClock !== undefined && value < this.lastClock)
    )
      throw new Error("Unsafe receipt clock");
    this.lastClock = value;
    return value;
  }
}

function sameBindingRecord(
  left: AuthoritySessionBindingRecord,
  right: AuthoritySessionBindingRecord,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionBindingKey === right.sessionBindingKey &&
    left.sessionBindingGeneration === right.sessionBindingGeneration &&
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    left.nodeId === right.nodeId &&
    left.clientId === right.clientId
  );
}

function sameReceiptBinding(
  receipt: AuthorizedRequestReceipt,
  binding: AuthoritySessionBindingRecord,
): boolean {
  return (
    receipt.sessionId === binding.sessionId &&
    receipt.sessionBindingKey === binding.sessionBindingKey &&
    receipt.sessionBindingGeneration === binding.sessionBindingGeneration &&
    receipt.organizationId === binding.organizationId &&
    receipt.principalId === binding.principalId &&
    receipt.principalType === binding.principalType &&
    receipt.credentialId === binding.credentialId &&
    receipt.grantVersion === binding.grantVersion &&
    receipt.nodeId === binding.nodeId &&
    receipt.clientId === binding.clientId
  );
}

export function createAuthorityReceiptStatePort(
  options?: AuthorityReceiptStateOptions,
): MemoryAuthorityReceiptState {
  return new MemoryAuthorityReceiptState(options);
}
