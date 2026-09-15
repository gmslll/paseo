import type { Logger } from "pino";
import type { DaemonManifest, ProbeState } from "@getpaseo/protocol/local-planes";

import {
  startControlPlane,
  type ControlPlaneAdmission,
  type ControlPlaneServer,
} from "./control-plane-server.js";
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
// last (ADR-0038). The manifest lists only the planes that are actually up.

const PLANE_PROTOCOL_VERSION = 1;

export interface LocalPlaneHost {
  readonly paths: LocalPlanePaths;
  readonly token: string;
  /** True while the control plane accepts Sessions. */
  readonly controlAvailable: boolean;
  stop(): Promise<void>;
}

export interface StartLocalPlanesInput {
  paseoHome: string;
  sources: Omit<ProbeStateSources, "planes" | "lifecycle">;
  /** Admission for control plane Sessions. Without it only the probe plane starts. */
  control?: ControlPlaneAdmission;
  logger: Logger;
  platform?: NodeJS.Platform;
}

interface RunningPlanes {
  probe: ProbePlaneServer | null;
  control: ControlPlaneServer | null;
}

function planeStatus(
  server: ProbePlaneServer | ControlPlaneServer | null,
): ProbeState["planes"][string] {
  return server
    ? { status: "listening", path: server.endpoint.path }
    : { status: "unavailable", path: null };
}

function manifestPlanes(running: RunningPlanes): DaemonManifest["planes"] {
  const planes: DaemonManifest["planes"] = {};
  if (running.probe) {
    planes.probe = { ...running.probe.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
  }
  if (running.control) {
    planes.control = { ...running.control.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
  }
  return planes;
}

async function closePlanes(running: RunningPlanes): Promise<void> {
  await running.control?.close();
  await running.probe?.close();
}

export async function startLocalPlanes(input: StartLocalPlanesInput): Promise<LocalPlaneHost> {
  const paths = resolveLocalPlanePaths({ paseoHome: input.paseoHome, platform: input.platform });
  await ensurePrivateDirectory(paths.runDirectory);
  if (paths.socketDirectory && paths.socketDirectory !== paths.runDirectory) {
    await ensurePrivateDirectory(paths.socketDirectory);
  }
  const token = await issueLocalToken(paths.tokenPath);
  const running: RunningPlanes = { probe: null, control: null };
  let lifecycle = "running";
  const collector = createProbeStateCollector({
    ...input.sources,
    lifecycle: () => lifecycle,
    planes: () => ({
      probe: planeStatus(running.probe),
      control: planeStatus(running.control),
      terminal: planeStatus(null),
      data: planeStatus(null),
    }),
  });

  try {
    running.probe = await startProbePlane({
      endpoint: paths.endpoints.probe,
      readState: () => collector.read(),
      logger: input.logger,
    });
    if (input.control) {
      running.control = await startControlPlane({
        endpoint: paths.endpoints.control,
        token,
        admission: input.control,
        logger: input.logger,
      });
    }
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
      planes: manifestPlanes(running),
    });
  } catch (error) {
    await closePlanes(running);
    collector.stop();
    await removeLocalToken(paths.tokenPath, token);
    throw error;
  }

  let stopping: Promise<void> | null = null;
  return {
    paths,
    token,
    get controlAvailable() {
      return running.control !== null && stopping === null;
    },
    stop() {
      stopping ??= (async () => {
        lifecycle = "stopping";
        await removeDaemonManifest(paths.manifestPath, process.pid);
        await closePlanes(running);
        collector.stop();
        await removeLocalToken(paths.tokenPath, token);
      })();
      return stopping;
    },
  };
}
