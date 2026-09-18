import {
  PrincipalContextSchema,
  type EnterpriseAction,
  type PrincipalContext,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";
import type { SessionInboundMessage } from "../../messages.js";
import {
  SessionAuthorization,
  activateCurrentInboundDaemonAuthorizationDecision,
  closeActiveInboundDaemonAuthorization,
  consumeInboundDaemonAuthorizationDecision,
  isActiveInboundDaemonAuthorizationCurrent,
  type ActiveInboundDaemonAuthorization,
  type ConsumedInboundDaemonAuthorizationDecision,
  type InboundDaemonAuthorizationDecision,
} from "../../authorization/index.js";
import type { PermissionRequirement } from "../../authorization/operation-permissions.js";
import { authorityReceiptPolicyForRequestType } from "./event-action-map.js";
import type { PrincipalGrantVersionGuard } from "./resource-authorization.js";

declare const inboundAuthoritySuccessEvidenceBrand: unique symbol;
declare const activeAuthorizedRequestHandleBrand: unique symbol;

export interface InboundAuthoritySuccessEvidence {
  readonly [inboundAuthoritySuccessEvidenceBrand]: true;
}

/** Opaque request-lifetime capability. It is not an outbound receipt. */
export interface ActiveAuthorizedRequestHandle {
  readonly [activeAuthorizedRequestHandleBrand]: true;
}

export interface ConsumedInboundAuthoritySuccessEvidence {
  readonly organizationId: string;
  readonly principalId: string;
  readonly principalType: PrincipalContext["principalType"];
  readonly credentialId: string;
  readonly grantVersion: string;
  readonly requestType: SessionInboundMessage["type"];
  readonly requestId: string;
  readonly activeRequestHandle: ActiveAuthorizedRequestHandle;
  readonly authorization: {
    readonly succeeded: true;
    readonly daemonPermission: PermissionRequirement;
    readonly enterpriseActions: readonly EnterpriseAction[];
  };
}

export interface InboundAuthorityRequestAuthorizerDependencies {
  readonly sessionAuthorization: SessionAuthorization;
  readonly principal: PrincipalContext;
  readonly grantVersionGuard: PrincipalGrantVersionGuard;
}

interface InboundAuthoritySuccessEvidenceState {
  readonly authorizer: InboundAuthorityRequestAuthorizer;
  readonly message: SessionInboundMessage;
  readonly requestType: SessionInboundMessage["type"];
  readonly requestId: string;
  readonly daemonAuthorization: ConsumedInboundDaemonAuthorizationDecision;
  readonly consumed: Omit<ConsumedInboundAuthoritySuccessEvidence, "activeRequestHandle">;
}

interface ActiveAuthorizedRequestHandleState {
  readonly authorizer: InboundAuthorityRequestAuthorizer;
  readonly sessionAuthorization: SessionAuthorization;
  readonly daemonAuthorization: ActiveInboundDaemonAuthorization;
  readonly isGrantCurrent: () => boolean;
  readonly principal: PrincipalContext;
  readonly requestType: SessionInboundMessage["type"];
  readonly requestId: string;
  readonly authorization: ConsumedInboundAuthoritySuccessEvidence["authorization"];
}

/** Internal projection returned only after an emission authorizer claims the handle. */
export interface ClaimedActiveAuthorizedRequest {
  readonly principal: PrincipalContext;
  readonly requestType: SessionInboundMessage["type"];
  readonly requestId: string;
  readonly authorization: ConsumedInboundAuthoritySuccessEvidence["authorization"];
  isDaemonAuthorizationCurrent(): boolean;
  isGrantCurrent(): boolean;
  close(): void;
}

const issuedEvidence = new WeakMap<object, InboundAuthoritySuccessEvidenceState>();
const issuedActiveRequestHandles = new WeakMap<object, ActiveAuthorizedRequestHandleState>();

/**
 * Converts a one-use daemon decision into a pending receipt-registration handle.
 * This port is deliberately synchronous: there is no awaitable seam between
 * its current-Grant samples, so it makes no asynchronous race guarantee.
 */
export class InboundAuthorityRequestAuthorizer {
  private readonly sessionAuthorization: SessionAuthorization;
  private readonly principal: PrincipalContext;
  private readonly isCurrentGrantVersion: (ctx: PrincipalContext) => boolean;

  constructor(dependencies: InboundAuthorityRequestAuthorizerDependencies) {
    this.sessionAuthorization = dependencies.sessionAuthorization;
    this.principal = canonicalPrincipal(dependencies.principal);
    this.isCurrentGrantVersion = dependencies.grantVersionGuard.isCurrent.bind(
      dependencies.grantVersionGuard,
    );
  }

  authorize(
    message: SessionInboundMessage,
    decision: InboundDaemonAuthorizationDecision,
  ): InboundAuthoritySuccessEvidence | null {
    try {
      if (!this.isPrincipalGrantCurrent()) return null;
      const daemonAuthorization = consumeInboundDaemonAuthorizationDecision(
        this.sessionAuthorization,
        message,
        decision,
      );
      if (!daemonAuthorization) return null;
      const requestId = inboundRequestId(message);
      const policy = authorityReceiptPolicyForRequestType(daemonAuthorization.requestType);
      if (
        requestId === null ||
        !policy ||
        !samePermissionRequirement(daemonAuthorization.daemonPermission, policy.daemonPermission) ||
        !policy.enterpriseActions.every((action) => organizationGrantAllows(this.principal, action))
      ) {
        return null;
      }
      if (!this.isPrincipalGrantCurrent()) return null;

      const consumed = deepFreeze({
        organizationId: this.principal.organizationId,
        principalId: this.principal.principalId,
        principalType: this.principal.principalType,
        credentialId: this.principal.credentialId,
        grantVersion: this.principal.grantVersion,
        requestType: policy.requestType,
        requestId,
        authorization: {
          succeeded: true as const,
          daemonPermission: clonePermissionRequirement(policy.daemonPermission),
          enterpriseActions: [...policy.enterpriseActions],
        },
      }) as Omit<ConsumedInboundAuthoritySuccessEvidence, "activeRequestHandle">;
      const evidence = Object.freeze(
        Object.create(null) as object,
      ) as unknown as InboundAuthoritySuccessEvidence;
      issuedEvidence.set(evidence, {
        authorizer: this,
        message,
        requestType: policy.requestType,
        requestId,
        daemonAuthorization,
        consumed,
      });
      return evidence;
    } catch {
      return null;
    }
  }

  consumeForRegistration(
    message: SessionInboundMessage,
    evidence: InboundAuthoritySuccessEvidence,
  ): ConsumedInboundAuthoritySuccessEvidence | null {
    try {
      if ((typeof evidence !== "object" && typeof evidence !== "function") || evidence === null) {
        return null;
      }
      const issued = issuedEvidence.get(evidence);
      if (!issued) return null;
      issuedEvidence.delete(evidence);
      const requestType = inboundRequestType(message);
      const requestId = inboundRequestId(message);
      const grantVersionIsCurrent = this.isPrincipalGrantCurrent();
      const activeDaemonAuthorization = activateCurrentInboundDaemonAuthorizationDecision(
        this.sessionAuthorization,
        message,
        requestType,
        issued.daemonAuthorization,
      );
      if (
        issued.authorizer !== this ||
        issued.message !== message ||
        issued.requestType !== requestType ||
        issued.requestId !== requestId ||
        !activeDaemonAuthorization ||
        !grantVersionIsCurrent
      ) {
        if (activeDaemonAuthorization) {
          closeActiveInboundDaemonAuthorization(
            this.sessionAuthorization,
            activeDaemonAuthorization,
          );
        }
        return null;
      }
      const activeRequestHandle = Object.freeze(
        Object.create(null) as object,
      ) as unknown as ActiveAuthorizedRequestHandle;
      issuedActiveRequestHandles.set(activeRequestHandle, {
        authorizer: this,
        sessionAuthorization: this.sessionAuthorization,
        daemonAuthorization: activeDaemonAuthorization,
        isGrantCurrent: this.isPrincipalGrantCurrent.bind(this),
        principal: this.principal,
        requestType: issued.requestType,
        requestId: issued.requestId,
        authorization: issued.consumed.authorization,
      });
      return deepFreeze({ ...issued.consumed, activeRequestHandle });
    } catch {
      return null;
    }
  }

  /** @internal Used by the claimed request handle without exposing the guard. */
  isPrincipalGrantCurrent(): boolean {
    try {
      return this.isCurrentGrantVersion(this.principal) === true;
    } catch {
      return false;
    }
  }
}

/** @internal Claimed handles are removed before any caller-controlled validation. */
export function claimActiveAuthorizedRequestHandle(
  handle: ActiveAuthorizedRequestHandle,
  authorizer: InboundAuthorityRequestAuthorizer,
  sessionAuthorization: SessionAuthorization,
): ClaimedActiveAuthorizedRequest | null {
  try {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
      return null;
    }
    const active = issuedActiveRequestHandles.get(handle);
    if (!active) return null;
    issuedActiveRequestHandles.delete(handle);
    if (active.authorizer !== authorizer || active.sessionAuthorization !== sessionAuthorization) {
      return null;
    }
    let closed = false;
    return Object.freeze({
      principal: active.principal,
      requestType: active.requestType,
      requestId: active.requestId,
      authorization: active.authorization,
      isDaemonAuthorizationCurrent: () =>
        !closed &&
        isActiveInboundDaemonAuthorizationCurrent(
          sessionAuthorization,
          active.daemonAuthorization,
          active.requestType,
          active.authorization.daemonPermission,
        ),
      isGrantCurrent: () => !closed && active.isGrantCurrent(),
      close: () => {
        if (closed) return;
        closed = true;
        closeActiveInboundDaemonAuthorization(sessionAuthorization, active.daemonAuthorization);
      },
    });
  } catch {
    return null;
  }
}

