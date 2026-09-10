import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import { createProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import { provisionProductionGrant } from "./production-grant-provisioner.js";

const execFileAsync = promisify(execFile);
const nodeId = "nod_0123456789abcdef" as const;
const organizationId = "org_0123456789abcdef" as const;
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId,
  credentialId: "cred_provision",
  grantVersion: "pending",
  grants: [],
};
const node: NodeContext = { nodeId, paseoServerId: "srv_provision", mode: "standalone" };

describe("production grant provisioner", () => {
  test("rejects structural providers and exact mismatches without touching a store", async () => {
    await expect(
      provisionProductionGrant({
        provider: { grantStore: {}, owners: {} },
        principal,
        organizationId,
        grants: [],
      }),
    ).resolves.toBeNull();
    await expect(
      provisionProductionGrant({ provider: {}, principal, organizationId, grants: [] }),
    ).resolves.toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "creates once, restores exact record, rejects conflict and fails closed after audit invalidation",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-provision-"));
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
        const first = await provisionProductionGrant({
          provider: provider!,
          principal,
          organizationId,
          grants: [],
        });
        expect(first).toMatchObject({ principalId: principal.principalId, organizationId });
        expect(first?.grantVersion).toMatch(/^grv_/);
        await expect(
          provisionProductionGrant({ provider: provider!, principal, organizationId, grants: [] }),
        ).resolves.toEqual(first);
        await expect(
          provisionProductionGrant({
            provider: provider!,
            principal: { ...principal, organizationId: "org_abcdef0123456789" },
            organizationId,
            grants: [],
          }),
        ).resolves.toBeNull();
        await audit.close();
        await expect(
          provisionProductionGrant({ provider: provider!, principal, organizationId, grants: [] }),
        ).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
