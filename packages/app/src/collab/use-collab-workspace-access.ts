import { useEffect, useState } from "react";
import type { WorkspaceMemberRole } from "@getpaseo/protocol/enterprise-collaboration";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export interface CollabWorkspaceAccess {
  readonly supported: boolean;
  readonly collaborationEnabled: boolean;
  readonly viewerRole: WorkspaceMemberRole | null;
  readonly revoked: boolean;
  readonly workspaceUid: string | null;
  readonly readOnly: boolean;
}

const EMPTY: CollabWorkspaceAccess = {
  supported: false,
  collaborationEnabled: false,
  viewerRole: null,
  revoked: false,
  workspaceUid: null,
  readOnly: false,
};

/** Owner/editor write; a viewer or a revoked member cannot send. Collab off leaves the composer as it is. */
export function useCollabWorkspaceAccess(
  serverId: string,
  workspaceId: string | null | undefined,
): CollabWorkspaceAccess {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const client = useHostRuntimeClient(serverId);
  const [access, setAccess] = useState<CollabWorkspaceAccess>(EMPTY);

  useEffect(() => {
    if (!supported || !client || !workspaceId) {
      setAccess(EMPTY);
      return;
    }
    let cancelled = false;
    void client
      .listCollabMembers({ workspaceId })
      .then((payload) => {
        if (cancelled) return undefined;
        const collaborationEnabled = payload.collaborationEnabled === true;
        const revoked = payload.revoked === true;
        const viewerRole = payload.viewerRole;
        setAccess({
          supported: true,
          collaborationEnabled,
          viewerRole,
          revoked,
          workspaceUid: payload.workspaceUid,
          readOnly: collaborationEnabled && (revoked || viewerRole === "viewer"),
        });
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setAccess({ ...EMPTY, supported: true });
      });
    return () => {
      cancelled = true;
    };
  }, [client, supported, workspaceId]);

  return supported === true ? access : EMPTY;
}
