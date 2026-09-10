import { AgentRequests } from "./agent/requests/index.js";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { IncomingMessage, Server as HTTPServer } from "http";
import { join } from "path";
import { hostname as getHostname } from "node:os";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { AgentManager, AgentMetricsSnapshot } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type pino from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";
import type { ProjectUpdate } from "./workspace-reconciliation-service.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager, CheckoutDiffMetrics } from "./checkout-diff-manager.js";
import type { DaemonConfigStore, MutableDaemonConfig } from "./daemon-config-store.js";
import {
  type ServerInfoStatusPayload,
  type SessionOutboundMessage,
  type WorkspaceSetupSnapshot,
  type WSHelloMessage,
  type WSInboundMessage,
  WSInboundMessageSchema,
  type ServerCapabilityState,
  type ServerCapabilities,
  type WSOutboundMessage,
  wrapSessionMessage,
} from "./messages.js";
import { asUint8Array, decodeBinaryFrame } from "@getpaseo/protocol/binary-frames/index";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import type { HostnamesConfig } from "./hostnames.js";
import { isHostnameAllowed } from "./hostnames.js";
import {
  Session,
  type SessionLifecycleIntent,
  type SessionOptions,
  type SessionRuntimeMetrics,
} from "./session.js";
import type {
  EnterpriseSessionDispatcher,
  EnterpriseSessionDispatcherFactory,
} from "./session/enterprise-dispatcher.js";
import type { EnterpriseFeatureAdvertisement } from "./enterprise/dispatcher-registry.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import { WorkspaceSetupRuntime } from "./workspace-setup-runtime.js";
import type { HubExecutionAgents } from "./hub/daemon-executions.js";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { attachMutableProviderConfigOwner } from "./agent/mutable-provider-config-owner.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitServiceMetrics,
} from "./workspace-git-service.js";
import type { GitCommandRuntimeMetricsSnapshot } from "../utils/git-command-runtime-metrics.js";
import { snapshotGitCommandRuntimeMetrics } from "../utils/run-git-command.js";
import { createPluginClientId, isPluginClientId } from "./plugins/plugin-session-identity.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { deriveProjectSlug } from "./workspace-git-metadata.js";
import {
  createPushNotifications,
  type PushNotifications,
  type PushNotificationSender,
} from "./push/index.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import type { SpeechReadinessSnapshot, SpeechService } from "./speech/speech-runtime.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
} from "./agent-attention-policy.js";
import {
  buildAgentAttentionNotificationPayload,
  findLatestPermissionRequest,
} from "@getpaseo/protocol/agent-attention-notification";
import { createGitHubService } from "../services/github-service.js";
import type { ForgeService } from "../services/forge-service.js";
import {
  extractWsBearerProtocol,
  extractWsBearerToken,
  isBearerTokenValid,
  type DaemonAuthConfig,
} from "./auth.js";
import {
  WebSocketRuntimeMetricsWindow,
  type WebSocketRuntimeCounters,
  type WebSocketRuntimeDiagnosticSnapshot,
} from "./websocket/runtime-metrics.js";
import { ProviderUsageService } from "../services/quota-fetcher/service.js";
import { getProcessMemoryDiagnostics, getProcessUptimeSeconds } from "./process-diagnostics.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  normalizeClientRestartRpcReason,
} from "./lifecycle-reasons.js";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { BrowserAutomationExecuteResponse } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  BrowserAutomationHostCapabilitySchema,
  type BrowserAutomationHostCapability,
} from "@getpaseo/protocol/browser-automation/capabilities";
import type { BrowserToolsBroker } from "./browser-tools/broker.js";
import type { DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import { DirectorySyncService } from "./directory-sync/index.js";
import {
  OWNER_PERMISSIONS,
  SessionAuthorization,
  type DaemonPermission,
} from "./authorization/index.js";
import type { WorkspaceLabelService } from "./workspace-labels/index.js";
import {
  APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS,
  ApplicationSocketLease,
  MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
  outboundFrameByteLength,
  physicalSocketHasCapacity,
  sendBoundedPhysicalFrame,
  sendBoundedPhysicalFrameAndWait,
} from "./websocket/physical-socket.js";
import type { EnterpriseAdmissionRuntime } from "./enterprise/identity/runtime.js";
import type { EnterpriseWorkspaceFilesRuntime } from "./enterprise/runtime/workspace-files-runtime.js";
import { createProductionAuthorizationRuntimeForSession } from "./enterprise/access/production-authorization-runtime-provider.js";
import type { ProductionAuthorizationRuntime } from "./enterprise/access/production-authorization-runtime.js";
import type { EnterpriseWorkspaceFilesProductionProvider } from "./enterprise/runtime/production-workspace-files-runtime-provider.js";
import {
  isCurrentEnterpriseAdmissionAuthorization,
  bindOrReplaceEnterpriseAdmissionSession,
  getEnterpriseAdmissionEvidenceLockPartition,
  resolveCurrentEnterpriseAdmissionAuthorization,
  type EnterpriseAdmissionAuthenticationEvidence,
  type EnterpriseAdmissionAuthorizationHandle,
} from "./enterprise/identity/admission-authorization.js";
import {
  DaemonPermissionSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  type NodeContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";

const WS_CLOSE_DAEMON_AUTH_FAILED = 4401;
const AdmissionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("legacy"),
      principalId: z.string(),
      permissions: z.array(DaemonPermissionSchema),
      hubExecutionAgents: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("enterprise"),
      principalId: z.string(),
      permissions: z.array(DaemonPermissionSchema),
      enterprise: z
        .object({
          principal: z.unknown(),
          node: z.unknown(),
          runtime: z.unknown(),
          grantVersionGuard: z.unknown(),
        })
        .strict(),
    })
    .strict(),
]);
function freezeAdmission(value: SessionAdmission): SessionAdmission {
  const top = captureRecord(value);
  if (top.kind === "enterprise") {
    if (Object.hasOwn(top, "authorizationEvidence")) {
      exact(top, ["kind", "authorizationEvidence"]);
      if (
        !top.authorizationEvidence ||
        (typeof top.authorizationEvidence !== "object" &&
          typeof top.authorizationEvidence !== "function")
      )
        throw new Error("invalid enterprise evidence");
      return Object.freeze({
        kind: "enterprise" as const,
        authorizationEvidence:
          top.authorizationEvidence as EnterpriseAdmissionAuthenticationEvidence,
      });
    }
    exact(top, ["kind", "principalId", "permissions", "enterprise"]);
    const e = captureRecord(top.enterprise);
    exact(e, ["principal", "node", "runtime", "grantVersionGuard"]);
    const principal = PrincipalContextSchema.parse(capturePrincipal(e.principal));
    const node = NodeContextSchema.parse(captureNode(e.node));
    const permissions = captureDenseArray(top.permissions, (x) => DaemonPermissionSchema.parse(x));
    if (typeof top.principalId !== "string" || top.principalId !== principal.principalId)
      throw new Error("principal mismatch");
    const input = {
      kind: "enterprise" as const,
      principalId: top.principalId,
      permissions: [...new Set(permissions)],
      enterprise: {
        principal,
        node,
        runtime: e.runtime as EnterpriseAdmissionRuntime,
        grantVersionGuard: e.grantVersionGuard as EnterpriseAdmissionRuntime["grantVersionGuard"],
      },
    };
    const parsed = AdmissionSchema.parse(input) as SessionAdmission;
    Object.freeze(parsed.permissions);
    Object.freeze(principal.grants);
    for (const g of principal.grants) {
      Object.freeze(g.selector);
      if ("workspaceIds" in g.selector) Object.freeze(g.selector.workspaceIds);
      Object.freeze(g);
    }
    Object.freeze(principal);
    Object.freeze(node);
    Object.freeze(parsed.enterprise);
    return Object.freeze(parsed);
  }
  if (top.kind !== undefined && top.kind !== "legacy") throw new Error("invalid admission kind");
  const legacyKeys =
    top.kind === undefined
      ? ["principalId", "permissions"]
      : ["kind", "principalId", "permissions"];
  const hasHub = Object.hasOwn(top, "hubExecutionAgents");
  if (hasHub) {
    if (!top.hubExecutionAgents || typeof top.hubExecutionAgents !== "object")
      throw new Error("hubExecutionAgents");
    legacyKeys.push("hubExecutionAgents");
  }
  exact(top, legacyKeys);
  if (typeof top.principalId !== "string") throw new Error("principalId");
  const hubExecutionAgents = hasHub ? (top.hubExecutionAgents as HubExecutionAgents) : undefined;
  const legacy: SessionAdmission = {
    kind: "legacy",
    principalId: top.principalId,
    permissions: Object.freeze([
      ...new Set(captureDenseArray(top.permissions, (x) => DaemonPermissionSchema.parse(x))),
    ]),
    ...(hubExecutionAgents ? { hubExecutionAgents } : {}),
  };
  return Object.freeze(legacy);
}

function captureRecord(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    throw new Error("invalid record");
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string") throw new Error("symbol");
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !("value" in d)) throw new Error("descriptor");
    out[key] = d.value;
  }
  return out;
}
function exact(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("keys");
}
function captureDenseArray<T>(raw: unknown, map: (value: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw new Error("array");
  const ld = Object.getOwnPropertyDescriptor(raw, "length");
  if (!ld || !("value" in ld) || !Number.isSafeInteger(ld.value) || ld.value < 0)
    throw new Error("length");
  const n = ld.value;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== n + 1) throw new Error("dense");
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d || !d.enumerable || !("value" in d)) throw new Error("index");
    out.push(map(d.value));
  }
  return out;
}
function captureSelector(raw: unknown) {
  const r = captureRecord(raw);
  const kind = r.kind;
  if (kind === "self") {
    exact(r, ["kind"]);
    return { kind: "self" as const };
  }
  if (kind === "organization") {
    exact(r, ["kind", "organizationId"]);
    return { kind: "organization" as const, organizationId: r.organizationId as string };
  }
  if (kind === "workspace") {
    exact(r, ["kind", "workspaceIds"]);
    return {
      kind: "workspace" as const,
      workspaceIds: captureDenseArray(r.workspaceIds, (x) => x as string),
    };
  }
  throw new Error("selector");
}
function captureGrant(raw: unknown) {
  const r = captureRecord(raw);
  exact(r, ["action", "selector"]);
  return { action: r.action as string, selector: captureSelector(r.selector) };
}
function capturePrincipal(raw: unknown) {
  const r = captureRecord(raw);
  exact(r, [
    "principalType",
    "principalId",
    "organizationId",
    "credentialId",
    "grantVersion",
    "grants",
  ]);
  return {
    principalType: r.principalType as string,
    principalId: r.principalId as string,
    organizationId: r.organizationId as string,
    credentialId: r.credentialId as string,
    grantVersion: r.grantVersion as string,
    grants: captureDenseArray(r.grants, captureGrant),
  };
}
function captureNode(raw: unknown) {
  const r = captureRecord(raw);
  exact(r, ["nodeId", "paseoServerId", "mode"]);
  return {
    nodeId: r.nodeId as string,
    paseoServerId: r.paseoServerId as string,
    mode: r.mode as string,
  };
}

export interface ExternalSocketMetadata {
  transport: "relay" | "hub";
  externalSessionKey?: string;
  relayConnectionId?: string;
  hubDaemonId?: string;
}

export type SessionAdmission =
  | {
      kind?: "legacy";
      principalId: string;
      permissions: readonly DaemonPermission[];
      hubExecutionAgents?: HubExecutionAgents;
      enterprise?: never;
    }
  | {
      kind: "enterprise";
      authorizationEvidence: EnterpriseAdmissionAuthenticationEvidence;
      principalId?: never;
      permissions?: never;
      enterprise?: never;
    }
  | {
      kind: "enterprise";
      principalId: string;
      permissions: readonly DaemonPermission[];
      enterprise: {
        principal: PrincipalContext;
        node: NodeContext;
        runtime: EnterpriseAdmissionRuntime;
        grantVersionGuard: EnterpriseAdmissionRuntime["grantVersionGuard"];
      };
      hubExecutionAgents?: never;
    };

interface PendingConnection {
  connectionLogger: pino.Logger;
  helloTimeout: ReturnType<typeof setTimeout> | null;
  identity: WebSocketConnectionIdentity;
  admission: SessionAdmission;
  authorizationEvidence?: EnterpriseAdmissionAuthenticationEvidence;
}
interface PendingMessageItem {
  readonly message: WSInboundMessage;
  readonly pendingConnection: PendingConnection;
}

interface WebSocketConnectionIdentity {
  connectionId: string;
  transport: "direct" | "relay" | "hub";
  peer: "loopback" | "local_ipc" | "external";
  browserOrigin: boolean;
  host?: string;
  origin?: string;
  userAgent?: string;
  remoteAddress?: string;
  relayConnectionId?: string;
  hubDaemonId?: string;
  clientId?: string;
  sessionId?: string;
  appVersion?: string;
}

interface WebSocketServerConfig {
  allowedOrigins?: Set<string>;
  hostnames?: HostnamesConfig;
  getAllowedOrigins?: () => Set<string>;
  getHostnames?: () => HostnamesConfig | undefined;
  daemonStatusRpc?: boolean;
  relayConfig?: boolean;
  startPaused?: boolean;
}

type WebSocketRuntimeMetrics = SessionRuntimeMetrics & CheckoutDiffMetrics;
interface GitRuntimeMetrics {
  commands: GitCommandRuntimeMetricsSnapshot;
  workspaceService: WorkspaceGitServiceMetrics;
}
type WebSocketRuntimeDiagnosticPayload = WebSocketRuntimeDiagnosticSnapshot<
  WebSocketRuntimeMetrics,
  AgentMetricsSnapshot,
  GitRuntimeMetrics
>;
type WebSocketRuntimeMetricsLogPayload = Omit<WebSocketRuntimeDiagnosticPayload, "collectedAt">;

type TerminalAttentionReason = "finished" | "needs_input";

function resolveTerminalAttentionReason(input: {
  attentionReason?: TerminalActivity["attentionReason"];
  previousState: "working" | "idle" | "attention" | null;
  state: "working" | "idle" | "attention" | null;
}): TerminalAttentionReason | null {
  if (input.attentionReason === "finished") return "finished";
  if (input.attentionReason === "needs_input") return "needs_input";
  if (input.state === "attention") return "needs_input";
  if (input.previousState === "working" && input.state === "idle") return "finished";
  return null;
}

function terminalAttentionTitle(reason: TerminalAttentionReason): string {
  return reason === "needs_input" ? "Terminal needs input" : "Terminal finished";
}

function createFallbackWorkspaceGitSnapshot(cwd: string): WorkspaceGitRuntimeSnapshot {
  return {
    cwd,
    git: {
      isGit: false,
      repoRoot: null,
      mainRepoRoot: null,
      currentBranch: null,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      diffStat: null,
    },
    forge: {
      featuresEnabled: false,
      authState: "no_remote",
      pullRequest: null,
      error: null,
    },
  };
}

function createFallbackWorkspaceGitService(): WorkspaceGitService {
  return {
    registerWorkspace: () => ({
      unsubscribe: () => {},
    }),
    onSnapshotUpdated: () => ({
      unsubscribe: () => {},
    }),
    peekSnapshot: () => null,
    getCheckout: async (cwd: string) => ({
      cwd,
      isGit: false,
      currentBranch: null,
      remoteUrl: null,
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
    }),
    getSnapshot: async (cwd: string) => createFallbackWorkspaceGitSnapshot(cwd),
    resolveForge: async () => null,
    getCheckoutDiff: async () => ({ diff: "" }),
    validateBranchRef: async () => ({ kind: "not-found" }),
    hasLocalBranch: async () => false,
    suggestBranchesForCwd: async () => [],
    listStashes: async () => [],
    listWorktrees: async () => [],
    getProjectSlug: async (cwd: string) => {
      const snapshot = createFallbackWorkspaceGitSnapshot(cwd);
      return deriveProjectSlug(cwd, snapshot.git.isGit ? snapshot.git.remoteUrl : null);
    },
    resolveRepoRoot: async (cwd: string) => cwd,
    resolveDefaultBranch: async () => "main",
    resolveRepoRemoteUrl: async () => null,
    refresh: async () => {},
    requestWorkingTreeWatch: async () => ({
      repoRoot: null,
      unsubscribe: () => {},
    }),
    scheduleRefreshForCwd: () => {},
    onWorkspaceStateMayHaveChanged: () => {},
    invalidateForge: () => {},
    getMetrics: () => ({
      workspaceTargetCount: 0,
      workspaceListenerCount: 0,
      repositoryTargetCount: 0,
      repositoryWorkspaceLinkCount: 0,
      workingTreeWatchTargetCount: 0,
      workingTreeWatchListenerCount: 0,
      workspaceObservationSetupInFlightCount: 0,
      workingTreeWatchSetupInFlightCount: 0,
      workspaceRefreshInFlightCount: 0,
      workspaceRefreshQueuedCount: 0,
      workspaceRefreshAdmissionActiveCount: 0,
      workspaceRefreshAdmissionPendingCount: 0,
      workspaceObservationSetupAdmissionActiveCount: 0,
      workspaceObservationSetupAdmissionPendingCount: 0,
      fetchInFlightCount: 0,
      snapshotUpdatedListenerCount: 0,
      watcherErrorCallbackCount: 0,
      fileObserver: {
        activeObservationCount: 0,
        nativeHandleCount: 0,
        nativeTrackedFileCount: 0,
        pendingEventCount: 0,
        pendingReconciliationWorkCount: 0,
        reconciliationInFlightCount: 0,
        reconciliationCount: 0,
        scopedReconciliationCount: 0,
        fullReconciliationCount: 0,
        reconciliationFailureCount: 0,
        observerFailureCount: 0,
        directoryLimitFailureCount: 0,
        nativeEventCount: 0,
        nativeChangeEventCount: 0,
        nativeRenameEventCount: 0,
        nativePathlessEventCount: 0,
        nativeClassificationCount: 0,
        nativeShallowScanCount: 0,
        lastReconciliationDurationMs: 0,
        maxReconciliationDurationMs: 0,
      },
    }),
    dispose: async () => {},
  };
}

