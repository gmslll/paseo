import { monitorEventLoopDelay } from "node:perf_hooks";
import type { ProbeState } from "@getpaseo/protocol/local-planes";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";

export interface ProbeStateSources {
  readonly serverId: string;
  readonly version: string;
  readonly startedAt: string;
  readonly desktopManaged: boolean;
  lifecycle(): string;
  planes(): ProbeState["planes"];
  websocketListen(): string | null;
  relay(): ProbeState["relay"];
  counts(): Promise<ProbeState["counts"]>;
  managedRuntimes(): Promise<readonly ManagedRuntimeStatus[]>;
  enterprise(): ProbeState["enterprise"];
  now?: () => number;
}

export interface ProbeStateCollector {
  read(): Promise<ProbeState>;
  stop(): void;
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.round(value / 1_000) / 1_000 : 0;
}

export function createProbeStateCollector(sources: ProbeStateSources): ProbeStateCollector {
  const now = sources.now ?? Date.now;
  const monitor = monitorEventLoopDelay({ resolution: 20 });
  monitor.enable();
  return {
    async read() {
      const [counts, managedRuntimes] = await Promise.all([
        sources.counts(),
        sources.managedRuntimes(),
      ]);
      return {
        pid: process.pid,
        serverId: sources.serverId,
        version: sources.version,
        startedAt: sources.startedAt,
        uptimeMs: Math.max(0, Math.round(now() - Date.parse(sources.startedAt))),
        lifecycle: sources.lifecycle(),
        desktopManaged: sources.desktopManaged,
        planes: sources.planes(),
        websocket: { listen: sources.websocketListen() },
        relay: sources.relay(),
        eventLoopDelayMs: {
          p50: nanosecondsToMilliseconds(monitor.percentile(50)),
          p99: nanosecondsToMilliseconds(monitor.percentile(99)),
          max: nanosecondsToMilliseconds(monitor.max),
        },
        counts,
        managedRuntimes: [...managedRuntimes],
        enterprise: sources.enterprise(),
      };
    },
    stop() {
      monitor.disable();
    },
  };
}
