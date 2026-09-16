import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import {
  DaemonManifestSchema,
  LOCAL_PLANE_MANIFEST_FILE,
  LOCAL_PLANE_RUN_DIRECTORY,
  ProbeStateSchema,
  type DaemonManifest,
  type ProbeState,
} from "@getpaseo/protocol/local-planes";

// Reading the local planes from outside the daemon (ADR-0038). The CLI and the desktop app both
// need this, and neither should learn the layout of `run/` for itself. Nothing here reads
// `run/local-token`: the probe plane needs no credential, and a caller that wants the control plane
// asks for the token where it is used.

/** A manifest written by a daemon process that is no longer alive tells us nothing. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLiveDaemonManifest(paseoHome: string): DaemonManifest | null {
  try {
    const raw = readFileSync(
      path.join(paseoHome, LOCAL_PLANE_RUN_DIRECTORY, LOCAL_PLANE_MANIFEST_FILE),
      "utf8",
    );
    const parsed = DaemonManifestSchema.safeParse(JSON.parse(raw));
    return parsed.success && isProcessAlive(parsed.data.pid) ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseProbeState(status: number | undefined, body: string): ProbeState | null {
  if (status !== 200) return null;
  try {
    const parsed = ProbeStateSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads the probe plane's state, or null when the daemon has no reachable probe plane. */
export function readLocalProbeState(
  paseoHome: string,
  timeoutMs: number,
): Promise<ProbeState | null> {
  const probe = readLiveDaemonManifest(paseoHome)?.planes.probe;
  if (probe?.transport !== "unix") return Promise.resolve(null);
  return new Promise((resolve) => {
    const outgoing = request(
      { socketPath: probe.path, method: "GET", path: "/state" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve(parseProbeState(response.statusCode, body)));
      },
    );
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy());
    outgoing.on("error", () => resolve(null));
    outgoing.end();
  });
}

export function describeLocalPlanes(state: ProbeState | null): string {
  if (!state) return "unavailable";
  const listening = Object.entries(state.planes)
    .filter(([, plane]) => plane.status === "listening")
    .map(([name]) => name)
    .toSorted();
  return listening.length > 0 ? listening.join(", ") : "none";
}
