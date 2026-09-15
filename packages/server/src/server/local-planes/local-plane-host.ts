import type { Logger } from "pino";
import type { ProbeState } from "@getpaseo/protocol/local-planes";

import { removeDaemonManifest, writeDaemonManifest } from "./daemon-manifest.js";
import { issueLocalToken, removeLocalToken } from "./local-token.js";
import {
  ensurePrivateDirectory,
  resolveLocalPlanePaths,
  type LocalPlanePaths,
} from "./plane-paths.js";
import { startProbePlane, type ProbePlaneServer } from "./probe-plane-server.js";
import { createProbeStateCollector, type ProbeStateSources } from "./probe-state.js";

// Starts the local planes after the daemon's other listeners are ready and writes run/daemon.json
// last (ADR-0038). Only the probe plane exists so far; the manifest lists what is actually up.

const PROBE_PROTOCOL_VERSION = 1;

export interface LocalPlaneHost {
  readonly paths: LocalPlanePaths;
  readonly token: string;
  stop(): Promise<void>;
}

export interface StartLocalPlanesInput {
  paseoHome: string;
  sources: Omit<ProbeStateSources, "planes" | "lifecycle">;
  logger: Logger;
  platform?: NodeJS.Platform;
}

function unavailablePlane(): ProbeState["planes"][string] {
  return { status: "unavailable", path: null };
}

export async function startLocalPlanes(input: StartLocalPlanesInput): Promise<LocalPlaneHost> {
  const paths = resolveLocalPlanePaths({ paseoHome: input.paseoHome, platform: input.platform });
  await ensurePrivateDirectory(paths.runDirectory);
  if (paths.socketDirectory && paths.socketDirectory !== paths.runDirectory) {
    await ensurePrivateDirectory(paths.socketDirectory);
  }
  const token = await issueLocalToken(paths.tokenPath);
  let lifecycle = "running";
  const collector = createProbeStateCollector({
    ...input.sources,
    lifecycle: () => lifecycle,
    planes: () => ({
      probe: { status: "listening", path: paths.endpoints.probe.path },
      control: unavailablePlane(),
      terminal: unavailablePlane(),
      data: unavailablePlane(),
    }),
  });

  let probe: ProbePlaneServer | null = null;
  try {
    probe = await startProbePlane({
      endpoint: paths.endpoints.probe,
      readState: () => collector.read(),
      logger: input.logger,
    });
    await writeDaemonManifest(paths.manifestPath, {
      schemaVersion: 1,
      pid: process.pid,
      // A daemon worker runs under a supervisor over IPC, as daemon-worker.ts assumes.
      supervisorPid: typeof process.send === "function" ? process.ppid : null,
      serverId: input.sources.serverId,
      version: input.sources.version,
      startedAt: input.sources.startedAt,
      listen: input.sources.websocketListen(),
      desktopManaged: input.sources.desktopManaged,
      planes: {
        probe: { ...paths.endpoints.probe, protocolVersion: PROBE_PROTOCOL_VERSION },
      },
    });
  } catch (error) {
    collector.stop();
    await probe?.close();
    await removeLocalToken(paths.tokenPath, token);
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const openProbe = probe;
  return {
    paths,
    token,
    stop() {
      stopping ??= (async () => {
        lifecycle = "stopping";
        await removeDaemonManifest(paths.manifestPath, process.pid);
        await openProbe.close();
        collector.stop();
        await removeLocalToken(paths.tokenPath, token);
      })();
      return stopping;
    },
  };
}
