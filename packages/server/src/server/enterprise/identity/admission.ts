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
import {
  IdentityRegistry,
  type CredentialInvalidationSink,
  type IdentityRegistryOptions,
  type PrincipalGrantSource,
} from "./registry.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  releaseEnterpriseAdmissionSession,
  replaceEnterpriseAdmissionSession,
  type EnterpriseAdmissionAuthenticationEvidence,
  type EnterpriseAdmissionAuthorizationHandle,
  type EnterpriseAdmissionAuthorizationIssuer,
  snapshotEnterpriseConnectionContext,
} from "./admission-authorization.js";

export interface EnterpriseAdmissionOptions extends Omit<
  IdentityRegistryOptions,
  "node" | "audit"
> {
  node: NodeContext;
  audit: ProductionAuditCapability;
  organizationId: string;
  daemonPassword?: string;
}

/** Integration-owned durable identity inputs; no storage or grant store is created here. */
export interface EnterpriseIdentitySideDependencies extends Omit<
  EnterpriseAdmissionOptions,
  "node" | "audit" | "organizationId"
> {
  readonly principalSource: PrincipalGrantSource;
  readonly invalidation: CredentialInvalidationSink;
}

export function createEnterpriseIdentitySide(
  input: EnterpriseIdentitySideDependencies & {
    readonly node: NodeContext;
    readonly audit: ProductionAuditCapability;
    readonly organizationId: string;
  },
): EnterpriseAdmission {
  return new EnterpriseAdmission(input);
}

/** Typed production seam for integration-owned runtime assembly. */
export function createEnterpriseAdmission(
  options: EnterpriseAdmissionOptions,
): EnterpriseAdmission {
  return new EnterpriseAdmission(options);
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
  readonly node: NodeContext;
  readonly authorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly registry: IdentityRegistry;
  readonly authenticator: EnterprisePrincipalAuthenticator;
  constructor(options: EnterpriseAdmissionOptions) {
    const audit = productionAuditCapabilityIssuer.requireCurrent(options.audit);
    this.audit = audit;
    const filePath = options.filePath;
    const principalSource = options.principalSource;
    const node = Object.freeze(NodeContextSchema.parse(options.node));
    const mintSecret = Object.freeze(Object.create(null)) as object;
    const authorizationIssuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret, () => {
      try {
        productionAuditCapabilityIssuer.requireCurrent(audit);
        return true;
      } catch {
        return false;
      }
    });
    admissionMintSecrets.set(this, mintSecret);
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
    this.node = node;
    this.authorizationIssuer = authorizationIssuer;
    productionAuditCapabilityIssuer.requireCurrent(audit);
    Object.freeze(this);
  }
  authenticate(token: string, context: ConnectionContext): Promise<PrincipalContext | null> {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return this.authenticateImpl(token, context);
  }

  authenticateEvidence(
    token: string,
    context: ConnectionContext,
  ): Promise<EnterpriseAdmissionAuthenticationEvidence | null> {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return this.authenticateEvidenceImpl(token, context);
  }

  private async authenticateEvidenceImpl(
    token: string,
    context: ConnectionContext,
  ): Promise<EnterpriseAdmissionAuthenticationEvidence | null> {
    let canonicalContext: ConnectionContext;
    try {
      canonicalContext =
        snapshotEnterpriseConnectionContext(context) ??
        (() => {
          throw new Error("invalid connection context");
        })();
    } catch {
      return null;
    }
    const principal = await this.authenticateImpl(token, canonicalContext);
    if (!principal) return null;
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return issueEnterpriseAdmissionEvidence(
      this.authorizationIssuer,
      admissionMintSecrets.get(this)!,
      principal,
      this.node,
      canonicalContext,
    );
  }

  bindSession(
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return bindEnterpriseAdmissionSession(this.authorizationIssuer, evidence, clientId);
  }

  replaceSession(
    oldHandle: EnterpriseAdmissionAuthorizationHandle,
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return replaceEnterpriseAdmissionSession(
      this.authorizationIssuer,
      oldHandle,
      evidence,
      clientId,
    );
  }

  releaseSession(handle: EnterpriseAdmissionAuthorizationHandle): boolean {
    productionAuditCapabilityIssuer.requireCurrent(this.audit);
    return releaseEnterpriseAdmissionSession(this.authorizationIssuer, handle);
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

const admissionMintSecrets = new WeakMap<EnterpriseAdmission, object>();
