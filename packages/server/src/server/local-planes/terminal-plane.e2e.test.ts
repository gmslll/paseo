import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { TERMINAL_PLANE_JSON_OPCODE } from "@getpaseo/protocol/local-planes";
import { encodeLengthPrefixedFrame } from "@getpaseo/protocol/binary-frames/length-prefix";

import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  nextSessionLine,
  upgradeControlPlane,
  writeSessionLine,
} from "./control-plane-test-client.js";
import { resolveLocalPlanePaths } from "./plane-paths.js";

interface TerminalUpgrade {
  status: number;
  socket: Socket | null;
}

function openTerminalPlane(
  socketPath: string,
  headers: Record<string, string>,
): Promise<TerminalUpgrade> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method: "POST", path: "/v1/terminal", headers });
    outgoing.on("upgrade", (_response, socket) => resolve({ status: 101, socket }));
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, socket: null });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function writeTerminalJson(socket: Socket, value: unknown): void {
  const json = new TextEncoder().encode(JSON.stringify(value));
  socket.write(encodeLengthPrefixedFrame(Uint8Array.from([TERMINAL_PLANE_JSON_OPCODE, ...json])));
}

describe.skipIf(process.platform === "win32")("terminal plane end-to-end", () => {
  test("issues a one-use attach token and carries terminal RPCs for that Session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-terminal-e2e-"));
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
    let attachedSocket: Socket | null = null;
    try {
      await daemon.start();
      const localToken = (await readFile(paths.tokenPath, "utf8")).trim();

      const session = await upgradeControlPlane(paths.endpoints.control.path, {
        connection: "Upgrade",
        upgrade: "paseo-ndjson/1",
        "x-paseo-local-token": localToken,
      });
      expect(session.status).toBe(101);
      const serverInfo = nextSessionLine(
        session,
        (line) => line.message?.payload?.status === "server_info",
      );
      writeSessionLine(session, {
        type: "hello",
        clientId: "terminal-plane-e2e",
        clientType: "cli",
        protocolVersion: 1,
      });
      const features = (await serverInfo).message?.payload?.features as
        | Record<string, unknown>
        | undefined;
      expect(features?.terminalPlane).toBe(true);

      const issued = nextSessionLine(
        session,
        (line) => line.message?.type === "local_plane.attach_token.create.response",
      );
      writeSessionLine(session, {
        type: "session",
        message: {
          type: "local_plane.attach_token.create.request",
          requestId: "attach-1",
          plane: "terminal",
        },
      });
      const payload = (await issued).message?.payload as {
        requestId: string;
        token: string;
        expiresAt: string;
        endpoint: { transport: string; path: string; protocolVersion: number };
      };
      expect(payload.requestId).toBe("attach-1");
      expect(payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(payload.endpoint).toEqual({
        transport: "unix",
        path: paths.endpoints.terminal.path,
        protocolVersion: 1,
      });
      expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());

      const attachHeaders = {
        connection: "Upgrade",
        upgrade: "paseo-terminal/1",
        "x-paseo-local-token": localToken,
        "x-paseo-attach-token": payload.token,
      };
      const attached = await openTerminalPlane(paths.endpoints.terminal.path, attachHeaders);
      expect(attached.status).toBe(101);
      attachedSocket = attached.socket;
      if (!attachedSocket) throw new Error("terminal plane refused the upgrade");

      // The plane carries terminal RPCs only, and the Session answers on its own channel. Writing
      // the refused request first makes the assertion deterministic: had it been handled, its
      // response would arrive before the terminal one.
      const answered = nextSessionLine(
        session,
        (line) =>
          line.message?.type === "fetch_agents_response" ||
          line.message?.type === "list_terminals_response",
      );
      writeTerminalJson(attachedSocket, { type: "fetch_agents_request", requestId: "plane-1" });
      writeTerminalJson(attachedSocket, { type: "list_terminals_request", requestId: "plane-2" });
      const answer = await answered;
      expect(answer.message?.type).toBe("list_terminals_response");
      expect(answer.message?.payload).toMatchObject({ requestId: "plane-2", terminals: [] });

      // The token is spent, so replaying it buys nothing.
      const replay = await openTerminalPlane(paths.endpoints.terminal.path, attachHeaders);
      expect(replay.status).toBe(401);

      session.socket?.destroy();
    } finally {
      attachedSocket?.destroy();
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 60_000);
});
