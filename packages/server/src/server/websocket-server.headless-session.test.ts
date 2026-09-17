/**
 * What this covers: `openHeadlessSession`'s own decisions — refusing without an enterprise runtime,
 * keeping the Session out of the maps `listSessions()` reads, and routing close to cleanup.
 *
 * What it does not: `ws` and `Session` are mocked here, as they are in every other test that
 * constructs this server, so nothing below proves a real Session is constructible without a
 * transport. That belongs to an integration test with a real daemon.
 */
import type { Server as HTTPServer } from "http";
import type pino from "pino";

import {
  NodeContextSchema,
  PrincipalContextSchema,
  type EnterpriseWorkspaceAuthorizationRecord,
  type PrincipalContext,
  type ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { EnterpriseAdmissionPort } from "./enterprise/identity/runtime.js";
import type { EnterpriseAdmissionRuntime } from "./enterprise/identity/runtime.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { ScheduleService } from "./schedule/service.js";
import { createEnterpriseAgentSessionContextRegistry } from "./session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "./session/enterprise-authority-receipt-state.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

const TEST_DAEMON_VERSION = "1.2.3-test";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    on() {
      return this;
    }
    close() {}
  }
  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];
  class MockSession {
    cleanup = vi.fn(async () => {});
    handleMessage = vi.fn(async () => {});
    updateClientCapabilities = vi.fn(() => {});
    readonly args: Record<string, unknown>;
    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }
  return { MockSession, instances };
});

vi.mock("ws", () => ({ WebSocketServer: wsModuleMock.MockWebSocketServer }));
vi.mock("./session.js", () => ({ Session: sessionMock.MockSession }));

beforeEach(() => {
  sessionMock.instances.length = 0;
});

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createEnterpriseRuntime(): {
  runtime: EnterpriseAdmissionRuntime;
  principal: PrincipalContext;
} {
  const node = NodeContextSchema.parse({
    nodeId: "nod_aaaaaaaaaaaaaaaa",
    paseoServerId: "srv_test",
    mode: "managed",
  });
  const principal = PrincipalContextSchema.parse({
    organizationId: "org_aaaaaaaaaaaaaaaa",
    principalType: "human",
    principalId: "usr_aaaaaaaaaaaaaaaa",
    credentialId: "cred-a",
    grantVersion: "grant-a",
    // A real selector, so the permissions come out of the same derivation an admitted connection
    // uses rather than an empty list that would prove nothing.
    grants: [
      { action: "workspace.write", selector: { kind: "workspace", workspaceIds: ["wks_a"] } },
    ],
  });
  const deny = async () => {
    throw new Error("denied");
  };
  const resourceAuthorization: ResourceAuthorization = {
    filterWorkspaces: <T extends EnterpriseWorkspaceAuthorizationRecord>(
      _ctx: PrincipalContext,
      rows: readonly T[],
    ): T[] => [...rows],
    assertWorkspace: deny,
    assertAgent: deny,
    assertBrowserProfile: deny,
    assertAppSlot: deny,
    resolveWorkspacePath: deny,
    canEmit: vi.fn(async () => true),
  };
  let generation = 0;
  const runtime = {
    admission: createStub<EnterpriseAdmissionPort>({
      authenticator: {
        node,
        configuredOrganizationId: principal.organizationId,
        isCurrentPrincipalContext: vi.fn(async () => true),
      },
      isCurrentPrincipalContext: vi.fn(async () => true),
    }),
    node,
    agentContextRegistry: createEnterpriseAgentSessionContextRegistry(),
    authorityReceiptState: new MemoryAuthorityReceiptState(),
    grantVersionGuard: { isCurrent: vi.fn(() => true) },
    resourceAuthorization,
    nextSessionBindingGeneration: vi.fn(() => `generation-${++generation}`),
  } satisfies EnterpriseAdmissionRuntime;
  return { runtime, principal };
}

