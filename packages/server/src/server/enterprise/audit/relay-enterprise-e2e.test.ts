import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { EnterpriseAuditListEventsResponseSchema } from "@getpaseo/protocol/messages";
import { startRelayTransport } from "../../relay-transport.js";
import pino from "pino";
import { hash } from "bcryptjs";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../../bootstrap.js";
import { createProductionEnterpriseRuntimeFactory } from "../production-runtime-factory.js";
import {
  createProductionAuditRuntime,
  productionAuditCapabilityIssuer,
} from "./production-audit-runtime.js";
import { getOrCreateServerId } from "../../server-id.js";
import { loadOrCreateDaemonKeyPair } from "../../daemon-keypair.js";
import { createProductionEnterpriseWorkspaceFilesProvider } from "../runtime/production-workspace-files-runtime-provider.js";

const enabled = process.env.FORCE_RELAY_E2E === "1";
const relayRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../relay",
);
const wrangler = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
const executeFile = promisify(execFile);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEnterpriseAuditFeature(values: readonly unknown[]): boolean {
  return values.some((value) => {
    if (!isRecord(value) || value.type !== "session" || !isRecord(value.message)) return false;
    const { message } = value;
    return (
      message.type === "status" &&
      isRecord(message.payload) &&
      message.payload.status === "server_info" &&
      isRecord(message.payload.features) &&
      message.payload.features.enterpriseAuditV1 === true
    );
  });
}

function findAuditResponse(values: readonly unknown[], requestId: string) {
  for (const value of values) {
    if (!isRecord(value) || value.type !== "session") continue;
    const parsed = EnterpriseAuditListEventsResponseSchema.safeParse(value.message);
    if (parsed.success && parsed.data.payload.requestId === requestId) return parsed.data;
  }
  return undefined;
}

