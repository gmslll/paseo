import {
  PrincipalContextSchema,
  type EnterpriseAction,
  type PrincipalContext,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";
import type { SessionInboundMessage } from "../../messages.js";
import {
  SessionAuthorization,
  consumeCurrentInboundDaemonAuthorizationDecision,
  consumeInboundDaemonAuthorizationDecision,
  type ConsumedInboundDaemonAuthorizationDecision,
  type InboundDaemonAuthorizationDecision,
} from "../../authorization/index.js";
import type { PermissionRequirement } from "../../authorization/operation-permissions.js";
import { authorityReceiptPolicyForRequestType } from "./event-action-map.js";
import type { PrincipalGrantVersionGuard } from "./resource-authorization.js";

declare const inboundAuthoritySuccessEvidenceBrand: unique symbol;

export interface InboundAuthoritySuccessEvidence {
  readonly [inboundAuthoritySuccessEvidenceBrand]: true;
}

export interface ConsumedInboundAuthoritySuccessEvidence {
  readonly organizationId: string;
  readonly principalId: string;
  readonly principalType: PrincipalContext["principalType"];
  readonly credentialId: string;
  readonly grantVersion: string;
  readonly requestType: SessionInboundMessage["type"];
  readonly requestId: string;
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
  readonly consumed: ConsumedInboundAuthoritySuccessEvidence;
}

const issuedEvidence = new WeakMap<object, InboundAuthoritySuccessEvidenceState>();

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
      if (!this.isCurrent()) return null;
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
      if (!this.isCurrent()) return null;

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
      }) as ConsumedInboundAuthoritySuccessEvidence;
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
      const grantVersionIsCurrent = this.isCurrent();
      const daemonAuthorizationIsCurrent = consumeCurrentInboundDaemonAuthorizationDecision(
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
        !daemonAuthorizationIsCurrent ||
        !grantVersionIsCurrent
      ) {
        return null;
      }
      return issued.consumed;
    } catch {
      return null;
    }
  }

  private isCurrent(): boolean {
    try {
      return this.isCurrentGrantVersion(this.principal) === true;
    } catch {
      return false;
    }
  }
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
