import type {
  AuditSink,
  ConnectionContext,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  ConnectionContextSchema,
  NodeContextSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
} from "@getpaseo/protocol/messages";
import { EnterprisePrincipalAuthenticator } from "./authenticator.js";
import { IdentityRegistry, type IdentityRegistryOptions } from "./registry.js";

export interface EnterpriseAuditSink extends AuditSink {
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
}
export interface EnterpriseAdmissionOptions extends Omit<
  IdentityRegistryOptions,
  "node" | "audit"
> {
  node: NodeContext;
  audit: EnterpriseAuditSink;
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
  readonly registry: IdentityRegistry;
  readonly authenticator: EnterprisePrincipalAuthenticator;
  constructor(options: EnterpriseAdmissionOptions) {
    if (!options.audit.releaseReady)
      throw new Error("enterprise admission requires release-ready audit storage");
    const node = Object.freeze(NodeContextSchema.parse(options.node));
    const organizationId = OrganizationIdSchema.parse(options.organizationId);
    const { organizationId: _organizationId, daemonPassword, ...registryOptions } = options;
    this.registry = new IdentityRegistry({ ...registryOptions, node, audit: options.audit });
    this.authenticator = new EnterprisePrincipalAuthenticator({
      registry: this.registry,
      node,
      organizationId,
      audit: options.audit,
      daemonPassword,
    });
  }
  async authenticate(token: string, context: ConnectionContext): Promise<PrincipalContext | null> {
    let canonical: ConnectionContext;
    try {
      canonical = cloneFreeze(ConnectionContextSchema.parse(structuredClone(context)));
    } catch {
      return null;
    }
    const raw = await this.authenticator.authenticateBearer(token, canonical);
    if (!raw) return null;
    let principal: PrincipalContext;
    try {
      principal = cloneFreeze(PrincipalContextSchema.parse(structuredClone(raw)));
    } catch {
      return null;
    }
    if (!(await this.authenticator.isCurrentPrincipalContext(principal))) return null;
    return cloneFreeze(principal);
  }
}
