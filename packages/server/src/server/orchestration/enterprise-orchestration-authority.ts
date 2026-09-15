import {
  AuditEventInputSchema,
  PrincipalContextSchema,
  type AuditEventInput,
  type AuditSink,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";

import { getAuthoritativeAgent } from "../enterprise/access/owner-registry.js";
import {
  ResourceAuthorizationError,
  type OwnerAuthorizationRegistry,
  type PrincipalGrantVersionGuard,
  type ResourceAuthorizationService,
} from "../enterprise/access/resource-authorization.js";
import type { EnterpriseAdmissionRuntime } from "../enterprise/identity/runtime.js";
import type { PrincipalGrantSource } from "../enterprise/identity/registry.js";
import type {
  OrchestrationAuditEvent,
  OrchestrationAuthority,
  OrchestrationTarget,
} from "./orchestration-authority.js";
import { OrchestrationError } from "./orchestration-error.js";

// A delegation acts for the owner of the requester Agent's Workspace (ADR-0043). Grant matching
// never reads the credential, so the frozen context names the delegation instead of a secret.
const DELEGATION_CREDENTIAL_PREFIX = "agent-delegation:";

export interface EnterpriseOrchestrationAuthorityDependencies {
  owners: Pick<OwnerAuthorizationRegistry, "getAgent">;
  principals: PrincipalGrantSource;
  resources: Pick<ResourceAuthorizationService, "assertWorkspace" | "assertAgent">;
  grantVersionGuard: PrincipalGrantVersionGuard;
  audit: AuditSink;
}

function targetResource(target: OrchestrationTarget): AuditEventInput["resource"] {
  if (target.kind === "prompt") return { kind: "agent", id: target.agentId };
  return { kind: "workspace", id: target.workspaceId ?? "unresolved" };
}

function deniedAuditInput(input: {
  principal: PrincipalContext;
  requesterAgentId: string;
  target: OrchestrationTarget;
}): AuditEventInput {
  return AuditEventInputSchema.parse({
    organizationId: input.principal.organizationId,
    actorPrincipalId: input.principal.principalId,
    action: "orchestration.operation.denied",
    resource: targetResource(input.target),
    ...(input.target.kind === "create" && input.target.workspaceId
      ? { workspaceId: input.target.workspaceId }
      : {}),
    outcome: "denied",
    priority: "high",
    reasonCode: "AUTHORIZATION_DENIED",
    metadata: { requesterAgentId: input.requesterAgentId },
  });
}

function lifecycleAuditInput(
  principal: PrincipalContext,
  event: OrchestrationAuditEvent,
): AuditEventInput {
  return AuditEventInputSchema.parse({
    organizationId: principal.organizationId,
    actorPrincipalId: principal.principalId,
    action: event.action,
    resource: { kind: "agent", id: event.requesterAgentId },
    agentId: event.requesterAgentId,
    outcome: event.action === "orchestration.delivery.uncertain" ? "failed" : "allowed",
    metadata: { ...event.metadata, operationId: event.operationId },
  });
}

export function createEnterpriseOrchestrationAuthority(
  dependencies: EnterpriseOrchestrationAuthorityDependencies,
): OrchestrationAuthority {
  async function resolveRequesterPrincipal(
    requesterAgentId: string,
  ): Promise<PrincipalContext | null> {
    const requester = dependencies.owners.getAgent(requesterAgentId);
    if (!requester) return null;
    const projection = await dependencies.principals.resolvePrincipal(
      requester.ownerPrincipalId,
      requester.organizationId,
    );
    if (
      projection?.principalId !== requester.ownerPrincipalId ||
      projection.organizationId !== requester.organizationId
    ) {
      return null;
    }
    return PrincipalContextSchema.parse({
      ...projection,
      credentialId: `${DELEGATION_CREDENTIAL_PREFIX}${requesterAgentId}`,
    });
  }

  async function assertTarget(principal: PrincipalContext, target: OrchestrationTarget) {
    if (target.kind === "create") {
      if (target.workspaceId === null) throw new ResourceAuthorizationError();
      await dependencies.resources.assertWorkspace(
        principal,
        "workspace.write",
        target.workspaceId,
      );
    } else {
      await dependencies.resources.assertAgent(principal, "workspace.write", target.agentId);
    }
  }

  return {
    async authorizeAccept({ requesterAgentId, targets }) {
      const principal = await resolveRequesterPrincipal(requesterAgentId);
      if (!principal) {
        throw new OrchestrationError(
          "AUTHORIZATION_DENIED",
          `Agent ${requesterAgentId} has no Workspace owner on this node`,
        );
      }
      for (const target of targets) {
        try {
          await assertTarget(principal, target);
        } catch (error) {
          if (!(error instanceof ResourceAuthorizationError)) throw error;
          await dependencies.audit.append(
            deniedAuditInput({ principal, requesterAgentId, target }),
            { durability: "required" },
          );
          throw new OrchestrationError(
            "AUTHORIZATION_DENIED",
            "A delegation target is not available to this Agent",
          );
        }
      }
      return { mode: "enterprise", principal };
    },

    isCurrent(authority) {
      if (authority.mode !== "enterprise") return false;
      try {
        return dependencies.grantVersionGuard.isCurrent(authority.principal);
      } catch {
        return false;
      }
    },

    async record(event) {
      if (event.authority.mode !== "enterprise") return;
      await dependencies.audit.append(lifecycleAuditInput(event.authority.principal, event), {
        durability: "buffered",
      });
    },
  };
}

/**
 * The authority delegations run under on this daemon, or null when an enterprise node cannot
 * resolve Workspace owners, in which case the outbox stays off.
 */
export function createEnterpriseRuntimeOrchestrationAuthority(
  runtime: EnterpriseAdmissionRuntime,
): OrchestrationAuthority | null {
  const owners = runtime.authorizationRuntimeProvider?.owners;
  if (!owners || !runtime.principalSource) return null;
  return createEnterpriseOrchestrationAuthority({
    owners: { getAgent: (agentId) => getAuthoritativeAgent(owners, agentId) },
    principals: runtime.principalSource,
    resources: runtime.resourceAuthorization,
    grantVersionGuard: runtime.grantVersionGuard,
    audit: runtime.audit,
  });
}
