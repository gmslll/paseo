import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hash } from "bcryptjs";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ConnectionContext } from "@getpaseo/protocol/messages";
import { createPaseoDaemon, type PaseoDaemonConfig } from "./bootstrap.js";
import {
  createProductionEnterpriseRuntimeFactory,
  provisionProductionEnterpriseInitialAdminFromHome,
} from "./enterprise/production-runtime-factory.js";
import {
  createProductionAuditRuntime,
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./enterprise/audit/production-audit-runtime.js";
import {
  createProductionBrowserLeaseBundle,
  type ProductionBrowserLeaseBundle,
} from "./enterprise/browser/production-bundle.js";
import { createProductionEnterpriseBrowserProfileContentReadSource } from "./enterprise/browser/content-source.js";
import { createProductionEnterpriseWorkspaceFilesProvider } from "./enterprise/runtime/production-workspace-files-runtime-provider.js";
import { getOrCreateServerId } from "./server-id.js";

const exec = promisify(execFile);
const organizationId = "org_aaaaaaaaaaaaaaaa" as const;
const principalId = "usr_aaaaaaaaaaaaaaaa" as const;
const nodeId = "nod_aaaaaaaaaaaaaaaa" as const;
const connection: ConnectionContext = {
  node: { nodeId, paseoServerId: "srv_browser_shutdown", mode: "standalone" },
  transport: "direct",
  peer: "loopback",
};

describe.runIf(process.platform === "darwin")("enterprise browser shutdown", () => {
  let addonDirectory: string;
  let auditAddonPath: string;
  let workspaceAddonPath: string;

  beforeAll(async () => {
    addonDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-shutdown-addon-"));
    auditAddonPath = path.join(addonDirectory, "darwin-audit-fs.node");
    workspaceAddonPath = path.join(addonDirectory, "darwin-workspace-fs.node");
    await exec(process.execPath, [
      fileURLToPath(
        new URL("./enterprise/audit/native/build-darwin-audit-fs.mjs", import.meta.url),
      ),
      "--output",
      auditAddonPath,
    ]);
    await exec(process.execPath, [
      fileURLToPath(
        new URL("./enterprise/runtime/native/build-darwin-workspace-fs.mjs", import.meta.url),
      ),
      "--output",
      workspaceAddonPath,
    ]);
  });

  afterAll(async () => {
    await rm(addonDirectory, { recursive: true, force: true });
  });

  test("daemon stop closes the production browser bundle once before runtime and audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-shutdown-"));
    const staticDir = path.join(root, "static");
    await mkdir(staticDir, { recursive: true });
    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome: path.join(root, ".paseo"),
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(root, ".paseo", "agents"),
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
      enterpriseMultiUser: {
        enabled: true,
        organizationId,
        nodeId,
        managementMode: "standalone",
        legacyRecords: "owner_only",
      },
    };
    const daemonPassword = await hash("break-glass", 4);
    let audit: ProductionAuditCapability | undefined;
    const order: string[] = [];
    let browserClose: ReturnType<typeof vi.fn> | undefined;
    let browserContentSourceCreates = 0;
    try {
      const paseoServerId = getOrCreateServerId(config.paseoHome, {
        logger: pino({ level: "silent" }),
      });
      await provisionProductionEnterpriseInitialAdminFromHome(
        {
          paseoHome: config.paseoHome,
          enterpriseConfig: config.enterpriseMultiUser,
          paseoServerId,
          daemonPasswordHash: daemonPassword,
          bootstrapPassword: "break-glass",
          principalId,
          displayName: "Shutdown test administrator",
        },
        {
          issueAudit: (options) =>
            createProductionAuditRuntime({ ...options, nativeAddonPath: auditAddonPath }),
        },
      );
      audit = await createProductionAuditRuntime({
        paseoHome: config.paseoHome,
        node: { ...connection.node, paseoServerId },
        auditRoot: path.join(config.paseoHome, "enterprise", "audit"),
        nativeAddonPath: auditAddonPath,
      });
      const runtimeFactory = createProductionEnterpriseRuntimeFactory({
        paseoHome: config.paseoHome,
        daemonPassword: "break-glass",
      });
      const daemon = await createPaseoDaemon(config, pino({ level: "silent" }), {
        issueProductionAuditCapability: async () => audit!,
        createEnterpriseAdmissionRuntime: async (input) => {
          const runtime = await runtimeFactory(input);
          return {
            ...runtime,
            close: async () => {
              expect(productionAuditCapabilityIssuer.current(audit!)).toBe(true);
              order.push("runtime");
              await runtime.close?.();
            },
          };
        },
        createEnterpriseWorkspaceFilesProvider: ({ workspaceRoots }) =>
          createProductionEnterpriseWorkspaceFilesProvider({
            workspaceRoots,
            nativeAddonPath: workspaceAddonPath,
          }),
        createProductionBrowserLeaseBundle: (input) => {
          const bundle = createProductionBrowserLeaseBundle(input);
          const close = vi.fn(async () => {
            expect(productionAuditCapabilityIssuer.current(audit!)).toBe(true);
            order.push("browser");
            await bundle.close();
          });
          browserClose = close;
          return { ...bundle, close } satisfies ProductionBrowserLeaseBundle;
        },
        createProductionBrowserProfileContentReadSource: () => {
          browserContentSourceCreates += 1;
          return createProductionEnterpriseBrowserProfileContentReadSource({
            addonPath: workspaceAddonPath,
          });
        },
      });
      await daemon.start();
      await expect(daemon.stop()).resolves.toBeUndefined();
      await expect(daemon.stop()).resolves.toBeUndefined();
      expect(order).toEqual(["browser", "runtime"]);
      expect(browserClose).toHaveBeenCalledOnce();
      expect(browserContentSourceCreates).toBe(1);
      expect(productionAuditCapabilityIssuer.current(audit!)).toBe(false);
    } finally {
      await audit?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
