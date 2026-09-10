import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createClientChannel, type Transport } from "@getpaseo/relay/e2ee";
import {
  deriveSharedKey,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  type KeyPair,
} from "@getpaseo/relay";
import {
  createEnterpriseSessionBindingKey,
  EnterpriseAuditListEventsResponseSchema,
} from "@getpaseo/protocol/messages";
import { startRelayTransport } from "../../relay-transport.js";
import pino from "pino";
import { hash } from "bcryptjs";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../../bootstrap.js";
import { createProductionEnterpriseRuntimeFactory } from "../production-runtime-factory.js";
import {
  isCurrentEnterpriseAdmissionAuthorization,
  resolveCurrentEnterpriseAdmissionAuthorization,
} from "../identity/admission-authorization.js";
import { EnterpriseAdmission } from "../identity/admission.js";
import { parsePersonalAccessToken } from "../identity/registry.js";
import type { EnterpriseAdmissionRuntime } from "../identity/runtime.js";
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

interface WireCapture {
  readonly sent: string[];
  readonly received: string[];
}

function serializeWireFrame(data: string | ArrayBuffer | Buffer, binary: boolean): string {
  if (typeof data === "string") return `text:${data}`;
  const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : data;
  return binary ? `binary:${buffer.toString("base64")}` : `text:${buffer.toString()}`;
}

