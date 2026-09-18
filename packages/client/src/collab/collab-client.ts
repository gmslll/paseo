import type {
  CollabPresenceHeartbeat,
  CollabSubscriptionEvent,
  PresenceEntry,
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";

import { CollabReplica, type CollabReplicaScope } from "./collab-replica.js";

/**
 * Client-side collaboration surface (ADR-0031, ADR-0033, ADR-0036).
 *
 * Membership writes go through a port the plane implements; this object only keeps the replica
 * coherent and drops it on revoke or logout. It does not talk to a node: Agent operations go
 * through `MachineRpcClient`.
 */

export interface CollabMembershipPort {
  list(workspaceUid: string): Promise<readonly WorkspaceMember[]>;
  upsert(workspaceUid: string, principalId: string, role: WorkspaceMemberRole): Promise<void>;
  remove(workspaceUid: string, principalId: string): Promise<void>;
}

export interface CollabPresencePort {
  beat(workspaceUid: string, heartbeat: CollabPresenceHeartbeat): Promise<readonly PresenceEntry[]>;
}

export class CollabClient {
  constructor(
    private readonly replica: CollabReplica,
    private readonly membership: CollabMembershipPort,
    private readonly presence: CollabPresencePort,
  ) {}

  ingest(scope: CollabReplicaScope, event: CollabSubscriptionEvent): void {
    this.replica.apply(scope, event);
  }

  snapshot(scope: CollabReplicaScope) {
    return this.replica.snapshot(scope);
  }

  async refreshMembers(scope: CollabReplicaScope): Promise<void> {
    if (this.replica.snapshot(scope)?.revoked) return;
    const members = await this.membership.list(scope.workspaceUid);
    this.replica.replaceMembers(scope, members);
  }

  async share(
    scope: CollabReplicaScope,
    principalId: string,
    role: WorkspaceMemberRole,
  ): Promise<void> {
    if (this.replica.snapshot(scope)?.revoked) {
      throw new Error("Workspace access was revoked");
    }
    await this.membership.upsert(scope.workspaceUid, principalId, role);
    await this.refreshMembers(scope);
  }

  async unshare(scope: CollabReplicaScope, principalId: string): Promise<void> {
    if (this.replica.snapshot(scope)?.revoked) {
      throw new Error("Workspace access was revoked");
    }
    await this.membership.remove(scope.workspaceUid, principalId);
    await this.refreshMembers(scope);
  }

  async heartbeat(scope: CollabReplicaScope, heartbeat: CollabPresenceHeartbeat): Promise<void> {
    if (this.replica.snapshot(scope)?.revoked) return;
    const entries = await this.presence.beat(scope.workspaceUid, heartbeat);
    this.replica.apply(scope, {
      type: "presence",
      containerId: scope.workspaceUid,
      entries: [...entries],
    });
  }

  /** Membership was taken away: drop the local copy so it cannot be read after logout of access. */
  handleRevoked(scope: CollabReplicaScope, reason: string): void {
    this.replica.apply(scope, {
      type: "revoked",
      containerId: scope.workspaceUid,
      reason,
    });
  }

  logout(organizationId: string, principalId: string): void {
    this.replica.clearPrincipal(organizationId, principalId);
  }
}
