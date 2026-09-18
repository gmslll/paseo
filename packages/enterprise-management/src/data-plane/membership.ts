import {
  WORKSPACE_MEMBER_ROLE_ACTIONS,
  type WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import { normalizeResourceGrants, type ResourceGrant } from "@getpaseo/protocol/messages";

// Collaborative Workspace membership (ADR-0033). A Workspace keeps exactly one owner and adds
// members with one role each. Membership is projected onto the frozen V1 actions with the existing
// `{ kind: "workspace", workspaceIds }` selector: ADR-0008 froze the action enum and the selector
// kinds, so collaboration adds neither.

export const MEMBERSHIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS collab_workspaces (
  workspace_uid TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  local_workspace_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  collaboration_enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, local_workspace_id)
);
CREATE TABLE IF NOT EXISTS collab_members (
  workspace_uid TEXT NOT NULL REFERENCES collab_workspaces(workspace_uid) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_uid, principal_id)
);
CREATE INDEX IF NOT EXISTS collab_members_by_principal
  ON collab_members (principal_id);
`;

export interface CollabWorkspaceRecord {
  workspaceUid: string;
  localWorkspaceId: string;
  ownerPrincipalId: string;
  collaborationEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CollabMember {
  principalId: string;
  role: WorkspaceMemberRole;
}

/**
 * Rewrites one Workspace's contribution to a Principal's grants. Existing entries for that
 * Workspace are dropped first, so demoting a member never leaves the wider role behind.
 *
 * Actions are merged by widening `workspaceIds` rather than appending another entry per Workspace.
 * Both authorization sites evaluate with `workspaceIds.includes(...)`, so the two shapes decide
 * identically, but merging keeps the stored array from growing with every Workspace a Principal
 * joins.
 */
export function projectMembershipGrants(input: {
  grants: readonly ResourceGrant[];
  workspaceUid: string;
  role: WorkspaceMemberRole | null;
}): ResourceGrant[] {
  const withoutWorkspace = input.grants.map((grant) => {
    if (grant.selector.kind !== "workspace") return grant;
    const workspaceIds = grant.selector.workspaceIds.filter((uid) => uid !== input.workspaceUid);
    return { action: grant.action, selector: { ...grant.selector, workspaceIds } };
  });
  const kept = withoutWorkspace.filter(
    (grant) => grant.selector.kind !== "workspace" || grant.selector.workspaceIds.length > 0,
  ) as ResourceGrant[];
  if (!input.role) return normalizeResourceGrants(kept);

  const granted = new Set<string>(WORKSPACE_MEMBER_ROLE_ACTIONS[input.role]);
  const widened = kept.map((grant) => {
    if (grant.selector.kind !== "workspace" || !granted.has(grant.action)) return grant;
    granted.delete(grant.action);
    return {
      action: grant.action,
      selector: {
        ...grant.selector,
        workspaceIds: [...grant.selector.workspaceIds, input.workspaceUid],
      },
    } as ResourceGrant;
  });
  const added = [...granted].map(
    (action) =>
      ({
        action,
        selector: { kind: "workspace" as const, workspaceIds: [input.workspaceUid] },
      }) as ResourceGrant,
  );
  return normalizeResourceGrants([...widened, ...added]);
}
