import {
  NodeIdSchema,
  PrincipalContextSchema,
  SessionOutboundMessageSchema,
  createEnterpriseSessionBindingKey,
  type OutboundAuthorizationContext,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { SessionAuthorization } from "../../authorization/index.js";
import {
  AuthoritySessionBindingRecordSchema,
  AuthorizedRequestReceiptSchema,
  type AuthoritySessionBindingRecord,
  type AuthorizedRequestReceipt,
} from "./authority-receipt-verifier.js";
import {
  type ActiveAuthorizedRequestHandle,
  type ClaimedActiveAuthorizedRequest,
  InboundAuthorityRequestAuthorizer,
  claimActiveAuthorizedRequestHandle,
} from "./inbound-authority-request-authorizer.js";
import {
  authorityReceiptPolicyForEvent,
  type OutboundAuthorityReceiptPolicy,
} from "./event-action-map.js";

type AuthorizedRequestContext = Extract<OutboundAuthorizationContext, { kind: "authority" }>;

export type ActiveAuthorizedRequestCloseReason =
  | "end"
  | "cancel"
  | "revoked"
  | "release"
  | "invalidate"
  | "authorization_failed";

export const ACTIVE_AUTHORIZED_REQUEST_MAX_EMISSIONS = 1_024;

export interface FreshAuthorityReceiptSeed {
  readonly receiptId: string;
  readonly expiresAt: number;
}

export type FreshAuthorityReceiptMaterializer = (seed: unknown) => AuthorizedRequestReceipt | null;

interface ActiveRequestReference {
  readonly handle: ActiveAuthorizedRequestHandle;
  readonly sessionBindingKey: string;
  readonly sessionBindingGeneration: string;
}

/**
 * W3 owns this state and lifecycle port. W2 is the only producer of the
 * opaque handle and receipt materializer, so mint inputs contain no caller
 * supplied Principal, permission, action, request type, or request ID.
 */
export interface OutboundAuthorityEmissionStatePort {
  register(input: {
    readonly handle: ActiveAuthorizedRequestHandle;
    readonly binding: AuthoritySessionBindingRecord;
  }): Promise<AuthoritySessionBindingRecord | null>;
  resolveOpen(input: ActiveRequestReference): Promise<AuthoritySessionBindingRecord | null>;
  /**
   * Atomically checks the open generation, allocates an ID that has never
   * appeared in this request state, stores the materialized receipt, and marks
   * terminal emissions terminal before resolving.
   */
  mintFreshReceipt(
    input: ActiveRequestReference & {
      readonly emission: OutboundAuthorityReceiptPolicy["emission"];
      readonly materializeReceipt: FreshAuthorityReceiptMaterializer;
    },
  ): Promise<AuthorizedRequestReceipt | null>;
  burnFreshReceipts(input: ActiveRequestReference): Promise<void>;
  close(
    input: ActiveRequestReference & { readonly reason: ActiveAuthorizedRequestCloseReason },
  ): Promise<void>;
}

export interface OutboundAuthorityEmissionAuthorizerDependencies {
  readonly inboundAuthorizer: InboundAuthorityRequestAuthorizer;
  readonly sessionAuthorization: SessionAuthorization;
  readonly nodeId: string;
  readonly state: OutboundAuthorityEmissionStatePort;
}

export interface RegisterActiveAuthorizedRequestInput {
  readonly handle: ActiveAuthorizedRequestHandle;
  readonly principal: PrincipalContext;
  readonly binding: AuthoritySessionBindingRecord;
}

export interface AuthorizeOutboundAuthorityEmissionInput extends RegisterActiveAuthorizedRequestInput {
  readonly event: SessionOutboundMessage;
}

export interface CloseActiveAuthorizedRequestInput extends RegisterActiveAuthorizedRequestInput {
  readonly reason: Exclude<ActiveAuthorizedRequestCloseReason, "authorization_failed">;
}

interface ActiveRequestState {
  readonly handle: ActiveAuthorizedRequestHandle;
  readonly claimed: ClaimedActiveAuthorizedRequest;
  readonly principal: PrincipalContext;
  readonly binding: AuthoritySessionBindingRecord;
  readonly mintedReceiptIds: Set<string>;
  tail: Promise<void>;
  teardownPromise: Promise<void> | null;
  readonly teardownFailures: unknown[];
  lifecycle: "registering" | "open" | "terminal_pending" | "terminal" | "closed";
}

const FreshAuthorityReceiptSeedSchema = z
  .object({
    receiptId: z.string().min(1),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * Revalidates one active authorized request and asks W3 to mint a fresh,
 * one-use receipt for each exact outbound emission.
 */
export class OutboundAuthorityEmissionAuthorizer {
  private readonly inboundAuthorizer: InboundAuthorityRequestAuthorizer;
  private readonly sessionAuthorization: SessionAuthorization;
  private readonly nodeId: string;
  private readonly registerState: OutboundAuthorityEmissionStatePort["register"];
  private readonly resolveOpenState: OutboundAuthorityEmissionStatePort["resolveOpen"];
  private readonly mintFreshReceiptState: OutboundAuthorityEmissionStatePort["mintFreshReceipt"];
  private readonly burnFreshReceiptsState: OutboundAuthorityEmissionStatePort["burnFreshReceipts"];
  private readonly closeState: OutboundAuthorityEmissionStatePort["close"];
  private readonly requests = new WeakMap<object, ActiveRequestState>();

  constructor(dependencies: OutboundAuthorityEmissionAuthorizerDependencies) {
    this.inboundAuthorizer = dependencies.inboundAuthorizer;
    this.sessionAuthorization = dependencies.sessionAuthorization;
    this.nodeId = NodeIdSchema.parse(dependencies.nodeId);
    const state = dependencies.state;
    this.registerState = state.register.bind(state);
    this.resolveOpenState = state.resolveOpen.bind(state);
    this.mintFreshReceiptState = state.mintFreshReceipt.bind(state);
    this.burnFreshReceiptsState = state.burnFreshReceipts.bind(state);
    this.closeState = state.close.bind(state);
  }

  async register(input: RegisterActiveAuthorizedRequestInput): Promise<boolean> {
    let state: ActiveRequestState | null = null;
    try {
      const handle = input.handle;
      const principal = canonicalPrincipal(input.principal);
      const binding = canonicalBinding(input.binding);
      const claimed = claimActiveAuthorizedRequestHandle(
        handle,
        this.inboundAuthorizer,
        this.sessionAuthorization,
      );
      if (!claimed) return false;
      state = {
        handle,
        claimed,
        principal,
        binding,
        mintedReceiptIds: new Set(),
        tail: Promise.resolve(),
        teardownPromise: null,
        teardownFailures: [],
        lifecycle: "registering",
      };
      this.requests.set(handle, state);
      if (!this.isCurrent(state)) return await this.failClosed(state);
      const registered = canonicalBindingOrNull(
        await this.registerState({ handle: state.handle, binding: state.binding }),
      );
      if (
        state.lifecycle !== "registering" ||
        !registered ||
        !sameBinding(registered, state.binding) ||
        !this.isCurrent(state)
      ) {
        return await this.failClosed(state);
      }
      state.lifecycle = "open";
      return true;
    } catch {
      if (state) await this.failClosed(state);
      return false;
    }
  }

  authorizeEmission(
    input: AuthorizeOutboundAuthorityEmissionInput,
  ): Promise<AuthorizedRequestContext | null> {
    let principal: PrincipalContext;
    let binding: AuthoritySessionBindingRecord;
    let event: SessionOutboundMessage;
    let handle: ActiveAuthorizedRequestHandle;
    try {
      handle = input.handle;
      principal = canonicalPrincipal(input.principal);
      binding = canonicalBinding(input.binding);
      event = SessionOutboundMessageSchema.parse(structuredClone(input.event));
    } catch {
      return Promise.resolve(null);
    }
    const state = this.requestState(handle);
    if (!state) return Promise.resolve(null);
    const operation = state.tail.then(
      () => this.authorizeEmissionSerial(state, principal, binding, event),
      () => this.authorizeEmissionSerial(state, principal, binding, event),
    );
    state.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async close(input: CloseActiveAuthorizedRequestInput): Promise<boolean> {
    try {
      const handle = input.handle;
      const principal = canonicalPrincipal(input.principal);
      const binding = canonicalBinding(input.binding);
      const state = this.requestState(handle);
      if (
        !state ||
        !samePrincipal(state.principal, principal) ||
        !sameBinding(state.binding, binding) ||
        state.lifecycle === "closed" ||
        state.lifecycle === "terminal"
      ) {
        return false;
      }
      state.lifecycle = "closed";
      state.claimed.close();
      const teardown = this.closeState({ ...this.reference(state), reason: input.reason });
      state.teardownPromise = teardown;
      await teardown;
      return true;
    } catch {
      return false;
    }
  }

  /** @internal Runtime teardown needs the exact delegate failure after local revocation. */
  closeForTeardown(input: CloseActiveAuthorizedRequestInput): Promise<void> {
    const handle = input.handle;
    const principal = canonicalPrincipal(input.principal);
    const binding = canonicalBinding(input.binding);
    const state = this.requestState(handle);
    if (
      !state ||
      !samePrincipal(state.principal, principal) ||
      !sameBinding(state.binding, binding)
    ) {
      throw new Error("active authorized request does not match runtime teardown");
    }
    if (state.teardownPromise) return state.teardownPromise;
    if (state.lifecycle === "closed") {
      return rejectCleanupFailures(state.teardownFailures);
    }
    const pendingTail = state.tail;
    state.lifecycle = "closed";
    state.claimed.close();
    const reference = this.reference(state);
    const teardown = (async () => {
      const failures: unknown[] = [];
      const cleanup = (async () => {
        try {
          await this.burnFreshReceiptsState(reference);
        } catch (error) {
          failures.push(error);
        }
        try {
          const closeResult: unknown = await this.closeState({
            ...reference,
            reason: input.reason,
          });
          if (closeResult === false) {
            failures.push(new Error("authority state rejected active request close"));
          }
        } catch (error) {
          failures.push(error);
        }
      })();
      await Promise.allSettled([pendingTail, cleanup]);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "active authorized request cleanup failed", {
          cause: failures[0],
        });
      }
    })();
    state.teardownPromise = teardown;
    return teardown;
  }

  private async authorizeEmissionSerial(
    state: ActiveRequestState,
    principal: PrincipalContext,
    binding: AuthoritySessionBindingRecord,
    event: SessionOutboundMessage,
  ): Promise<AuthorizedRequestContext | null> {
    try {
      if (state.lifecycle !== "open") return null;
      if (state.mintedReceiptIds.size >= ACTIVE_AUTHORIZED_REQUEST_MAX_EMISSIONS) {
        await this.failClosed(state, true);
        return null;
      }
      const policy = authorityReceiptPolicyForEvent(event);
      if (!policy || !this.matchesEmission(state, principal, binding, event, policy)) {
        await this.failClosed(state);
        return null;
      }
      if (policy.emission === "terminal") state.lifecycle = "terminal_pending";
      const currentBinding = canonicalBindingOrNull(
        await this.resolveOpenState(this.reference(state)),
      );
      if (
        !currentBinding ||
        !sameBinding(currentBinding, state.binding) ||
        !this.matchesEmission(state, principal, binding, event, policy)
      ) {
        await this.failClosed(state);
        return null;
      }
      const materializeReceipt = this.receiptMaterializer(state, binding, policy);
      const rawReceipt = await this.mintFreshReceiptState({
        ...this.reference(state),
        emission: policy.emission,
        materializeReceipt,
      });
      const receipt = canonicalReceiptOrNull(rawReceipt);
      if (
        !receipt ||
        !this.matchesEmission(state, principal, binding, event, policy) ||
        !receiptMatches(receipt, state, binding, policy) ||
        state.mintedReceiptIds.has(receipt.receiptId)
      ) {
        await this.failClosed(state, true);
        return null;
      }
      state.mintedReceiptIds.add(receipt.receiptId);
      if (policy.emission === "terminal") {
        state.lifecycle = "terminal";
        state.claimed.close();
      }
      return deepFreeze({
        kind: "authority" as const,
        authority: {
          kind: "authorized_request" as const,
          receiptId: receipt.receiptId,
          requestId: state.claimed.requestId,
          requestType: state.claimed.requestType,
          sessionBindingKey: binding.sessionBindingKey,
          sessionBindingGeneration: binding.sessionBindingGeneration,
        },
      });
    } catch {
      await this.failClosed(state, true);
      return null;
    }
  }

  private receiptMaterializer(
    state: ActiveRequestState,
    binding: AuthoritySessionBindingRecord,
    policy: OutboundAuthorityReceiptPolicy,
  ): FreshAuthorityReceiptMaterializer {
    let used = false;
    return (input: unknown) => {
      try {
        if (used) return null;
        used = true;
        const seed = FreshAuthorityReceiptSeedSchema.parse(structuredClone(input));
        if (!this.isCurrentForPolicy(state, policy)) return null;
        return deepFreeze(
          AuthorizedRequestReceiptSchema.parse({
            ...binding,
            ...seed,
            requestId: state.claimed.requestId,
            requestType: state.claimed.requestType,
            authorization: {
              succeeded: true,
              daemonPermission: clonePermissionRequirement(policy.daemonPermission),
              enterpriseActions: [...policy.enterpriseActions],
            },
          }),
        );
      } catch {
        return null;
      }
    };
  }

  private matchesEmission(
    state: ActiveRequestState,
    principal: PrincipalContext,
    binding: AuthoritySessionBindingRecord,
    event: SessionOutboundMessage,
    policy: OutboundAuthorityReceiptPolicy,
  ): boolean {
    return (
      (state.lifecycle === "open" || state.lifecycle === "terminal_pending") &&
      samePrincipal(state.principal, principal) &&
      sameBinding(state.binding, binding) &&
      policy.requestType === state.claimed.requestType &&
      requestIdForEvent(event) === state.claimed.requestId &&
      eventClientMatchesBinding(event, binding.clientId) &&
      this.isCurrentForPolicy(state, policy)
    );
  }

  private isCurrent(state: ActiveRequestState): boolean {
    return (
      samePrincipal(state.claimed.principal, state.principal) &&
      bindingMatchesPrincipal(state.binding, state.principal, this.nodeId) &&
      state.claimed.isDaemonAuthorizationCurrent() &&
      state.claimed.isGrantCurrent()
    );
  }

  private isCurrentForPolicy(
    state: ActiveRequestState,
    policy: OutboundAuthorityReceiptPolicy,
  ): boolean {
    return (
      this.isCurrent(state) &&
      samePermissionRequirement(
        state.claimed.authorization.daemonPermission,
        policy.daemonPermission,
      ) &&
      sameStrings(state.claimed.authorization.enterpriseActions, policy.enterpriseActions) &&
      policy.enterpriseActions.every((action) => organizationGrantAllows(state.principal, action))
    );
  }

  private requestState(handle: ActiveAuthorizedRequestHandle): ActiveRequestState | null {
    try {
      if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
        return null;
      }
      return this.requests.get(handle) ?? null;
    } catch {
      return null;
    }
  }

  private reference(state: ActiveRequestState): ActiveRequestReference {
    return Object.freeze({
      handle: state.handle,
      sessionBindingKey: state.binding.sessionBindingKey,
      sessionBindingGeneration: state.binding.sessionBindingGeneration,
    });
  }

  private async failClosed(state: ActiveRequestState, burn = false): Promise<false> {
    state.lifecycle = "closed";
    state.claimed.close();
    if (state.teardownPromise) return false;
    const reference = this.reference(state);
    if (burn) {
      try {
        await this.burnFreshReceiptsState(reference);
      } catch (error) {
        state.teardownFailures.push(error);
        // The state port must also invalidate receipts when close runs.
      }
    }
    try {
      await this.closeState({ ...reference, reason: "authorization_failed" });
    } catch (error) {
      state.teardownFailures.push(error);
      // The local capability remains closed even when external cleanup fails.
    }
    return false;
  }
}

function rejectCleanupFailures(failures: readonly unknown[]): Promise<void> {
  if (failures.length === 0) return Promise.resolve();
  if (failures.length === 1) return Promise.reject(failures[0]);
  return Promise.reject(
    new AggregateError(failures, "active authorized request cleanup failed", {
      cause: failures[0],
    }),
  );
}

function canonicalPrincipal(input: PrincipalContext): PrincipalContext {
  return deepFreeze(PrincipalContextSchema.parse(structuredClone(input)));
}

function canonicalBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord {
  return deepFreeze(AuthoritySessionBindingRecordSchema.parse(structuredClone(input)));
}

function canonicalBindingOrNull(input: unknown): AuthoritySessionBindingRecord | null {
  try {
    return canonicalBinding(input as AuthoritySessionBindingRecord);
  } catch {
    return null;
  }
}

function canonicalReceiptOrNull(input: unknown): AuthorizedRequestReceipt | null {
  try {
    return deepFreeze(AuthorizedRequestReceiptSchema.parse(structuredClone(input)));
  } catch {
    return null;
  }
}

function bindingMatchesPrincipal(
  binding: AuthoritySessionBindingRecord,
  principal: PrincipalContext,
  nodeId: string,
): boolean {
  return (
    binding.organizationId === principal.organizationId &&
    binding.principalId === principal.principalId &&
    binding.principalType === principal.principalType &&
    binding.credentialId === principal.credentialId &&
    binding.grantVersion === principal.grantVersion &&
    binding.nodeId === nodeId &&
    binding.sessionBindingKey ===
      createEnterpriseSessionBindingKey({
        organizationId: principal.organizationId,
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        grantVersion: principal.grantVersion,
        clientId: binding.clientId,
      })
  );
}

function samePrincipal(left: PrincipalContext, right: PrincipalContext): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    JSON.stringify(left.grants) === JSON.stringify(right.grants)
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

function receiptMatches(
  receipt: AuthorizedRequestReceipt,
  state: ActiveRequestState,
  binding: AuthoritySessionBindingRecord,
  policy: OutboundAuthorityReceiptPolicy,
): boolean {
  return (
    sameBinding(receipt, binding) &&
    receipt.requestId === state.claimed.requestId &&
    receipt.requestType === state.claimed.requestType &&
    samePermissionRequirement(receipt.authorization.daemonPermission, policy.daemonPermission) &&
    sameStrings(receipt.authorization.enterpriseActions, policy.enterpriseActions)
  );
}

function requestIdForEvent(event: SessionOutboundMessage): string | null {
  try {
    if ("requestId" in event && typeof event.requestId === "string" && event.requestId.length > 0) {
      return event.requestId;
    }
    if (!("payload" in event) || !event.payload || typeof event.payload !== "object") return null;
    if (!("requestId" in event.payload)) return null;
    const requestId: unknown = event.payload.requestId;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
}

function eventClientMatchesBinding(event: SessionOutboundMessage, clientId: string): boolean {
  if (
    event.type !== "status" ||
    (event.payload.status !== "restart_requested" && event.payload.status !== "shutdown_requested")
  ) {
    return true;
  }
  return event.payload.clientId === clientId;
}

function organizationGrantAllows(
  principal: PrincipalContext,
  action: OutboundAuthorityReceiptPolicy["enterpriseActions"][number],
): boolean {
  return principal.grants.some(
    (grant) =>
      grant.action === action &&
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === principal.organizationId,
  );
}

function clonePermissionRequirement(
  requirement: OutboundAuthorityReceiptPolicy["daemonPermission"],
): OutboundAuthorityReceiptPolicy["daemonPermission"] {
  return Array.isArray(requirement) ? Object.freeze([...requirement]) : requirement;
}

function samePermissionRequirement(
  left: OutboundAuthorityReceiptPolicy["daemonPermission"],
  right: OutboundAuthorityReceiptPolicy["daemonPermission"],
): boolean {
  if (left === null || right === null) return left === right;
  const leftValues = typeof left === "string" ? [left] : [...left];
  const rightValues = typeof right === "string" ? [right] : [...right];
  return sameStrings(leftValues, rightValues);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