function createNoopProjectRegistry(): ProjectRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [],
    get: async () => null,
    getOrCreateActiveByRoot: async (input) => ({
      projectId: "prj_noop",
      rootPath: input.rootPath,
      kind: input.kind,
      displayName: input.displayName,
      projectKey: input.projectKey ?? null,
      customName: null,
      customIconRevision: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
      archivedAt: null,
    }),
    upsert: async () => {},
    update: async () => null,
    archive: async () => {},
    remove: async () => {},
  };
}

function createNoopWorkspaceRegistry(): WorkspaceRegistry {
  return {
    initialize: async () => {},
    existsOnDisk: async () => true,
    list: async () => [],
    get: async () => null,
    update: async () => null,
    upsert: async () => {},
    archive: async () => {},
    remove: async () => {},
  };
}

function toServerCapabilityState(params: {
  state: SpeechReadinessSnapshot["dictation"];
  reason: string;
}): ServerCapabilityState {
  const { state, reason } = params;
  return {
    enabled: state.enabled,
    reason,
  };
}

function resolveCapabilityReason(params: {
  state: SpeechReadinessSnapshot["dictation"];
  readiness: SpeechReadinessSnapshot;
}): string {
  const { state, readiness } = params;
  if (state.available) {
    return "";
  }

  if (readiness.voiceFeature.reasonCode === "model_download_in_progress") {
    const baseMessage = readiness.voiceFeature.message.trim();
    if (baseMessage.includes("Try again in a few minutes")) {
      return baseMessage;
    }
    return `${baseMessage} Try again in a few minutes.`;
  }

  return state.message;
}

function buildServerCapabilities(params: {
  readiness: SpeechReadinessSnapshot | null;
}): ServerCapabilities | undefined {
  const readiness = params.readiness;
  if (!readiness) {
    return undefined;
  }
  return {
    voice: {
      dictation: toServerCapabilityState({
        state: readiness.dictation,
        reason: resolveCapabilityReason({
          state: readiness.dictation,
          readiness,
        }),
      }),
      voice: toServerCapabilityState({
        state: readiness.realtimeVoice,
        reason: resolveCapabilityReason({
          state: readiness.realtimeVoice,
          readiness,
        }),
      }),
    },
  };
}

function areServerCapabilitiesEqual(
  current: ServerCapabilities | undefined,
  next: ServerCapabilities | undefined,
): boolean {
  return JSON.stringify(current ?? null) === JSON.stringify(next ?? null);
}

function bufferFromWsData(data: Buffer | ArrayBuffer | Buffer[] | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item as ArrayBuffer))),
    );
  }
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function getBrowserHostCapability(
  capabilities: Record<string, unknown> | null,
): BrowserAutomationHostCapability | null {
  const parsed = BrowserAutomationHostCapabilitySchema.safeParse(
    capabilities?.[CLIENT_CAPS.browserHost],
  );
  return parsed.success ? parsed.data : null;
}

export interface WebSocketLike {
  readyState: number;
  bufferedAmount?: number;
  send: (
    data: string | Uint8Array | ArrayBuffer,
    callback?: (error?: Error) => void,
  ) => void | Promise<void>;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface SessionConnectionBase {
  session: Session;
  principalId: string;
  sessionKey: string;
  clientId: string;
  appVersion: string | null;
  clientCapabilities: Record<string, unknown> | null;
  connectionLogger: pino.Logger;
  sockets: Set<WebSocketLike>;
  enterpriseAuthorizationHandle?: EnterpriseAdmissionAuthorizationHandle;
}

interface ReconnectableSessionConnection extends SessionConnectionBase {
  lifecycle: "reconnectable";
  externalDisconnectCleanupTimeout: ReturnType<typeof setTimeout> | null;
}

interface PluginSessionConnection extends SessionConnectionBase {
  lifecycle: "ephemeral-plugin";
  pluginId: string;
}

type SessionConnection = ReconnectableSessionConnection | PluginSessionConnection;

interface BrowserToolsRegistration {
  capabilitySignature: string;
  unregister: () => void;
}

interface SocketSessionOptions {
  clientId: string;
  appVersion: string | null;
  clientCapabilities: Record<string, unknown> | null;
  permissions: readonly DaemonPermission[];
  connectionLogger: pino.Logger;
  onMessage: (message: SessionOutboundMessage) => void;
  onMessageToSource?: (source: object, message: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onBinaryMessageToSource?: (source: object, frame: Uint8Array) => Promise<void>;
  getTransportBufferedAmount?: () => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  hubExecutionAgents?: HubExecutionAgents;
  hubRelationships?: HubRelationshipManagement;
  enterprise?: SessionAdmission["enterprise"];
  grantVersionGuard?: EnterpriseAdmissionRuntime["grantVersionGuard"];
  sessionId?: string;
  sessionAuthorization?: SessionAuthorization;
  enterpriseAuthorizationRuntime?: ProductionAuthorizationRuntime;
  enterpriseWorkspaceFilesRuntime?: SessionOptions["enterpriseWorkspaceFilesRuntime"];
  admissionAuthorizationIssuer?: EnterpriseAdmissionRuntime["admission"]["authorizationIssuer"];
  admissionAuthorizationHandle?: EnterpriseAdmissionAuthorizationHandle;
}

interface ClosePhysicalSocketParams {
  ws: WebSocketLike;
  logMessage: string;
  logFields?: Record<string, unknown>;
}

const SLOW_REQUEST_THRESHOLD_MS = 500;
const EXTERNAL_SESSION_DISCONNECT_GRACE_MS = 90_000;
const HELLO_TIMEOUT_MS = 15_000;
const WS_CLOSE_HELLO_TIMEOUT = 4001;
const WS_CLOSE_INVALID_HELLO = 4002;
const WS_CLOSE_INCOMPATIBLE_PROTOCOL = 4003;
const WS_CLOSE_SERVER_SHUTDOWN = 1001;
const WS_PROTOCOL_VERSION = 1;
const WS_RUNTIME_METRICS_FLUSH_MS = 30_000;
const OWNER_SESSION_ADMISSION: SessionAdmission = {
  principalId: "owner",
  permissions: OWNER_PERMISSIONS,
};

export class MissingDaemonVersionError extends Error {
  constructor() {
    super("VoiceAssistantWebSocketServer requires a non-empty daemonVersion.");
    this.name = "MissingDaemonVersionError";
  }
}

interface RequiredWebSocketServices {
  scheduleService: ScheduleService;
  checkoutDiffManager: CheckoutDiffManager;
}

function requireWebSocketServices(params: {
  scheduleService?: ScheduleService;
  checkoutDiffManager?: CheckoutDiffManager;
}): RequiredWebSocketServices {
  const { scheduleService, checkoutDiffManager } = params;
  if (!scheduleService) {
    throw new Error("VoiceAssistantWebSocketServer requires a schedule service.");
  }
  if (!checkoutDiffManager) {
    throw new Error("VoiceAssistantWebSocketServer requires a checkout diff manager.");
  }
  return { scheduleService, checkoutDiffManager };
}

/**
 * WebSocket server that only accepts sockets + parses/forwards messages to the session layer.
 */
export class VoiceAssistantWebSocketServer {
  private readonly logger: pino.Logger;
  private readonly wss: WebSocketServer;
  private readonly pendingConnections: Map<WebSocketLike, PendingConnection> = new Map();
  /** Handshakes remain owned while async hello admission/server_info work runs. */
  private readonly handshakeConnections: Map<WebSocketLike, PendingConnection> = new Map();
  /** Authentication promises are owned by shutdown until they settle. */
  private readonly authenticationTasks: Map<WebSocketLike, Promise<void>> = new Map();
  private readonly sessions: Map<WebSocketLike, SessionConnection> = new Map();
  private readonly socketIdentities: Map<WebSocketLike, WebSocketConnectionIdentity> = new Map();
  private readonly externalSessionsByKey: Map<string, ReconnectableSessionConnection> = new Map();
  private readonly externalSessionsByBaseKey: Map<string, ReconnectableSessionConnection> =
    new Map();
  private readonly pendingMessageQueues = new Map<WebSocketLike, PendingMessageItem[]>();
  private readonly pendingMessageDraining = new Set<WebSocketLike>();
  private readonly pendingMessageReplaying = new Set<WebSocketLike>();
  private readonly pendingMessageOwners = new Map<WebSocketLike, PendingConnection>();
  private readonly pendingMessageTasks = new Map<WebSocketLike, Promise<void>>();
  private readonly pendingMessageErrors = new Map<WebSocketLike, unknown>();
  private readonly connectionCleanupPromises = new WeakMap<SessionConnection, Promise<void>>();
  private readonly handshakeInFlight = new Set<WebSocketLike>();
  private readonly handshakeLocks = new Map<string, Promise<void>>();
  private readonly pluginSocketIds = new WeakMap<WebSocketLike, string>();
  private readonly pluginSocketCleanup = new WeakMap<WebSocketLike, () => void>();
  private readonly serverId: string;
  private readonly daemonVersion: string;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly agentRequests: AgentRequests;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly workspaceLabelService: WorkspaceLabelService | null;
  private readonly scheduleService: ScheduleService;
  private readonly checkoutDiffManager: CheckoutDiffManager;
  private readonly github: ForgeService;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceAutoName: WorkspaceAutoName;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly paseoHome: string;
  private readonly worktreesRoot: string | undefined;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly pushNotifications: PushNotifications;
  private readonly pushNotificationSender: PushNotificationSender;
  private readonly mcpBaseUrl: string | null;
  private speech!: SpeechService | null;
  private terminalManager!: TerminalManager | null;
  private serviceProxy!: ServiceProxySubsystem | null;
  private scriptRuntimeStore!: WorkspaceScriptRuntimeStore | null;
  private getDaemonTcpPort!: (() => number | null) | null;
  private getDaemonTcpHost!: (() => string | null) | null;
  private serviceProxyPublicBaseUrl!: string | null;
  private resolveScriptHealth!: ((hostname: string) => ScriptHealthState | null) | null;
  private dictation!: {
    finalTimeoutMs?: number;
  } | null;
  private readonly voiceSpeakHandlers = new Map<string, VoiceSpeakHandler>();
  private readonly voiceCallerContexts = new Map<string, VoiceCallerContext>();
  private readonly workspaceSetupSnapshots = new Map<string, WorkspaceSetupSnapshot>();
  private readonly workspaceSetupRuntime: WorkspaceSetupRuntime;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private onLifecycleIntent!: ((intent: SessionLifecycleIntent) => void) | null;
  private onBranchChanged!:
    | ((workspaceId: string, oldBranch: string | null, newBranch: string | null) => void)
    | null;
  private serverCapabilities: ServerCapabilities | undefined;
  private readonly runtimeMetrics = new WebSocketRuntimeMetricsWindow();
  private lastRuntimeMetricsSnapshot: WebSocketRuntimeDiagnosticPayload | null = null;
  private runtimeMetricsInterval: ReturnType<typeof setInterval> | null = null;
  private applicationSocketLeaseInterval: ReturnType<typeof setInterval> | null = null;
  private readonly applicationSocketLease = new ApplicationSocketLease<WebSocketLike>();
  private eventLoopDelayMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private unsubscribeSpeechReadiness: (() => void) | null = null;
  private unsubscribeDaemonConfigChange: (() => void) | null = null;
  private readonly providerUsageService: ProviderUsageService;
  private unsubscribeTerminalActivity: (() => void) | null = null;
  private readonly browserToolsBroker: BrowserToolsBroker | null;
  private readonly hubRelationships: HubRelationshipManagement | null;
  private readonly browserToolsRegistrations = new Map<string, BrowserToolsRegistration>();
  private connectionLifecycle: "starting" | "accepting" | "stopping" = "accepting";
  private closePromise: Promise<void> | null = null;
  private readonly advertiseDaemonStatusRpc: boolean;
  private readonly advertiseRelayConfig: boolean;
  private readonly directorySync = new DirectorySyncService();
  private readonly pluginRuntime: SessionOptions["pluginRuntime"];
  private readonly orchestrationSkills: SessionOptions["orchestrationSkills"];
  private readonly enterpriseRuntime?: EnterpriseAdmissionRuntime;
  private readonly enterpriseWorkspaceFilesProvider?: EnterpriseWorkspaceFilesProductionProvider;
  private readonly enterpriseDispatcher?: EnterpriseSessionDispatcher;
  private readonly enterpriseDispatcherFactory?: EnterpriseSessionDispatcherFactory;
  private readonly enterpriseFeatureFlags?: EnterpriseFeatureAdvertisement;
  private readonly enterpriseIdentitySelfAuthorization?: SessionOptions["enterpriseIdentitySelfAuthorization"];

  constructor(
    server: HTTPServer,
    logger: pino.Logger,
    serverId: string,
    agentManager: AgentManager,
    agentStorage: AgentStorage,
    downloadTokenStore: DownloadTokenStore,
    paseoHome: string,
    daemonConfigStore: DaemonConfigStore,
    mcpBaseUrl: string | null,
    wsConfig: WebSocketServerConfig,
    workspaceAutoName: WorkspaceAutoName,
    auth?: DaemonAuthConfig,
    speech?: SpeechService | null,
    terminalManager?: TerminalManager | null,
    dictation?: {
      finalTimeoutMs?: number;
    },
    daemonVersion?: string,
    onLifecycleIntent?: (intent: SessionLifecycleIntent) => void,
    projectRegistry?: ProjectRegistry,
    workspaceRegistry?: WorkspaceRegistry,
    scheduleService?: ScheduleService,
    checkoutDiffManager?: CheckoutDiffManager,
    serviceProxy?: ServiceProxySubsystem | null,
    scriptRuntimeStore?: WorkspaceScriptRuntimeStore | null,
    onBranchChanged?: (
      workspaceId: string,
      oldBranch: string | null,
      newBranch: string | null,
    ) => void,
    getDaemonTcpPort?: () => number | null,
    getDaemonTcpHost?: () => string | null,
    resolveScriptHealth?: (hostname: string) => ScriptHealthState | null,
    workspaceGitService?: WorkspaceGitService,
    github?: ForgeService,
    pushNotificationSender?: PushNotificationSender,
    providerSnapshotManager?: ProviderSnapshotManager,
    daemonRuntimeConfig?: DaemonRuntimeConfig,
    serviceProxyPublicBaseUrl?: string | null,
    browserToolsBroker?: BrowserToolsBroker | null,
    hubRelationships?: HubRelationshipManagement | null,
    workspaceSetupRuntime: WorkspaceSetupRuntime = new WorkspaceSetupRuntime(),
    pluginRuntime?: SessionOptions["pluginRuntime"],
    orchestrationSkills?: SessionOptions["orchestrationSkills"],
    workspaceLabelService?: WorkspaceLabelService,
    enterpriseRuntime?: EnterpriseAdmissionRuntime,
    enterpriseWorkspaceFilesProvider?: EnterpriseWorkspaceFilesProductionProvider,
    enterpriseDispatcher?: EnterpriseSessionDispatcher,
    enterpriseIdentitySelfAuthorization?: SessionOptions["enterpriseIdentitySelfAuthorization"],
    enterpriseFeatureFlags?: EnterpriseFeatureAdvertisement,
    enterpriseDispatcherFactory?: EnterpriseSessionDispatcherFactory,
  ) {
    this.logger = logger.child({ module: "websocket-server" });
    this.workspaceSetupRuntime = workspaceSetupRuntime;
    this.enterpriseRuntime = enterpriseRuntime;
    this.enterpriseWorkspaceFilesProvider = enterpriseWorkspaceFilesProvider;
    this.enterpriseDispatcher = enterpriseDispatcher;
    this.enterpriseIdentitySelfAuthorization = enterpriseIdentitySelfAuthorization;
    this.enterpriseFeatureFlags = enterpriseFeatureFlags;
    this.enterpriseDispatcherFactory = enterpriseDispatcherFactory;
    this.advertiseDaemonStatusRpc = wsConfig.daemonStatusRpc !== false;
    this.advertiseRelayConfig = wsConfig.relayConfig !== false;
    this.connectionLifecycle = wsConfig.startPaused === true ? "starting" : "accepting";
    this.serverId = serverId;
    if (typeof daemonVersion !== "string" || daemonVersion.trim().length === 0) {
      throw new MissingDaemonVersionError();
    }
    this.daemonVersion = daemonVersion.trim();
    this.daemonRuntimeConfig = daemonRuntimeConfig;
    this.browserToolsBroker = browserToolsBroker ?? null;
    this.hubRelationships = hubRelationships ?? null;
    this.pluginRuntime = pluginRuntime;
    this.orchestrationSkills = orchestrationSkills;
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.agentRequests = new AgentRequests(join(paseoHome, "agent-requests"));
    this.projectRegistry = projectRegistry ?? createNoopProjectRegistry();
    this.workspaceRegistry = workspaceRegistry ?? createNoopWorkspaceRegistry();
    this.workspaceLabelService = workspaceLabelService ?? null;
    const requiredServices = requireWebSocketServices({
      scheduleService,
      checkoutDiffManager,
    });
    this.scheduleService = requiredServices.scheduleService;
    this.checkoutDiffManager = requiredServices.checkoutDiffManager;
    this.github = github ?? createGitHubService();
    this.workspaceGitService = workspaceGitService ?? createFallbackWorkspaceGitService();
    this.workspaceAutoName = workspaceAutoName;
    this.downloadTokenStore = downloadTokenStore;
    this.paseoHome = paseoHome;
    this.worktreesRoot = daemonRuntimeConfig?.worktreesRoot;
    this.daemonConfigStore = daemonConfigStore;
    this.mcpBaseUrl = mcpBaseUrl;
    this.assignOptionalServices({
      speech,
      terminalManager,
      dictation,
      onLifecycleIntent,
      serviceProxy,
      scriptRuntimeStore,
      onBranchChanged,
      getDaemonTcpPort,
      getDaemonTcpHost,
      serviceProxyPublicBaseUrl,
      resolveScriptHealth,
    });
    if (!providerSnapshotManager) {
      throw new Error("providerSnapshotManager is required");
    }
    this.providerSnapshotManager = providerSnapshotManager;
    this.serverCapabilities = buildServerCapabilities({
      readiness: this.speech?.getReadiness() ?? null,
    });
    this.unsubscribeSpeechReadiness =
      this.speech?.onReadinessChange((snapshot) => {
        this.publishSpeechReadiness(snapshot);
      }) ?? null;
    const unsubscribeProviderConfig = attachMutableProviderConfigOwner({
      store: this.daemonConfigStore,
      providerSnapshotManager: this.providerSnapshotManager,
      updateProviderRegistry: (state) => this.agentManager.updateProviderRegistry(state),
    });
    const unsubscribeChange = this.daemonConfigStore.onChange((config) => {
      this.broadcastDaemonConfigChanged(config);
    });
    this.unsubscribeDaemonConfigChange = () => {
      unsubscribeProviderConfig();
      unsubscribeChange();
    };

    const pushLogger = this.logger.child({ module: "push" });
    this.pushNotifications = createPushNotifications({
      logger: pushLogger,
      filePath: join(paseoHome, "push-tokens.json"),
    });
    this.pushNotificationSender = pushNotificationSender ?? this.pushNotifications;

    this.agentManager.setAgentAttentionCallback((params) => {
      void this.broadcastAgentAttention(params).catch((err) => {
        this.logger.warn({ err, agentId: params.agentId }, "Failed to broadcast agent attention");
      });
    });

    this.providerUsageService = new ProviderUsageService({
      logger: this.logger,
    });

    this.wss = this.createWebSocketServer(server, wsConfig, auth);
    this.startRuntimeMetricsInterval();
    this.startApplicationSocketLeaseInterval();

    this.logger.info("WebSocket server initialized on /ws");
  }

