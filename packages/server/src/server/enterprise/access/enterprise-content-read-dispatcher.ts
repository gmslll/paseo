import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";
import type { ProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import { resolveCurrentProductionRuntimeAuthority } from "./production-runtime-authority.js";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { EnterpriseContentAgentProductionSource } from "../runtime/enterprise-content-read.js";
import { createEnterpriseWorkspaceContentReadSource } from "../runtime/enterprise-content-read.js";
import { isCurrentProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";

export interface EnterpriseContentReadFactoryInput {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly audit: ProductionAuditCapability;
  readonly agents: EnterpriseContentAgentProductionSource;
}

export function createEnterpriseContentReadDispatcherRegistration(
  input: EnterpriseContentReadFactoryInput,
): EnterpriseSessionDispatcherFactoryRegistration | null {
  const { provider, audit, agents } = input;
  if (!isCurrentProductionAuthorizationRuntimeProvider(provider) || !audit || !agents) return null;
  return {
    manifest: { operations: ["enterprise.workspace.content.read.request"] },
    open(openInput) {
      if (!openInput.authorizationRuntime || !openInput.filesRuntime)
        throw new Error("content runtime unavailable");
      if (!resolveCurrentProductionRuntimeAuthority(openInput.authorizationRuntime, provider))
        throw new Error("content runtime is not current");
      const source = createEnterpriseWorkspaceContentReadSource({
        filesRuntime: openInput.filesRuntime,
        agents,
      });
      if (!source) throw new Error("workspace source unavailable");
      let closed = false;
      return {
        dispatcher: { handle: () => false },
        close: async () => {
          if (closed) return;
          closed = true;
          await source.close();
        },
      };
    },
  };
}
