import type { ConnectionContext, NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import { productionAuditCapabilityIssuer } from "../audit/production-audit-runtime.js";
import {
  ConnectionContextSchema,
  NodeContextSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
} from "@getpaseo/protocol/messages";
import { EnterprisePrincipalAuthenticator } from "./authenticator.js";
import { IdentityRegistry, type IdentityRegistryOptions } from "./registry.js";

export interface EnterpriseAdmissionOptions extends Omit<
  IdentityRegistryOptions,
  "node" | "audit"
> {
  node: NodeContext;
  audit: ProductionAuditCapability;
  organizationId: string;
  daemonPassword?: string;
}
function cloneFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  // oxlint-disable-next-line no-explicit-any -- recursive structural clone boundary.
  const copy: any = Array.isArray(value) ? [...(value as any)] : { ...(value as any) };
  for (const key of Object.keys(copy)) copy[key] = cloneFreeze(copy[key]);
  return Object.freeze(copy) as T;
}

/** W1-owned singleton identity/admission seam. It never constructs a Session. */
export class EnterpriseAdmission {
  readonly audit: ProductionAuditCapability;
  readonly registry: IdentityRegistry;
  readonly authenticator: EnterprisePrincipalAuthenticator;
  constructor(options: EnterpriseAdmissionOptions) {
    const audit = productionAuditCapabilityIssuer.requireCurrent(options.audit);
    this.audit = audit;
    const filePath = options.filePath;
    const principalSource = options.principalSource;
    const node = Object.freeze(NodeContextSchema.parse(options.node));
    const organizationId = OrganizationIdSchema.parse(options.organizationId);
    const invalidation = options.invalidation;
    const clock = options.clock;
    const credentialIds = options.credentialIds;
    const secrets = options.secrets;
    const hasher = options.hasher;
    const verifier = options.verifier;
    const fs = options.fs;
    const daemonPassword = options.daemonPassword;
    productionAuditCapabilityIssuer.requireCurrent(audit);
    this.registry = new IdentityRegistry({
      filePath,
      principalSource,
      node,
      audit,
      invalidation,
      clock,
      credentialIds,
      secrets,
      hasher,
      verifier,
      fs,
    });
    productionAuditCapabilityIssuer.requireCurrent(audit);
    this.authenticator = new EnterprisePrincipalAuthenticator({
      registry: this.registry,
      node,
      organizationId,
      audit,
      daemonPassword,
    });
    productionAuditCapabilityIssuer.requireCurrent(audit);
    Object.freeze(this);
  }
  authenticate(token: string, context: ConnectionContext): Promise<PrincipalContext | null> {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return this.authenticateImpl(token, context);
  }

  private async authenticateImpl(
    token: string,
    context: ConnectionContext,
  ): Promise<PrincipalContext | null> {
    let canonical: ConnectionContext;
    try {
      canonical = cloneFreeze(ConnectionContextSchema.parse(structuredClone(context)));
    } catch {
      return null;
    }
    const raw = await this.authenticator.authenticateBearer(token, canonical);
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    if (!raw) return null;
    let principal: PrincipalContext;
    try {
      principal = cloneFreeze(PrincipalContextSchema.parse(structuredClone(raw)));
    } catch {
      return null;
    }
    const current = await this.authenticator.isCurrentPrincipalContext(principal);
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    if (!current) return null;
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return cloneFreeze(principal);
  }

  isCurrentPrincipalContext(principal: PrincipalContext): Promise<boolean> {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return this.isCurrentPrincipalContextImpl(principal);
  }

  private async isCurrentPrincipalContextImpl(principal: PrincipalContext): Promise<boolean> {
    const result = await this.authenticator.isCurrentPrincipalContext(principal);
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    if (!result) return false;
    return true;
  }
}