  private assignOptionalServices(params: {
    speech: SpeechService | null | undefined;
    terminalManager: TerminalManager | null | undefined;
    dictation: { finalTimeoutMs?: number } | undefined;
    onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | undefined;
    serviceProxy: ServiceProxySubsystem | null | undefined;
    scriptRuntimeStore: WorkspaceScriptRuntimeStore | null | undefined;
    onBranchChanged:
      | ((workspaceId: string, oldBranch: string | null, newBranch: string | null) => void)
      | undefined;
    getDaemonTcpPort: (() => number | null) | undefined;
    getDaemonTcpHost: (() => string | null) | undefined;
    serviceProxyPublicBaseUrl: string | null | undefined;
    resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | undefined;
  }): void {
    this.speech = params.speech ?? null;
    this.terminalManager = params.terminalManager ?? null;
    if (this.terminalManager) {
      this.unsubscribeTerminalActivity = this.terminalManager.subscribeTerminalActivity((event) => {
        const reason = resolveTerminalAttentionReason({
          attentionReason: event.activity?.attentionReason,
          previousState: event.previous?.state ?? null,
          state: event.activity?.state ?? null,
        });
        if (!reason) {
          return;
        }
        void this.broadcastTerminalAttention({
          terminalId: event.terminalId,
          cwd: event.cwd,
          ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
          terminalName: event.name,
          reason,
        }).catch((err) => {
          this.logger.warn(
            { err, terminalId: event.terminalId },
            "Failed to broadcast terminal attention",
          );
        });
      });
    }
    this.dictation = params.dictation ?? null;
    this.onLifecycleIntent = params.onLifecycleIntent ?? null;
    this.serviceProxy = params.serviceProxy ?? null;
    this.scriptRuntimeStore = params.scriptRuntimeStore ?? null;
    this.onBranchChanged = params.onBranchChanged ?? null;
    this.getDaemonTcpPort = params.getDaemonTcpPort ?? null;
    this.getDaemonTcpHost = params.getDaemonTcpHost ?? null;
    this.serviceProxyPublicBaseUrl = params.serviceProxyPublicBaseUrl ?? null;
    this.resolveScriptHealth = params.resolveScriptHealth ?? null;
  }

  private createWebSocketServer(
    server: HTTPServer,
    wsConfig: WebSocketServerConfig,
    auth: DaemonAuthConfig | undefined,
  ): WebSocketServer {
    const password = auth?.password;
    const wss = new WebSocketServer({
      server,
      path: "/ws",
      handleProtocols: (protocols) => selectWebSocketProtocol(protocols, password),
      verifyClient: ({ req }, callback) => {
        this.verifyWsUpgrade(
          req,
          wsConfig.getAllowedOrigins?.() ?? wsConfig.allowedOrigins ?? new Set(),
          wsConfig.getHostnames?.() ?? wsConfig.hostnames,
          callback,
        );
      },
    });
    wss.on("connection", (ws, request) => {
      const task = this.attachAuthenticatedSocket(ws, request, password);
      this.authenticationTasks.set(ws, task);
      void task.then(
        () => this.authenticationTasks.delete(ws),
        () => this.authenticationTasks.delete(ws),
      );
    });
    return wss;
  }

  private startRuntimeMetricsInterval(): void {
    this.eventLoopDelayMonitor = monitorEventLoopDelay({ resolution: 10 });
    this.eventLoopDelayMonitor.enable();
    const runtimeMetricsInterval = setInterval(() => {
      this.flushRuntimeMetrics();
    }, WS_RUNTIME_METRICS_FLUSH_MS);
    this.runtimeMetricsInterval = runtimeMetricsInterval;
    (runtimeMetricsInterval as unknown as { unref?: () => void }).unref?.();
  }

  private startApplicationSocketLeaseInterval(): void {
    const interval = setInterval(() => {
      for (const ws of this.applicationSocketLease.listExpired()) {
        this.closePhysicalSocket({
          ws,
          logMessage: "Closing physical WebSocket with expired application lease",
        });
      }
    }, APPLICATION_SOCKET_LEASE_CHECK_INTERVAL_MS);
    this.applicationSocketLeaseInterval = interval;
    (interval as unknown as { unref?: () => void }).unref?.();
  }

  // Main-loop stall visibility: terminal frames and agent traffic share one event
  // loop, so delay percentiles here are the ground truth for "the daemon is busy".
  private snapshotEventLoopDelay(): { p50Ms: number; p99Ms: number; maxMs: number } | null {
    const monitor = this.eventLoopDelayMonitor;
    if (!monitor) {
      return null;
    }
    const toMs = (nanoseconds: number): number => Math.round(nanoseconds / 1e5) / 10;
    const snapshot = {
      p50Ms: toMs(monitor.percentile(50)),
      p99Ms: toMs(monitor.percentile(99)),
      maxMs: toMs(monitor.max),
    };
    monitor.reset();
    return snapshot;
  }

  private verifyWsUpgrade(
    req: IncomingMessage,
    allowedOrigins: Set<string>,
    hostnames: HostnamesConfig | undefined,
    callback: (res: boolean, code?: number, message?: string) => void,
  ): void {
    if (this.connectionLifecycle !== "accepting") {
      callback(false, 503, "Server not ready");
      return;
    }

    const requestMetadata = extractSocketRequestMetadata(req);
    const origin = requestMetadata.origin;
    const requestHost = requestMetadata.host ?? null;
    if (requestHost && !isHostnameAllowed(requestHost, hostnames)) {
      this.incrementRuntimeCounter("hostRejected");
      this.logger.warn(
        { ...requestMetadata, host: requestHost },
        "Rejected connection from disallowed host",
      );
      callback(false, 403, "Host not allowed");
      return;
    }
    const sameOrigin = isWebSocketSameOrigin(origin, requestHost);

    if (!origin || allowedOrigins.has("*") || allowedOrigins.has(origin) || sameOrigin) {
      callback(true);
    } else {
      this.incrementRuntimeCounter("originRejected");
      this.logger.warn({ ...requestMetadata, origin }, "Rejected connection from origin");
      callback(false, 403, "Origin not allowed");
    }
  }

  private async attachAuthenticatedSocket(
    ws: WebSocket,
    request: IncomingMessage,
    password: string | undefined,
  ): Promise<void> {
    try {
      await this.attachAuthenticatedSocketImpl(ws, request, password);
    } catch (error) {
      this.logger.warn({ err: error }, "WebSocket authentication failed unexpectedly");
      safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise authentication failed");
    }
  }

  private async attachAuthenticatedSocketImpl(
    ws: WebSocket,
    request: IncomingMessage,
    password: string | undefined,
  ): Promise<void> {
    if (this.enterpriseRuntime) {
      const protocol = extractWsBearerProtocol(request.headers["sec-websocket-protocol"]);
      const token = extractWsBearerToken(protocol);
      const metadata = extractSocketRequestMetadata(request);
      if (!token) {
        ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise authentication required");
        return;
      }
      const authorizationEvidence = await this.enterpriseRuntime.admission.authenticateEvidence(
        token,
        {
          node: this.enterpriseRuntime.node,
          transport: "direct",
          peer: resolveConnectionPeer(extractSocketRequestMetadata(request), undefined),
          ...(metadata.origin ? { origin: metadata.origin } : {}),
          ...(metadata.remoteAddress ? { remoteAddress: metadata.remoteAddress } : {}),
          ...(metadata.userAgent ? { userAgent: metadata.userAgent } : {}),
        },
      );
      if (ws.readyState !== 1 || this.connectionLifecycle === "stopping") {
        return;
      }
      if (!authorizationEvidence) {
        ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise authentication failed");
        return;
      }
      await this.attachSocket(
        ws,
        request,
        undefined,
        false,
        { kind: "enterprise", authorizationEvidence },
        undefined,
        authorizationEvidence,
      );
      return;
    }
    if (password) {
      const requestMetadata = extractSocketRequestMetadata(request);
      const protocol = extractWsBearerProtocol(request.headers["sec-websocket-protocol"]);
      const token = extractWsBearerToken(protocol);
      const isAuthorized = isBearerTokenValid({ password, token });
      if (!isAuthorized) {
        const reason = token === null ? "Password required" : "Incorrect password";
        this.logger.warn(
          { ...requestMetadata, hasToken: token !== null },
          "Rejected WebSocket connection with invalid daemon password",
        );
        ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, reason);
        return;
      }
    }

    await this.attachSocket(ws, request);
  }

  public broadcast(message: WSOutboundMessage): void {
    if (message.type === "session") {
      for (const connection of new Set(this.sessions.values())) {
        connection.session.publish(message.message);
      }
      return;
    }
    this.sendMessageToSockets(this.sessions.keys(), message);
  }

  public listSessions(): Session[] {
    return Array.from(
      new Set(
        [...this.sessions.values(), ...this.externalSessionsByKey.values()].map(
          (connection) => connection.session,
        ),
      ),
    );
  }

  public publishProjectUpdate(update: ProjectUpdate): void {
    for (const session of this.listSessions()) {
      void session
        .emitProjectUpdate(update)
        .catch((error) => this.logger.warn({ err: error }, "Failed to publish project update"));
    }
  }

  public publishSpeechReadiness(readiness: SpeechReadinessSnapshot | null): void {
    this.updateServerCapabilities(buildServerCapabilities({ readiness }));
  }

  public updateServerCapabilities(capabilities: ServerCapabilities | null | undefined): void {
    const next = capabilities ?? undefined;
    if (areServerCapabilitiesEqual(this.serverCapabilities, next)) {
      return;
    }
    this.serverCapabilities = next;
    this.broadcastCapabilitiesUpdate();
  }

  public async attachExternalSocket(
    ws: WebSocketLike,
    metadata?: ExternalSocketMetadata,
    admission: SessionAdmission = OWNER_SESSION_ADMISSION,
    initialHello?: WSHelloMessage,
  ): Promise<void> {
    // Enterprise external admission is established by the authenticated
    // WebSocket path.  This public bridge must never inspect caller supplied
    // admission objects: relay/hub callers are untrusted and may provide a
    // throwing Proxy or structural authority substitute.
    if (this.enterpriseRuntime) {
      safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise admission required");
      return;
    }
    const authorizationEvidence =
      admission.kind === "enterprise" && "authorizationEvidence" in admission
        ? admission.authorizationEvidence
        : undefined;
    if (metadata?.transport === "relay") {
      this.incrementRuntimeCounter("relayExternalSocketAttached");
    }
    await this.attachSocket(
      ws,
      undefined,
      metadata,
      false,
      admission,
      initialHello,
      authorizationEvidence,
    );
  }

  public async attachPluginSocket(
    pluginId: string,
    ws: WebSocketLike,
  ): Promise<{ closed: Promise<void> }> {
    if (this.connectionLifecycle === "stopping") {
      throw new Error(`Cannot attach plugin session while shutting down: ${pluginId}`);
    }
    let resolve: () => void = () => undefined;
    const closed = new Promise<void>((finish) => {
      resolve = finish;
    });
    this.pluginSocketIds.set(ws, pluginId);
    this.pluginSocketCleanup.set(ws, resolve);
    try {
      await this.attachSocket(ws, undefined, undefined, true);
    } catch (error) {
      this.pluginSocketIds.delete(ws);
      this.finishPluginSocketCleanup(ws);
      throw error;
    }
    return { closed };
  }

  public updatePrincipalPermissions(
    principalId: string,
    permissions: readonly DaemonPermission[],
  ): void {
    for (const pending of this.pendingConnections.values()) {
      if (pending.admission.principalId === principalId) {
        pending.admission = { ...pending.admission, permissions };
      }
    }
    for (const connection of new Set(this.externalSessionsByKey.values())) {
      if (connection.principalId === principalId) {
        connection.session.setPermissions(permissions);
        this.syncBrowserToolsClientRegistration(connection);
      }
    }
  }

  public prepareForShutdown(): void {
    this.connectionLifecycle = "stopping";
  }

  public beginAcceptingConnections(): void {
    if (this.connectionLifecycle === "starting") {
      this.connectionLifecycle = "accepting";
    }
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (reason: unknown) => void;
    this.closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const initialErrors: unknown[] = [];
    if (this.connectionLifecycle !== "stopping") {
      try {
        this.prepareForShutdown();
      } catch (error) {
        initialErrors.push(error);
      }
    }
    void this.closeImpl(initialErrors).then(resolveClose, rejectClose);
    return this.closePromise;
  }

  private async closeImpl(initialErrors: readonly unknown[]): Promise<void> {
    const errors: unknown[] = [];
    const appendError = (error: unknown): void => {
      if (error instanceof AggregateError) {
        for (const nested of error.errors) appendError(nested);
        return;
      }
      if (!errors.includes(error)) errors.push(error);
    };
    for (const error of initialErrors) appendError(error);
    const captureSync = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        appendError(error);
      }
    };
    captureSync(() => this.unsubscribeSpeechReadiness?.());
    this.unsubscribeSpeechReadiness = null;
    captureSync(() => this.unsubscribeDaemonConfigChange?.());
    this.unsubscribeDaemonConfigChange = null;
    captureSync(() => this.unsubscribeTerminalActivity?.());
    this.unsubscribeTerminalActivity = null;
    if (this.runtimeMetricsInterval) {
      clearInterval(this.runtimeMetricsInterval);
      this.runtimeMetricsInterval = null;
    }
    if (this.applicationSocketLeaseInterval) {
      clearInterval(this.applicationSocketLeaseInterval);
      this.applicationSocketLeaseInterval = null;
    }
    captureSync(() => this.applicationSocketLease.clear());
    captureSync(() => this.flushRuntimeMetrics({ final: true }));
    captureSync(() => this.eventLoopDelayMonitor?.disable());
    this.eventLoopDelayMonitor = null;

