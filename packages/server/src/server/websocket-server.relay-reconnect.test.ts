import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import {
  asUint8Array,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/terminal-stream-protocol";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { EnterpriseAdmissionRuntime } from "./enterprise/identity/runtime.js";
import type { EnterpriseAdmissionPort } from "./enterprise/identity/runtime.js";
import {
  NodeContextSchema,
  PrincipalContextSchema,
  type EnterpriseWorkspaceAuthorizationRecord,
  type PrincipalContext,
  type ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { createEnterpriseAgentSessionContextRegistry } from "./session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "./session/enterprise-authority-receipt-state.js";

type SocketListener = (...args: unknown[]) => void;

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    constructor(_options: unknown) {
      MockWebSocketServer.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];

  class MockSession {
    cleanup = vi.fn(async () => {});
    handleMessage = vi.fn(async () => {});
    handleBinaryFrame = vi.fn((_frame: unknown) => {});
    supports = vi.fn((capability: string) => this.args.clientCapabilities?.[capability] === true);
    updateClientCapabilities = vi.fn((capabilities: Record<string, unknown> | null) => {
      this.args.clientCapabilities = capabilities;
    });
    clearAgentTimelineSubscription = vi.fn();
    getClientActivity = vi.fn(() => null);
    getSessionId = vi.fn(() => "mock-session-id");
    getEnterpriseSessionContext = vi.fn(() => this.args.enterpriseContext);
    getPermissions = vi.fn(() => this.args.permissions as string[]);
    allowsInbound = vi.fn(() => true);
    allowsPermission = vi.fn(() => true);
    publish = vi.fn((message: unknown) => {
      const onMessage = this.args.onMessage as ((message: unknown) => void) | undefined;
      onMessage?.(message);
    });
    resetPeakInflight = vi.fn(() => {});
    getRuntimeMetrics = vi.fn(() => ({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
      terminalDirectorySubscriptionCount: 0,
      terminalSubscriptionCount: 0,
      inflightRequests: 0,
      peakInflightRequests: 0,
    }));
    readonly args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }

  return { MockSession, instances };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: sessionMock.MockSession,
}));

vi.mock("./push/index.js", () => ({
  createPushNotifications: () => ({
    renew: () => undefined,
    revoke: () => undefined,
    send: async () => undefined,
  }),
}));

import { z } from "zod";
import { VoiceAssistantWebSocketServer } from "./websocket-server";
import { DAEMON_PERMISSIONS, parseServerInfoStatusPayload } from "./messages.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  externalSessionsByKey: Map<unknown, unknown>;
  externalSessionsByBaseKey: Map<unknown, unknown>;
  pendingConnections: Map<unknown, unknown>;
  socketIdentities: Map<unknown, unknown>;
  providerSnapshotManager: { destroy: () => void };
  checkoutDiffManager: { dispose: () => void };
  workspaceGitService: { dispose: () => Promise<void> };
  wss: { close: () => void };
  unsubscribeSpeechReadiness: (() => void) | null;
  attachSocket(
    ws: unknown,
    req: unknown,
    metadata?: unknown,
    allowDuringStartup?: boolean,
    admission?: unknown,
  ): Promise<void>;
  attachAuthenticatedSocket(ws: unknown, req: unknown, password?: string): Promise<void>;
}

const TEST_DAEMON_VERSION = "1.2.3-test";

function createEnterpriseRuntimeHarness() {
  const node = NodeContextSchema.parse({
    nodeId: "nod_aaaaaaaaaaaaaaaa",
    paseoServerId: "srv_test",
    mode: "standalone",
  });
  const principal = PrincipalContextSchema.parse({
    organizationId: "org_aaaaaaaaaaaaaaaa",
    principalType: "human",
    principalId: "usr_aaaaaaaaaaaaaaaa",
    credentialId: "cred-a",
    grantVersion: "grant-a",
    grants: [],
  });
  const authenticate = vi.fn(async () => principal);
  const current = vi.fn(async () => true);
  const canEmit = vi.fn(async () => true);
  function filterWorkspaces<T extends EnterpriseWorkspaceAuthorizationRecord>(
    _ctx: PrincipalContext,
    rows: readonly T[],
  ): T[] {
    return [...rows];
  }
  const deny = async () => {
    throw new Error("denied");
  };
  const resourceAuthorization: ResourceAuthorization = {
    filterWorkspaces,
    assertWorkspace: deny,
    assertAgent: deny,
    assertBrowserProfile: deny,
    assertAppSlot: deny,
    resolveWorkspacePath: deny,
    canEmit,
  };
  const agentContextRegistry = createEnterpriseAgentSessionContextRegistry();
  const authorityReceiptState = new MemoryAuthorityReceiptState();
  const grantVersionGuard = { isCurrent: vi.fn(() => true) };
  let generation = 0;
  const nextSessionBindingGeneration = vi.fn(() => `generation-${++generation}`);
  const admission = {
    releaseReady: true,
    authenticator: {
      node,
      configuredOrganizationId: principal.organizationId,
      isCurrentPrincipalContext: current,
    },
    authenticate,
    isCurrentPrincipalContext: current,
  } satisfies EnterpriseAdmissionPort;
  const runtime = {
    admission,
    node,
    agentContextRegistry,
    authorityReceiptState,
    grantVersionGuard,
    resourceAuthorization,
    nextSessionBindingGeneration,
  } satisfies EnterpriseAdmissionRuntime;
  return {
    runtime,
    node,
    principal,
    authenticate,
    current,
    canEmit,
    agentContextRegistry,
    authorityReceiptState,
    grantVersionGuard,
    resourceAuthorization,
    nextSessionBindingGeneration,
  };
}

const WireEnvelopeSchema = z.object({
  type: z.string().optional(),
  message: z
    .object({
      type: z.string().optional(),
      payload: z.unknown().optional(),
    })
    .optional(),
});

function parseSentEnvelope(data: unknown): z.infer<typeof WireEnvelopeSchema> {
  if (typeof data !== "string") throw new Error("Expected string frame");
  return WireEnvelopeSchema.parse(JSON.parse(data));
}

function sentEnvelopes(socket: MockSocket): z.infer<typeof WireEnvelopeSchema>[] {
  return socket.sent.filter((data) => typeof data === "string").map(parseSentEnvelope);
}

function sentServerInfoEnvelopes(socket: MockSocket): z.infer<typeof WireEnvelopeSchema>[] {
  return sentEnvelopes(socket).filter(
    (envelope) => parseServerInfoStatusPayload(envelope.message?.payload) !== null,
  );
}

function sentBinaryFrames(socket: MockSocket): Uint8Array[] {
  return socket.sent.map(asUint8Array).filter((frame): frame is Uint8Array => frame !== null);
}

