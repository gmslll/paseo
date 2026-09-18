import { useCollabWorkspaceAccess } from "./use-collab-workspace-access";

/** Whether this Workspace's turns should go through the plane (ADR-0035). */
export function useCollabPlaneTurn(
  serverId: string,
  workspaceId: string | null | undefined,
): boolean {
  return useCollabWorkspaceAccess(serverId, workspaceId).collaborationEnabled;
}