export function isActiveAuthorizedRequestHandle(
  value: unknown,
): value is ActiveAuthorizedRequestHandle {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    issuedActiveRequestHandles.has(value)
  );
}

export function isInboundAuthoritySuccessEvidence(
  value: unknown,
): value is InboundAuthoritySuccessEvidence {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    issuedEvidence.has(value)
  );
}

function canonicalPrincipal(input: PrincipalContext): PrincipalContext {
  const parsed = PrincipalContextSchema.parse(structuredClone(input));
  return deepFreeze({
    organizationId: parsed.organizationId,
    principalId: parsed.principalId,
    principalType: parsed.principalType,
    credentialId: parsed.credentialId,
    grantVersion: parsed.grantVersion,
    grants: parsed.grants.map(canonicalGrant),
  }) as PrincipalContext;
}

function canonicalGrant(grant: ResourceGrant): ResourceGrant {
  switch (grant.selector.kind) {
    case "workspace":
      return {
        action: grant.action,
        selector: { kind: grant.selector.kind, workspaceIds: [...grant.selector.workspaceIds] },
      };
    case "organization":
      return {
        action: grant.action,
        selector: {
          kind: grant.selector.kind,
          organizationId: grant.selector.organizationId,
        },
      };
    case "self":
      return { action: grant.action, selector: { kind: grant.selector.kind } };
  }
}