function sentTerminalFrames(
  socket: MockSocket,
): NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>[] {
  return sentBinaryFrames(socket)
    .map(decodeTerminalStreamFrame)
    .filter(
      (frame): frame is NonNullable<ReturnType<typeof decodeTerminalStreamFrame>> => frame !== null,
    );
}

const BinaryFrameSchema = z.object({
  kind: z.literal("terminal"),
  frame: z.object({
    opcode: z.number(),
    slot: z.number(),
    payload: z.instanceof(Uint8Array),
  }),
});

class MockSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  private listeners = new Map<string, SocketListener[]>();

  on(event: "message" | "close" | "error", listener: SocketListener): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: SocketListener): void {
    const wrapped: SocketListener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  emit(event: "message" | "close" | "error", ...args: unknown[]): void {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers.slice()) {
      handler(...args);
    }
  }

  private off(event: "close" | "error", listener: SocketListener): void {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener),
    );
  }
}

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

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

function createServer(options?: {
  speechReadiness?: SpeechReadinessSnapshot | null;
  logger?: ReturnType<typeof createLogger>;
  startPaused?: boolean;
  enterpriseRuntime?: EnterpriseAdmissionRuntime;
}) {
  const speechReadiness = options?.speechReadiness ?? null;
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };
  const logger = options?.logger ?? createLogger();
  return new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(logger),
    "srv_test",
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
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set(), startPaused: options?.startPaused },
    createWorkspaceAutoNameStub(),
    undefined,
    speechReadiness
      ? {
          resolveStt: () => null,
          resolveSttLanguage: () => "en",
          resolveTts: () => null,
          resolveTurnDetection: () => null,
          resolveDictationStt: () => null,
          resolveDictationSttLanguage: () => "en",
          getReadiness: () => speechReadiness,
          onReadinessChange: vi.fn(() => () => {}),
          start: vi.fn(),
          stop: vi.fn(),
          ready: Promise.resolve(),
        }
      : undefined,
    undefined,
    undefined,
    TEST_DAEMON_VERSION,
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
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
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options?.enterpriseRuntime,
  );
}

function createReadySpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: [],
    missingLocalModelIds: [],
    download: {
      inProgress: false,
      error: null,
    },
    dictation: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Dictation is ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Realtime voice is ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: true,
      reasonCode: "ready",
      message: "Voice features are ready.",
      retryable: false,
      missingModelIds: [],
    },
  };
}

function createDownloadInProgressSpeechReadinessSnapshot(): SpeechReadinessSnapshot {
  return {
    generatedAt: "2026-02-14T00:00:00.000Z",
    requiredLocalModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    missingLocalModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    download: {
      inProgress: true,
      error: null,
    },
    dictation: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Dictation is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    realtimeVoice: {
      enabled: true,
      available: false,
      reasonCode: "stt_unavailable",
      message: "Realtime voice is unavailable: speech-to-text service is not ready.",
      retryable: false,
      missingModelIds: [],
    },
    voiceFeature: {
      enabled: true,
      available: false,
      reasonCode: "model_download_in_progress",
      message:
        "Voice features are unavailable while models download in the background (parakeet-tdt-0.6b-v2-int8).",
      retryable: true,
      missingModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    },
  };
}

function createHelloMessage(
  clientId: string,
  options?: { capabilities?: Record<string, boolean> },
) {
  return {
    type: "hello" as const,
    clientId,
    clientType: "cli" as const,
    protocolVersion: 1,
    ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
  };
}

function createDirectRequest() {
  return {
    headers: {
      host: "localhost:6767",
      origin: "http://localhost:6767",
      "user-agent": "vitest",
    },
    socket: {
      remoteAddress: "127.0.0.1",
    },
    url: "/ws",
  };
}

async function attachRelayAndHello(params: {
  server: VoiceAssistantWebSocketServer;
  socket: MockSocket;
  clientId: string;
}) {
  await params.server.attachExternalSocket(params.socket, { transport: "relay" });
  params.socket.emit("message", JSON.stringify(createHelloMessage(params.clientId)));
  expect(params.socket.sent.length).toBeGreaterThan(0);
  const envelope = parseSentEnvelope(params.socket.sent[0]);
  expect(envelope.type).toBe("session");
  const serverInfo = parseServerInfoStatusPayload(envelope.message?.payload);
  expect(envelope.message?.type).toBe("status");
  expect(serverInfo).not.toBeNull();
  return serverInfo!;
}

async function attachDirectAndHello(params: {
  server: VoiceAssistantWebSocketServer;
  socket: MockSocket;
  clientId: string;
}) {
  await asInternals<WebSocketServerInternals>(params.server).attachSocket(
    params.socket,
    createDirectRequest(),
  );
  params.socket.emit("message", JSON.stringify(createHelloMessage(params.clientId)));
  expect(params.socket.sent.length).toBeGreaterThan(0);
  const envelope = parseSentEnvelope(params.socket.sent[0]);
  expect(envelope.type).toBe("session");
  const serverInfo = parseServerInfoStatusPayload(envelope.message?.payload);
  expect(envelope.message?.type).toBe("status");
  expect(serverInfo).not.toBeNull();
  return serverInfo!;
}

function holdNextSessionMessage(session: (typeof sessionMock.instances)[number]): {
  finish: () => void;
} {
  let finish = () => {};
  session.handleMessage.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: () => finish(),
  };
}

function holdSessionCleanup(session: (typeof sessionMock.instances)[number]): {
  finish: () => void;
} {
  let finish = () => {};
  session.cleanup.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return {
    finish: () => finish(),
  };
}

