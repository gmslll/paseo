import {
  createEnterpriseSessionBindingKey,
  DaemonPermissionSchema,
  EnterpriseActionSchema,
  NodeIdSchema,
  OrganizationIdSchema,
  PrincipalIdSchema,
  type OutboundAuthorizationContext,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { PermissionRequirement } from "../../authorization/operation-permissions.js";
import {
  authorityReceiptPolicyForEvent,
  type OutboundAuthorityReceiptPolicy,
} from "./event-action-map.js";

type OutboundAuthority = Extract<OutboundAuthorizationContext, { kind: "authority" }>["authority"];
type AuthorizedRequestAuthority = Extract<OutboundAuthority, { kind: "authorized_request" }>;
type IdentitySelfAuthority = Extract<OutboundAuthority, { kind: "identity_self" }>;

const PermissionRequirementSchema = z.union([
  DaemonPermissionSchema,
  z.array(DaemonPermissionSchema).min(1),
  z.null(),
]);

export const AuthoritySessionBindingRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    sessionBindingKey: z.string().min(1),
    sessionBindingGeneration: z.string().min(1),
    organizationId: OrganizationIdSchema,
    principalId: PrincipalIdSchema,
    principalType: z.enum(["human", "service", "break_glass_owner"]),
    credentialId: z.string().min(1),
    grantVersion: z.string().min(1),
    nodeId: NodeIdSchema,
    clientId: z.string().min(1),
  })
  .strict();

export type AuthoritySessionBindingRecord = z.infer<typeof AuthoritySessionBindingRecordSchema>;

export const AuthorizedRequestReceiptSchema = AuthoritySessionBindingRecordSchema.extend({
  receiptId: z.string().min(1),
  requestId: z.string().min(1),
  requestType: z.string().min(1),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  authorization: z
    .object({
      succeeded: z.literal(true),
      daemonPermission: PermissionRequirementSchema,
      enterpriseActions: z.array(EnterpriseActionSchema),
    })
    .strict(),
}).strict();

export type AuthorizedRequestReceipt = z.infer<typeof AuthorizedRequestReceiptSchema>;

const ConsumedAuthorizedRequestSchema = z
  .object({
    receipt: AuthorizedRequestReceiptSchema,
    currentBinding: AuthoritySessionBindingRecordSchema,
  })
  .strict();

export interface AuthorityReceiptStatePort {
  /**
   * Atomically consumes a receipt. Missing, invalidated, ended, cancelled, or
   * already-consumed receipts return null. The accompanying binding is the
   * registry's current Session binding at the instant of consumption.
   */
  consumeAuthorizedRequest(receiptId: string): Promise<{
    receipt: AuthorizedRequestReceipt;
    currentBinding: AuthoritySessionBindingRecord;
  } | null>;

  /** Resolves only a binding that is current for this key and generation. */
  resolveCurrentSessionBinding(input: {
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }): Promise<AuthoritySessionBindingRecord | null>;
}

export interface AuthorityReceiptClock {
  now(): number;
}

export class SystemAuthorityReceiptClock implements AuthorityReceiptClock {
  now(): number {
    return Date.now();
  }
}

export interface OutboundAuthorityVerifier {
  verify(
    ctx: PrincipalContext,
    event: SessionOutboundMessage,
    authority: OutboundAuthority,
  ): Promise<boolean>;
}

export class StrictOutboundAuthorityVerifier implements OutboundAuthorityVerifier {
  private lastClockReading: number | undefined;

  constructor(
    private readonly nodeId: string,
    private readonly state: AuthorityReceiptStatePort,
    private readonly clock: AuthorityReceiptClock = new SystemAuthorityReceiptClock(),
  ) {}

  async verify(
    ctx: PrincipalContext,
    event: SessionOutboundMessage,
    authority: OutboundAuthority,
  ): Promise<boolean> {
    try {
      if (authority.kind === "authorized_request") {
        return await this.verifyAuthorizedRequest(ctx, event, authority);
      }
      return await this.verifyIdentitySelf(ctx, event, authority);
    } catch {
      return false;
    }
  }

  private async verifyAuthorizedRequest(
    ctx: PrincipalContext,
    event: SessionOutboundMessage,
    authority: AuthorizedRequestAuthority,
  ): Promise<boolean> {
    const policy = authorityReceiptPolicyForEvent(event);
    if (!policy || policy.requestType !== authority.requestType) return false;
    if (requestIdForEvent(event) !== authority.requestId) return false;

    const consumed = await this.state.consumeAuthorizedRequest(authority.receiptId);
    const parsed = ConsumedAuthorizedRequestSchema.safeParse(consumed);
    if (!parsed.success) return false;
    const { receipt, currentBinding } = parsed.data;
    const now = this.readClock();
    if (now === null || receipt.expiresAt <= now) return false;
    if (!receiptMatchesAuthority(receipt, authority, policy)) return false;
    if (!bindingMatchesPrincipal(currentBinding, ctx, this.nodeId)) return false;
    if (!bindingMatchesPrincipal(receipt, ctx, this.nodeId)) return false;
    if (!sameBinding(receipt, currentBinding)) return false;
    if (!eventClientMatchesReceipt(event, receipt.clientId)) return false;
    return bindingKeyMatchesPrincipal(receipt, ctx);
  }

