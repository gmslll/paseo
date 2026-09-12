import { access, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import { productionAuditCapabilityIssuer } from "./enterprise/audit/production-audit-runtime.js";

const logger = { child: () => logger } as never;

test("invalid paseoHome fails before enterprise issuer or factory", async () => {
  const issue = vi.fn();
  const factory = vi.fn();
  const config = {
    paseoHome: "",
    enterpriseMultiUser: { enabled: true },
  } as unknown as PaseoDaemonConfig;
  await expect(
    createPaseoDaemon(config, logger, {
      issueProductionAuditCapability: issue,
      createEnterpriseAdmissionRuntime: factory,
    }),
  ).rejects.toThrow("paseoHome must be a non-empty string");
  expect(issue).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
});

describe.runIf(process.platform === "darwin")("enterprise audit bootstrap snapshot", () => {
  let buildDirectory: string;
  let addonPath: string;
  const execute = promisify(execFile);
  beforeAll(async () => {
    buildDirectory = await mkdtemp(path.join(os.tmpdir(), "bootstrap-audit-addon-"));
    addonPath = path.join(buildDirectory, "audit.node");
    await execute(process.execPath, [
      fileURLToPath(
        new URL("./enterprise/audit/native/build-darwin-audit-fs.mjs", import.meta.url),
      ),
      "--output",
      addonPath,
    ]);
  });
  afterAll(async () => {
    await rm(buildDirectory, { recursive: true, force: true });
  });

  test("invalid enterprise snapshot fails before issuer", async () => {
    const issue = vi.fn();
    const factory = vi.fn();
    const config = {
      paseoHome: "/tmp/paseo-enterprise-test",
      enterpriseMultiUser: { enabled: true, organizationId: "bad" },
    } as unknown as PaseoDaemonConfig;
    await expect(
      createPaseoDaemon(config, logger, {
        issueProductionAuditCapability: issue,
        createEnterpriseAdmissionRuntime: factory,
      }),
    ).rejects.toThrow();
    expect(issue).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  test("issues managed audit authority with the configured node mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-managed-audit-"));
    let issuedAudit: unknown;
    const issue = vi.fn(
      async (input: {
        node: {
          nodeId: string;
          paseoServerId: string;
          mode: "standalone" | "managed";
        };
        auditRoot: string;
      }) => {
        expect(input.node).toMatchObject({
          nodeId: "nod_0123456789abcdef",
          mode: "managed",
        });
        issuedAudit = await productionAuditCapabilityIssuer.issue({
          ...input,
          nativeAddonPath: addonPath,
        });
        return issuedAudit;
      },
    );
    const factory = vi.fn(async (input: { audit: unknown }) => {
      expect(productionAuditCapabilityIssuer.requireCurrent(input.audit).node.mode).toBe("managed");
      throw new Error("managed factory sentinel");
    });

    await expect(
      createPaseoDaemon(
        {
          paseoHome: root,
          enterpriseMultiUser: {
            enabled: true,
            organizationId: "org_0123456789abcdef",
            nodeId: "nod_0123456789abcdef",
            managementMode: "managed",
            legacyRecords: "owner_only",
            management: {
              baseUrl: "https://management.test:17443",
              caCertificatePath: path.join(root, "management-ca.pem"),
              relationshipPath: path.join(root, "relationship.json"),
            },
          },
        },
        logger,
        {
          issueProductionAuditCapability: issue,
          createEnterpriseAdmissionRuntime: factory as never,
        },
      ),
    ).rejects.toThrow("managed factory sentinel");
    expect(issue).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(() => productionAuditCapabilityIssuer.requireCurrent(issuedAudit)).toThrow();
    await rm(root, { recursive: true, force: true });
  });

  test("deferred issue uses the first frozen snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bootstrap-enterprise-"));
    const attackerRoot = path.join(root, "attacker");
    const firstNode = {
      nodeId: "nod_0123456789abcdef",
      paseoServerId: "srv-test",
      mode: "standalone" as const,
    };
    const firstEnterprise = {
      enabled: true as const,
      organizationId: "org_0123456789abcdef",
      nodeId: firstNode.nodeId,
      managementMode: "standalone" as const,
      legacyRecords: "owner_only" as const,
    };
    const expectedEnterprise = structuredClone(firstEnterprise);
    const reads = { paseoHome: 0, enterpriseMultiUser: 0, factory: 0, issue: 0 };
    let gate!: () => void;
    const entered = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let issuedAudit: unknown;
    const issue = vi.fn(async (input: { node: typeof firstNode; auditRoot: string }) => {
      reads.issue++;
      expect(input.node.nodeId).toBe(firstNode.nodeId);
      expect(input.node.mode).toBe("standalone");
      expect(typeof input.node.paseoServerId).toBe("string");
      expect(input.auditRoot).toBe(path.join(root, "enterprise", "audit"));
      gate();
      await blocked;
      issuedAudit = await productionAuditCapabilityIssuer.issue({
        ...input,
        nativeAddonPath: addonPath,
      });
      return issuedAudit;
    });
    const factory = vi.fn(async (input: { config: typeof firstEnterprise; audit: unknown }) => {
      reads.factory++;
      expect(input.config).toEqual(expectedEnterprise);
      expect(Object.isFrozen(input.config)).toBe(true);
      expect(input.audit).toBe(issuedAudit);
      throw new Error("factory sentinel");
    });
    const config = new Proxy(
      { paseoHome: root, enterpriseMultiUser: firstEnterprise } as PaseoDaemonConfig,
      {
        get(target, key, receiver) {
          if (key === "paseoHome") {
            reads.paseoHome++;
            return reads.paseoHome === 1 ? root : attackerRoot;
          }
          if (key === "enterpriseMultiUser") {
            reads.enterpriseMultiUser++;
            return firstEnterprise;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const pending = createPaseoDaemon(config, logger, {
      issueProductionAuditCapability: issue,
      createEnterpriseAdmissionRuntime: factory as never,
    });
    await entered;
    (firstEnterprise as { organizationId: string }).organizationId = "org_attacker";
    firstNode.nodeId = "nod_attacker";
    release();
    await expect(pending).rejects.toThrow("factory sentinel");
    expect(issue).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    expect(reads).toEqual({ paseoHome: 1, enterpriseMultiUser: 1, factory: 1, issue: 1 });
    expect(() => productionAuditCapabilityIssuer.requireCurrent(issuedAudit)).toThrow();
    let attackerExists = true;
    try {
      await access(attackerRoot);
    } catch {
      attackerExists = false;
    }
    expect(attackerExists).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