describe("relay external socket reconnect behavior", () => {
  beforeEach(() => {
    sessionMock.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("keeps the same session when relay reconnects within grace window", async () => {
    const server = createServer();
    const clientId = "cid-relay-reconnect";

    const socket1 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket2,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("gives every plugin socket an exclusively owned session and cleans it immediately", async () => {
    const server = createServer();
    const firstSocket = new MockSocket();
    const firstAttachment = await server.attachPluginSocket("exclusive", firstSocket);
    firstSocket.emit("message", JSON.stringify(createHelloMessage("plugin:exclusive")));

    const secondSocket = new MockSocket();
    const secondAttachment = await server.attachPluginSocket("exclusive", secondSocket);
    secondSocket.emit("message", JSON.stringify(createHelloMessage("plugin:exclusive")));

    expect(sessionMock.instances).toHaveLength(2);
    firstSocket.emit("close", 1000, "plugin stopped");
    await firstAttachment.closed;
    expect(sessionMock.instances[0]?.cleanup).toHaveBeenCalledOnce();
    expect(sessionMock.instances[1]?.cleanup).not.toHaveBeenCalled();

    secondSocket.emit("close", 1000, "plugin stopped");
    await secondAttachment.closed;
    expect(sessionMock.instances[1]?.cleanup).toHaveBeenCalledOnce();
    await server.close();
  });

  test("rejects ordinary sockets that claim the reserved plugin client id", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await server.attachExternalSocket(socket, { transport: "relay" });
    socket.emit("message", JSON.stringify(createHelloMessage("plugin:not-a-plugin")));

    expect(socket.readyState).toBe(3);
    expect(sessionMock.instances).toHaveLength(0);
    await server.close();
  });

  test("passes hello capabilities through to the created session", async () => {
    const server = createServer();
    const socket = new MockSocket();

    await asInternals<WebSocketServerInternals>(server).attachSocket(socket, createDirectRequest());
    socket.emit(
      "message",
      JSON.stringify(
        createHelloMessage("client-capabilities", {
          capabilities: { [CLIENT_CAPS.reasoningMergeEnum]: true },
        }),
      ),
    );
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];
    expect(session.args.clientCapabilities).toEqual({
      [CLIENT_CAPS.reasoningMergeEnum]: true,
    });

    await server.close();
  });

  test("rejects sockets attached after shutdown begins", async () => {
    const server = createServer();
    const existingSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: existingSocket,
      clientId: "existing-client",
    });

    const heldCleanup = holdSessionCleanup(sessionMock.instances[0]);
    const closePromise = server.close();

    const lateSocket = new MockSocket();
    try {
      await server.attachExternalSocket(lateSocket, { transport: "relay" });
      lateSocket.emit("message", JSON.stringify(createHelloMessage("late-client")));

      expect({
        readyState: lateSocket.readyState,
        sessionCount: sessionMock.instances.length,
      }).toEqual({
        readyState: 3,
        sessionCount: 1,
      });
    } finally {
      heldCleanup.finish();
      await closePromise;
    }
  });

  test("accepts plugin startup sessions while application sessions remain paused", async () => {
    const server = createServer({ startPaused: true });
    const applicationSocket = new MockSocket();
    await server.attachExternalSocket(applicationSocket, { transport: "relay" });
    expect(applicationSocket.readyState).toBe(3);

    const pluginSocket = new MockSocket();
    const attachment = await server.attachPluginSocket("startup", pluginSocket);
    pluginSocket.emit("message", JSON.stringify(createHelloMessage("plugin:startup")));
    expect(sessionMock.instances).toHaveLength(1);

    server.beginAcceptingConnections();
    const readySocket = new MockSocket();
    await attachRelayAndHello({ server, socket: readySocket, clientId: "ready-client" });
    expect(sessionMock.instances).toHaveLength(2);

    pluginSocket.emit("close", 1000, "done");
    await attachment.closed;
    await server.close();
  });

  test("closes pending connection when hello timeout elapses", async () => {
    const server = createServer();

    const socket = new MockSocket();
    let closeCode: number | null = null;
    let closeReason = "";
    socket.on("close", (code: unknown, reason: unknown) => {
      closeCode = typeof code === "number" ? code : null;
      closeReason = typeof reason === "string" ? reason : "";
    });

    await asInternals<WebSocketServerInternals>(server).attachSocket(socket, createDirectRequest());
    await vi.advanceTimersByTimeAsync(15_000);

    expect(closeCode).toBe(4001);
    expect(closeReason).toBe("Hello timeout");
    expect(sessionMock.instances).toHaveLength(0);

    await server.close();
  });

  test("returns server_info when clientId reconnects with existing session", async () => {
    const server = createServer();
    const clientId = "cid-resume-flag";

    const firstSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: firstSocket,
      clientId,
    });

    firstSocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);

    const secondSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: secondSocket,
      clientId,
    });

    await server.close();
  });

  test("returns server_info for distinct clientIds", async () => {
    const server = createServer();

    const firstSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: firstSocket,
      clientId: "cid-new-1",
    });

    const secondSocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: secondSocket,
      clientId: "cid-new-2",
    });
    expect(sessionMock.instances).toHaveLength(2);

    await server.close();
  });

  test("isolates resumable sessions by principal while sharing hello bootstrap", async () => {
    const server = createServer();
    const clientId = "shared-client-id";
    const ownerSocket = new MockSocket();
    const hubSocket = new MockSocket();

    const ownerInfo = await attachRelayAndHello({ server, socket: ownerSocket, clientId });
    await server.attachExternalSocket(
      hubSocket,
      { transport: "hub", hubDaemonId: "daemon-1" },
      { principalId: "hub:daemon-1", permissions: ["hub.execute"] },
    );
    hubSocket.emit("message", JSON.stringify(createHelloMessage(clientId)));
    const hubEnvelope = parseSentEnvelope(hubSocket.sent[0]);
    const hubInfo = parseServerInfoStatusPayload(hubEnvelope.message?.payload);

    expect(sessionMock.instances).toHaveLength(2);
    expect(ownerInfo.permissions).toEqual(DAEMON_PERMISSIONS);
    expect(hubInfo?.permissions).toEqual(["hub.execute"]);
    await server.close();
  });

  test("rejects session messages before hello", async () => {
    const server = createServer();
    const socket = new MockSocket();
    let closeCode: number | null = null;
    let closeReason = "";
    socket.on("close", (code: unknown, reason: unknown) => {
      closeCode = typeof code === "number" ? code : null;
      closeReason = typeof reason === "string" ? reason : "";
    });

    await server.attachExternalSocket(socket, { transport: "relay" });
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "ping",
        },
      }),
    );
    expect(closeCode).toBe(4002);
    expect(["Invalid hello", "Session message before hello"]).toContain(closeReason);
    expect(sessionMock.instances).toHaveLength(0);

    await server.close();
  });

  test("logs control RPCs with the socket identity", async () => {
    const logger = createLogger();
    const server = createServer({ logger });
    const socket = new MockSocket();

    await server.attachExternalSocket(socket, {
      transport: "relay",
      relayConnectionId: "relay-conn-1",
    });
    socket.emit("message", JSON.stringify(createHelloMessage("cid-control-log")));
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "shutdown_server_request",
          requestId: "shutdown-1",
        },
      }),
    );
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: expect.stringMatching(/^conn_/),
        transport: "relay",
        relayConnectionId: "relay-conn-1",
        clientId: "cid-control-log",
        sessionId: "mock-session-id",
        requestType: "shutdown_server_request",
        requestId: "shutdown-1",
        reason: "client_shutdown_rpc",
      }),
      "ws_control_rpc_received",
    );

    await server.close();
  });

  test("responds to top-level ping while provider diagnostic is still running", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-ping-during-provider-diagnostic",
    });

    const session = sessionMock.instances[0];
    const providerDiagnostic = holdNextSessionMessage(session);

    const sentBeforeDiagnostic = socket.sent.length;
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "slow-provider-diagnostic",
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(1);
    });

    socket.emit("message", JSON.stringify({ type: "ping" }));
    await Promise.resolve();

    expect(sentEnvelopes(socket).slice(sentBeforeDiagnostic)).toContainEqual({ type: "pong" });

    providerDiagnostic.finish();
    await Promise.resolve();
    await server.close();
  });

  test("routes later session requests while provider diagnostic is still running", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-session-request-during-provider-diagnostic",
    });

    const session = sessionMock.instances[0];
    const providerDiagnostic = holdNextSessionMessage(session);

    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "slow-provider-diagnostic",
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(1);
    });

    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "ping",
          requestId: "second-session-request",
          clientSentAt: Date.now(),
        },
      }),
    );
    await vi.waitFor(() => {
      expect(session.handleMessage).toHaveBeenCalledTimes(2);
    });

    providerDiagnostic.finish();
    await Promise.resolve();
    await server.close();
  });

  test("sends rpc_error when an async session request fails", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-session-request-failure",
    });

    const session = sessionMock.instances[0];
    session.handleMessage.mockRejectedValueOnce(new Error("handler exploded"));

    const sentBeforeRequest = socket.sent.length;
    socket.emit(
      "message",
      JSON.stringify({
        type: "session",
        message: {
          type: "provider_diagnostic_request",
          provider: "grok",
          requestId: "failing-provider-diagnostic",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sentEnvelopes(socket).slice(sentBeforeRequest)).toContainEqual({
        type: "session",
        message: {
          type: "rpc_error",
          payload: {
            requestId: "failing-provider-diagnostic",
            requestType: "provider_diagnostic_request",
            error: "Invalid message",
            code: "invalid_message",
          },
        },
      });
    });

    await server.close();
  });

  test("reuses direct session when same clientId reconnects within grace window", async () => {
    const server = createServer();
    const clientId = "cid-direct-reconnect";

    const socket1 = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    const socket2 = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: socket2,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    await server.close();
  });

  test("reuses one session when switching from direct to relay with the same clientId", async () => {
    const server = createServer();
    const clientId = "cid-switch-path";

    const directSocket = new MockSocket();
    await attachDirectAndHello({
      server,
      socket: directSocket,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    const relaySocket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: relaySocket,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);

    const { onMessage } = session.args;
    expect(onMessage).toBeTypeOf("function");
    if (typeof onMessage === "function") {
      onMessage({
        type: "status",
        payload: { status: "ok" },
      });
    }

    expect(directSocket.sent.length).toBeGreaterThan(0);
    expect(relaySocket.sent.length).toBeGreaterThan(0);

    directSocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.cleanup).not.toHaveBeenCalled();

    relaySocket.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });

  test("cleans up relay session when reconnect grace expires", async () => {
    const server = createServer();
    const clientId = "cid-relay-grace-expire";

    const socket1 = new MockSocket();
    await attachRelayAndHello({
      server,
      socket: socket1,
      clientId,
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket1.emit("close", 1006, "");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(session.cleanup).toHaveBeenCalledTimes(1);

    await server.close();
  });

  test("advertises current features in initial server_info", async () => {
    const server = createServer();
    const socket = new MockSocket();

    const serverInfo = await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-stable-project-identity",
    });

    expect(serverInfo.features?.stableProjectIdentity).toBe(true);
    expect(serverInfo.features?.canonicalSubmittedPrompts).toBe(true);
    expect(serverInfo.features?.providersSnapshotCwd).toBe(true);
    expect(serverInfo.features?.pluginLogs).toBe(true);
    expect(serverInfo.features?.workspaceMarkUnread).toBe(true);
    expect(serverInfo.features?.["terminal-input-mode-replay"]).toBe(true);
    expect(serverInfo.features?.["terminal-size-ownership"]).toBe(true);
    expect(serverInfo.features?.agentTurnIdentity).toBeUndefined();
    expect(serverInfo.permissions).toEqual(DAEMON_PERMISSIONS);
    await server.close();
  });

  test("includes voice capabilities in initial server_info when speech readiness exists", async () => {
    const speechReadiness = createReadySpeechReadinessSnapshot();
    const server = createServer({ speechReadiness });

    const socket = new MockSocket();
    const serverInfo = (await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-capabilities",
    })) as {
      version?: unknown;
      capabilities?: {
        voice?: {
          dictation?: { enabled?: unknown; reason?: unknown };
          voice?: { enabled?: unknown; reason?: unknown };
        };
      };
    };
    expect(serverInfo.version).toBe(TEST_DAEMON_VERSION);
    expect(serverInfo.capabilities?.voice?.dictation?.enabled).toBe(
      speechReadiness.dictation.enabled,
    );
    expect(serverInfo.capabilities?.voice?.dictation?.reason).toBe("");
    expect(serverInfo.capabilities?.voice?.voice?.enabled).toBe(
      speechReadiness.realtimeVoice.enabled,
    );
    expect(serverInfo.capabilities?.voice?.voice?.reason).toBe("");

    await server.close();
  });

  test("broadcasts updated server_info when capabilities change", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-broadcast",
    });
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(1);

    const speechReadiness = createReadySpeechReadinessSnapshot();
    server.publishSpeechReadiness(speechReadiness);
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    const secondEnvelope = sentServerInfoEnvelopes(socket)[1];
    const secondPayload = parseServerInfoStatusPayload(secondEnvelope.message?.payload);
    expect(secondPayload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(secondPayload?.capabilities?.voice?.voice.enabled).toBe(true);

    // Same readiness should not produce another server_info broadcast.
    server.publishSpeechReadiness(speechReadiness);
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    await server.close();
  });

  test("includes temporary retry guidance while models are downloading", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-server-info-download-guidance",
    });
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(1);

    server.publishSpeechReadiness(createDownloadInProgressSpeechReadinessSnapshot());
    expect(sentServerInfoEnvelopes(socket)).toHaveLength(2);

    const envelope = sentServerInfoEnvelopes(socket)[1];
    const payload = parseServerInfoStatusPayload(envelope.message?.payload);
    expect(payload?.capabilities?.voice?.dictation.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.voice.enabled).toBe(true);
    expect(payload?.capabilities?.voice?.dictation.reason).toContain("Try again in a few minutes.");
    expect(payload?.capabilities?.voice?.voice.reason).toContain("Try again in a few minutes.");

    await server.close();
  });

  test("routes inbound terminal frames to session.handleBinaryFrame", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-inbound",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    socket.emit(
      "message",
      Buffer.from(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 9,
          payload: new TextEncoder().encode("ls\r"),
        }),
      ),
    );
    expect(session.handleBinaryFrame).toHaveBeenCalledTimes(1);
    const { frame } = BinaryFrameSchema.parse(session.handleBinaryFrame.mock.calls[0]?.[0]);
    expect(frame.opcode).toBe(TerminalStreamOpcode.Input);
    expect(frame.slot).toBe(9);
    expect(new TextDecoder().decode(frame.payload)).toBe("ls\r");

    await server.close();
  });

  test("sends status error when async binary frame handling fails", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-inbound-failure",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];
    session.handleBinaryFrame.mockRejectedValueOnce(new Error("binary exploded"));

    const sentBeforeFrame = socket.sent.length;
    socket.emit(
      "message",
      Buffer.from(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 11,
          payload: new TextEncoder().encode("pwd\r"),
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(sentEnvelopes(socket).slice(sentBeforeFrame)).toContainEqual({
        type: "session",
        message: {
          type: "status",
          payload: {
            status: "error",
            message: "Invalid message: binary exploded",
          },
        },
      });
    });

    await server.close();
  });

  test("sends outbound terminal frames from session over websocket", async () => {
    const server = createServer();

    const socket = new MockSocket();
    await attachRelayAndHello({
      server,
      socket,
      clientId: "cid-binary-outbound",
    });
    expect(sessionMock.instances).toHaveLength(1);
    const session = sessionMock.instances[0];

    const { onBinaryMessage } = session.args;
    expect(onBinaryMessage).toBeTypeOf("function");
    if (typeof onBinaryMessage === "function") {
      onBinaryMessage(new Uint8Array([TerminalStreamOpcode.Output, 12, 0x6f, 0x6b]));
    }

    const terminalFrames = sentTerminalFrames(socket);
    expect(terminalFrames).toHaveLength(1);
    const frame = terminalFrames[0];
    expect(frame.opcode).toBe(TerminalStreamOpcode.Output);
    expect(frame.slot).toBe(12);
    expect(new TextDecoder().decode(frame.payload ?? new Uint8Array())).toBe("ok");

    await server.close();
  });
});

