import type {
  CollabSubscriptionEvent,
  PresenceEntry,
  WorkspaceMember,
} from "@getpaseo/protocol/enterprise-collaboration";

/**
 * A client's copy of one collaborative Workspace (ADR-0031, ADR-0036).
 *
 * Partitioned by `(organizationId, principalId, workspaceUid)` so a revoke or logout can drop
 * exactly that Principal's replica and nothing else. The daemon's catalog is node-scoped; this one
 * is Principal-scoped because two employees on the same device must not share it.
 */

export interface CollabReplicaScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly workspaceUid: string;
}

export interface CollabReplicaSnapshot {
  readonly members: readonly WorkspaceMember[];
  readonly presence: readonly PresenceEntry[];
  readonly revoked: boolean;
  readonly revokeReason: string | null;
  readonly cursors: Readonly<Record<string, string>>;
  readonly segments: Readonly<Record<string, { offset: string; update: string }>>;
}

interface Partition {
  members: WorkspaceMember[];
  presence: PresenceEntry[];
  revoked: boolean;
  revokeReason: string | null;
  cursors: Record<string, string>;
  segments: Record<string, { offset: string; update: string }>;
}

function scopeKey(scope: CollabReplicaScope): string {
  return `${scope.organizationId}\0${scope.principalId}\0${scope.workspaceUid}`;
}

function emptyPartition(): Partition {
  return {
    members: [],
    presence: [],
    revoked: false,
    revokeReason: null,
    cursors: {},
    segments: {},
  };
}

export class CollabReplica {
  private readonly partitions = new Map<string, Partition>();

  snapshot(scope: CollabReplicaScope): CollabReplicaSnapshot | null {
    const partition = this.partitions.get(scopeKey(scope));
    if (!partition) return null;
    return {
      members: partition.members.slice(),
      presence: partition.presence.slice(),
      revoked: partition.revoked,
      revokeReason: partition.revokeReason,
      cursors: { ...partition.cursors },
      segments: { ...partition.segments },
    };
  }

  replaceMembers(scope: CollabReplicaScope, members: readonly WorkspaceMember[]): void {
    const partition = this.ensure(scope);
    if (partition.revoked) return;
    partition.members = members.map((member) => ({ ...member }));
  }

  apply(scope: CollabReplicaScope, event: CollabSubscriptionEvent): void {
    if (event.containerId !== scope.workspaceUid) return;
    const partition = this.ensure(scope);
    if (event.type === "revoked") {
      partition.revoked = true;
      partition.revokeReason = event.reason;
      partition.members = [];
      partition.presence = [];
      partition.segments = {};
      partition.cursors = {};
      return;
    }
    if (partition.revoked) return;
    if (event.type === "presence") {
      partition.presence = event.entries.slice();
      return;
    }
    if (event.type === "control") {
      partition.cursors[event.segment] = event.nextOffset;
      return;
    }
    partition.segments[event.segment] = { offset: event.offset, update: event.update };
    partition.cursors[event.segment] = event.offset;
  }

  /** Drops one Workspace for one Principal. */
  clear(scope: CollabReplicaScope): void {
    this.partitions.delete(scopeKey(scope));
  }

  /** Logout: every Workspace this Principal held on this organization. */
  clearPrincipal(organizationId: string, principalId: string): void {
    const prefix = `${organizationId}\0${principalId}\0`;
    const doomed: string[] = [];
    for (const key of this.partitions.keys()) {
      if (key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) this.partitions.delete(key);
  }

  private ensure(scope: CollabReplicaScope): Partition {
    const key = scopeKey(scope);
    const existing = this.partitions.get(key);
    if (existing) return existing;
    const created = emptyPartition();
    this.partitions.set(key, created);
    return created;
  }
}
