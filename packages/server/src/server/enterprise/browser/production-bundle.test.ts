import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  JsonFileBrowserProfileLeaseGenerationStorage,
  createProductionBrowserLeaseWaitingContext,
  createProductionBrowserLeaseBundle,
  isProductionBrowserLeaseWaitingContext,
  isProductionBrowserLeaseWaitingContextForSession,
  type ProductionBrowserLeaseBundle,
  type ProductionBrowserLeaseWaitingNotice,
} from "./production-bundle.js";
import type {
  BrowserProfileLeaseAuthorization,
  BrowserProfileLeaseWaitingNotice,
} from "./lease-manager.js";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseAgentContextHandle,
} from "../../session/enterprise-agent-session-context-registry.js";
import { createAuthenticatedBrowserHostSession } from "../../browser-tools/page-identity-registry.js";

const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_1111111111111111";
const PRINCIPAL_ID = "usr_1111111111111111";
const OWNER_ID = "usr_2222222222222222";
const PROFILE_ID = "brp_1111111111111111";
const WORKSPACE_ID = "workspace-1";

function bindHandle(agentId: string, generation: string): EnterpriseAgentContextHandle {
  return createEnterpriseAgentSessionContextRegistry().bind({
    agentId,
    context: {
      principal: {
        organizationId: ORGANIZATION_ID,
        principalType: "human",
        principalId: PRINCIPAL_ID,
        grants: [],
        credentialId: `credential-${agentId}`,
        grantVersion: "grant-version-1",
      },
      node: { nodeId: NODE_ID, paseoServerId: "server-1", mode: "managed" },
      sessionBindingGeneration: generation,
    },
  });
}

function authorization(handle: EnterpriseAgentContextHandle): BrowserProfileLeaseAuthorization {
  return {
    workspace: {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
    },
    agent: {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: OWNER_ID,
      agentId: handle.agentId,
      workspaceId: WORKSPACE_ID,
    },
    profile: {
      browserProfileId: PROFILE_ID,
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_1111111111111111",
      ownerPrincipalId: OWNER_ID,
      platform: "generic",
      businessAccountKey: "production-waiting-account",
      label: "Production waiting profile",
      partitionKey: `persist:paseo-enterprise-${PROFILE_ID}`,
      downloadRoot: `/profiles/${PROFILE_ID}/downloads`,
      status: "ready",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    },
    bindingRevision: "binding-revision-1",
  };
}

function createBundle(
  home: string,
  onWaiting?: (notice: BrowserProfileLeaseWaitingNotice) => void | Promise<void>,
): ProductionBrowserLeaseBundle {
  const leaseIds = [
    "lea_11111111-1111-4111-8111-111111111111",
    "lea_22222222-2222-4222-8222-222222222222",
    "lea_33333333-3333-4333-8333-333333333333",
  ];
  let requestId = 0;
  return createProductionBrowserLeaseBundle({
    paseoHome: home,
    nodeId: NODE_ID,
    downloadBaseRoot: path.join(home, "downloads"),
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    auditSink: { append: vi.fn(async (event) => event as never) },
    createLeaseId: () => leaseIds.shift() ?? "lea_44444444-4444-4444-8444-444444444444",
    createRequestId: () => `request-${++requestId}`,
    maxLeaseTtlMs: 60_000,
    onWaiting,
  });
}

