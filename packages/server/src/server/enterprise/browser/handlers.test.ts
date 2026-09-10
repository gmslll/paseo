import { describe, expect, test } from "vitest";
import type {
  AuthorizedAgent,
  AuthorizedBrowserProfile,
  AuthorizedWorkspace,
  BrowserProfileBinding,
  BrowserProfileRecord,
  EnterpriseAction,
  FencedLease,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseAgentContextHandle,
  type EnterpriseSessionContext,
} from "../../session/enterprise-agent-session-context-registry.js";
import {
  EnterpriseBrowserLeaseHandler,
  type EnterpriseBrowserLeaseAuthorityPort,
  type EnterpriseBrowserLeasePort,
  type EnterpriseBrowserProfileBindingPort,
  type EnterpriseBrowserProfileReadPort,
} from "./handlers.js";
import { isStableBrowserProfileBinding } from "./factory.js";
import {
  ENTERPRISE_BROWSER_LEASE_OPERATIONS,
  createEnterpriseBrowserLeaseDispatcherRegistration,
  createEnterpriseBrowserLeaseSessionRuntime,
} from "./factory.js";
import type { BrowserProfileLeaseAuthorization } from "./lease-manager.js";

const ORGANIZATION_ID = "org_1111111111111111";
const FOREIGN_ORGANIZATION_ID = "org_2222222222222222";
const NODE_ID = "nod_1111111111111111";
const PRINCIPAL_ID = "usr_1111111111111111";
const FOREIGN_PRINCIPAL_ID = "usr_2222222222222222";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";
const PROFILE_ID = "brp_1111111111111111";
const FOREIGN_PROFILE_ID = "brp_2222222222222222";

function principal(): PrincipalContext {
  return {
    organizationId: ORGANIZATION_ID,
    principalType: "human",
    principalId: PRINCIPAL_ID,
    grants: [],
    credentialId: "credential-1",
    grantVersion: "grant-version-1",
  };
}

function sessionContext(
  overrides: {
    organizationId?: string;
    principalId?: string;
    nodeId?: string;
    generation?: string;
  } = {},
): EnterpriseSessionContext {
  return {
    principal: {
      ...principal(),
      organizationId: overrides.organizationId ?? ORGANIZATION_ID,
      principalId: overrides.principalId ?? PRINCIPAL_ID,
    },
    node: {
      nodeId: overrides.nodeId ?? NODE_ID,
      paseoServerId: "server-1",
      mode: "managed",
    },
    sessionBindingGeneration: overrides.generation ?? "session-generation-1",
  };
}

