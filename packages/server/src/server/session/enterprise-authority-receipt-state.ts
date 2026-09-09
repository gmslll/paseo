import { z } from "zod";
import { OrganizationIdSchema, PrincipalIdSchema } from "@getpaseo/protocol/messages";
import type { EnterpriseAction } from "@getpaseo/protocol/messages";
import type { PermissionRequirement } from "../authorization/operation-permissions.js";
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

const RegisterInputSchema = AuthorizedRequestReceiptSchema.omit({
  receiptId: true,
  expiresAt: true,
}).strict();
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
const HARD_MAX_RECEIPTS = 10_000;
export const AUTHORITY_RECEIPT_TTL_MAX_MS = 60_000;
export const AUTHORITY_RECEIPT_ID_MIN_LENGTH = 16;
export const AUTHORITY_RECEIPT_ID_MAX_LENGTH = 256;
export type AuthorityReceiptRegisterInput = Readonly<
  Omit<z.input<typeof RegisterInputSchema>, "authorization">
> & {
  readonly authorization: {
    readonly succeeded: true;
    readonly daemonPermission: PermissionRequirement;
    readonly enterpriseActions: readonly EnterpriseAction[];
  };
};

/** Minimal Session-owned binding lifecycle seam; receipt consumption remains W2-owned. */
export interface AuthoritySessionBindingLifecycle {
  registerSessionBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord;
  registerAuthorizedRequest(input: AuthorityReceiptRegisterInput): AuthorizedRequestReceipt;
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

export class MemoryAuthorityReceiptState
  implements AuthorityReceiptStatePort, AuthoritySessionBindingLifecycle
{
  private readonly receipts = new Map<string, AuthorizedRequestReceipt>();
  private readonly bindings = new Map<string, Map<string, AuthoritySessionBindingRecord>>();
  private readonly maxReceipts: number;
  private readonly clock: AuthorityReceiptClock;
  private readonly receiptIdFactory: () => string;
  private readonly receiptTtlMs: number;
  private lastClock: number | undefined;

  constructor(options: AuthorityReceiptStateOptions = {}) {
    this.maxReceipts = options.maxReceipts ?? 1024;
    if (
      !Number.isSafeInteger(this.maxReceipts) ||
      this.maxReceipts < 1 ||
      this.maxReceipts > HARD_MAX_RECEIPTS
    )
      throw new Error("Invalid receipt capacity");
    const clock = options.clock ?? { now: () => Date.now() };
    this.clock = { now: clock.now.bind(clock) };
    const defaultRandomUUID = globalThis.crypto?.randomUUID;
    if (!options.receiptIdFactory && typeof defaultRandomUUID !== "function")
      throw new Error("Receipt ID factory unavailable");
    const factory = options.receiptIdFactory ?? defaultRandomUUID.bind(globalThis.crypto);
    this.receiptIdFactory = factory.bind(undefined);
    this.receiptTtlMs = options.receiptTtlMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.receiptTtlMs) ||
      this.receiptTtlMs < 1 ||
      this.receiptTtlMs > AUTHORITY_RECEIPT_TTL_MAX_MS
    )
      throw new Error("Invalid receipt TTL");
  }

  // oxlint-disable-next-line max-depth -- replacement atomically prunes prior session receipts.
  registerSessionBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord {
    const binding = AuthoritySessionBindingRecordSchema.parse(structuredClone(input));
    const same = this.bindings
      .get(binding.sessionBindingKey)
      ?.get(binding.sessionBindingGeneration);
    if (same && JSON.stringify(same) !== JSON.stringify(binding))
      throw new Error("Binding collision");
    for (const [key, generations] of this.bindings) {
      for (const [generation, prior] of generations)
        if (prior.sessionId === binding.sessionId) {
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

  registerAuthorizedRequest(input: AuthorityReceiptRegisterInput): AuthorizedRequestReceipt {
    const parsed = RegisterInputSchema.parse(structuredClone(input));
    const now = this.now();
    if (now > Number.MAX_SAFE_INTEGER - this.receiptTtlMs)
      throw new Error("Receipt expiry overflow");
    const expiresAt = now + this.receiptTtlMs;
    const binding = this.bindings
      .get(parsed.sessionBindingKey)
      ?.get(parsed.sessionBindingGeneration);
    if (!binding || !sameBindingFields(parsed, binding))
      throw new Error("Stale authority session binding");
    this.purgeExpired(now);
    if (this.receipts.size >= this.maxReceipts)
      throw new Error("Authority receipt capacity exceeded");
    let receiptId = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = this.receiptIdFactory();
      if (
        typeof candidate === "string" &&
        new RegExp(
          `^[A-Za-z0-9._~-]{${AUTHORITY_RECEIPT_ID_MIN_LENGTH},${AUTHORITY_RECEIPT_ID_MAX_LENGTH}}$`,
        ).test(candidate) &&
        !this.receipts.has(candidate)
      ) {
        receiptId = candidate;
        break;
      }
    }
    if (!receiptId) throw new Error("Authority receipt collision");
    const receipt = AuthorizedRequestReceiptSchema.parse({ ...parsed, expiresAt, receiptId });
    if (this.receipts.has(receiptId)) throw new Error("Authority receipt collision");
    this.receipts.set(receiptId, clone(receipt));
    return clone(receipt);
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
    const parsed = parseInput(BindingLookupSchema, input);
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
    const parsed = parseInput(CorrelationSchema, input);
    if (!parsed) return;
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
    this.endRequest(input);
  }
  invalidateSession(input: {
    sessionId: string;
    sessionBindingGeneration: string;
    sessionBindingKey: string;
  }): void {
    const parsed = parseInput(SessionScopeSchema, input);
    if (!parsed) return;
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
    this.invalidateSession(input);
  }
  invalidateCredential(input: {
    organizationId: string;
    principalId: string;
    credentialId: string;
  }): void {
    const parsed = parseInput(CredentialSchema, input);
    if (!parsed) return;
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
    const parsed = parseInput(PrincipalSchema, input);
    if (!parsed) return;
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
    const parsed = parseInput(GrantSchema, input);
    if (!parsed) return;
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
    const parsed = parseInput(SessionScopeSchema, input);
    if (!parsed) return;
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

function sameBindingFields(
  receipt: AuthorityReceiptRegisterInput,
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
