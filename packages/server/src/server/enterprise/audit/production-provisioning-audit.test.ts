import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createProductionAuditRuntime,
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./production-audit-runtime.js";
import { provisionProductionEnterpriseInitialAdminFromHome } from "../production-runtime-factory.js";

const executeFile = promisify(execFile);
const enabled = process.platform === "darwin";

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(full)));
    else files.push(full);
  }
  return files;
}

describe.runIf(enabled)("production break-glass provisioning audit evidence", () => {
  let addonDirectory = "";
  let addonPath = "";

  beforeAll(async () => {
    addonDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-provision-audit-addon-"));
    addonPath = path.join(addonDirectory, "darwin-audit-fs.node");
    await executeFile(process.execPath, [
      fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      addonPath,
    ]);
  });

  afterAll(async () => {
    await rm(addonDirectory, { recursive: true, force: true });
  });

  test("writes required credential audit and never persists the bootstrap secret canary", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-provision-audit-"));
    const bootstrapPassword = "break-glass-secret-canary";
    const daemonPasswordHash = await hash(bootstrapPassword, 4);
    const organizationId = "org_aaaaaaaaaaaaaaaa";
    const principalId = "usr_aaaaaaaaaaaaaaaa";
    let issuedAudit: ProductionAuditCapability | undefined;
    try {
      const result = await provisionProductionEnterpriseInitialAdminFromHome(
        {
          paseoHome,
          enterpriseConfig: {
            enabled: true,
            organizationId,
            nodeId: "nod_aaaaaaaaaaaaaaaa",
            managementMode: "standalone",
            legacyRecords: "owner_only",
          },
          paseoServerId: "srv_provision_audit",
          daemonPasswordHash,
          bootstrapPassword,
          principalId,
          displayName: "Initial administrator",
        },
        {
          issueAudit: async (options) => {
            issuedAudit = await createProductionAuditRuntime({
              ...options,
              nativeAddonPath: addonPath,
            });
            return issuedAudit;
          },
        },
      );
      expect(result).toMatchObject({
        principalId,
        alreadyProvisioned: false,
        token: expect.any(String),
      });
      expect(result.token).not.toContain(bootstrapPassword);
      const issuedToken = result.token;
      if (!issuedToken) throw new Error("expected initial credential token");
      await issuedAudit?.close();
      issuedAudit = undefined;

      const restored = await createProductionAuditRuntime({
        node: {
          nodeId: "nod_aaaaaaaaaaaaaaaa",
          paseoServerId: "srv_provision_audit",
          mode: "standalone",
        },
        auditRoot: path.join(paseoHome, "enterprise", "audit"),
        nativeAddonPath: addonPath,
      });
      const events = await restored.snapshotEvents();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "identity.break_glass.use",
            actorPrincipalId: "owner",
            outcome: "allowed",
            organizationId,
            priority: "high",
          }),
          expect.objectContaining({
            action: "identity.credential.issue",
            outcome: "allowed",
            organizationId,
          }),
        ]),
      );
      const serialized = (
        await Promise.all((await filesUnder(paseoHome)).map((file) => readFile(file, "utf8")))
      ).join("\n");
      expect(serialized).not.toContain(bootstrapPassword);
      expect(serialized).not.toContain(issuedToken);
      expect(JSON.stringify(events)).not.toContain(bootstrapPassword);
      expect(JSON.stringify(events)).not.toContain(issuedToken);
      await restored.close();
      expect(productionAuditCapabilityIssuer.current(restored)).toBe(false);
    } finally {
      await issuedAudit?.close().catch(() => undefined);
      await rm(paseoHome, { recursive: true, force: true });
    }
  }, 30_000);
});
