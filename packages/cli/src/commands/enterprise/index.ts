import { Command } from "commander";
import {
  getOrCreateServerId,
  loadConfig,
  provisionProductionEnterpriseInitialAdminFromHome,
} from "@getpaseo/server";
import { resolveLocalDaemonState } from "../daemon/local-daemon.js";
import { createEnterpriseInitCommand, type EnterpriseInitDependencies } from "./init.js";

export function createEnterpriseCommand(dependencies?: EnterpriseInitDependencies): Command {
  return new Command("enterprise")
    .description("Manage local enterprise identity")
    .addCommand(
      createEnterpriseInitCommand(dependencies ?? createProductionEnterpriseInitDependencies()),
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
