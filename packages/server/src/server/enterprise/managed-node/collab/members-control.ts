import { ManagedPrincipalIdSchema } from "@getpaseo/protocol/messages";
import type {
  WorkspaceCatalogEntry,
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

export const COLLAB_MEMBERS_UNAVAILABLE = "Workspace sharing is unavailable on this daemon";
export const COLLAB_ENABLE_DENIED = "only the workspace owner can enable collaboration";

function resolveMemberRevoke(
  entry: WorkspaceCatalogEntry,
  viewerPrincipalId: string | null,
): { revoked: boolean; reason: string | null } {
  const isOwner = viewerPrincipalId === entry.ownerPrincipalId;
  const isMember =
    viewerPrincipalId !== null &&
    entry.members.some((member) => member.principalId === viewerPrincipalId);
  if (entry.state === "revoked") {
    return { revoked: true, reason: "membership_removed" };
  }
  if (entry.state === "remote_missing" && !isOwner) {
    return { revoked: true, reason: "remote_missing" };
  }
  if (viewerPrincipalId && viewerPrincipalId !== "owner" && !isOwner && !isMember) {
    return { revoked: true, reason: "membership_removed" };
  }
  return { revoked: false, reason: null };
}

export interface CollabMembersSnapshot {
  readonly workspaceUid: string | null;
  readonly viewerRole: WorkspaceMemberRole | null;
  readonly revoked: boolean;
  readonly revokeReason: string | null;
  readonly members: readonly WorkspaceMember[];
  readonly collaborationEnabled: boolean;
  readonly canEnable: boolean;
}

export interface CollabMembersMutator {
  setMember(input: {
    workspaceUid: string;
    actorPrincipalId: string;
    principalId: string;
    role: Exclude<WorkspaceMemberRole, "owner">;
  }): Promise<readonly WorkspaceMember[]>;
  removeMember(input: {
    workspaceUid: string;
    actorPrincipalId: string;
    principalId: string;
  }): Promise<readonly WorkspaceMember[]>;
  enableWorkspace(input: {
    localWorkspaceId: string;
    actorPrincipalId: string;
  }): Promise<{ workspaceUid: string; members: readonly WorkspaceMember[] }>;
}

export interface CollabMembersControl {
  list(
    workspaceId: string,
    viewerPrincipalId: string | null,
    localOwnerPrincipalId?: string | null,
  ): CollabMembersSnapshot;
  set(
    workspaceId: string,
    actorPrincipalId: string,
    principalId: string,
    role: Exclude<WorkspaceMemberRole, "owner">,
  ): Promise<readonly WorkspaceMember[]>;
  remove(
    workspaceId: string,
    actorPrincipalId: string,
    principalId: string,
  ): Promise<readonly WorkspaceMember[]>;
  enable(
    workspaceId: string,
    actorPrincipalId: string,
    localOwnerPrincipalId: string | null,
  ): Promise<CollabMembersSnapshot>;
}

export function createCollabMembersControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  mutator?: CollabMembersMutator;
}): CollabMembersControl {
  function lookup(workspaceId: string) {
    const catalog = input.catalog.current();
    return catalog?.workspaces.find((entry) => entry.localWorkspaceId === workspaceId) ?? null;
  }

  function snapshotFor(
    workspaceId: string,
    viewerPrincipalId: string | null,
    localOwnerPrincipalId: string | null,
  ): CollabMembersSnapshot {
    const entry = lookup(workspaceId);
    const ownerPrincipalId = entry?.ownerPrincipalId ?? localOwnerPrincipalId;
    const isOwner =
      viewerPrincipalId !== null &&
      ownerPrincipalId !== null &&
      viewerPrincipalId === ownerPrincipalId;
    const isPrincipal =
      viewerPrincipalId !== null && ManagedPrincipalIdSchema.safeParse(viewerPrincipalId).success;
    if (!entry) {
      return {
        workspaceUid: null,
        viewerRole: null,
        revoked: false,
        revokeReason: null,
        members: [],
        collaborationEnabled: false,
        canEnable: isOwner && isPrincipal,
      };
    }
    const viewerRole =
      entry.members.find((member) => member.principalId === viewerPrincipalId)?.role ?? null;
    const revoke = resolveMemberRevoke(entry, viewerPrincipalId);
    const collaborationEnabled = entry.state === "active";
    return {
      workspaceUid: entry.workspaceUid,
      viewerRole,
      revoked: revoke.revoked,
      revokeReason: revoke.reason,
      members: entry.members,
      collaborationEnabled,
      canEnable: !collaborationEnabled && !revoke.revoked && isOwner && isPrincipal,
    };
  }

  return {
    list(workspaceId, viewerPrincipalId, localOwnerPrincipalId = null) {
      return snapshotFor(workspaceId, viewerPrincipalId, localOwnerPrincipalId);
    },
    async set(workspaceId, actorPrincipalId, principalId, role) {
      const entry = lookup(workspaceId);
      if (!entry) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      if (!input.mutator) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      return await input.mutator.setMember({
        workspaceUid: entry.workspaceUid,
        actorPrincipalId,
        principalId,
        role,
      });
    },
    async remove(workspaceId, actorPrincipalId, principalId) {
      const entry = lookup(workspaceId);
      if (!entry) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      if (!input.mutator) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      return await input.mutator.removeMember({
        workspaceUid: entry.workspaceUid,
        actorPrincipalId,
        principalId,
      });
    },
    async enable(workspaceId, actorPrincipalId, localOwnerPrincipalId) {
      const current = snapshotFor(workspaceId, actorPrincipalId, localOwnerPrincipalId);
      const ownerPrincipalId =
        current.members.find((member) => member.role === "owner")?.principalId ??
        localOwnerPrincipalId;
      if (current.collaborationEnabled) {
        if (actorPrincipalId !== ownerPrincipalId) throw new Error(COLLAB_ENABLE_DENIED);
        return current;
      }
      if (!current.canEnable) throw new Error(COLLAB_ENABLE_DENIED);
      if (!input.mutator) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      const enabled = await input.mutator.enableWorkspace({
        localWorkspaceId: workspaceId,
        actorPrincipalId,
      });
      return {
        workspaceUid: enabled.workspaceUid,
        viewerRole: "owner",
        revoked: false,
        revokeReason: null,
        members: enabled.members,
        collaborationEnabled: true,
        canEnable: false,
      };
    },
  };
}
