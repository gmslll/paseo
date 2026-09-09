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

export type QuarantineReason = "legacy_owner_only" | "partial_owner" | "missing_workspace";

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
  }

  registerAgent(record: EnterpriseAgentAuthorizationRecord): void {
    const key = resourceKey("agent", record.id);
    if (!record.workspaceId) {
      this.agents.delete(record.id);
      this.quarantine.set(key, { kind: "agent", id: record.id, reason: "missing_workspace" });
      return;
    }

    const result = classifyOwner(record);
    if (result.kind === "quarantined") {
      this.agents.delete(record.id);
      this.quarantine.set(key, { kind: "agent", id: record.id, reason: result.reason });
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
    return this.agents.get(agentId) ?? null;
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
