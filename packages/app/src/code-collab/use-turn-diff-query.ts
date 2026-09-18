import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { resolveTurnDiffQueryResult, type TurnDiffQueryResult } from "./resolve-turn-diff-query";

const TURN_DIFF_STALE_TIME_MS = 30_000;

export interface TurnDiffQueryInput {
  serverId: string;
  workspaceId: string;
  turnId: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
}

export type { TurnDiffQueryResult };

export interface TurnListQueryInput {
  serverId: string;
  workspaceId: string;
  agentId?: string;
  enabled?: boolean;
}

export { resolveTurnDiffQueryResult };

export function useTurnDiffQuery(input: TurnDiffQueryInput): TurnDiffQueryResult {
  const retainedPanelActive = useRetainedPanelActive();
  const enabled = (input.enabled ?? true) && retainedPanelActive;
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const capabilityPresent = useHostFeature(input.serverId, "codeCollabTurnDiff");
  const canFetch =
    Boolean(client) && isConnected && Boolean(input.workspaceId) && Boolean(input.turnId);
  const query = useFetchQuery({
    queryKey: [
      "codeCollabTurnDiff",
      input.serverId,
      input.workspaceId,
      input.turnId,
      input.ignoreWhitespace === true,
    ],
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const payload = await client.getCodeCollabTurnFiles({
        workspaceId: input.workspaceId,
        turnId: input.turnId,
        ignoreWhitespace: input.ignoreWhitespace,
      });
      return payload.files;
    },
    enabled: enabled && capabilityPresent && canFetch,
    staleTimeMs: TURN_DIFF_STALE_TIME_MS,
    dataShape: "list" as const,
  });

  return resolveTurnDiffQueryResult({
    enabled,
    capabilityPresent,
    canFetch,
    files: query.data,
    error: query.error,
    isFetching: query.isFetching,
  });
}

export function useTurnDiffListQuery(input: TurnListQueryInput) {
  const retainedPanelActive = useRetainedPanelActive();
  const enabled = (input.enabled ?? true) && retainedPanelActive;
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const capabilityPresent = useHostFeature(input.serverId, "codeCollabTurnDiff");
  const canFetch = Boolean(client) && isConnected && Boolean(input.workspaceId);
  return useFetchQuery({
    queryKey: ["codeCollabTurnList", input.serverId, input.workspaceId, input.agentId ?? ""],
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const payload = await client.listCodeCollabTurns({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      });
      return payload.turns;
    },
    enabled: enabled && capabilityPresent && canFetch,
    staleTimeMs: TURN_DIFF_STALE_TIME_MS,
    dataShape: "list" as const,
  });
}
