import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";
import {
  DataPlaneFrameKind,
  decodeDataPlaneFrame,
  encodeDataPlaneFrame,
  type DataPlaneFrame,
} from "@getpaseo/protocol/binary-frames/data-plane";
import {
  LengthPrefixedFrameDecoder,
  encodeLengthPrefixedFrame,
} from "@getpaseo/protocol/binary-frames/length-prefix";

import { createPaseoDaemon } from "../bootstrap.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { DataPlaneDocHandler } from "./data-plane-access.js";
import {
  nextSessionLine,
  upgradeControlPlane,
  writeSessionLine,
} from "./control-plane-test-client.js";
import { resolveLocalPlanePaths } from "./plane-paths.js";

interface OpenedDocuments {
  sessionId: string;
  principalId: string;
}

function openDataUpgrade(
  socketPath: string,
  headers: Record<string, string>,
): Promise<{ status: number; socket: Socket | null }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method: "POST", path: "/v1/data", headers });
    outgoing.on("upgrade", (_response, socket) => resolve({ status: 101, socket }));
    outgoing.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, socket: null });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function nextDataFrame(socket: Socket): Promise<DataPlaneFrame> {
  return new Promise((resolve, reject) => {
    const decoder = new LengthPrefixedFrameDecoder({ maxFrameBytes: 1_048_576 });
    const onData = (chunk: Buffer) => {
      for (const bytes of decoder.push(chunk)) {
        const frame = decodeDataPlaneFrame(bytes);
        if (frame) {
          socket.off("data", onData);
          resolve(frame);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("data plane end-to-end", () => {
  test("attaches a document channel to the Session its token names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-data-e2e-"));
    const paseoHome = path.join(root, ".paseo");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const opened: OpenedDocuments[] = [];
    // Echoes each frame back as an Ack, which is enough to prove the whole path carries documents.
    const dataPlaneDocHandler: DataPlaneDocHandler = {
      open: (input) => {
        opened.push({ sessionId: input.sessionId, principalId: input.principalId });
        return {
          handleFrame: (frame) =>
            input.channel.send({
              kind: DataPlaneFrameKind.Ack,
              docId: frame.docId,
              payload: frame.payload,
            }),
          detach: () => undefined,
        };
      },
    };
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
        dataPlaneDocHandler,
      },
      pino({ level: "silent" }),
    );
    const paths = resolveLocalPlanePaths({ paseoHome });
    let attached: Socket | null = null;
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
        clientId: "data-plane-e2e",
        clientType: "cli",
        protocolVersion: 1,
      });
      const features = (await serverInfo).message?.payload?.features as
        | Record<string, unknown>
        | undefined;
      expect(features?.dataPlane).toBe(true);

      const issued = nextSessionLine(
        session,
        (line) => line.message?.type === "local_plane.attach_token.create.response",
      );
      writeSessionLine(session, {
        type: "session",
        message: {
          type: "local_plane.attach_token.create.request",
          requestId: "attach-data-1",
          plane: "data",
        },
      });
      const payload = (await issued).message?.payload as {
        plane: string;
        token: string;
        endpoint: { transport: string; path: string; protocolVersion: number };
      };
      expect(payload.plane).toBe("data");
      expect(payload.endpoint).toEqual({
        transport: "unix",
        path: paths.endpoints.data.path,
        protocolVersion: 1,
      });

      const attachHeaders = {
        connection: "Upgrade",
        upgrade: "paseo-data/1",
        "x-paseo-local-token": localToken,
        "x-paseo-attach-token": payload.token,
      };
      const upgrade = await openDataUpgrade(paths.endpoints.data.path, attachHeaders);
      expect(upgrade.status).toBe(101);
      attached = upgrade.socket;
      if (!attached) throw new Error("data plane refused the upgrade");

      const echoed = nextDataFrame(attached);
      attached.write(
        encodeLengthPrefixedFrame(
          encodeDataPlaneFrame({
            kind: DataPlaneFrameKind.Update,
            docId: "wf",
            payload: Uint8Array.from([1, 2]),
          }),
        ),
      );
      expect(await echoed).toEqual({
        kind: DataPlaneFrameKind.Ack,
        docId: "wf",
        payload: Uint8Array.from([1, 2]),
      });

      // The channel was opened for the Session that asked for the token, as its owner.
      expect(opened).toHaveLength(1);
      expect(opened[0]?.principalId).toBe("owner");
      expect(opened[0]?.sessionId).toMatch(/.+/);

      // The token is spent, so replaying it buys nothing.
      const replay = await openDataUpgrade(paths.endpoints.data.path, attachHeaders);
      expect(replay.status).toBe(401);

      session.socket?.destroy();
    } finally {
      attached?.destroy();
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 60_000);
});