function organizationGrantAllows(principal: PrincipalContext, action: EnterpriseAction): boolean {
  return principal.grants.some(
    (grant) =>
      grant.action === action &&
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === principal.organizationId,
  );
}

function inboundRequestType(message: SessionInboundMessage): SessionInboundMessage["type"] | null {
  try {
    if (typeof message !== "object" || message === null || !("type" in message)) return null;
    return typeof message.type === "string" ? message.type : null;
  } catch {
    return null;
  }
}

function inboundRequestId(message: SessionInboundMessage): string | null {
  try {
    if (typeof message !== "object" || message === null || !("requestId" in message)) return null;
    const requestId: unknown = message.requestId;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
  } catch {
    return null;
  }
}

function clonePermissionRequirement(requirement: PermissionRequirement): PermissionRequirement {
  return Array.isArray(requirement) ? Object.freeze([...requirement]) : requirement;
}

function samePermissionRequirement(
  left: PermissionRequirement,
  right: PermissionRequirement,
): boolean {
  if (left === null || right === null) return left === right;
  const leftValues = typeof left === "string" ? [left] : [...left];
  const rightValues = typeof right === "string" ? [right] : [...right];
  if (new Set(leftValues).size !== leftValues.length) return false;
  if (new Set(rightValues).size !== rightValues.length) return false;
  return [...leftValues].sort().join("\0") === [...rightValues].sort().join("\0");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
