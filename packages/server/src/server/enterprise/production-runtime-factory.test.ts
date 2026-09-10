import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ConnectionContext } from "@getpaseo/protocol/messages";
import { FileBackedGrantStorage } from "./access/grant-store.js";
import {
  createProductionAuditRuntime,
  type ProductionAuditCapability,
} from "./audit/production-audit-runtime.js";
import { EnterpriseAdmission } from "./identity/admission.js";
import type { EnterpriseAdmissionRuntime } from "./identity/runtime.js";
import {
  createProductionEnterpriseRuntimeFactory,
  createProductionIdentityDispatcherRegistration,
  provisionProductionEnterpriseInitialAdminFromHome,
  resolveProductionBrowserProfileRegistry,
} from "./production-runtime-factory.js";

const executeFile = promisify(execFile);
const organizationId = "org_aaaaaaaaaaaaaaaa" as const;
const principalId = "usr_aaaaaaaaaaaaaaaa" as const;
const nodeId = "nod_aaaaaaaaaaaaaaaa" as const;
const appSlotId = "aps_aaaaaaaaaaaaaaaa" as const;
const connection: ConnectionContext = {
  node: { nodeId, paseoServerId: "srv_production_factory", mode: "standalone" },
  transport: "direct",
  peer: "loopback",
};
const config = {
  enabled: true as const,
  organizationId,
  nodeId,
  managementMode: "standalone" as const,
  legacyRecords: "owner_only" as const,
};

