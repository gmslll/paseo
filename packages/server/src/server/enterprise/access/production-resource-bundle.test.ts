import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext } from "@getpaseo/protocol/messages";
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
import { createProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";

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
        const bundle = await createProductionResourceBundle({
          provider,
          workspaceRegistry: registry,
          nodeId,
        });
        expect(bundle).not.toBeNull();
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
      } finally {
        await audit.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