describe("enterprise admission", () => {
  beforeEach(() => {
    sessionMock.instances.length = 0;
  });
  test("legacy admission preserves hub execution agents", async () => {
    const server = createServer();
    const socket = new MockSocket();
    const hubExecutionAgents = {
      create: vi.fn(),
      control: vi.fn(),
      subscribe: vi.fn(),
      invalidateAuthority: vi.fn(),
    };
    const admission = {
      kind: "legacy" as const,
      principalId: "owner",
      permissions: ["daemon.read", "daemon.read"],
      hubExecutionAgents,
    };
    try {
      await asInternals<WebSocketServerInternals>(server).attachSocket(
        socket,
        createDirectRequest(),
        undefined,
        false,
        admission,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("legacy-hub")));
      await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(1));
      const args = sessionMock.instances[0]!.args;
      expect(args.hubExecutionAgents).toBe(hubExecutionAgents);
      expect(args.permissions).toEqual(["daemon.read"]);
      expect(Object.isFrozen(args.permissions)).toBe(true);
      expect(args.enterpriseContext).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  test("enterprise server_info throw cleans unpublished session", async () => {
    const h = createEnterpriseRuntimeHarness();
    const primary = new Error("emit failed");
    h.canEmit.mockRejectedValueOnce(primary);
    const logger = createLogger();
    const server = createServer({ enterpriseRuntime: h.runtime, logger });
    const socket = new MockSocket();
    const admission = {
      kind: "enterprise",
      principalId: h.principal.principalId,
      permissions: [],
      enterprise: {
        principal: h.principal,
        node: h.node,
        runtime: h.runtime,
        grantVersionGuard: h.grantVersionGuard,
      },
    };
    try {
      await asInternals<WebSocketServerInternals>(server).attachSocket(
        socket,
        createDirectRequest(),
        undefined,
        false,
        admission,
      );
      const internals = asInternals<WebSocketServerInternals>(server);
      socket.emit("message", JSON.stringify(createHelloMessage("enterprise-throw")));
      await vi.waitFor(() => expect(sessionMock.instances[0]?.cleanup).toHaveBeenCalledOnce());
      expect(sentServerInfoEnvelopes(socket)).toHaveLength(0);
      expect(h.nextSessionBindingGeneration).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
      const warning = logger.warn.mock.calls.find(
        (call) => call[1] === "pending websocket message failed",
      );
      expect(warning?.[0].err).toBe(primary);
      expect(socket.readyState).toBe(3);
      expect(internals.sessions.size).toBe(0);
      expect(internals.externalSessionsByKey.size).toBe(0);
      expect(internals.externalSessionsByBaseKey.size).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("enterprise server_info and cleanup errors are observed", async () => {
    const h = createEnterpriseRuntimeHarness();
    const primary = new Error("emit failed");
    const cleanup = new Error("cleanup failed");
    h.canEmit.mockImplementationOnce(async () => {
      const s = sessionMock.instances[0];
      s?.cleanup.mockRejectedValueOnce(cleanup);
      throw primary;
    });
    const logger = createLogger();
    const server = createServer({ enterpriseRuntime: h.runtime, logger });
    const internals = asInternals<WebSocketServerInternals>(server);
    const socket = new MockSocket();
    const admission = {
      kind: "enterprise",
      principalId: h.principal.principalId,
      permissions: [],
      enterprise: {
        principal: h.principal,
        node: h.node,
        runtime: h.runtime,
        grantVersionGuard: h.grantVersionGuard,
      },
    };
    try {
      await asInternals<WebSocketServerInternals>(server).attachSocket(
        socket,
        createDirectRequest(),
        undefined,
        false,
        admission,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("enterprise-throw-aggregate")));
      await vi.waitFor(() => expect(sessionMock.instances[0]?.cleanup).toHaveBeenCalledOnce());
      expect(socket.readyState).toBe(3);
      expect(sentServerInfoEnvelopes(socket)).toHaveLength(0);
      expect(h.nextSessionBindingGeneration).toHaveBeenCalledOnce();
      expect(internals.sessions.size).toBe(0);
      expect(internals.externalSessionsByKey.size).toBe(0);
      expect(internals.externalSessionsByBaseKey.size).toBe(0);
      const warning = logger.warn.mock.calls.find(
        (call) => call[1] === "pending websocket message failed",
      );
      expect(warning).toBeDefined();
      const warningError = warning![0].err;
      expect(warningError).toBeInstanceOf(AggregateError);
      expect((warningError as AggregateError).errors[0]).toBe(primary);
      expect((warningError as AggregateError).errors[1]).toBe(cleanup);
      expect((warningError as AggregateError).cause).toBe(primary);
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    } finally {
      await server.close();
    }
  });

  test("enterprise server_info false cleanup runs once", async () => {
    const h = createEnterpriseRuntimeHarness();
    const cleanupError = new Error("cleanup failed");
    h.canEmit.mockResolvedValueOnce(false);
    const server = createServer({ enterpriseRuntime: h.runtime });
    const internals = asInternals<WebSocketServerInternals>(server);
    const socket = new MockSocket();
    const admission = {
      kind: "enterprise",
      principalId: h.principal.principalId,
      permissions: [],
      enterprise: {
        principal: h.principal,
        node: h.node,
        runtime: h.runtime,
        grantVersionGuard: h.grantVersionGuard,
      },
    };
    try {
      await asInternals<WebSocketServerInternals>(server).attachSocket(
        socket,
        createDirectRequest(),
        undefined,
        false,
        admission,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("enterprise-false")));
      await vi.waitFor(() => expect(sessionMock.instances[0]).toBeDefined());
      sessionMock.instances[0]!.cleanup.mockRejectedValueOnce(cleanupError);
      await vi.waitFor(() => expect(sessionMock.instances[0]?.cleanup).toHaveBeenCalledOnce());
      expect(socket.readyState).toBe(3);
      expect(sentServerInfoEnvelopes(socket)).toHaveLength(0);
      expect(h.nextSessionBindingGeneration).toHaveBeenCalledOnce();
      expect(internals.sessions.size).toBe(0);
      expect(internals.externalSessionsByKey.size).toBe(0);
      expect(internals.externalSessionsByBaseKey.size).toBe(0);
    } finally {
      await server.close();
    }
  });

  test("close waits for all sessions and reuses promise", async () => {
    const server = createServer();
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    await attachDirectAndHello({ server, socket: socketA, clientId: "close-a" });
    await attachDirectAndHello({ server, socket: socketB, clientId: "close-b" });
    const [sessionA, sessionB] = sessionMock.instances.slice(-2);
    const primary = new Error("sync cleanup");
    const secondary = new Error("async cleanup");
    sessionA!.cleanup.mockImplementationOnce(() => {
      throw primary;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionB!.cleanup.mockImplementationOnce(async () => {
      await gate;
      throw secondary;
    });
    const internals = asInternals<WebSocketServerInternals>(server);
    const destroy = vi.spyOn(internals.providerSnapshotManager, "destroy");
    const diffDispose = vi.spyOn(internals.checkoutDiffManager, "dispose");
    const gitDispose = vi.spyOn(internals.workspaceGitService, "dispose");
    const wssClose = vi.spyOn(internals.wss, "close");
    const closeA = server.close();
    const closeB = server.close();
    expect(closeA).toBe(closeB);
    let settled = false;
    void closeA.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const error = await closeA.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, secondary]);
    expect((error as AggregateError).cause).toBe(primary);
    expect(destroy).toHaveBeenCalledOnce();
    expect(diffDispose).toHaveBeenCalledOnce();
    expect(gitDispose).toHaveBeenCalledOnce();
    expect(wssClose).toHaveBeenCalledOnce();
    expect(internals.sessions.size).toBe(0);
    expect(internals.externalSessionsByKey.size).toBe(0);
    expect(internals.externalSessionsByBaseKey.size).toBe(0);
    expect(internals.pendingConnections.size).toBe(0);
    expect(internals.socketIdentities.size).toBe(0);
    expect(sessionA!.cleanup).toHaveBeenCalledOnce();
    expect(sessionB!.cleanup).toHaveBeenCalledOnce();
  });

  test("close continues teardown after a pre-barrier unsubscribe throw", async () => {
    const server = createServer();
    const socket = new MockSocket();
    await attachDirectAndHello({ server, socket, clientId: "close-prebarrier" });
    const session = sessionMock.instances.at(-1)!;
    const internals = asInternals<WebSocketServerInternals>(server);
    const primary = new Error("unsubscribe failed");
    let nestedClose: Promise<void> | undefined;
    internals.unsubscribeSpeechReadiness = () => {
      nestedClose = server.close();
      throw primary;
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.cleanup.mockImplementationOnce(async () => {
      await gate;
    });
    const destroy = vi.spyOn(internals.providerSnapshotManager, "destroy");
    const wssClose = vi.spyOn(internals.wss, "close");
    const closePromise = server.close();
    expect(nestedClose).toBe(closePromise);
    let settled = false;
    void closePromise.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const error = await closePromise.catch((reason: unknown) => reason);
    expect(error).toBe(primary);
    expect(destroy).toHaveBeenCalledOnce();
    expect(wssClose).toHaveBeenCalledOnce();
    expect(internals.sessions.size).toBe(0);
    expect(internals.externalSessionsByKey.size).toBe(0);
    expect(internals.externalSessionsByBaseKey.size).toBe(0);
    expect(session.cleanup).toHaveBeenCalledOnce();
  });

  test.each([
    ["enumerable extra", (base: object) => ({ ...base, extra: true })],
    ["symbol extra", (base: object) => Object.assign({ ...base }, { [Symbol("extra")]: true })],
    [
      "non-enumerable extra",
      (base: object) => Object.defineProperty({ ...base }, "extra", { value: true }),
    ],
    [
      "partial enterprise",
      (_base: object) => ({
        kind: "enterprise",
        principalId: "usr_aaaaaaaaaaaaaaaa",
        permissions: [],
        enterprise: {},
      }),
    ],
    [
      "principal accessor",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: object }).enterprise,
          get principal() {
            throw new Error("getter");
          },
        },
      }),
    ],
    [
      "node accessor",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: object }).enterprise,
          get node() {
            throw new Error("getter");
          },
        },
      }),
    ],
    [
      "ownKeys throwing",
      (base: object) =>
        new Proxy(base, {
          ownKeys() {
            throw new Error("ownKeys");
          },
        }),
    ],
    [
      "legacy enterprise mixed",
      (base: object) => ({
        ...base,
        kind: "legacy",
        enterprise: (base as { enterprise: object }).enterprise,
      }),
    ],
    [
      "nested enterprise symbol",
      (base: object) => ({
        ...base,
        enterprise: { ...(base as { enterprise: object }).enterprise, [Symbol("x")]: true },
      }),
    ],
    [
      "cross-kind selector extra",
      (base: object) => {
        const b = base as { enterprise: { principal: object } };
        return {
          ...base,
          enterprise: {
            ...b.enterprise,
            principal: {
              ...b.enterprise.principal,
              grants: [
                {
                  action: "app.use",
                  selector: { kind: "self", organizationId: "org_aaaaaaaaaaaaaaaa" },
                },
              ],
            },
          },
        };
      },
    ],
    [
      "permissions sparse",
      (base: object) => ({
        ...base,
        permissions: Object.assign([], { 1: "daemon.read", length: 2 }),
      }),
    ],
    [
      "permissions symbol",
      (base: object) => ({
        ...base,
        permissions: Object.assign(["daemon.read"], { [Symbol("x")]: true }),
      }),
    ],
    [
      "grants sparse",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: object }).enterprise,
          principal: {
            ...(base as { enterprise: { principal: object } }).enterprise.principal,
            grants: Object.assign([], { 1: {}, length: 2 }),
          },
        },
      }),
    ],
    [
      "grants symbol",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: object }).enterprise,
          principal: {
            ...(base as { enterprise: { principal: object } }).enterprise.principal,
            grants: Object.assign([], { [Symbol("x")]: true }),
          },
        },
      }),
    ],
    [
      "workspaceIds sparse",
      (base: object) => {
        const b = base as { enterprise: { principal: Record<string, unknown> } };
        return {
          ...base,
          enterprise: {
            ...(base as { enterprise: object }).enterprise,
            principal: {
              ...b.enterprise.principal,
              grants: [
                {
                  action: "workspace.metadata.read",
                  selector: {
                    kind: "workspace",
                    workspaceIds: Object.assign([], { 1: "ws-a", length: 2 }),
                  },
                },
              ],
            },
          },
        };
      },
    ],
    [
      "workspaceIds symbol",
      (base: object) => {
        const b = base as { enterprise: { principal: Record<string, unknown> } };
        return {
          ...base,
          enterprise: {
            ...(base as { enterprise: object }).enterprise,
            principal: {
              ...b.enterprise.principal,
              grants: [
                {
                  action: "workspace.metadata.read",
                  selector: {
                    kind: "workspace",
                    workspaceIds: Object.assign(["ws-a"], { [Symbol("x")]: true }),
                  },
                },
              ],
            },
          },
        };
      },
    ],
    [
      "principal non-enumerable",
      (base: object) => {
        const e = (base as { enterprise: { principal: object } }).enterprise;
        const p = Object.defineProperty({ ...e.principal }, "extra", { value: true });
        return {
          ...base,
          enterprise: { ...(base as { enterprise: object }).enterprise, principal: p },
        };
      },
    ],
    [
      "node symbol",
      (base: object) => {
        const e = (base as { enterprise: object }).enterprise;
        const n = Object.assign(
          { nodeId: "nod_aaaaaaaaaaaaaaaa", paseoServerId: "srv_test", mode: "standalone" },
          { [Symbol("x")]: true },
        );
        return { ...base, enterprise: { ...e, node: n } };
      },
    ],
    ["principal mismatch", (base: object) => ({ ...base, principalId: "usr_bbbbbbbbbbbbbbbb" })],
    [
      "runtime copy",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: { runtime: object } }).enterprise,
          runtime: { ...(base as { enterprise: { runtime: object } }).enterprise.runtime },
        },
      }),
    ],
    [
      "guard copy",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: { grantVersionGuard: object } }).enterprise,
          grantVersionGuard: {
            ...(base as { enterprise: { grantVersionGuard: object } }).enterprise.grantVersionGuard,
          },
        },
      }),
    ],
    [
      "node mismatch",
      (base: object) => ({
        ...base,
        enterprise: {
          ...(base as { enterprise: object }).enterprise,
          node: { nodeId: "nod_bbbbbbbbbbbbbbbb", paseoServerId: "srv_test", mode: "standalone" },
        },
      }),
    ],
    ["invalid permission", (base: object) => ({ ...base, permissions: ["invalid"] })],
    ["inherited prototype", (base: object) => Object.create({ evil: true, ...base })],
    [
      "own __proto__",
      (base: object) =>
        Object.defineProperty({ ...base }, "__proto__", { enumerable: true, value: true }),
    ],
  ])("strict admission rejects %s before session side effects", async (_name, mutate) => {
    const h = createEnterpriseRuntimeHarness();
    const server = createServer({ enterpriseRuntime: h.runtime });
    const socket = new MockSocket();
    const closes: unknown[][] = [];
    socket.on("close", (...args) => closes.push(args));
    const admission = mutate({
      kind: "enterprise",
      principalId: h.principal.principalId,
      permissions: [],
      enterprise: {
        principal: h.principal,
        node: h.node,
        runtime: h.runtime,
        grantVersionGuard: h.grantVersionGuard,
      },
    });
    try {
      await expect(
        asInternals<WebSocketServerInternals>(server).attachSocket(
          socket,
          createDirectRequest(),
          undefined,
          false,
          admission,
        ),
      ).resolves.toBeUndefined();
      expect(closes.length).toBeGreaterThan(0);
      expect(sessionMock.instances).toHaveLength(0);
      expect(h.nextSessionBindingGeneration).not.toHaveBeenCalled();
      expect(h.canEmit).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
  test.each(["permissions", "grants", "workspaceIds"])(
    "admission array accessor %s",
    async (field) => {
      const h = createEnterpriseRuntimeHarness();
      const server = createServer({ enterpriseRuntime: h.runtime });
      const socket = new MockSocket();
      const closes: unknown[][] = [];
      socket.on("close", (...args) => closes.push(args));
      const getter = vi.fn(() => {
        if (field === "permissions") return "daemon.read";
        if (field === "workspaceIds") return "ws-a";
        return { action: "app.use", selector: { kind: "self" } };
      });
      const arr: unknown[] = [];
      Object.defineProperty(arr, "0", { enumerable: true, get: getter });
      const base = {
        kind: "enterprise",
        principalId: h.principal.principalId,
        permissions: [],
        enterprise: {
          principal: h.principal,
          node: h.node,
          runtime: h.runtime,
          grantVersionGuard: h.grantVersionGuard,
        },
      };
      if (field === "permissions") base.permissions = arr as never;
      else
        base.enterprise.principal = {
          ...h.principal,
          grants:
            field === "grants"
              ? arr
              : [
                  {
                    action: "workspace.metadata.read",
                    selector: { kind: "workspace", workspaceIds: arr },
                  },
                ],
        } as never;
      try {
        await asInternals<WebSocketServerInternals>(server).attachSocket(
          socket,
          createDirectRequest(),
          undefined,
          false,
          base,
        );
        expect(getter).not.toHaveBeenCalled();
        expect(closes.length).toBeGreaterThan(0);
        expect(sessionMock.instances).toHaveLength(0);
        expect(h.nextSessionBindingGeneration).not.toHaveBeenCalled();
        expect(h.canEmit).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );
  test("enterprise direct authentication creates a canonical session", async () => {
    const h = createEnterpriseRuntimeHarness();
    const server = createServer({ enterpriseRuntime: h.runtime });
    const socket = new MockSocket();
    const base = createDirectRequest();
    const request = {
      ...base,
      headers: { ...base.headers, "sec-websocket-protocol": "paseo.bearer.pat-test" },
    };
    await asInternals<WebSocketServerInternals>(server).attachAuthenticatedSocket(
      socket,
      request,
      undefined,
    );
    expect(h.authenticate).toHaveBeenCalledTimes(1);
    expect(h.authenticate.mock.calls[0]?.[0]).toBe("pat-test");
    expect(h.authenticate.mock.calls[0]?.[1]).toEqual({
      node: h.node,
      transport: "direct",
      peer: "loopback",
      remoteAddress: "127.0.0.1",
      origin: "http://localhost:6767",
      userAgent: "vitest",
    });
    socket.emit("message", JSON.stringify(createHelloMessage("enterprise-client")));
    await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(1));
    const args = sessionMock.instances[0]!.args;
    const enterpriseValue = args.enterpriseContext;
    expect(enterpriseValue).toBeDefined();
    if (!enterpriseValue || typeof enterpriseValue !== "object")
      throw new Error("missing enterprise context");
    const principalValue: unknown = Reflect.get(enterpriseValue, "principal");
    const nodeValue: unknown = Reflect.get(enterpriseValue, "node");
    if (
      !principalValue ||
      typeof principalValue !== "object" ||
      !Array.isArray(Reflect.get(principalValue, "grants"))
    )
      throw new Error("invalid principal context");
    if (!nodeValue || typeof nodeValue !== "object") throw new Error("invalid node context");
    const enterprise = { principal: principalValue, node: nodeValue };
    expect(enterprise.principal).toEqual(h.principal);
    expect(enterprise.node).toEqual(h.node);
    expect(Object.isFrozen(enterprise.principal)).toBe(true);
    expect(Object.isFrozen(enterprise.principal.grants)).toBe(true);
    expect(Object.isFrozen(enterprise.node)).toBe(true);
    expect(args.enterpriseAgentContextRegistry).toBe(h.agentContextRegistry);
    expect(args.authorityReceiptState).toBe(h.authorityReceiptState);
    expect(args.principalGrantVersionGuard).toBe(h.grantVersionGuard);
    expect(args.resourceAuthorization).toBe(h.resourceAuthorization);
    expect(h.nextSessionBindingGeneration).toHaveBeenCalledTimes(1);
    expect(h.canEmit).toHaveBeenCalledWith(
      h.principal,
      expect.objectContaining({
        type: "status",
        payload: expect.objectContaining({ status: "server_info" }),
      }),
      { kind: "transport_control", control: "server_info" },
    );
    await server.close();
  });
  test("captures changing top and principal proxies once", async () => {
    const h = createEnterpriseRuntimeHarness();
    const server = createServer({ enterpriseRuntime: h.runtime });
    const socket = new MockSocket();
    const grant = {
      action: "workspace.metadata.read",
      selector: { kind: "workspace", workspaceIds: ["ws-a"] },
    };
    const principalTarget = { ...h.principal, grants: [grant] };
    let pKeys = 0;
    let tKeys = 0;
    const pDesc = new Map<PropertyKey, number>();
    const tDesc = new Map<PropertyKey, number>();
    const principal = new Proxy(principalTarget, {
      ownKeys: () => {
        if (++pKeys > 1) throw new Error("re-read");
        return Reflect.ownKeys(principalTarget);
      },
      getOwnPropertyDescriptor: (_t, k) => {
        const n = (pDesc.get(k) ?? 0) + 1;
        pDesc.set(k, n);
        if (n > 1) throw new Error("re-read");
        return Object.getOwnPropertyDescriptor(principalTarget, k);
      },
    });
    const topTarget = {
      kind: "enterprise",
      principalId: h.principal.principalId,
      permissions: [],
      enterprise: {
        principal,
        node: h.node,
        runtime: h.runtime,
        grantVersionGuard: h.grantVersionGuard,
      },
    };
    const top = new Proxy(topTarget, {
      ownKeys: () => {
        if (++tKeys > 1) throw new Error("re-read");
        return Reflect.ownKeys(topTarget);
      },
      getOwnPropertyDescriptor: (_t, k) => {
        const n = (tDesc.get(k) ?? 0) + 1;
        tDesc.set(k, n);
        if (n > 1) throw new Error("re-read");
        return Object.getOwnPropertyDescriptor(topTarget, k);
      },
    });
    try {
      await asInternals<WebSocketServerInternals>(server).attachSocket(
        socket,
        createDirectRequest(),
        undefined,
        false,
        top,
      );
      topTarget.permissions = ["daemon.read"];
      principalTarget.credentialId = "mutated";
      grant.action = "daemon.read";
      grant.selector.workspaceIds[0] = "mutated";
      socket.emit("message", JSON.stringify(createHelloMessage("changing")));
      await vi.waitFor(() => expect(sessionMock.instances).toHaveLength(1));
      const ctx = sessionMock.instances[0]!.args.enterpriseContext as {
        principal: PrincipalContext;
      };
      expect(ctx.principal.credentialId).toBe("cred-a");
      expect(ctx.principal.grants[0]!.action).toBe("workspace.metadata.read");
      const selector = ctx.principal.grants[0]!.selector;
      expect(selector.kind).toBe("workspace");
      if (selector.kind !== "workspace") throw new Error("workspace selector expected");
      expect(selector.workspaceIds[0]).toBe("ws-a");
      expect(Object.isFrozen(ctx.principal)).toBe(true);
      expect(Object.isFrozen(ctx.principal.grants)).toBe(true);
      expect(Object.isFrozen(ctx.principal.grants[0])).toBe(true);
      expect(Object.isFrozen(ctx.principal.grants[0]!.selector)).toBe(true);
      expect(Object.isFrozen(ctx.principal.grants[0]!.selector.workspaceIds)).toBe(true);
      expect(Object.isFrozen(sessionMock.instances[0]!.args.permissions)).toBe(true);
      expect(tKeys).toBe(1);
      expect(pKeys).toBe(1);
      for (const key of ["kind", "principalId", "permissions", "enterprise"])
        expect(tDesc.get(key)).toBe(1);
      for (const key of [
        "principalType",
        "principalId",
        "organizationId",
        "credentialId",
        "grantVersion",
        "grants",
      ])
        expect(pDesc.get(key)).toBe(1);
      expect(sessionMock.instances[0]!.args.principalGrantVersionGuard).toBe(h.grantVersionGuard);
      expect(h.nextSessionBindingGeneration).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  test.each([false, "throw"])("auth current fence %s closes before session", async (mode) => {
    const h = createEnterpriseRuntimeHarness();
    h.current.mockImplementation(async () => {
      if (mode === "throw") throw new Error("current");
      return false;
    });
    const server = createServer({ enterpriseRuntime: h.runtime });
    const socket = new MockSocket();
    const req = createDirectRequest();
    req.headers["sec-websocket-protocol"] = "paseo.bearer.pat-test";
    try {
      await asInternals<WebSocketServerInternals>(server).attachAuthenticatedSocket(
        socket,
        req,
        undefined,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("stale")));
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
      expect(sessionMock.instances).toHaveLength(0);
      expect(h.nextSessionBindingGeneration).not.toHaveBeenCalled();
      expect(h.canEmit).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