function bindAuthority(
  bundle: ProductionBrowserLeaseBundle,
  handle: EnterpriseAgentContextHandle,
  waitingContext?: ReturnType<typeof createProductionBrowserLeaseWaitingContext>,
): () => void {
  return bundle.bindSessionAuthority({
    generation: handle.context.sessionBindingGeneration,
    isCurrentHandle: (candidate) => candidate === handle && handle.isCurrent(),
    resolveAuthorization: (candidate) => {
      if (candidate !== handle) throw new Error("Foreign Agent handle.");
      return authorization(handle);
    },
    waitingContext,
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function expectStillWaiting(promise: Promise<unknown>): Promise<void> {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await flushMicrotasks();
  expect(settled).not.toHaveBeenCalled();
}

describe("production browser lease bundle", () => {
  test("persists lease generation JSON across storage restart", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const file = path.join(home, "enterprise", "browser", "lease-generation.json");
    const first = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await first.write({ version: 1, generation: 4, nextFencingToken: 9 });
    const restarted = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await expect(restarted.read()).resolves.toEqual({
      version: 1,
      generation: 4,
      nextFencingToken: 9,
    });
  });

  test("fails closed for corrupt and unknown generation JSON", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const file = path.join(home, "enterprise", "browser", "lease-generation.json");
    const storage = new JsonFileBrowserProfileLeaseGenerationStorage(file);
    await storage.write({ version: 1, generation: 1, nextFencingToken: 2, unexpected: true });
    await expect(storage.read()).rejects.toThrow();
    await writeFile(file, "{broken", "utf8");
    await expect(storage.read()).rejects.toThrow(SyntaxError);
  });

  test("bundle close and invalidation are idempotent", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const clock = { now: () => Date.now(), setTimeout, clearTimeout };
    const bundle = createProductionBrowserLeaseBundle({
      paseoHome: home,
      nodeId: "node-1",
      downloadBaseRoot: path.join(home, "downloads"),
      clock,
      auditSink: { append: vi.fn(async () => undefined) },
      createLeaseId: () => "lease-1",
      createRequestId: () => "request-1",
      maxLeaseTtlMs: 60_000,
      isCurrentHandle: () => false,
      resolveAuthorization: () => {
        throw new Error("not expected");
      },
    });
    await expect(bundle.invalidateHost("missing-host")).resolves.toBeUndefined();
    await expect(bundle.invalidateHost("missing-host")).resolves.toBeUndefined();
    await expect(bundle.close()).resolves.toBeUndefined();
    await expect(bundle.close()).resolves.toBeUndefined();
    await expect(
      readFile(path.join(home, "enterprise", "browser", "lease-generation.json"), "utf8"),
    ).resolves.toContain('"generation"');
  });

  test("exposes nominal verification and both production registrations without advertising them", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const bundle = createBundle(home);
    try {
      const created = await bundle.profiles.create({
        organizationId: ORGANIZATION_ID,
        homeNodeId: NODE_ID,
        businessIdentityId: "bid_1111111111111111",
        ownerPrincipalId: OWNER_ID,
        platform: "generic",
        businessAccountKey: "account-a",
        label: "Account A",
        expectedIdentity: { hostnames: ["shop.example"] },
        status: "ready",
      });
      const host = createAuthenticatedBrowserHostSession({
        clientId: "desktop-client-1",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-1",
      });
      bundle.pageIdentity.registerBrowser({
        host,
        browserId: "11111111-1111-4111-8111-111111111111",
        browserProfileId: created.browserProfileId,
        bindingRevision: "binding-1",
      });
      await bundle.pageIdentity.observe(host, {
        type: "enterprise.browser.page_identity.observe.request",
        requestId: "observe-1",
        browser: {
          browserId: "11111111-1111-4111-8111-111111111111",
          browserProfileId: created.browserProfileId,
        },
        hostname: "shop.example",
        observationRevision: "observation-1",
        bindingRevision: "binding-1",
        lifecycleGeneration: "session-1",
      });

      const proof = await bundle.pageIdentity.verify({
        browserId: "11111111-1111-4111-8111-111111111111",
        browserProfileId: created.browserProfileId,
        bindingRevision: "binding-1",
      });
      expect(proof).toMatchObject({ observationRevision: "observation-1" });
      await bundle.invalidateHost("browser-route-1");
      await expect(bundle.pageIdentity.recheck(proof)).resolves.toBeUndefined();
      expect(bundle.pageIdentityObservationRegistration.manifest.operations).toEqual([
        "enterprise.browser.page_identity.observe.request",
      ]);
      expect(bundle.pageIdentityInvalidationRegistration.manifest.operations).toEqual([
        "enterprise.browser.page_identity.invalidate.request",
      ]);
      expect("enterpriseBrowserPageIdentityObservationV1" in bundle).toBe(false);
      expect("enterpriseBrowserPageIdentityInvalidationV1" in bundle).toBe(false);
    } finally {
      await bundle.close();
    }
  });

  test("routes same-Profile FIFO waiting to each exact server Session context", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const bundle = createBundle(home);
    const firstHandle = bindHandle("agent-first", "generation-first");
    const secondHandle = bindHandle("agent-second", "generation-second");
    const thirdHandle = bindHandle("agent-third", "generation-third");
    const secondNotices: ProductionBrowserLeaseWaitingNotice[] = [];
    const thirdNotices: ProductionBrowserLeaseWaitingNotice[] = [];
    const secondContext = createProductionBrowserLeaseWaitingContext({
      sessionId: "session-second",
      clientId: "client-second",
      sessionBindingGeneration: "generation-second",
      onWaiting: (notice) => secondNotices.push(notice),
    });
    const thirdContext = createProductionBrowserLeaseWaitingContext({
      sessionId: "session-third",
      clientId: "client-third",
      sessionBindingGeneration: "generation-third",
      onWaiting: (notice) => thirdNotices.push(notice),
    });
    expect(
      isProductionBrowserLeaseWaitingContextForSession(secondContext, {
        sessionId: "session-second",
        clientId: "client-second",
        sessionBindingGeneration: "generation-second",
      }),
    ).toBe(true);
    expect(
      isProductionBrowserLeaseWaitingContextForSession(secondContext, {
        sessionId: "session-third",
        clientId: "client-second",
        sessionBindingGeneration: "generation-second",
      }),
    ).toBe(false);
    expect(
      isProductionBrowserLeaseWaitingContextForSession(structuredClone(secondContext), {
        sessionId: "session-second",
        clientId: "client-second",
        sessionBindingGeneration: "generation-second",
      }),
    ).toBe(false);
    const unbind = [
      bindAuthority(bundle, firstHandle),
      bindAuthority(bundle, secondHandle, secondContext),
      bindAuthority(bundle, thirdHandle, thirdContext),
    ];

    try {
      const first = await bundle.leases.acquire({
        handle: firstHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      const second = bundle.leases.acquire({
        handle: secondHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      const third = bundle.leases.acquire({
        handle: thirdHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      await flushMicrotasks();

      expect(secondNotices).toHaveLength(1);
      expect(thirdNotices).toHaveLength(1);
      expect(secondNotices[0]).toMatchObject({
        agentId: "agent-second",
        workspaceId: WORKSPACE_ID,
        resourceId: PROFILE_ID,
        mode: "write",
        position: 1,
        context: {
          sessionId: "session-second",
          clientId: "client-second",
          sessionBindingGeneration: "generation-second",
        },
      });
      expect(thirdNotices[0]).toMatchObject({
        agentId: "agent-third",
        workspaceId: WORKSPACE_ID,
        resourceId: PROFILE_ID,
        mode: "write",
        position: 2,
        context: {
          sessionId: "session-third",
          clientId: "client-third",
          sessionBindingGeneration: "generation-third",
        },
      });
      expect(isProductionBrowserLeaseWaitingContext(secondNotices[0]?.context)).toBe(true);
      expect(isProductionBrowserLeaseWaitingContext(thirdNotices[0]?.context)).toBe(true);
      expect(secondNotices[0]?.context).not.toBe(thirdNotices[0]?.context);
      expect(Object.isFrozen(secondNotices[0]?.context)).toBe(true);
      expect(Object.keys(secondNotices[0]?.context ?? {}).sort()).toEqual([
        "clientId",
        "sessionBindingGeneration",
        "sessionId",
      ]);
      await expectStillWaiting(second);
      await expectStillWaiting(third);

      await bundle.leases.releaseLease({ handle: firstHandle, lease: first });
      const secondLease = await second;
      expect(secondLease.holderAgentId).toBe("agent-second");
      await expectStillWaiting(third);
      await bundle.leases.releaseLease({ handle: secondHandle, lease: secondLease });
      const thirdLease = await third;
      expect(thirdLease.holderAgentId).toBe("agent-third");
      await bundle.leases.releaseLease({ handle: thirdHandle, lease: thirdLease });
    } finally {
      for (const release of unbind) release();
      await bundle.close();
    }
  });

  test("fails a waiter closed when its exact Session waiting callback fails", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const bundle = createBundle(home);
    const activeHandle = bindHandle("agent-active", "generation-active");
    const waitingHandle = bindHandle("agent-waiting", "generation-waiting");
    const wrongGenerationContext = createProductionBrowserLeaseWaitingContext({
      sessionId: "session-waiting",
      clientId: "client-waiting",
      sessionBindingGeneration: "generation-other",
      onWaiting: () => undefined,
    });
    expect(() => bindAuthority(bundle, waitingHandle, wrongGenerationContext)).toThrow(
      /does not match/i,
    );
    const unbind = [
      bindAuthority(bundle, activeHandle),
      bindAuthority(
        bundle,
        waitingHandle,
        createProductionBrowserLeaseWaitingContext({
          sessionId: "session-waiting",
          clientId: "client-waiting",
          sessionBindingGeneration: "generation-waiting",
          onWaiting: () => Promise.reject(new Error("Session is no longer writable.")),
        }),
      ),
    ];

    try {
      const active = await bundle.leases.acquire({
        handle: activeHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      await expect(
        bundle.leases.acquire({
          handle: waitingHandle,
          resourceId: PROFILE_ID,
          mode: "write",
          ttlMs: 60_000,
        }),
      ).rejects.toThrow(/status unavailable/i);
      await bundle.leases.releaseLease({ handle: activeHandle, lease: active });
    } finally {
      for (const release of unbind) release();
      await bundle.close();
    }
  });

  test("preserves the legacy waiting callback and notice shape when no Session sink is bound", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-bundle-"));
    const notices: BrowserProfileLeaseWaitingNotice[] = [];
    const bundle = createBundle(home, (notice) => notices.push(notice));
    const activeHandle = bindHandle("agent-legacy-active", "generation-legacy-active");
    const waitingHandle = bindHandle("agent-legacy-waiting", "generation-legacy-waiting");
    const unbind = [bindAuthority(bundle, activeHandle), bindAuthority(bundle, waitingHandle)];

    try {
      const active = await bundle.leases.acquire({
        handle: activeHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      const waiting = bundle.leases.acquire({
        handle: waitingHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: 60_000,
      });
      await flushMicrotasks();
      expect(notices).toEqual([
        {
          requestId: "request-1",
          agentId: "agent-legacy-waiting",
          workspaceId: WORKSPACE_ID,
          resourceId: PROFILE_ID,
          mode: "write",
          position: 1,
        },
      ]);
      await bundle.leases.releaseLease({ handle: activeHandle, lease: active });
      const waitingLease = await waiting;
      await bundle.leases.releaseLease({ handle: waitingHandle, lease: waitingLease });
    } finally {
      for (const release of unbind) release();
      await bundle.close();
    }
  });
});
