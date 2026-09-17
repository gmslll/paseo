import { useEffect, useState } from "react";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useCollabViewer } from "./use-collab-viewer";

export function useCollabRevoke(input: { serverId: string; workspaceId: string | undefined }): {
  revoked: boolean;
  reason: string | null;
} {
  const client = useHostRuntimeClient(input.serverId);
  const viewer = useCollabViewer(input.serverId);
  const [revoked, setRevoked] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const enabled = viewer.supported && Boolean(client) && Boolean(input.workspaceId);

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
  }, [client, enabled, input.workspaceId]);

  return { revoked, reason };
}