    const uniqueConnections = new Set<SessionConnection>([
      ...this.sessions.values(),
      ...this.externalSessionsByKey.values(),
    ]);

    const pendingSockets = new Set<WebSocketLike>([
      ...this.pendingConnections.keys(),
      ...this.handshakeConnections.keys(),
      ...this.authenticationTasks.keys(),
      ...this.pendingMessageTasks.keys(),
    ]);
    for (const pending of this.pendingConnections.values()) {
      if (pending.helloTimeout) {
        clearTimeout(pending.helloTimeout);
        pending.helloTimeout = null;
      }
    }

    const cleanupPromises: Promise<void>[] = [];
    const connectionCleanupErrors: unknown[] = [];
    for (const connection of uniqueConnections) {
      if (connection.lifecycle === "reconnectable" && connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
        connection.externalDisconnectCleanupTimeout = null;
      }

      this.releaseEnterpriseAuthorization(connection);

      cleanupPromises.push(
        Promise.resolve()
          .then(() => this.cleanupConnection(connection, "Server closing session"))
          .catch((error) => {
            if (!connectionCleanupErrors.includes(error)) connectionCleanupErrors.push(error);
          }),
      );
      for (const ws of connection.sockets) {
        cleanupPromises.push(
          new Promise<void>((resolve) => {
            // WebSocket.CLOSED = 3
            if (ws.readyState === 3) {
              resolve();
              return;
            }
            ws.once("close", () => resolve());
            try {
              ws.close();
            } catch (error) {
              appendError(error);
              resolve();
            }
          }),
        );
      }
    }

    for (const ws of pendingSockets) {
      cleanupPromises.push(
        new Promise<void>((resolve) => {
          if (ws.readyState === 3) {
            resolve();
            return;
          }
          ws.once("close", () => resolve());
          try {
            ws.close();
          } catch (error) {
            appendError(error);
            resolve();
          }
        }),
      );
    }

