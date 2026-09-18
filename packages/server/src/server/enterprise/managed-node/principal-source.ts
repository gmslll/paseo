import type {
  EnterprisePrincipalRecord,
  OrganizationId,
  PrincipalContext,
} from "@getpaseo/protocol/messages";

import { synchronizeAuthoritativeGrantRecords, type GrantStore } from "../access/grant-store.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import type { ProductionPrincipalGrantSource } from "../identity/principal-source.js";
import type { ManagedNodeControlPlaneClient } from "./management-client.js";

export class ManagedPrincipalGrantSource implements ProductionPrincipalGrantSource {
  private closed = false;

  constructor(
    private readonly client: ManagedNodeControlPlaneClient,
    private readonly grantStore: GrantStore,
    private readonly audit: ProductionAuditCapability,
  ) {}

  async ready(): Promise<void> {
    await this.refresh();
  }

  async validateCurrent(): Promise<boolean> {
    if (!this.isCurrent()) return false;
    try {
      await this.refresh();
      return this.isCurrent();
    } catch {
      return false;
    }
  }

  isCurrent(): boolean {
    return !this.closed && productionAuditCapabilityIssuer.current(this.audit);
  }

  async resolvePrincipal(
    principalId: string,
    organizationId: OrganizationId,
  ): Promise<Omit<PrincipalContext, "credentialId"> | null> {
    if (organizationId !== this.client.relationship.node.organizationId) return null;
    await this.refresh();
    const entry = this.client.currentPolicy(principalId);
    if (!entry || entry.status !== "active") return null;
    return Object.freeze({
      principalType: entry.principalType,
      principalId: entry.principalId,
      organizationId,
      grants: structuredClone(entry.grants),
      grantVersion: entry.grantVersion,
    });
  }

  async listPrincipalRecords(
    organizationId: OrganizationId,
  ): Promise<readonly EnterprisePrincipalRecord[]> {
    if (organizationId !== this.client.relationship.node.organizationId) return Object.freeze([]);
    const entries = await this.refresh();
    return Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          principalType: entry.principalType,
          principalId: entry.principalId,
          organizationId,
          displayName: entry.displayName,
          status: entry.status,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        }),
      ),
    );
  }

  close(): void {
    this.closed = true;
  }

  private async refresh() {
    if (!this.isCurrent()) throw new Error("managed principal source is closed");
    const entries = await this.client.refreshPolicy();
    if (!this.isCurrent()) throw new Error("managed principal source is closed");
    await synchronizeAuthoritativeGrantRecords(
      this.grantStore,
      this.audit,
      entries.map((entry) => ({
        principalId: entry.principalId,
        organizationId: this.client.relationship.node.organizationId,
        grants: entry.status === "active" ? structuredClone(entry.grants) : [],
        grantVersion: entry.grantVersion,
      })),
    );
    if (!this.isCurrent()) throw new Error("managed principal source is closed");
    return entries;
  }
}
