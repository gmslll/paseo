import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type {
  EnterpriseWorkspaceAuthorizationRecord,
  NodeContext,
  PrincipalContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AgentStorage } from "./agent/agent-storage.js";
import type { PaseoDaemonConfig } from "./bootstrap.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
  type ProductionAuditRuntimeOptions,
} from "./enterprise/audit/production-audit-runtime.js";
import type {
  EnterpriseAdmissionPort,
  EnterpriseAdmissionRuntime,
} from "./enterprise/identity/runtime.js";
import { PluginService } from "./plugins/index.js";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { HubRelationshipController } from "./hub/relationship-controller.js";
import { createEnterpriseAgentSessionContextRegistry } from "./session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "./session/enterprise-authority-receipt-state.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import { ScheduleService } from "./schedule/service.js";

const providerState = vi.hoisted(() => ({ shutdown: vi.fn() }));
vi.mock("./agent/provider-runtime.js", () => ({
  createAgentProviderRuntime: vi.fn(async () => ({
    snapshotManager: {
      getAgentManagerProviderState: () => ({ clients: [], providerDefinitions: [] }),
      replacePluginProviders: () => [],
      setRefreshTimeoutMs: () => undefined,
      destroy: vi.fn(),
    },
    setPaseoToolCatalog: () => undefined,
    shutdown: providerState.shutdown,
  })),
}));

const execute = promisify(execFile);