function workspace(overrides: Partial<AuthorizedWorkspace> = {}): AuthorizedWorkspace {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    createdByPrincipalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function agent(overrides: Partial<AuthorizedAgent> = {}): AuthorizedAgent {
  return {
    ...workspace(),
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

function profile(overrides: Partial<BrowserProfileRecord> = {}): AuthorizedBrowserProfile {
  return {
    browserProfileId: PROFILE_ID,
    organizationId: ORGANIZATION_ID,
    homeNodeId: NODE_ID,
    businessIdentityId: "bid_1111111111111111",
    ownerPrincipalId: PRINCIPAL_ID,
    platform: "generic",
    businessAccountKey: "opaque-account",
    label: "Authorized profile",
    partitionKey: `persist:paseo-enterprise-${PROFILE_ID}`,
    downloadRoot: `/profiles/${PROFILE_ID}/downloads`,
    credentialRef: "keychain-profile-1",
    status: "ready",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Partial<BrowserProfileBinding> = {}): BrowserProfileBinding {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    workspaceId: WORKSPACE_ID,
    browserProfileId: PROFILE_ID,
    boundByPrincipalId: PRINCIPAL_ID,
    boundAt: "2026-09-10T01:00:00.000Z",
    ...overrides,
  };
}

function lease(overrides: Partial<FencedLease> = {}): FencedLease {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    businessIdentityId: "bid_1111111111111111",
    resourceKind: "browser_profile",
    resourceId: PROFILE_ID,
    leaseId: "lea_11111111-1111-1111-1111-111111111111",
    holderPrincipalId: PRINCIPAL_ID,
    holderAgentId: AGENT_ID,
    fencingToken: 1,
    mode: "write",
    acquiredAt: "2026-09-10T01:00:00.000Z",
    heartbeatAt: "2026-09-10T01:00:00.000Z",
    expiresAt: "2026-09-10T01:01:00.000Z",
    leaseRevision: "1",
    ...overrides,
  };
}

class MemoryProfiles implements EnterpriseBrowserProfileReadPort {
  public listCalls = 0;
  public getCalls = 0;

  public constructor(public records: BrowserProfileRecord[]) {}

  public async list(): Promise<BrowserProfileRecord[]> {
    this.listCalls++;
    return structuredClone(this.records);
  }

  public async get(browserProfileId: string): Promise<BrowserProfileRecord | null> {
    this.getCalls++;
    return structuredClone(
      this.records.find((record) => record.browserProfileId === browserProfileId) ?? null,
    );
  }
}

class MemoryBindings implements EnterpriseBrowserProfileBindingPort {
  public readonly bound: BrowserProfileBinding[] = [];
  public listCalls = 0;

  public constructor(public records: BrowserProfileBinding[]) {}

  public async list(): Promise<BrowserProfileBinding[]> {
    this.listCalls++;
    return structuredClone(this.records);
  }

  public async bind(input: {
    workspace: AuthorizedWorkspace;
    profile: AuthorizedBrowserProfile;
    actor: PrincipalContext;
  }): Promise<BrowserProfileBinding> {
    const next = binding({
      organizationId: input.workspace.organizationId,
      nodeId: input.workspace.nodeId,
      workspaceId: input.workspace.workspaceId,
      browserProfileId: input.profile.browserProfileId,
      boundByPrincipalId: input.actor.principalId,
    });
    this.bound.push(next);
    this.records = [next];
    return structuredClone(next);
  }
}

class MemoryLeases implements EnterpriseBrowserLeasePort {
  public readonly acquired: Parameters<EnterpriseBrowserLeasePort["acquire"]>[0][] = [];
  public readonly renewed: Parameters<EnterpriseBrowserLeasePort["renew"]>[0][] = [];
  public readonly released: Parameters<EnterpriseBrowserLeasePort["releaseLease"]>[0][] = [];
  public current = lease();
  public onAcquire: (() => void) | null = null;

  public async acquire(
    input: Parameters<EnterpriseBrowserLeasePort["acquire"]>[0],
  ): Promise<FencedLease> {
    this.acquired.push(input);
    this.onAcquire?.();
    return structuredClone(this.current);
  }

  public async renew(
    input: Parameters<EnterpriseBrowserLeasePort["renew"]>[0],
  ): Promise<FencedLease> {
    this.renewed.push(input);
    this.current = lease({ leaseRevision: "2" });
    return structuredClone(this.current);
  }

  public async releaseLease(
    input: Parameters<EnterpriseBrowserLeasePort["releaseLease"]>[0],
  ): Promise<void> {
    this.released.push(input);
  }
}

class MemoryAuthority implements EnterpriseBrowserLeaseAuthorityPort {
  public readonly registry = createEnterpriseAgentSessionContextRegistry();
  public readonly handle: EnterpriseAgentContextHandle;
  public workspaceRecord = workspace();
  public profileRecord = profile();
  public resolvedHandle: EnterpriseAgentContextHandle | null;
  public workspaceAvailable = true;
  public profileAvailable = true;
  public resolveLeaseAuthorizationCalls = 0;
  public bindingRevision = "binding-revision-1";

  public constructor() {
    this.handle = this.registry.bind({ agentId: AGENT_ID, context: sessionContext() });
    this.resolvedHandle = this.handle;
  }

  public async assertWorkspace(
    context: PrincipalContext,
    _action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    if (
      !this.workspaceAvailable ||
      context.organizationId !== ORGANIZATION_ID ||
      context.principalId !== PRINCIPAL_ID ||
      workspaceId !== this.workspaceRecord.workspaceId
    ) {
      throw new Error("Resource unavailable");
    }
    return structuredClone(this.workspaceRecord);
  }

  public async assertBrowserProfile(
    context: PrincipalContext,
    _action: EnterpriseAction,
    browserProfileId: string,
  ): Promise<AuthorizedBrowserProfile> {
    if (
      !this.profileAvailable ||
      context.organizationId !== ORGANIZATION_ID ||
      context.principalId !== PRINCIPAL_ID ||
      browserProfileId !== this.profileRecord.browserProfileId
    ) {
      throw new Error("Resource unavailable");
    }
    return structuredClone(this.profileRecord);
  }

  public resolveAgentHandle(input: {
    sessionContext: EnterpriseSessionContext;
    agentId: string;
  }): EnterpriseAgentContextHandle | null {
    if (
      input.agentId !== AGENT_ID ||
      input.sessionContext.sessionBindingGeneration !== this.handle.context.sessionBindingGeneration
    ) {
      return null;
    }
    return this.resolvedHandle;
  }

  public isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean {
    return this.registry.isCurrentHandle(handle);
  }

  public resolveLeaseAuthorization(
    handle: EnterpriseAgentContextHandle,
  ): BrowserProfileLeaseAuthorization {
    this.resolveLeaseAuthorizationCalls++;
    return {
      workspace: structuredClone(this.workspaceRecord),
      agent: agent({ agentId: handle.agentId }),
      profile: structuredClone(this.profileRecord),
      bindingRevision: this.bindingRevision,
    };
  }
}

function createHandler(
  input: {
    profiles?: MemoryProfiles;
    bindings?: MemoryBindings;
    leases?: MemoryLeases;
    authority?: MemoryAuthority;
  } = {},
): {
  handler: EnterpriseBrowserLeaseHandler;
  profiles: MemoryProfiles;
  bindings: MemoryBindings;
  leases: MemoryLeases;
  authority: MemoryAuthority;
} {
  const profiles = input.profiles ?? new MemoryProfiles([profile()]);
  const bindings = input.bindings ?? new MemoryBindings([binding()]);
  const leases = input.leases ?? new MemoryLeases();
  const authority = input.authority ?? new MemoryAuthority();
  return {
    handler: new EnterpriseBrowserLeaseHandler({
      profiles,
      bindings,
      leases,
      authority,
      leaseTtlMs: 60_000,
    }),
    profiles,
    bindings,
    leases,
    authority,
  };
}

function dispatchContext(context: EnterpriseSessionContext = sessionContext()) {
  return {
    sessionId: "session-1",
    clientId: "client-1",
    credentialId: context.principal.credentialId,
    sessionBindingGeneration: context.sessionBindingGeneration,
    enterpriseContext: context,
  };
}

describe("EnterpriseBrowserLeaseHandler", () => {
  test("rejects deferred A to B rebinding after authorization await", async () => {
    const first = {
      organizationId: "org-a",
      nodeId: "node-a",
      workspaceId: "ws",
      browserProfileId: "profile-a",
      boundAt: "a",
    };
    const second = { ...first, browserProfileId: "profile-b", boundAt: "b" };
    let current = first;
    const duringAuthorization = Promise.resolve().then(() => {
      current = second;
      return undefined;
    });
    await duringAuthorization;
    expect(isStableBrowserProfileBinding(first, current)).toBe(false);
  });
  test("lists only canonical profiles and binding projections for the authorized Workspace", async () => {
    const profiles = new MemoryProfiles([
      profile(),
      profile({
        browserProfileId: FOREIGN_PROFILE_ID,
        organizationId: FOREIGN_ORGANIZATION_ID,
        ownerPrincipalId: FOREIGN_PRINCIPAL_ID,
        businessIdentityId: "bid_2222222222222222",
      }),
    ]);
    const bindings = new MemoryBindings([
      binding(),
      binding({
        organizationId: FOREIGN_ORGANIZATION_ID,
        browserProfileId: FOREIGN_PROFILE_ID,
      }),
    ]);
    const { handler } = createHandler({ profiles, bindings });

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.list_profiles.request",
          requestId: "request-list",
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toEqual({
      type: "enterprise.browser.list_profiles.response",
      payload: {
        requestId: "request-list",
        profiles: [
          {
            browserProfileId: PROFILE_ID,
            organizationId: ORGANIZATION_ID,
            homeNodeId: NODE_ID,
            ownerPrincipalId: PRINCIPAL_ID,
            platform: "generic",
            label: "Authorized profile",
            status: "ready",
          },
        ],
        bindings: [
          {
            organizationId: ORGANIZATION_ID,
            nodeId: NODE_ID,
            workspaceId: WORKSPACE_ID,
            browserProfileId: PROFILE_ID,
            boundAt: "2026-09-10T01:00:00.000Z",
          },
        ],
      },
    });
  });

  test("lists a manage-only profile while content permissions remain separate", async () => {
    const authority = new MemoryAuthority();
    const original = authority.assertBrowserProfile.bind(authority);
    authority.assertBrowserProfile = async (context, action, profileId) => {
      if (action === "browser.use") throw new Error("use denied");
      return original(context, action, profileId);
    };
    const { handler } = createHandler({ authority });
    const response = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.browser.list_profiles.request",
        requestId: "request-manage-only-list",
        workspaceId: WORKSPACE_ID,
      },
    });
    expect(response).toMatchObject({ type: "enterprise.browser.list_profiles.response" });
  });

  test("denies an unavailable Workspace before reading Profile registries", async () => {
    const { handler, profiles, bindings } = createHandler();

    const response = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.browser.list_profiles.request",
        requestId: "request-foreign-workspace",
        workspaceId: "foreign-workspace",
      },
    });

    expect(profiles.listCalls).toBe(0);
    expect(bindings.listCalls).toBe(0);
    expect(response).toEqual({
      type: "rpc_error",
      payload: {
        requestId: "request-foreign-workspace",
        requestType: "enterprise.browser.list_profiles.request",
        error: "Enterprise resource unavailable",
        code: "access_denied",
      },
    });
  });

  test("binds an authorized Profile and omits binding actor authority from the response", async () => {
    const { handler, bindings } = createHandler();

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.bind_profile.request",
          requestId: "request-bind",
          workspaceId: WORKSPACE_ID,
          browserProfileId: PROFILE_ID,
        },
      }),
    ).resolves.toEqual({
      type: "enterprise.browser.bind_profile.response",
      payload: {
        requestId: "request-bind",
        binding: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          workspaceId: WORKSPACE_ID,
          browserProfileId: PROFILE_ID,
          boundAt: "2026-09-10T01:00:00.000Z",
        },
      },
    });

    expect(bindings.bound).toHaveLength(1);
  });

  test("denies a foreign Profile without mutating bindings", async () => {
    const { handler, bindings } = createHandler();

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.bind_profile.request",
          requestId: "request-bind-foreign",
          workspaceId: WORKSPACE_ID,
          browserProfileId: FOREIGN_PROFILE_ID,
        },
      }),
    ).resolves.toEqual({
      type: "rpc_error",
      payload: {
        requestId: "request-bind-foreign",
        requestType: "enterprise.browser.bind_profile.request",
        error: "Enterprise resource unavailable",
        code: "access_denied",
      },
    });

    expect(bindings.bound).toEqual([]);
  });

  test("acquires the server-resolved bound Browser Profile for the canonical Agent handle", async () => {
    const { handler, leases, authority } = createHandler();

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.acquire_lease.request",
          requestId: "request-acquire",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          resourceKind: "browser_profile",
          mode: "write",
        },
      }),
    ).resolves.toEqual({
      type: "enterprise.resource.acquire_lease.response",
      payload: { requestId: "request-acquire", lease: lease(), waiting: false },
    });

    expect(leases.acquired).toEqual([
      {
        handle: authority.handle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      },
    ]);
  });

  test("denies forged Workspace and Agent tuples before acquiring a lease", async () => {
    const { handler, leases } = createHandler();

    const workspaceResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-forged-workspace",
        workspaceId: "workspace-foreign",
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });
    const agentResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-forged-agent",
        workspaceId: WORKSPACE_ID,
        agentId: "agent-foreign",
        resourceKind: "browser_profile",
        mode: "write",
      },
    });

    expect(leases.acquired).toEqual([]);
    expect([workspaceResponse, agentResponse]).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "request-forged-workspace",
          requestType: "enterprise.resource.acquire_lease.request",
          error: "Enterprise resource unavailable",
          code: "access_denied",
        },
      },
      {
        type: "rpc_error",
        payload: {
          requestId: "request-forged-agent",
          requestType: "enterprise.resource.acquire_lease.request",
          error: "Enterprise resource unavailable",
          code: "access_denied",
        },
      },
    ]);
  });

  test("rejects a structural fake handle before trusted authorization or lease calls", async () => {
    const authority = new MemoryAuthority();
    authority.resolvedHandle = {
      agentId: AGENT_ID,
      context: sessionContext(),
      isCurrent: () => true,
    } as unknown as EnterpriseAgentContextHandle;
    const { handler, leases } = createHandler({ authority });

    const response = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-fake-handle",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });

    expect(authority.resolveLeaseAuthorizationCalls).toBe(0);
    expect(leases.acquired).toEqual([]);
    expect(response).toMatchObject({
      type: "rpc_error",
      payload: { requestId: "request-fake-handle", code: "access_denied" },
    });
  });

  test("renews with the server-held lease and releases that renewed lease exactly once", async () => {
    const { handler, leases, authority } = createHandler();
    await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-acquire-lifecycle",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });
    const renewResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.renew_lease.request",
        requestId: "request-renew",
        leaseId: lease().leaseId,
        fencingToken: lease().fencingToken,
      },
    });
    const releaseResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.release_lease.request",
        requestId: "request-release",
        leaseId: lease().leaseId,
        fencingToken: lease().fencingToken,
      },
    });

    expect(renewResponse).toEqual({
      type: "enterprise.resource.renew_lease.response",
      payload: { requestId: "request-renew", lease: lease({ leaseRevision: "2" }) },
    });
    expect(releaseResponse).toEqual({
      type: "enterprise.resource.release_lease.response",
      payload: { requestId: "request-release", released: true },
    });
    expect(leases.renewed).toEqual([{ handle: authority.handle, lease: lease(), ttlMs: 60_000 }]);
    expect(leases.released).toEqual([
      { handle: authority.handle, lease: lease({ leaseRevision: "2" }) },
    ]);
  });

  test("allows the same original holder to release after authorization revocation", async () => {
    const { handler, leases, authority } = createHandler();
    await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-acquire-before-revoke",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });
    authority.workspaceAvailable = false;
    authority.profileAvailable = false;

    const response = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.release_lease.request",
        requestId: "request-release-after-revoke",
        leaseId: lease().leaseId,
        fencingToken: lease().fencingToken,
      },
    });

    expect(leases.released).toEqual([{ handle: authority.handle, lease: lease() }]);
    expect(response).toEqual({
      type: "enterprise.resource.release_lease.response",
      payload: { requestId: "request-release-after-revoke", released: true },
    });
  });

  test("foreign and stale holders cannot renew or release another holder's lease", async () => {
    const { handler, leases, authority } = createHandler();
    await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-acquire-guarded",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });

    const foreignResponse = await handler.handle({
      sessionContext: dispatchContext(
        sessionContext({
          organizationId: FOREIGN_ORGANIZATION_ID,
          principalId: FOREIGN_PRINCIPAL_ID,
        }),
      ),
      message: {
        type: "enterprise.resource.renew_lease.request",
        requestId: "request-foreign-renew",
        leaseId: lease().leaseId,
        fencingToken: lease().fencingToken,
      },
    });
    authority.registry.bind({ agentId: AGENT_ID, context: sessionContext() });
    const staleResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.release_lease.request",
        requestId: "request-stale-release",
        leaseId: lease().leaseId,
        fencingToken: lease().fencingToken,
      },
    });

    expect(leases.renewed).toEqual([]);
    expect(leases.released).toEqual([]);
    expect(foreignResponse).toMatchObject({ type: "rpc_error" });
    expect(staleResponse).toMatchObject({ type: "rpc_error" });
  });

  test.each(["foreign_registry", "different_principal", "different_node", "different_agent"])(
    "rejects %s handles before trusted lease authorization",
    async (variant) => {
      const authority = new MemoryAuthority();
      if (variant === "foreign_registry") {
        const registry = createEnterpriseAgentSessionContextRegistry();
        authority.resolvedHandle = registry.bind({ agentId: AGENT_ID, context: sessionContext() });
      } else if (variant === "different_principal") {
        authority.resolvedHandle = authority.registry.bind({
          agentId: AGENT_ID,
          context: sessionContext({ principalId: FOREIGN_PRINCIPAL_ID }),
        });
      } else if (variant === "different_node") {
        authority.resolvedHandle = authority.registry.bind({
          agentId: AGENT_ID,
          context: sessionContext({ nodeId: "nod_2222222222222222" }),
        });
      } else {
        authority.resolvedHandle = authority.registry.bind({
          agentId: "agent-foreign",
          context: sessionContext(),
        });
      }
      const { handler, leases } = createHandler({ authority });

      const response = await handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.acquire_lease.request",
          requestId: `request-${variant}`,
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          resourceKind: "browser_profile",
          mode: "write",
        },
      });

      expect(response).toMatchObject({ type: "rpc_error" });
      expect(authority.resolveLeaseAuthorizationCalls).toBe(0);
      expect(leases.acquired).toEqual([]);
    },
  );

  test("releases a newly acquired lease when its handle becomes stale after manager await", async () => {
    const authority = new MemoryAuthority();
    const leases = new MemoryLeases();
    leases.onAcquire = () => {
      authority.registry.bind({ agentId: AGENT_ID, context: sessionContext() });
    };
    const { handler } = createHandler({ authority, leases });

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.acquire_lease.request",
          requestId: "request-stale-after-acquire",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          resourceKind: "browser_profile",
          mode: "write",
        },
      }),
    ).resolves.toMatchObject({ type: "rpc_error" });

    expect(leases.released).toEqual([{ handle: authority.handle, lease: lease() }]);
  });

  test("releases a renewed lease when the canonical binding revision changed", async () => {
    const { handler, leases, authority } = createHandler();
    await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-acquire-before-rebind",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });
    authority.bindingRevision = "binding-revision-2";

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.renew_lease.request",
          requestId: "request-renew-after-rebind",
          leaseId: lease().leaseId,
          fencingToken: lease().fencingToken,
        },
      }),
    ).resolves.toMatchObject({ type: "rpc_error" });

    expect(leases.released).toEqual([
      { handle: authority.handle, lease: lease({ leaseRevision: "2" }) },
    ]);
  });

  test("rejects a stale fencing token without invoking renew or release", async () => {
    const { handler, leases } = createHandler();
    await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-acquire-for-token",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });

    const renewResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.renew_lease.request",
        requestId: "request-renew-stale-token",
        leaseId: lease().leaseId,
        fencingToken: 2,
      },
    });
    const releaseResponse = await handler.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.release_lease.request",
        requestId: "request-release-stale-token",
        leaseId: lease().leaseId,
        fencingToken: 2,
      },
    });

    expect(renewResponse).toMatchObject({ type: "rpc_error" });
    expect(releaseResponse).toMatchObject({ type: "rpc_error" });
    expect(leases.renewed).toEqual([]);
    expect(leases.released).toEqual([]);
  });

  test("captures dependency methods with their receivers at construction", async () => {
    const profiles = new MemoryProfiles([profile()]);
    const leases = new MemoryLeases();
    const authority = new MemoryAuthority();
    const { handler } = createHandler({ profiles, leases, authority });
    profiles.list = async () => {
      throw new Error("mutated profile dependency");
    };
    leases.acquire = async () => {
      throw new Error("mutated lease dependency");
    };
    authority.resolveLeaseAuthorization = () => {
      throw new Error("mutated authority dependency");
    };

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.list_profiles.request",
          requestId: "request-list-snapshot",
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toMatchObject({ type: "enterprise.browser.list_profiles.response" });
    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.acquire_lease.request",
          requestId: "request-acquire-snapshot",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          resourceKind: "browser_profile",
          mode: "write",
        },
      }),
    ).resolves.toMatchObject({ type: "enterprise.resource.acquire_lease.response" });
  });

  test("snapshots each dependency port and the TTL exactly once at construction", async () => {
    const profiles = new MemoryProfiles([profile()]);
    const bindings = new MemoryBindings([binding()]);
    const leases = new MemoryLeases();
    const authority = new MemoryAuthority();
    const reads = {
      profiles: 0,
      bindings: 0,
      leases: 0,
      authority: 0,
      leaseTtlMs: 0,
    };
    const options = Object.defineProperties(
      {},
      {
        profiles: {
          get: () => {
            reads.profiles++;
            return profiles;
          },
        },
        bindings: {
          get: () => {
            reads.bindings++;
            return bindings;
          },
        },
        leases: {
          get: () => {
            reads.leases++;
            return leases;
          },
        },
        authority: {
          get: () => {
            reads.authority++;
            return authority;
          },
        },
        leaseTtlMs: {
          get: () => {
            reads.leaseTtlMs++;
            return 60_000;
          },
        },
      },
    ) as ConstructorParameters<typeof EnterpriseBrowserLeaseHandler>[0];

    const handler = new EnterpriseBrowserLeaseHandler(options);

    expect(reads).toEqual({
      profiles: 1,
      bindings: 1,
      leases: 1,
      authority: 1,
      leaseTtlMs: 1,
    });
    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.list_profiles.request",
          requestId: "request-list-option-snapshot",
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toMatchObject({ type: "enterprise.browser.list_profiles.response" });
    expect(reads).toEqual({
      profiles: 1,
      bindings: 1,
      leases: 1,
      authority: 1,
      leaseTtlMs: 1,
    });
  });

  test("rejects mismatched dispatcher credentials and generations before dependencies", async () => {
    const { handler, profiles, leases, authority } = createHandler();
    const credentialContext = { ...dispatchContext(), credentialId: "credential-foreign" };
    const generationContext = {
      ...dispatchContext(),
      sessionBindingGeneration: "session-generation-foreign",
    };
    const message = {
      type: "enterprise.browser.list_profiles.request" as const,
      requestId: "request-dispatch-context",
      workspaceId: WORKSPACE_ID,
    };

    await expect(handler.handle({ sessionContext: credentialContext, message })).resolves.toBe(
      false,
    );
    await expect(handler.handle({ sessionContext: generationContext, message })).resolves.toBe(
      false,
    );
    expect(profiles.listCalls).toBe(0);
    expect(leases.acquired).toEqual([]);
    expect(authority.resolveLeaseAuthorizationCalls).toBe(0);
  });

  test("does not claim AppSlot or unknown lease references owned by another handler", async () => {
    const { handler, leases } = createHandler();

    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.acquire_lease.request",
          requestId: "request-app-slot",
          workspaceId: WORKSPACE_ID,
          agentId: AGENT_ID,
          resourceKind: "app_slot",
          mode: "write",
        },
      }),
    ).resolves.toBe(false);
    await expect(
      handler.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.resource.release_lease.request",
          requestId: "request-unknown-lease",
          leaseId: "lea_22222222-2222-2222-2222-222222222222",
          fencingToken: 1,
        },
      }),
    ).resolves.toBe(false);

    expect(leases.acquired).toEqual([]);
    expect(leases.released).toEqual([]);
  });

  test("opens a per-session dispatcher lease and closes its held leases", async () => {
    const profiles = new MemoryProfiles([profile()]);
    const bindings = new MemoryBindings([binding()]);
    const leases = new MemoryLeases();
    const authority = new MemoryAuthority();
    const runtime = createEnterpriseBrowserLeaseSessionRuntime({
      profiles,
      bindings,
      leases,
      leaseTtlMs: 60_000,
    });
    const registration = createEnterpriseBrowserLeaseDispatcherRegistration({
      runtime,
      authority,
    });

    expect(registration?.manifest.operations).toEqual(ENTERPRISE_BROWSER_LEASE_OPERATIONS);
    expect(() =>
      registration?.open({
        sessionId: "",
        clientId: "client-1",
        context: sessionContext(),
      }),
    ).toThrow(/sessionId/);
    const sessionLease = registration?.open({
      sessionId: "session-1",
      clientId: "client-1",
      context: sessionContext(),
    });
    expect(sessionLease).toBeDefined();
    if (!sessionLease) throw new Error("factory did not open a session lease");
    const foreignRuntimeLease = registration?.open({
      sessionId: "session-foreign",
      clientId: "client-1",
      context: sessionContext(),
      authorizationRuntime: createEnterpriseBrowserLeaseSessionRuntime({
        profiles,
        bindings,
        leases,
        leaseTtlMs: 60_000,
      }),
    });
    expect(foreignRuntimeLease).toBeDefined();
    await foreignRuntimeLease?.close();
    await sessionLease.dispatcher.handle({
      sessionContext: dispatchContext(),
      message: {
        type: "enterprise.resource.acquire_lease.request",
        requestId: "request-factory-acquire",
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        resourceKind: "browser_profile",
        mode: "write",
      },
    });
    await sessionLease.close();

    expect(leases.released).toEqual([{ handle: authority.handle, lease: lease() }]);
    await expect(
      sessionLease.dispatcher.handle({
        sessionContext: dispatchContext(),
        message: {
          type: "enterprise.browser.list_profiles.request",
          requestId: "request-after-close",
          workspaceId: WORKSPACE_ID,
        },
      }),
    ).resolves.toBe(false);
  });

  test("does not register when typed runtime or authority dependencies are absent", () => {
    expect(createEnterpriseBrowserLeaseDispatcherRegistration(null)).toBeNull();
    expect(
      createEnterpriseBrowserLeaseDispatcherRegistration({
        runtime: undefined as never,
        authority: undefined as never,
      }),
    ).toBeNull();
  });
});
