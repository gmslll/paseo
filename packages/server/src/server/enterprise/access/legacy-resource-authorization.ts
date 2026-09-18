import { normalizeEnterpriseResourceOwner } from "@getpaseo/protocol/messages";
import type {
  AuthorizedAgent,
  AuthorizedWorkspace,
  EnterpriseWorkspaceAuthorizationRecord,
  EnterpriseAction,
} from "@getpaseo/protocol/messages";
import type { EnterpriseAgentAuthorizationRecord } from "./owner-registry.js";
import type { EnterpriseAgentContentAuthorizationRow } from "./resource-authorization.js";
import { isCurrentProductionAuthorizationRuntime } from "./production-authorization-runtime.js";

const legacyBrand = Symbol("enterprise-legacy-resource-authorization");
export interface EnterpriseLegacyResourceAuthorization {
  readonly [legacyBrand]: never;
  isCurrent(): boolean;
  filterWorkspaces<T extends EnterpriseWorkspaceAuthorizationRecord>(
    rows: readonly T[],
  ): readonly T[];
  filterAgents<T extends EnterpriseAgentAuthorizationRecord>(
    action: "workspace.metadata.read" | "workspace.content.read",
    rows: readonly T[],
  ): Promise<readonly T[]>;
  prefilterAgentContentRows<T extends EnterpriseAgentContentAuthorizationRow>(
    rows: readonly T[],
  ): readonly T[];
  assertWorkspace(action: EnterpriseAction, id: string): Promise<AuthorizedWorkspace | null>;
  assertAgent(action: EnterpriseAction, id: string): Promise<AuthorizedAgent | null>;
}

const branded = new WeakSet<object>();

export function isEnterpriseLegacyResourceAuthorization(
  value: unknown,
): value is EnterpriseLegacyResourceAuthorization {
  return typeof value === "object" && value !== null && branded.has(value);
}

export function createEnterpriseLegacyResourceAuthorization(
  input: unknown,
): EnterpriseLegacyResourceAuthorization | null {
  try {
    if (!input || typeof input !== "object") return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== null && proto !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 1 || keys[0] !== "authorizationRuntime") return null;
    const descriptor = Object.getOwnPropertyDescriptor(input, "authorizationRuntime");
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
    const runtime = descriptor.value;
    if (!isCurrentProductionAuthorizationRuntime(runtime)) return null;
    const record = Object.freeze(
      Object.assign(
        {
          isCurrent: () => isCurrentProductionAuthorizationRuntime(runtime),
          filterWorkspaces: <T extends EnterpriseWorkspaceAuthorizationRecord>(
            rows: readonly T[],
          ) => {
            if (!isCurrentProductionAuthorizationRuntime(runtime)) return [] as readonly T[];
            const result = runtime.resourceAuthorization.filterWorkspaces(runtime.principal, rows);
            return isCurrentProductionAuthorizationRuntime(runtime) ? result : [];
          },
          filterAgents: async <T extends EnterpriseAgentAuthorizationRecord>(
            action: "workspace.metadata.read" | "workspace.content.read",
            rows: readonly T[],
          ) => {
            if (!isCurrentProductionAuthorizationRuntime(runtime)) return [] as readonly T[];
            const out: T[] = [];
            for (const row of rows) {
              if (!isCurrentProductionAuthorizationRuntime(runtime)) return [];
              const canonical = await runtime.resourceAuthorization
                .assertAgent(runtime.principal, action, row.id)
                .catch(() => null);
              if (canonical) {
                try {
                  const owner = normalizeEnterpriseResourceOwner(row);
                  if (
                    owner &&
                    owner.organizationId === canonical.organizationId &&
                    owner.nodeId === canonical.nodeId &&
                    owner.ownerPrincipalId === canonical.ownerPrincipalId &&
                    owner.createdByPrincipalId === canonical.createdByPrincipalId &&
                    canonical.agentId === row.id &&
                    canonical.workspaceId === row.workspaceId
                  )
                    out.push(row);
                } catch {
                  /* skip malformed rows */
                }
              }
            }
            return isCurrentProductionAuthorizationRuntime(runtime) ? out : [];
          },
          prefilterAgentContentRows: <T extends EnterpriseAgentContentAuthorizationRow>(
            rows: readonly T[],
          ) => {
            if (!isCurrentProductionAuthorizationRuntime(runtime)) return [];
            try {
              const result = runtime.resourceAuthorization.prefilterAgentContentRows(
                runtime.principal,
                rows,
              );
              return isCurrentProductionAuthorizationRuntime(runtime) ? result : [];
            } catch {
              return [];
            }
          },
          assertWorkspace: async (action: EnterpriseAction, id: string) => {
            if (!isCurrentProductionAuthorizationRuntime(runtime)) return null;
            try {
              const value = await runtime.resourceAuthorization.assertWorkspace(
                runtime.principal,
                action,
                id,
              );
              return isCurrentProductionAuthorizationRuntime(runtime) ? value : null;
            } catch {
              return null;
            }
          },
          assertAgent: async (action: EnterpriseAction, id: string) => {
            if (!isCurrentProductionAuthorizationRuntime(runtime)) return null;
            try {
              const value = await runtime.resourceAuthorization.assertAgent(
                runtime.principal,
                action,
                id,
              );
              return isCurrentProductionAuthorizationRuntime(runtime) ? value : null;
            } catch {
              return null;
            }
          },
        },
        { [legacyBrand]: undefined as never },
      ),
    );
    branded.add(record);
    return isEnterpriseLegacyResourceAuthorization(record) ? record : null;
  } catch {
    return null;
  }
}
