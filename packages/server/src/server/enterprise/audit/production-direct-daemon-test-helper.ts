import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { AuditEventInput, ResourceGrant } from "@getpaseo/protocol/messages";
import { hash } from "bcryptjs";
import pino from "pino";
import { WebSocket, type RawData } from "ws";

import { createPaseoDaemon, type PaseoDaemonConfig } from "../../bootstrap.js";
import { createProductionEnterpriseBrowserProfileContentReadSource } from "../browser/content-source.js";
import { EnterpriseAdmission } from "../identity/admission.js";
import type { IssuedPersonalAccessToken } from "../identity/registry.js";
import type { EnterpriseAdmissionRuntime } from "../identity/runtime.js";
import { createProductionEnterpriseRuntimeFactory } from "../production-runtime-factory.js";
import { createProductionEnterpriseWorkspaceFilesProvider } from "../runtime/production-workspace-files-runtime-provider.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./production-audit-runtime.js";

const executeFile = promisify(execFile);
const DEFAULT_TIMESTAMP = "2026-09-11T00:00:00.000Z";

export const PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED = process.platform === "darwin";

export interface ProductionDirectTestPrincipal {
  readonly principalId: string;
  readonly principalType?: "human" | "service";
  readonly grantVersion: string;
  readonly grants: readonly ResourceGrant[];
}

export interface ProductionDirectDaemonTestOptions {
  readonly name: string;
  readonly serverId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly principals: readonly ProductionDirectTestPrincipal[];
  readonly preparatoryAuditInputs?: readonly AuditEventInput[];
  readonly loggerChunks?: string[];
}

export interface ProductionDirectNativeAddons {
  readonly directory: string;
  readonly audit: string;
  readonly workspace: string;
}

export interface ProductionDirectWsEnvelope {
  readonly type?: string;
  readonly message?: {
    readonly type?: string;
    readonly payload?: Record<string, unknown>;
  };
}

export interface ProductionDirectSocket {
  readonly socket: WebSocket;
  readonly outboundFrames: string[];
  readonly serverInfo: ProductionDirectWsEnvelope;
}

function parseFrame(data: RawData): ProductionDirectWsEnvelope | null {
  try {
    return JSON.parse(data.toString()) as ProductionDirectWsEnvelope;
  } catch {
    return null;
  }
}

function isServerInfo(
  value: ProductionDirectWsEnvelope | null,
): value is ProductionDirectWsEnvelope {
  return value?.type === "session" && value.message?.payload?.status === "server_info";
}