describe.runIf(process.platform === "darwin")("enterprise audit construction lifecycle", () => {
  let buildDirectory: string;
  let addonPath: string;
  const tempRoots: string[] = [];

  function captureConfigUnsubscribes(
    onUnsubscribe: (field: string) => void,
    onSubscribe?: (field: string) => void,
  ) {
    const unsubscribeByField = new Map<string, ReturnType<typeof vi.fn>>();
    vi.spyOn(DaemonConfigStore.prototype, "onFieldChange").mockImplementation((field) => {
      if (unsubscribeByField.has(field)) throw new Error(`duplicate config subscription: ${field}`);
      onSubscribe?.(field);
      const unsubscribe = vi.fn(() => onUnsubscribe(field));
      unsubscribeByField.set(field, unsubscribe);
      return unsubscribe;
    });
    return unsubscribeByField;
  }

  beforeAll(async () => {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), "bootstrap-construction-addon-"));
    addonPath = path.join(buildDirectory, "audit.node");
    await execute(process.execPath, [
      fileURLToPath(
        new URL("./enterprise/audit/native/build-darwin-audit-fs.mjs", import.meta.url),
      ),
      "--output",
      addonPath,
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    providerState.shutdown.mockReset();
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  afterAll(async () => {
    await rm(buildDirectory, { recursive: true, force: true });
  });

  function createRuntime(
    audit: ProductionAuditCapability,
    node: NodeContext,
    organizationId: string,
  ): EnterpriseAdmissionRuntime {
    const current = async () => true;
    const admission = {
      audit,
      authenticator: {
        node,
        configuredOrganizationId: organizationId,
        isCurrentPrincipalContext: current,
      },
      authenticate: async () => null,
      isCurrentPrincipalContext: current,
    } satisfies EnterpriseAdmissionPort;
    const deny = async () => {
      throw new Error("denied");
    };
    const resourceAuthorization = {
      filterWorkspaces<T extends EnterpriseWorkspaceAuthorizationRecord>(
        _ctx: PrincipalContext,
        rows: readonly T[],
      ): T[] {
        return [...rows];
      },
      assertWorkspace: deny,
      assertAgent: deny,
      assertBrowserProfile: deny,
      assertAppSlot: deny,
      resolveWorkspacePath: deny,
      canEmit: async () => false,
    } satisfies ResourceAuthorization;
    let generation = 0;
    return {
      audit,
      admission,
      node,
      agentContextRegistry: createEnterpriseAgentSessionContextRegistry(),
      authorityReceiptState: new MemoryAuthorityReceiptState(),
      grantVersionGuard: { isCurrent: () => true },
      resourceAuthorization,
      nextSessionBindingGeneration: () => `generation-${++generation}`,
    } satisfies EnterpriseAdmissionRuntime;
  }

  async function createFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-enterprise-construction-"));
    tempRoots.push(root);
    const paseoHome = path.join(root, ".paseo");
    const staticDir = path.join(root, "static");
    await mkdir(staticDir, { recursive: true });
    const enterpriseMultiUser = {
      enabled: true as const,
      organizationId: "org_0123456789abcdef",
      nodeId: "nod_0123456789abcdef",
      managementMode: "standalone" as const,
      legacyRecords: "owner_only" as const,
    };
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      enterpriseMultiUser,
    };
    let issuedAudit: ProductionAuditCapability | undefined;
    let issuedNode: NodeContext | undefined;
    const issue = vi.fn(async (options: ProductionAuditRuntimeOptions) => {
      issuedNode = options.node;
      issuedAudit = await productionAuditCapabilityIssuer.issue({
        ...options,
        nativeAddonPath: addonPath,
      });
      return issuedAudit;
    });
    const factory = async ({ audit }: { audit: ProductionAuditCapability }) => {
      if (!issuedNode) throw new Error("audit node was not captured");
      return createRuntime(audit, issuedNode, enterpriseMultiUser.organizationId);
    };
    return {
      config,
      issue,
      factory,
      get audit() {
        if (!issuedAudit) throw new Error("audit was not issued");
        return issuedAudit;
      },
    };
  }

  test("cleans consumers before closing audit when storage initialization fails", async () => {
    const fixture = await createFixture();
    const primary = new Error("initialize failed");
    const providerError = new Error("provider cleanup failed");
    const pluginError = new Error("plugin cleanup failed");
    const order: string[] = [];
    const initialize = vi.spyOn(AgentStorage.prototype, "initialize").mockRejectedValue(primary);
    providerState.shutdown.mockImplementation(async () => {
      expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
      order.push("provider");
      throw providerError;
    });
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockImplementation(async () => {
        expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
        order.push("plugin");
        throw pluginError;
      });
    const { createPaseoDaemon } = await import("./bootstrap.js");

    const error = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([primary, providerError, pluginError]);
    expect((error as Error & { cause?: unknown }).cause).toBe(primary);
    expect(order).toEqual(["provider", "plugin"]);
    expect(initialize).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("unsubscribes construction config listeners before closing audit", async () => {
    const fixture = await createFixture();
    const unsubscribes = captureConfigUnsubscribes(() => {
      expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
    });
    const primary = new Error("initialize failed after config subscriptions");
    vi.spyOn(AgentStorage.prototype, "initialize").mockRejectedValue(primary);
    const { createPaseoDaemon } = await import("./bootstrap.js");

    await expect(
      createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
        issueProductionAuditCapability: fixture.issue,
        createEnterpriseAdmissionRuntime: fixture.factory,
      }),
    ).rejects.toBe(primary);

    for (const field of ["trustedProxies", "hostnames", "app.baseUrl", "cors.allowedOrigins"]) {
      expect(unsubscribes.get(field)).toHaveBeenCalledOnce();
    }
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("unsubscribes early listeners when provider construction rejects", async () => {
    const fixture = await createFixture();
    const unsubscribes = captureConfigUnsubscribes(() => {
      expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
    });
    const primary = new Error("provider construction failed");
    const provider = await import("./agent/provider-runtime.js");
    vi.mocked(provider.createAgentProviderRuntime).mockRejectedValueOnce(primary);
    const { createPaseoDaemon } = await import("./bootstrap.js");

    await expect(
      createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
        issueProductionAuditCapability: fixture.issue,
        createEnterpriseAdmissionRuntime: fixture.factory,
      }),
    ).rejects.toBe(primary);

    for (const field of ["trustedProxies", "hostnames", "app.baseUrl", "cors.allowedOrigins"]) {
      expect(unsubscribes.get(field)).toHaveBeenCalledOnce();
    }
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("unsubscribes startup config listeners once across repeated stop", async () => {
    const fixture = await createFixture();
    const unsubscribes = captureConfigUnsubscribes(() => {
      expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });

    await daemon.start();
    const stopA = daemon.stop();
    const stopB = daemon.stop();
    expect(stopA).toBe(stopB);
    await expect(stopA).resolves.toBeUndefined();

    for (const field of [
      "trustedProxies",
      "hostnames",
      "app.baseUrl",
      "cors.allowedOrigins",
      "mcp.enabled",
      "mcp.injectIntoAgents",
      "appendSystemPrompt",
      "relay.enabled",
      "catalogRefreshTimeoutMs",
      "git.maxProcessesPerSecond",
      "git.maxProcessConcurrency",
    ]) {
      expect(unsubscribes.get(field)).toHaveBeenCalledOnce();
    }
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
    await expect(daemon.stop()).resolves.toBeUndefined();
    for (const unsubscribe of unsubscribes.values()) {
      if (unsubscribe.mock.calls.length > 0) expect(unsubscribe).toHaveBeenCalledOnce();
    }
  });

  test("uses the first paseoHome snapshot throughout construction", async () => {
    const fixture = await createFixture();
    const capturedPaseoHome = fixture.config.paseoHome;
    const attackerHome = path.join(path.dirname(capturedPaseoHome), "attacker-home");
    let paseoHomeReads = 0;
    Object.defineProperty(fixture.config, "paseoHome", {
      configurable: true,
      enumerable: true,
      get() {
        paseoHomeReads++;
        return paseoHomeReads === 1 ? capturedPaseoHome : attackerHome;
      },
    });
    const primary = new Error("initialize snapshot sentinel");
    vi.spyOn(AgentStorage.prototype, "initialize").mockRejectedValue(primary);
    const { createPaseoDaemon } = await import("./bootstrap.js");

    const error = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    }).catch((reason: unknown) => reason);

    expect(error).toBe(primary);
    expect(paseoHomeReads).toBe(1);
    await expect(access(attackerHome)).rejects.toThrow();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("stops construction after a capability closes during storage initialization", async () => {
    const fixture = await createFixture();
    let entered!: () => void;
    const initialized = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = vi
      .spyOn(AgentStorage.prototype, "initialize")
      .mockImplementation(async () => {
        entered();
        await blocked;
      });
    const list = vi.spyOn(AgentStorage.prototype, "list");
    providerState.shutdown.mockResolvedValue(undefined);
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockResolvedValue(undefined);
    const { createPaseoDaemon } = await import("./bootstrap.js");

    const pending = createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await initialized;
    await fixture.audit.close();
    release();

    await expect(pending).rejects.toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(initialize).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("start rejects synchronously when enterprise audit is closed", async () => {
    const fixture = await createFixture();
    const pluginStart = vi.spyOn(PluginService.prototype, "start");
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await fixture.audit.close();
    expect(() => daemon.start()).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(pluginStart).not.toHaveBeenCalled();
    await daemon.stop().catch(() => undefined);
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("plugin start close race fences before accepting", async () => {
    const fixture = await createFixture();
    const beginAccept = vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    );
    const prepare = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "prepareForShutdown");
    const close = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "close");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pluginStart = vi.spyOn(PluginService.prototype, "start").mockImplementation(async () => {
      entered();
      await gate;
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    const pending = daemon.start();
    await started;
    await fixture.audit.close();
    release();
    const startError = await pending.catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect(startError).not.toBeInstanceOf(AggregateError);
    expect((startError as Error).message).toContain("current runtime-issued");
    expect(pluginStart).toHaveBeenCalledOnce();
    expect(beginAccept).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("bind session host close race prevents plugin start", async () => {
    const fixture = await createFixture();
    const pluginStart = vi.spyOn(PluginService.prototype, "start");
    const bind = vi
      .spyOn(PluginService.prototype, "bindPaseoSessionHost")
      .mockImplementation(() => {
        void fixture.audit.close();
      });
    const beginAccept = vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    );
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await expect(daemon.start()).rejects.toThrow("current runtime-issued");
    expect(bind).toHaveBeenCalledOnce();
    expect(pluginStart).not.toHaveBeenCalled();
    expect(beginAccept).not.toHaveBeenCalled();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
    await daemon.stop().catch(() => undefined);
  });

  test("hub start close race reuses shared stop promise", async () => {
    const fixture = await createFixture();
    const beginAccept = vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    );
    const prepare = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "prepareForShutdown");
    const wsClose = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "close");
    const pluginStop = vi.spyOn(PluginService.prototype, "stopAllPlugins");
    let entered!: () => void;
    const hubEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hubStart = vi
      .spyOn(HubRelationshipController.prototype, "start")
      .mockImplementation(async () => {
        entered();
        await gate;
      });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    const startPending = daemon.start();
    await hubEntered;
    expect(beginAccept).not.toHaveBeenCalled();
    await fixture.audit.close();
    release();
    const startError = await startPending.catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect(startError).not.toBeInstanceOf(AggregateError);
    expect((startError as Error).message).toContain("current runtime-issued");
    expect(hubStart).toHaveBeenCalledOnce();
    expect(beginAccept).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    expect(wsClose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
    const stopA = daemon.stop();
    const stopB = daemon.stop();
    expect(stopA).toBe(stopB);
    await expect(stopA).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
    expect(wsClose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
  });

  test("shares flattened startup cleanup failures with stop", async () => {
    const fixture = await createFixture();
    const primary = new Error("plugin start failed");
    const prepareError = new Error("prepare failed");
    const pluginError = new Error("plugin cleanup failed");
    const pluginNestedError = new Error("plugin nested cleanup failed");
    const providerError = new Error("provider cleanup failed");
    const originalPrepare = VoiceAssistantWebSocketServer.prototype.prepareForShutdown;
    const prepare = vi
      .spyOn(VoiceAssistantWebSocketServer.prototype, "prepareForShutdown")
      .mockImplementationOnce(() => {
        throw prepareError;
      })
      .mockImplementation(function (this: VoiceAssistantWebSocketServer) {
        return Reflect.apply(originalPrepare, this, []);
      });
    const wsClose = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "close");
    const pluginStart = vi.spyOn(PluginService.prototype, "start").mockRejectedValue(primary);
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockRejectedValue(new AggregateError([pluginError, pluginNestedError]));
    providerState.shutdown.mockRejectedValue(providerError);
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });

    const startError = await daemon.start().catch((error: unknown) => error);

    expect(startError).toBeInstanceOf(AggregateError);
    expect((startError as AggregateError).errors).toEqual([
      primary,
      prepareError,
      pluginError,
      pluginNestedError,
      providerError,
    ]);
    expect((startError as Error & { cause?: unknown }).cause).toBe(primary);
    expect((startError as AggregateError).errors).not.toContainEqual(expect.any(AggregateError));
    expect(pluginStart).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(wsClose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);

    const stopA = daemon.stop();
    const stopB = daemon.stop();
    expect(stopA).toBe(stopB);
    const stopError = await stopA.catch((error: unknown) => error);
    expect(stopError).toBeInstanceOf(AggregateError);
    expect((stopError as AggregateError).errors).toEqual([
      prepareError,
      pluginError,
      pluginNestedError,
      providerError,
    ]);
    expect((stopError as Error & { cause?: unknown }).cause).toBe(prepareError);
    expect((stopError as AggregateError).errors).not.toContainEqual(expect.any(AggregateError));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(wsClose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
  });

  test("service proxy start close race fences before websocket publish", async () => {
    const fixture = await createFixture();
    fixture.config.serviceProxy = { publicBaseUrl: null, standaloneListen: "127.0.0.1:0" };
    const pluginStart = vi.spyOn(PluginService.prototype, "start");
    const beginAccept = vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    );
    const prepare = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "prepareForShutdown");
    const wsClose = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "close");
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startProxy = vi
      .spyOn(daemon.serviceProxy, "startStandalone")
      .mockImplementation(async (input) => {
        entered();
        await gate;
        return input.listenTarget;
      });
    const stopProxy = vi.spyOn(daemon.serviceProxy, "stopStandalone");
    const pending = daemon.start();
    await started;
    await fixture.audit.close();
    release();
    const startError = await pending.catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect(startError).not.toBeInstanceOf(AggregateError);
    expect((startError as Error).message).toContain("current runtime-issued");
    expect(startProxy).toHaveBeenCalledOnce();
    expect(stopProxy).toHaveBeenCalledOnce();
    expect(pluginStart).not.toHaveBeenCalled();
    expect(beginAccept).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(wsClose).not.toHaveBeenCalled();
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(stopProxy).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("rejects when the fulfilled start fence loses audit before its callback", async () => {
    const fixture = await createFixture();
    let armed = false;
    const closeInMicrotask = () => void fixture.audit.close();
    captureConfigUnsubscribes(
      () => undefined,
      (field) => {
        if (armed && field === "relay.enabled") queueMicrotask(closeInMicrotask);
      },
    );
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    armed = true;
    const startError = await daemon.start().catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toContain("current runtime-issued");
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  test("rejects after HTTP start resolves when audit closes before continuation", async () => {
    const fixture = await createFixture();
    let armed = false;
    const closeNextMicrotask = () => queueMicrotask(() => void fixture.audit.close());
    captureConfigUnsubscribes(
      () => undefined,
      (field) => {
        if (armed && field === "relay.enabled") queueMicrotask(closeNextMicrotask);
      },
    );
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    armed = true;
    const startError = await daemon.start().catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toContain("current runtime-issued");
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  test("HTTP listen close race fences before websocket construction", async () => {
    const fixture = await createFixture();
    const pluginStart = vi.spyOn(PluginService.prototype, "start");
    const beginAccept = vi.spyOn(
      VoiceAssistantWebSocketServer.prototype,
      "beginAcceptingConnections",
    );
    const prepare = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "prepareForShutdown");
    const wsClose = vi.spyOn(VoiceAssistantWebSocketServer.prototype, "close");
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const daemon = await createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    const originalListen = http.Server.prototype.listen;
    const closeAll = vi.spyOn(http.Server.prototype, "closeAllConnections");
    const httpClose = vi.spyOn(http.Server.prototype, "close");
    let auditClosePromise: Promise<void> | null = null;
    const guardedListen = function (this: http.Server, ...args: unknown[]) {
      auditClosePromise = fixture.audit.close();
      return Reflect.apply(originalListen, this, args);
    } as typeof originalListen;
    const listen = vi.spyOn(http.Server.prototype, "listen").mockImplementation(guardedListen);
    const pending = daemon.start();
    const startError = await pending.catch((error: unknown) => error);
    expect(startError).toBeInstanceOf(Error);
    expect(startError).not.toBeInstanceOf(AggregateError);
    expect((startError as Error).message).toContain("current runtime-issued");
    expect(auditClosePromise).not.toBeNull();
    await auditClosePromise;
    expect(listen).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalledOnce();
    expect(httpClose).toHaveBeenCalledOnce();
    expect(pluginStart).not.toHaveBeenCalled();
    expect(beginAccept).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(wsClose).not.toHaveBeenCalled();
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(closeAll).toHaveBeenCalledOnce();
    expect(httpClose).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("provider runtime close race fences later construction", async () => {
    const fixture = await createFixture();
    const initialize = vi.spyOn(AgentStorage.prototype, "initialize");
    const list = vi.spyOn(AgentStorage.prototype, "list");
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockResolvedValue(undefined);
    providerState.shutdown.mockResolvedValue(undefined);
    const provider = await import("./agent/provider-runtime.js");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(provider.createAgentProviderRuntime).mockClear();
    vi.mocked(provider.createAgentProviderRuntime).mockImplementationOnce(async () => {
      entered();
      await gate;
      return {
        snapshotManager: {
          getAgentManagerProviderState: () => ({ clients: [], providerDefinitions: [] }),
          replacePluginProviders: () => [],
          setRefreshTimeoutMs: () => undefined,
          destroy: vi.fn(),
        },
        setPaseoToolCatalog: () => undefined,
        shutdown: providerState.shutdown,
      };
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const pending = createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await started;
    await fixture.audit.close();
    release();
    await expect(pending).rejects.toThrow("current runtime-issued");
    expect(fixture.issue).toHaveBeenCalledOnce();
    expect(provider.createAgentProviderRuntime).toHaveBeenCalledOnce();
    expect(initialize).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
  });

  test("workspace reconciliation start close race fences reconcile", async () => {
    const fixture = await createFixture();
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockResolvedValue(undefined);
    providerState.shutdown.mockResolvedValue(undefined);
    const startSpy = vi.spyOn(WorkspaceReconciliationService.prototype, "start");
    const reconcile = vi.spyOn(WorkspaceReconciliationService.prototype, "reconcileNow");
    const dispose = vi.spyOn(WorkspaceReconciliationService.prototype, "dispose");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startSpy.mockImplementation(async () => {
      entered();
      await gate;
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const pending = createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await started;
    await fixture.audit.close();
    release();
    await expect(pending).rejects.toThrow("current runtime-issued");
    expect(reconcile).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("schedule start close race fences later construction", async () => {
    const fixture = await createFixture();
    const startSpy = vi.spyOn(ScheduleService.prototype, "start");
    const stopSpy = vi.spyOn(ScheduleService.prototype, "stop").mockResolvedValue(undefined);
    const list = vi.spyOn(AgentStorage.prototype, "list");
    const dispose = vi.spyOn(WorkspaceReconciliationService.prototype, "dispose");
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockResolvedValue(undefined);
    providerState.shutdown.mockResolvedValue(undefined);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startSpy.mockImplementation(async () => {
      entered();
      await gate;
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const pending = createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await started;
    list.mockClear();
    await fixture.audit.close();
    release();
    await expect(pending).rejects.toThrow("current runtime-issued");
    expect(list).not.toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("late agent storage list close race fences completion", async () => {
    const fixture = await createFixture();
    const scheduleStart = vi.spyOn(ScheduleService.prototype, "start");
    const scheduleStop = vi.spyOn(ScheduleService.prototype, "stop").mockResolvedValue(undefined);
    const dispose = vi.spyOn(WorkspaceReconciliationService.prototype, "dispose");
    const pluginStop = vi
      .spyOn(PluginService.prototype, "stopAllPlugins")
      .mockResolvedValue(undefined);
    providerState.shutdown.mockResolvedValue(undefined);
    let scheduleEntered!: () => void;
    const scheduleStarted = new Promise<void>((resolve) => {
      scheduleEntered = resolve;
    });
    let releaseSchedule!: () => void;
    const scheduleGate = new Promise<void>((resolve) => {
      releaseSchedule = resolve;
    });
    scheduleStart.mockImplementation(async () => {
      scheduleEntered();
      await scheduleGate;
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const pending = createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
      issueProductionAuditCapability: fixture.issue,
      createEnterpriseAdmissionRuntime: fixture.factory,
    });
    await scheduleStarted;
    let listEntered!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const list = vi.spyOn(AgentStorage.prototype, "list").mockImplementation(async () => {
      listEntered();
      await listGate;
      return [];
    });
    releaseSchedule();
    await listStarted;
    await fixture.audit.close();
    releaseList();
    await expect(pending).rejects.toThrow("current runtime-issued");
    expect(list).toHaveBeenCalledOnce();
    expect(scheduleStop).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(providerState.shutdown).toHaveBeenCalledOnce();
    expect(pluginStop).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("workspace reconciliation start rejection cleans registered resources", async () => {
    const fixture = await createFixture();
    const primary = new Error("reconciliation failed");
    const start = vi
      .spyOn(WorkspaceReconciliationService.prototype, "start")
      .mockRejectedValue(primary);
    const dispose = vi
      .spyOn(WorkspaceReconciliationService.prototype, "dispose")
      .mockImplementation(() => {
        expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
      });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    await expect(
      createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
        issueProductionAuditCapability: fixture.issue,
        createEnterpriseAdmissionRuntime: fixture.factory,
      }),
    ).rejects.toBe(primary);
    expect(start).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });

  test("schedule start rejection cleans registered resources", async () => {
    const fixture = await createFixture();
    const primary = new Error("schedule failed");
    const start = vi.spyOn(ScheduleService.prototype, "start").mockRejectedValue(primary);
    const stop = vi.spyOn(ScheduleService.prototype, "stop").mockImplementation(async () => {
      expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(true);
    });
    const { createPaseoDaemon } = await import("./bootstrap.js");
    await expect(
      createPaseoDaemon(fixture.config, pino({ level: "silent" }), {
        issueProductionAuditCapability: fixture.issue,
        createEnterpriseAdmissionRuntime: fixture.factory,
      }),
    ).rejects.toBe(primary);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(productionAuditCapabilityIssuer.current(fixture.audit)).toBe(false);
  });
});