function hasRelayDataLog(logs: readonly string[], connectionId: string): boolean {
  return logs.some((line) => line.includes("relay_data_connected") && line.includes(connectionId));
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

    test("production daemon authenticates PAT over relay before enterprise session attach", async () => {
      const root = await mkdtemp(
        path.join(process.env.TMPDIR ?? "/tmp", "paseo-relay-production-"),
      );
      const paseoHome = path.join(root, ".paseo");
      const staticDir = path.join(root, "static");
      const auditAddonPath = path.join(root, "darwin-audit-fs.node");
      const workspaceAddonPath = path.join(root, "darwin-workspace-fs.node");
      const serverId = "srv_relay_production";
      const organizationId = "org_0123456789abcdef";
      const principalId = "usr_0123456789abcdef";
      const daemonPassword = await hash("relay-production-password", 10);
      await Promise.all([
        mkdir(path.join(paseoHome, "enterprise"), { recursive: true, mode: 0o700 }),
        mkdir(staticDir, { recursive: true, mode: 0o700 }),
      ]);
      await writeFile(path.join(paseoHome, "server-id"), `${serverId}\n`, { mode: 0o600 });
      await writeFile(
        path.join(paseoHome, "enterprise", "principals.json"),
        JSON.stringify({
          version: 1,
          principals: {
            [principalId]: {
              principalId,
              organizationId,
              principalType: "human",
              status: "active",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(paseoHome, "enterprise", "grants.json"),
        JSON.stringify({
          [principalId]: {
            principalId,
            organizationId,
            grants: [{ action: "audit.read", selector: { kind: "organization", organizationId } }],
            grantVersion: "grv_relay",
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(paseoHome, "enterprise", "credentials.json"),
        JSON.stringify({ version: 1, credentials: {} }),
        { mode: 0o600 },
      );
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        auditAddonPath,
      ]);
      await executeFile(process.execPath, [
        fileURLToPath(new URL("../runtime/native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        workspaceAddonPath,
      ]);
      const auditRoot = path.join(paseoHome, "enterprise", "audit");
      const seededAudit = await createProductionAuditRuntime({
        node: { nodeId: "nod_0123456789abcdef", paseoServerId: serverId, mode: "standalone" },
        auditRoot,
        nativeAddonPath: auditAddonPath,
      });
      const seededEvent = await seededAudit.append(
        {
          organizationId,
          actorPrincipalId: principalId,
          action: "audit.read",
          resource: { kind: "workspace", id: "wks_relay" },
          outcome: "allowed",
        },
        { durability: "required" },
      );
      await seededAudit.close();
      const preparatoryAudit = await createProductionAuditRuntime({
        node: { nodeId: "nod_0123456789abcdef", paseoServerId: serverId, mode: "standalone" },
        auditRoot,
        nativeAddonPath: auditAddonPath,
      });
      const factory = createProductionEnterpriseRuntimeFactory({ paseoHome, daemonPassword });
      const preparatory = await factory({
        config: {
          enabled: true,
          organizationId,
          nodeId: "nod_0123456789abcdef",
          managementMode: "standalone",
          legacyRecords: "owner_only",
        },
        audit: preparatoryAudit,
      });
      const breakGlass = await preparatory.admission.authenticate("relay-production-password", {
        node: preparatory.node,
        transport: "direct",
        peer: "loopback",
      });
      if (!breakGlass) throw new Error("expected break-glass actor");
      const issued = await preparatory.admission.registry.issueToken({
        actor: breakGlass,
        principalId,
        organizationId,
      });
      await preparatory.close();
      await preparatoryAudit.close();
      const config: PaseoDaemonConfig = {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        staticDir,
        mcpEnabled: false,
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: true,
        relayEndpoint: `127.0.0.1:${relayPort}`,
        relayUseTls: false,
        appBaseUrl: "https://app.paseo.sh",
        enterpriseMultiUser: {
          enabled: true,
          organizationId,
          nodeId: "nod_0123456789abcdef",
          managementMode: "standalone",
          legacyRecords: "owner_only",
        },
      };
      const daemonLogs: string[] = [];
      const daemon = await createPaseoDaemon(
        config,
        pino({ level: "debug" }, { write: (chunk: string) => daemonLogs.push(chunk) }),
        {
          issueProductionAuditCapability: (input) =>
            productionAuditCapabilityIssuer.issue({ ...input, nativeAddonPath: auditAddonPath }),
          createEnterpriseAdmissionRuntime: factory,
          createEnterpriseWorkspaceFilesProvider: ({ workspaceRoots }) =>
            createProductionEnterpriseWorkspaceFilesProvider({
              workspaceRoots,
              nativeAddonPath: workspaceAddonPath,
            }),
        },
      );
      const keyPair = await loadOrCreateDaemonKeyPair(paseoHome);
      const actualServerId = getOrCreateServerId(paseoHome);
      const sockets: WebSocket[] = [];
      const clientErrors: string[] = [];
      try {
        await daemon.start();
        const connectionId = `production-${Date.now()}`;
        const ws = new WebSocket(
          `ws://127.0.0.1:${relayPort}/ws?serverId=${actualServerId}&role=client&connectionId=${connectionId}&v=2`,
        );
        sockets.push(ws);
        ws.on("close", (code, reason) => clientErrors.push(`close:${code}:${reason.toString()}`));
        ws.on("error", (error) => clientErrors.push(`ws:${String(error)}`));
        await wsOpen(ws);
        await vi.waitFor(() => expect(hasRelayDataLog(daemonLogs, connectionId)).toBe(true), {
          timeout: 10_000,
        });
        const responses: unknown[] = [];
        let opened!: () => void;
        const ready = new Promise<void>((resolve) => {
          opened = resolve;
        });
        const channel = await createClientChannel(
          asTransport(ws),
          keyPair.publicKeyB64,
          {
            onopen: opened,
            onerror: (error) => clientErrors.push(`e2ee:${String(error)}`),
            onmessage: (data) => {
              try {
                responses.push(
                  JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
                );
              } catch {
                /* ignore */
              }
            },
          },
          { authPreface: { getToken: () => issued.token } },
        );
        await ready;
        await channel
          .send(
            JSON.stringify({
              type: "hello",
              clientId: "relay-client",
              clientType: "browser",
              protocolVersion: 1,
            }),
          )
          .catch((error) => {
            throw new Error(`hello send failed: ${String(error)} errors=${clientErrors.join("|")}`);
          });
        await vi.waitFor(
          () => expect(hasEnterpriseAuditFeature(responses), JSON.stringify(responses)).toBe(true),
          { timeout: 10_000 },
        );
        await channel.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "enterprise.audit.list_events.request",
              requestId: "relay-audit",
              limit: 20,
            },
          }),
        );
        await vi.waitFor(() => expect(findAuditResponse(responses, "relay-audit")).toBeDefined(), {
          timeout: 10_000,
        });
        const auditResponse = findAuditResponse(responses, "relay-audit");
        expect(
          auditResponse?.payload.events.some(
            (event) =>
              event.eventId === seededEvent.eventId &&
              event.resource.kind === "workspace" &&
              event.resource.id === "wks_relay",
          ),
        ).toBe(true);
        expect(clientErrors).toEqual([]);
      } finally {
        await daemon.stop().catch(() => undefined);
        for (const ws of sockets) ws.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