async function buildNativeAddons(root: string): Promise<ProductionDirectNativeAddons> {
  const directory = path.join(root, "native-addons");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const audit = path.join(directory, "darwin-audit-fs.node");
  const workspace = path.join(directory, "darwin-workspace-fs.node");
  await Promise.all([
    executeFile(process.execPath, [
      fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      audit,
    ]),
    executeFile(process.execPath, [
      fileURLToPath(new URL("../runtime/native/build-darwin-workspace-fs.mjs", import.meta.url)),
      "--output",
      workspace,
    ]),
  ]);
  return Object.freeze({ directory, audit, workspace });
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

async function waitForServerInfo(
  socket: WebSocket,
  outboundFrames: string[],
  timeoutMs: number,
): Promise<ProductionDirectWsEnvelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("production direct hello timed out waiting for server_info"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: RawData) => {
      const frame = data.toString();
      outboundFrames.push(frame);
      const parsed = parseFrame(data);
      if (!isServerInfo(parsed)) return;
      cleanup();
      socket.on("message", captureLaterFrame);
      resolve(parsed);
    };
    const captureLaterFrame = (data: RawData) => outboundFrames.push(data.toString());
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`production direct socket closed before server_info (${code})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

export class ProductionDirectDaemonTestHarness {
  readonly root: string;
  readonly paseoHome: string;
  readonly staticDir: string;
  readonly nativeAddons: ProductionDirectNativeAddons;
  readonly breakGlassPassword: string;
  readonly daemonPasswordHash: string;
  readonly loggerChunks: string[];
  readonly enterpriseConfig: {
    readonly enabled: true;
    readonly organizationId: string;
    readonly nodeId: string;
    readonly managementMode: "standalone";
    readonly legacyRecords: "owner_only";
  };

  private preparatoryAudit: ProductionAuditCapability | undefined;
  private preparatoryRuntime: EnterpriseAdmissionRuntime | undefined;
  private activeDaemon: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
  private activeRuntime: EnterpriseAdmissionRuntime | undefined;
  private activeUrl: string | undefined;
  private readonly sockets = new Set<WebSocket>();

  private constructor(input: {
    readonly options: ProductionDirectDaemonTestOptions;
    readonly root: string;
    readonly nativeAddons: ProductionDirectNativeAddons;
    readonly breakGlassPassword: string;
    readonly daemonPasswordHash: string;
    readonly preparatoryAudit: ProductionAuditCapability;
    readonly preparatoryRuntime: EnterpriseAdmissionRuntime;
  }) {
    this.root = input.root;
    this.paseoHome = path.join(input.root, ".paseo");
    this.staticDir = path.join(input.root, "static");
    this.nativeAddons = input.nativeAddons;
    this.breakGlassPassword = input.breakGlassPassword;
    this.daemonPasswordHash = input.daemonPasswordHash;
    this.loggerChunks = input.options.loggerChunks ?? [];
    this.enterpriseConfig = Object.freeze({
      enabled: true,
      organizationId: input.options.organizationId,
      nodeId: input.options.nodeId,
      managementMode: "standalone",
      legacyRecords: "owner_only",
    });
    this.preparatoryAudit = input.preparatoryAudit;
    this.preparatoryRuntime = input.preparatoryRuntime;
  }

  static async create(
    options: ProductionDirectDaemonTestOptions,
  ): Promise<ProductionDirectDaemonTestHarness> {
    if (!PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED) {
      throw new Error("production direct daemon test harness requires Darwin");
    }
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), `paseo-${options.name}-`)));
    let preparatoryAudit: ProductionAuditCapability | undefined;
    let preparatoryRuntime: EnterpriseAdmissionRuntime | undefined;
    try {
      const paseoHome = path.join(root, ".paseo");
      const staticDir = path.join(root, "static");
      const breakGlassPassword = randomBytes(32).toString("base64url");
      const [nativeAddons, daemonPasswordHash] = await Promise.all([
        buildNativeAddons(root),
        hash(breakGlassPassword, 12),
        mkdir(path.join(paseoHome, "enterprise"), { recursive: true, mode: 0o700 }),
        mkdir(staticDir, { recursive: true, mode: 0o700 }),
      ]);
      const principals = Object.fromEntries(
        options.principals.map((principal) => [
          principal.principalId,
          {
            principalId: principal.principalId,
            organizationId: options.organizationId,
            principalType: principal.principalType ?? "human",
            status: "active",
            createdAt: DEFAULT_TIMESTAMP,
            updatedAt: DEFAULT_TIMESTAMP,
          },
        ]),
      );
      const grants = Object.fromEntries(
        options.principals.map((principal) => [
          principal.principalId,
          {
            principalId: principal.principalId,
            organizationId: options.organizationId,
            grants: principal.grants,
            grantVersion: principal.grantVersion,
          },
        ]),
      );
      await Promise.all([
        writeFile(path.join(paseoHome, "server-id"), `${options.serverId}\n`, { mode: 0o600 }),
        writeFile(
          path.join(paseoHome, "enterprise", "principals.json"),
          JSON.stringify({ version: 1, principals }),
          { mode: 0o600 },
        ),
        writeFile(path.join(paseoHome, "enterprise", "grants.json"), JSON.stringify(grants), {
          mode: 0o600,
        }),
        writeFile(
          path.join(paseoHome, "enterprise", "credentials.json"),
          JSON.stringify({ version: 1, credentials: {} }),
          { mode: 0o600 },
        ),
      ]);

      preparatoryAudit = await productionAuditCapabilityIssuer.issue({
        node: {
          nodeId: options.nodeId,
          paseoServerId: options.serverId,
          mode: "standalone",
        },
        auditRoot: path.join(paseoHome, "enterprise", "audit"),
        nativeAddonPath: nativeAddons.audit,
      });
      for (const auditInput of options.preparatoryAuditInputs ?? []) {
        await preparatoryAudit.append(auditInput, { durability: "required" });
      }
      preparatoryRuntime = await createProductionEnterpriseRuntimeFactory({
        paseoHome,
        daemonPassword: daemonPasswordHash,
      })({
        config: {
          enabled: true,
          organizationId: options.organizationId,
          nodeId: options.nodeId,
          managementMode: "standalone",
          legacyRecords: "owner_only",
        },
        audit: preparatoryAudit,
      });
      return new ProductionDirectDaemonTestHarness({
        options,
        root,
        nativeAddons,
        breakGlassPassword,
        daemonPasswordHash,
        preparatoryAudit,
        preparatoryRuntime,
      });
    } catch (error) {
      await preparatoryRuntime?.close?.().catch(() => undefined);
      await preparatoryAudit?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  get daemon(): Awaited<ReturnType<typeof createPaseoDaemon>> {
    if (!this.activeDaemon) throw new Error("production direct daemon is not running");
    return this.activeDaemon;
  }

  get runtime(): EnterpriseAdmissionRuntime {
    if (!this.activeRuntime) throw new Error("production enterprise runtime is not running");
    return this.activeRuntime;
  }

  get url(): string {
    if (!this.activeUrl) throw new Error("production direct daemon is not listening");
    return this.activeUrl;
  }

  async issuePersonalAccessToken(principalId: string): Promise<IssuedPersonalAccessToken> {
    const runtime = this.preparatoryRuntime ?? this.activeRuntime;
    if (!runtime || !(runtime.admission instanceof EnterpriseAdmission)) {
      throw new Error("production EnterpriseAdmission is unavailable");
    }
    const actor = await runtime.admission.authenticate(this.breakGlassPassword, {
      node: runtime.node,
      transport: "direct",
      peer: "loopback",
    });
    if (!actor) throw new Error("expected break-glass provisioning actor");
    return runtime.admission.registry.issueToken({
      actor,
      principalId,
      organizationId: this.enterpriseConfig.organizationId,
    });
  }

  async start(): Promise<void> {
    if (this.activeDaemon) throw new Error("production direct daemon already running");
    await this.closePreparation();
    const productionFactory = createProductionEnterpriseRuntimeFactory({
      paseoHome: this.paseoHome,
      daemonPassword: this.daemonPasswordHash,
    });
    const daemonConfig: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome: this.paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      staticDir: this.staticDir,
      mcpEnabled: false,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(this.paseoHome, "agents"),
      auth: { password: this.daemonPasswordHash },
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      enterpriseMultiUser: this.enterpriseConfig,
    };
    let capturedRuntime: EnterpriseAdmissionRuntime | undefined;
    let daemon: Awaited<ReturnType<typeof createPaseoDaemon>> | undefined;
    try {
      daemon = await createPaseoDaemon(
        daemonConfig,
        pino({ level: "trace" }, { write: (chunk: string) => this.loggerChunks.push(chunk) }),
        {
          issueProductionAuditCapability: (input) =>
            productionAuditCapabilityIssuer.issue({
              ...input,
              nativeAddonPath: this.nativeAddons.audit,
            }),
          createEnterpriseAdmissionRuntime: async (input) => {
            capturedRuntime = await productionFactory(input);
            return capturedRuntime;
          },
          createEnterpriseWorkspaceFilesProvider: ({ workspaceRoots }) =>
            createProductionEnterpriseWorkspaceFilesProvider({
              workspaceRoots,
              nativeAddonPath: this.nativeAddons.workspace,
            }),
          createProductionBrowserProfileContentReadSource: (input) =>
            createProductionEnterpriseBrowserProfileContentReadSource({
              addonPath: this.nativeAddons.workspace,
              pageIdentity: input.pageIdentity,
            }),
        },
      );
      await daemon.start();
      if (!capturedRuntime) throw new Error("expected captured production enterprise runtime");
      const target = daemon.getListenTarget();
      if (!target || target.type !== "tcp") throw new Error("expected TCP daemon listener");
      this.activeDaemon = daemon;
      this.activeRuntime = capturedRuntime;
      this.activeUrl = `ws://127.0.0.1:${target.port}/ws`;
    } catch (error) {
      await daemon?.stop().catch(() => undefined);
      await capturedRuntime?.close?.().catch(() => undefined);
      throw error;
    }
  }

  async connectAndHello(input: {
    readonly token: string;
    readonly clientId: string;
    readonly timeoutMs?: number;
  }): Promise<ProductionDirectSocket> {
    const socket = new WebSocket(this.url, [`paseo.bearer.${input.token}`]);
    const outboundFrames: string[] = [];
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    try {
      await waitForOpen(socket);
      const serverInfo = waitForServerInfo(socket, outboundFrames, input.timeoutMs ?? 10_000);
      socket.send(
        JSON.stringify({
          type: "hello",
          clientId: input.clientId,
          clientType: "browser",
          protocolVersion: 1,
        }),
      );
      return { socket, outboundFrames, serverInfo: await serverInfo };
    } catch (error) {
      this.sockets.delete(socket);
      socket.terminate();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const daemon = this.activeDaemon;
    this.activeDaemon = undefined;
    this.activeRuntime = undefined;
    this.activeUrl = undefined;
    if (daemon) await daemon.stop();
  }

  async reopen(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    try {
      await this.stop();
    } finally {
      await this.closePreparation();
      await rm(this.root, { recursive: true, force: true });
    }
  }

  private async closePreparation(): Promise<void> {
    const runtime = this.preparatoryRuntime;
    const audit = this.preparatoryAudit;
    this.preparatoryRuntime = undefined;
    this.preparatoryAudit = undefined;
    await runtime?.close?.();
    await audit?.close();
  }
}

export function createProductionDirectDaemonTestHarness(
  options: ProductionDirectDaemonTestOptions,
): Promise<ProductionDirectDaemonTestHarness> {
  return ProductionDirectDaemonTestHarness.create(options);
}
