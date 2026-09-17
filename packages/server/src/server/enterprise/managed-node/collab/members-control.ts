import type {
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

export const COLLAB_MEMBERS_UNAVAILABLE = "Workspace sharing is unavailable on this daemon";

export interface CollabMembersSnapshot {
  readonly workspaceUid: string | null;
  readonly viewerRole: WorkspaceMemberRole | null;
  readonly revoked: boolean;
  readonly members: readonly WorkspaceMember[];
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
}

export interface CollabMembersControl {
  list(workspaceId: string, viewerPrincipalId: string | null): CollabMembersSnapshot;
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
}

export function createCollabMembersControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  mutator?: CollabMembersMutator;
}): CollabMembersControl {
  function lookup(workspaceId: string) {
    const catalog = input.catalog.current();
    return catalog?.workspaces.find((entry) => entry.localWorkspaceId === workspaceId) ?? null;
  }

  return {
    list(workspaceId, viewerPrincipalId) {
      const entry = lookup(workspaceId);
      if (!entry) {
        return { workspaceUid: null, viewerRole: null, revoked: false, members: [] };
      }
      const viewerRole =
        entry.members.find((member) => member.principalId === viewerPrincipalId)?.role ?? null;
      return {
        workspaceUid: entry.workspaceUid,
        viewerRole,
        revoked: entry.state === "revoked",
        members: entry.members,
      };
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
  };
}
