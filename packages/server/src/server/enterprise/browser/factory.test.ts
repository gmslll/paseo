import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResourceGrant } from "@getpaseo/protocol/messages";
import { afterAll, describe, expect, test } from "vitest";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
  node,
  principal,
} from "../access/production-runtime-test-fixture.js";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseAgentContextHandle,
  type EnterpriseAgentSessionContextRegistry,
} from "../../session/enterprise-agent-session-context-registry.js";
import type { EnterpriseDispatcherLease } from "../../session/enterprise-dispatcher.js";
import {
  createEnterpriseBrowserLeaseSessionRuntime,
  createProductionBrowserLeaseDispatcherRegistration,
} from "./factory.js";
import {
  createProductionBrowserLeaseBundle,
  prepareProductionBrowserProfileRegistry,
  type ProductionBrowserLeaseBundle,
} from "./production-bundle.js";
import type { ProductionAuthorizationRuntime } from "../access/production-authorization-runtime.js";
import type { ProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";

const WORKSPACE_ID = "wks_0123456789abcdef";
const AGENT_ID = "00000000-0000-4000-8000-000000000042";
const PROFILE_ID = "brp_4242424242424242";
const LEASE_ID = "lea_42424242-4242-4424-8424-424242424242";
const FOREIGN_ORGANIZATION_ID = "org_2222222222222222";
const FOREIGN_PRINCIPAL_ID = "usr_2222222222222222";
const AUTHORIZED_GRANTS = Object.freeze([
  {
    action: "workspace.metadata.read",
    selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
  },
  { action: "browser.use", selector: { kind: "self" } },
] as const satisfies readonly ResourceGrant[]);

interface FactoryFixture {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly authorizationRuntime: ProductionAuthorizationRuntime;
  readonly bundle: ProductionBrowserLeaseBundle;
  readonly registry: EnterpriseAgentSessionContextRegistry;
  readonly bindCount: () => number;
  readonly context: Awaited<ReturnType<typeof createProductionRuntimeFixture>>["context"];
  readonly home: string;
}

afterAll(closeProductionRuntimeFixture);

describe.skipIf(process.platform !== "darwin")("production browser dispatcher factory", () => {
  test("binds the exact Session once after canonical browser.use authorization", async () => {
    const fixture = await createFixture("authorized", { bindProfile: true });
    const sessionLease = open(fixture);
    try {
      const response = await acquire(sessionLease, fixture);

      expect(response).toMatchObject({
        type: "enterprise.resource.acquire_lease.response",
        payload: {
          lease: { holderAgentId: AGENT_ID, resourceId: PROFILE_ID },
        },
      });
      expect(fixture.bindCount()).toBe(1);
      const handle = fixture.registry.resolve(AGENT_ID);
      expect(handle).not.toBeNull();
      expect(handle?.context).toEqual(fixture.context.enterpriseContext);
    } finally {
      await closeFixture(fixture, sessionLease);
    }
  });

  test.each(["missing", "foreign", "no_grant"] as const)(
    "does not bind a %s Agent request",
    async (variant) => {
      const fixture = await createFixture(`denied-${variant}`, {
        grants: variant === "no_grant" ? AUTHORIZED_GRANTS.slice(0, 1) : AUTHORIZED_GRANTS,
        agent: variant === "missing" ? "missing" : variant,
      });
      const sessionLease = open(fixture);
      try {
        const response = await acquire(sessionLease, fixture, {
          agentId: variant === "foreign" ? "agent-foreign" : AGENT_ID,
          workspaceId: variant === "foreign" ? "workspace-foreign" : WORKSPACE_ID,
        });

        expect(response).toMatchObject({
          type: "rpc_error",
          payload: { code: "access_denied" },
        });
        expect(fixture.bindCount()).toBe(0);
        expect(fixture.registry.resolve(AGENT_ID)).toBeNull();
        expect(fixture.registry.resolve("agent-foreign")).toBeNull();
      } finally {
        await closeFixture(fixture, sessionLease);
      }
    },
  );

  test("does not bind after the production runtime is stale", async () => {
    const fixture = await createFixture("stale");
    const sessionLease = open(fixture);
    await fixture.authorizationRuntime.release();
    try {
      await expect(acquire(sessionLease, fixture)).resolves.toBe(false);
      expect(fixture.bindCount()).toBe(0);
      expect(fixture.registry.resolve(AGENT_ID)).toBeNull();
    } finally {
      await closeFixture(fixture, sessionLease);
    }
  });

  test("does not bind when the runtime is revoked across deferred Agent authorization", async () => {
    const fixture = await createFixture("deferred-revoke");
    const sessionLease = open(fixture);
    try {
      const response = acquire(sessionLease, fixture);
      await fixture.authorizationRuntime.release();

      await expect(response).resolves.toMatchObject({
        type: "rpc_error",
        payload: { code: "access_denied" },
      });
      expect(fixture.bindCount()).toBe(0);
      expect(fixture.registry.resolve(AGENT_ID)).toBeNull();
    } finally {
      await closeFixture(fixture, sessionLease);
    }
  });

  test("releases the exact newly bound handle when later lease authorization fails", async () => {
    const fixture = await createFixture("post-bind-failure");
    const sessionLease = open(fixture);
    try {
      await expect(acquire(sessionLease, fixture)).resolves.toMatchObject({
        type: "rpc_error",
        payload: { code: "access_denied" },
      });
      expect(fixture.bindCount()).toBe(1);
      expect(fixture.registry.resolve(AGENT_ID)).toBeNull();
    } finally {
      await closeFixture(fixture, sessionLease);
    }
  });

  test("failed cleanup cannot release a successor binding for the same generation", async () => {
    let successor: EnterpriseAgentContextHandle | null = null;
    let firstBind = true;
    const fixture = await createFixture("successor", {
      onBind: (registry, input) => {
        const handle = registry.bind(input);
        if (firstBind) {
          firstBind = false;
          queueMicrotask(() => {
            successor = registry.bind(input);
          });
        }
        return handle;
      },
    });
    const sessionLease = open(fixture);
    try {
      await expect(acquire(sessionLease, fixture)).resolves.toMatchObject({
        type: "rpc_error",
        payload: { code: "access_denied" },
      });
      expect(fixture.bindCount()).toBe(1);
      expect(successor).not.toBeNull();
      expect(fixture.registry.resolve(AGENT_ID)).toBe(successor);
      expect(successor?.isCurrent()).toBe(true);
    } finally {
      await closeFixture(fixture, sessionLease);
    }
  });
});

async function createFixture(
  name: string,
  options: {
    readonly grants?: readonly ResourceGrant[];
    readonly bindProfile?: boolean;
    readonly agent?: "authorized" | "missing" | "foreign" | "no_grant";
    readonly onBind?: (
      registry: EnterpriseAgentSessionContextRegistry,
      input: Parameters<EnterpriseAgentSessionContextRegistry["bind"]>[0],
    ) => EnterpriseAgentContextHandle;
  } = {},
): Promise<FactoryFixture> {
  const home = await mkdtemp(path.join(os.tmpdir(), `paseo-browser-factory-${name}-`));
  const profiles = await prepareProductionBrowserProfileRegistry({
    paseoHome: home,
    nodeId: node.nodeId,
    downloadBaseRoot: path.join(home, "downloads"),
    createId: () => PROFILE_ID,
  });
  const profile = await profiles.create({
    organizationId: principal.organizationId,
    homeNodeId: node.nodeId,
    businessIdentityId: "bid_4242424242424242",
    ownerPrincipalId: principal.principalId,
    platform: "generic",
    businessAccountKey: `account-${name}`,
    label: `Profile ${name}`,
    expectedIdentity: { hostnames: ["account.example"] },
    status: "ready",
  });
  const runtimeFixture = await createProductionRuntimeFixture(name, {
    grants: options.grants ?? AUTHORIZED_GRANTS,
    browserProfiles: profiles,
  });
  const { provider, runtime: authorizationRuntime } = runtimeFixture;
  if (options.agent === "foreign") {
    provider.owners.registerWorkspace({
      id: "workspace-foreign",
      organizationId: FOREIGN_ORGANIZATION_ID,
      nodeId: node.nodeId,
      ownerPrincipalId: FOREIGN_PRINCIPAL_ID,
      createdByPrincipalId: FOREIGN_PRINCIPAL_ID,
    });
    provider.owners.registerAgent({
      id: "agent-foreign",
      workspaceId: "workspace-foreign",
      organizationId: FOREIGN_ORGANIZATION_ID,
      nodeId: node.nodeId,
      ownerPrincipalId: FOREIGN_PRINCIPAL_ID,
      createdByPrincipalId: FOREIGN_PRINCIPAL_ID,
    });
  } else if (options.agent !== "missing") {
    provider.owners.registerAgent({
      id: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: principal.organizationId,
      nodeId: node.nodeId,
      ownerPrincipalId: principal.principalId,
      createdByPrincipalId: principal.principalId,
    });
  }
  const bundle = createProductionBrowserLeaseBundle({
    paseoHome: home,
    nodeId: node.nodeId,
    downloadBaseRoot: path.join(home, "downloads"),
    profiles,
    auditSink: runtimeFixture.audit,
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    createLeaseId: () => LEASE_ID,
    createRequestId: () => `request-${name}`,
    maxLeaseTtlMs: 60_000,
  });
  await Promise.all([bundle.bindings.initialize(), bundle.leases.initialize()]);
  if (options.bindProfile) {
    const workspace = provider.owners.getWorkspace(WORKSPACE_ID);
    if (!workspace) throw new Error("expected canonical Workspace");
    await bundle.bindings.bind({ workspace, profile, actor: authorizationRuntime.principal });
  }
  const sourceRegistry = createEnterpriseAgentSessionContextRegistry();
  let binds = 0;
  const registry: EnterpriseAgentSessionContextRegistry = {
    bind: (input) => {
      binds++;
      return options.onBind ? options.onBind(sourceRegistry, input) : sourceRegistry.bind(input);
    },
    resolve: sourceRegistry.resolve,
    isCurrentHandle: sourceRegistry.isCurrentHandle,
    release: sourceRegistry.release,
    releaseSession: sourceRegistry.releaseSession,
  };
  return {
    provider,
    authorizationRuntime,
    bundle,
    registry,
    bindCount: () => binds,
    context: runtimeFixture.context,
    home,
  };
}

function open(fixture: FactoryFixture): EnterpriseDispatcherLease {
  const registration = createProductionBrowserLeaseDispatcherRegistration({
    provider: fixture.provider,
    registry: fixture.registry,
    bundle: fixture.bundle,
    runtime: createEnterpriseBrowserLeaseSessionRuntime({
      profiles: fixture.bundle.profiles,
      bindings: fixture.bundle.bindings,
      leases: fixture.bundle.leases,
      leaseTtlMs: 60_000,
    }),
  });
  const lease = registration?.open({
    sessionId: fixture.context.sessionId,
    clientId: fixture.context.clientId,
    context: fixture.context.enterpriseContext,
    authorizationRuntime: fixture.authorizationRuntime,
  });
  if (!lease) throw new Error("expected production browser dispatcher lease");
  return lease;
}

function acquire(
  lease: EnterpriseDispatcherLease,
  fixture: FactoryFixture,
  overrides: { readonly agentId?: string; readonly workspaceId?: string } = {},
) {
  return lease.dispatcher.handle({
    sessionContext: fixture.context,
    message: {
      type: "enterprise.resource.acquire_lease.request",
      requestId: `request-${path.basename(fixture.home)}`,
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      agentId: overrides.agentId ?? AGENT_ID,
      resourceKind: "browser_profile",
      mode: "write",
    },
  });
}

async function closeFixture(
  fixture: FactoryFixture,
  sessionLease: EnterpriseDispatcherLease,
): Promise<void> {
  try {
    await sessionLease.close();
  } finally {
    fixture.registry.releaseSession(fixture.context.sessionBindingGeneration);
    await fixture.bundle.close();
    await fixture.authorizationRuntime.release();
    await rm(fixture.home, { recursive: true, force: true });
  }
}
