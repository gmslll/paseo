import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext } from "@getpaseo/protocol/messages";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import {
  createProductionOrganizationResourceSource,
  createProductionPlacementResolver,
  createProductionResourceBundle,
} from "./production-resource-bundle.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  createProductionPrincipalGrantSource,
  createProductionPrincipalProvisioning,
} from "../identity/principal-source.js";
import { createProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import { getAuthoritativeWorkspace } from "./owner-registry.js";

const nodeId = "nod_0123456789abcdef" as const;
const organizationId = "org_0123456789abcdef" as const;
const execFileAsync = promisify(execFile);
const node: NodeContext = {
  nodeId,
  paseoServerId: "srv_resource_bundle",
  mode: "standalone",
};

describe("production resource bundle ports", () => {
  test("placement resolves only live records from the real file-backed registry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-placement-"));
    try {
      const registry = new FileBackedWorkspaceRegistry(
        path.join(root, "workspaces.json"),
        createTestLogger(),
      );
      await registry.initialize();
      const record = createPersistedWorkspaceRecord({
        workspaceId: "workspace-a",
        projectId: "project-a",
        cwd: "/tmp/workspace-a",
        kind: "directory",
        displayName: "Workspace A",
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      });
      await registry.upsert({
        ...record,
        organizationId,
        nodeId,
        ownerPrincipalId: "usr_0123456789abcdef",
        createdByPrincipalId: "usr_0123456789abcdef",
      });
      const resolver = createProductionPlacementResolver({ workspaceRegistry: registry, nodeId });
      expect(resolver).not.toBeNull();
      await expect(resolver?.resolveWorkspace("workspace-a")).resolves.toEqual({
        organizationId,
        nodeId,
        resourceKind: "workspace",
        localResourceId: "workspace-a",
      });
      await expect(resolver?.resolveWorkspace("missing")).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects missing or structural registries and providers", () => {
    expect(createProductionPlacementResolver({ workspaceRegistry: {}, nodeId })).toBeNull();
    expect(
      createProductionOrganizationResourceSource({
        provider: { grantStore: {}, owners: {} },
        workspaceRegistry: {},
        nodeId,
      }),
    ).toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "builds only from the current provider and real persisted workspace registry",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-bundle-"));
      const addonPath = path.join(root, "darwin-audit-fs.node");
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
      const audit = await createProductionAuditRuntime({
        node,
        auditRoot: path.join(root, "audit"),
        nativeAddonPath: addonPath,
      });
      try {
        const provider = createProductionAuthorizationRuntimeProvider({
          audit,
          grantFilePath: path.join(root, "grants.json"),
        });
        expect(provider).not.toBeNull();
        if (!provider) throw new Error("expected provider");
        const newOwnerPrincipalId = "usr_1111111111111111";
        await provider.grantStore.update({
          actor: {
            principalType: "human",
            principalId: "usr_0123456789abcdef",
            organizationId,
            credentialId: "cred_resource_bundle",
            grantVersion: "grv_resource_bundle",
            grants: [],
          },
          principalId: newOwnerPrincipalId,
          organizationId,
          grants: [],
          expectedVersion: null,
        });
        const principalProvisioning = createProductionPrincipalProvisioning({
          filePath: path.join(root, "principals.json"),
          audit,
        });
        await principalProvisioning.ensurePrincipal({
          principalId: newOwnerPrincipalId,
          organizationId,
          principalType: "human",
          status: "active",
          createdAt: "2026-09-11T00:00:00.000Z",
          updatedAt: "2026-09-11T00:00:00.000Z",
        });
        const principalSource = createProductionPrincipalGrantSource({
          filePath: path.join(root, "principals.json"),
          grantStore: provider.grantStore,
          audit,
        });
        await principalSource.ready();
        const registry = new FileBackedWorkspaceRegistry(
          path.join(root, "workspaces.json"),
          createTestLogger(),
        );
        await registry.initialize();
        const record = createPersistedWorkspaceRecord({
          workspaceId: "workspace-bundle",
          projectId: "project-bundle",
          cwd: "/tmp/workspace-bundle",
          kind: "directory",
          displayName: "Bundle",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:00:00.000Z",
        });
        await registry.upsert({
          ...record,
          organizationId,
          nodeId,
          ownerPrincipalId: "usr_0123456789abcdef",
          createdByPrincipalId: "usr_0123456789abcdef",
        });
        const agentRecords: StoredAgentRecord[] = [];
        const bundle = await createProductionResourceBundle({
          provider,
          workspaceRegistry: registry,
          agentRecords: { list: () => agentRecords },
          nodeId,
        });
        expect(bundle).not.toBeNull();
        expect(bundle?.workspaceTransfers).toBeUndefined();
        await expect(bundle?.placement.resolveWorkspace("workspace-bundle")).resolves.toMatchObject(
          { localResourceId: "workspace-bundle" },
        );
        await expect(
          bundle?.organizationResources.list({
            organizationId,
            nodeId,
            resourceKinds: ["workspace"],
          }),
        ).resolves.toMatchObject({ resources: [{ workspaceId: "workspace-bundle" }] });
        const lateWorkspace = createPersistedWorkspaceRecord({
          workspaceId: "workspace-created-after-bundle",
          ownership: {
            organizationId,
            nodeId,
            ownerPrincipalId: "usr_0123456789abcdef",
            createdByPrincipalId: "usr_0123456789abcdef",
          },
          projectId: "project-created-after-bundle",
          cwd: "/tmp/workspace-created-after-bundle",
          kind: "directory",
          displayName: "Created after bundle",
          createdAt: "2026-09-10T00:02:00.000Z",
          updatedAt: "2026-09-10T00:02:00.000Z",
        });
        await registry.upsert(lateWorkspace);
        expect(getAuthoritativeWorkspace(provider.owners, lateWorkspace.workspaceId)).toMatchObject(
          {
            workspaceId: lateWorkspace.workspaceId,
            organizationId,
            nodeId,
            ownerPrincipalId: "usr_0123456789abcdef",
            createdByPrincipalId: "usr_0123456789abcdef",
          },
        );
        agentRecords.push({
          id: "agent-bundle",
          provider: "test",
          cwd: "/tmp/workspace-bundle",
          workspaceId: "workspace-bundle",
          organizationId,
          nodeId,
          ownerPrincipalId: "usr_0123456789abcdef",
          createdByPrincipalId: "usr_0123456789abcdef",
          createdAt: "2026-09-10T00:00:00.000Z",
          updatedAt: "2026-09-10T00:01:00.000Z",
          lastStatus: "running",
          config: null,
          labels: {},
          persistence: null,
        } as StoredAgentRecord);
        await expect(
          bundle?.organizationResources.list({
            organizationId,
            nodeId,
            resourceKinds: ["agent"],
          }),
        ).resolves.toMatchObject({
          resources: [{ agentId: "agent-bundle", workspaceId: "workspace-bundle" }],
        });
        const transferBundle = await createProductionResourceBundle({
          provider,
          workspaceRegistry: registry,
          agentRecords: { list: () => agentRecords },
          nodeId,
          audit,
          principalSource,
        });
        expect(transferBundle?.workspaceTransfers).toBeDefined();
        expect(transferBundle?.dispatcherFactory.manifest.operations).toContain(
          "enterprise.resource.ownership.transfer.request",
        );
        await expect(
          createProductionResourceBundle({
            provider,
            workspaceRegistry: registry,
            agentRecords: { list: () => agentRecords },
            nodeId,
            audit,
          }),
        ).resolves.toBeNull();
        bundle?.close();
        transferBundle?.close();
        const afterCloseWorkspace = createPersistedWorkspaceRecord({
          workspaceId: "workspace-after-close",
          ownership: {
            organizationId,
            nodeId,
            ownerPrincipalId: "usr_0123456789abcdef",
            createdByPrincipalId: "usr_0123456789abcdef",
          },
          projectId: "project-after-close",
          cwd: "/tmp/workspace-after-close",
          kind: "directory",
          displayName: "After close",
          createdAt: "2026-09-10T00:03:00.000Z",
          updatedAt: "2026-09-10T00:03:00.000Z",
        });
        await registry.upsert(afterCloseWorkspace);
        expect(
          getAuthoritativeWorkspace(provider.owners, afterCloseWorkspace.workspaceId),
        ).toBeNull();
      } finally {
        await audit.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