    await Promise.all(cleanupPromises);
    await Promise.all(this.authenticationTasks.values());
    await Promise.all(this.pendingMessageTasks.values());
    for (const error of this.pendingMessageErrors.values()) appendError(error);
    for (const error of connectionCleanupErrors) appendError(error);
    await Promise.resolve()
      .then(() => this.providerSnapshotManager.destroy())
      .catch((e) => appendError(e));
    await Promise.resolve()
      .then(() => this.checkoutDiffManager.dispose())
      .catch((e) => appendError(e));
    await Promise.resolve()
      .then(() => this.workspaceGitService.dispose())
      .catch((e) => appendError(e));
    this.pendingConnections.clear();
    this.handshakeConnections.clear();
    this.authenticationTasks.clear();
    this.pendingMessageTasks.clear();
    this.pendingMessageErrors.clear();
    this.handshakeLocks.clear();
    this.sessions.clear();
    this.socketIdentities.clear();
    this.externalSessionsByKey.clear();
    this.externalSessionsByBaseKey.clear();
    for (const clientId of this.browserToolsRegistrations.keys()) {
      try {
        this.unregisterBrowserToolsClient(clientId);
      } catch (error) {
        appendError(error);
      }
    }
    await Promise.resolve()
      .then(() => this.wss.close())
      .catch((e) => appendError(e));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "websocket close failed", { cause: errors[0] });
  }

  private sendToClient(ws: WebSocketLike, message: WSOutboundMessage): void {
    this.sendMessageToSockets([ws], message);
  }

  private sendMessageToSockets(sockets: Iterable<WebSocketLike>, message: WSOutboundMessage): void {
    const writableSockets = [...sockets].filter((ws) => this.ensureOutboundCapacity(ws, 0));
    if (writableSockets.length === 0) {
      return;
    }

    let payload: string;
    try {
      payload = JSON.stringify(message);
    } catch (err) {
      this.logger.warn({ err }, "ws_serialize_failed");
      return;
    }

    const payloadBytes = outboundFrameByteLength(payload);
    for (const ws of writableSockets) {
      this.sendFrameToClient(ws, payload, payloadBytes, () => {
        this.runtimeMetrics.recordOutboundMessage(message, ws.bufferedAmount);
      });
    }
  }

  private sendBinaryToClient(ws: WebSocketLike, frame: Uint8Array): void {
    this.sendFrameToClient(ws, frame, outboundFrameByteLength(frame), () => {
      this.runtimeMetrics.recordOutboundBinaryFrame(ws.bufferedAmount);
    });
  }

  private async sendBinaryToClientAndWait(ws: WebSocketLike, frame: Uint8Array): Promise<void> {
    try {
      const sent = await sendBoundedPhysicalFrameAndWait({
        socket: ws,
        frame,
        onHighWater: () => this.closeAtOutboundHighWater(ws),
      });
      if (!sent) {
        throw new Error("Physical WebSocket is not open");
      }
      this.runtimeMetrics.recordOutboundBinaryFrame(ws.bufferedAmount);
    } catch (err) {
      this.logger.warn({ err }, "ws_send_failed");
      throw err;
    }
  }

  private sendFrameToClient(
    ws: WebSocketLike,
    frame: string | Uint8Array,
    frameBytes: number,
    recordSent: () => void,
  ): void {
    try {
      const sent = sendBoundedPhysicalFrame({
        socket: ws,
        frame,
        frameBytes,
        onHighWater: () => this.closeAtOutboundHighWater(ws),
      });
      if (sent) recordSent();
    } catch (err) {
      this.logger.warn({ err }, "ws_send_failed");
    }
  }

  private ensureOutboundCapacity(ws: WebSocketLike, frameBytes: number): boolean {
    if (ws.readyState !== 1) return false;
    if (physicalSocketHasCapacity(ws, frameBytes)) return true;

    this.closeAtOutboundHighWater(ws);
    return false;
  }

  private closeAtOutboundHighWater(ws: WebSocketLike): void {
    this.closePhysicalSocket({
      ws,
      logMessage: "Closing physical WebSocket at outbound high-water mark",
      logFields: {
        bufferedAmount: ws.bufferedAmount,
        maxBufferedBytes: MAX_PHYSICAL_SOCKET_BUFFERED_BYTES,
      },
    });
  }

  private closePhysicalSocket(params: ClosePhysicalSocketParams): void {
    const { ws, logMessage, logFields } = params;
    this.applicationSocketLease.release(ws);
    if (ws.readyState !== 1) {
      return;
    }
    const identity = this.socketIdentities.get(ws);
    this.logger.warn(
      {
        ...(identity ? toConnectionLogFields(identity) : {}),
        ...logFields,
      },
      logMessage,
    );
    try {
      // A close frame queues behind application data, so it cannot enforce a
      // hard memory cutoff. Production transports expose terminate().
      if (ws.terminate) {
        ws.terminate();
      } else {
        ws.close();
      }
    } catch (err) {
      this.logger.warn(
        { err, ...(identity ? toConnectionLogFields(identity) : {}) },
        "ws_close_failed",
      );
    }
  }

  private sendToConnection(connection: SessionConnection, message: WSOutboundMessage): void {
    this.sendMessageToSockets(connection.sockets, message);
  }

  private sendBinaryToConnection(connection: SessionConnection, frame: Uint8Array): void {
    for (const ws of connection.sockets) {
      this.sendBinaryToClient(ws, frame);
    }
  }

  // oxlint-disable-next-line complexity -- admission canonicalization and lifecycle setup.
  private async attachSocket(
    ws: WebSocketLike,
    request?: unknown,
    metadata?: ExternalSocketMetadata,
    allowDuringStartup = false,
    admission: SessionAdmission = OWNER_SESSION_ADMISSION,
    initialHello?: WSHelloMessage,
    authorizationEvidence?: EnterpriseAdmissionAuthenticationEvidence,
  ): Promise<void> {
    if (
      ws.readyState !== 1 ||
      (this.enterpriseRuntime && (!authorizationEvidence || admission.kind !== "enterprise")) ||
      (!this.enterpriseRuntime && authorizationEvidence)
    ) {
      safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Invalid enterprise admission");
      return;
    }
    try {
      admission = freezeAdmission(admission);
      if (admission.enterprise && admission.enterprise.runtime !== this.enterpriseRuntime)
        throw new Error("enterprise runtime mismatch");
      if (
        admission.enterprise &&
        admission.enterprise.grantVersionGuard !== admission.enterprise.runtime.grantVersionGuard
      )
        throw new Error("enterprise grant guard mismatch");
      if (admission.enterprise && this.enterpriseRuntime) {
        const n = admission.enterprise.node;
        const r = this.enterpriseRuntime.node;
        if (n.nodeId !== r.nodeId || n.paseoServerId !== r.paseoServerId || n.mode !== r.mode)
          throw new Error("enterprise node mismatch");
        admission = freezeAdmission({
          ...admission,
          enterprise: { ...admission.enterprise, node: r },
        });
      }
      if (
        admission.enterprise &&
        admission.principalId !== admission.enterprise.principal.principalId
      )
        throw new Error("enterprise principal mismatch");
    } catch {
      ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Invalid admission");
      return;
    }
    if (
      this.connectionLifecycle === "stopping" ||
      (this.connectionLifecycle === "starting" && !allowDuringStartup)
    ) {
      try {
        ws.close(WS_CLOSE_SERVER_SHUTDOWN, "Server shutting down");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestMetadata = extractSocketRequestMetadata(request);
    const identity = createWebSocketConnectionIdentity(requestMetadata, metadata);
    this.socketIdentities.set(ws, identity);
    const connectionLogger = this.logger.child(toConnectionLogFields(identity));

    const pending: PendingConnection = {
      connectionLogger,
      helloTimeout: null,
      identity,
      admission,
      ...(authorizationEvidence ? { authorizationEvidence } : {}),
    };
    const timeout = setTimeout(() => {
      if (this.pendingConnections.get(ws) !== pending) {
        return;
      }
      pending.helloTimeout = null;
      this.pendingConnections.delete(ws);
      pending.connectionLogger.warn(
        { ...toConnectionLogFields(identity), timeoutMs: HELLO_TIMEOUT_MS },
        "Closing connection due to missing hello",
      );
      try {
        ws.close(WS_CLOSE_HELLO_TIMEOUT, "Hello timeout");
      } catch {
        // ignore close errors
      }
    }, HELLO_TIMEOUT_MS);
    pending.helloTimeout = timeout;
    (timeout as unknown as { unref?: () => void }).unref?.();

    this.pendingConnections.set(ws, pending);
    this.incrementRuntimeCounter("connectedAwaitingHello");
    this.bindSocketHandlers(ws);

    pending.connectionLogger.info(
      {
        ...toConnectionLogFields(identity),
        totalPendingConnections: this.pendingConnections.size,
      },
      "Client connected; awaiting hello",
    );
    if (initialHello) {
      this.handlePendingConnectionMessage({
        ws,
        message: initialHello,
        pendingConnection: pending,
      });
    }
  }

  private createSessionConnection(params: {
    ws: WebSocketLike;
    clientId: string;
    appVersion: string | null;
    clientCapabilities: Record<string, unknown> | null;
    connectionLogger: pino.Logger;
    lifecycle: { kind: "reconnectable" } | { kind: "ephemeral-plugin"; pluginId: string };
    admission: Exclude<SessionAdmission, { authorizationEvidence: unknown }>;
    enterpriseAuthorizationHandle?: EnterpriseAdmissionAuthorizationHandle;
    sessionId?: string;
    sessionAuthorization?: SessionAuthorization;
    enterpriseAuthorizationRuntime?: ProductionAuthorizationRuntime;
    onEnterpriseWorkspaceRuntimeConstructionFailure?: (
      runtime: EnterpriseWorkspaceFilesRuntime,
    ) => void;
  }): SessionConnection {
    const {
      ws,
      clientId,
      appVersion,
      clientCapabilities,
      connectionLogger,
      lifecycle,
      admission,
      sessionId,
      sessionAuthorization,
      enterpriseAuthorizationRuntime,
      onEnterpriseWorkspaceRuntimeConstructionFailure,
    } = params;
    let connection: SessionConnection | null = null;
    const enterpriseWorkspaceFilesRuntime =
      enterpriseAuthorizationRuntime && this.enterpriseWorkspaceFilesProvider
        ? this.enterpriseWorkspaceFilesProvider.createSessionRuntime(enterpriseAuthorizationRuntime)
        : undefined;
    if (
      enterpriseAuthorizationRuntime &&
      this.enterpriseWorkspaceFilesProvider &&
      !enterpriseWorkspaceFilesRuntime
    ) {
      throw new Error("Enterprise workspace files runtime unavailable");
    }

    let session: Session;
    try {
      session = this.createSocketSession({
        clientId,
        appVersion,
        clientCapabilities,
        permissions: Object.freeze([...admission.permissions]),
        connectionLogger,
        onMessage: (msg) => {
          if (!connection) {
            return;
          }
          this.sendToConnection(connection, wrapSessionMessage(msg));
        },
        onMessageToSource: (source, msg) => {
          if (!connection || !connection.sockets.has(source as WebSocketLike)) {
            return;
          }
          this.sendToClient(source as WebSocketLike, wrapSessionMessage(msg));
        },
        onBinaryMessage: (frame) => {
          if (!connection) {
            return;
          }
          this.sendBinaryToConnection(connection, frame);
        },
        onBinaryMessageToSource: async (source, frame) => {
          if (!connection || !connection.sockets.has(source as WebSocketLike)) {
            throw new Error("File transfer source socket is no longer attached");
          }
          await this.sendBinaryToClientAndWait(source as WebSocketLike, frame);
        },
        getTransportBufferedAmount: () => {
          if (!connection) {
            return null;
          }
          // Relay-attached sockets are a WebSocketLike that doesn't expose
          // bufferedAmount. Return null when no socket gives a signal so the
          // terminal fallback can't mistake "no signal" for "client keeping up";
          // a direct ws reports its real buffered bytes (0 when drained).
          let maxBuffered: number | null = null;
          for (const socket of connection.sockets) {
            if (typeof socket.bufferedAmount === "number") {
              maxBuffered = Math.max(maxBuffered ?? 0, socket.bufferedAmount);
            }
          }
          return maxBuffered;
        },
        onLifecycleIntent: (intent) => {
          this.onLifecycleIntent?.(intent);
        },
        hubExecutionAgents: admission.hubExecutionAgents,
        hubRelationships: this.hubRelationships ?? undefined,
        enterprise: admission.enterprise,
        ...(enterpriseWorkspaceFilesRuntime ? { enterpriseWorkspaceFilesRuntime } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionAuthorization ? { sessionAuthorization } : {}),
        ...(enterpriseAuthorizationRuntime ? { enterpriseAuthorizationRuntime } : {}),
        ...(this.enterpriseRuntime && params.enterpriseAuthorizationHandle
          ? { admissionAuthorizationIssuer: this.enterpriseRuntime.admission.authorizationIssuer }
          : {}),
        ...(params.enterpriseAuthorizationHandle
          ? { admissionAuthorizationHandle: params.enterpriseAuthorizationHandle }
          : {}),
      });
    } catch (error) {
      if (enterpriseWorkspaceFilesRuntime) {
        onEnterpriseWorkspaceRuntimeConstructionFailure?.(enterpriseWorkspaceFilesRuntime);
      }
      throw error;
    }

    const base: SessionConnectionBase = {
      session,
      principalId: admission.principalId,
      sessionKey: sessionConnectionKey(
        admission.principalId,
        clientId,
        admission.enterprise?.principal,
      ),
      clientId,
      appVersion,
      clientCapabilities,
      connectionLogger,
      sockets: new Set([ws]),
      ...(params.enterpriseAuthorizationHandle
        ? { enterpriseAuthorizationHandle: params.enterpriseAuthorizationHandle }
        : {}),
    };
    connection =
      lifecycle.kind === "ephemeral-plugin"
        ? { ...base, lifecycle: "ephemeral-plugin", pluginId: lifecycle.pluginId }
        : { ...base, lifecycle: "reconnectable", externalDisconnectCleanupTimeout: null };
    session.updateClientCapabilities(clientCapabilities, ws);
    return connection;
  }

  private createSocketSession(options: SocketSessionOptions): Session {
    return new Session({
      clientId: options.clientId,
      ...(options.enterprise
        ? {
            enterpriseContext: {
              principal: options.enterprise.principal,
              node: options.enterprise.node,
              sessionBindingGeneration: options.enterprise.runtime.nextSessionBindingGeneration(),
            },
            enterpriseAgentContextRegistry: options.enterprise.runtime.agentContextRegistry,
            authorityReceiptState: options.enterprise.runtime.authorityReceiptState,
            principalGrantVersionGuard: options.enterprise.runtime.grantVersionGuard,
            resourceAuthorization: options.enterprise.runtime.resourceAuthorization,
          }
        : {}),
      ...(options.enterpriseWorkspaceFilesRuntime
        ? { enterpriseWorkspaceFilesRuntime: options.enterpriseWorkspaceFilesRuntime }
        : {}),
      ...(this.enterpriseDispatcher ? { enterpriseDispatcher: this.enterpriseDispatcher } : {}),
      ...(this.enterpriseIdentitySelfAuthorization
        ? { enterpriseIdentitySelfAuthorization: this.enterpriseIdentitySelfAuthorization }
        : {}),
      ...(this.enterpriseDispatcherFactory
        ? { enterpriseDispatcherFactory: this.enterpriseDispatcherFactory }
        : {}),
      appVersion: options.appVersion,
      clientCapabilities: options.clientCapabilities,
      permissions: options.permissions,
      onMessage: options.onMessage,
      onMessageToSource: options.onMessageToSource,
      onBinaryMessage: options.onBinaryMessage,
      onBinaryMessageToSource: options.onBinaryMessageToSource,
      getTransportBufferedAmount: options.getTransportBufferedAmount,
      onLifecycleIntent: options.onLifecycleIntent,
      logger: options.connectionLogger.child({ module: "session" }),
      onWorkspaceRecovered: async (workspace) => {
        await Promise.all(
          this.listSessions().map((activeSession) =>
            activeSession.refreshRecoveredWorkspaceForExternalMutation(workspace),
          ),
        );
      },
      downloadTokenStore: this.downloadTokenStore,
      pushNotifications: this.pushNotifications,
      paseoHome: this.paseoHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      agentRequests: this.agentRequests,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      workspaceLabelService: this.workspaceLabelService ?? undefined,
      directorySync: this.directorySync,
      scheduleService: this.scheduleService,
      checkoutDiffManager: this.checkoutDiffManager,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      workspaceAutoName: this.workspaceAutoName,
      daemonConfigStore: this.daemonConfigStore,
      pluginRuntime: this.pluginRuntime,
      orchestrationSkills: this.orchestrationSkills,
      mcpBaseUrl: this.mcpBaseUrl,
      stt: () => this.speech?.resolveStt() ?? null,
      sttLanguage: this.speech?.resolveSttLanguage() ?? "en",
      tts: () => this.speech?.resolveTts() ?? null,
      terminalManager: this.terminalManager,
      providerSnapshotManager: this.providerSnapshotManager,
      providerUsageService: this.providerUsageService,
      hubExecutionAgents: options.hubExecutionAgents,
      hubRelationships: options.hubRelationships,
      serviceProxy: this.serviceProxy ?? undefined,
      scriptRuntimeStore: this.scriptRuntimeStore ?? undefined,
      workspaceSetupSnapshots: this.workspaceSetupSnapshots,
      workspaceSetupRuntime: this.workspaceSetupRuntime,
      onBranchChanged: this.onBranchChanged ?? undefined,
      getDaemonTcpPort: this.getDaemonTcpPort ?? undefined,
      getDaemonTcpHost: this.getDaemonTcpHost ?? undefined,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      resolveScriptHealth: this.resolveScriptHealth ?? undefined,
      voice: {
        turnDetection: () => this.speech?.resolveTurnDetection() ?? null,
      },
      voiceBridge: {
        registerVoiceSpeakHandler: (agentId, handler) => {
          this.voiceSpeakHandlers.set(agentId, handler);
        },
        unregisterVoiceSpeakHandler: (agentId) => {
          this.voiceSpeakHandlers.delete(agentId);
        },
        registerVoiceCallerContext: (agentId, context) => {
          this.voiceCallerContexts.set(agentId, context);
        },
        unregisterVoiceCallerContext: (agentId) => {
          this.voiceCallerContexts.delete(agentId);
        },
      },
      dictation:
        this.dictation || this.speech
          ? {
              finalTimeoutMs: this.dictation?.finalTimeoutMs,
              stt: () => this.speech?.resolveDictationStt() ?? null,
              sttLanguage: this.speech?.resolveDictationSttLanguage() ?? "en",
              getSpeechReadiness: () => this.speech!.getReadiness(),
            }
          : undefined,
      serverId: this.serverId,
      daemonVersion: this.daemonVersion,
      daemonRuntimeConfig: this.daemonRuntimeConfig,
      getWebSocketRuntimeMetrics: () => this.lastRuntimeMetricsSnapshot,
    });
  }

  private clearPendingConnection(ws: WebSocketLike): PendingConnection | null {
    const pending = this.pendingConnections.get(ws);
    if (!pending) {
      return null;
    }
    if (pending.helloTimeout) {
      clearTimeout(pending.helloTimeout);
      pending.helloTimeout = null;
    }
    this.pendingConnections.delete(ws);
    return pending;
  }

  private isHandshakeCurrent(ws: WebSocketLike, pending: PendingConnection): boolean {
    return (
      this.connectionLifecycle !== "stopping" &&
      ws.readyState === 1 &&
      this.socketIdentities.get(ws) === pending.identity
    );
  }

  // oxlint-disable-next-line complexity -- protocol validation and enterprise reconnect fence.
  private handleHello(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
  }): Promise<void> {
    if (
      this.pendingConnections.get(params.ws) !== params.pending ||
      params.ws.readyState !== 1 ||
      this.connectionLifecycle === "stopping"
    ) {
      return Promise.resolve();
    }
    const enterprisePrincipal = params.pending.admission.enterprise?.principal;
    const admissionPrincipalId =
      "principalId" in params.pending.admission ? params.pending.admission.principalId : "opaque";
    const fallbackLockKey = `${
      enterprisePrincipal?.organizationId ?? "legacy"
    }:${enterprisePrincipal?.principalId ?? admissionPrincipalId}:${params.message.clientId.trim()}`;
    const lockKey =
      params.pending.authorizationEvidence && this.enterpriseRuntime
        ? (getEnterpriseAdmissionEvidenceLockPartition(
            this.enterpriseRuntime.admission.authorizationIssuer,
            params.pending.authorizationEvidence,
            params.message.clientId.trim(),
          ) ?? fallbackLockKey)
        : fallbackLockKey;
    if (lockKey.length === 0) {
      return this.handleHelloUnlocked(params);
    }
    const prior = this.handshakeLocks.get(lockKey);
    const run = () => this.handleHelloUnlocked(params);
    const task = prior ? prior.then(run, run) : run();
    this.handshakeLocks.set(lockKey, task);
    void task.then(
      () => this.handshakeLocks.get(lockKey) === task && this.handshakeLocks.delete(lockKey),
      () => this.handshakeLocks.get(lockKey) === task && this.handshakeLocks.delete(lockKey),
    );
    return task;
  }

  // oxlint-disable-next-line complexity -- protocol validation and enterprise reconnect fence.
  private async handleHelloUnlocked(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
  }): Promise<void> {
    const { ws, message, pending } = params;

    if (
      (this.pendingConnections.get(ws) !== pending &&
        this.handshakeConnections.get(ws) !== pending) ||
      !this.isHandshakeCurrent(ws, pending)
    ) {
      return;
    }

    if (message.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn(
        {
          receivedProtocolVersion: message.protocolVersion,
          expectedProtocolVersion: WS_PROTOCOL_VERSION,
        },
        "Rejected hello due to protocol version mismatch",
      );
      try {
        ws.close(WS_CLOSE_INCOMPATIBLE_PROTOCOL, "Incompatible protocol version");
      } catch {
        // ignore close errors
      }
      return;
    }

    const clientId = message.clientId.trim();
    if (clientId.length === 0) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn("Rejected hello with empty clientId");
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const pluginId = this.pluginSocketIds.get(ws);
    const expectedPluginClientId = pluginId ? createPluginClientId(pluginId) : null;
    if (
      (expectedPluginClientId !== null && clientId !== expectedPluginClientId) ||
      (expectedPluginClientId === null && isPluginClientId(clientId))
    ) {
      this.clearPendingConnection(ws);
      pending.connectionLogger.warn({ clientId }, "Rejected reserved plugin clientId");
      ws.close(WS_CLOSE_INVALID_HELLO, "Invalid plugin clientId");
      return;
    }

    this.clearPendingConnection(ws);
    this.handshakeConnections.set(ws, pending);
    pending.identity.clientId = clientId;
    if (message.appVersion) {
      pending.identity.appVersion = message.appVersion;
    }
    let admission = pending.admission;
    let enterpriseAuthorizationHandle: EnterpriseAdmissionAuthorizationHandle | undefined;
    let enterpriseAuthorizationRuntime: ProductionAuthorizationRuntime | undefined;
    let sessionAuthorization: SessionAuthorization | undefined;
    let sessionId: string | undefined;
    let sessionKey: string;
    let existing: ReconnectableSessionConnection | undefined;
    if (pending.authorizationEvidence) {
      const runtime = this.enterpriseRuntime;
      if (!runtime) {
        this.handshakeConnections.delete(ws);
        safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise runtime unavailable");
        return;
      }
      const handle = pluginId
        ? runtime.admission.bindSession(pending.authorizationEvidence, clientId)
        : bindOrReplaceEnterpriseAdmissionSession(
            runtime.admission.authorizationIssuer,
            pending.authorizationEvidence,
            clientId,
          );
      const resolved = handle
        ? resolveCurrentEnterpriseAdmissionAuthorization(
            runtime.admission.authorizationIssuer,
            handle,
          )
        : null;
      if (!handle || !resolved) {
        if (handle) {
          runtime.admission.releaseSession(handle);
        }
        this.handshakeConnections.delete(ws);
        safeCloseSocket(
          ws,
          WS_CLOSE_DAEMON_AUTH_FAILED,
          "Enterprise admission is no longer current",
        );
        return;
      }
      enterpriseAuthorizationHandle = handle;
      if (runtime.authorizationRuntimeProvider) {
        sessionAuthorization = new SessionAuthorization(OWNER_PERMISSIONS);
        sessionId = randomUUID();
        const createdAuthorizationRuntime = await createProductionAuthorizationRuntimeForSession(
          runtime.authorizationRuntimeProvider,
          {
            admissionAuthorizationIssuer: runtime.admission.authorizationIssuer,
            admissionAuthorizationHandle: handle,
            sessionAuthorization,
            sessionId,
            authorityState: runtime.authorityReceiptState,
          },
        );
        if (!createdAuthorizationRuntime || !this.isHandshakeCurrent(ws, pending)) {
          runtime.admission.releaseSession(handle);
          this.handshakeConnections.delete(ws);
          safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise authorization unavailable");
          return;
        }
        enterpriseAuthorizationRuntime = createdAuthorizationRuntime;
      }
      sessionKey = sessionConnectionKey(
        resolved.principal.principalId,
        clientId,
        resolved.principal,
      );
      existing = pluginId ? undefined : this.externalSessionsByKey.get(sessionKey);
      admission = Object.freeze({
        kind: "enterprise",
        principalId: resolved.principal.principalId,
        permissions: OWNER_PERMISSIONS,
        enterprise: Object.freeze({
          principal: resolved.principal as PrincipalContext,
          node: resolved.node as NodeContext,
          runtime,
          grantVersionGuard: runtime.grantVersionGuard,
        }),
      });
      if (existing) {
        if (enterpriseAuthorizationRuntime) {
          // ADR-0021: a replacement gets a new Session/runtime generation.
          // Retire the old connection before publishing the replacement.
          try {
            await this.cleanupConnection(existing, "Enterprise session replaced");
          } catch (error) {
            runtime.admission.releaseSession(handle);
            await enterpriseAuthorizationRuntime.release().catch(() => undefined);
            this.handshakeConnections.delete(ws);
            safeCloseSocket(
              ws,
              WS_CLOSE_DAEMON_AUTH_FAILED,
              "Enterprise session replacement failed",
            );
            throw error;
          }
          existing = undefined;
        } else {
          existing.enterpriseAuthorizationHandle = handle;
        }
      }
      if (existing) {
        try {
          await this.resumeSession({ ws, message, pending, existing });
        } catch (error) {
          this.releaseEnterpriseAuthorization(existing);
          const oldSockets = [...existing.sockets];
          try {
            await this.cleanupConnection(existing, "Enterprise session resume failed");
          } catch (cleanupError) {
            // oxlint-disable-next-line max-depth -- cleanup error aggregation.
            for (const oldSocket of oldSockets) {
              safeCloseSocket(
                oldSocket,
                WS_CLOSE_DAEMON_AUTH_FAILED,
                "Enterprise session replaced",
              );
            }
            // oxlint-disable-next-line preserve-caught-error
            throw new AggregateError([error, cleanupError], "enterprise resume failed", {
              cause: error,
            });
          }
          for (const oldSocket of oldSockets) {
            safeCloseSocket(oldSocket, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise session replaced");
          }
          throw error;
        }
        return;
      }
    } else {
      if ("authorizationEvidence" in admission) {
        this.handshakeConnections.delete(ws);
        safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise admission is incomplete");
        return;
      }
      sessionKey = sessionConnectionKey(
        admission.principalId,
        clientId,
        admission.enterprise?.principal,
      );
      existing = pluginId
        ? undefined
        : (this.externalSessionsByKey.get(sessionKey) ??
          this.externalSessionsByBaseKey.get(
            sessionConnectionBaseKey(admission.principalId, clientId),
          ));
    }
    if (existing) {
      await this.resumeSession({ ws, message, pending, existing });
      return;
    }

    if ("authorizationEvidence" in admission) {
      this.handshakeConnections.delete(ws);
      safeCloseSocket(ws, WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise admission is incomplete");
      return;
    }
    const activeAdmission = admission;
    const connectionLogger = pending.connectionLogger.child({ clientId });
    this.incrementRuntimeCounter("helloNew");
    let connection: SessionConnection | undefined;
    let cleanupStarted = false;
    let workspaceCleanupPromise: Promise<void> | null = null;
    try {
      connection = this.createSessionConnection({
        ws,
        clientId,
        appVersion: message.appVersion ?? null,
        clientCapabilities: message.capabilities ?? null,
        connectionLogger,
        lifecycle: pluginId ? { kind: "ephemeral-plugin", pluginId } : { kind: "reconnectable" },
        admission: activeAdmission,
        ...(enterpriseAuthorizationHandle ? { enterpriseAuthorizationHandle } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionAuthorization ? { sessionAuthorization } : {}),
        ...(enterpriseAuthorizationRuntime ? { enterpriseAuthorizationRuntime } : {}),
        onEnterpriseWorkspaceRuntimeConstructionFailure: (runtime) => {
          workspaceCleanupPromise ??= runtime.cleanup("session-closed");
        },
      });
      const initialInfo = this.sendServerInfoToClient(
        ws,
        connection.session,
        connection.enterpriseAuthorizationHandle,
      );
      const initialAllowed: boolean =
        initialInfo instanceof Promise ? await initialInfo : initialInfo;
      if (!this.isHandshakeCurrent(ws, pending)) {
        throw new Error("WebSocket closed during enterprise handshake");
      }
      if (enterpriseAuthorizationHandle && this.enterpriseRuntime) {
        const current = isCurrentEnterpriseAdmissionAuthorization(
          this.enterpriseRuntime.admission.authorizationIssuer,
          enterpriseAuthorizationHandle,
        );
        if (!current) throw new Error("Enterprise admission is no longer current");
      }
      if (!initialAllowed) {
        this.releaseEnterpriseAuthorization(connection);
        cleanupStarted = true;
        await connection.session.cleanup();
        this.handshakeConnections.delete(ws);
        return;
      }
      this.sessions.set(ws, connection);
      if (connection.lifecycle === "reconnectable") {
        this.externalSessionsByKey.set(sessionKey, connection);
        this.externalSessionsByBaseKey.set(
          sessionConnectionBaseKey(activeAdmission.principalId, clientId),
          connection,
        );
      }
      pending.identity.sessionId = connection.session.getSessionId();
      this.syncBrowserToolsClientRegistration(connection);
      connection.connectionLogger.info(
        {
          ...toConnectionLogFields(pending.identity),
          resumed: false,
          totalSessions: this.sessions.size,
        },
        "Client connected via hello",
      );
      this.handshakeConnections.delete(ws);
    } catch (primary) {
      const cleanupErrors: unknown[] = [];
      if (workspaceCleanupPromise) {
        try {
          await workspaceCleanupPromise;
        } catch (workspaceCleanup) {
          cleanupErrors.push(workspaceCleanup);
        }
      }
      this.handshakeConnections.delete(ws);
      if (connection) {
        this.releaseEnterpriseAuthorization(connection);
        if (!cleanupStarted) {
          try {
            cleanupStarted = true;
            await connection.session.cleanup();
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      } else if (enterpriseAuthorizationHandle && this.enterpriseRuntime) {
        this.enterpriseRuntime.admission.releaseSession(enterpriseAuthorizationHandle);
        if (enterpriseAuthorizationRuntime) {
          try {
            await enterpriseAuthorizationRuntime.release();
          } catch (runtimeCleanup) {
            cleanupErrors.push(runtimeCleanup);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        // oxlint-disable-next-line preserve-caught-error
        throw new AggregateError([primary, ...cleanupErrors], "enterprise hello failed", {
          cause: primary,
        });
      }
      throw primary;
    }
  }

  private async resumeSession(params: {
    ws: WebSocketLike;
    message: WSHelloMessage;
    pending: PendingConnection;
    existing: ReconnectableSessionConnection;
  }): Promise<void> {
    const { ws, message, pending, existing } = params;
    const expectedHandle = existing.enterpriseAuthorizationHandle;
    this.incrementRuntimeCounter("helloResumed");
    const newAppVersion = message.appVersion ?? null;
    const newClientCapabilities = message.capabilities ?? null;
    const resumedInfo = this.sendServerInfoToClient(
      ws,
      existing.session,
      existing.enterpriseAuthorizationHandle,
    );
    const resumedAllowed = resumedInfo instanceof Promise ? await resumedInfo : resumedInfo;
    if (!this.isHandshakeCurrent(ws, pending)) {
      throw new Error("WebSocket closed during session resume");
    }
    if (existing.enterpriseAuthorizationHandle !== expectedHandle) {
      throw new Error("Enterprise session handle changed during resume");
    }
    if (expectedHandle && this.enterpriseRuntime) {
      if (
        !isCurrentEnterpriseAdmissionAuthorization(
          this.enterpriseRuntime.admission.authorizationIssuer,
          expectedHandle,
        )
      ) {
        throw new Error("Enterprise admission is no longer current");
      }
    }
    if (!resumedAllowed) {
      if (expectedHandle) {
        throw new Error("Enterprise server_info denied");
      }
      this.handshakeConnections.delete(ws);
      return;
    }
    if (existing.externalDisconnectCleanupTimeout) {
      clearTimeout(existing.externalDisconnectCleanupTimeout);
      existing.externalDisconnectCleanupTimeout = null;
    }
    if (newAppVersion && newAppVersion !== existing.appVersion) {
      existing.appVersion = newAppVersion;
      existing.session.updateAppVersion(newAppVersion);
    }
    existing.session.updateClientCapabilities(newClientCapabilities, ws);
    if (
      JSON.stringify(existing.clientCapabilities ?? null) !==
      JSON.stringify(newClientCapabilities ?? null)
    ) {
      existing.clientCapabilities = newClientCapabilities;
      this.syncBrowserToolsClientRegistration(existing);
    }
    existing.sockets.add(ws);
    this.sessions.set(ws, existing);
    this.handshakeConnections.delete(ws);
    pending.identity.sessionId = existing.session.getSessionId();
    this.syncBrowserToolsClientRegistration(existing);
    pending.connectionLogger.info(
      {
        ...toConnectionLogFields(pending.identity),
        resumed: true,
        totalSessions: this.sessions.size,
      },
      "Client connected via hello",
    );
  }

  private buildServerInfoStatusPayload(session: Session): ServerInfoStatusPayload {
    return {
      status: "server_info",
      serverId: this.serverId,
      hostname: getHostname(),
      version: this.daemonVersion,
      permissions: session.getPermissions(),
      // COMPAT(desktopManaged): added in v0.1.X, remove optional parsing after 2027-01-16.
      desktopManaged: this.daemonRuntimeConfig?.desktopManaged === true,
      ...(this.serverCapabilities ? { capabilities: this.serverCapabilities } : {}),
      features: {
        agentRequestReceipts: true,
        hubAgentRpc: true,
        // COMPAT(directorySync): added in v0.3.x, remove gate after 2027-02-12.
        directorySync: true,
        // COMPAT(workspaceLabels): added in v0.5.0, remove after 2027-08-14.
        ...(this.workspaceLabelService ? { workspaceLabels: true } : {}),
        // COMPAT(workspaceSetupRun): added in v0.7.3, remove gate after 2027-09-02.
        workspaceSetupRun: true,
        // COMPAT(providersSnapshot): keep optional until all clients rely on snapshot flow.
        providersSnapshot: true,
        // COMPAT(providersSnapshotCwd): added in v0.3.2, remove gate after 2027-02-10.
        providersSnapshotCwd: true,
        ...this.enterpriseFeatureFlags,
        // COMPAT(checkoutForgeSetAutoMerge): added in v0.2.0-beta.1. Remove the
        // feature gate and legacy fallback after 2027-01-17 once the supported
        // daemon floor is >= v0.2.0.
        checkoutForgeSetAutoMerge: true,
        // COMPAT(checkoutGithubSetAutoMerge): added in v0.1.75 and retained as
        // the fallback for checkoutForgeSetAutoMerge. Stop advertising it after
        // 2027-01-17 once supported floors are >= v0.2.0.
        checkoutGithubSetAutoMerge: true,
        // COMPAT(githubCheckDetails): added in v0.1.92 and retained as the
        // fallback for forgeCheckDetails. Stop advertising it after 2027-01-17
        // once supported floors are >= v0.2.0.
        githubCheckDetails: true,
        // COMPAT(forgeCheckDetails): added in v0.2.0-beta.1. Remove the feature
        // gate and legacy fallback after 2027-01-17 once the supported daemon
        // floor is >= v0.2.0.
        forgeCheckDetails: true,
        // COMPAT(forgeSearch): added in v0.2.0-beta.1. Remove the feature gate
        // and legacy fallback after 2027-01-17 once the supported daemon floor
        // is >= v0.2.0.
        forgeSearch: true,
        // COMPAT(daemonStatusRpc): added in v0.1.76, remove gate after 2026-11-18.
        ...(this.advertiseDaemonStatusRpc ? { daemonStatusRpc: true } : {}),
        // COMPAT(daemonConfigReload): added in v0.4.0, remove gate after 2027-02-14.
        daemonConfigReload: true,
        // COMPAT(relayConfig): added in v0.2.6, remove gate after 2027-01-31.
        ...(this.advertiseRelayConfig ? { relayConfig: true } : {}),
        // COMPAT(pushTokenRevocation): added in v0.3.2, remove gate after 2027-02-10.
        pushTokenRevocation: true,
        // COMPAT(plugins): added in v0.3.0, remove gate after 2027-08-07.
        plugins: true,
        pluginManagement: true,
        pluginGitManagement: true,
        pluginLogs: true,
        // COMPAT(pluginThemes): added in v0.5.0, remove gate after 2027-08-20.
        pluginThemes: true,
        pluginSettings: true,
        pluginTimelineItems: true,
        // COMPAT(skillManagement): added in v0.4.0, remove gate after 2027-08-16.
        skillManagement: true,
        // COMPAT(terminalRestoreModes): added in v0.1.81, remove gate after 2026-11-23.
        "terminal-restore-modes": true,
        // COMPAT(terminalInputModeReplay): added in v0.2.6, remove gate after 2027-02-02.
        "terminal-input-mode-replay": true,
        // COMPAT(terminalSizeOwnership): added in v0.2.6, remove gate after 2027-02-02.
        "terminal-size-ownership": true,
        workspaceTerminals: true,
        // COMPAT(rewind): added in v0.1.X, drop the gate when floor >= v0.1.X.
        rewind: true,
        // COMPAT(agentTimelinePromptIndex): added in v0.2.X, drop the gate when floor >= v0.2.X.
        agentTimelinePromptIndex: true,
        // COMPAT(agentHistorySearch): added in v0.3.0, remove gate after 2027-02-07.
        agentHistorySearch: true,
        // COMPAT(checkoutRefresh): added in v0.1.86, remove gate after 2026-11-29.
        checkoutRefresh: true,
        // COMPAT(workspaceMultiplicity): added in v0.1.97, drop the gate when floor >= v0.1.97
        workspaceMultiplicity: true,
        // COMPAT(projectRemove): added in v0.1.97, drop the gate when floor >= v0.1.97.
        projectRemove: true,
        // COMPAT(projectAdd): added in v0.1.97, drop the gate when floor >= v0.1.97.
        projectAdd: true,
        // COMPAT(projectList): added in v0.2.4, drop the gate when floor >= v0.2.4.
        projectList: true,
        // COMPAT(worktreeRestore): keep through 2027-01-11 for clients older than v0.1.105.
        worktreeRestore: true,
        // COMPAT(workspaceRecovery): added in v0.1.105, remove after 2027-01-11 once daemon floor >= v0.1.105.
        workspaceRecovery: true,
        // COMPAT(workspaceFileEditing): added in v0.2.0, remove after 2027-01-18 once daemon floor >= v0.2.0.
        workspaceFileEditing: true,
        // COMPAT(providerUsageList): added in v0.1.98, drop the gate when daemon floor >= v0.1.98.
        providerUsageList: true,
        // COMPAT(agentDetach): added in v0.1.98, remove gate after 2026-12-19 once daemon floor >= v0.1.98.
        agentDetach: true,
        // COMPAT(agentThinkingUpdate): added in v0.2.4, remove gate after 2027-01-28.
        agentThinkingUpdate: true,
        // COMPAT(daemonDiagnostics): added in v0.1.100, remove gate after 2026-12-25 once daemon floor >= v0.1.100.
        daemonDiagnostics: true,
        // COMPAT(daemonSelfUpdate): added in v0.1.93, remove gate after 2026-12-13.
        daemonSelfUpdate: this.daemonRuntimeConfig?.desktopManaged !== true,
        // COMPAT(agentForkContext): added in v0.1.102, remove gate after 2026-12-28.
        agentForkContext: true,
        // COMPAT(agentForkContextCursor): added in v0.1.108, remove gate after 2027-01-14.
        agentForkContextCursor: true,
        // COMPAT(providerSubagents): added in v0.1.107, remove gate after 2027-01-12.
        providerSubagents: true,
        // COMPAT(providerSubagentNesting): added in v0.7, remove gate after 2027-03-04.
        providerSubagentNesting: true,
        // COMPAT(workspacePinning): added in v0.1.107, remove gate after 2027-01-12.
        workspacePinning: true,
        // COMPAT(workspaceMarkUnread): added in v0.5.0, remove after 2027-08-20.
        workspaceMarkUnread: true,
        // COMPAT(hubRelationship): added in v0.1.X, drop the gate when floor >= v0.1.X.
        hubRelationship: true,
        // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
        projectGithubClone: true,
        // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
        workspaceGithubRepositorySearch: true,
        // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
        projectCreateDirectory: true,
        // COMPAT(commitsList): added in v0.1.110, remove gate after 2027-01-16.
        commitsList: true,
        // COMPAT(commitBaseClassification): added in v0.2.0, remove gate after 2027-01-23.
        commitBaseClassification: true,
        // COMPAT(providerRemoval): added in v0.1.105, drop the gate when floor >= v0.1.105.
        providerRemoval: true,
        // COMPAT(importSessionWorkspaceTarget): added in v0.1.110, remove gate after 2027-01-16.
        importSessionWorkspaceTarget: true,
        // COMPAT(importSessionSearch): added in v0.7.3, remove gate after 2027-03-02.
        importSessionSearch: true,
        // COMPAT(forgeProviders): added in v0.2.0-beta.1. Drop the gate after
        // 2027-01-17 once the supported daemon floor is >= v0.2.0.
        forgeProviders: true,
        // COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
        selectiveAgentTimeline: true,
        explicitEventSubscriptions: true,
        // COMPAT(canonicalSubmittedPrompts): added in v0.2.6, remove gate after 2027-01-30.
        canonicalSubmittedPrompts: true,
        // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
        stableProjectIdentity: true,
        // COMPAT(workspaceScriptManagement): added in v0.1.105, remove gate after 2027-01-10.
        workspaceScriptManagement: true,
        // COMPAT(projectCustomIcon): added in v0.2.0, remove after 2027-01-20.
        projectCustomIcon: true,
        // COMPAT(fsEntryOps): added in v0.3.0, remove gate after 2027-02-08.
        fsEntryOps: true,
        // COMPAT(fsEntryDuplicate): added in v0.3.0, remove gate after 2027-02-09.
        fsEntryDuplicate: true,
        // COMPAT(checkoutDiscardChanges): added in v0.3.0, remove gate after 2027-02-08.
        checkoutDiscardChanges: true,
        // COMPAT(agentProfiles): added in v0.3.2, remove gate after 2027-02-11.
        agentProfiles: true,
        // COMPAT(agentConfigApply): added in v0.3.2, remove gate after 2027-02-11.
        agentConfigApply: true,
      },
    };
  }

  private createServerInfoMessage(session: Session): WSOutboundMessage {
    return {
      type: "session",
      message: {
        type: "status",
        payload: this.buildServerInfoStatusPayload(session),
      },
    };
  }

  private sendServerInfoToClient(
    ws: WebSocketLike,
    session: Session,
    authorizationHandle?: EnterpriseAdmissionAuthorizationHandle,
  ): boolean | Promise<boolean> {
    const message = this.createServerInfoMessage(session);
    if (this.enterpriseRuntime) {
      return this.sendEnterpriseServerInfo(ws, session, message, authorizationHandle);
    }
    this.sendToClient(ws, message);
    return true;
  }

  private async sendEnterpriseServerInfo(
    ws: WebSocketLike,
    session: Session,
    message: WSOutboundMessage,
    authorizationHandle?: EnterpriseAdmissionAuthorizationHandle,
  ): Promise<boolean> {
    const context = session.getEnterpriseSessionContext();
    if (!context || message.type !== "session") return false;
    const allowed = await this.enterpriseRuntime!.resourceAuthorization.canEmit(
      context.principal,
      message.message,
      { kind: "transport_control", control: "server_info" },
    );
    if (!allowed) {
      ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Enterprise authorization failed");
      return false;
    }
    if (
      ws.readyState !== 1 ||
      this.connectionLifecycle === "stopping" ||
      (authorizationHandle &&
        !isCurrentEnterpriseAdmissionAuthorization(
          this.enterpriseRuntime!.admission.authorizationIssuer,
          authorizationHandle,
        ))
    ) {
      return false;
    }
    this.sendToClient(ws, message);
    return true;
  }

  private createDaemonConfigChangedMessage(config: MutableDaemonConfig): WSOutboundMessage {
    return wrapSessionMessage({
      type: "status",
      payload: {
        status: "daemon_config_changed",
        config,
      },
    });
  }

  private broadcastCapabilitiesUpdate(): void {
    for (const connection of new Set(this.sessions.values())) {
      for (const socket of connection.sockets) {
        void Promise.resolve(
          this.sendServerInfoToClient(
            socket,
            connection.session,
            connection.enterpriseAuthorizationHandle,
          ),
        )
          .then((sent) =>
            sent ? undefined : this.cleanupConnection(connection, "server_info denied"),
          )
          .catch((error) => {
            this.logger.warn({ err: error }, "server_info broadcast send failed");
            return this.cleanupConnection(connection, "server_info failed");
          });
      }
    }
  }

  private broadcastDaemonConfigChanged(config: MutableDaemonConfig): void {
    this.broadcast(this.createDaemonConfigChangedMessage(config));
  }

  private bindSocketHandlers(ws: WebSocketLike): void {
    ws.on("message", (...args: unknown[]) => {
      const data = args[0] as Buffer | ArrayBuffer | Buffer[] | string;
      this.handleRawMessage(ws, data);
    });

    ws.on("close", async (...args: unknown[]) => {
      const code = args[0];
      const reason = args[1];
      await this.detachSocket(ws, {
        code: typeof code === "number" ? code : undefined,
        reason,
      });
    });

    ws.on("error", async (...args: unknown[]) => {
      const error = args[0];
      const err = error instanceof Error ? error : new Error(String(error));
      const active = this.sessions.get(ws);
      const pending = this.pendingConnections.get(ws);
      const log = active?.connectionLogger ?? pending?.connectionLogger ?? this.logger;
      log.error({ err }, "Client error");
      await this.detachSocket(ws, { error: err });
    });
  }

  public resolveVoiceSpeakHandler(callerAgentId: string): VoiceSpeakHandler | null {
    return this.voiceSpeakHandlers.get(callerAgentId) ?? null;
  }

  public resolveVoiceCallerContext(callerAgentId: string): VoiceCallerContext | null {
    return this.voiceCallerContexts.get(callerAgentId) ?? null;
  }

  private async detachSocket(
    ws: WebSocketLike,
    details: {
      code?: number;
      reason?: unknown;
      error?: Error;
    },
  ): Promise<void> {
    this.applicationSocketLease.release(ws);
    const identity = this.socketIdentities.get(ws);
    const identityFields = identity ? toConnectionLogFields(identity) : {};
    const pending = this.clearPendingConnection(ws);
    this.handshakeConnections.delete(ws);
    if (pending) {
      this.incrementRuntimeCounter("pendingDisconnected");
      pending.connectionLogger.info(
        {
          ...identityFields,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Pending client disconnected",
      );
      this.socketIdentities.delete(ws);
      this.finishPluginSocketCleanup(ws);
      return;
    }

    const connection = this.sessions.get(ws);
    if (!connection) {
      if (identity) {
        this.logger.info(
          {
            ...identityFields,
            code: details.code,
            reason: stringifyCloseReason(details.reason),
          },
          "Client socket closed without active session",
        );
        this.socketIdentities.delete(ws);
      }
      this.finishPluginSocketCleanup(ws);
      return;
    }

    this.sessions.delete(ws);
    connection.sockets.delete(ws);
    connection.session.clearAgentTimelineSubscription(ws);
    this.socketIdentities.delete(ws);

    if (connection.sockets.size === 0) {
      this.unregisterBrowserToolsClient(connection);
      if (connection.lifecycle === "ephemeral-plugin") {
        this.pluginSocketIds.delete(ws);
        await this.cleanupConnection(connection, "Plugin session disconnected");
        this.finishPluginSocketCleanup(ws);
        return;
      }
      this.incrementRuntimeCounter("sessionDisconnectedWaitingReconnect");
      if (connection.externalDisconnectCleanupTimeout) {
        clearTimeout(connection.externalDisconnectCleanupTimeout);
      }
      const timeout = setTimeout(() => {
        if (connection.externalDisconnectCleanupTimeout !== timeout) {
          return;
        }
        connection.externalDisconnectCleanupTimeout = null;
        void this.cleanupConnection(connection, "Client disconnected (grace timeout)");
      }, EXTERNAL_SESSION_DISCONNECT_GRACE_MS);
      connection.externalDisconnectCleanupTimeout = timeout;

      connection.connectionLogger.info(
        {
          ...identityFields,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
          reconnectGraceMs: EXTERNAL_SESSION_DISCONNECT_GRACE_MS,
        },
        "Client disconnected; waiting for reconnect",
      );
      return;
    }

    if (connection.sockets.size > 0) {
      this.incrementRuntimeCounter("sessionSocketDisconnectedAttached");
      connection.connectionLogger.info(
        {
          ...identityFields,
          remainingSockets: connection.sockets.size,
          code: details.code,
          reason: stringifyCloseReason(details.reason),
        },
        "Client socket disconnected; session remains attached",
      );
      return;
    }

    await this.cleanupConnection(connection, "Client disconnected");
    this.finishPluginSocketCleanup(ws);
  }

  private finishPluginSocketCleanup(ws: WebSocketLike): void {
    const resolve = this.pluginSocketCleanup.get(ws);
    if (!resolve) return;
    this.pluginSocketCleanup.delete(ws);
    resolve();
  }

  private cleanupConnection(connection: SessionConnection, logMessage: string): Promise<void> {
    const existing = this.connectionCleanupPromises.get(connection);
    if (existing) return existing;
    const cleanup = this.cleanupConnectionImpl(connection, logMessage);
    this.connectionCleanupPromises.set(connection, cleanup);
    return cleanup;
  }

  private async cleanupConnectionImpl(
    connection: SessionConnection,
    logMessage: string,
  ): Promise<void> {
    this.incrementRuntimeCounter("sessionCleanup");
    if (connection.lifecycle === "reconnectable" && connection.externalDisconnectCleanupTimeout) {
      clearTimeout(connection.externalDisconnectCleanupTimeout);
      connection.externalDisconnectCleanupTimeout = null;
    }

    for (const socket of connection.sockets) {
      this.sessions.delete(socket);
      this.socketIdentities.delete(socket);
    }
    connection.sockets.clear();
    if (connection.lifecycle === "reconnectable") {
      const existing = this.externalSessionsByKey.get(connection.sessionKey);
      if (existing === connection) {
        this.externalSessionsByKey.delete(connection.sessionKey);
      }
      const baseKey = sessionConnectionBaseKey(connection.principalId, connection.clientId);
      if (this.externalSessionsByBaseKey.get(baseKey) === connection)
        this.externalSessionsByBaseKey.delete(baseKey);
    }
    this.unregisterBrowserToolsClient(connection);
    this.releaseEnterpriseAuthorization(connection);

    connection.connectionLogger.trace(
      { clientId: connection.clientId, totalSessions: this.sessions.size },
      logMessage,
    );
    await connection.session.cleanup();
  }

  private releaseEnterpriseAuthorization(connection: SessionConnection): void {
    const handle = connection.enterpriseAuthorizationHandle;
    if (!handle) return;
    connection.enterpriseAuthorizationHandle = undefined;
    this.enterpriseRuntime?.admission.releaseSession(handle);
  }

  private syncBrowserToolsClientRegistration(connection: SessionConnection): void {
    if (!this.browserToolsBroker) {
      return;
    }
    const registrationKey = connection.sessionKey;
    if (!connection.session.allowsPermission("workspace.write")) {
      this.unregisterBrowserToolsClient(registrationKey);
      return;
    }
    const browserHostCapability = getBrowserHostCapability(connection.clientCapabilities);
    if (!browserHostCapability) {
      this.unregisterBrowserToolsClient(registrationKey);
      return;
    }
    const capabilitySignature = JSON.stringify(browserHostCapability);
    const existing = this.browserToolsRegistrations.get(registrationKey);
    if (existing?.capabilitySignature === capabilitySignature) {
      return;
    }
    if (existing) {
      this.browserToolsRegistrations.delete(registrationKey);
      existing.unregister();
    }

    const unregister = this.browserToolsBroker.registerClient({
      id: connection.principalId === "owner" ? connection.clientId : registrationKey,
      hostKind: browserHostCapability.hostKind,
      supportedCommands: browserHostCapability.supportedCommands,
      sendBrowserAutomationRequest: (request) => {
        this.sendToConnection(connection, wrapSessionMessage(request));
      },
    });
    this.browserToolsRegistrations.set(registrationKey, {
      capabilitySignature,
      unregister,
    });
  }

  private unregisterBrowserToolsClient(connection: SessionConnection | string): void {
    const registrationKey = typeof connection === "string" ? connection : connection.sessionKey;
    const registration = this.browserToolsRegistrations.get(registrationKey);
    if (!registration) {
      return;
    }
    this.browserToolsRegistrations.delete(registrationKey);
    registration.unregister();
  }

  private handleInvalidInboundMessage(args: {
    ws: WebSocketLike;
    parsed: unknown;
    parsedMessage: { success: false; error: { message: string } } & Record<string, unknown>;
    pendingConnection: PendingConnection | undefined;
    activeConnection: SessionConnection | undefined;
    log: pino.Logger;
  }): void {
    const { ws, parsed, parsedMessage, pendingConnection, activeConnection, log } = args;
    this.incrementRuntimeCounter("validationFailed");
    if (pendingConnection) {
      pendingConnection.connectionLogger.warn(
        { error: parsedMessage.error.message },
        "Rejected pending message before hello",
      );
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestInfo = extractRequestInfoFromUnknownWsInbound(parsed);
    const isUnknownSchema =
      requestInfo?.requestId != null &&
      typeof parsed === "object" &&
      parsed != null &&
      "type" in parsed &&
      (parsed as { type?: unknown }).type === "session";

    log.warn(
      {
        clientId: activeConnection?.clientId,
        requestId: requestInfo?.requestId,
        requestType: requestInfo?.requestType,
        error: parsedMessage.error.message,
      },
      "WS inbound message validation failed",
    );

    if (requestInfo) {
      this.sendToClient(
        ws,
        wrapSessionMessage({
          type: "rpc_error",
          payload: {
            requestId: requestInfo.requestId,
            requestType: requestInfo.requestType,
            error: isUnknownSchema
              ? `Unknown request, try upgrading the daemon (currently v${this.daemonVersion})`
              : "Invalid message",
            code: isUnknownSchema ? "unknown_schema" : "invalid_message",
          },
        }),
      );
      return;
    }

    const errorMessage = `Invalid message: ${parsedMessage.error.message}`;
    this.sendToClient(
      ws,
      wrapSessionMessage({
        type: "status",
        payload: {
          status: "error",
          message: errorMessage,
        },
      }),
    );
  }

  private maybeHandleBinaryFrame(params: {
    ws: WebSocketLike;
    buffer: Buffer;
    activeConnection: SessionConnection | undefined;
    log: pino.Logger;
  }): boolean {
    const { ws, buffer, activeConnection, log } = params;
    const asBytes = asUint8Array(buffer);
    if (!asBytes) {
      return false;
    }
    const decodedFrame = decodeBinaryFrame(asBytes);
    if (!decodedFrame) {
      return false;
    }
    if (!activeConnection) {
      this.incrementRuntimeCounter("binaryBeforeHelloRejected");
      log.warn("Rejected binary frame before hello");
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Session message before hello");
      } catch {
        // ignore close errors
      }
      return true;
    }
    void Promise.resolve(activeConnection.session.handleBinaryFrame(decodedFrame)).catch(
      (error: unknown) => {
        this.handleRawMessageError({
          ws,
          data: buffer,
          error,
          log: activeConnection.connectionLogger,
        });
      },
    );
    return true;
  }

  private handlePendingConnectionMessage(params: {
    ws: WebSocketLike;
    message: WSInboundMessage;
    pendingConnection: PendingConnection;
  }): void {
    const { ws, message, pendingConnection } = params;
    if (message.type === "hello") this.handshakeInFlight.add(ws);
    const queue = this.pendingMessageQueues.get(ws) ?? [];
    this.pendingMessageOwners.set(ws, pendingConnection);
    queue.push({ message, pendingConnection });
    this.pendingMessageQueues.set(ws, queue);
    if (this.pendingMessageDraining.has(ws)) return;
    this.pendingMessageDraining.add(ws);
    const task = this.drainPendingMessages(ws).catch((error) => {
      this.pendingMessageErrors.set(ws, error);
      this.logger.warn({ err: error }, "pending websocket message failed");
      this.pendingMessageQueues.delete(ws);
      this.pendingMessageOwners.delete(ws);
      this.pendingMessageDraining.delete(ws);
      try {
        ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Authentication failed");
      } catch {
        /* ignore */
      }
    });
    this.pendingMessageTasks.set(ws, task);
    void task.then(
      () => {
        if (this.pendingMessageTasks.get(ws) === task) this.pendingMessageTasks.delete(ws);
        if (this.connectionLifecycle !== "stopping") this.pendingMessageErrors.delete(ws);
        return undefined;
      },
      () => {
        if (this.pendingMessageTasks.get(ws) === task) this.pendingMessageTasks.delete(ws);
        if (this.connectionLifecycle !== "stopping") this.pendingMessageErrors.delete(ws);
        return undefined;
      },
    );
  }

  // oxlint-disable max-depth -- serialized pending dispatch.
  private async drainPendingMessages(ws: WebSocketLike): Promise<void> {
    try {
      for (;;) {
        const item = this.pendingMessageQueues.get(ws)?.shift();
        if (!item) return;
        if (item.message.type === "hello") {
          await this.handleHello({ ws, message: item.message, pending: item.pendingConnection });
        } else {
          this.pendingMessageReplaying.add(ws);
          try {
            const active = this.sessions.get(ws);
            if (active && item.message.type === "session") {
              await this.dispatchSessionMessage(ws, active, item.message);
            } else {
              this.handleRawMessage(ws, Buffer.from(JSON.stringify(item.message)));
            }
          } finally {
            this.pendingMessageReplaying.delete(ws);
          }
        }
      }
    } finally {
      this.pendingMessageQueues.delete(ws);
      this.pendingMessageDraining.delete(ws);
      this.pendingMessageOwners.delete(ws);
      this.handshakeInFlight.delete(ws);
    }
  }
  // oxlint-enable max-depth

  // oxlint-disable-next-line complexity -- pending queue gate plus protocol dispatch.
  private handleRawMessage(
    ws: WebSocketLike,
    data: Buffer | ArrayBuffer | Buffer[] | string,
  ): void {
    if (
      this.connectionLifecycle === "stopping" ||
      (this.connectionLifecycle === "starting" && !this.pluginSocketIds.has(ws))
    ) {
      return;
    }

    this.applicationSocketLease.renew(ws);

    const activeConnection = this.sessions.get(ws);
    const pendingConnection = this.pendingConnections.get(ws);
    const log =
      activeConnection?.connectionLogger ?? pendingConnection?.connectionLogger ?? this.logger;

    try {
      const buffer = bufferFromWsData(data);
      const binaryHandled = this.maybeHandleBinaryFrame({
        ws,
        buffer,
        activeConnection,
        log,
      });
      if (binaryHandled) {
        return;
      }

      const parsed = JSON.parse(buffer.toString());
      const parsedMessage = WSInboundMessageSchema.safeParse(parsed);
      if (!parsedMessage.success) {
        this.handleInvalidInboundMessage({
          ws,
          parsed,
          parsedMessage,
          pendingConnection,
          activeConnection,
          log,
        });
        return;
      }

      const message = parsedMessage.data;
      if (
        !pendingConnection &&
        this.handshakeInFlight.has(ws) &&
        !this.pendingMessageReplaying.has(ws)
      ) {
        const owner = this.pendingMessageOwners.get(ws);
        if (owner) {
          const queue = this.pendingMessageQueues.get(ws) ?? [];
          queue.push({ message, pendingConnection: owner });
          this.pendingMessageQueues.set(ws, queue);
          return;
        }
      }
      this.recordInboundMessageType(message.type);

      if (message.type === "ping") {
        this.applicationSocketLease.claim(ws);
        this.sendToClient(ws, { type: "pong" });
        return;
      }

      if (message.type === "recording_state") {
        return;
      }

      if (pendingConnection) {
        this.handlePendingConnectionMessage({
          ws,
          message,
          pendingConnection,
        });
        return;
      }

      if (!activeConnection) {
        this.incrementRuntimeCounter("missingConnectionForMessage");
        this.logger.error("No connection found for websocket");
        return;
      }

      if (message.type === "hello") {
        this.incrementRuntimeCounter("unexpectedHelloOnActiveConnection");
        activeConnection.connectionLogger.warn("Received hello on active connection");
        try {
          ws.close(WS_CLOSE_INVALID_HELLO, "Unexpected hello");
        } catch {
          // ignore close errors
        }
        return;
      }

      if (message.type === "session") {
        void this.dispatchSessionMessage(ws, activeConnection, message).catch((error: unknown) => {
          this.handleRawMessageError({ ws, data, error, log: activeConnection.connectionLogger });
        });
      }
    } catch (error) {
      this.handleRawMessageError({ ws, data, error, log });
    }
  }

  private async dispatchSessionMessage(
    ws: WebSocketLike,
    activeConnection: SessionConnection,
    message: Extract<WSInboundMessage, { type: "session" }>,
  ): Promise<void> {
    this.recordInboundSessionRequestType(message.message.type);
    const controlRpc = getControlRpcLogInfo(message.message);
    if (controlRpc) {
      const identity = this.socketIdentities.get(ws);
      let connectionFields: Record<string, unknown>;
      if (identity) {
        connectionFields = toConnectionLogFields(identity);
      } else {
        connectionFields = { clientId: activeConnection.clientId };
      }
      activeConnection.connectionLogger.warn(
        {
          ...connectionFields,
          ...controlRpc,
        },
        "ws_control_rpc_received",
      );
    }
    if (message.message.type === "browser.automation.execute.response") {
      if (!activeConnection.session.allowsInbound(message.message)) {
        await activeConnection.session.handleMessage(message.message, ws);
        return;
      }
      this.browserToolsBroker?.receiveResponse(message.message as BrowserAutomationExecuteResponse);
      return;
    }

    const startMs = performance.now();
    await activeConnection.session.handleMessage(message.message, ws);
    const durationMs = performance.now() - startMs;
    this.recordRequestLatency(message.message.type, durationMs);

    if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
      activeConnection.connectionLogger.warn(
        {
          requestType: message.message.type,
          durationMs: Math.round(durationMs),
          inflightRequests: activeConnection.session.getRuntimeMetrics().inflightRequests,
        },
        "ws_slow_request",
      );
    }
  }

  private handleRawMessageError(params: {
    ws: WebSocketLike;
    data: Buffer | ArrayBuffer | Buffer[] | string;
    error: unknown;
    log: pino.Logger;
  }): void {
    const { ws, data, error, log } = params;
    const err = error instanceof Error ? error : new Error(String(error));
    const { rawPayload, parsedPayload } = this.decodeRawMessagePayloadForError(data);

    const trimmedRawPayload =
      typeof rawPayload === "string" && rawPayload.length > 2000
        ? `${rawPayload.slice(0, 2000)}... (truncated)`
        : rawPayload;

    log.error(
      {
        err,
        rawPayload: trimmedRawPayload,
        parsedPayload,
      },
      "Failed to parse/handle message",
    );

    if (this.pendingConnections.has(ws)) {
      this.clearPendingConnection(ws);
      try {
        ws.close(WS_CLOSE_INVALID_HELLO, "Invalid hello");
      } catch {
        // ignore close errors
      }
      return;
    }

    const requestInfo = extractRequestInfoFromUnknownWsInbound(parsedPayload);
    if (requestInfo) {
      this.sendToClient(
        ws,
        wrapSessionMessage({
          type: "rpc_error",
          payload: {
            requestId: requestInfo.requestId,
            requestType: requestInfo.requestType,
            error: "Invalid message",
            code: "invalid_message",
          },
        }),
      );
      return;
    }

    this.sendToClient(
      ws,
      wrapSessionMessage({
        type: "status",
        payload: {
          status: "error",
          message: `Invalid message: ${err.message}`,
        },
      }),
    );
  }

  private decodeRawMessagePayloadForError(data: Buffer | ArrayBuffer | Buffer[] | string): {
    rawPayload: string | null;
    parsedPayload: unknown;
  } {
    let rawPayload: string | null = null;
    let parsedPayload: unknown = null;
    try {
      const buffer = bufferFromWsData(data);
      rawPayload = buffer.toString();
      parsedPayload = JSON.parse(rawPayload);
    } catch (payloadError) {
      rawPayload = rawPayload ?? "<unreadable>";
      parsedPayload = parsedPayload ?? rawPayload;
      const payloadErr =
        payloadError instanceof Error ? payloadError : new Error(String(payloadError));
      this.logger.error({ err: payloadErr }, "Failed to decode raw payload");
    }
    return { rawPayload, parsedPayload };
  }

  private incrementRuntimeCounter(counter: keyof WebSocketRuntimeCounters): void {
    this.runtimeMetrics.incrementCounter(counter);
  }

  private recordInboundMessageType(type: string): void {
    this.runtimeMetrics.recordInboundMessage(type);
  }

  private recordInboundSessionRequestType(type: string): void {
    this.runtimeMetrics.recordInboundSessionRequest(type);
  }

  private recordRequestLatency(type: string, durationMs: number): void {
    this.runtimeMetrics.recordRequestLatency(type, durationMs);
  }

  private collectSessionRuntimeMetrics(): WebSocketRuntimeMetrics {
    const uniqueConnections = new Set<SessionConnection>(this.externalSessionsByKey.values());
    let terminalDirectorySubscriptionCount = 0;
    let terminalSubscriptionCount = 0;
    let workspaceGitWatchedDirectoryCount = 0;
    let workspaceGitWorkspaceRecordCount = 0;
    let workspaceGitSubscriptionCount = 0;
    let inflightRequests = 0;
    let peakInflightRequests = 0;

    for (const connection of uniqueConnections) {
      const sessionMetrics = connection.session.getRuntimeMetrics();
      terminalDirectorySubscriptionCount += sessionMetrics.terminalDirectorySubscriptionCount;
      terminalSubscriptionCount += sessionMetrics.terminalSubscriptionCount;
      workspaceGitWatchedDirectoryCount += sessionMetrics.workspaceGitWatchedDirectoryCount;
      workspaceGitWorkspaceRecordCount += sessionMetrics.workspaceGitWorkspaceRecordCount;
      workspaceGitSubscriptionCount += sessionMetrics.workspaceGitSubscriptionCount;
      inflightRequests += sessionMetrics.inflightRequests;
      peakInflightRequests = Math.max(peakInflightRequests, sessionMetrics.peakInflightRequests);
      connection.session.resetPeakInflight();
    }

    return {
      ...this.checkoutDiffManager.getMetrics(),
      terminalDirectorySubscriptionCount,
      terminalSubscriptionCount,
      workspaceGitWatchedDirectoryCount,
      workspaceGitWorkspaceRecordCount,
      workspaceGitSubscriptionCount,
      inflightRequests,
      peakInflightRequests,
    };
  }

  private flushRuntimeMetrics(options?: { final?: boolean }): void {
    const runtimeMetrics = this.runtimeMetrics.snapshotAndReset();
    const activeConnections = new Set<SessionConnection>(this.sessions.values()).size;
    const activeSockets = this.sessions.size;
    const pendingConnections = this.pendingConnections.size;
    const reconnectGraceSessions = [...this.externalSessionsByKey.values()].filter(
      (connection) =>
        connection.sockets.size === 0 && connection.externalDisconnectCleanupTimeout !== null,
    ).length;
    const sessionMetrics = this.collectSessionRuntimeMetrics();
    const agentSnapshot = this.agentManager.getMetricsSnapshot();
    const gitCommandMetrics = snapshotGitCommandRuntimeMetrics();
    const loggedMetrics = {
      windowMs: runtimeMetrics.windowMs,
      final: Boolean(options?.final),
      sessions: {
        activeConnections,
        externalSessionKeys: this.externalSessionsByKey.size,
        reconnectGraceSessions,
      },
      sockets: {
        activeSockets,
        pendingConnections,
      },
      counters: runtimeMetrics.counters,
      inboundMessageTypesTop: runtimeMetrics.inboundMessageTypesTop,
      inboundSessionRequestTypesTop: runtimeMetrics.inboundSessionRequestTypesTop,
      outboundMessageTypesTop: runtimeMetrics.outboundMessageTypesTop,
      outboundSessionMessageTypesTop: runtimeMetrics.outboundSessionMessageTypesTop,
      outboundAgentStreamTypesTop: runtimeMetrics.outboundAgentStreamTypesTop,
      outboundAgentStreamAgentsTop: runtimeMetrics.outboundAgentStreamAgentsTop,
      outboundBinaryFrameTypesTop: runtimeMetrics.outboundBinaryFrameTypesTop,
      bufferedAmount: runtimeMetrics.bufferedAmount,
      eventLoopDelay: this.snapshotEventLoopDelay(),
      uptimeSeconds: getProcessUptimeSeconds(),
      memory: getProcessMemoryDiagnostics(),
      runtime: sessionMetrics,
      latency: runtimeMetrics.latency,
      agents: agentSnapshot,
      git: {
        commands: gitCommandMetrics,
        workspaceService: this.workspaceGitService.getMetrics(),
      },
    } satisfies WebSocketRuntimeMetricsLogPayload;

    this.lastRuntimeMetricsSnapshot = {
      collectedAt: new Date().toISOString(),
      ...loggedMetrics,
    };
    this.logger.info(loggedMetrics, "ws_runtime_metrics");
  }

  private getClientActivityState(session: Session): ClientPresenceState {
    const activity = session.getClientActivity();
    if (!activity) {
      return {
        appVisible: false,
        focusedAgentId: null,
        focusedTerminalId: null,
        lastActivityAtMs: null,
      };
    }

    return {
      appVisible: activity.appVisible,
      focusedAgentId: activity.focusedAgentId,
      focusedTerminalId: activity.focusedTerminalId,
      lastActivityAtMs: activity.lastActivityAt.getTime(),
    };
  }

  private async broadcastAgentAttention(params: {
    agentId: string;
    provider: AgentProvider;
    reason: "finished" | "error" | "permission";
  }): Promise<void> {
    const agent = this.agentManager.getAgent(params.agentId);
    if (!agent?.workspaceId) {
      return;
    }
    const clientEntries: Array<{
      ws: WebSocketLike;
      state: ClientPresenceState;
    }> = [];

    for (const [ws, connection] of this.sessions) {
      if (!(await connection.session.subscribesToAgent(agent))) continue;
      clientEntries.push({
        ws,
        state: this.getClientActivityState(connection.session),
      });
    }

    const allStates = clientEntries.map((e) => e.state);
    const nowMs = Date.now();
    const assistantMessage = await this.agentManager.getLastAssistantMessage(params.agentId);
    const notification = buildAgentAttentionNotificationPayload({
      reason: params.reason,
      serverId: this.serverId,
      workspaceId: agent.workspaceId,
      agentId: params.agentId,
      assistantMessage,
      permissionRequest: findLatestPermissionRequest(agent.pendingPermissions),
    });

    const plan = computeNotificationPlan({
      allStates,
      focusTarget: { kind: "agent", id: params.agentId },
      pushEligible: isPushEligibleAttentionReason(params.reason),
      nowMs,
    });

    if (plan.shouldPush) {
      void this.pushNotificationSender.send(notification).catch((err) => {
        this.logger.warn({ err, agentId: params.agentId }, "Failed to send push notification");
      });
    }

    for (const [clientIndex, { ws }] of clientEntries.entries()) {
      const shouldNotify = clientIndex === plan.inAppRecipientIndex;
      const timestamp = new Date().toISOString();
      const connection = this.sessions.get(ws);
      const attentionPayload = {
        agentId: params.agentId,
        reason: params.reason,
        timestamp,
        shouldNotify,
        notification,
      };
      const message = wrapSessionMessage(
        connection?.session.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, ws)
          ? {
              type: "agent_attention_required",
              payload: attentionPayload,
            }
          : {
              type: "agent_stream",
              payload: {
                agentId: params.agentId,
                event: {
                  type: "attention_required",
                  provider: params.provider,
                  reason: params.reason,
                  timestamp,
                  shouldNotify,
                  notification,
                },
                timestamp,
              },
            },
      );

      this.sendToClient(ws, message);
    }
  }

  private async broadcastTerminalAttention(params: {
    terminalId: string;
    cwd: string;
    workspaceId?: string;
    terminalName: string;
    reason: TerminalAttentionReason;
  }): Promise<void> {
    const clientEntries: Array<{
      ws: WebSocketLike;
      state: ClientPresenceState;
    }> = [];

    for (const [ws, connection] of this.sessions) {
      if (
        !(await connection.session.subscribesToTerminalDirectory({
          cwd: params.cwd,
          ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        }))
      ) {
        continue;
      }
      clientEntries.push({
        ws,
        state: this.getClientActivityState(connection.session),
      });
    }

    const allStates = clientEntries.map((e) => e.state);
    const nowMs = Date.now();
    const workspaceId = params.workspaceId;

    const plan = computeNotificationPlan({
      allStates,
      focusTarget: { kind: "terminal", id: params.terminalId },
      pushEligible: true,
      nowMs,
    });

    const title = terminalAttentionTitle(params.reason);
    const body = params.terminalName;

    if (plan.shouldPush) {
      void this.pushNotificationSender
        .send({
          title,
          body,
          data: {
            serverId: this.serverId,
            terminalId: params.terminalId,
            cwd: params.cwd,
            ...(workspaceId ? { workspaceId } : {}),
          },
        })
        .catch((err) => {
          this.logger.warn(
            { err, terminalId: params.terminalId },
            "Failed to send push notification",
          );
        });
    }

    for (const [clientIndex, { ws }] of clientEntries.entries()) {
      const shouldNotify = clientIndex === plan.inAppRecipientIndex;
      const message = wrapSessionMessage({
        type: "terminal_attention_required",
        payload: {
          serverId: this.serverId,
          terminalId: params.terminalId,
          cwd: params.cwd,
          ...(workspaceId ? { workspaceId } : {}),
          reason: params.reason,
          title,
          body,
          shouldNotify,
        },
      });
      this.sendToClient(ws, message);
    }
  }
}

interface SocketRequestMetadata {
  host?: string;
  origin?: string;
  userAgent?: string;
  remoteAddress?: string;
}

function createWebSocketConnectionIdentity(
  requestMetadata: SocketRequestMetadata,
  metadata: ExternalSocketMetadata | undefined,
): WebSocketConnectionIdentity {
  return {
    connectionId: `conn_${randomUUID().replaceAll("-", "")}`,
    transport: metadata?.transport ?? "direct",
    peer: resolveConnectionPeer(requestMetadata, metadata),
    browserOrigin: requestMetadata.origin !== undefined,
    ...(requestMetadata.host ? { host: requestMetadata.host } : {}),
    ...(requestMetadata.origin ? { origin: requestMetadata.origin } : {}),
    ...(requestMetadata.userAgent ? { userAgent: requestMetadata.userAgent } : {}),
    ...(requestMetadata.remoteAddress ? { remoteAddress: requestMetadata.remoteAddress } : {}),
    ...(metadata?.relayConnectionId ? { relayConnectionId: metadata.relayConnectionId } : {}),
    ...(metadata?.hubDaemonId ? { hubDaemonId: metadata.hubDaemonId } : {}),
  };
}

function sessionConnectionKey(
  principalId: string,
  clientId: string,
  principal?: PrincipalContext,
): string {
  return JSON.stringify([
    principalId,
    clientId,
    principal?.principalType ?? null,
    principal?.organizationId ?? null,
    principal?.credentialId ?? null,
    principal?.grantVersion ?? null,
  ]);
}
function sessionConnectionBaseKey(principalId: string, clientId: string): string {
  return JSON.stringify([principalId, clientId]);
}

function safeCloseSocket(ws: WebSocketLike, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // ignore close errors
  }
}

function toConnectionLogFields(identity: WebSocketConnectionIdentity): Record<string, string> {
  return {
    connectionId: identity.connectionId,
    transport: identity.transport,
    peer: identity.peer,
    ...(identity.host ? { host: identity.host } : {}),
    ...(identity.origin ? { origin: identity.origin } : {}),
    ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
    ...(identity.remoteAddress ? { remoteAddress: identity.remoteAddress } : {}),
    ...(identity.relayConnectionId ? { relayConnectionId: identity.relayConnectionId } : {}),
    ...(identity.hubDaemonId ? { hubDaemonId: identity.hubDaemonId } : {}),
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
    ...(identity.appVersion ? { appVersion: identity.appVersion } : {}),
  };
}

function resolveConnectionPeer(
  requestMetadata: SocketRequestMetadata,
  metadata: ExternalSocketMetadata | undefined,
): WebSocketConnectionIdentity["peer"] {
  if (metadata !== undefined) return "external";
  if (!requestMetadata.remoteAddress) return "local_ipc";
  return isLoopbackAddress(requestMetadata.remoteAddress) ? "loopback" : "external";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  return ipv4.startsWith("127.");
}

function extractSocketRequestMetadata(request: unknown): SocketRequestMetadata {
  if (!request || typeof request !== "object") {
    return {};
  }

  const record = request as {
    headers?: {
      host?: unknown;
      origin?: unknown;
      "user-agent"?: unknown;
    };
    url?: unknown;
    socket?: {
      remoteAddress?: unknown;
    };
  };

  const host = typeof record.headers?.host === "string" ? record.headers.host : undefined;
  const origin = typeof record.headers?.origin === "string" ? record.headers.origin : undefined;
  const userAgent =
    typeof record.headers?.["user-agent"] === "string" ? record.headers["user-agent"] : undefined;
  const remoteAddress =
    typeof record.socket?.remoteAddress === "string" ? record.socket.remoteAddress : undefined;

  return {
    ...(host ? { host } : {}),
    ...(origin ? { origin } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  };
}

interface HostAuthority {
  hostname: string;
  port: string | null;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function parseHostAuthority(host: string): HostAuthority | null {
  const trimmed = host.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) {
      return null;
    }
    const hostname = stripIpv6Brackets(trimmed.slice(0, end + 1)).toLowerCase();
    const rest = trimmed.slice(end + 1);
    if (!rest) {
      return { hostname, port: null };
    }
    if (!rest.startsWith(":")) {
      return null;
    }
    const port = rest.slice(1);
    return port ? { hostname, port } : null;
  }

  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) {
    return { hostname: trimmed.toLowerCase(), port: null };
  }
  if (trimmed.indexOf(":", firstColon + 1) !== -1) {
    return { hostname: trimmed.toLowerCase(), port: null };
  }
  const hostname = trimmed.slice(0, firstColon).toLowerCase();
  const port = trimmed.slice(firstColon + 1);
  return hostname && port ? { hostname, port } : null;
}

function defaultPortForOriginProtocol(protocol: string): string | null {
  if (protocol === "http:") {
    return "80";
  }
  if (protocol === "https:") {
    return "443";
  }
  return null;
}

function isLoopbackAlias(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function isWebSocketSameOrigin(
  origin: string | undefined,
  requestHost: string | null,
): boolean {
  if (!origin || !requestHost) {
    return false;
  }

  if (origin === `http://${requestHost}` || origin === `https://${requestHost}`) {
    return true;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const originPort = originUrl.port || defaultPortForOriginProtocol(originUrl.protocol);
  if (!originPort) {
    return false;
  }

  const requestAuthority = parseHostAuthority(requestHost);
  if (!requestAuthority) {
    return false;
  }
  const requestPort = requestAuthority.port || defaultPortForOriginProtocol(originUrl.protocol);
  if (originPort !== requestPort) {
    return false;
  }

  return isLoopbackAlias(originUrl.hostname) && isLoopbackAlias(requestAuthority.hostname);
}

function selectWebSocketProtocol(
  protocols: Set<string>,
  password: string | undefined,
): string | false {
  if (!password) {
    return protocols.values().next().value ?? false;
  }

  for (const protocol of protocols) {
    const token = extractWsBearerToken(protocol);
    if (token !== null) {
      return protocol;
    }
  }

  return false;
}

function stringifyCloseReason(reason: unknown): string | null {
  if (typeof reason === "string") {
    return reason.length > 0 ? reason : null;
  }
  if (Buffer.isBuffer(reason)) {
    const text = reason.toString();
    return text.length > 0 ? text : null;
  }
  if (reason == null) {
    return null;
  }
  const text = String(reason);
  return text.length > 0 ? text : null;
}

function getControlRpcLogInfo(
  message: Extract<WSInboundMessage, { type: "session" }>["message"],
): { requestType: string; requestId: string; reason?: string } | null {
  if (message.type === "shutdown_server_request") {
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason: CLIENT_SHUTDOWN_RPC_REASON,
    };
  }
  if (message.type === "restart_server_request") {
    const reason = normalizeClientRestartRpcReason(message.reason);
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason,
    };
  }
  if (message.type === "daemon.update.request") {
    return {
      requestType: message.type,
      requestId: message.requestId,
      reason: "daemon_update",
    };
  }
  return null;
}

function extractRequestInfoFromUnknownWsInbound(
  payload: unknown,
): { requestId: string; requestType?: string } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as {
    type?: unknown;
    requestId?: unknown;
    message?: unknown;
  };

  // Session-wrapped messages
  if (record.type === "session" && record.message && typeof record.message === "object") {
    const msg = record.message as { requestId?: unknown; type?: unknown };
    if (typeof msg.requestId === "string") {
      return {
        requestId: msg.requestId,
        ...(typeof msg.type === "string" ? { requestType: msg.type } : {}),
      };
    }
  }

  // Non-session messages (future-proof)
  if (typeof record.requestId === "string") {
    return {
      requestId: record.requestId,
      ...(typeof record.type === "string" ? { requestType: record.type } : {}),
    };
  }

  return null;
}
