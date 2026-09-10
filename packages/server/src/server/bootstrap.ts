import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open, rm } from "fs/promises";
import { randomUUID } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { NodeContextSchema } from "@getpaseo/protocol/messages";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

function logDaemonPasswordAuthentication(logger: Logger, password: string | undefined): void {
  if (password) {
    logger.info("Daemon password authentication enabled");
  }
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import { createWorkspaceLabelService } from "./workspace-labels/index.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import {
  createPaseoToolCatalog,
  type PaseoToolHostDependencies,
} from "./agent/tools/paseo-tools.js";
import type { PaseoToolRuntimeContext } from "./agent/tools/types.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { createOrchestrationSkills } from "./orchestration-skills/index.js";
import { resolveConfigFromPersisted, type CliConfigOverrides } from "./config.js";
import { resolvePaseoToolPolicy } from "./agent/paseo-tool-policy.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { DaemonConfigBrowserToolsPolicy } from "./browser-tools/policy.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import type { PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProfile,
  AgentSkillSelection,
  FirstAgentContext,
  PluginSource,
  TerminalProfile,
} from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import {
  loadPersistedConfig,
  type PersistedConfig,
  type EnterpriseMultiUserConfig,
  EnterpriseMultiUserSchema,
} from "./persisted-config.js";
import type { EnterpriseAdmissionRuntime } from "./enterprise/identity/runtime.js";
import {
  createProductionAuthorizationRuntimeProvider,
  isCurrentProductionAuthorizationRuntimeProvider,
} from "./enterprise/access/production-authorization-runtime-provider.js";
import { isAuthoritativeGrantStoreForAudit } from "./enterprise/access/grant-store.js";
import { createProductionEnterpriseWorkspaceFilesProvider } from "./enterprise/runtime/production-workspace-files-runtime-provider.js";
import type { EnterpriseWorkspaceFilesProductionProvider } from "./enterprise/runtime/production-workspace-files-runtime-provider.js";
import type {
  EnterpriseSessionDispatcher,
  EnterpriseSessionDispatcherFactory,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "./session/enterprise-dispatcher.js";
import type { SessionOptions } from "./session.js";
import type {
  EnterpriseDispatcherRegistration,
  EnterpriseDispatcherRegistry,
  EnterpriseFeatureAdvertisement,
} from "./enterprise/dispatcher-registry.js";
import {
  contentFeaturesForEnterpriseManifest,
  createEnterpriseDispatcherRegistry,
  createEnterpriseSessionDispatcherRegistration,
} from "./enterprise/dispatcher-registry.js";
import { createProductionResourceBundle } from "./enterprise/access/production-resource-bundle.js";
import {
  bindProductionAgentOwners,
  type ProductionAgentOwnerBinder,
} from "./enterprise/access/production-agent-owner-binder.js";
import { createProductionBrowserLeaseBundle } from "./enterprise/browser/production-bundle.js";
import {
  createEnterpriseBrowserLeaseSessionRuntime,
  createProductionBrowserLeaseDispatcherRegistration,
} from "./enterprise/browser/factory.js";
import {
  createProductionAuditDispatcherRegistration,
  createProductionIdentityDispatcherRegistration,
  resolveProductionBrowserProfileRegistry,
} from "./enterprise/production-runtime-factory.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./enterprise/audit/production-audit-runtime.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import {
  attachmentContentDisposition,
  writeHttpDownloadChunk,
} from "./enterprise/http-download-response.js";
import { assertWorkspaceAutomationAllowedForWorkspace } from "./workspace-automation-gate.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  extractHttpBearerToken,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
import { PluginService } from "./plugins/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";

const MCP_DEBUG_BATCH_LIMIT = 10;
const MCP_DEBUG_SECRET = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function describeMcpRequest(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { shape: value === null ? "null" : typeof value };
  }
  const request = value as Record<string, unknown>;
  return {
    shape: "request",
    ...(typeof request.jsonrpc === "string" ? { jsonrpc: request.jsonrpc } : {}),
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    hasId: "id" in request,
    hasParams: "params" in request,
  };
}

function describeMcpDebugPayload(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return describeMcpRequest(value);
  const sampled = value.slice(0, MCP_DEBUG_BATCH_LIMIT).map(describeMcpRequest);
  return {
    shape: "batch",
    count: value.length,
    sampled,
    ...(sampled.length < value.length ? { skipped: value.length - sampled.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  daemonVersion?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  agentProfiles?: AgentProfile[];
  skillSelection?: AgentSkillSelection;
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  providerCatalogRefreshTimeoutMs?: number;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
  configReload?: {
    env: NodeJS.ProcessEnv;
    cli?: CliConfigOverrides;
    overrideControlledPaths: string[];
    relayEnabledFallback: boolean;
    startupPersisted: PersistedConfig;
  };
  enterpriseMultiUser?: EnterpriseMultiUserConfig;
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

export interface PaseoDaemonDependencies {
  enterpriseDispatcherRegistry?: EnterpriseDispatcherRegistry;
  enterpriseDispatcherRegistrations?: readonly EnterpriseDispatcherRegistration[];
  enterpriseDispatcher?: EnterpriseSessionDispatcher;
  enterpriseDispatcherFactory?: EnterpriseSessionDispatcherFactory;
  enterpriseDispatcherRegistration?: EnterpriseSessionDispatcherFactoryRegistration;
  enterpriseIdentitySelfAuthorization?: SessionOptions["enterpriseIdentitySelfAuthorization"];
  enterpriseFeatureFlags?: EnterpriseFeatureAdvertisement;
  createEnterpriseWorkspaceFilesProvider?: (input: {
    workspaceRoots: FileBackedWorkspaceRegistry;
  }) => EnterpriseWorkspaceFilesProductionProvider | null;
  createEnterpriseAdmissionRuntime?: (input: {
    config: EnterpriseMultiUserConfig;
    audit: ProductionAuditCapability;
  }) => Promise<EnterpriseAdmissionRuntime>;
  issueProductionAuditCapability?: typeof productionAuditCapabilityIssuer.issue;
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
    relayConfig?: boolean;
  };
}

async function resolveEnterpriseRuntime(
  paseoHome: string,
  enterpriseConfig: EnterpriseMultiUserConfig | undefined,
  factory: PaseoDaemonDependencies["createEnterpriseAdmissionRuntime"],
  issue: PaseoDaemonDependencies["issueProductionAuditCapability"],
  serverId: string,
): Promise<EnterpriseAdmissionRuntime | undefined> {
  if (enterpriseConfig?.enabled !== true) return undefined;
  if (!factory) throw new Error("enterprise admission runtime factory is required");
  const issueCapability = issue ?? productionAuditCapabilityIssuer.issue;
  const audit = await issueCapability({
    node: { nodeId: enterpriseConfig.nodeId, paseoServerId: serverId, mode: "standalone" },
    auditRoot: path.join(paseoHome, "enterprise", "audit"),
  });
  productionAuditCapabilityIssuer.requireCurrent(audit);
  const closeAudit = audit.close.bind(audit);
  let runtime: EnterpriseAdmissionRuntime | undefined;
  try {
    runtime = await factory({ config: enterpriseConfig, audit });
    productionAuditCapabilityIssuer.requireCurrent(audit);
    const capturedAudit = runtime.audit;
    const capturedAdmission = runtime.admission;
    const capturedAuthenticator = capturedAdmission.authenticator;
    const capturedNode = NodeContextSchema.parse(structuredClone(runtime.node));
    const authenticatorNode = NodeContextSchema.parse(structuredClone(capturedAuthenticator.node));
    const capturedRegistry = runtime.agentContextRegistry;
    const capturedReceiptState = runtime.authorityReceiptState;
    const capturedGrantGuard = runtime.grantVersionGuard;
    const capturedResourceAuthorization = runtime.resourceAuthorization;
    const capturedClose = runtime.close?.bind(runtime);
    const authorizationRuntimeProvider = resolveAuthorizationRuntimeProvider(
      runtime,
      audit,
      paseoHome,
    );
    const capturedGenerationSource = runtime.nextSessionBindingGeneration.bind(runtime);
    if (
      !capturedResourceAuthorization ||
      capturedNode.nodeId !== enterpriseConfig.nodeId ||
      capturedNode.paseoServerId !== serverId ||
      capturedNode.mode !== "standalone" ||
      authenticatorNode.nodeId !== capturedNode.nodeId ||
      authenticatorNode.paseoServerId !== capturedNode.paseoServerId ||
      authenticatorNode.mode !== capturedNode.mode ||
      capturedAuthenticator.configuredOrganizationId !== enterpriseConfig.organizationId ||
      capturedAudit !== audit ||
      capturedAudit !== capturedAdmission.audit
    )
      throw new Error("enterprise runtime does not match configured organization or node");
    productionAuditCapabilityIssuer.requireCurrent(capturedAudit);
    const generation = () => {
      productionAuditCapabilityIssuer.requireCurrent(capturedAudit);
      return capturedGenerationSource();
    };
    return Object.freeze({
      audit: capturedAudit,
      admission: capturedAdmission,
      node: Object.freeze(capturedNode),
      agentContextRegistry: capturedRegistry,
      authorityReceiptState: capturedReceiptState,
      grantVersionGuard: capturedGrantGuard,
      nextSessionBindingGeneration: generation,
      resourceAuthorization: capturedResourceAuthorization,
      authorizationRuntimeProvider,
      ...(runtime.admissionInvalidationSink
        ? { admissionInvalidationSink: runtime.admissionInvalidationSink }
        : {}),
      ...(capturedClose ? { close: capturedClose } : {}),
    });
  } catch (primary) {
    return closeFailedEnterpriseRuntime(runtime, closeAudit, primary);
  }
}

async function closeFailedEnterpriseRuntime(
  runtime: EnterpriseAdmissionRuntime | undefined,
  closeAudit: () => Promise<void>,
  primary: unknown,
): Promise<never> {
  const errors = [primary];
  const closeRuntime = runtime?.close?.bind(runtime);
  if (closeRuntime) await runCleanupStep(errors, closeRuntime);
  await runCleanupStep(errors, closeAudit);
  if (errors.length > 1) {
    // oxlint-disable-next-line preserve-caught-error -- the primary construction error is retained as cause.
    throw new AggregateError(errors, "enterprise runtime construction failed", { cause: primary });
  }
  throw primary;
}

function resolveAuthorizationRuntimeProvider(
  runtime: EnterpriseAdmissionRuntime,
  audit: ProductionAuditCapability,
  paseoHome: string,
) {
  const provider =
    runtime.authorizationRuntimeProvider ??
    createProductionAuthorizationRuntimeProvider({
      audit,
      grantFilePath: path.join(paseoHome, "enterprise", "grants.json"),
    });
  if (
    !isCurrentProductionAuthorizationRuntimeProvider(provider) ||
    !isAuthoritativeGrantStoreForAudit(provider.grantStore, audit)
  ) {
    throw new Error("enterprise authorization provider unavailable");
  }
  return provider;
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function runCleanupStep(errors: unknown[], fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (error) {
    appendError(errors, error);
  }
}

function appendError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) appendError(errors, nested);
    return;
  }
  errors.push(error);
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(app: express.Application, config: PaseoDaemonConfig, logger: Logger): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostname(),
      logger,
    }),
  );
}

