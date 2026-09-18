import type {
  EnterprisePrincipalRecord,
  OrganizationId,
  SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResult,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../../session/enterprise-dispatcher.js";
import { createEnterpriseIdentityDispatcher } from "../identity/handlers.js";
import { createEnterpriseIdentityDisplayProjection } from "../identity/projection.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";

export interface ManagedIdentityPrincipalSource {
  isCurrent(): boolean;
  listPrincipalRecords(
    organizationId: OrganizationId,
  ): Promise<readonly EnterprisePrincipalRecord[]>;
}

export function createManagedIdentityDispatcherRegistration(input: {
  readonly source: ManagedIdentityPrincipalSource;
  readonly audit: ProductionAuditCapability;
}): EnterpriseSessionDispatcherFactoryRegistration {
  return Object.freeze({
    manifest: Object.freeze({
      operations: Object.freeze([
        "enterprise.identity.get_current.request",
        "enterprise.identity.list_principals.request",
      ]),
    }),
    open() {
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      if (!input.source.isCurrent()) throw new Error("managed identity source is unavailable");
      let active = true;
      const listCurrentPrincipalRecords = async (organizationId: OrganizationId) => {
        if (!active) throw new Error("managed identity lease is closed");
        const result = await input.source.listPrincipalRecords(organizationId);
        productionAuditCapabilityIssuer.requireCurrent(input.audit);
        if (!active || !input.source.isCurrent()) {
          throw new Error("managed identity source is unavailable");
        }
        return result;
      };
      const delegate = createEnterpriseIdentityDispatcher({
        display: async ({ enterpriseContext }) => {
          const principal = enterpriseContext.principal;
          if (principal.principalType === "break_glass_owner") {
            return createEnterpriseIdentityDisplayProjection(principal);
          }
          const records = await listCurrentPrincipalRecords(principal.organizationId);
          const record = records.find(
            (candidate) =>
              candidate.principalId === principal.principalId &&
              candidate.organizationId === principal.organizationId &&
              candidate.status === "active",
          );
          if (!record) throw new Error("managed identity projection is not current");
          return createEnterpriseIdentityDisplayProjection(principal, record.displayName);
        },
        listPrincipals: async ({ enterpriseContext }) => {
          return listCurrentPrincipalRecords(enterpriseContext.principal.organizationId);
        },
        logoutAll: async () => false,
      });
      const dispatcher: ReturnType<typeof createEnterpriseIdentityDispatcher> = Object.freeze({
        async handle(request: {
          readonly sessionContext: EnterpriseDispatchContext;
          readonly message: SessionInboundMessage;
        }): Promise<EnterpriseDispatchResult> {
          if (!active) return false;
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          const response = await delegate.handle(request);
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          return active ? response : false;
        },
        consumeResponse: delegate.consumeResponse,
      });
      return Object.freeze({
        dispatcher,
        close() {
          active = false;
        },
      });
    },
  });
}
