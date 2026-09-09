import {
  normalizeEnterpriseResourceOwner,
  type AuthorizedAgent,
  type AuthorizedWorkspace,
  type EnterpriseResourceOwnerWire,
  type EnterpriseWorkspaceAuthorizationRecord,
} from "@getpaseo/protocol/messages";

export type EnterpriseAgentAuthorizationRecord = EnterpriseResourceOwnerWire & {
  id: string;
  workspaceId?: string;
};

export type QuarantineReason =
  | "legacy_owner_only"
  | "partial_owner"
  | "missing_workspace"
  | "workspace_unavailable"
  | "owner_mismatch";

export interface QuarantinedResource {
  kind: "workspace" | "agent";
  id: string;
  reason: QuarantineReason;
}

type OwnedWorkspace = AuthorizedWorkspace;
type OwnedAgent = AuthorizedAgent;

/**
 * Canonical in-process owner index. Rows without a complete enterprise owner
 * envelope stay quarantined and are never returned as authorized resources.
 */
export class OwnerRegistry {
  private readonly workspaces = new Map<string, OwnedWorkspace>();
  private readonly agents = new Map<string, OwnedAgent>();
  private readonly quarantine = new Map<string, QuarantinedResource>();

  registerWorkspace(record: EnterpriseWorkspaceAuthorizationRecord): void {
    const result = classifyOwner(record);
    const key = resourceKey("workspace", record.id);
    if (result.kind === "quarantined") {
      this.workspaces.delete(record.id);
      this.quarantine.set(key, { kind: "workspace", id: record.id, reason: result.reason });
      return;
    }

    this.workspaces.set(record.id, { workspaceId: record.id, ...result.owner });
    this.quarantine.delete(key);
    for (const [agentId, agent] of this.agents) {
      if (agent.workspaceId !== record.id || ownersMatch(agent, result.owner)) continue;
      this.agents.delete(agentId);
      this.quarantine.set(resourceKey("agent", agentId), {
        kind: "agent",
        id: agentId,
        reason: "owner_mismatch",
      });
    }
  }

  registerAgent(record: EnterpriseAgentAuthorizationRecord): void {
    const key = resourceKey("agent", record.id);
    if (!record.workspaceId) {
      this.agents.delete(record.id);
      this.quarantine.set(key, { kind: "agent", id: record.id, reason: "missing_workspace" });
      return;
    }

    const workspace = this.workspaces.get(record.workspaceId);
    if (!workspace) {
      this.agents.delete(record.id);
      this.quarantine.set(key, {
        kind: "agent",
        id: record.id,
        reason: "workspace_unavailable",
      });
      return;
    }

    const result = classifyOwner(record);
    if (result.kind === "quarantined") {
      if (result.reason === "legacy_owner_only") {
        this.agents.set(record.id, {
          agentId: record.id,
          workspaceId: record.workspaceId,
          organizationId: workspace.organizationId,
          nodeId: workspace.nodeId,
          ownerPrincipalId: workspace.ownerPrincipalId,
          createdByPrincipalId: workspace.createdByPrincipalId,
        });
        this.quarantine.delete(key);
        return;
      }
      this.agents.delete(record.id);
      this.quarantine.set(key, { kind: "agent", id: record.id, reason: result.reason });
      return;
    }

    if (!ownersMatch(result.owner, workspace)) {
      this.agents.delete(record.id);
      this.quarantine.set(key, { kind: "agent", id: record.id, reason: "owner_mismatch" });
      return;
    }

    this.agents.set(record.id, {
      agentId: record.id,
      workspaceId: record.workspaceId,
      ...result.owner,
    });
    this.quarantine.delete(key);
  }

  getWorkspace(workspaceId: string): OwnedWorkspace | null {
    return this.workspaces.get(workspaceId) ?? null;
  }

  getAgent(agentId: string): OwnedAgent | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const workspace = this.workspaces.get(agent.workspaceId);
    if (!workspace) {
      this.agents.delete(agentId);
      this.quarantine.set(resourceKey("agent", agentId), {
        kind: "agent",
        id: agentId,
        reason: "workspace_unavailable",
      });
      return null;
    }
    if (!ownersMatch(agent, workspace)) {
      this.agents.delete(agentId);
      this.quarantine.set(resourceKey("agent", agentId), {
        kind: "agent",
        id: agentId,
        reason: "owner_mismatch",
      });
      return null;
    }
    this.quarantine.delete(resourceKey("agent", agentId));
    return agent;
  }

  quarantined(): QuarantinedResource[] {
    return [...this.quarantine.values()];
  }
}

function resourceKey(kind: QuarantinedResource["kind"], id: string): string {
  return `${kind}:${id}`;
}

function classifyOwner(
  record: EnterpriseWorkspaceAuthorizationRecord | EnterpriseAgentAuthorizationRecord,
):
  | { kind: "owned"; owner: NonNullable<ReturnType<typeof normalizeEnterpriseResourceOwner>> }
  | {
      kind: "quarantined";
      reason: "legacy_owner_only" | "partial_owner";
    } {
  try {
    const owner = normalizeEnterpriseResourceOwner(record);
    if (owner) return { kind: "owned", owner };
    return { kind: "quarantined", reason: "legacy_owner_only" };
  } catch {
    return { kind: "quarantined", reason: "partial_owner" };
  }
}

function ownersMatch(
  left: NonNullable<ReturnType<typeof normalizeEnterpriseResourceOwner>>,
  right: NonNullable<ReturnType<typeof normalizeEnterpriseResourceOwner>>,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}