function asTransport(ws: WebSocket, capture?: WireCapture): Transport {
  const transport: Transport = {
    send: (data) => {
      capture?.sent.push(serializeWireFrame(data, data instanceof ArrayBuffer));
      return new Promise((resolve, reject) => {
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
      });
    },
    close: (code, reason) => ws.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("message", (data, binary) => {
    capture?.received.push(serializeWireFrame(data, binary));
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

function createWireCapture(): WireCapture {
  return { sent: [], received: [] };
}

function relayClientUrl(relayPort: number, serverId: string, connectionId: string): string {
  return `ws://127.0.0.1:${relayPort}/ws?serverId=${serverId}&role=client&connectionId=${connectionId}&v=2`;
}

async function wsClosed(
  ws: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for relay close")),
      10_000,
    );
    ws.once("close", (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function manualRelayHandshake(input: {
  readonly url: string;
  readonly keyPair: KeyPair;
  readonly capture: WireCapture;
}): Promise<{ readonly ws: WebSocket; readonly challenge: string }> {
  const ws = new WebSocket(input.url);
  ws.on("message", (data, binary) => input.capture.received.push(serializeWireFrame(data, binary)));
  await wsOpen(ws);
  let challenge: string | undefined;
  ws.on("message", (data, binary) => {
    if (binary) return;
    try {
      const parsed = JSON.parse(data.toString()) as {
        type?: string;
        capabilities?: { admissionChallenge?: string };
      };
      if (parsed.type === "e2ee_ready") challenge = parsed.capabilities?.admissionChallenge;
    } catch {
      // Encrypted frames are recorded above and ignored by the plaintext handshake reader.
    }
  });
  const hello = JSON.stringify({
    type: "e2ee_hello",
    key: exportPublicKey(input.keyPair.publicKey),
    capabilities: { binaryCiphertext: true },
  });
  input.capture.sent.push(serializeWireFrame(hello, false));
  ws.send(hello);
  await vi.waitFor(() => expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/), { timeout: 10_000 });
  return { ws, challenge: challenge! };
}

async function rejectedRelayPreface(input: {
  readonly url: string;
  readonly daemonPublicKeyB64: string;
  readonly token: string;
  readonly capture: WireCapture;
}): Promise<{
  readonly ws: WebSocket;
  readonly closeCode: number;
  readonly decryptedFrames: unknown[];
  readonly errors: string[];
}> {
  const ws = new WebSocket(input.url);
  const closed = wsClosed(ws);
  const decryptedFrames: unknown[] = [];
  const errors: string[] = [];
  await wsOpen(ws);
  await createClientChannel(
    asTransport(ws, input.capture),
    input.daemonPublicKeyB64,
    {
      onmessage: (data) => {
        try {
          decryptedFrames.push(
            JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
          );
        } catch {
          // Non-JSON decrypted frames are irrelevant to the admission boundary.
        }
      },
      onerror: (error) => errors.push(String(error)),
    },
    { authPreface: { getToken: () => input.token } },
  );
  const outcome = await closed;
  return { ws, closeCode: outcome.code, decryptedFrames, errors };
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function countLogMessage(chunks: readonly string[], message: string): number {
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { msg?: string })
    .filter((line) => line.msg === message).length;
}

function assertCanaryAbsent(
  label: string,
  serialized: string,
  personalAccessToken: string,
  fingerprint: string,
): void {
  expect(serialized, `${label} contained the personal access token`).not.toContain(
    personalAccessToken,
  );
  expect(serialized, `${label} contained the token fingerprint`).not.toContain(fingerprint);
}

function ownerSnapshot(runtime: EnterpriseAdmissionRuntime): string {
  return JSON.stringify({
    quarantined: runtime.authorizationRuntimeProvider?.owners.quarantined() ?? [],
    canaryWorkspace:
      runtime.authorizationRuntimeProvider?.owners.getWorkspace("wks_case15_relay") ?? null,
  });
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

    // oxlint-disable-next-line complexity -- one sequential production lifecycle is the evidence boundary.
    test("production daemon authenticates a secret canary over the relay without disclosure", async () => {
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
      const nodeId = "nod_0123456789abcdef";
      const grantVersion = "grv_relay";
      const breakGlassPassword = randomBytes(32).toString("base64url");
      const daemonPassword = await hash(breakGlassPassword, 12);
      const enterpriseConfig = {
        enabled: true as const,
        organizationId,
        nodeId,
        managementMode: "standalone" as const,
        legacyRecords: "owner_only" as const,
      };
      const auditInputs: unknown[] = [];
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
            grantVersion,
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
        node: { nodeId, paseoServerId: serverId, mode: "standalone" },
        auditRoot,
        nativeAddonPath: auditAddonPath,
      });
      const seedInput = Object.freeze({
        organizationId,
        actorPrincipalId: principalId,
        action: "audit.read",
        resource: { kind: "workspace", id: "wks_relay" },
        outcome: "allowed" as const,
      });
      auditInputs.push(structuredClone(seedInput));
      const seededEvent = await seededAudit.append(seedInput, { durability: "required" });
      await seededAudit.close();
      const preparatoryAudit = await createProductionAuditRuntime({
        node: { nodeId, paseoServerId: serverId, mode: "standalone" },
        auditRoot,
        nativeAddonPath: auditAddonPath,
      });
      const factory = createProductionEnterpriseRuntimeFactory({ paseoHome, daemonPassword });
      const preparatory = await factory({
        config: enterpriseConfig,
        audit: preparatoryAudit,
      });
      const breakGlass = await preparatory.admission.authenticate(breakGlassPassword, {
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
      const personalAccessToken = issued.token;
      const fingerprint = createHash("sha256").update(personalAccessToken).digest("hex");
      const parsedToken = parsePersonalAccessToken(personalAccessToken);
      expect(parsedToken).not.toBeNull();
      expect(Buffer.from(parsedToken!.secret, "base64url")).toHaveLength(32);
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
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
        enterpriseMultiUser: enterpriseConfig,
      };
      const daemonLogs: string[] = [];
      let daemonRuntime: EnterpriseAdmissionRuntime | undefined;
      const daemon = await createPaseoDaemon(
        config,
        pino({ level: "trace" }, { write: (chunk: string) => daemonLogs.push(chunk) }),
        {
          issueProductionAuditCapability: (input) =>
            productionAuditCapabilityIssuer.issue({ ...input, nativeAddonPath: auditAddonPath }),
          createEnterpriseAdmissionRuntime: async (input) => {
            daemonRuntime = await factory(input);
            return daemonRuntime;
          },
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
      const wireCaptures: WireCapture[] = [];
      let daemonStopped = false;
      try {
        await daemon.start();
        if (!daemonRuntime) throw new Error("expected captured production enterprise runtime");
        const runtime = daemonRuntime;
        await vi.waitFor(
          () => expect(countLogMessage(daemonLogs, "relay_control_connected")).toBe(1),
          { timeout: 10_000 },
        );
        expect(runtime.admission).toBeInstanceOf(EnterpriseAdmission);
        const relayConnection = {
          node: runtime.node,
          transport: "relay" as const,
          peer: "external" as const,
          remoteAddress: "relay",
          origin: "relay",
          userAgent: "relay",
        };
        const closeEvidence = await runtime.admission.authenticateEvidence(
          personalAccessToken,
          relayConnection,
        );
        if (!closeEvidence) throw new Error("expected production relay admission evidence");
        const closeHandle = runtime.admission.bindSession(closeEvidence, "case15-relay-close");
        if (!closeHandle) throw new Error("expected relay close-test admission handle");
        const closeSnapshot = resolveCurrentEnterpriseAdmissionAuthorization(
          runtime.admission.authorizationIssuer,
          closeHandle,
        );
        if (!closeSnapshot) throw new Error("expected current relay close-test snapshot");
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            runtime.admission.authorizationIssuer,
            closeHandle,
          ),
        ).toBe(true);
        expect(runtime.admission.releaseSession(closeHandle)).toBe(true);
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            runtime.admission.authorizationIssuer,
            closeHandle,
          ),
        ).toBe(false);

        const connectionId = `production-${Date.now()}`;
        const validCapture = createWireCapture();
        wireCaptures.push(validCapture);
        const ws = new WebSocket(relayClientUrl(relayPort, actualServerId, connectionId));
        sockets.push(ws);
        ws.on("error", (error) => clientErrors.push(`ws:${String(error)}`));
        const validClosed = wsClosed(ws);
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
          asTransport(ws, validCapture),
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
          { authPreface: { getToken: () => personalAccessToken } },
        );
        await ready;
        const clientId = "case15-relay-valid";
        await channel
          .send(
            JSON.stringify({
              type: "hello",
              clientId,
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

        const validGeneration = String(Number(closeSnapshot.sessionBindingGeneration) + 1);
        const validBindingKey = createEnterpriseSessionBindingKey({
          organizationId,
          principalId,
          credentialId: issued.credentialId,
          grantVersion,
          clientId,
        });
        let validBinding: Awaited<
          ReturnType<typeof runtime.authorityReceiptState.resolveCurrentSessionBinding>
        > = null;
        await vi.waitFor(async () => {
          validBinding = await runtime.authorityReceiptState.resolveCurrentSessionBinding({
            sessionBindingKey: validBindingKey,
            sessionBindingGeneration: validGeneration,
          });
          expect(validBinding).toMatchObject({
            sessionBindingKey: validBindingKey,
            sessionBindingGeneration: validGeneration,
            organizationId,
            principalId,
            credentialId: issued.credentialId,
            grantVersion,
            nodeId,
            clientId,
          });
        });
        const initialRuntimeSnapshot = {
          audit: {
            adapterKind: runtime.audit.adapterKind,
            node: runtime.audit.node,
            releaseReady: runtime.audit.releaseReady,
          },
          admission: {
            type: runtime.admission.constructor.name,
            node: runtime.admission.authenticator.node,
            organizationId: runtime.admission.authenticator.configuredOrganizationId,
          },
          closedAdmission: closeSnapshot,
          validBinding,
          ownerState: JSON.parse(ownerSnapshot(runtime)) as unknown,
        };
        assertCanaryAbsent(
          "relay runtime snapshots",
          JSON.stringify(initialRuntimeSnapshot),
          personalAccessToken,
          fingerprint,
        );

        channel.close(1000, "case15 valid complete");
        ws.terminate();
        expect([1000, 1006]).toContain((await validClosed).code);

        const wrongToken = `pso_u_${parsedToken!.credentialId}.${randomBytes(32).toString("base64url")}`;
        const beforeWrongEvents = await runtime.audit.snapshotEvents();
        const beforeWrongAllowed = beforeWrongEvents.filter(
          (event) => event.outcome === "allowed",
        ).length;
        const beforeWrongAwaiting = countLogMessage(daemonLogs, "Client connected; awaiting hello");
        const beforeWrongSessions = countLogMessage(daemonLogs, "Client connected via hello");
        const beforeWrongOwner = ownerSnapshot(runtime);
        const wrongCapture = createWireCapture();
        wireCaptures.push(wrongCapture);
        const wrong = await rejectedRelayPreface({
          url: relayClientUrl(relayPort, actualServerId, `wrong-${Date.now()}`),
          daemonPublicKeyB64: keyPair.publicKeyB64,
          token: wrongToken,
          capture: wrongCapture,
        });
        sockets.push(wrong.ws);
        expect([1008, 1011, 1012]).toContain(wrong.closeCode);
        expect(wrong.decryptedFrames).toEqual([]);
        expect(
          (await runtime.audit.snapshotEvents()).filter((event) => event.outcome === "allowed"),
        ).toHaveLength(beforeWrongAllowed);
        expect(countLogMessage(daemonLogs, "Client connected; awaiting hello")).toBe(
          beforeWrongAwaiting,
        );
        expect(countLogMessage(daemonLogs, "Client connected via hello")).toBe(beforeWrongSessions);
        expect(ownerSnapshot(runtime)).toBe(beforeWrongOwner);

        const replayKeyPair = generateKeyPair();
        const replaySharedKey = deriveSharedKey(
          replayKeyPair.secretKey,
          importPublicKey(keyPair.publicKeyB64),
        );
        const sourceCapture = createWireCapture();
        wireCaptures.push(sourceCapture);
        const source = await manualRelayHandshake({
          url: relayClientUrl(relayPort, actualServerId, `replay-source-${Date.now()}`),
          keyPair: replayKeyPair,
          capture: sourceCapture,
        });
        sockets.push(source.ws);
        const sourceClosed = wsClosed(source.ws);
        const replayedPreface = encrypt(
          replaySharedKey,
          JSON.stringify({
            type: "encrypted_auth_preface_v1",
            challenge: source.challenge,
            token: personalAccessToken,
          }),
        );
        sourceCapture.sent.push(serializeWireFrame(replayedPreface, true));
        source.ws.send(replayedPreface);
        await vi.waitFor(
          () =>
            expect(countLogMessage(daemonLogs, "Client connected; awaiting hello")).toBe(
              beforeWrongAwaiting + 1,
            ),
          { timeout: 10_000 },
        );
        expect(countLogMessage(daemonLogs, "Client connected via hello")).toBe(beforeWrongSessions);
        source.ws.close(1000, "replay source complete");
        source.ws.terminate();
        expect([1000, 1006]).toContain((await sourceClosed).code);

        const beforeReplayEvents = await runtime.audit.snapshotEvents();
        const beforeReplayAllowed = beforeReplayEvents.filter(
          (event) => event.outcome === "allowed",
        ).length;
        const beforeReplayAwaiting = countLogMessage(
          daemonLogs,
          "Client connected; awaiting hello",
        );
        const beforeReplaySessions = countLogMessage(daemonLogs, "Client connected via hello");
        const beforeReplayOwner = ownerSnapshot(runtime);
        const replayCapture = createWireCapture();
        wireCaptures.push(replayCapture);
        const replay = await manualRelayHandshake({
          url: relayClientUrl(relayPort, actualServerId, `replay-${Date.now()}`),
          keyPair: replayKeyPair,
          capture: replayCapture,
        });
        sockets.push(replay.ws);
        expect(replay.challenge).not.toBe(source.challenge);
        const replayClosed = wsClosed(replay.ws);
        replayCapture.sent.push(serializeWireFrame(replayedPreface, true));
        replay.ws.send(replayedPreface);
        expect([1008, 1011, 1012]).toContain((await replayClosed).code);
        expect(
          (await runtime.audit.snapshotEvents()).filter((event) => event.outcome === "allowed"),
        ).toHaveLength(beforeReplayAllowed);
        expect(countLogMessage(daemonLogs, "Client connected; awaiting hello")).toBe(
          beforeReplayAwaiting,
        );
        expect(countLogMessage(daemonLogs, "Client connected via hello")).toBe(
          beforeReplaySessions,
        );
        expect(ownerSnapshot(runtime)).toBe(beforeReplayOwner);

        const revokeEvidence = await runtime.admission.authenticateEvidence(
          personalAccessToken,
          relayConnection,
        );
        if (!revokeEvidence) throw new Error("expected revocable production relay evidence");
        const revokeHandle = runtime.admission.bindSession(revokeEvidence, "case15-relay-revoke");
        if (!revokeHandle) throw new Error("expected relay revoke-test admission handle");
        const revokeSnapshot = resolveCurrentEnterpriseAdmissionAuthorization(
          runtime.admission.authorizationIssuer,
          revokeHandle,
        );
        if (!revokeSnapshot) throw new Error("expected current relay revoke-test snapshot");
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            runtime.admission.authorizationIssuer,
            revokeHandle,
          ),
        ).toBe(true);
        const revokeActor = await runtime.admission.authenticate(breakGlassPassword, {
          node: runtime.node,
          transport: "direct",
          peer: "loopback",
        });
        if (!revokeActor) throw new Error("expected break-glass revoke actor");
        await expect(
          (runtime.admission as EnterpriseAdmission).registry.revokeCredential(
            revokeActor,
            issued.credentialId,
          ),
        ).resolves.toBe(true);
        expect(
          isCurrentEnterpriseAdmissionAuthorization(
            runtime.admission.authorizationIssuer,
            revokeHandle,
          ),
        ).toBe(false);
        await expect(runtime.admission.isCurrentPrincipalContext(issued.principal)).resolves.toBe(
          false,
        );
        await vi.waitFor(async () =>
          expect(
            await runtime.authorityReceiptState.resolveCurrentSessionBinding({
              sessionBindingKey: validBindingKey,
              sessionBindingGeneration: validGeneration,
            }),
          ).toBeNull(),
        );

        const beforeRevokedEvents = await runtime.audit.snapshotEvents();
        const beforeRevokedAllowed = beforeRevokedEvents.filter(
          (event) => event.outcome === "allowed",
        ).length;
        const beforeRevokedAwaiting = countLogMessage(
          daemonLogs,
          "Client connected; awaiting hello",
        );
        const beforeRevokedSessions = countLogMessage(daemonLogs, "Client connected via hello");
        const beforeRevokedOwner = ownerSnapshot(runtime);
        const revokedCapture = createWireCapture();
        wireCaptures.push(revokedCapture);
        const revoked = await rejectedRelayPreface({
          url: relayClientUrl(relayPort, actualServerId, `revoked-${Date.now()}`),
          daemonPublicKeyB64: keyPair.publicKeyB64,
          token: personalAccessToken,
          capture: revokedCapture,
        });
        sockets.push(revoked.ws);
        expect([1008, 1011, 1012]).toContain(revoked.closeCode);
        expect(revoked.decryptedFrames).toEqual([]);
        const auditEvents = await runtime.audit.snapshotEvents();
        expect(auditEvents).toHaveLength(beforeRevokedEvents.length);
        expect(auditEvents.filter((event) => event.outcome === "allowed")).toHaveLength(
          beforeRevokedAllowed,
        );
        expect(countLogMessage(daemonLogs, "Client connected; awaiting hello")).toBe(
          beforeRevokedAwaiting,
        );
        expect(countLogMessage(daemonLogs, "Client connected via hello")).toBe(
          beforeRevokedSessions,
        );
        expect(ownerSnapshot(runtime)).toBe(beforeRevokedOwner);

        const runtimeSnapshots = {
          initial: initialRuntimeSnapshot,
          revocableAdmission: revokeSnapshot,
          currentAfterRevocation: await runtime.authorityReceiptState.resolveCurrentSessionBinding({
            sessionBindingKey: validBindingKey,
            sessionBindingGeneration: validGeneration,
          }),
          ownerState: JSON.parse(ownerSnapshot(runtime)) as unknown,
        };
        assertCanaryAbsent(
          "captured logger lines",
          daemonLogs.join(""),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "audit inputs",
          JSON.stringify(auditInputs),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "audit events",
          JSON.stringify(auditEvents),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "server_info and decrypted outbound frames",
          JSON.stringify([responses, wrong.decryptedFrames, revoked.decryptedFrames]),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "encrypted relay wire frames",
          JSON.stringify(wireCaptures),
          personalAccessToken,
          fingerprint,
        );
        assertCanaryAbsent(
          "SessionAdmission and runtime snapshots",
          JSON.stringify(runtimeSnapshots),
          personalAccessToken,
          fingerprint,
        );
        const credentialsText = await readFile(
          path.join(paseoHome, "enterprise", "credentials.json"),
          "utf8",
        );
        assertCanaryAbsent("credentials.json", credentialsText, personalAccessToken, fingerprint);

        await daemon.stop();
        daemonStopped = true;
        expect(productionAuditCapabilityIssuer.current(runtime.audit)).toBe(false);
        const persistedFiles = await filesUnder(paseoHome);
        for (const file of persistedFiles) {
          assertCanaryAbsent(
            `paseoHome file ${path.relative(paseoHome, file)}`,
            (await readFile(file)).toString("utf8"),
            personalAccessToken,
            fingerprint,
          );
        }
        const evidenceArtifact = JSON.stringify({
          case: 15,
          transport: "relay",
          canary: {
            tokenLength: personalAccessToken.length,
            fingerprintAlgorithm: "sha256",
            fingerprintLength: fingerprint.length,
            fingerprintIdentifier: "runtime-only",
          },
          counts: {
            auditInputs: auditInputs.length,
            auditEvents: auditEvents.length,
            decryptedFrames: responses.length,
            wireFrames: wireCaptures.reduce(
              (count, capture) => count + capture.sent.length + capture.received.length,
              0,
            ),
            persistedFiles: persistedFiles.length,
            rejectedAttempts: 3,
          },
          credentialStorage: { records: 1, hash: "bcrypt", cost: 12 },
        });
        assertCanaryAbsent(
          "relay evidence artifact",
          evidenceArtifact,
          personalAccessToken,
          fingerprint,
        );
      } finally {
        if (!daemonStopped) await daemon.stop().catch(() => undefined);
        for (const ws of sockets) ws.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