function resolveExpressTrustProxySetting(config: PaseoDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialMutableDaemonConfig(config: PaseoDaemonConfig): MutableDaemonConfig {
  const providers = config.providerOverrides ?? {};

  const initialConfig: MutableDaemonConfig = {
    relay: { enabled: config.relayEnabled ?? true },
    mcp: {
      enabled: config.mcpEnabled ?? true,
      injectIntoAgents: config.mcpInjectIntoAgents ?? true,
    },
    ...(config.hostnames !== undefined ? { hostnames: config.hostnames } : {}),
    cors: { allowedOrigins: config.corsAllowedOrigins },
    trustedProxies: config.trustedProxies ?? ["loopback"],
    git: config.git ?? resolveGitProcessPolicy({ env: process.env }),
    app: { baseUrl: config.appBaseUrl ?? "https://app.paseo.sh" },
    ...(config.providerCatalogRefreshTimeoutMs !== undefined
      ? { catalogRefreshTimeoutMs: config.providerCatalogRefreshTimeoutMs }
      : {}),
    browserTools: { enabled: config.browserToolsEnabled ?? false },
    providers,
    metadataGeneration: {
      providers: config.metadataGeneration?.providers ?? [],
    },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    pluginsEnabled: config.pluginsEnabled ?? false,
    plugins: config.plugins ?? {},
    skills: { selection: config.skillSelection },
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }

  if (config.agentProfiles !== undefined) {
    initialConfig.agentProfiles = config.agentProfiles;
  }

  return initialConfig;
}

// oxlint-disable-next-line complexity -- bootstrap owns the ordered enterprise capability lifecycle.
export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
  dependencies: PaseoDaemonDependencies = {},
): Promise<PaseoDaemon> {
  let enterpriseRuntime: EnterpriseAdmissionRuntime | undefined;
  let enterpriseWorkspaceFilesProvider:
    | ReturnType<typeof createProductionEnterpriseWorkspaceFilesProvider>
    | undefined;
  let productionEnterpriseDispatcherRegistration:
    | EnterpriseSessionDispatcherFactoryRegistration
    | undefined;
  let productionEnterpriseFeatureFlags: EnterpriseFeatureAdvertisement | undefined;
  let productionAgentOwnerBinder: ProductionAgentOwnerBinder | undefined;
  const logger = rootLogger.child({ module: "bootstrap" });
  const capturedPaseoHome = structuredClone(config.paseoHome);
  if (typeof capturedPaseoHome !== "string" || capturedPaseoHome.length === 0) {
    throw new Error("paseoHome must be a non-empty string");
  }
  const rawEnterpriseMultiUser = config.enterpriseMultiUser;
  const capturedEnterpriseMultiUser =
    rawEnterpriseMultiUser === undefined
      ? undefined
      : Object.freeze(EnterpriseMultiUserSchema.parse(structuredClone(rawEnterpriseMultiUser)));
  const capturedFactory = dependencies.createEnterpriseAdmissionRuntime;
  const capturedIssue = dependencies.issueProductionAuditCapability;
  const serverId = getOrCreateServerId(capturedPaseoHome, { logger });
  if (capturedEnterpriseMultiUser?.enabled === true) {
    enterpriseRuntime = await resolveEnterpriseRuntime(
      capturedPaseoHome,
      capturedEnterpriseMultiUser,
      capturedFactory,
      capturedIssue,
      serverId,
    );
  }
  const enterpriseAudit = enterpriseRuntime?.audit;
  const constructionCleanupStack: Array<() => Promise<void> | void> = [];
  const configUnsubscribes: Array<() => void> = [];
  const registerConfigUnsubscribe = (unsubscribe: () => void) => {
    configUnsubscribes.push(unsubscribe);
    constructionCleanupStack.push(unsubscribe);
  };
  const requireConstructionAudit = () => {
    if (enterpriseAudit) productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
  };
  const boundEnterpriseAuditClose = enterpriseAudit?.close.bind(enterpriseAudit);
  let outerAuditClosePromise: Promise<void> | null = null;
  const closeEnterpriseAuditOuter = async () => {
    if (!boundEnterpriseAuditClose) return;
    if (!outerAuditClosePromise) outerAuditClosePromise = boundEnterpriseAuditClose();
    await outerAuditClosePromise;
  };
  const boundEnterpriseRuntimeClose = enterpriseRuntime?.close?.bind(enterpriseRuntime);
  let enterpriseRuntimeClosePromise: Promise<void> | null = null;
  const closeEnterpriseRuntime = async () => {
    if (!boundEnterpriseRuntimeClose) return;
    enterpriseRuntimeClosePromise ??= boundEnterpriseRuntimeClose();
    await enterpriseRuntimeClosePromise;
  };
  // oxlint-disable-next-line complexity -- bootstrap owns ordered production provider construction.
  const constructAfterEnterpriseRuntime = async (): Promise<PaseoDaemon> => {
    constructionCleanupStack.push(() => closeEnterpriseRuntime());
    requireConstructionAudit();
    configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
    const obsoleteTimelineDirectory = path.join(capturedPaseoHome, "agent-timelines");
    await rm(obsoleteTimelineDirectory, { recursive: true, force: true }).catch((error) => {
      logger.warn(
        { err: error, path: obsoleteTimelineDirectory },
        "Failed to remove obsolete agent timeline data",
      );
    });
    requireConstructionAudit();
    const bootstrapStart = performance.now();
    const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
    const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
    const initialMutableConfig = createInitialMutableDaemonConfig(config);
    const daemonConfigStore = new DaemonConfigStore(
      capturedPaseoHome,
      initialMutableConfig,
      logger,
      {
        relayEnabledMutable: config.relayEnabledMutable ?? true,
        startupPersisted: config.configReload?.startupPersisted,
        reloadSource: {
          resolve: (persisted) => {
            const reloaded = resolveConfigFromPersisted(capturedPaseoHome, persisted, {
              env: config.configReload?.env ?? process.env,
              cli: config.configReload?.cli,
              relayEnabledFallback: config.configReload?.relayEnabledFallback,
            });
            return {
              mutable: createInitialMutableDaemonConfig(reloaded),
              overrideControlledPaths: reloaded.configReload?.overrideControlledPaths ?? [],
            };
          },
        },
      },
    );
    const orchestrationSkills = createOrchestrationSkills(daemonConfigStore);
    void orchestrationSkills.autoUpdate().catch((error) => {
      logger.error({ err: error }, "Failed to maintain orchestration skills at startup");
    });
    const browserToolsPolicy = new DaemonConfigBrowserToolsPolicy(daemonConfigStore);
    let browserToolsBroker: BrowserToolsBroker;
    const pluginRuntime = new PluginService(logger, daemonConfigStore, daemonVersion, {
      managedSources: new ManagedPluginSources(capturedPaseoHome),
      settingsDirectory: path.join(capturedPaseoHome, "plugin-settings"),
    });
    constructionCleanupStack.push(() => pluginRuntime.stopAllPlugins());

    const closeEnterpriseAudit = closeEnterpriseAuditOuter;
    const daemonKeyPair = await loadOrCreateDaemonKeyPair(capturedPaseoHome, logger);
    requireConstructionAudit();
    const managedProcesses = createBootstrapManagedProcessRegistry(
      { paseoHome: capturedPaseoHome, managedProcesses: config.managedProcesses },
      logger,
    );
    // Reconcile the helper-process ledger in the background so it never blocks the
    // daemon from coming up; terminating a live leftover can take a few seconds.
    // Best-effort, so a failure is logged here rather than crashing startup.
    void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
      logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
    });
    let relayRuntime: RelayRuntime | null = null;

    const staticDir = config.staticDir;
    const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

    const downloadTokenStore = new DownloadTokenStore({
      ttlMs: downloadTokenTtlMs,
    });

    // Capability token authenticating the daemon's own agents to the loopback
    // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
    // local agent configs and the daemon's own MCP client — never sent to remote
    // clients — so it cannot be replayed off-box. This lets the injected MCP
    // authenticate even when the daemon password is set via the app (hash only,
    // no plaintext available). Mirrors the /api/files/download capability-token
    // pattern.
    const agentMcpAuthToken = randomUUID();

    const listenTarget = parseListenString(config.listen);

    const app = express();
    app.set("trust proxy", resolveExpressTrustProxySetting(config));
    registerConfigUnsubscribe(
      daemonConfigStore.onFieldChange("trustedProxies", (value) => {
        app.set("trust proxy", value ?? ["loopback"]);
      }),
    );
    let boundListenTarget: ListenTarget | null = null;
    let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
    const terminalManager = createConfiguredTerminalManager({
      getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
    });
    applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

    const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
      ? config.serviceProxy.publicBaseUrl
      : null;
    const serviceProxy = createServiceProxySubsystem({
      logger,
      publicBaseUrl: serviceProxyPublicBaseUrl,
    });
    const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
    const workspaceSetupRuntime = new WorkspaceSetupRuntime();
    let configuredHostnames = config.hostnames ?? config.allowedHosts;
    let appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";
    registerConfigUnsubscribe(
      daemonConfigStore.onFieldChange("hostnames", (value) => {
        configuredHostnames = value as HostnamesConfig | undefined;
      }),
    );
    registerConfigUnsubscribe(
      daemonConfigStore.onFieldChange("app.baseUrl", (value) => {
        appBaseUrl = typeof value === "string" ? value : "https://app.paseo.sh";
      }),
    );
    let wsServer: VoiceAssistantWebSocketServer | null = null;
    let serviceProxyListenTarget: ListenTarget | null = null;
    const scriptHealthMonitor = new ScriptHealthMonitor({
      serviceProxy,
      onChange: createScriptStatusEmitter({
        sessions: () =>
          wsServer?.listSessions().map((session) => ({
            emit: (message) => session.emitServerMessage(message),
          })) ?? [],
        serviceProxy,
        runtimeStore: scriptRuntimeStore,
        daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        resolveWorkspaceDirectory: async (workspaceId) =>
          (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
        logger,
        serviceProxyPublicBaseUrl,
      }),
    });
    const handleBranchChange = createBranchChangeRouteHandler({
      serviceProxy,
      onRoutesChanged: (workspaceId) => {
        scriptHealthMonitor.invalidateWorkspace(workspaceId);
      },
      logger,
    });

    // Service proxy classifies service hosts before daemon auth/route fallthrough.
    // Registered service hosts proxy directly; known service namespaces without a
    // route return 404 and never reach daemon APIs.
    app.use(serviceProxy.middleware());

    // Host allowlist / DNS rebinding protection (vite-like semantics).
    // For non-TCP (unix sockets), skip host validation.
    if (listenTarget.type === "tcp") {
      app.use((req, res, next) => {
        const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
        if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
          res.status(403).json({ error: "Invalid Host header" });
          return;
        }
        next();
      });
    }

    // CORS - allow same-origin + configured origins
    const fixedAllowedOrigins = [
      // Packaged desktop renderers use the custom paseo:// protocol scheme.
      "paseo://app",
      // For TCP, add localhost variants
      ...(listenTarget.type === "tcp"
        ? [
            `http://${listenTarget.host}:${listenTarget.port}`,
            `http://localhost:${listenTarget.port}`,
            `http://127.0.0.1:${listenTarget.port}`,
          ]
        : []),
    ];
    const allowedOrigins = new Set([...config.corsAllowedOrigins, ...fixedAllowedOrigins]);
    registerConfigUnsubscribe(
      daemonConfigStore.onFieldChange("cors.allowedOrigins", (value) => {
        allowedOrigins.clear();
        for (const origin of [...((value as string[] | undefined) ?? []), ...fixedAllowedOrigins]) {
          allowedOrigins.add(origin);
        }
      }),
    );

    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    });

    // Local, harmless, and token-gated; deliberately skips daemon auth.
    app.post(
      "/api/terminal-activity",
      express.json(),
      createTerminalActivityRouteHandler(terminalManager),
    );

    // Serve the bundled browser web UI when enabled. Mounted after service-proxy
    // classification and host/CORS handling, but before daemon bearer auth, so
    // static app files load without the daemon password while API/WebSocket calls
    // remain protected.
    mountWebUi(app, config, logger);

    app.use(
      createRequireBearerMiddleware(config.auth, (context) => {
        logger.warn(context, "Rejected HTTP request with invalid daemon password");
      }),
    );

    app.use(express.json());

    // Serve static files from public directory
    app.use("/public", express.static(staticDir));

    // Health check endpoint
    app.get("/api/health", (_req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });

    app.get("/api/status", (_req, res) => {
      res.json({
        status: "server_info",
        serverId,
        hostname: getHostname(),
        version: daemonVersion,
        listen: formatListenTarget(boundListenTarget ?? listenTarget),
      });
    });

    const handleFileDownload = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (enterpriseRuntime && enterpriseWorkspaceFilesProvider) {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (!token) {
          res.status(403).json({ error: "Enterprise authentication required" });
          return;
        }
        const principal = await enterpriseRuntime.admission.authenticate(token, {
          node: enterpriseRuntime.node,
          transport: "direct",
          peer: "external",
          remoteAddress: req.ip || req.socket.remoteAddress || "http",
          ...(typeof req.headers.origin === "string" && req.headers.origin.length > 0
            ? { origin: req.headers.origin }
            : {}),
          ...(typeof req.headers["user-agent"] === "string" && req.headers["user-agent"].length > 0
            ? { userAgent: req.headers["user-agent"] }
            : {}),
        });
        if (!principal) {
          res.status(403).json({ error: "Enterprise authentication failed" });
          return;
        }
        await enterpriseWorkspaceFilesProvider.httpHandler.handle({
          principal,
          node: enterpriseRuntime.node,
          query: req.query,
          response: {
            reject: async (status) => {
              res.status(status).json({ error: status === 400 ? "Invalid request" : "Forbidden" });
            },
            begin: async (metadata) => {
              res.setHeader("Content-Type", metadata.mimeType);
              res.setHeader("Content-Disposition", attachmentContentDisposition(metadata.fileName));
              res.setHeader("Content-Length", metadata.size.toString());
            },
            write: async (bytes) => {
              await writeHttpDownloadChunk(res, bytes);
            },
            end: async () => {
              res.end();
            },
            abort: async () => {
              res.destroy();
            },
          },
        });
        return;
      }
      const token =
        typeof req.query.token === "string" && req.query.token.trim().length > 0
          ? req.query.token.trim()
          : null;

      if (!token) {
        res.status(400).json({ error: "Missing download token" });
        return;
      }

      const entry = downloadTokenStore.consumeToken(token);
      if (!entry) {
        res.status(403).json({ error: "Invalid or expired token" });
        return;
      }

      let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
        const fileStats = await fileHandle.stat();
        if (!fileStats.isFile()) {
          res.status(404).json({ error: "File not found" });
          return;
        }

        const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
        res.setHeader("Content-Type", entry.mimeType);
        res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
        res.setHeader("Content-Length", fileStats.size.toString());

        const stream = fileHandle.createReadStream();
        fileHandle = null;
        stream.on("error", (err) => {
          logger.error({ err }, "Failed to stream download");
          if (!res.headersSent) {
            res.status(500).json({ error: "Failed to read file" });
          } else {
            res.end();
          }
        });
        stream.pipe(res);
      } catch (err) {
        logger.error({ err }, "Failed to download file");
        if (!res.headersSent) {
          res.status(404).json({ error: "File not found" });
        }
      } finally {
        await fileHandle?.close().catch(() => undefined);
      }
    };

    app.get("/api/files/download", (req, res) => {
      void handleFileDownload(req, res).catch((error: unknown) => {
        logger.error({ err: error }, "Unhandled file download request failure");
        if (res.destroyed) {
          return;
        }
        if (!res.headersSent) {
          res.status(enterpriseRuntime ? 403 : 500).json({ error: "File download failed" });
        } else if (!res.writableEnded) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });

    const httpServer = createHTTPServer(app);

    // Script proxy WebSocket upgrade handler — must be registered before the
    // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
    // script-bound upgrades are forwarded first. The handler is a no-op for
    // requests that don't match a registered script route.
    httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

    if (config.serviceProxy?.standaloneListen) {
      serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
    }

    const agentStorage = new AgentStorage(config.agentStoragePath, logger);
    const projectRegistry = new FileBackedProjectRegistry(
      path.join(capturedPaseoHome, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(capturedPaseoHome, "projects", "workspaces.json"),
      logger,
    );
    if (enterpriseRuntime && workspaceRegistry) {
      enterpriseWorkspaceFilesProvider = (
        dependencies.createEnterpriseWorkspaceFilesProvider ??
        createProductionEnterpriseWorkspaceFilesProvider
      )({
        workspaceRoots: workspaceRegistry,
      });
      if (!enterpriseWorkspaceFilesProvider || !enterpriseWorkspaceFilesProvider.releaseReady) {
        throw new Error("enterprise workspace files provider unavailable");
      }
    }
    const workspaceLabelService = createWorkspaceLabelService({
      paseoHome: capturedPaseoHome,
      workspaceRegistry,
    });
    const github = createGitHubService();
    const workspaceGitService = new WorkspaceGitServiceImpl({
      logger,
      paseoHome: capturedPaseoHome,
      worktreesRoot: config.worktreesRoot,
      deps: {
        forgeOverrides: { github },
      },
    });
    const unsubscribeWorkspaceMutations = workspaceRegistry.subscribeToMutations((mutation) => {
      if (mutation.kind === "archive" && mutation.workspace) {
        pluginRuntime.emit("workspace.archived", {
          workspace: describeHookWorkspace(mutation.workspace),
        });
      }
    });
    constructionCleanupStack.push(() => unsubscribeWorkspaceMutations());
    const workspaceProvisioning = createWorkspaceProvisioningService({
      lifecycle: pluginRuntime,
      serverId,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });
    const agentProviderRuntime = await createAgentProviderRuntime({
      paseoHome: capturedPaseoHome,
      logger,
      snapshotManager: {
        refreshTimeoutMs: config.providerCatalogRefreshTimeoutMs,
        runtimeSettings: config.agentProviderSettings,
        providerOverrides: config.providerOverrides,
        workspaceGitService,
        managedProcesses,
        isDev: config.isDev === true,
        extraClients: config.agentClients,
      },
    });
    constructionCleanupStack.push(() => agentProviderRuntime.shutdown());
    requireConstructionAudit();
    const providerSnapshotManager = agentProviderRuntime.snapshotManager;
    const unsubscribeCatalog = daemonConfigStore.onFieldChange(
      "catalogRefreshTimeoutMs",
      (value) => {
        providerSnapshotManager.setRefreshTimeoutMs(typeof value === "number" ? value : undefined);
      },
    );
    registerConfigUnsubscribe(unsubscribeCatalog);
    const unsubscribeGitRate = daemonConfigStore.onFieldChange("git.maxProcessesPerSecond", () => {
      const git = daemonConfigStore.get().git;
      if (git) configureGitProcessPolicy(git);
    });
    registerConfigUnsubscribe(unsubscribeGitRate);
    const unsubscribeGitConcurrency = daemonConfigStore.onFieldChange(
      "git.maxProcessConcurrency",
      () => {
        const git = daemonConfigStore.get().git;
        if (git) configureGitProcessPolicy(git);
      },
    );
    registerConfigUnsubscribe(unsubscribeGitConcurrency);
    const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
    const agentManager = new AgentManager({
      pluginLifecycle: pluginRuntime,
      clients: initialAgentManagerState.clients,
      providerDefinitions: initialAgentManagerState.providerDefinitions,
      registry: agentStorage,
      appendSystemPrompt: config.appendSystemPrompt,
      onWorkspaceStateMayHaveChanged: ({ cwd }) => {
        workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
      },
      mcpAuthToken: agentMcpAuthToken,
      resolvePaseoToolPolicy: (provider) =>
        resolvePaseoToolPolicy(provider, daemonConfigStore.get().providers),
      logger,
    });
    const syncPluginProviders = () => {
      agentManager.updateProviderRegistry(
        providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
      );
    };
    const unsubscribePluginProviders =
      pluginRuntime.subscribeProviderRegistrations(syncPluginProviders);
    constructionCleanupStack.push(() => unsubscribePluginProviders());

    const detachAgentStoragePersistence = attachAgentStoragePersistence(logger, agentManager, {
      list: () => agentStorage.list(),
      applySnapshot: async (agent) => {
        await agentStorage.applySnapshot(agent);
        const record = await agentStorage.get(agent.id);
        if (
          record &&
          productionAgentOwnerBinder &&
          !productionAgentOwnerBinder.onPersisted(record)
        ) {
          throw new Error("enterprise agent owner binding failed after persistence");
        }
      },
    });
    constructionCleanupStack.push(() => detachAgentStoragePersistence());
    await agentStorage.initialize();
    requireConstructionAudit();
    logger.info({ elapsed: elapsed() }, "Agent storage initialized");
    await bootstrapWorkspaceRegistries({
      serverId,
      paseoHome: capturedPaseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceGitService,
      logger,
    });
    requireConstructionAudit();
    await workspaceLabelService.initialize();
    requireConstructionAudit();
    logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
    if (enterpriseRuntime) {
      const authorizationRuntimeProvider = enterpriseRuntime.authorizationRuntimeProvider;
      if (!authorizationRuntimeProvider) {
        throw new Error("enterprise authorization provider unavailable");
      }
      const initialAgentRecords = await agentStorage.list();
      productionAgentOwnerBinder =
        bindProductionAgentOwners({
          provider: authorizationRuntimeProvider,
          records: initialAgentRecords,
          nodeId: enterpriseRuntime.node.nodeId,
        }) ?? undefined;
      if (!productionAgentOwnerBinder) {
        throw new Error("enterprise agent owner binding unavailable");
      }
      const agentRecords = Object.freeze({ list: () => agentStorage.list() });
      const resourceBundle = await createProductionResourceBundle({
        provider: authorizationRuntimeProvider,
        workspaceRegistry,
        agentRecords,
        nodeId: enterpriseRuntime.node.nodeId,
      });
      const auditRegistration = createProductionAuditDispatcherRegistration({
        audit: enterpriseRuntime.audit,
        provider: authorizationRuntimeProvider,
      });
      const identityRegistration = createProductionIdentityDispatcherRegistration({
        admission: enterpriseRuntime.admission,
        audit: enterpriseRuntime.audit,
        provider: authorizationRuntimeProvider,
      });
      const browserProfiles = resolveProductionBrowserProfileRegistry({
        admission: enterpriseRuntime.admission,
        audit: enterpriseRuntime.audit,
        provider: authorizationRuntimeProvider,
      });
      if (!browserProfiles) {
        throw new Error("enterprise browser profile authority unavailable");
      }
      const browserBundle = createProductionBrowserLeaseBundle({
        paseoHome: capturedPaseoHome,
        nodeId: enterpriseRuntime.node.nodeId,
        downloadBaseRoot: path.join(capturedPaseoHome, "enterprise", "browser", "profile-data"),
        profiles: browserProfiles,
        auditSink: enterpriseRuntime.audit,
        clock: {
          now: () => Date.now(),
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
        createLeaseId: () => `lea_${randomUUID()}`,
        createRequestId: () => `req_${randomUUID()}`,
        maxLeaseTtlMs: 60_000,
        onError: (error) => logger.error({ err: error }, "Enterprise browser lease failure"),
      });
      constructionCleanupStack.push(() => browserBundle.close());
      await browserBundle.profiles.initialize();
      await browserBundle.bindings.initialize();
      await browserBundle.leases.initialize();
      const browserRegistration = createProductionBrowserLeaseDispatcherRegistration({
        provider: authorizationRuntimeProvider,
        registry: enterpriseRuntime.agentContextRegistry,
        bundle: browserBundle,
        runtime: createEnterpriseBrowserLeaseSessionRuntime({
          profiles: browserBundle.profiles,
          bindings: browserBundle.bindings,
          leases: browserBundle.leases,
          leaseTtlMs: 60_000,
        }),
      });
      if (!identityRegistration || !resourceBundle || !auditRegistration || !browserRegistration) {
        throw new Error("enterprise dispatcher production bundle unavailable");
      }
      productionEnterpriseDispatcherRegistration =
        createEnterpriseSessionDispatcherRegistration([
          identityRegistration,
          resourceBundle.dispatcherFactory,
          browserRegistration,
          auditRegistration,
        ]) ?? undefined;
      if (!productionEnterpriseDispatcherRegistration) {
        throw new Error("enterprise dispatcher production registration unavailable");
      }
      productionEnterpriseFeatureFlags = Object.freeze({
        enterpriseIdentityV1: true,
        enterpriseResourceAuthorizationV1: true,
        enterpriseBrowserProfilesV1: true,
        enterpriseAuditV1: true,
        ...contentFeaturesForEnterpriseManifest(
          productionEnterpriseDispatcherRegistration.manifest,
        ),
      });
      browserToolsBroker = new BrowserToolsBroker({
        enterprise: browserBundle.browserToolsRuntime,
        onHostTeardownError: (error, hostClientId) =>
          logger.error({ err: error, hostClientId }, "Enterprise browser host teardown failed"),
      });
    } else {
      browserToolsBroker = new BrowserToolsBroker({});
    }
    const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
      scriptRuntimeStore.removeForWorkspace(workspaceId);
      releaseWorkspaceServicePortPlan(workspaceId);
    };
    const workspaceReconciliation = new WorkspaceReconciliationService({
      serverId,
      projectRegistry,
      workspaceRegistry,
      logger,
      workspaceGitService,
      onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
      onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
      onWorkspacesChanged: async (workspaceIds) => {
        await fanOutReconciledWorkspaceUpdates({
          sessions: wsServer?.listSessions() ?? [],
          workspaceIds,
          logger,
        });
      },
    });
    constructionCleanupStack.push(() => workspaceReconciliation.dispose());
    await workspaceReconciliation.start();
    requireConstructionAudit();
    void workspaceReconciliation.reconcileNow().catch((error) => {
      logger.warn({ err: error }, "Initial workspace reconciliation failed");
    });
    const checkoutDiffManager = new CheckoutDiffManager({
      logger,
      paseoHome: capturedPaseoHome,
      workspaceGitService,
    });
    const archiveWorkspaceRecordExternal = async (
      workspaceId: string,
      context?: WorkspaceArchiveContext,
    ) => {
      const existingWorkspace = await archivePersistedWorkspaceRecord({
        workspaceId,
        workspaceRegistry,
        context,
      });
      if (!existingWorkspace || existingWorkspace.archivedAt) return;
      teardownArchivedWorkspaceRuntime(workspaceId);
    };
    // external path→workspace adapter, not ownership: archive-by-path requests that
    // arrive with a worktree path and no workspaceId (old clients / CLI).
    const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
      return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
    };
    const ensureWorkspaceForCreateExternal = async (
      cwd: string,
      firstAgentContext?: FirstAgentContext,
    ): Promise<string> => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        resolveFirstAgentPromptTitle(firstAgentContext),
      );
      if (firstAgentContext) {
        workspaceAutoName.scheduleForDirectory({
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          firstAgentContext,
        });
      }
      return workspace.workspaceId;
    };
    const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
      const workspaces = await workspaceRegistry.list();
      return workspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          kind: workspace.kind,
          worktreeRoot: workspace.worktreeRoot,
          isPaseoOwnedWorktree: workspace.isPaseoOwnedWorktree,
          mainRepoRoot: workspace.mainRepoRoot,
        }));
    };
    const markWorkspaceArchivingExternal = (
      workspaceIds: Iterable<string>,
      archivingAt: string,
    ) => {
      const workspaceIdList = Array.from(workspaceIds);
      for (const session of wsServer?.listSessions() ?? []) {
        session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
      }
    };
    const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
      const workspaceIdList = Array.from(workspaceIds);
      for (const session of wsServer?.listSessions() ?? []) {
        session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
      }
    };
    const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
      const workspaceIdList = Array.from(workspaceIds);
      await Promise.all(
        (wsServer?.listSessions() ?? []).map((session) =>
          session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
        ),
      );
    };
    const ensureWorkspaceForCreateAndBroadcastExternal = async (
      cwd: string,
      firstAgentContext?: FirstAgentContext,
    ): Promise<string> => {
      const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext);
      await emitWorkspaceUpdatesExternal([workspaceId]);
      return workspaceId;
    };
    const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
      const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
      await emitWorkspaceUpdatesExternal(workspaceIds);
    };
    const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
      wsServer?.broadcast(wrapSessionMessage(message));
    };
    const workspaceAutoName = new WorkspaceAutoName({
      agentManager,
      workspaceRegistry,
      workspaceGitService,
      providerSnapshotManager,
      readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
      gitMutation: createGitMutationService({
        workspaceGitService,
        logger,
      }),
      emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
      emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
        await emitWorkspaceUpdatesExternal([workspaceId]);
      },
      logger,
    });

    setupAutoArchiveOnMerge({
      paseoHome: capturedPaseoHome,
      paseoWorktreesBaseRoot: config.worktreesRoot,
      daemonConfigStore,
      workspaceGitService,
      github,
      agentManager,
      agentStorage,
      terminalManager,
      logger,
      findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
      listActiveWorkspaces: listActiveWorkspacesExternal,
      getAutoArchivedChangeRequestUrl: async (workspaceId) =>
        (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
      archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
      markWorkspaceArchiving: markWorkspaceArchivingExternal,
      clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
      emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    });

    const createPaseoWorktreeForTools = async (
      input: Parameters<typeof createPaseoWorktreeWorkflow>[1],
      serviceOptions?: Parameters<typeof createPaseoWorktreeWorkflow>[2],
    ) => {
      return createPaseoWorktreeWorkflow(
        {
          paseoHome: capturedPaseoHome,
          worktreesRoot: config.worktreesRoot,
          createPaseoWorktree: async (workflowInput, workflowOptions) => {
            return createRegisteredPaseoWorktree(workflowInput, {
              github,
              ...(workflowOptions?.resolveDefaultBranch
                ? {
                    resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                  }
                : {}),
              workspaceGitService,
              workspaceProvisioning,
            });
          },
          warmWorkspaceGitData: async (workspace) => {
            await Promise.all(
              wsServer
                ?.listSessions()
                .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
            );
          },
          autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
            workspaceAutoName.scheduleForWorktree(autoNameInput),
          emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
            await emitWorkspaceUpdatesExternal([workspaceId]);
          },
          cacheWorkspaceSetupSnapshot: () => {},
          startWorkspaceSetup: (workspaceId, operation) =>
            workspaceSetupRuntime.start(workspaceId, operation),
          assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
            assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
          emit: emitExternalSessionMessage,
          sessionLogger: logger,
          terminalManager,
          archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
          serviceProxy,
          scriptRuntimeStore,
          getDaemonTcpPort: () =>
            boundListenTarget?.type === "tcp" ? boundListenTarget.port : null,
          getDaemonTcpHost: () =>
            boundListenTarget?.type === "tcp" ? boundListenTarget.host : null,
          serviceProxyPublicBaseUrl,
          onScriptsChanged: null,
        },
        input,
        serviceOptions,
      );
    };

    const createAgentCommandDependencies: CreateAgentCommandDependencies = {
      agentManager,
      agentStorage,
      logger,
      paseoHome: capturedPaseoHome,
      worktreesRoot: config.worktreesRoot,
      terminalManager,
      providerSnapshotManager,
      createPaseoWorktree: createPaseoWorktreeForTools,
      ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    };
    const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
      createAgentCommand(createAgentCommandDependencies, input);
    const archiveWorkspaceByIdExternal = (workspaceId: string, requestId: string) =>
      archiveByScope(
        {
          paseoHome: capturedPaseoHome,
          paseoWorktreesBaseRoot: config.worktreesRoot,
          github,
          workspaceGitService,
          agentManager,
          agentStorage,
          findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
          listActiveWorkspaces: listActiveWorkspacesExternal,
          getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
          archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
          emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
          markWorkspaceArchiving: markWorkspaceArchivingExternal,
          clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
          killTerminalsForWorkspace: (workspaceIdToKill) =>
            killTerminalsForWorkspace(
              { terminalManager, sessionLogger: logger },
              workspaceIdToKill,
            ),
          stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
          assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
            assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
          sessionLogger: logger,
        },
        { scope: { kind: "workspace", workspaceId }, requestId },
      );
    const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
      paseoHome: capturedPaseoHome,
      worktreesRoot: config.worktreesRoot,
      agentManager,
      agentStorage,
      github,
      workspaceGitService,
      createPaseoWorktreeWorkflow: createPaseoWorktreeForTools,
      archiveAgentForClose: (agentId) =>
        archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
      findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
      listActiveWorkspaces: listActiveWorkspacesExternal,
      archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
      emit: emitExternalSessionMessage,
      emitAgentRemove: async () => undefined,
      emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
      markWorkspaceArchiving: markWorkspaceArchivingExternal,
      clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
      killTerminalsForWorkspace: (workspaceId) =>
        killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
      logger,
    });
    const hubRelationships = new HubRelationshipController({
      paseoHome: capturedPaseoHome,
      hostname: getHostname(),
      serverId,
      daemonPublicKey: daemonKeyPair.publicKeyB64,
      logger,
      remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
      clock: dependencies.hubRelationshipClock,
      retryPolicy: dependencies.hubRelationshipRetryPolicy,
      createDaemonId: dependencies.createHubDaemonId,
      attachSocket: async (socket, options) => {
        if (!wsServer) throw new Error("WebSocket server is not running");
        await wsServer.attachExternalSocket(
          socket,
          { transport: "hub", hubDaemonId: options.daemonId },
          {
            principalId: options.principalId,
            permissions: options.permissions,
            hubExecutionAgents: options.agents,
          },
          options.sessionProtocol === "legacy"
            ? {
                type: "hello",
                clientId: `hub:${options.daemonId}`,
                clientType: "hub",
                protocolVersion: 1,
              }
            : undefined,
        );
      },
      updateAttachedPermissions: (principalId, permissions) => {
        if (!wsServer) throw new Error("WebSocket server is not running");
        wsServer.updatePrincipalPermissions(principalId, permissions);
      },
      createExecutionAgents: (daemonId) =>
        new DaemonExecutions({
          daemonId,
          agentManager,
          agentStorage,
          createAgent,
          interruptAgent: (agentId) => cancelAgentRunCommand({ agentManager, logger }, agentId),
          archiveWorkspace: archiveWorkspaceByIdExternal,
          cleanupFailedCreate: (input) =>
            hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
        }),
    });

    const createScheduleLocalWorkspaceExternal = async (input: {
      cwd: string;
      firstAgentContext: FirstAgentContext;
    }) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        input.cwd,
        resolveFirstAgentPromptTitle(input.firstAgentContext),
      );
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext: input.firstAgentContext,
      });
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    };
    const createSchedulePaseoWorktreeExternal = async (input: {
      cwd: string;
      firstAgentContext: FirstAgentContext;
    }) => {
      const result = await createPaseoWorktreeForTools({
        cwd: input.cwd,
        firstAgentContext: input.firstAgentContext,
      });
      await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
      return result;
    };
    const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
      await archiveByScope(
        {
          paseoHome: capturedPaseoHome,
          paseoWorktreesBaseRoot: config.worktreesRoot,
          github,
          workspaceGitService,
          agentManager,
          agentStorage,
          findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
          listActiveWorkspaces: listActiveWorkspacesExternal,
          getWorkspace: (workspaceIdToGet) => workspaceRegistry.get(workspaceIdToGet),
          archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
          emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
          markWorkspaceArchiving: markWorkspaceArchivingExternal,
          clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
          killTerminalsForWorkspace: (workspaceIdToKill) =>
            killTerminalsForWorkspace(
              {
                terminalManager,
                sessionLogger: logger,
              },
              workspaceIdToKill,
            ),
          stopWorkspaceSetup: (workspaceIdToStop) => workspaceSetupRuntime.stop(workspaceIdToStop),
          assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
            assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
          sessionLogger: logger,
        },
        {
          scope: { kind: "workspace", workspaceId },
          requestId: "schedule-run-finish",
        },
      );
    };
    const scheduleService = new ScheduleService({
      paseoHome: capturedPaseoHome,
      logger,
      agentManager,
      agentStorage,
      createAgent,
      createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
      createPaseoWorktreeWorkspace: createSchedulePaseoWorktreeExternal,
      archiveWorkspace: archiveScheduleWorkspaceExternal,
    });
    constructionCleanupStack.push(() => scheduleService.stop());
    await scheduleService.start();
    requireConstructionAudit();
    agentManager.setAgentArchivedCallback(async (agentId) => {
      try {
        await scheduleService.completeForAgent(agentId);
      } catch (error) {
        logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
      }
    });
    logger.info({ elapsed: elapsed() }, "Schedule service initialized");
    logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
    const persistedRecords = await agentStorage.list();
    requireConstructionAudit();
    logger.info(
      { elapsed: elapsed() },
      `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
    );
    logger.info(
      "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
    );
    logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

    const createAgentToolHostDependencies = (
      runtime: PaseoToolRuntimeContext,
    ): PaseoToolHostDependencies => ({
      agentManager,
      agentStorage,
      terminalManager,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      scheduleService,
      providerSnapshotManager,
      daemonConfigStore,
      github,
      workspaceGitService,
      findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
      listActiveWorkspaces: listActiveWorkspacesExternal,
      archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
      emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
      workspaceRegistry,
      projectRegistry,
      createDirectoryWorkspace: async (cwd, title, projectId) => {
        const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
          cwd,
          title,
          projectId,
        );
        await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
        return workspace;
      },
      workspaceScripts: createWorkspaceScriptsService({
        serviceProxy,
        scriptRuntimeStore,
        terminalManager,
        workspaceRegistry,
        projectRegistry,
        workspaceGitService,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
        logger,
        // MCP operations do not belong to one WebSocket session, so lifecycle
        // status updates fan out to every connected client.
        emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
        spawnWorkspaceScript,
        assertAutomationAllowed: (workspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, workspaceId),
        globalServicePorts: loadPersistedConfig(capturedPaseoHome).worktrees?.servicePorts,
      }),
      markWorkspaceArchiving: markWorkspaceArchivingExternal,
      clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
      ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
      createPaseoWorktree: createAgentCommandDependencies.createPaseoWorktree,
      browserToolsEnabled: browserToolsPolicy.isEnabled(),
      browserToolsBroker,
      paseoToolPolicy:
        runtime.paseoToolPolicy ??
        (runtime.callerAgentId
          ? agentManager.getPaseoToolPolicy(runtime.callerAgentId)
          : undefined),
      paseoHome: capturedPaseoHome,
      worktreesRoot: config.worktreesRoot,
      callerAgentId: runtime.callerAgentId,
      enableVoiceTools: runtime.enableVoiceTools,
      voiceOnly: runtime.voiceOnly,
      resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
      resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
      logger,
    });
    const createAgentToolCatalog = (runtime: PaseoToolRuntimeContext) =>
      createPaseoToolCatalog(createAgentToolHostDependencies(runtime));
    const setAgentProviderToolsEnabled = (enabled: boolean) => {
      agentProviderRuntime.setPaseoToolCatalog(enabled ? createAgentToolCatalog({}) : null);
    };
    agentManager.setPaseoToolCatalogFactory(createAgentToolCatalog);
    agentManager.setPaseoToolsEnabled(config.mcpInjectIntoAgents !== false);
    setAgentProviderToolsEnabled(
      config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false,
    );

    let mcpEnabled = config.mcpEnabled ?? true;
    let agentMcpBaseUrl: string | null = null;
    {
      const agentMcpRoute = "/mcp/agents";

      const createAgentMcpSession = async (callerAgentId?: string) => {
        const agentMcpServer = await createAgentMcpServer(
          createAgentToolHostDependencies({
            callerAgentId,
            paseoToolPolicy: callerAgentId
              ? agentManager.getPaseoToolPolicy(callerAgentId)
              : undefined,
          }),
        );

        // Stateless mode: each HTTP request builds a fresh server + transport that is
        // torn down when the response closes, so no per-session state is retained between
        // requests. The agent control plane only lists and calls tools, neither of which
        // needs cross-request state, so sessions would only pin memory for the life of the
        // daemon (agents that exit without a clean DELETE never get reaped).
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
          // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
          enableDnsRebindingProtection: false,
        });
        Object.assign(transport, {
          onerror: (err: Error) => {
            logger.error({ err }, "Agent MCP transport error");
          },
        });

        await agentMcpServer.connect(transport);
        return { server: agentMcpServer, transport };
      };

      const runAgentMcpRequest = async (
        req: express.Request,
        res: express.Response,
      ): Promise<void> => {
        if (!mcpEnabled) {
          res.status(404).json({ error: "Agent MCP endpoint disabled" });
          return;
        }
        // This route is exempt from the global daemon-password middleware, so it
        // authenticates here using the injected capability token (or a valid
        // daemon password). Without this, a password-protected daemon would be
        // wide open on its agent control plane.
        if (
          !(await isAgentMcpRequestAuthorized({
            password: config.auth?.password,
            capabilityToken: agentMcpAuthToken,
            authorizationHeader: req.header("authorization"),
          }))
        ) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        if (config.mcpDebug) {
          logger.debug(
            {
              method: req.method,
              url: req.originalUrl,
              sessionId: req.header("mcp-session-id"),
              authorization: req.header("authorization") ? MCP_DEBUG_SECRET : undefined,
              body: describeMcpDebugPayload(req.body),
            },
            "Agent MCP request",
          );
        }
        try {
          // Stateless: GET (standalone SSE) and DELETE (session termination) have no
          // meaning without sessions. The MCP client tolerates 405 on the GET stream
          // and never issues a DELETE because it is never handed a session id.
          if (req.method !== "POST") {
            res.status(405).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Method not allowed",
              },
              id: null,
            });
            return;
          }
          const callerAgentIdRaw = req.query.callerAgentId;
          let callerAgentId: string | undefined;
          if (typeof callerAgentIdRaw === "string") {
            callerAgentId = callerAgentIdRaw;
          } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
            callerAgentId = callerAgentIdRaw[0];
          }
          const { server, transport } = await createAgentMcpSession(callerAgentId);
          res.on("close", () => {
            void transport.close();
            void server.close();
          });

          await transport.handleRequest(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            req.body,
          );
        } catch (err) {
          logger.error({ err }, "Failed to handle Agent MCP request");
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Internal MCP server error",
              },
              id: null,
            });
          }
        }
      };

      const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
        void runAgentMcpRequest(req, res);
      };

      app.post(agentMcpRoute, handleAgentMcpRequest);
      app.get(agentMcpRoute, handleAgentMcpRequest);
      app.delete(agentMcpRoute, handleAgentMcpRequest);
      logger.info({ route: agentMcpRoute, enabled: mcpEnabled }, "Agent MCP route mounted");
    }

    const speechService = createSpeechService({
      logger,
      openaiConfig: config.openai,
      speechConfig: config.speech,
    });
    logger.info({ elapsed: elapsed() }, "Speech service created");

    logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

    let shutdownRunPromise: Promise<readonly unknown[]> | null = null;
    let hubRelationshipShutdown: Promise<void> | null = null;
    const collectShutdownErrors = (): Promise<readonly unknown[]> => {
      if (shutdownRunPromise) return shutdownRunPromise;
      const errors: unknown[] = [];
      try {
        wsServer?.prepareForShutdown();
      } catch (error) {
        appendError(errors, error);
      }
      try {
        agentManager.prepareForShutdown();
      } catch (error) {
        appendError(errors, error);
      }
      try {
        hubRelationshipShutdown = hubRelationships.stop();
      } catch (error) {
        appendError(errors, error);
      }
      shutdownRunPromise = Promise.resolve().then(async () => {
        await runCleanupStep(errors, () => pluginRuntime.stopAllPlugins());
        await runCleanupStep(errors, () => unsubscribePluginProviders());
        await runCleanupStep(errors, () => unsubscribeWorkspaceMutations());
        for (const unsubscribe of configUnsubscribes) {
          await runCleanupStep(errors, unsubscribe);
        }
        await runCleanupStep(errors, () => hubRelationshipShutdown ?? hubRelationships.stop());
        await runCleanupStep(errors, () => workspaceReconciliation.dispose());
        await runCleanupStep(errors, () => scriptHealthMonitor.stop());
        await runCleanupStep(errors, () => scheduleService.stop());
        await runCleanupStep(errors, () => relayRuntime?.stop());
        await runCleanupStep(errors, () => closeAllAgents(logger, agentManager));
        await runCleanupStep(errors, () => agentManager.flushForShutdown());
        await runCleanupStep(errors, () => detachAgentStoragePersistence());
        await runCleanupStep(errors, () => agentStorage.flush());
        await runCleanupStep(errors, () => agentProviderRuntime.shutdown());
        await runCleanupStep(errors, () => terminalManager.killAll());
        await runCleanupStep(errors, () => speechService.stop());
        if (wsServer) {
          const currentWsServer = wsServer;
          await runCleanupStep(errors, () => currentWsServer.close());
        }
        await runCleanupStep(errors, () => serviceProxy.stopStandalone());
        await runCleanupStep(errors, () => httpServer.closeAllConnections());
        await runCleanupStep(
          errors,
          () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
        );
        await runCleanupStep(errors, () => {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
        });
        await runCleanupStep(errors, () => closeEnterpriseRuntime());
        await runCleanupStep(errors, () => closeEnterpriseAudit());
        return errors;
      });
      return shutdownRunPromise;
    };

    const startImpl = async () => {
      const requireStartAudit = () => {
        if (enterpriseAudit) productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
      };
      requireStartAudit();
      try {
        if (serviceProxyListenTarget) {
          const boundServiceProxyTarget = await serviceProxy.startStandalone({
            listenTarget: serviceProxyListenTarget,
          });
          requireConstructionAudit();
          serviceProxyListenTarget = boundServiceProxyTarget;
          logger.info(
            {
              listen: formatListenTarget(serviceProxyListenTarget),
              publicBaseUrl: serviceProxyPublicBaseUrl,
              elapsed: elapsed(),
            },
            "Service proxy listening",
          );
        }

        // Start main HTTP server
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            httpServer.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            httpServer.off("error", onError);
            // oxlint-disable-next-line complexity -- startup ordering is intentionally explicit.
            const logAndResolve = async () => {
              requireStartAudit();
              boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
              const mcpBaseUrl = createAgentMcpBaseUrl(boundListenTarget);
              agentMcpBaseUrl =
                !mcpEnabled || config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
              agentManager.setMcpBaseUrl(agentMcpBaseUrl);
              agentManager.setPaseoToolsEnabled(mcpEnabled && config.mcpInjectIntoAgents !== false);
              registerConfigUnsubscribe(
                daemonConfigStore.onFieldChange("mcp.enabled", (value) => {
                  mcpEnabled = value !== false;
                  const inject = daemonConfigStore.get().mcp.injectIntoAgents !== false;
                  agentManager.setMcpBaseUrl(mcpEnabled && inject ? mcpBaseUrl : null);
                  agentManager.setPaseoToolsEnabled(mcpEnabled && inject);
                  setAgentProviderToolsEnabled(mcpEnabled && inject);
                }),
              );
              registerConfigUnsubscribe(
                daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
                  agentManager.setMcpBaseUrl(mcpEnabled && value ? mcpBaseUrl : null);
                  agentManager.setPaseoToolsEnabled(mcpEnabled && value !== false);
                  setAgentProviderToolsEnabled(mcpEnabled && value !== false);
                }),
              );
              registerConfigUnsubscribe(
                daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
                  agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
                }),
              );
              const relayEnabled = config.relayEnabled ?? true;
              const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
              const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
              const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
              const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
              if (boundListenTarget.type === "tcp") {
                logger.info(
                  {
                    host: boundListenTarget.host,
                    port: boundListenTarget.port,
                    authRequired: !!config.auth?.password,
                    elapsed: elapsed(),
                  },
                  `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
                );
              } else {
                logger.info(
                  {
                    path: boundListenTarget.path,
                    authRequired: !!config.auth?.password,
                    elapsed: elapsed(),
                  },
                  `Server listening on ${boundListenTarget.path}`,
                );
              }
              logDaemonPasswordAuthentication(logger, config.auth?.password);

              requireStartAudit();
              const suppliedDispatcherRegistrations =
                dependencies.enterpriseDispatcherRegistrations ?? [];
              const dispatcherRegistrations = [...suppliedDispatcherRegistrations];
              const enterpriseDispatcherRegistry =
                dependencies.enterpriseDispatcherRegistry ??
                (dispatcherRegistrations.length > 0
                  ? createEnterpriseDispatcherRegistry(dispatcherRegistrations)
                  : undefined);
              wsServer = new VoiceAssistantWebSocketServer(
                httpServer,
                logger,
                serverId,
                agentManager,
                agentStorage,
                downloadTokenStore,
                capturedPaseoHome,
                daemonConfigStore,
                mcpBaseUrl,
                {
                  getAllowedOrigins: () => allowedOrigins,
                  getHostnames: () => configuredHostnames,
                  daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
                  relayConfig: dependencies.serverFeatureOverrides?.relayConfig,
                  startPaused: true,
                },
                workspaceAutoName,
                config.auth,
                speechService,
                terminalManager,
                {
                  finalTimeoutMs: config.dictationFinalTimeoutMs,
                },
                daemonVersion,
                (intent) => {
                  try {
                    config.onLifecycleIntent?.(intent);
                  } catch (error) {
                    logger.error(
                      { err: error, intent },
                      "Failed to handle daemon lifecycle intent",
                    );
                  }
                },
                projectRegistry,
                workspaceRegistry,
                scheduleService,
                checkoutDiffManager,
                serviceProxy,
                scriptRuntimeStore,
                handleBranchChange,
                () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
                () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
                (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
                workspaceGitService,
                github,
                config.pushNotificationSender,
                providerSnapshotManager,
                {
                  listen: formatListenTarget(boundListenTarget ?? listenTarget),
                  worktreesRoot: config.worktreesRoot,
                  get appBaseUrl() {
                    return appBaseUrl;
                  },
                  desktopManaged: config.desktopManaged === true,
                  getRelayConfig: () =>
                    relayRuntime?.getConfig() ?? {
                      enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                      endpoint: relayEndpoint,
                      publicEndpoint: relayPublicEndpoint,
                      useTls: relayUseTls,
                      publicUseTls: relayPublicUseTls,
                    },
                },
                serviceProxyPublicBaseUrl,
                browserToolsBroker,
                hubRelationships,
                workspaceSetupRuntime,
                pluginRuntime,
                orchestrationSkills,
                workspaceLabelService,
                enterpriseRuntime,
                enterpriseWorkspaceFilesProvider ?? undefined,
                enterpriseDispatcherRegistry ?? dependencies.enterpriseDispatcher,
                dependencies.enterpriseIdentitySelfAuthorization,
                enterpriseDispatcherRegistry?.features ??
                  dependencies.enterpriseFeatureFlags ??
                  productionEnterpriseFeatureFlags,
                dependencies.enterpriseDispatcherFactory,
                dependencies.enterpriseDispatcherRegistration ??
                  productionEnterpriseDispatcherRegistration,
              );
              requireStartAudit();
              pluginRuntime.bindPaseoSessionHost(wsServer);
              requireStartAudit();
              await pluginRuntime.start();
              requireStartAudit();
              if (!enterpriseAudit) wsServer.beginAcceptingConnections();
              await hubRelationships.start();
              requireStartAudit();
              speechService.start();
              requireStartAudit();
              scriptHealthMonitor.start();
              requireStartAudit();
              if (enterpriseAudit) wsServer.beginAcceptingConnections();
              requireStartAudit();
              relayRuntime = createRelayRuntime({
                config: {
                  enabled: daemonConfigStore.get().relay?.enabled ?? relayEnabled,
                  endpoint: relayEndpoint,
                  publicEndpoint: relayPublicEndpoint,
                  useTls: relayUseTls,
                  publicUseTls: relayPublicUseTls,
                },
                logger,
                attachSocket: async (ws, metadata) => {
                  if (!wsServer) throw new Error("WebSocket server is not ready");
                  await wsServer.attachExternalSocket(ws, metadata);
                },
                serverId,
                daemonKeyPair: daemonKeyPair.keyPair,
                requireEnterpriseAuth: enterpriseAudit !== undefined,
                authenticateEnterprise: enterpriseRuntime
                  ? async ({ token }) => {
                      productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
                      const evidence = await enterpriseRuntime.admission.authenticateEvidence(
                        token,
                        {
                          node: enterpriseRuntime.node,
                          transport: "relay",
                          peer: "external",
                          remoteAddress: "relay",
                          origin: "relay",
                          userAgent: "relay",
                        },
                      );
                      productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
                      return evidence !== null;
                    }
                  : undefined,
              });
              requireStartAudit();
              registerConfigUnsubscribe(
                daemonConfigStore.onFieldChange("relay.enabled", (value) => {
                  relayRuntime?.setEnabled(value === true);
                }),
              );
              requireStartAudit();
            };

            void logAndResolve()
              .then(() => {
                requireStartAudit();
                resolve();
                return undefined;
              }, reject)
              .catch(reject);
          };
          httpServer.once("error", onError);
          httpServer.once("listening", onListening);

          if (listenTarget.type === "tcp") {
            httpServer.listen(listenTarget.port, listenTarget.host);
          } else {
            if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
              unlinkSync(listenTarget.path);
            }
            httpServer.listen(listenTarget.path);
          }
        });

        requireStartAudit();

        // Start speech service after listening so synchronous Sherpa native
        // model loading doesn't block the server from accepting connections.
      } catch (error) {
        const errors: unknown[] = [];
        appendError(errors, error);
        for (const cleanupError of await collectShutdownErrors()) {
          appendError(errors, cleanupError);
        }
        if (errors.length === 1) throw error;
        // oxlint-disable-next-line preserve-caught-error -- primary startup error is retained as cause.
        throw new AggregateError(errors, "enterprise startup failed", { cause: error });
      }
    };
    const start = () => {
      if (enterpriseAudit) productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
      return startImpl();
    };

    let stopPromise: Promise<void> | null = null;
    const stop = () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const errors = await collectShutdownErrors();
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1)
          throw new AggregateError(errors, "enterprise shutdown failed", { cause: errors[0] });
      })();
      return stopPromise;
    };

    if (enterpriseRuntime) productionAuditCapabilityIssuer.requireCurrent(enterpriseAudit);
    return {
      config,
      agentManager,
      agentStorage,
      terminalManager,
      serviceProxy,
      scriptRuntimeStore,
      browserToolsBroker,
      start,
      stop,
      getListenTarget: () => boundListenTarget,
    };
  };
  try {
    return await constructAfterEnterpriseRuntime();
  } catch (primary) {
    const errors: unknown[] = [];
    appendError(errors, primary);
    for (let index = constructionCleanupStack.length - 1; index >= 0; index -= 1) {
      await runCleanupStep(errors, constructionCleanupStack[index]!);
    }
    await runCleanupStep(errors, () => closeEnterpriseAuditOuter());
    if (errors.length === 1) throw primary;
    // oxlint-disable-next-line preserve-caught-error -- primary is retained as aggregate cause.
    throw new AggregateError(errors, "enterprise construction failed", { cause: primary });
  }
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}
