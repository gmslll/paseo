import { useEffect, useState } from "react";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { useHostEnterpriseIdentitySnapshot, useHostRuntimeClient } from "@/runtime/host-runtime";
import { appCollabReplica } from "./replica-host";
import { useCollabPlaneSubscribe } from "./use-collab-plane-subscribe";
import { useCollabReplicaLifecycle } from "./use-collab-replica-lifecycle";
import { useCollabViewer } from "./use-collab-viewer";

export function useCollabRevoke(input: { serverId: string; workspaceId: string | undefined }): {
  revoked: boolean;
  reason: string | null;
} {
  const client = useHostRuntimeClient(input.serverId);
  const viewer = useCollabViewer(input.serverId);
  const identity = useHostEnterpriseIdentitySnapshot(input.serverId);
  const organizationId =
    identity?.state === "signed_in"
      ? (identity.scope?.organizationId ?? identity.projection?.organizationId)
      : undefined;
  const [revoked, setRevoked] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const enabled = viewer.supported && Boolean(client) && Boolean(input.workspaceId);
  useCollabReplicaLifecycle(input.serverId);
  useCollabPlaneSubscribe({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    onRevoked: (nextReason) => {
      setRevoked(true);
      setReason(nextReason);
    },
  });

  useEffect(() => {
    if (!enabled || !client || !input.workspaceId) {
      setRevoked(false);
      setReason(null);
      return;
    }
    const workspaceId = input.workspaceId;
    const daemon = client;
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const payload = await daemon.listCollabMembers({ workspaceId });
        if (cancelled) return;
        setRevoked(payload.revoked);
        setReason(payload.revokeReason ?? (payload.revoked ? "membership_removed" : null));
        if (
          payload.revoked &&
          payload.workspaceUid &&
          organizationId &&
          viewer.principalId !== "owner"
        ) {
          appCollabReplica.apply(
            {
              organizationId,
              principalId: viewer.principalId,
              workspaceUid: payload.workspaceUid,
            },
            {
              type: "revoked",
              containerId: payload.workspaceUid,
              reason: payload.revokeReason ?? "membership_removed",
            },
          );
        }
      } catch {
        if (!cancelled) {
          setRevoked(false);
          setReason(null);
        }
      }
    }

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, enabled, input.workspaceId, organizationId, viewer.principalId]);

  return { revoked, reason };
}
