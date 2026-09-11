import { verify } from "node:crypto";

import {
  ManagedSessionTicketClaimsSchema,
  type ManagedSessionTicketClaims,
} from "@getpaseo/protocol/enterprise-management";
import {
  ConnectionContextSchema,
  PrincipalContextSchema,
  type ConnectionContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";

import type { ManagedNodeControlPlaneClient } from "./management-client.js";

export interface ManagedTicketAuthenticatorOptions {
  readonly client: ManagedNodeControlPlaneClient;
  readonly maxPolicyStalenessMs?: number;
  readonly clock?: { readonly nowMs: () => number };
}

export class ManagedTicketAuthenticator {
  readonly adapterKind = "remote" as const;
  readonly node;
  readonly configuredOrganizationId: string;
  private readonly maxPolicyStalenessMs: number;
  private readonly clock: { readonly nowMs: () => number };

  constructor(private readonly options: ManagedTicketAuthenticatorOptions) {
    this.node = Object.freeze({
      nodeId: options.client.relationship.node.nodeId,
      paseoServerId: options.client.relationship.node.paseoServerId,
      mode: "managed" as const,
    });
    this.configuredOrganizationId = options.client.relationship.node.organizationId;
    this.maxPolicyStalenessMs = parseStaleness(options.maxPolicyStalenessMs);
    this.clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async authenticateBearer(
    token: string,
    connection: ConnectionContext,
  ): Promise<PrincipalContext | null> {
    const verified = await this.authenticateTicket(token, connection, true);
    return verified ? verified.principal : null;
  }

  async authenticateSessionTicket(
    token: string,
    connection: ConnectionContext,
  ): Promise<{
    readonly principal: PrincipalContext;
    readonly claims: ManagedSessionTicketClaims & { readonly kind: "session" };
  } | null> {
    const verified = await this.authenticateTicket(token, connection, true);
    if (!verified || verified.claims.kind !== "session") return null;
    return Object.freeze({
      principal: verified.principal,
      claims: verified.claims as ManagedSessionTicketClaims & { readonly kind: "session" },
    });
  }

  async isCurrentPrincipalContext(principal: PrincipalContext): Promise<boolean> {
    let canonical: PrincipalContext;
    try {
      canonical = PrincipalContextSchema.parse(structuredClone(principal));
    } catch {
      return false;
    }
    if (
      canonical.organizationId !== this.configuredOrganizationId ||
      canonical.principalType === "break_glass_owner"
    ) {
      return false;
    }
    if (this.options.client.policyAgeMs() > this.maxPolicyStalenessMs) {
      try {
        await this.options.client.refreshPolicy();
      } catch {
        return false;
      }
    }
    const policy = this.options.client.currentPolicy(canonical.principalId);
    return Boolean(
      policy && policy.status === "active" && policy.grantVersion === canonical.grantVersion,
    );
  }

  private async authenticateTicket(
    token: string,
    connection: ConnectionContext,
    requireFreshPolicy: boolean,
  ): Promise<{
    readonly principal: PrincipalContext;
    readonly claims: ManagedSessionTicketClaims;
  } | null> {
    let canonicalConnection: ConnectionContext;
    let claims: ManagedSessionTicketClaims;
    try {
      canonicalConnection = ConnectionContextSchema.parse(structuredClone(connection));
      if (
        canonicalConnection.node.nodeId !== this.node.nodeId ||
        canonicalConnection.node.paseoServerId !== this.node.paseoServerId ||
        canonicalConnection.node.mode !== "managed"
      ) {
        return null;
      }
      claims = verifyManagedTicket(token, this.options.client.relationship.ticketPublicKeyPem);
    } catch {
      return null;
    }
    if (
      claims.kind !== "session" ||
      claims.issuer !== this.options.client.relationship.managementBaseUrl ||
      claims.organizationId !== this.configuredOrganizationId ||
      claims.nodeId !== this.node.nodeId ||
      claims.paseoServerId !== this.node.paseoServerId ||
      this.clock.nowMs() < claims.notBeforeMs ||
      this.clock.nowMs() >= claims.expiresAtMs
    ) {
      return null;
    }
    if (requireFreshPolicy) {
      try {
        await this.options.client.refreshPolicy();
      } catch {
        return null;
      }
    }
    const policy = this.options.client.currentPolicy(claims.principalId);
    if (
      !policy ||
      policy.status !== "active" ||
      policy.grantVersion !== claims.grantVersion ||
      policy.revocationEpoch !== claims.revocationEpoch ||
      JSON.stringify(policy.grants) !== JSON.stringify(claims.grants)
    ) {
      return null;
    }
    const principal = PrincipalContextSchema.safeParse({
      principalType: claims.principalType,
      principalId: claims.principalId,
      organizationId: claims.organizationId,
      grants: structuredClone(claims.grants),
      credentialId: claims.credentialId,
      grantVersion: claims.grantVersion,
    });
    if (!principal.success) return null;
    return Object.freeze({
      principal: freezePrincipal(principal.data),
      claims: Object.freeze(structuredClone(claims)),
    });
  }
}

export function verifyManagedTicket(
  ticket: string,
  publicKeyPem: string,
): ManagedSessionTicketClaims {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "pmt_v1") throw new Error("invalid managed ticket");
  const payload = parts[1]!;
  const signature = Buffer.from(parts[2]!, "base64url");
  if (
    !verify(
      null,
      Buffer.from(`paseo-management-ticket-v1.${payload}`, "utf8"),
      publicKeyPem,
      signature,
    )
  ) {
    throw new Error("invalid managed ticket signature");
  }
  return ManagedSessionTicketClaimsSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
}

function freezePrincipal(principal: PrincipalContext): PrincipalContext {
  return Object.freeze({
    ...principal,
    grants: Object.freeze(principal.grants.map((grant) => Object.freeze(structuredClone(grant)))),
  }) as unknown as PrincipalContext;
}

function parseStaleness(value: number | undefined): number {
  const staleness = value ?? 60_000;
  if (!Number.isSafeInteger(staleness) || staleness < 1_000 || staleness > 5 * 60_000) {
    throw new Error("invalid managed policy staleness");
  }
  return staleness;
}
