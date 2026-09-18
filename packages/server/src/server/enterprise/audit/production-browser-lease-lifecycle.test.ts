import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ProductionAuthorizationRuntime } from "../access/production-authorization-runtime.js";
import type { ProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
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
import {
  createProductionBrowserLeaseBundle,
  prepareProductionBrowserProfileRegistry,
  type ProductionBrowserLeaseBundle,
} from "../browser/production-bundle.js";

const WORKSPACE_ID = "wks_0123456789abcdef";
const AGENT_ID = "00000000-0000-4000-8000-000000000012";
const PROFILE_ID = "brp_1212121212121212";
const LEASE_TTL_MS = 60_000;

const grants = Object.freeze([
  {
    action: "workspace.metadata.read" as const,
    selector: { kind: "workspace" as const, workspaceIds: [WORKSPACE_ID] },
  },
  {
    action: "browser.use" as const,
    selector: { kind: "self" as const },
  },
]);

interface BoundAuthority {
  readonly resolutionCount: () => number;
  readonly unbind: () => void;
}

function bindProductionAuthority(input: {
  readonly bundle: ProductionBrowserLeaseBundle;
  readonly runtime: ProductionAuthorizationRuntime;
  readonly registry: EnterpriseAgentSessionContextRegistry;
}): BoundAuthority {
  let resolutions = 0;
  const unbind = input.bundle.bindSessionAuthority({
    generation: input.runtime.binding.sessionBindingGeneration,
    isCurrentHandle: (handle) => input.registry.isCurrentHandle(handle),
    resolveAuthorization: async (handle, requestedProfileId) => {
      resolutions++;
      const agent = await input.runtime.resourceAuthorization.assertAgent(
        handle.context.principal,
        "workspace.metadata.read",
        handle.agentId,
      );
      const workspace = await input.runtime.resourceAuthorization.assertWorkspace(
        handle.context.principal,
        "workspace.metadata.read",
        agent.workspaceId,
      );
      const binding = await input.bundle.bindings.resolveForAgent({ workspace, agent });
      if (!binding || binding.browserProfileId !== requestedProfileId) {
        throw new Error("The current Agent binding does not match the requested Browser Profile.");
      }
      const profile = await input.runtime.resourceAuthorization.assertBrowserProfile(
        handle.context.principal,
        "browser.use",
        binding.browserProfileId,
      );
      return { workspace, agent, profile, bindingRevision: binding.boundAt };
    },
  });
  return Object.freeze({
    resolutionCount: () => resolutions,
    unbind,
  });
}

function bindAgentHandle(input: {
  readonly runtime: ProductionAuthorizationRuntime;
  readonly registry: EnterpriseAgentSessionContextRegistry;
}): EnterpriseAgentContextHandle {
  return input.registry.bind({
    agentId: AGENT_ID,
    context: {
      principal: input.runtime.principal,
      node: input.runtime.node,
      sessionBindingGeneration: input.runtime.binding.sessionBindingGeneration,
    },
  });
}

function registerAgent(
  runtime: ProductionAuthorizationRuntime,
  provider: ProductionAuthorizationRuntimeProvider,
): void {
  provider.owners.registerAgent({
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    organizationId: runtime.principal.organizationId,
    nodeId: runtime.node.nodeId,
    ownerPrincipalId: runtime.principal.principalId,
    createdByPrincipalId: runtime.principal.principalId,
  });
}

function createBundle(input: {
  readonly paseoHome: string;
  readonly audit: Awaited<ReturnType<typeof createProductionRuntimeFixture>>["audit"];
  readonly profiles: Awaited<ReturnType<typeof prepareProductionBrowserProfileRegistry>>;
  readonly leaseId: string;
}): ProductionBrowserLeaseBundle {
  return createProductionBrowserLeaseBundle({
    paseoHome: input.paseoHome,
    nodeId: node.nodeId,
    downloadBaseRoot: path.join(input.paseoHome, "downloads"),
    profiles: input.profiles,
    auditSink: input.audit,
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    createLeaseId: () => input.leaseId,
    createRequestId: () => `request-${input.leaseId}`,
    maxLeaseTtlMs: LEASE_TTL_MS,
  });
}

describe.skipIf(process.platform !== "darwin")("production Browser Profile lease lifecycle", () => {
  test("rejects a pre-restart lease before reauthorization and preserves monotonic fencing", async () => {
    const paseoHome = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "paseo-browser-lease-restart-")),
    );
    let firstBundle: ProductionBrowserLeaseBundle | null = null;
    let secondBundle: ProductionBrowserLeaseBundle | null = null;
    let firstRuntime: ProductionAuthorizationRuntime | null = null;
    let secondRuntime: ProductionAuthorizationRuntime | null = null;
    let firstUnbind: (() => void) | null = null;
    let secondUnbind: (() => void) | null = null;

    try {
      const firstProfiles = await prepareProductionBrowserProfileRegistry({
        paseoHome,
        nodeId: node.nodeId,
        downloadBaseRoot: path.join(paseoHome, "downloads"),
        createId: () => PROFILE_ID,
      });
      const profile = await firstProfiles.create({
        organizationId: principal.organizationId,
        homeNodeId: node.nodeId,
        businessIdentityId: "bid_1212121212121212",
        ownerPrincipalId: principal.principalId,
        platform: "generic",
        businessAccountKey: "restart-evidence-account",
        label: "Restart evidence profile",
        expectedIdentity: { hostnames: ["account.example"] },
        status: "ready",
      });
      const firstFixture = await createProductionRuntimeFixture("browser-lease-restart-first", {
        grants,
        browserProfiles: firstProfiles,
      });
      firstRuntime = firstFixture.runtime;
      registerAgent(firstRuntime, firstFixture.provider);
      const firstRegistry = createEnterpriseAgentSessionContextRegistry();
      const firstHandle = bindAgentHandle({ runtime: firstRuntime, registry: firstRegistry });
      firstBundle = createBundle({
        paseoHome,
        audit: firstFixture.audit,
        profiles: firstProfiles,
        leaseId: "lea_12121212-1212-4121-8121-121212121212",
      });
      await Promise.all([
        firstBundle.profiles.initialize(),
        firstBundle.bindings.initialize(),
        firstBundle.leases.initialize(),
      ]);
      const workspace = await firstRuntime.resourceAuthorization.assertWorkspace(
        firstRuntime.principal,
        "workspace.metadata.read",
        WORKSPACE_ID,
      );
      const authorizedProfile = await firstRuntime.resourceAuthorization.assertBrowserProfile(
        firstRuntime.principal,
        "browser.use",
        profile.browserProfileId,
      );
      await firstBundle.bindings.bind({
        workspace,
        profile: authorizedProfile,
        actor: firstRuntime.principal,
      });
      const firstAuthority = bindProductionAuthority({
        bundle: firstBundle,
        runtime: firstRuntime,
        registry: firstRegistry,
      });
      firstUnbind = firstAuthority.unbind;
      const oldLease = await firstBundle.leases.acquire({
        handle: firstHandle,
        resourceId: profile.browserProfileId,
        mode: "write",
        ttlMs: LEASE_TTL_MS,
      });
      expect(oldLease).toMatchObject({
        holderAgentId: AGENT_ID,
        holderPrincipalId: principal.principalId,
        resourceId: PROFILE_ID,
        fencingToken: 1,
        leaseRevision: "1:1",
      });
      expect(firstAuthority.resolutionCount()).toBeGreaterThan(0);

      firstUnbind();
      firstUnbind = null;
      await firstBundle.close();
      firstBundle = null;
      await firstRuntime.release();
      firstRuntime = null;

      const restartedProfiles = await prepareProductionBrowserProfileRegistry({
        paseoHome,
        nodeId: node.nodeId,
        downloadBaseRoot: path.join(paseoHome, "downloads"),
      });
      const secondFixture = await createProductionRuntimeFixture("browser-lease-restart-second", {
        grants,
        browserProfiles: restartedProfiles,
      });
      secondRuntime = secondFixture.runtime;
      registerAgent(secondRuntime, secondFixture.provider);
      const secondRegistry = createEnterpriseAgentSessionContextRegistry();
      const secondHandle = bindAgentHandle({ runtime: secondRuntime, registry: secondRegistry });
      secondBundle = createBundle({
        paseoHome,
        audit: secondFixture.audit,
        profiles: restartedProfiles,
        leaseId: "lea_34343434-3434-4343-8343-343434343434",
      });
      await Promise.all([
        secondBundle.profiles.initialize(),
        secondBundle.bindings.initialize(),
        secondBundle.leases.initialize(),
      ]);
      const secondAuthority = bindProductionAuthority({
        bundle: secondBundle,
        runtime: secondRuntime,
        registry: secondRegistry,
      });
      secondUnbind = secondAuthority.unbind;
      const authorizationCallsBeforeReplay = secondAuthority.resolutionCount();
      const auditBeforeReplay = await secondFixture.audit.snapshotEvents();

      await expect(
        secondBundle.leases.validateLease({ handle: secondHandle, lease: oldLease }),
      ).rejects.toThrow("Lease is expired or inactive.");
      expect(secondAuthority.resolutionCount()).toBe(authorizationCallsBeforeReplay);
      await expect(secondFixture.audit.snapshotEvents()).resolves.toEqual(auditBeforeReplay);

      const newLease = await secondBundle.leases.acquire({
        handle: secondHandle,
        resourceId: PROFILE_ID,
        mode: "write",
        ttlMs: LEASE_TTL_MS,
      });
      expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
      expect(newLease.leaseRevision).toBe("2:1");
      expect(newLease.leaseId).not.toBe(oldLease.leaseId);
      expect(secondAuthority.resolutionCount()).toBeGreaterThan(authorizationCallsBeforeReplay);
      const auditAfterNewLease = await secondFixture.audit.snapshotEvents();
      expect(auditAfterNewLease.slice(auditBeforeReplay.length)).toMatchObject([
        {
          action: "enterprise.resource.browser_profile_lease",
          actorPrincipalId: principal.principalId,
          agentId: AGENT_ID,
          outcome: "allowed",
          reasonCode: "lease_acquired",
          resource: { kind: "browser_profile_lease", id: PROFILE_ID },
          workspaceId: WORKSPACE_ID,
        },
      ]);
    } finally {
      secondUnbind?.();
      firstUnbind?.();
      await secondBundle?.close();
      await firstBundle?.close();
      await secondRuntime?.release();
      await firstRuntime?.release();
      await closeProductionRuntimeFixture();
      await rm(paseoHome, { recursive: true, force: true });
    }
  }, 60_000);
});
