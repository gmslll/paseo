import { useEffect, useState } from "react";
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  type PresenceEntry,
} from "@getpaseo/protocol/enterprise-collaboration";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getOrCreateClientId } from "@/utils/client-id";
import { useCollabViewer } from "./use-collab-viewer";

const MANAGED_PRINCIPAL = /^(usr|svc)_[0-9a-f]{16}$/;

export function useCollabPresence(input: {
  serverId: string;
  workspaceId: string | undefined;
  focusAgentId: string | null;
  displayName?: string;
  enabled?: boolean;
}): { entries: readonly PresenceEntry[]; now: number } {
  const client = useHostRuntimeClient(input.serverId);
  const viewer = useCollabViewer(input.serverId);
  const [entries, setEntries] = useState<readonly PresenceEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const enabled =
    (input.enabled ?? true) &&
    viewer.supported &&
    Boolean(client) &&
    Boolean(input.workspaceId) &&
    MANAGED_PRINCIPAL.test(viewer.principalId);

  useEffect(() => {
    if (!enabled || !client || !input.workspaceId) {
      setEntries([]);
      return;
    }
    const workspaceId = input.workspaceId;
    const daemon = client;
    let cancelled = false;

    async function beat(): Promise<void> {
      const clientId = await getOrCreateClientId();
      if (cancelled) return;
      try {
        const payload = await daemon.beatCollabPresence({
          workspaceId,
          clientId,
          focusAgentId: input.focusAgentId,
          ...(input.displayName ? { displayName: input.displayName } : {}),
        });
        if (cancelled) return;
        const host = payload.hostNode
          ? [
              {
                kind: "node" as const,
                nodeId: payload.hostNode.nodeId,
                heartbeatAt: payload.hostNode.heartbeatAt,
              },
            ]
          : [];
        setEntries([...payload.entries, ...host]);
        setNow(Date.now());
      } catch {
        if (!cancelled) setEntries([]);
      }
    }

    void beat();
    const timer = setInterval(() => {
      void beat();
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, enabled, input.displayName, input.focusAgentId, input.workspaceId]);

  return { entries, now };
}