// Positional, and long: each argument carries its index in the constructor so this list is
// maintained by reading the signature rather than by counting commas.
function createServer(enterpriseRuntime?: EnterpriseAdmissionRuntime) {
  const logger = createLogger();
  return new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}), // 1 server
    createStub<pino.Logger>(logger), // 2 logger
    "srv_test", // 3 serverId
    createStub<AgentManager>({
      subscribe: vi.fn(() => () => {}),
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
      getMetricsSnapshot: vi.fn(() => ({
        totalAgents: 0,
        idleAgents: 0,
        runningAgents: 0,
        pendingPermissionAgents: 0,
        erroredAgents: 0,
      })),
    }), // 4 agentManager
    createStub<AgentStorage>({}), // 5 agentStorage
    createStub<DownloadTokenStore>({}), // 6 downloadTokenStore
    "/tmp/paseo-headless-test", // 7 paseoHome
    createStub<DaemonConfigStore>({
      onApply: vi.fn(() => () => {}),
      onChange: vi.fn(() => () => {}),
    }), // 8 daemonConfigStore
    null, // 9 mcpBaseUrl
    { allowedOrigins: new Set(), startPaused: true }, // 10 wsConfig
    createStub<WorkspaceAutoName>({
      scheduleForWorktree: () => {},
      scheduleForDirectory: () => {},
    }), // 11 workspaceAutoName
    undefined, // 12 auth
    undefined, // 13 speech
    undefined, // 14 terminalManager
    undefined, // 15 dictation
    TEST_DAEMON_VERSION, // 16 daemonVersion
    undefined, // 17 onLifecycleIntent
    undefined, // 18 projectRegistry
    undefined, // 19 workspaceRegistry
    createStub<ScheduleService>({}), // 20 scheduleService
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }), // 21 checkoutDiffManager
    undefined, // 22 serviceProxy
    undefined, // 23 scriptRuntimeStore
    undefined, // 24 onBranchChanged
    undefined, // 25 getDaemonTcpPort
    undefined, // 26 getDaemonTcpHost
    undefined, // 27 resolveScriptHealth
    undefined, // 28 workspaceGitService
    undefined, // 29 github
    undefined, // 30 pushNotificationSender
    createProviderSnapshotManagerStub().manager, // 31 providerSnapshotManager
    undefined, // 32 daemonRuntimeConfig
    undefined, // 33 serviceProxyPublicBaseUrl
    undefined, // 34 browserToolsBroker
    undefined, // 35 hubRelationships
    undefined, // 36 workspaceSetupRuntime (undefined takes the parameter default)
    undefined, // 37 pluginRuntime
    undefined, // 38 orchestrationSkills
    undefined, // 39 workspaceLabelService
    enterpriseRuntime, // 40 enterpriseRuntime
  );
}

describe("opening a Session for a request that arrived without a socket", () => {
  test("refuses when the daemon is not an enterprise node", () => {
    const { principal } = createEnterpriseRuntime();

    const opened = createServer().openHeadlessSession({
      principal,
      clientId: "machine-rpc-1",
      onMessage: () => {},
    });

    expect(opened).toBeNull();
    expect(sessionMock.instances).toHaveLength(0);
  });

  test("opens one and leaves the socket session list alone", () => {
    const { runtime, principal } = createEnterpriseRuntime();
    const server = createServer(runtime);

    const opened = server.openHeadlessSession({
      principal,
      clientId: "machine-rpc-1",
      onMessage: () => {},
    });

    expect(opened).not.toBeNull();
    expect(sessionMock.instances).toHaveLength(1);
    // listSessions() is what broadcasts and project updates fan out over. A machine RPC answers one
    // caller and must not start receiving everyone else's traffic.
    expect(server.listSessions()).toEqual([]);
  });

  test("gives the Session the caller's own permissions", () => {
    const { runtime, principal } = createEnterpriseRuntime();
    const server = createServer(runtime);

    server.openHeadlessSession({ principal, clientId: "machine-rpc-1", onMessage: () => {} });

    // Derived from the Principal's grants, so a machine RPC can never do more than the same person
    // could over a socket.
    expect(sessionMock.instances[0]!.args.permissions).toEqual(["workspace.write"]);
  });

  test("closes by cleaning the Session up", () => {
    const { runtime, principal } = createEnterpriseRuntime();
    const server = createServer(runtime);
    const opened = server.openHeadlessSession({
      principal,
      clientId: "machine-rpc-1",
      onMessage: () => {},
    })!;

    opened.close();

    expect(sessionMock.instances[0]!.cleanup).toHaveBeenCalledTimes(1);
  });
});
