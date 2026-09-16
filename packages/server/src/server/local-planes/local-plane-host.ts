import type { Logger } from "pino";
import type { DaemonManifest, ProbeState } from "@getpaseo/protocol/local-planes";
import type { LocalPlaneAttachEndpoint } from "./local-plane-access.js";

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
import {
  startDataPlane,
  type DataPlaneAdmission,
  type DataPlaneServer,
} from "./data-plane-server.js";
import {
  startTerminalPlane,
  type TerminalPlaneAdmission,
  type TerminalPlaneServer,
} from "./terminal-plane-server.js";
import { createProbeStateCollector, type ProbeStateSources } from "./probe-state.js";

// Starts the local planes after the daemon's other listeners are ready and writes run/daemon.json
// last (ADR-0038). The manifest lists only the planes that are actually up.

const PLANE_PROTOCOL_VERSION = 1;

export interface LocalPlaneHost {
  readonly paths: LocalPlanePaths;
  readonly token: string;
  /** True while the control plane accepts Sessions. */
  readonly controlAvailable: boolean;
  /** Where terminal channels attach while the plane accepts them, else null. */
  readonly terminalEndpoint: LocalPlaneAttachEndpoint | null;
  /** Where data channels attach while the plane accepts them, else null. */
  readonly dataEndpoint: LocalPlaneAttachEndpoint | null;
  stop(): Promise<void>;
}

export interface StartLocalPlanesInput {
  paseoHome: string;
  sources: Omit<ProbeStateSources, "planes" | "lifecycle">;
  /** Admission for control plane Sessions. Without it only the probe plane starts. */
  control?: ControlPlaneAdmission;
  /** Admission for terminal plane channels. Without it the terminal plane stays down. */
  terminal?: TerminalPlaneAdmission;
  /** Admission for data plane channels. Without it the data plane stays down. */
  data?: DataPlaneAdmission;
  logger: Logger;
  platform?: NodeJS.Platform;
}

interface RunningPlanes {
  probe: ProbePlaneServer | null;
  control: ControlPlaneServer | null;
  terminal: TerminalPlaneServer | null;
  data: DataPlaneServer | null;
}

function planeStatus(
  server: ProbePlaneServer | ControlPlaneServer | TerminalPlaneServer | DataPlaneServer | null,
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
  if (running.terminal) {
    planes.terminal = { ...running.terminal.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
  }
  if (running.data) {
    planes.data = { ...running.data.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
  }
  return planes;
}

async function closePlanes(running: RunningPlanes): Promise<void> {
  await running.data?.close();
  await running.terminal?.close();
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
  const running: RunningPlanes = { probe: null, control: null, terminal: null, data: null };
  let lifecycle = "running";
  const collector = createProbeStateCollector({
    ...input.sources,
    lifecycle: () => lifecycle,
    planes: () => ({
      probe: planeStatus(running.probe),
      control: planeStatus(running.control),
      terminal: planeStatus(running.terminal),
      data: planeStatus(running.data),
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
    if (input.terminal) {
      running.terminal = await startTerminalPlane({
        endpoint: paths.endpoints.terminal,
        token,
        admission: input.terminal,
        logger: input.logger,
      });
    }
    if (input.data) {
      running.data = await startDataPlane({
        endpoint: paths.endpoints.data,
        token,
        admission: input.data,
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
    get terminalEndpoint() {
      if (!running.terminal || stopping !== null) return null;
      return { ...running.terminal.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
    },
    get dataEndpoint() {
      if (!running.data || stopping !== null) return null;
      return { ...running.data.endpoint, protocolVersion: PLANE_PROTOCOL_VERSION };
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
