import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  createClientChannel,
  exportPublicKey,
  generateKeyPair,
  type Transport,
} from "@getpaseo/relay/e2ee";
import { startRelayTransport } from "../../relay-transport.js";
import pino from "pino";

const enabled = process.env.FORCE_RELAY_E2E === "1";
const relayRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../relay",
);
const wrangler = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });
}

function asTransport(ws: WebSocket): Transport {
  const transport: Transport = {
    send: (data) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        try {
          ws.send(data, (error) => finish(error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    close: (code, reason) => ws.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("message", (data, binary) => {
    if (!binary) {
      transport.onmessage?.({ data: data.toString(), isBinary: false });
      return;
    }
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    transport.onmessage?.({ data: copy.buffer, isBinary: true });
  });
  ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString()));
  ws.on("error", (error) => transport.onerror?.(error));
  return transport;
}

async function wsOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

describe.runIf(enabled && process.platform === "darwin")(
  "relay encrypted auth transport evidence",
  () => {
    let relayPort = 0;
    let processHandle: ChildProcess | null = null;
    beforeAll(async () => {
      const binary = process.env.NODE_BINARY
        ? realpathSync(process.env.NODE_BINARY)
        : process.execPath;
      accessSync(binary, constants.X_OK);
      relayPort = await freePort();
      processHandle = spawn(
        binary,
        [
          wrangler,
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--port",
          String(relayPort),
          "--live-reload=false",
          "--show-interactive-dev-session=false",
        ],
        { cwd: relayRoot, stdio: "ignore" },
      );
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          await new Promise<void>((resolve, reject) => {
            const s = net.connect(relayPort, "127.0.0.1", () => {
              s.destroy();
              resolve();
            });
            s.once("error", reject);
          });
          await new Promise<void>((resolve, reject) => {
            const s = new WebSocket(
              `ws://127.0.0.1:${relayPort}/ws?serverId=probe-${Date.now()}&role=server&v=2`,
            );
            s.once("open", () => {
              s.close();
              resolve();
            });
            s.once("error", reject);
          });
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error("relay dev server did not start");
    }, 70_000);
    afterAll(() => {
      processHandle?.kill("SIGTERM");
      processHandle = null;
    });

    test("gates attach on PAT preface and keeps invalid/pre-auth traffic side-effect free", async () => {
      const keys = generateKeyPair();
      const serverId = `enterprise-relay-${Date.now()}`;
      const attached: string[] = [];
      const messages: string[] = [];
      const authCalls: string[] = [];
      const controller = startRelayTransport({
        logger: pino({ level: "silent" }),
        relayEndpoint: `127.0.0.1:${relayPort}`,
        relayUseTls: false,
        serverId,
        daemonKeyPair: keys,
        authenticateEnterprise: async ({ token }) => {
          authCalls.push(token);
          return token === "pat-a";
        },
        attachSocket: async (socket) => {
          attached.push("attach");
          socket.on("message", () => messages.push("message"));
        },
      });
      const sockets: WebSocket[] = [];
      try {
        const connect = async (token: string, id: string) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=${id}&v=2`,
          );
          sockets.push(ws);
          await wsOpen(ws);
          const channel = await createClientChannel(
            asTransport(ws),
            exportPublicKey(keys.publicKey),
            { onerror: () => undefined },
            { authPreface: { getToken: () => token } },
          );
          await vi.waitFor(() => expect(authCalls.length).toBeGreaterThan(0), { timeout: 10_000 });
          return { ws, channel };
        };
        const valid = await connect("pat-a", "valid");
        await vi.waitFor(() => expect(attached).toHaveLength(1), { timeout: 10_000 });
        await valid.channel.send(JSON.stringify({ type: "session", message: { type: "probe" } }));
        await vi.waitFor(() => expect(messages).toHaveLength(1));
        const authBeforeWrong = authCalls.length;
        await connect("wrong-pat", "wrong");
        await vi.waitFor(() => expect(authCalls.length).toBe(authBeforeWrong + 1), {
          timeout: 10_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(attached).toHaveLength(1);
        const pre = new WebSocket(
          `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=preauth&v=2`,
        );
        sockets.push(pre);
        await wsOpen(pre);
        pre.send(JSON.stringify({ type: "session", message: { type: "probe" } }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(attached).toHaveLength(1);
        expect(messages).toHaveLength(1);
      } finally {
        await controller.stop();
        for (const ws of sockets) ws.close();
      }
    }, 90_000);
  },
);
