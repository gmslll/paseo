import type { WorkspaceMembershipPolicy } from "@getpaseo/protocol/enterprise-collaboration";
import { normalizeResourceGrants, type ResourceGrant } from "@getpaseo/protocol/messages";

/**
 * Plane membership grants name collaborative uids (`cws_`). Node authorization matches the local
 * Workspace id. Bind them here so a member can open the Workspace this node hosts (ADR-0033).
 */
export function bindCollabGrantsToLocalWorkspaces(
  grants: ResourceGrant[],
  memberships: readonly WorkspaceMembershipPolicy[] | null,
): ResourceGrant[] {
  if (memberships === null || memberships.length === 0) return grants;
  const localByUid = new Map(
    memberships.map((entry) => [entry.workspaceUid, entry.localWorkspaceId]),
  );
  let changed = false;
  const projected = grants.map((grant) => {
    if (grant.selector.kind !== "workspace") return grant;
    const workspaceIds = [...grant.selector.workspaceIds];
    const known = new Set(workspaceIds);
    for (const id of grant.selector.workspaceIds) {
      const localId = localByUid.get(id);
      if (!localId || known.has(localId)) continue;
      workspaceIds.push(localId);
      known.add(localId);
      changed = true;
    }
    if (workspaceIds.length === grant.selector.workspaceIds.length) return grant;
    return {
      action: grant.action,
      selector: { ...grant.selector, workspaceIds },
    };
  });
  return changed ? normalizeResourceGrants(projected) : grants;
}
