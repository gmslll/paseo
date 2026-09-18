import type { ConnectionContext, PrincipalContext } from "@getpaseo/protocol/messages";

import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  invalidateEnterpriseAdmissionAuthorization,
  issueEnterpriseAdmissionEvidence,
  releaseEnterpriseAdmissionSession,
  replaceEnterpriseAdmissionSession,
  snapshotEnterpriseConnectionContext,
  type EnterpriseAdmissionAuthenticationEvidence,
  type EnterpriseAdmissionAuthorizationHandle,
  type EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import type { EnterpriseAdmissionPort } from "../identity/runtime.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import type { ManagedNodeControlPlaneClient } from "./management-client.js";
import { ManagedTicketAuthenticator } from "./ticket-authenticator.js";

export interface ManagedEnterpriseAdmissionOptions {
  readonly client: ManagedNodeControlPlaneClient;
  readonly audit: ProductionAuditCapability;
  readonly onAuthenticatedPrincipal?: (principal: PrincipalContext) => Promise<void>;
  readonly maxPolicyStalenessMs?: number;
}

export class ManagedEnterpriseAdmission implements EnterpriseAdmissionPort {
  readonly audit: ProductionAuditCapability;
  readonly authorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly authenticator: ManagedTicketAuthenticator;
  private readonly mintSecret = Object.freeze(Object.create(null)) as object;
  private readonly expectedClients = new WeakMap<object, string>();
  private readonly onAuthenticatedPrincipal?: (principal: PrincipalContext) => Promise<void>;
  private closed = false;

  constructor(options: ManagedEnterpriseAdmissionOptions) {
    this.audit = productionAuditCapabilityIssuer.requireCurrent(options.audit);
    this.authenticator = new ManagedTicketAuthenticator({
      client: options.client,
      ...(options.maxPolicyStalenessMs === undefined
        ? {}
        : { maxPolicyStalenessMs: options.maxPolicyStalenessMs }),
    });
    this.onAuthenticatedPrincipal = options.onAuthenticatedPrincipal;
    this.authorizationIssuer = createEnterpriseAdmissionAuthorizationIssuer(this.mintSecret, () => {
      return !this.closed && productionAuditCapabilityIssuer.current(this.audit);
    });
  }

  async authenticate(
    token: string,
    connection: ConnectionContext,
  ): Promise<PrincipalContext | null> {
    const authenticated = await this.authenticateTicket(token, connection);
    return authenticated?.principal ?? null;
  }

  async authenticateEvidence(
    token: string,
    connection: ConnectionContext,
  ): Promise<EnterpriseAdmissionAuthenticationEvidence | null> {
    if (this.closed) return null;
    const canonical = snapshotEnterpriseConnectionContext(connection);
    if (!canonical) return null;
    const authenticated = await this.authenticateTicket(token, canonical);
    if (!authenticated) return null;
    const evidence = issueEnterpriseAdmissionEvidence(
      this.authorizationIssuer,
      this.mintSecret,
      authenticated.principal,
      this.authenticator.node,
      canonical,
    );
    if (!evidence) return null;
    this.expectedClients.set(evidence as object, authenticated.clientId);
    return evidence;
  }

  bindSession(
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null {
    if (this.closed || typeof clientId !== "string") return null;
    const expected = this.expectedClients.get(evidence as object);
    this.expectedClients.delete(evidence as object);
    if (expected !== clientId) return null;
    return bindEnterpriseAdmissionSession(this.authorizationIssuer, evidence, clientId);
  }

  replaceSession(
    oldHandle: EnterpriseAdmissionAuthorizationHandle,
    evidence: EnterpriseAdmissionAuthenticationEvidence,
    clientId: unknown,
  ): EnterpriseAdmissionAuthorizationHandle | null {
    if (this.closed || typeof clientId !== "string") return null;
    const expected = this.expectedClients.get(evidence as object);
    this.expectedClients.delete(evidence as object);
    if (expected !== clientId) return null;
    return replaceEnterpriseAdmissionSession(
      this.authorizationIssuer,
      oldHandle,
      evidence,
      clientId,
    );
  }

  releaseSession(handle: EnterpriseAdmissionAuthorizationHandle): boolean {
    return releaseEnterpriseAdmissionSession(this.authorizationIssuer, handle);
  }

  isCurrentPrincipalContext(principal: PrincipalContext): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.authenticator.isCurrentPrincipalContext(principal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    invalidateEnterpriseAdmissionAuthorization(this.authorizationIssuer);
  }

  private async authenticateTicket(
    token: string,
    connection: ConnectionContext,
  ): Promise<{ readonly principal: PrincipalContext; readonly clientId: string } | null> {
    if (this.closed) return null;
    const authenticated = await this.authenticator.authenticateSessionTicket(token, connection);
    if (!authenticated) return null;
    await this.onAuthenticatedPrincipal?.(authenticated.principal);
    if (!(await this.authenticator.isCurrentPrincipalContext(authenticated.principal))) return null;
    const clientId = authenticated.claims.clientId;
    if (!clientId) return null;
    return Object.freeze({
      principal: authenticated.principal,
      clientId,
    });
  }
}