describe.runIf(process.platform === "darwin")("production enterprise runtime factory", () => {
  let addonDirectory: string;
  let addonPath: string;

  beforeAll(async () => {
    addonDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-production-factory-addon-"));
    addonPath = path.join(addonDirectory, "darwin-audit-fs.node");
    await executeFile(process.execPath, [
      fileURLToPath(new URL("./audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      addonPath,
    ]);
  });

  afterAll(async () => {
    await rm(addonDirectory, { recursive: true, force: true });
  });

  test("provisions a cold home with one authority graph and restores the issued administrator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-production-provision-once-"));
    const daemonPassword = await hash("break-glass", 4);
    let restoredAudit: ProductionAuditCapability | undefined;
    try {
      const provision = () =>
        provisionProductionEnterpriseInitialAdminFromHome(
          {
            paseoHome: root,
            enterpriseConfig: config,
            paseoServerId: connection.node.paseoServerId,
            daemonPasswordHash: daemonPassword,
            bootstrapPassword: "break-glass",
            principalId,
            displayName: "Initial administrator",
          },
          {
            issueAudit: (options) =>
              createProductionAuditRuntime({ ...options, nativeAddonPath: addonPath }),
          },
        );
      const first = await provision();
      expect(first).toMatchObject({
        principalId,
        alreadyProvisioned: false,
        token: expect.any(String),
      });
      const second = await provision();
      expect(second).toEqual({
        principalId,
        credentialId: first.credentialId,
        alreadyProvisioned: true,
      });

      restoredAudit = await issueAudit(root);
      const runtime = await createProductionEnterpriseRuntimeFactory({
        paseoHome: root,
        daemonPassword,
      })({ config, audit: restoredAudit });
      await expect(runtime.admission.authenticate(first.token!, connection)).resolves.toMatchObject(
        {
          principalId,
          organizationId,
        },
      );
    } finally {
      await restoredAudit?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores one authority graph and fans committed revocation into live Sessions", async () => {
    const root = await createStorage();
    const daemonPassword = await hash("break-glass", 4);
    let audit: ProductionAuditCapability | undefined;
    let restartedAudit: ProductionAuditCapability | undefined;
    let runtime: EnterpriseAdmissionRuntime | undefined;
    let restarted: EnterpriseAdmissionRuntime | undefined;
    try {
      audit = await issueAudit(root);
      const factory = createProductionEnterpriseRuntimeFactory({
        paseoHome: root,
        daemonPassword,
      });
      runtime = await factory({ config, audit });
      expect(runtime.authorizationRuntimeProvider?.grantStore).toBeDefined();
      expect(runtime.admissionInvalidationSink).toBeDefined();
      expect(runtime.admission).toBeInstanceOf(EnterpriseAdmission);
      expect(
        createProductionIdentityDispatcherRegistration({
          admission: runtime.admission,
          audit,
          provider: runtime.authorizationRuntimeProvider!,
        }),
      ).not.toBeNull();
      if (!(runtime.admission instanceof EnterpriseAdmission)) throw new Error("wrong admission");
      const owner = await runtime.admission.authenticate("break-glass", connection);
      expect(owner?.principalType).toBe("break_glass_owner");
      const issued = await runtime.admission.registry.issueToken({
        actor: owner!,
        principalId,
        organizationId,
      });
      const principal = await runtime.admission.authenticate(issued.token, connection);
      expect(principal).toMatchObject({ principalId, organizationId, grantVersion: "grv_1" });
      expect(runtime.grantVersionGuard.isCurrent(principal!)).toBe(true);
      const browserProfiles = resolveProductionBrowserProfileRegistry({
        admission: runtime.admission,
        audit,
        provider: runtime.authorizationRuntimeProvider!,
      });
      expect(browserProfiles).not.toBeNull();
      const browserProfile = await browserProfiles!.create({
        organizationId,
        homeNodeId: nodeId,
        businessIdentityId: "bid_1111111111111111",
        ownerPrincipalId: principalId,
        platform: "generic",
        businessAccountKey: "production-factory-account",
        label: "Production factory profile",
        status: "ready",
      });
      await expect(
        runtime.resourceAuthorization.assertBrowserProfile(
          principal!,
          "browser.use",
          browserProfile.browserProfileId,
        ),
      ).resolves.toMatchObject({ browserProfileId: browserProfile.browserProfileId });
      await expect(
        runtime.resourceAuthorization.assertAppSlot(principal!, "app.use", appSlotId),
      ).resolves.toMatchObject({ appSlotId });
      const identityRegistration = createProductionIdentityDispatcherRegistration({
        admission: runtime.admission,
        audit,
        provider: runtime.authorizationRuntimeProvider!,
      });
      const enterpriseContext = Object.freeze({
        principal: principal!,
        node: runtime.node,
        sessionBindingGeneration: "identity-generation",
      });
      const identityLease = identityRegistration!.open({
        sessionId: "identity-session",
        clientId: "identity-client",
        context: enterpriseContext,
      });
      const dispatchContext = Object.freeze({
        sessionId: "identity-session",
        clientId: "identity-client",
        credentialId: principal!.credentialId,
        sessionBindingGeneration: "identity-generation",
        enterpriseContext,
      });
      await expect(
        identityLease.dispatcher.handle({
          sessionContext: dispatchContext,
          message: { type: "enterprise.identity.get_current.request", requestId: "identity-1" },
        }),
      ).resolves.toMatchObject({ type: "enterprise.identity.get_current.response" });
      await expect(
        identityLease.dispatcher.handle({
          sessionContext: dispatchContext,
          message: { type: "enterprise.identity.list_principals.request", requestId: "identity-2" },
        }),
      ).resolves.toMatchObject({
        type: "enterprise.identity.list_principals.response",
        payload: { principals: [{ principalId, status: "active" }] },
      });
      await identityLease.close();
      await expect(
        identityLease.dispatcher.handle({
          sessionContext: dispatchContext,
          message: { type: "enterprise.identity.get_current.request", requestId: "identity-3" },
        }),
      ).resolves.toBe(false);

      await runtime.close?.();
      await audit.close();
      restartedAudit = await issueAudit(root);
      restarted = await factory({ config, audit: restartedAudit });
      expect(restarted.admission).toBeInstanceOf(EnterpriseAdmission);
      if (!(restarted.admission instanceof EnterpriseAdmission)) throw new Error("wrong admission");
      const restoredPrincipal = await restarted.admission.authenticate(issued.token, connection);
      expect(restoredPrincipal).toMatchObject({ principalId, organizationId });
      const invalidate = vi.fn(async () => undefined);
      const unsubscribe = restarted.admissionInvalidationSink!.register({
        sessionBindingKey: "binding-current",
        generation: "generation-current",
        credentialId: issued.credentialId,
        principalId,
        organizationId,
        grantVersion: "grv_1",
        invalidate,
      });
      const restartedOwner = await restarted.admission.authenticate("break-glass", connection);
      await expect(
        restarted.admission.registry.revokeCredential(restartedOwner!, issued.credentialId),
      ).resolves.toBe(true);
      expect(invalidate).toHaveBeenCalledOnce();
      expect(invalidate).toHaveBeenCalledWith({
        sessionBindingKey: "binding-current",
        sessionBindingGeneration: "generation-current",
      });
      await expect(restarted.admission.authenticate(issued.token, connection)).resolves.toBeNull();
      unsubscribe();
    } finally {
      await runtime?.close?.().catch(() => undefined);
      await restarted?.close?.().catch(() => undefined);
      await audit?.close().catch(() => undefined);
      await restartedAudit?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing principal metadata and mismatched Grant state before returning", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-production-missing-"));
    const mismatchRoot = await createStorage("org_bbbbbbbbbbbbbbbb");
    let missingAudit: ProductionAuditCapability | undefined;
    let mismatchAudit: ProductionAuditCapability | undefined;
    try {
      missingAudit = await issueAudit(missingRoot);
      await expect(
        createProductionEnterpriseRuntimeFactory({ paseoHome: missingRoot })({
          config,
          audit: missingAudit,
        }),
      ).rejects.toThrow();
      mismatchAudit = await issueAudit(mismatchRoot);
      await expect(
        createProductionEnterpriseRuntimeFactory({ paseoHome: mismatchRoot })({
          config,
          audit: mismatchAudit,
        }),
      ).rejects.toThrow("metadata and GrantStore do not match");
    } finally {
      await missingAudit?.close().catch(() => undefined);
      await mismatchAudit?.close().catch(() => undefined);
      await rm(missingRoot, { recursive: true, force: true });
      await rm(mismatchRoot, { recursive: true, force: true });
    }
  });

  async function createStorage(grantOrganizationId = organizationId): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-production-factory-"));
    await chmod(root, 0o700);
    const enterpriseRoot = path.join(root, "enterprise");
    await mkdir(enterpriseRoot, { mode: 0o700 });
    await writeFile(
      path.join(enterpriseRoot, "principals.json"),
      JSON.stringify({
        version: 1,
        principals: {
          [principalId]: {
            principalId,
            organizationId,
            principalType: "human",
            status: "active",
            createdAt: "2026-09-10T00:00:00.000Z",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        },
      }),
      { mode: 0o600 },
    );
    await new FileBackedGrantStorage(path.join(enterpriseRoot, "grants.json")).put({
      principalId,
      organizationId: grantOrganizationId,
      grants: [
        {
          action: "browser.use",
          selector: { kind: "organization", organizationId: grantOrganizationId },
        },
        {
          action: "app.use",
          selector: { kind: "organization", organizationId: grantOrganizationId },
        },
      ],
      grantVersion: "grv_1",
    });
    await writeFile(
      path.join(enterpriseRoot, "app-slots.json"),
      JSON.stringify({
        version: 1,
        records: [
          {
            appSlotId,
            organizationId,
            nodeId,
            businessIdentityId: "bid_aaaaaaaaaaaaaaaa",
            appBundleId: "com.example.production",
            accountBindingKey: "production-account",
            ownerPrincipalId: principalId,
            concurrency: 1,
            credentialRef: "keychain://production-app-slot",
            status: "ready",
          },
        ],
      }),
      { mode: 0o600 },
    );
    return root;
  }

  async function issueAudit(root: string): Promise<ProductionAuditCapability> {
    return createProductionAuditRuntime({
      node: connection.node,
      auditRoot: path.join(root, "enterprise", "audit"),
      nativeAddonPath: addonPath,
    });
  }
});