  private async verifyIdentitySelf(
    ctx: PrincipalContext,
    event: SessionOutboundMessage,
    authority: IdentitySelfAuthority,
  ): Promise<boolean> {
    if (!identitySelfMessageMatchesEvent(authority, event, ctx, this.nodeId)) return false;
    const binding = await this.state.resolveCurrentSessionBinding({
      sessionBindingKey: authority.sessionBindingKey,
      sessionBindingGeneration: authority.sessionBindingGeneration,
    });
    const parsed = AuthoritySessionBindingRecordSchema.safeParse(binding);
    if (!parsed.success) return false;
    if (
      parsed.data.sessionBindingKey !== authority.sessionBindingKey ||
      parsed.data.sessionBindingGeneration !== authority.sessionBindingGeneration ||
      !bindingMatchesPrincipal(parsed.data, ctx, this.nodeId)
    )
      return false;
    return bindingKeyMatchesPrincipal(parsed.data, ctx);
  }

  private readClock(): number | null {
    let reading: number;
    try {
      reading = this.clock.now();
    } catch {
      return null;
    }
    if (
      !Number.isSafeInteger(reading) ||
      reading < 0 ||
      (this.lastClockReading !== undefined && reading < this.lastClockReading)
    )
      return null;
    this.lastClockReading = reading;
    return reading;
  }
}

function requestIdForEvent(event: SessionOutboundMessage): string | null {
  if ("requestId" in event && typeof event.requestId === "string" && event.requestId.length > 0)
    return event.requestId;
  if (!("payload" in event)) return null;
  const payload: unknown = event.payload;
  if (!payload || typeof payload !== "object" || !("requestId" in payload)) return null;
  const requestId = payload.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

function eventClientMatchesReceipt(event: SessionOutboundMessage, clientId: string): boolean {
  if (
    event.type !== "status" ||
    (event.payload.status !== "restart_requested" && event.payload.status !== "shutdown_requested")
  )
    return true;
  return event.payload.clientId === clientId;
}

function receiptMatchesAuthority(
  receipt: AuthorizedRequestReceipt,
  authority: AuthorizedRequestAuthority,
  policy: OutboundAuthorityReceiptPolicy,
): boolean {
  return (
    receipt.receiptId === authority.receiptId &&
    receipt.requestId === authority.requestId &&
    receipt.requestType === authority.requestType &&
    receipt.sessionBindingKey === authority.sessionBindingKey &&
    receipt.sessionBindingGeneration === authority.sessionBindingGeneration &&
    samePermissionRequirement(receipt.authorization.daemonPermission, policy.daemonPermission) &&
    sameActions(receipt.authorization.enterpriseActions, policy.enterpriseActions)
  );
}

function bindingMatchesPrincipal(
  binding: AuthoritySessionBindingRecord,
  ctx: PrincipalContext,
  nodeId: string,
): boolean {
  return (
    binding.organizationId === ctx.organizationId &&
    binding.principalId === ctx.principalId &&
    binding.principalType === ctx.principalType &&
    binding.credentialId === ctx.credentialId &&
    binding.grantVersion === ctx.grantVersion &&
    binding.nodeId === nodeId
  );
}

function bindingKeyMatchesPrincipal(
  binding: AuthoritySessionBindingRecord,
  ctx: PrincipalContext,
): boolean {
  return (
    binding.sessionBindingKey ===
    createEnterpriseSessionBindingKey({
      organizationId: ctx.organizationId,
      principalId: ctx.principalId,
      credentialId: ctx.credentialId,
      grantVersion: ctx.grantVersion,
      clientId: binding.clientId,
    })
  );
}

function sameBinding(
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

function samePermissionRequirement(
  left: PermissionRequirement,
  right: PermissionRequirement,
): boolean {
  if (left === null || right === null) return left === right;
  const leftValues = typeof left === "string" ? [left] : [...left];
  const rightValues = typeof right === "string" ? [right] : [...right];
  return sameUniqueStrings(leftValues, rightValues);
}

function sameActions(left: readonly string[], right: readonly string[]): boolean {
  return sameUniqueStrings(left, right);
}

function sameUniqueStrings(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function identitySelfMessageMatchesEvent(
  authority: IdentitySelfAuthority,
  event: SessionOutboundMessage,
  ctx: PrincipalContext,
  nodeId: string,
): boolean {
  switch (authority.message.type) {
    case "enterprise.identity.get_current.response":
      return (
        event.type === "enterprise.identity.get_current.response" &&
        event.payload.requestId === authority.message.requestId &&
        identityProjectionMatches(event.payload.identity, ctx, nodeId)
      );
    case "enterprise.identity.logout_all.response":
      return (
        event.type === "enterprise.identity.logout_all.response" &&
        event.payload.requestId === authority.message.requestId
      );
    case "enterprise.identity.scope_refreshed":
      return (
        event.type === "enterprise.identity.scope_refreshed" &&
        identityProjectionMatches(event.payload.identity, ctx, nodeId)
      );
    case "enterprise.identity.credential_revoked":
      return event.type === "enterprise.identity.credential_revoked";
  }
}

function identityProjectionMatches(
  identity: {
    organizationId: string;
    principalId: string;
    principalType: string;
    grantVersion: string;
    nodeId: string;
  },
  ctx: PrincipalContext,
  nodeId: string,
): boolean {
  return (
    identity.organizationId === ctx.organizationId &&
    identity.principalId === ctx.principalId &&
    identity.principalType === ctx.principalType &&
    identity.grantVersion === ctx.grantVersion &&
    identity.nodeId === nodeId
  );
}
