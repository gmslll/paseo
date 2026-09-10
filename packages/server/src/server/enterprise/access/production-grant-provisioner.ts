import {
  normalizeResourceGrants,
  PrincipalContextSchema,
  type PrincipalContext,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";
import {
  GrantRecordSchema,
  readAuthoritativeGrantRecord,
  updateAuthoritativeGrantRecord,
  type GrantRecord,
} from "./grant-store.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

export interface ProductionGrantProvisionInput {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly principal: PrincipalContext;
  readonly organizationId: string;
  readonly grants: readonly ResourceGrant[];
}

const INPUT_KEYS = new Set(["provider", "principal", "organizationId", "grants"]);

/** Idempotently provisions the first grant record through the provider's sole GrantStore. */
export async function provisionProductionGrant(input: unknown): Promise<GrantRecord | null> {
  try {
    const captured = captureInput(input);
    if (!captured || !isCurrentProductionAuthorizationRuntimeProvider(captured.provider))
      return null;
    if (captured.principal.organizationId !== captured.organizationId) return null;
    const grants = normalizeResourceGrants(captured.grants);
    const existing = await readAuthoritativeGrantRecord(
      captured.provider.grantStore,
      captured.principal.principalId,
    );
    if (!isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) return null;
    if (existing) {
      if (
        existing.organizationId !== captured.organizationId ||
        JSON.stringify(existing.grants) !== JSON.stringify(grants) ||
        !GrantRecordSchema.safeParse(existing).success
      )
        return null;
      return existing;
    }
    const change = await updateAuthoritativeGrantRecord(captured.provider.grantStore, {
      actor: captured.principal,
      principalId: captured.principal.principalId,
      organizationId: captured.organizationId,
      grants,
      expectedVersion: null,
    });
    if (!isCurrentProductionAuthorizationRuntimeProvider(captured.provider) || !change.changed)
      return null;
    return GrantRecordSchema.parse(change.current);
  } catch {
    return null;
  }
}

function captureInput(value: unknown): ProductionGrantProvisionInput | null {
  if (!isObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== INPUT_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))
  )
    return null;
  const descriptors = Object.fromEntries(
    keys.map((key) => [key, Reflect.getOwnPropertyDescriptor(value, key)]),
  );
  if (
    Object.values(descriptors).some(
      (descriptor) => !descriptor?.enumerable || !("value" in descriptor!),
    )
  )
    return null;
  const candidate = value as Record<string, unknown>;
  const principal = PrincipalContextSchema.safeParse(candidate.principal);
  if (
    !principal.success ||
    typeof candidate.organizationId !== "string" ||
    !Array.isArray(candidate.grants)
  )
    return null;
  if (!candidate.provider || !isObject(candidate.provider)) return null;
  const provider = candidate.provider as ProductionAuthorizationRuntimeProvider;
  return Object.freeze({
    provider,
    principal: PrincipalContextSchema.parse(principal.data),
    organizationId: candidate.organizationId,
    grants: candidate.grants as readonly ResourceGrant[],
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
