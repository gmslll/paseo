import { request } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { ProbeStateSchema } from "@getpaseo/protocol/local-planes";

import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { readDaemonManifest } from "./daemon-manifest.js";
import { resolveLocalPlanePaths } from "./plane-paths.js";

function probeGet(
  socketPath: string,
  requestPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method: "GET", path: requestPath }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function modeOf(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("local planes end-to-end", () => {
  test("publishes an owner-only probe plane and removes it when the daemon stops", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-planes-"));
    const paseoHome = path.join(root, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
      },
      pino({ level: "silent" }),
    );
    const paths = resolveLocalPlanePaths({ paseoHome });
    let stopped = false;
    try {
      await daemon.start();

      const manifest = await readDaemonManifest(paths.manifestPath);
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        pid: process.pid,
        planes: {
          probe: { transport: "unix", path: paths.endpoints.probe.path, protocolVersion: 1 },
        },
      });
      expect(Object.keys(manifest?.planes ?? {})).toEqual(["probe"]);
      expect(await modeOf(paths.runDirectory)).toBe(0o700);
      expect(await modeOf(paths.tokenPath)).toBe(0o600);
      expect(await modeOf(paths.endpoints.probe.path)).toBe(0o600);
      const token = (await readFile(paths.tokenPath, "utf8")).trim();

      expect(await probeGet(paths.endpoints.probe.path, "/healthz")).toEqual({
        status: 200,
        body: JSON.stringify({ status: "ok" }),
      });
      const stateResponse = await probeGet(paths.endpoints.probe.path, "/state");
      expect(stateResponse.status).toBe(200);
      const state = ProbeStateSchema.parse(JSON.parse(stateResponse.body));
      expect(state).toMatchObject({
        pid: process.pid,
        serverId: manifest?.serverId,
        lifecycle: "running",
        relay: { enabled: false, connected: false },
        counts: { agents: 0, terminals: 0 },
        enterprise: null,
        planes: { probe: { status: "listening" }, control: { status: "unavailable" } },
      });
      expect(state.websocket.listen).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(stateResponse.body).not.toContain(token);

      await daemon.stop();
      stopped = true;

      expect(await readDaemonManifest(paths.manifestPath)).toBeNull();
      await expect(stat(paths.tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(paths.endpoints.probe.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!stopped) await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 60_000);
});
