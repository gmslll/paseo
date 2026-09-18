import {
  NodeContextSchema,
  PrincipalContextSchema,
  normalizeResourceGrants,
  type NodeContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  isCurrentEnterpriseAdmissionAuthorization,
  resolveCurrentEnterpriseAdmissionAuthorization,
  type EnterpriseAdmissionAuthorizationHandle,
  type EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import {
  currentAuthoritativeGrantVersion,
  isAuthoritativeGrantStore,
  isAuthoritativeGrantStoreForAudit,
  readAuthoritativeGrantRecord,
  type GrantRecord,
  type GrantStore,
} from "./grant-store.js";
import type { PrincipalGrantVersionGuard } from "./resource-authorization.js";

export interface ProductionAuthorizationAuthorityDependencies {
  readonly admissionAuthorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly admissionAuthorizationHandle: EnterpriseAdmissionAuthorizationHandle;
  readonly grantStore: GrantStore;
  readonly audit: ProductionAuditCapability;
}

export interface ResolvedProductionAuthorizationAuthority {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly clientId: string;
  readonly sessionBindingKey: string;
  readonly sessionBindingGeneration: string;
  readonly grantVersionGuard: PrincipalGrantVersionGuard;
}

const AUTHORITY_DEPENDENCY_KEYS = new Set([
  "admissionAuthorizationIssuer",
  "admissionAuthorizationHandle",
  "grantStore",
  "audit",
]);

export async function resolveProductionAuthorizationAuthority(
  input: ProductionAuthorizationAuthorityDependencies,
): Promise<ResolvedProductionAuthorizationAuthority | null> {
  try {
    const captured = captureAuthorityDependencies(input);
    if (
      !captured ||
      !isAuthoritativeGrantStore(captured.grantStore) ||
      !isAuthoritativeGrantStoreForAudit(captured.grantStore, captured.audit)
    ) {
      return null;
    }
    if (!productionAuditCapabilityIssuer.current(captured.audit)) return null;

    const first = canonicalResolved(
      resolveCurrentEnterpriseAdmissionAuthorization(
        captured.admissionAuthorizationIssuer,
        captured.admissionAuthorizationHandle,
      ),
    );
    if (!first || !sameNode(first.node, captured.audit.node)) return null;

    const record = await readAuthoritativeGrantRecord(
      captured.grantStore,
      first.principal.principalId,
    );
    if (!recordMatchesPrincipal(record, first.principal)) return null;
    if (!productionAuditCapabilityIssuer.current(captured.audit)) return null;

    const second = canonicalResolved(
      resolveCurrentEnterpriseAdmissionAuthorization(
        captured.admissionAuthorizationIssuer,
        captured.admissionAuthorizationHandle,
      ),
    );
    if (!second || !sameResolved(first, second) || !sameNode(second.node, captured.audit.node)) {
      return null;
    }

    const guard = new AdmissionGrantVersionGuard(captured, first);
    if (!guard.isCurrent(first.principal)) return null;
    return deepFreeze({ ...first, grantVersionGuard: guard });
  } catch {
    return null;
  }
}

class AdmissionGrantVersionGuard implements PrincipalGrantVersionGuard {
  constructor(
    private readonly dependencies: Readonly<ProductionAuthorizationAuthorityDependencies>,
    private readonly resolved: Omit<ResolvedProductionAuthorizationAuthority, "grantVersionGuard">,
  ) {
    Object.freeze(this);
  }

  isCurrent(ctx: PrincipalContext): boolean {
    try {
      if (!samePrincipal(canonicalPrincipal(ctx), this.resolved.principal)) return false;
      if (!productionAuditCapabilityIssuer.current(this.dependencies.audit)) return false;
      if (
        !isCurrentEnterpriseAdmissionAuthorization(
          this.dependencies.admissionAuthorizationIssuer,
          this.dependencies.admissionAuthorizationHandle,
        )
      ) {
        return false;
      }
      const current = canonicalResolved(
        resolveCurrentEnterpriseAdmissionAuthorization(
          this.dependencies.admissionAuthorizationIssuer,
          this.dependencies.admissionAuthorizationHandle,
        ),
      );
      return Boolean(
        current &&
        sameResolved(current, this.resolved) &&
        sameNode(current.node, this.dependencies.audit.node) &&
        currentAuthoritativeGrantVersion(
          this.dependencies.grantStore,
          this.resolved.principal.organizationId,
          this.resolved.principal.principalId,
        ) === this.resolved.principal.grantVersion,
      );
    } catch {
      return false;
    }
  }
}

function captureAuthorityDependencies(
  input: ProductionAuthorizationAuthorityDependencies,
): Readonly<ProductionAuthorizationAuthorityDependencies> | null {
  if (!hasOnlyDataProperties(input, AUTHORITY_DEPENDENCY_KEYS)) return null;
  try {
    return Object.freeze({
      admissionAuthorizationIssuer: dataProperty(
        input,
        "admissionAuthorizationIssuer",
      ) as EnterpriseAdmissionAuthorizationIssuer,
      admissionAuthorizationHandle: dataProperty(
        input,
        "admissionAuthorizationHandle",
      ) as EnterpriseAdmissionAuthorizationHandle,
      grantStore: dataProperty(input, "grantStore") as GrantStore,
      audit: dataProperty(input, "audit") as ProductionAuditCapability,
    });
  } catch {
    return null;
  }
}

function canonicalResolved(
  input: ReturnType<typeof resolveCurrentEnterpriseAdmissionAuthorization>,
): Omit<ResolvedProductionAuthorizationAuthority, "grantVersionGuard"> | null {
  if (!input) return null;
  try {
    const principal = canonicalPrincipal(input.principal);
    const node = canonicalNode(input.node);
    if (
      typeof input.clientId !== "string" ||
      input.clientId.length === 0 ||
      typeof input.sessionBindingKey !== "string" ||
      input.sessionBindingKey.length === 0 ||
      typeof input.sessionBindingGeneration !== "string" ||
      input.sessionBindingGeneration.length === 0
    ) {
      return null;
    }
    return deepFreeze({
      principal,
      node,
      clientId: input.clientId,
      sessionBindingKey: input.sessionBindingKey,
      sessionBindingGeneration: input.sessionBindingGeneration,
    });
  } catch {
    return null;
  }
}

function canonicalPrincipal(input: PrincipalContext): PrincipalContext {
  const parsed = PrincipalContextSchema.parse(structuredClone(input));
  return deepFreeze({ ...parsed, grants: normalizeResourceGrants(parsed.grants) });
}

function canonicalNode(input: NodeContext): NodeContext {
  const parsed = NodeContextSchema.parse(structuredClone(input));
  return deepFreeze({ ...parsed });
}

function recordMatchesPrincipal(
  record: GrantRecord | null,
  principal: PrincipalContext,
): record is GrantRecord {
  return Boolean(
    record &&
    record.organizationId === principal.organizationId &&
    record.principalId === principal.principalId &&
    record.grantVersion === principal.grantVersion &&
    sameGrants(record.grants, principal.grants),
  );
}

function sameResolved(
  left: Omit<ResolvedProductionAuthorizationAuthority, "grantVersionGuard">,
  right: Omit<ResolvedProductionAuthorizationAuthority, "grantVersionGuard">,
): boolean {
  return (
    samePrincipal(left.principal, right.principal) &&
    sameNode(left.node, right.node) &&
    left.clientId === right.clientId &&
    left.sessionBindingKey === right.sessionBindingKey &&
    left.sessionBindingGeneration === right.sessionBindingGeneration
  );
}

function samePrincipal(left: PrincipalContext, right: PrincipalContext): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    sameGrants(left.grants, right.grants)
  );
}

function sameGrants(left: PrincipalContext["grants"], right: PrincipalContext["grants"]): boolean {
  return (
    JSON.stringify(normalizeResourceGrants(left)) === JSON.stringify(normalizeResourceGrants(right))
  );
}

function sameNode(left: NodeContext, right: NodeContext): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.paseoServerId === right.paseoServerId &&
    left.mode === right.mode
  );
}

function hasOnlyDataProperties(input: unknown, allowed: ReadonlySet<string>): input is object {
  try {
    if (typeof input !== "object" || input === null) return false;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function dataProperty(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("authority dependencies must use enumerable data properties");
  }
  return descriptor.value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
