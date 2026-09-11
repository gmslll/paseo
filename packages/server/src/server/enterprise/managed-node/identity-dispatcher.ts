import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResult,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../../session/enterprise-dispatcher.js";
import type { SessionInboundMessage } from "@getpaseo/protocol/messages";
import { createEnterpriseIdentityDispatcher } from "../identity/handlers.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import type { ManagedEnterpriseAdmission } from "./admission.js";
import type { ManagedPrincipalGrantSource } from "./principal-source.js";

export function createManagedIdentityDispatcherRegistration(input: {
  readonly admission: ManagedEnterpriseAdmission;
  readonly source: ManagedPrincipalGrantSource;
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
      const delegate = createEnterpriseIdentityDispatcher({
        listPrincipals: async ({ enterpriseContext }) => {
          if (!active) throw new Error("managed identity lease is closed");
          const result = await input.source.listPrincipalRecords(
            enterpriseContext.principal.organizationId,
          );
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          if (!active) throw new Error("managed identity lease is closed");
          return result;
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
