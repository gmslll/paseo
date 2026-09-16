import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { createPaseoDaemon } from "@getpaseo/server";

import { connectToLocalControlPlane } from "./client.js";
import {
  describeLocalPlanes,
  findLocalControlPlane,
  readLocalProbeState,
} from "./local-control-plane.js";

describe.skipIf(process.platform === "win32")("CLI local control plane", () => {
  test("reaches a running daemon over its control plane and stops when the daemon does", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-cli-planes-"));
    const paseoHome = path.join(root, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-cli-static-"));
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
      },
      pino({ level: "silent" }),
    );
    const connect = () =>
      connectToLocalControlPlane({
        paseoHome,
        clientId: "cli-control-plane-test",
        timeout: 5_000,
      });
    let stopped = false;
    try {
      expect(findLocalControlPlane(paseoHome)).toBeNull();
      await daemon.start();

      const plane = findLocalControlPlane(paseoHome);
      expect(plane?.socketPath).toMatch(/control\.sock$/);
      const client = await connect();
      expect(client).not.toBeNull();
      expect(client?.getLastServerInfoMessage()?.features?.localPlanes).toBe(true);
      expect((await client!.fetchAgents()).entries).toEqual([]);
      await client?.close();

      const state = await readLocalProbeState(paseoHome, 1_500);
      expect(describeLocalPlanes(state)).toBe("control, probe");

      await writeFile(path.join(paseoHome, "run", "local-token"), "not-the-token\n");
      expect(await connect()).toBeNull();

      await daemon.stop();
      stopped = true;
      expect(findLocalControlPlane(paseoHome)).toBeNull();
      expect(await readLocalProbeState(paseoHome, 1_500)).toBeNull();
      expect(describeLocalPlanes(null)).toBe("unavailable");
      expect(await connect()).toBeNull();
    } finally {
      if (!stopped) await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 60_000);
});
