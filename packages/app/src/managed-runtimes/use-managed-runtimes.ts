import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Runtime status changes only when an install runs or the pinned policy changes.
const MANAGED_RUNTIMES_STALE_TIME_MS = 30_000;

export function managedRuntimesQueryKey(serverId: string) {
  return ["managedRuntimes", serverId] as const;
}

export type ManagedRuntimesView =
  | { kind: "unsupported" }
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; runtimes: readonly ManagedRuntimeStatus[] };

export type ManagedRuntimeInstallState =
  | { kind: "idle" }
  | { kind: "installing"; runtimeName: string }
  | { kind: "failed"; runtimeName: string; message: string };

export function useManagedRuntimes(serverId: string): {
  view: ManagedRuntimesView;
  installState: ManagedRuntimeInstallState;
  install: (runtimeName: string) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "managedRuntimes");
  const queryKey = useMemo(() => managedRuntimesQueryKey(serverId), [serverId]);
  const [installState, setInstallState] = useState<ManagedRuntimeInstallState>({ kind: "idle" });

  const query = useFetchQuery({
    queryKey,
    queryFn: async () => {
      if (!client) throw new Error("Host client unavailable");
      return (await client.getManagedRuntimeStatus()).runtimes;
    },
    enabled: Boolean(client && isConnected && supported),
    refetchOnWindowFocus: false,
    // A value, not a list: keeping the previous host's runtimes while switching hosts would mislabel them.
    dataShape: "value",
    staleTimeMs: MANAGED_RUNTIMES_STALE_TIME_MS,
  });

  const install = useCallback(
    async (runtimeName: string) => {
      if (!client) return;
      setInstallState({ kind: "installing", runtimeName });
      try {
        await client.installManagedRuntime(runtimeName);
        setInstallState({ kind: "idle" });
      } catch (error) {
        setInstallState({
          kind: "failed",
          runtimeName,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await queryClient.invalidateQueries({ queryKey });
      }
    },
    [client, queryClient, queryKey],
  );

  const view = useMemo<ManagedRuntimesView>(() => {
    if (!supported) return { kind: "unsupported" };
    if (!client || !isConnected) return { kind: "disconnected" };
    if (query.data) return { kind: "ready", runtimes: query.data };
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [client, isConnected, query.data, query.error, query.isError, supported]);

  return { view, installState, install };
}
