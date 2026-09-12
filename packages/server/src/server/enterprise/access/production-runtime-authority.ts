import type { AuthorizedAgent, ResourceAuthorization } from "@getpaseo/protocol/messages";
import type { ProductionAuthorizationRuntime } from "./production-authorization-runtime.js";
import { isCurrentProductionAuthorizationRuntimeForAuthoritySources } from "./production-authorization-runtime.js";
import { getAuthoritativeAgent, type OwnerRegistry } from "./owner-registry.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

declare const productionRuntimeAuthorityBrand: unique symbol;
declare const productionRuntimeOwnersBrand: unique symbol;

export interface ProductionRuntimeOwners {
  readonly [productionRuntimeOwnersBrand]: never;
}

export interface CurrentProductionRuntimeAuthority {
  readonly [productionRuntimeAuthorityBrand]: never;
  readonly resourceAuthorization: ResourceAuthorization;
  readonly owners: ProductionRuntimeOwners;
}

interface OwnersRecord {
  readonly runtime: ProductionAuthorizationRuntime;
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly owners: OwnerRegistry;
}

const ownersRecords = new WeakMap<object, OwnersRecord>();

export function resolveCurrentProductionRuntimeAuthority(
  runtime: unknown,
  provider: unknown,
): CurrentProductionRuntimeAuthority | null {
  try {
    if (!isCurrentProductionAuthorizationRuntimeProvider(provider)) return null;
    if (
      !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
        runtime,
        provider.grantStore,
        provider.owners,
      )
    ) {
      return null;
    }
    const currentRuntime = runtime as ProductionAuthorizationRuntime;
    const owners = Object.freeze(Object.create(null)) as ProductionRuntimeOwners;
    ownersRecords.set(
      owners,
      Object.freeze({ runtime: currentRuntime, provider, owners: provider.owners }),
    );
    return Object.freeze({
      resourceAuthorization: currentRuntime.resourceAuthorization,
      owners,
    }) as unknown as CurrentProductionRuntimeAuthority;
  } catch {
    return null;
  }
}

export function resolveAuthoritativeAgent(
  owners: unknown,
  agentId: string,
): AuthorizedAgent | null {
  try {
    if (typeof agentId !== "string" || agentId.length === 0 || !isObject(owners)) return null;
    const record = ownersRecords.get(owners);
    if (
      !record ||
      !isCurrentProductionAuthorizationRuntimeProvider(record.provider) ||
      !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
        record.runtime,
        record.provider.grantStore,
        record.provider.owners,
      )
    ) {
      return null;
    }
    return getAuthoritativeAgent(record.owners, agentId);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
