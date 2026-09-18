import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import {
  defaultManagedNodeCapacity,
  enrollManagedNode,
  getOrCreateServerId,
  loadConfig,
  loadPersistedConfig,
  provisionProductionEnterpriseInitialAdminFromHome,
  resolveDaemonVersion,
  savePersistedConfig,
} from "@getpaseo/server";
import { resolveLocalDaemonState } from "../daemon/local-daemon.js";
import { createEnterpriseEnrollCommand, type EnterpriseEnrollDependencies } from "./enroll.js";
import { createEnterpriseInitCommand, type EnterpriseInitDependencies } from "./init.js";

export interface EnterpriseCommandDependencies {
  readonly init?: EnterpriseInitDependencies;
  readonly enroll?: EnterpriseEnrollDependencies;
}

export function createEnterpriseCommand(dependencies: EnterpriseCommandDependencies = {}): Command {
  return new Command("enterprise")
    .description("Manage local enterprise identity")
    .addCommand(
      createEnterpriseInitCommand(
        dependencies.init ?? createProductionEnterpriseInitDependencies(),
      ),
    )
    .addCommand(
      createEnterpriseEnrollCommand(
        dependencies.enroll ?? createProductionEnterpriseEnrollDependencies(),
      ),
    );
}

interface ProductionEnterpriseInitAdapterDependencies {
  readonly resolveState?: typeof resolveLocalDaemonState;
  readonly loadDaemonConfig?: typeof loadConfig;
  readonly resolveServerId?: typeof getOrCreateServerId;
  readonly provisionFromHome?: typeof provisionProductionEnterpriseInitialAdminFromHome;
}

export function createProductionEnterpriseInitDependencies(
  dependencies: ProductionEnterpriseInitAdapterDependencies = {},
): EnterpriseInitDependencies {
  const resolveState = dependencies.resolveState ?? resolveLocalDaemonState;
  const loadDaemonConfig = dependencies.loadDaemonConfig ?? loadConfig;
  const resolveServerId = dependencies.resolveServerId ?? getOrCreateServerId;
  const provisionFromHome =
    dependencies.provisionFromHome ?? provisionProductionEnterpriseInitialAdminFromHome;
  return Object.freeze({
    async provision(input: Parameters<EnterpriseInitDependencies["provision"]>[0]) {
      const state = resolveState({ home: input.home });
      if (state.running) {
        throw {
          code: "ENTERPRISE_INIT_DAEMON_RUNNING",
          message: "Stop the local daemon before provisioning enterprise identity",
        };
      }
      const config = loadDaemonConfig(state.home);
      const enterpriseConfig = config.enterpriseMultiUser;
      if (enterpriseConfig?.enabled !== true) {
        throw {
          code: "ENTERPRISE_INIT_NOT_ENABLED",
          message: "Enterprise multi-user mode is not enabled in config.json",
        };
      }
      const daemonPasswordHash = config.auth?.password;
      if (!daemonPasswordHash) {
        throw {
          code: "ENTERPRISE_INIT_PASSWORD_UNAVAILABLE",
          message: "A local daemon password must be configured before enterprise initialization",
        };
      }
      return provisionFromHome({
        paseoHome: state.home,
        enterpriseConfig,
        paseoServerId: resolveServerId(state.home),
        daemonPasswordHash,
        bootstrapPassword: input.bootstrapPassword,
        principalId: input.principalId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      });
    },
  });
}

interface ProductionEnterpriseEnrollAdapterDependencies {
  readonly resolveState?: typeof resolveLocalDaemonState;
  readonly readConfig?: typeof loadPersistedConfig;
  readonly writeConfig?: typeof savePersistedConfig;
  readonly resolveServerId?: typeof getOrCreateServerId;
  readonly resolveVersion?: typeof resolveDaemonVersion;
  readonly enrollNode?: typeof enrollManagedNode;
  readonly readPrivateFile?: typeof readFile;
}

export function createProductionEnterpriseEnrollDependencies(
  dependencies: ProductionEnterpriseEnrollAdapterDependencies = {},
): EnterpriseEnrollDependencies {
  const resolveState = dependencies.resolveState ?? resolveLocalDaemonState;
  const readConfig = dependencies.readConfig ?? loadPersistedConfig;
  const writeConfig = dependencies.writeConfig ?? savePersistedConfig;
  const resolveServerId = dependencies.resolveServerId ?? getOrCreateServerId;
  const resolveVersion = dependencies.resolveVersion ?? resolveDaemonVersion;
  const enrollNode = dependencies.enrollNode ?? enrollManagedNode;
  const readPrivateFile = dependencies.readPrivateFile ?? readFile;
  return Object.freeze({
    async readEnrollmentToken(tokenPath: string): Promise<string> {
      return readPrivateFile(path.resolve(tokenPath), "utf8");
    },
    async enroll(input: Parameters<EnterpriseEnrollDependencies["enroll"]>[0]) {
      const state = resolveState({ home: input.home });
      if (state.running) {
        throw {
          code: "ENTERPRISE_ENROLL_DAEMON_RUNNING",
          message: "Stop the local daemon before enrolling this node",
        };
      }
      const caCertificatePath = path.resolve(input.caCertificatePath);
      const relationshipPath = path.resolve(
        input.relationshipPath ??
          path.join(state.home, "enterprise", "managed-node-relationship.json"),
      );
      const caCertificate = await readPrivateFile(caCertificatePath);
      const relationship = await enrollNode({
        managementBaseUrl: input.managementBaseUrl,
        enrollmentToken: input.enrollmentToken,
        relationshipPath,
        caCertificate,
        heartbeat: {
          bootId: `boot_${randomBytes(16).toString("hex")}`,
          paseoServerId: resolveServerId(state.home),
          endpoint: input.endpoint,
          version: resolveVersion(),
          capabilities: {
            platform: process.platform,
            arch: process.arch,
            enterpriseManagedV1: true,
            browserProfiles: true,
          },
          capacity: defaultManagedNodeCapacity(),
        },
      });
      const current = readConfig(state.home);
      writeConfig(state.home, {
        ...current,
        features: {
          ...current.features,
          enterpriseMultiUser: {
            enabled: true,
            organizationId: relationship.node.organizationId,
            nodeId: relationship.node.nodeId,
            managementMode: "managed",
            legacyRecords: "owner_only",
            management: {
              baseUrl: relationship.managementBaseUrl,
              caCertificatePath,
              relationshipPath,
            },
          },
        },
      });
      return Object.freeze({
        organizationId: relationship.node.organizationId,
        nodeId: relationship.node.nodeId,
        endpoint: relationship.node.endpoint,
        managementBaseUrl: relationship.managementBaseUrl,
        relationshipPath,
      });
    },
  });
}
