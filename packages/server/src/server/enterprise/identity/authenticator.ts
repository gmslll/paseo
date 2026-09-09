import { randomUUID } from "node:crypto";
import { compare } from "bcryptjs";
import { ENTERPRISE_ACTIONS } from "@getpaseo/protocol/messages";
import type {
  AuditSink,
  ConnectionContext,
  NodeContext,
  PrincipalAuthenticator,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  ConnectionContextSchema,
  NodeContextSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
} from "@getpaseo/protocol/messages";
import { IdentityRegistry } from "./registry.js";

export interface EnterprisePrincipalAuthenticatorOptions {
  registry: IdentityRegistry;
  node: NodeContext;
  organizationId: string;
  daemonPassword?: string;
  audit: AuditSink;
}

/** Local adapter for the protocol PrincipalAuthenticator port. */
export class EnterprisePrincipalAuthenticator implements PrincipalAuthenticator {
  readonly adapterKind = "local" as const;
  readonly node: NodeContext;
  private readonly registry: IdentityRegistry;
  private readonly daemonPassword?: string;
  private readonly organizationId: string;
  private readonly breakGlassGeneration = randomUUID();
  private readonly audit: AuditSink;

  constructor(options: EnterprisePrincipalAuthenticatorOptions) {
    this.registry = options.registry;
    this.node = Object.freeze(NodeContextSchema.parse(options.node));
    this.daemonPassword = options.daemonPassword;
    this.organizationId = OrganizationIdSchema.parse(options.organizationId);
    this.audit = options.audit;
  }

  async authenticateBearer(
    token: string,
    context: ConnectionContext,
  ): Promise<PrincipalContext | null> {
    const canonicalContext = ConnectionContextSchema.parse(context);
    if (
      canonicalContext.node.nodeId !== this.node.nodeId ||
      canonicalContext.node.paseoServerId !== this.node.paseoServerId ||
      canonicalContext.node.mode !== this.node.mode
    )
      return null;
    const enterprise = await this.registry.authenticate(token, this.node);
    if (enterprise) return enterprise;
    // Break-glass Owner is local-only in enterprise mode. Relay and external direct
    // connections must never gain Owner by presenting the daemon password.
    if (
      this.daemonPassword &&
      (canonicalContext.peer === "loopback" || canonicalContext.peer === "local_ipc") &&
      (await compare(token, this.daemonPassword))
    ) {
      const credentialId = `break-glass:${this.node.nodeId}:${this.node.paseoServerId}:${this.breakGlassGeneration}`;
      await this.audit.append(
        {
          organizationId: this.organizationId,
          actorPrincipalId: "owner",
          actorCredentialId: credentialId,
          action: "identity.break_glass.use",
          outcome: "allowed",
          resource: { kind: "daemon", id: this.node.nodeId },
        },
        { durability: "required" },
      );
      return PrincipalContextSchema.parse({
        principalType: "break_glass_owner",
        principalId: "owner",
        organizationId: this.organizationId,
        grants: ENTERPRISE_ACTIONS.map((action) => ({
          action,
          selector: { kind: "organization" as const, organizationId: this.organizationId },
        })),
        credentialId,
        grantVersion: this.breakGlassGeneration,
      });
    }
    return null;
  }
}

export function createSessionBindingGeneration(): string {
  return randomUUID();
}
