import { describe, expect, test, vi } from "vitest";
import {
  BROWSER_AUTOMATION_COMMAND_NAMES,
  type BrowserAutomationCommandName,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type {
  AuthorizedAgent,
  AuthorizedBrowserProfile,
  AuthorizedWorkspace,
  FencedLease,
} from "@getpaseo/protocol/messages";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseAgentContextHandle,
} from "../session/enterprise-agent-session-context-registry.js";
import {
  BrowserProfileLeaseManager,
  type BrowserProfileLeaseAuthorization,
} from "../enterprise/browser/lease-manager.js";
import {
  BrowserToolsBroker,
  type BrowserHostClient,
  type EnterpriseBrowserProfileLeasePort,
  type EnterpriseBrowserToolsRuntime,
} from "./broker.js";
import {
  BrowserPageIdentityRegistry,
  createAuthenticatedBrowserHostSession,
  type AuthenticatedBrowserHostSession,
} from "./page-identity-registry.js";

const ORGANIZATION_ID = "org_1111111111111111";
const SECOND_ORGANIZATION_ID = "org_2222222222222222";
const NODE_ID = "nod_1111111111111111";
const SECOND_NODE_ID = "nod_2222222222222222";
const PRINCIPAL_ID = "usr_1111111111111111";
const SECOND_PRINCIPAL_ID = "usr_2222222222222222";
const PROFILE_A = "brp_1111111111111111";
const PROFILE_B = "brp_2222222222222222";
const BROWSER_A = "11111111-1111-4111-8111-111111111111";

