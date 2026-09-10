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

export interface ProductionInitialGrantProvisionInput {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly actor: PrincipalContext;
  readonly principalId: string;
  readonly organizationId: string;
  readonly grants: readonly ResourceGrant[];
}

const INPUT_KEYS = new Set(["provider", "actor", "principalId", "organizationId", "grants"]);

/** Idempotently provisions the first grant record through the provider's sole GrantStore. */
export async function provisionInitialGrant(input: unknown): Promise<GrantRecord | null> {
  try {
    const captured = captureInput(input);
    if (!captured || !isCurrentProductionAuthorizationRuntimeProvider(captured.provider))
      return null;
    if (captured.actor.organizationId !== captured.organizationId) return null;
    if (!isProvisioningActor(captured.actor, captured.organizationId)) return null;
    const grants = normalizeResourceGrants(captured.grants);
    const existing = await readAuthoritativeGrantRecord(
      captured.provider.grantStore,
      captured.principalId,
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
      actor: captured.actor,
      principalId: captured.principalId,
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

function captureInput(value: unknown): ProductionInitialGrantProvisionInput | null {
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
  const actor = PrincipalContextSchema.safeParse(candidate.actor);
  if (
    !actor.success ||
    typeof candidate.principalId !== "string" ||
    typeof candidate.organizationId !== "string" ||
    !Array.isArray(candidate.grants)
  )
    return null;
  if (!candidate.provider || !isObject(candidate.provider)) return null;
  const provider = candidate.provider as ProductionAuthorizationRuntimeProvider;
  return Object.freeze({
    provider,
    actor: PrincipalContextSchema.parse(actor.data),
    principalId: candidate.principalId,
    organizationId: candidate.organizationId,
    grants: candidate.grants as readonly ResourceGrant[],
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isProvisioningActor(actor: PrincipalContext, organizationId: string): boolean {
  if (actor.principalType === "break_glass_owner" && actor.principalId === "owner") return true;
  return actor.grants.some(
    (grant) =>
      grant.action === "identity.manage" &&
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === organizationId,
  );
}
