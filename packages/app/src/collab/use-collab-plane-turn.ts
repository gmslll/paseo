import { useEffect, useState } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

/** Whether this Workspace's turns should go through the plane (ADR-0035). */
export function useCollabPlaneTurn(
  serverId: string,
  workspaceId: string | null | undefined,
): boolean {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const client = useHostRuntimeClient(serverId);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!supported || !client || !workspaceId) {
      setEnabled(false);
      return;
    }
    let cancelled = false;
    void client
      .listCollabMembers({ workspaceId })
      .then((payload) => {
        if (!cancelled) setEnabled(payload.collaborationEnabled === true);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, supported, workspaceId]);

  return supported === true && enabled;
}