function pageIdentityProfile(): AuthorizedBrowserProfile {
  return {
    browserProfileId: PROFILE_A,
    organizationId: ORGANIZATION_ID,
    homeNodeId: NODE_ID,
    businessIdentityId: "bid_1111111111111111",
    ownerPrincipalId: PRINCIPAL_ID,
    platform: "generic",
    businessAccountKey: PROFILE_A,
    label: PROFILE_A,
    partitionKey: `persist:paseo-enterprise-${PROFILE_A}`,
    downloadRoot: `/profiles/${PROFILE_A}/downloads`,
    expectedIdentity: {
      hostnames: ["shop.example"],
      accountLabelHash: "sha256:account-a",
    },
    status: "ready",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

class EnterpriseHost implements BrowserHostClient {
  public readonly hostKind = "desktop app";
  public readonly supportedCommands: readonly BrowserAutomationCommandName[] = [
    ...BROWSER_AUTOMATION_COMMAND_NAMES,
  ];
  public readonly enterpriseProfiles?: { version: 1 };
  public readonly homeNodeId?: string;
  public readonly authenticatedSession?: AuthenticatedBrowserHostSession;
  public readonly receivedRequests: BrowserAutomationExecuteRequest[] = [];

  public constructor(
    public readonly id: string,
    options: {
      enterprise?: boolean;
      homeNodeId?: string;
      authenticatedSession?: AuthenticatedBrowserHostSession | null;
    } = {},
  ) {
    if (options.enterprise !== false) {
      this.enterpriseProfiles = { version: 1 };
      this.homeNodeId = options.homeNodeId ?? NODE_ID;
      this.authenticatedSession =
        options.authenticatedSession === null
          ? undefined
          : (options.authenticatedSession ??
            createAuthenticatedBrowserHostSession({
              clientId: id,
              homeNodeId: this.homeNodeId,
              sessionBindingGeneration: "session-a",
            }));
    }
  }

  public readonly sendBrowserAutomationRequest = (
    request: BrowserAutomationExecuteRequest,
  ): void => {
    this.receivedRequests.push(request);
  };

  public respond(
    broker: BrowserToolsBroker,
    request: BrowserAutomationExecuteRequest,
    payload: Omit<BrowserAutomationExecuteResponse["payload"], "requestId">,
  ): boolean {
    return broker.receiveResponse(this.id, {
      type: "browser.automation.execute.response",
      payload: {
        ...payload,
        requestId: request.requestId,
      } as BrowserAutomationExecuteResponse["payload"],
    });
  }
}

interface EnterpriseFixture {
  broker: BrowserToolsBroker;
  pageIdentity: BrowserPageIdentityRegistry | null;
  handles: Record<"a" | "b" | "c", EnterpriseAgentContextHandle>;
  workspaces: Record<"a" | "b" | "c", AuthorizedWorkspace>;
  manager: BrowserProfileLeaseManager;
  acquired: FencedLease[];
  getAuditCallCount(): number;
  getResolverCalls(): number;
  setAuthorization(
    handle: EnterpriseAgentContextHandle,
    authorization: BrowserProfileLeaseAuthorization,
  ): void;
  getAuthorization(handle: EnterpriseAgentContextHandle): BrowserProfileLeaseAuthorization;
  mutateDependencies(): void;
}

async function createEnterpriseFixture(
  options: {
    createRequestId?: () => string;
    invalidateHost?: (hostClientId: string) => Promise<void>;
    onHostTeardownError?: (error: Error, hostClientId: string) => void;
    pageIdentity?: BrowserPageIdentityRegistry | null;
  } = {},
): Promise<EnterpriseFixture> {
  const registry = createEnterpriseAgentSessionContextRegistry();
  const makeHandle = (
    agentId: string,
    generation: string,
    organizationId = ORGANIZATION_ID,
    principalId = PRINCIPAL_ID,
  ) =>
    registry.bind({
      agentId,
      context: {
        principal: {
          organizationId,
          principalType: "human",
          principalId,
          credentialId: "credential-a",
          grantVersion: "grant-a",
          grants: [{ action: "browser.use", selector: { kind: "self" } }],
        },
        node: { nodeId: NODE_ID, paseoServerId: "server-a", mode: "managed" },
        sessionBindingGeneration: generation,
      },
    });
  const handles = {
    a: makeHandle("agent-a", "session-a"),
    b: makeHandle("agent-b", "session-b"),
    c: makeHandle("agent-c", "session-c", SECOND_ORGANIZATION_ID, SECOND_PRINCIPAL_ID),
  };
  const makeWorkspace = (
    workspaceId: string,
    organizationId = ORGANIZATION_ID,
    principalId = PRINCIPAL_ID,
  ): AuthorizedWorkspace => ({
    organizationId,
    nodeId: NODE_ID,
    workspaceId,
    ownerPrincipalId: principalId,
    createdByPrincipalId: principalId,
  });
  const workspaces = {
    a: makeWorkspace("workspace-a"),
    b: makeWorkspace("workspace-b"),
    c: makeWorkspace("workspace-a", SECOND_ORGANIZATION_ID, SECOND_PRINCIPAL_ID),
  };
  const makeAuthorization = (
    handle: EnterpriseAgentContextHandle,
    workspace: AuthorizedWorkspace,
    browserProfileId: string,
  ): BrowserProfileLeaseAuthorization => {
    const agent: AuthorizedAgent = { ...workspace, agentId: handle.agentId };
    const profile: AuthorizedBrowserProfile = {
      browserProfileId,
      organizationId: workspace.organizationId,
      homeNodeId: workspace.nodeId,
      businessIdentityId:
        browserProfileId === PROFILE_A ? "bid_1111111111111111" : "bid_2222222222222222",
      ownerPrincipalId: workspace.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: browserProfileId,
      label: browserProfileId,
      partitionKey: `persist:paseo-enterprise-${browserProfileId}`,
      downloadRoot: `/profiles/${browserProfileId}/downloads`,
      expectedIdentity: {
        hostnames: ["shop.example"],
        accountLabelHash: "sha256:account-a",
      },
      status: "ready",
      createdAt: "2026-09-10T00:00:00.000Z",
      updatedAt: "2026-09-10T00:00:00.000Z",
    };
    return { workspace, agent, profile, bindingRevision: `binding-${workspace.workspaceId}` };
  };
  const authorizations = new Map([
    [handles.a, makeAuthorization(handles.a, workspaces.a, PROFILE_A)],
    [handles.b, makeAuthorization(handles.b, workspaces.b, PROFILE_B)],
    [handles.c, makeAuthorization(handles.c, workspaces.c, PROFILE_A)],
  ]);
  let leaseSequence = 0;
  let auditCallCount = 0;
  const manager = new BrowserProfileLeaseManager({
    generationStorage: {
      read: async () => null,
      write: async () => {},
    },
    createLeaseId: () => `lea_11111111-1111-4111-8111-${String(++leaseSequence).padStart(12, "0")}`,
    createRequestId: () => `wait-${leaseSequence + 1}`,
    auditSink: {
      append: async () => {
        auditCallCount += 1;
        return {} as never;
      },
    },
    maxLeaseTtlMs: 30_000,
    isCurrentHandle: (handle) => registry.isCurrentHandle(handle),
    resolveAuthorization: (handle, browserProfileId) => {
      const authorization = authorizations.get(handle);
      if (!authorization || authorization.profile.browserProfileId !== browserProfileId) {
        throw new Error("Browser Profile is not authorized.");
      }
      return authorization;
    },
  });
  await manager.initialize();
  const acquired: FencedLease[] = [];
  const leases: EnterpriseBrowserProfileLeasePort = {
    acquire: async (input) => {
      const lease = await manager.acquire(input);
      acquired.push(lease);
      return lease;
    },
    attachHost: (input) => manager.attachHost(input),
    validateLease: (input) => manager.validateLease(input),
    releaseLease: (input) => manager.releaseLease(input),
    invalidateHost:
      options.invalidateHost ?? ((hostClientId) => manager.invalidateHost(hostClientId)),
  };
  let resolverCalls = 0;
  let requestSequence = 0;
  const pageIdentity =
    options.pageIdentity === null
      ? null
      : (options.pageIdentity ??
        new BrowserPageIdentityRegistry({
          profiles: {
            get: async (browserProfileId) =>
              [...authorizations.values()].find(
                (authorization) => authorization.profile.browserProfileId === browserProfileId,
              )?.profile ?? null,
          },
        }));
  const enterpriseRuntime = {
    isCurrentHandle: (handle: EnterpriseAgentContextHandle) => registry.isCurrentHandle(handle),
    resolveAuthorization: (handle: EnterpriseAgentContextHandle) => {
      resolverCalls += 1;
      const authorization = authorizations.get(handle);
      if (!authorization) {
        throw new Error("Workspace binding is not authorized.");
      }
      return authorization;
    },
    leases,
    leaseTtlMs: 30_000,
  };
  const broker = new BrowserToolsBroker({
    defaultTimeoutMs: 1_000,
    createRequestId: options.createRequestId ?? (() => `enterprise-${++requestSequence}`),
    enterprise: enterpriseRuntime,
    ...(pageIdentity ? { pageIdentity } : {}),
    ...(options.onHostTeardownError ? { onHostTeardownError: options.onHostTeardownError } : {}),
  });
  return {
    broker,
    pageIdentity,
    handles,
    workspaces,
    manager,
    acquired,
    getAuditCallCount: () => auditCallCount,
    getResolverCalls: () => resolverCalls,
    setAuthorization: (handle, authorization) => authorizations.set(handle, authorization),
    getAuthorization: (handle) => {
      const authorization = authorizations.get(handle);
      if (!authorization) throw new Error("Missing test authorization.");
      return authorization;
    },
    mutateDependencies: () => {
      enterpriseRuntime.leaseTtlMs = 1;
      enterpriseRuntime.isCurrentHandle = () => false;
      enterpriseRuntime.resolveAuthorization = () => {
        throw new Error("mutated resolver");
      };
      enterpriseRuntime.leases = {
        acquire: async () => {
          throw new Error("mutated acquire");
        },
        attachHost: async () => {
          throw new Error("mutated attach");
        },
        validateLease: async () => {
          throw new Error("mutated validate");
        },
        releaseLease: async () => {
          throw new Error("mutated release");
        },
        invalidateHost: async () => {
          throw new Error("mutated invalidate");
        },
      };
    },
  };
}

async function registerProfileHost(
  fixture: EnterpriseFixture,
  host: EnterpriseHost,
  handle: EnterpriseAgentContextHandle = fixture.handles.a,
): Promise<() => void> {
  const unregister = fixture.broker.registerClient(host);
  await expect(
    fixture.broker.bindEnterpriseProfileHost({ handle, hostClientId: host.id }),
  ).resolves.toBe(true);
  return unregister;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function newTabSuccess(request: BrowserAutomationExecuteRequest, browserId = BROWSER_A) {
  if (!request.enterpriseContext || !request.workspaceId) {
    throw new Error("Expected an enterprise Browser request.");
  }
  return {
    ok: true as const,
    enterpriseContext: request.enterpriseContext,
    result: {
      command: "new_tab" as const,
      browserId,
      workspaceId: request.workspaceId,
      url: "https://example.com",
    },
  };
}

describe("BrowserToolsBroker enterprise Profile execution", () => {
  test("denies every enterprise command before authorization when page identity is absent", async () => {
    const fixture = await createEnterpriseFixture({ pageIdentity: null });
    const resolverCalls = fixture.getResolverCalls();

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(resolverCalls);
    expect(fixture.acquired).toEqual([]);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);
  });

  test.each(["list_tabs", "new_tab"] as const)(
    "denies %s after authorization when the Enterprise host has no authenticated Session",
    async (command) => {
      const fixture = await createEnterpriseFixture();
      const host = new EnterpriseHost("desktop-client-untrusted", {
        authenticatedSession: null,
      });
      fixture.broker.registerClient(host);
      const resolverCalls = fixture.getResolverCalls();

      await expect(
        fixture.broker.executeEnterprise({
          handle: fixture.handles.a,
          command: { command, args: {} },
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
      expect(fixture.getResolverCalls()).toBe(resolverCalls + 1);
      expect(fixture.acquired).toEqual([]);
      expect(host.receivedRequests).toEqual([]);
      expect(fixture.broker.getPendingRequestCount()).toBe(0);
    },
  );

  test("rejects structural handles and caller-owned Profile, partition, lease, or process authority before resolution", async () => {
    const fixture = await createEnterpriseFixture();
    const fakeHandle = { ...fixture.handles.a } as EnterpriseAgentContextHandle;

    await expect(
      fixture.broker.executeEnterprise({
        handle: fakeHandle,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
        workspace: fixture.workspaces.a,
        browserProfileId: PROFILE_A,
        partition: "persist:caller",
        leaseId: "lea_11111111-1111-4111-8111-111111111111",
        processId: 123,
      } as never),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(0);
  });

  test("serializes writers for the same Profile in FIFO order", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("host-a");
    await registerProfileHost(fixture, host);

    const first = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    const second = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const firstRequest = host.receivedRequests[0];
    expect(host.respond(fixture.broker, firstRequest, newTabSuccess(firstRequest))).toBe(true);
    await expect(first).resolves.toMatchObject({ ok: true });

    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(2));
    const secondRequest = host.receivedRequests[1];
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    expect(host.respond(fixture.broker, secondRequest, newTabSuccess(secondRequest))).toBe(true);
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  test("rejects a resolver-forged Workspace tuple before acquiring a lease", async () => {
    const fixture = await createEnterpriseFixture();
    const original = fixture.getAuthorization(fixture.handles.a);
    fixture.setAuthorization(fixture.handles.a, {
      ...original,
      workspace: { ...original.workspace, workspaceId: "workspace-forged" },
    });

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.acquired).toEqual([]);
  });

  test("rejects accessor and Proxy inputs before invoking the trusted resolver", async () => {
    const fixture = await createEnterpriseFixture();
    const changingInput = {
      command: { command: "list_tabs", args: {} },
    } as Record<string, unknown>;
    let handleReads = 0;
    Object.defineProperty(changingInput, "handle", {
      enumerable: true,
      get: () => {
        handleReads += 1;
        return fixture.handles.a;
      },
    });
    const throwingInput = new Proxy(
      { handle: fixture.handles.a, command: { command: "list_tabs", args: {} } },
      {
        ownKeys: () => {
          throw new Error("proxy trap");
        },
      },
    );

    await expect(fixture.broker.executeEnterprise(changingInput as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    await expect(fixture.broker.executeEnterprise(throwingInput)).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(handleReads).toBe(0);
    expect(fixture.getResolverCalls()).toBe(0);
  });

  test("rejects accessor and Proxy host registrations without invoking their fields", async () => {
    const fixture = await createEnterpriseFixture();
    const accessorHost = {
      hostKind: "desktop app",
      supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
      sendBrowserAutomationRequest: () => {},
    } as Record<string, unknown>;
    let idReads = 0;
    Object.defineProperty(accessorHost, "id", {
      enumerable: true,
      get: () => {
        idReads += 1;
        return "accessor-host";
      },
    });
    const proxyHost = new Proxy(
      {
        id: "proxy-host",
        hostKind: "desktop app",
        supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
        sendBrowserAutomationRequest: () => {},
      },
      {
        ownKeys: () => {
          throw new Error("proxy trap");
        },
      },
    );

    expect(() => fixture.broker.registerClient(accessorHost as never)).toThrow(/stable/i);
    expect(() => fixture.broker.registerClient(proxyHost)).toThrow(/inspect/i);
    expect(idReads).toBe(0);
  });

  test("snapshots constructor dependencies and host capabilities against later mutation", async () => {
    const fixture = await createEnterpriseFixture();
    const receivedRequests: BrowserAutomationExecuteRequest[] = [];
    const host = {
      id: "host-snapshot",
      hostKind: "desktop app",
      supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
      enterpriseProfiles: { version: 1 as const },
      homeNodeId: NODE_ID,
      authenticatedSession: createAuthenticatedBrowserHostSession({
        clientId: "host-snapshot",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-a",
      }),
      sendBrowserAutomationRequest: (request: BrowserAutomationExecuteRequest) => {
        receivedRequests.push(request);
      },
    };
    fixture.broker.registerClient(host);
    host.id = "host-mutated";
    host.supportedCommands.length = 0;
    host.homeNodeId = SECOND_NODE_ID;
    host.sendBrowserAutomationRequest = () => {
      throw new Error("mutated sender");
    };
    fixture.mutateDependencies();

    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: "host-snapshot",
      }),
    ).resolves.toBe(true);
    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(receivedRequests).toHaveLength(1));
    const request = receivedRequests[0];
    expect(
      fixture.broker.receiveResponse("host-snapshot", {
        type: "browser.automation.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          enterpriseContext: request.enterpriseContext,
          result: { command: "list_tabs", tabs: [] },
        },
      }),
    ).toBe(true);
    await expect(execution).resolves.toMatchObject({ ok: true });
  });

  test("binds a host send method to its immutable registration snapshot", async () => {
    const fixture = await createEnterpriseFixture();
    const receiverIds: string[] = [];
    const requests: BrowserAutomationExecuteRequest[] = [];
    const client = {
      id: "receiver-host",
      hostKind: "desktop app",
      supportedCommands: [...BROWSER_AUTOMATION_COMMAND_NAMES],
      sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest) {
        receiverIds.push(this.id);
        requests.push(request);
      },
    };
    fixture.broker.registerClient(client);
    client.id = "mutated-host";

    const execution = fixture.broker.execute({
      command: { command: "list_tabs", args: {} },
    });
    expect(receiverIds).toEqual(["receiver-host"]);
    const request = requests[0];
    expect(
      fixture.broker.receiveResponse("receiver-host", {
        type: "browser.automation.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      }),
    ).toBe(true);
    await expect(execution).resolves.toMatchObject({ ok: true });
  });

  test("blocks a replacement host on lease invalidation and drops it if invalidation fails", async () => {
    const invalidation = deferred<void>();
    const teardownErrors: Error[] = [];
    const runtime: EnterpriseBrowserToolsRuntime = {
      isCurrentHandle: () => false,
      resolveAuthorization: async () => {
        throw new Error("unused");
      },
      leases: {
        acquire: async () => {
          throw new Error("unused");
        },
        attachHost: async () => {},
        validateLease: async () => {
          throw new Error("unused");
        },
        releaseLease: async () => {},
        invalidateHost: () => invalidation.promise,
      },
      leaseTtlMs: 1_000,
    };
    const broker = new BrowserToolsBroker({
      createRequestId: () => "replacement-request",
      enterprise: runtime,
      onHostTeardownError: (error) => teardownErrors.push(error),
    });
    broker.registerClient(new EnterpriseHost("replacement-host", { enterprise: false }));
    const replacement = new EnterpriseHost("replacement-host", { enterprise: false });
    broker.registerClient(replacement);
    const blocked = broker.execute({ command: { command: "new_tab", args: {} } });
    await Promise.resolve();
    expect(replacement.receivedRequests).toEqual([]);

    invalidation.reject(new Error("lease invalidation failed"));
    await expect(blocked).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_no_host" },
    });
    expect(replacement.receivedRequests).toEqual([]);
    expect(teardownErrors).toEqual([
      expect.objectContaining({ message: "lease invalidation failed" }),
    ]);
  });

  test("keeps a replacement host unroutable until lease invalidation completes", async () => {
    const invalidation = deferred<void>();
    const runtime: EnterpriseBrowserToolsRuntime = {
      isCurrentHandle: () => false,
      resolveAuthorization: async () => {
        throw new Error("unused");
      },
      leases: {
        acquire: async () => {
          throw new Error("unused");
        },
        attachHost: async () => {},
        validateLease: async () => {
          throw new Error("unused");
        },
        releaseLease: async () => {},
        invalidateHost: () => invalidation.promise,
      },
      leaseTtlMs: 1_000,
    };
    const broker = new BrowserToolsBroker({
      createRequestId: () => "replacement-success-request",
      enterprise: runtime,
    });
    broker.registerClient(new EnterpriseHost("replacement-host", { enterprise: false }));
    const replacement = new EnterpriseHost("replacement-host", { enterprise: false });
    broker.registerClient(replacement);
    const blocked = broker.execute({ command: { command: "new_tab", args: {} } });
    await Promise.resolve();
    expect(replacement.receivedRequests).toEqual([]);

    invalidation.resolve();
    await vi.waitFor(() => expect(replacement.receivedRequests).toHaveLength(1));
    const request = replacement.receivedRequests[0];
    expect(
      replacement.respond(broker, request, {
        ok: true,
        result: {
          command: "new_tab",
          browserId: BROWSER_A,
          workspaceId: "workspace-legacy",
          url: "https://example.com",
        },
      }),
    ).toBe(true);
    await expect(blocked).resolves.toMatchObject({ ok: true });
  });

  test("does not let a blocked Profile A teardown delay an authorized Profile B", async () => {
    const invalidation = deferred<void>();
    const fixture = await createEnterpriseFixture({
      invalidateHost: () => invalidation.promise,
    });
    const profileAHost = new EnterpriseHost("profile-a-host");
    const profileBHost = new EnterpriseHost("profile-b-host", {
      authenticatedSession: createAuthenticatedBrowserHostSession({
        clientId: "profile-b-host",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-b",
      }),
    });
    await registerProfileHost(fixture, profileAHost, fixture.handles.a);
    await registerProfileHost(fixture, profileBHost, fixture.handles.b);
    const profileAReplacement = new EnterpriseHost(profileAHost.id);
    fixture.broker.registerClient(profileAReplacement);

    const profileAExecution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    const profileBExecution = fixture.broker.executeEnterprise({
      handle: fixture.handles.b,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(profileBHost.receivedRequests).toHaveLength(1));
    expect(profileAHost.receivedRequests).toEqual([]);
    expect(profileAReplacement.receivedRequests).toEqual([]);
    await expect(profileAExecution).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });

    const profileBRequest = profileBHost.receivedRequests[0];
    expect(
      profileBHost.respond(fixture.broker, profileBRequest, {
        ok: true,
        enterpriseContext: profileBRequest.enterpriseContext,
        result: { command: "list_tabs", tabs: [] },
      }),
    ).toBe(true);
    await expect(profileBExecution).resolves.toMatchObject({ ok: true });
    invalidation.resolve();
  });

  test("keeps Profile B live when Profile A teardown fails and drops only A replacement", async () => {
    const invalidation = deferred<void>();
    const teardownErrors: Array<{ error: Error; hostClientId: string }> = [];
    const fixture = await createEnterpriseFixture({
      invalidateHost: () => invalidation.promise,
      onHostTeardownError: (error, hostClientId) => teardownErrors.push({ error, hostClientId }),
    });
    const profileAHost = new EnterpriseHost("profile-a-host");
    const profileBHost = new EnterpriseHost("profile-b-host", {
      authenticatedSession: createAuthenticatedBrowserHostSession({
        clientId: "profile-b-host",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-b",
      }),
    });
    await registerProfileHost(fixture, profileAHost, fixture.handles.a);
    await registerProfileHost(fixture, profileBHost, fixture.handles.b);
    const profileAReplacement = new EnterpriseHost(profileAHost.id);
    fixture.broker.registerClient(profileAReplacement);

    const profileBExecution = fixture.broker.executeEnterprise({
      handle: fixture.handles.b,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(profileBHost.receivedRequests).toHaveLength(1));
    invalidation.reject(new Error("Profile A lease invalidation failed"));
    await vi.waitFor(() => expect(teardownErrors).toHaveLength(1));
    const profileBRequest = profileBHost.receivedRequests[0];
    expect(
      profileBHost.respond(fixture.broker, profileBRequest, {
        ok: true,
        enterpriseContext: profileBRequest.enterpriseContext,
        result: { command: "list_tabs", tabs: [] },
      }),
    ).toBe(true);

    await expect(profileBExecution).resolves.toMatchObject({ ok: true });
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(profileAReplacement.receivedRequests).toEqual([]);
    expect(fixture.broker.getRegisteredClientCount()).toBe(1);
    expect(teardownErrors).toEqual([
      {
        error: expect.objectContaining({ message: "Profile A lease invalidation failed" }),
        hostClientId: profileAHost.id,
      },
    ]);
  });

  test.each(["list_tabs", "new_tab"] as const)(
    "bootstraps first %s through the unique authenticated host for the Agent Session generation",
    async (command) => {
      const fixture = await createEnterpriseFixture();
      const host = new EnterpriseHost("unique-bootstrap-host");
      fixture.broker.registerClient(host);

      const execution = fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command, args: {} },
      });
      await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
      const request = host.receivedRequests[0];
      expect(
        host.respond(
          fixture.broker,
          request,
          command === "list_tabs"
            ? {
                ok: true,
                enterpriseContext: request.enterpriseContext,
                result: { command: "list_tabs", tabs: [] },
              }
            : newTabSuccess(request),
        ),
      ).toBe(true);
      await expect(execution).resolves.toMatchObject({ ok: true });

      const ambiguousHost = new EnterpriseHost("later-bootstrap-host");
      fixture.broker.registerClient(ambiguousHost);
      const followup = fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      });
      await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(2));
      expect(ambiguousHost.receivedRequests).toEqual([]);
      const followupRequest = host.receivedRequests[1];
      expect(
        host.respond(fixture.broker, followupRequest, {
          ok: true,
          enterpriseContext: followupRequest.enterpriseContext,
          result: { command: "list_tabs", tabs: [] },
        }),
      ).toBe(true);
      await expect(followup).resolves.toMatchObject({ ok: true });
    },
  );

  test("denies bootstrap with no matching host after resolution and before lease, audit, send, or pending state", async () => {
    const fixture = await createEnterpriseFixture();
    const resolverCalls = fixture.getResolverCalls();
    const auditCalls = fixture.getAuditCallCount();

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(resolverCalls + 1);
    expect(fixture.acquired).toEqual([]);
    expect(fixture.getAuditCallCount()).toBe(auditCalls);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);
  });

  test("denies bootstrap when more than one exact authenticated host is current", async () => {
    const fixture = await createEnterpriseFixture();
    const first = new EnterpriseHost("ambiguous-bootstrap-host-a");
    const second = new EnterpriseHost("ambiguous-bootstrap-host-b");
    fixture.broker.registerClient(first);
    fixture.broker.registerClient(second);
    const resolverCalls = fixture.getResolverCalls();
    const auditCalls = fixture.getAuditCallCount();

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "new_tab", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(resolverCalls + 1);
    expect(fixture.acquired).toEqual([]);
    expect(fixture.getAuditCallCount()).toBe(auditCalls);
    expect(first.receivedRequests).toEqual([]);
    expect(second.receivedRequests).toEqual([]);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);
  });

  test("denies bootstrap when the authenticated host Session generation differs from the Agent handle", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("wrong-generation-bootstrap-host", {
      authenticatedSession: createAuthenticatedBrowserHostSession({
        clientId: "desktop-client-wrong-generation",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-b",
      }),
    });
    fixture.broker.registerClient(host);
    const resolverCalls = fixture.getResolverCalls();
    const auditCalls = fixture.getAuditCallCount();

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(resolverCalls + 1);
    expect(fixture.acquired).toEqual([]);
    expect(fixture.getAuditCallCount()).toBe(auditCalls);
    expect(host.receivedRequests).toEqual([]);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);
  });

  test("rejects caller-supplied bootstrap route authority", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("caller-selected-bootstrap-host");
    fixture.broker.registerClient(host);

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
        routeId: host.id,
        clientId: host.authenticatedSession?.clientId,
      } as never),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(0);
    expect(fixture.acquired).toEqual([]);
    expect(host.receivedRequests).toEqual([]);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);
  });

  test("keeps legacy and enterprise request IDs collision-free", async () => {
    const fixture = await createEnterpriseFixture({ createRequestId: () => "shared-request" });
    const host = new EnterpriseHost("host-a");
    await registerProfileHost(fixture, host);
    const legacy = fixture.broker.execute({
      requestId: "shared-request",
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(host.receivedRequests).toHaveLength(1);
    host.respond(fixture.broker, host.receivedRequests[0], {
      ok: true,
      result: {
        command: "new_tab",
        browserId: BROWSER_A,
        workspaceId: "workspace-legacy",
        url: "https://example.com",
      },
    });
    await expect(legacy).resolves.toMatchObject({ ok: true });
  });

  test("fails closed before authorization when request ID allocation throws", async () => {
    const fixture = await createEnterpriseFixture({
      createRequestId: () => {
        throw new Error("request allocator unavailable");
      },
    });

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({
      requestId: "unknown",
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(fixture.getResolverCalls()).toBe(0);
  });

  test("releases an execution lease exactly once and preserves the primary browser failure", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("host-a");
    await registerProfileHost(fixture, host);
    const release = vi
      .spyOn(fixture.manager, "releaseLease")
      .mockRejectedValue(new Error("cleanup failed"));
    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const request = host.receivedRequests[0];
    expect(
      host.respond(fixture.broker, request, {
        ok: false,
        enterpriseContext: request.enterpriseContext,
        error: { code: "browser_tab_closed", message: "closed", retryable: false },
      }),
    ).toBe(true);

    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_tab_closed", message: "closed" },
    });
    expect(release).toHaveBeenCalledTimes(1);
    release.mockRestore();
    await fixture.manager.releaseLease({
      handle: fixture.handles.a,
      lease: fixture.acquired.at(-1)!,
    });
  });

  test("allows different Profiles to execute in parallel", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("host-a");
    await registerProfileHost(fixture, host);
    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.b,
        hostClientId: host.id,
      }),
    ).resolves.toBe(true);

    const first = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    const second = fixture.broker.executeEnterprise({
      handle: fixture.handles.b,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(2));
    for (const [index, request] of host.receivedRequests.entries()) {
      host.respond(
        fixture.broker,
        request,
        newTabSuccess(request, index === 0 ? BROWSER_A : "22222222-2222-4222-8222-222222222222"),
      );
    }
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true }, { ok: true }]);
  });

  test("keeps identical local Workspace and Profile IDs isolated across organizations", async () => {
    const fixture = await createEnterpriseFixture();
    const firstHost = new EnterpriseHost("organization-a-host");
    const secondHost = new EnterpriseHost("organization-c-host");
    await registerProfileHost(fixture, firstHost, fixture.handles.a);
    await registerProfileHost(fixture, secondHost, fixture.handles.c);

    const first = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    const second = fixture.broker.executeEnterprise({
      handle: fixture.handles.c,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => {
      expect(firstHost.receivedRequests).toHaveLength(1);
      expect(secondHost.receivedRequests).toHaveLength(1);
    });
    for (const host of [firstHost, secondHost]) {
      const request = host.receivedRequests[0];
      expect(
        host.respond(fixture.broker, request, {
          ok: true,
          enterpriseContext: request.enterpriseContext,
          result: { command: "list_tabs", tabs: [] },
        }),
      ).toBe(true);
    }
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true }, { ok: true }]);
  });

  test("rebuilds Profile ownership without reusing tab affinity after a binding revision changes", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("profile-host");
    await registerProfileHost(fixture, host);
    const opened = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const openRequest = host.receivedRequests[0];
    expect(host.respond(fixture.broker, openRequest, newTabSuccess(openRequest))).toBe(true);
    await expect(opened).resolves.toMatchObject({ ok: true });

    const original = fixture.getAuthorization(fixture.handles.a);
    fixture.setAuthorization(fixture.handles.a, {
      ...original,
      bindingRevision: "binding-updated",
    });
    const rebound = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(2));
    const reboundRequest = host.receivedRequests[1];
    expect(
      host.respond(fixture.broker, reboundRequest, {
        ok: true,
        enterpriseContext: reboundRequest.enterpriseContext,
        result: { command: "list_tabs", tabs: [] },
      }),
    ).toBe(true);
    await expect(rebound).resolves.toMatchObject({ ok: true });

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(host.receivedRequests).toHaveLength(2);
  });

  test("does not publish tab affinity until post-response authorization is current", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("profile-host");
    await registerProfileHost(fixture, host);
    const original = fixture.getAuthorization(fixture.handles.a);
    const opened = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const openRequest = host.receivedRequests[0];
    fixture.setAuthorization(fixture.handles.a, {
      ...original,
      bindingRevision: "binding-updated-during-send",
    });
    expect(host.respond(fixture.broker, openRequest, newTabSuccess(openRequest))).toBe(true);
    await expect(opened).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });

    fixture.setAuthorization(fixture.handles.a, original);
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(host.receivedRequests).toHaveLength(1);
  });

  test("routes only to the bound enterprise host on the Profile home node", async () => {
    const fixture = await createEnterpriseFixture();
    const legacyHost = new EnterpriseHost("legacy-host", { enterprise: false });
    const otherNodeHost = new EnterpriseHost("other-node-host", {
      homeNodeId: SECOND_NODE_ID,
    });
    const profileHost = new EnterpriseHost("profile-host");
    fixture.broker.registerClient(legacyHost);
    fixture.broker.registerClient(otherNodeHost);
    await registerProfileHost(fixture, profileHost);

    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(profileHost.receivedRequests).toHaveLength(1));
    expect(legacyHost.receivedRequests).toEqual([]);
    expect(otherNodeHost.receivedRequests).toEqual([]);
    const request = profileHost.receivedRequests[0];
    expect(
      profileHost.respond(fixture.broker, request, {
        ok: true,
        enterpriseContext: request.enterpriseContext,
        result: { command: "list_tabs", tabs: [] },
      }),
    ).toBe(true);
    await expect(execution).resolves.toMatchObject({ ok: true });
  });

  test("does not fall back to the Profile host for an unknown Browser ID", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("profile-host");
    await registerProfileHost(fixture, host);

    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(host.receivedRequests).toEqual([]);
  });

  test("requires list_tabs to rebuild Browser affinity after host reconnect", async () => {
    const fixture = await createEnterpriseFixture();
    const firstHost = new EnterpriseHost("profile-host");
    const unregister = fixture.broker.registerClient(firstHost);
    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: firstHost.id,
      }),
    ).resolves.toBe(true);
    const newTab = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(firstHost.receivedRequests).toHaveLength(1));
    const newTabRequest = firstHost.receivedRequests[0];
    firstHost.respond(fixture.broker, newTabRequest, newTabSuccess(newTabRequest));
    await expect(newTab).resolves.toMatchObject({ ok: true });
    unregister();
    await fixture.manager.waitForIdle();

    const reconnectedSession = createAuthenticatedBrowserHostSession({
      clientId: "profile-host",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-reconnected",
    });
    const reconnectedHost = new EnterpriseHost("profile-host", {
      authenticatedSession: reconnectedSession,
    });
    fixture.broker.registerClient(reconnectedHost);
    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: reconnectedHost.id,
      }),
    ).resolves.toBe(true);
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(reconnectedHost.receivedRequests).toEqual([]);

    const listTabs = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(reconnectedHost.receivedRequests).toHaveLength(1));
    const listRequest = reconnectedHost.receivedRequests[0];
    if (!listRequest.enterpriseContext || !listRequest.workspaceId) {
      throw new Error("Expected an enterprise list-tabs request.");
    }
    reconnectedHost.respond(fixture.broker, listRequest, {
      ok: true,
      enterpriseContext: listRequest.enterpriseContext,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_A,
            workspaceId: listRequest.workspaceId,
            enterpriseContext: listRequest.enterpriseContext,
            url: "https://example.com",
            title: "Example",
          },
        ],
      },
    });
    await expect(listTabs).resolves.toMatchObject({ ok: true });

    await fixture.pageIdentity!.observe(reconnectedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-reconnected",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-reconnected",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-reconnected",
    });
    const pageIdentityVerification = await fixture.pageIdentity!.verify({
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    });

    const snapshot = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "snapshot", args: { browserId: BROWSER_A } },
      pageIdentityVerification,
    });
    await vi.waitFor(() => expect(reconnectedHost.receivedRequests).toHaveLength(2));
    const snapshotRequest = reconnectedHost.receivedRequests[1];
    expect(snapshotRequest.command).toEqual({
      command: "snapshot",
      args: { browserId: BROWSER_A },
    });
    reconnectedHost.respond(fixture.broker, snapshotRequest, {
      ok: false,
      enterpriseContext: snapshotRequest.enterpriseContext,
      error: { code: "browser_tab_closed", message: "closed", retryable: false },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: false });
  });

  test("invalidates an attached lease when its host restarts", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("host-a");
    const unregister = fixture.broker.registerClient(host);
    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: host.id,
      }),
    ).resolves.toBe(true);
    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const oldRequest = host.receivedRequests[0];
    unregister();

    await expect(execution).resolves.toMatchObject({ ok: false });
    await fixture.manager.waitForIdle();
    await expect(
      fixture.manager.validateLease({
        handle: fixture.handles.a,
        lease: fixture.acquired.at(-1)!,
      }),
    ).rejects.toThrow(/expired|inactive/i);
    const replacement = new EnterpriseHost("host-b");
    fixture.broker.registerClient(replacement);
    expect(replacement.respond(fixture.broker, oldRequest, newTabSuccess(oldRequest))).toBe(false);
  });

  test("keeps transport routes separate from same-client authenticated Session generations", async () => {
    const fixture = await createEnterpriseFixture();
    const pageIdentity = fixture.pageIdentity;
    if (!pageIdentity) throw new Error("Expected Browser page identity registry.");
    const oldSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-shared",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "host-session-old",
    });
    const newSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-shared",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "host-session-new",
    });
    const oldHost = new EnterpriseHost("browser-route-old", {
      authenticatedSession: oldSession,
    });
    const newHost = new EnterpriseHost("browser-route-new", {
      authenticatedSession: newSession,
    });
    const unregisterOld = fixture.broker.registerClient(oldHost);
    fixture.broker.registerClient(newHost);
    expect(fixture.broker.getRegisteredClientCount()).toBe(2);

    const registration = {
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    };
    pageIdentity.registerBrowser({ host: oldSession, ...registration });
    pageIdentity.registerBrowser({ host: newSession, ...registration });
    await pageIdentity.observe(oldSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-old-route",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-old-route",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "host-session-old",
    });
    await pageIdentity.observe(newSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-new-route",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-new-route",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "host-session-new",
    });
    const oldProof = await pageIdentity.verify({
      ...registration,
      hostClientId: "desktop-client-shared",
      hostSessionBindingGeneration: "host-session-old",
    });
    const newProof = await pageIdentity.verify({
      ...registration,
      hostClientId: "desktop-client-shared",
      hostSessionBindingGeneration: "host-session-new",
    });

    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: newHost.id,
      }),
    ).resolves.toBe(true);
    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(newHost.receivedRequests).toHaveLength(1));
    const request = newHost.receivedRequests[0];
    if (!request.enterpriseContext || !request.workspaceId) {
      throw new Error("Expected enterprise list-tabs context.");
    }
    const response = {
      type: "browser.automation.execute.response" as const,
      payload: {
        requestId: request.requestId,
        ok: true as const,
        enterpriseContext: request.enterpriseContext,
        result: {
          command: "list_tabs" as const,
          tabs: [
            {
              browserId: BROWSER_A,
              workspaceId: request.workspaceId,
              enterpriseContext: request.enterpriseContext,
              url: "https://shop.example",
              title: "Shop",
            },
          ],
        },
      },
    };
    expect(fixture.broker.receiveResponse("desktop-client-shared", response)).toBe(false);
    expect(fixture.broker.receiveResponse(newHost.id, response)).toBe(true);
    await expect(execution).resolves.toMatchObject({ ok: true });

    const beforeWrongGenerationAcquireCount = fixture.acquired.length;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
        pageIdentityVerification: oldProof,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.acquired).toHaveLength(beforeWrongGenerationAcquireCount);
    expect(newHost.receivedRequests).toHaveLength(1);

    unregisterOld();
    await fixture.manager.waitForIdle();
    expect(fixture.broker.getRegisteredClientCount()).toBe(1);
    await expect(pageIdentity.recheck(oldProof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });
    await expect(pageIdentity.recheck(newProof)).resolves.toBeUndefined();

    const snapshot = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "snapshot", args: { browserId: BROWSER_A } },
      pageIdentityVerification: newProof,
    });
    await vi.waitFor(() => expect(newHost.receivedRequests).toHaveLength(2));
    const snapshotRequest = newHost.receivedRequests[1];
    expect(
      newHost.respond(fixture.broker, snapshotRequest, {
        ok: true,
        enterpriseContext: snapshotRequest.enterpriseContext,
        result: {
          command: "snapshot",
          browserId: BROWSER_A,
          workspaceId: snapshotRequest.workspaceId,
          url: "https://shop.example",
          title: "Shop",
          format: "aria-yaml",
          snapshot: "- document",
          truncated: false,
          stats: { nodeCount: 1, refCount: 0, textLength: 10 },
        },
      }),
    ).toBe(true);
    await expect(snapshot).resolves.toMatchObject({ ok: true });
  });

  test("rejects wrong host, wrong lease, and wrong-Profile tabs without completing the request", async () => {
    const fixture = await createEnterpriseFixture();
    const host = new EnterpriseHost("host-a");
    const foreignHost = new EnterpriseHost("host-b");
    await registerProfileHost(fixture, host);
    fixture.broker.registerClient(foreignHost);
    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const request = host.receivedRequests[0];
    if (!request.enterpriseContext) throw new Error("Expected enterprise context.");
    const wrongProfilePayload = {
      requestId: request.requestId,
      ok: true as const,
      enterpriseContext: request.enterpriseContext,
      result: {
        command: "list_tabs" as const,
        tabs: [
          {
            browserId: BROWSER_A,
            workspaceId: request.workspaceId,
            enterpriseContext: {
              ...request.enterpriseContext,
              browserProfileId: PROFILE_B,
            },
            url: "https://example.com",
            title: "Foreign Profile",
          },
        ],
      },
    };
    expect(
      fixture.broker.receiveResponse(foreignHost.id, {
        type: "browser.automation.execute.response",
        payload: wrongProfilePayload,
      }),
    ).toBe(false);
    expect(
      fixture.broker.receiveResponse(host.id, {
        type: "browser.automation.execute.response",
        payload: {
          ...wrongProfilePayload,
          enterpriseContext: { ...request.enterpriseContext, leaseRevision: "wrong-lease" },
        },
      }),
    ).toBe(false);
    expect(fixture.broker.getPendingRequestCount()).toBe(1);
    expect(
      host.respond(fixture.broker, request, {
        ok: true,
        enterpriseContext: request.enterpriseContext,
        result: { command: "list_tabs", tabs: [] },
      }),
    ).toBe(true);
    await expect(execution).resolves.toMatchObject({
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    });
  });

  test("requires and rechecks same-host nominal page evidence before authorization, lease, attach, or send", async () => {
    let throwProfileRead = false;
    const pageIdentity = new BrowserPageIdentityRegistry({
      profiles: {
        get: async () => {
          if (throwProfileRead) throw new Error("profile store failed");
          return pageIdentityProfile();
        },
      },
    });
    const fixture = await createEnterpriseFixture({ pageIdentity });
    const authenticatedSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-a",
    });
    const host = new EnterpriseHost("desktop-client-1", { authenticatedSession });
    const unregisterHost = await registerProfileHost(fixture, host);

    await pageIdentity.observe(authenticatedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-1",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-1",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-a",
    });
    await expect(
      pageIdentity.verify({
        browserId: BROWSER_A,
        browserProfileId: PROFILE_A,
        bindingRevision: "binding-workspace-a",
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    const preRegistrationResolverCalls = fixture.getResolverCalls();
    const preRegistrationAcquireCount = fixture.acquired.length;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(preRegistrationResolverCalls);
    expect(fixture.acquired).toHaveLength(preRegistrationAcquireCount);
    expect(host.receivedRequests).toHaveLength(0);

    const listTabs = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const listRequest = host.receivedRequests[0];
    if (!listRequest.enterpriseContext || !listRequest.workspaceId) {
      throw new Error("Expected enterprise list-tabs context.");
    }
    host.respond(fixture.broker, listRequest, {
      ok: true,
      enterpriseContext: listRequest.enterpriseContext,
      result: {
        command: "list_tabs",
        tabs: [
          {
            browserId: BROWSER_A,
            workspaceId: listRequest.workspaceId,
            enterpriseContext: listRequest.enterpriseContext,
            url: "https://shop.example",
            title: "Shop",
          },
        ],
      },
    });
    await expect(listTabs).resolves.toMatchObject({ ok: true });
    const proof = await pageIdentity.verify({
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    });
    const resolverCalls = fixture.getResolverCalls();
    const acquiredCount = fixture.acquired.length;
    const sentCount = host.receivedRequests.length;

    await pageIdentity.observe(authenticatedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-2",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "wrong.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-2",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-a",
    });
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
        pageIdentityVerification: proof,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(resolverCalls);
    expect(fixture.acquired).toHaveLength(acquiredCount);
    expect(host.receivedRequests).toHaveLength(sentCount);

    await pageIdentity.observe(authenticatedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-3",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-3",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-a",
    });
    const currentProof = await pageIdentity.verify({
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    });
    const snapshot = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "snapshot", args: { browserId: BROWSER_A } },
      pageIdentityVerification: currentProof,
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(sentCount + 1));
    const snapshotRequest = host.receivedRequests.at(-1)!;
    host.respond(fixture.broker, snapshotRequest, {
      ok: true,
      enterpriseContext: snapshotRequest.enterpriseContext,
      result: {
        command: "snapshot",
        browserId: BROWSER_A,
        workspaceId: snapshotRequest.workspaceId,
        url: "https://shop.example",
        title: "Shop",
        format: "aria-yaml",
        snapshot: "- document",
        truncated: false,
        stats: { nodeCount: 1, refCount: 0, textLength: 10 },
      },
    });
    await expect(snapshot).resolves.toMatchObject({ ok: true });

    const foreignSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-2",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-b",
    });
    pageIdentity.registerBrowser({
      host: foreignSession,
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    });
    await pageIdentity.observe(foreignSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-foreign",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-foreign",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-b",
    });
    const foreignProof = await pageIdentity.verify({
      browserId: BROWSER_A,
      browserProfileId: PROFILE_A,
      bindingRevision: "binding-workspace-a",
    });
    const preForeignAcquiredCount = fixture.acquired.length;
    const preForeignSentCount = host.receivedRequests.length;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
        pageIdentityVerification: foreignProof,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.acquired).toHaveLength(preForeignAcquiredCount);
    expect(host.receivedRequests).toHaveLength(preForeignSentCount);

    const postSuccessResolverCalls = fixture.getResolverCalls();
    const postSuccessAcquiredCount = fixture.acquired.length;
    const postSuccessSentCount = host.receivedRequests.length;
    throwProfileRead = true;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "snapshot", args: { browserId: BROWSER_A } },
        pageIdentityVerification: currentProof,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(postSuccessResolverCalls);
    expect(fixture.acquired).toHaveLength(postSuccessAcquiredCount);
    expect(host.receivedRequests).toHaveLength(postSuccessSentCount);

    throwProfileRead = false;
    unregisterHost();
    await expect(pageIdentity.recheck(currentProof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });
  });

  test("atomically combines provisional page evidence with a new_tab Browser registration", async () => {
    const pageIdentity = new BrowserPageIdentityRegistry({
      profiles: { get: async () => pageIdentityProfile() },
    });
    const fixture = await createEnterpriseFixture({ pageIdentity });
    const authenticatedSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-a",
    });
    const host = new EnterpriseHost("desktop-client-1", { authenticatedSession });
    await registerProfileHost(fixture, host);
    await pageIdentity.observe(authenticatedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-before-new-tab",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-before-new-tab",
      bindingRevision: "binding-workspace-a",
      lifecycleGeneration: "session-a",
    });

    const execution = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "new_tab", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const request = host.receivedRequests[0];
    expect(host.respond(fixture.broker, request, newTabSuccess(request))).toBe(true);
    await expect(execution).resolves.toMatchObject({ ok: true });
    await expect(
      pageIdentity.verify({
        browserId: BROWSER_A,
        browserProfileId: PROFILE_A,
        bindingRevision: "binding-workspace-a",
        hostClientId: host.id,
        hostSessionBindingGeneration: authenticatedSession.sessionBindingGeneration,
      }),
    ).resolves.toMatchObject({ observationRevision: "observation-before-new-tab" });
  });

  test("revokes a host before affinity mutation when provisional evidence mismatches registration", async () => {
    const fixture = await createEnterpriseFixture();
    const pageIdentity = fixture.pageIdentity;
    if (!pageIdentity) throw new Error("Expected Browser page identity registry.");
    const authenticatedSession = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-mismatch",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-a",
    });
    const host = new EnterpriseHost("desktop-client-mismatch", { authenticatedSession });
    await registerProfileHost(fixture, host);
    await pageIdentity.observe(authenticatedSession, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-mismatched-binding",
      browser: { browserId: BROWSER_A, browserProfileId: PROFILE_A },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-mismatched-binding",
      bindingRevision: "binding-rebound",
      lifecycleGeneration: "session-a",
    });

    const bootstrap = fixture.broker.executeEnterprise({
      handle: fixture.handles.a,
      command: { command: "list_tabs", args: {} },
    });
    await vi.waitFor(() => expect(host.receivedRequests).toHaveLength(1));
    const request = host.receivedRequests[0];
    if (!request.enterpriseContext || !request.workspaceId) {
      throw new Error("Expected enterprise list-tabs context.");
    }
    expect(
      host.respond(fixture.broker, request, {
        ok: true,
        enterpriseContext: request.enterpriseContext,
        result: {
          command: "list_tabs",
          tabs: [
            {
              browserId: BROWSER_A,
              workspaceId: request.workspaceId,
              enterpriseContext: request.enterpriseContext,
              url: "https://shop.example",
              title: "Shop",
            },
          ],
        },
      }),
    ).toBe(true);
    await expect(bootstrap).resolves.toMatchObject({
      ok: false,
      error: { code: "browser_denied" },
    });
    expect(fixture.broker.getRegisteredClientCount()).toBe(0);
    expect(fixture.broker.getPendingRequestCount()).toBe(0);

    const postFailureResolverCalls = fixture.getResolverCalls();
    const postFailureAcquireCount = fixture.acquired.length;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(postFailureResolverCalls + 1);
    expect(fixture.acquired).toHaveLength(postFailureAcquireCount);
    expect(host.receivedRequests).toHaveLength(1);

    const unregisterFailedSession = fixture.broker.registerClient(host);
    await fixture.manager.waitForIdle();
    await expect(
      fixture.broker.bindEnterpriseProfileHost({
        handle: fixture.handles.a,
        hostClientId: host.id,
      }),
    ).resolves.toBe(false);
    const failedSessionResolverCalls = fixture.getResolverCalls();
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "new_tab", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.getResolverCalls()).toBe(failedSessionResolverCalls + 1);
    expect(host.receivedRequests).toHaveLength(1);
    unregisterFailedSession();

    const replacement = new EnterpriseHost("desktop-client-mismatch", {
      authenticatedSession: createAuthenticatedBrowserHostSession({
        clientId: "desktop-client-mismatch",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-b",
      }),
    });
    fixture.broker.registerClient(replacement);
    await fixture.manager.waitForIdle();
    const beforeReplacementAcquireCount = fixture.acquired.length;
    await expect(
      fixture.broker.executeEnterprise({
        handle: fixture.handles.a,
        command: { command: "list_tabs", args: {} },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(fixture.acquired).toHaveLength(beforeReplacementAcquireCount);
    expect(replacement.receivedRequests).toEqual([]);
  });
});
