import { useEffect, useState } from "react";
import type { StreamItem } from "@/types/stream";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { hydrateCollabSessionDocument } from "./hydrate-collab-session";
import { useCollabPlaneTurn } from "./use-collab-plane-turn";

const TIMELINE_POLL_MS = 1_000;

/**
 * Reads the session CRDT through the node replica (ADR-0031). The result replaces the rendered
 * stream when a page has arrived; it does not write the session-store reducer.
 */
export function useCollabTimeline(input: {
  serverId: string;
  workspaceId: string | undefined;
  agentId: string;
  provider?: string;
}): { items: StreamItem[] | null; head: StreamItem[] | null } {
  const client = useHostRuntimeClient(input.serverId);
  const plane = useCollabPlaneTurn(input.serverId, input.workspaceId);
  const [items, setItems] = useState<StreamItem[] | null>(null);
  const [head, setHead] = useState<StreamItem[] | null>(null);
  const enabled = plane && Boolean(client) && Boolean(input.workspaceId);

  useEffect(() => {
    if (!enabled || !client || !input.workspaceId) {
      setItems(null);
      setHead(null);
      return;
    }
    const workspaceId = input.workspaceId;
    const daemon = client;
    const agentId = input.agentId;
    const provider = input.provider ?? "collab";
    let cancelled = false;
    let seen = false;

    async function refresh(): Promise<void> {
      try {
        const payload = await daemon.getCollabTimeline({ workspaceId, agentId });
        if (cancelled) return;
        const hydrated = hydrateCollabSessionDocument({
          epoch: payload.epoch,
          rows: payload.rows,
          stream: payload.stream,
          provider,
        });
        if (hydrated.items.length > 0 || hydrated.head.length > 0 || seen) {
          seen = true;
          setItems(hydrated.items);
          setHead(hydrated.head);
        }
      } catch {
        if (!cancelled && !seen) {
          setItems(null);
          setHead(null);
        }
      }
    }

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, TIMELINE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, enabled, input.agentId, input.provider, input.workspaceId]);

  return { items, head };
}
