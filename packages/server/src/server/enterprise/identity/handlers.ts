import {
  type CurrentIdentityProjection,
  type EnterprisePrincipalRecord,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResponse,
  EnterpriseSessionDispatcher,
  EnterpriseResponseContextConsumer,
} from "../../session/enterprise-dispatcher.js";
import { isIdentitySelfResponse } from "../../session/enterprise-dispatcher.js";
import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";
import type { EnterpriseAdmission } from "./admission.js";
import type { ProductionPrincipalGrantSource } from "./principal-source.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import {
  createCurrentIdentityProjection,
  createEnterpriseIdentityDisplayProjection,
  type EnterpriseIdentityDisplayProjection,
} from "./projection.js";

export interface EnterpriseIdentityHandlerDeps {
  readonly listPrincipals: (
    context: EnterpriseDispatchContext,
  ) => Promise<readonly EnterprisePrincipalRecord[]>;
  readonly logoutAll: (context: EnterpriseDispatchContext) => Promise<boolean>;
  readonly display?:
    | Partial<EnterpriseIdentityDisplayProjection>
    | ((
        context: EnterpriseDispatchContext,
      ) =>
        | Partial<EnterpriseIdentityDisplayProjection>
        | Promise<Partial<EnterpriseIdentityDisplayProjection>>);
}

export function createEnterpriseIdentityDispatcher(
  deps: EnterpriseIdentityHandlerDeps,
): EnterpriseSessionDispatcher {
  return {
    async handle({ sessionContext, message }): Promise<SessionOutboundMessage | false> {
      if (message.type === "enterprise.identity.get_current.request") {
        const resolvedDisplay =
          typeof deps.display === "function"
            ? await deps.display(sessionContext)
            : (deps.display ?? {});
        const identity: CurrentIdentityProjection = createCurrentIdentityProjection(
          sessionContext.enterpriseContext.principal,
          sessionContext.enterpriseContext.node,
          {
            displayName: resolvedDisplay.displayName,
            navigation: resolvedDisplay.navigation ?? [],
            allowedOperations: resolvedDisplay.allowedOperations ?? [],
          },
        );
        return {
          type: "enterprise.identity.get_current.response",
          payload: { requestId: message.requestId, identity },
        };
      }
      if (message.type === "enterprise.identity.list_principals.request") {
        const principals = await deps.listPrincipals(sessionContext);
        return {
          type: "enterprise.identity.list_principals.response",
          payload: { requestId: message.requestId, principals: [...principals] },
        };
      }
      if (message.type === "enterprise.identity.logout_all.request") {
        const loggedOut = await deps.logoutAll(sessionContext);
        return {
          type: "enterprise.identity.logout_all.response",
          payload: { requestId: message.requestId, loggedOut },
        };
      }
      return false;
    },
    consumeResponse: (({ response }) => {
      if (response.type === "enterprise.identity.list_principals.response")
        return {
          response,
          receiptClassification: "authority",
        } satisfies EnterpriseDispatchResponse;
      return isIdentitySelfResponse(response)
        ? ({
            response,
            receiptClassification: "identity_self",
          } satisfies EnterpriseDispatchResponse)
        : null;
    }) satisfies EnterpriseResponseContextConsumer["consumeResponse"],
  };
}

export function createProductionEnterpriseIdentityDispatcherRegistration(input: {
  readonly admission: EnterpriseAdmission;
  readonly source: ProductionPrincipalGrantSource;
  readonly audit: ProductionAuditCapability;
}): EnterpriseSessionDispatcherFactoryRegistration {
  return {
    manifest: {
      operations: [
        "enterprise.identity.get_current.request",
        "enterprise.identity.list_principals.request",
        "enterprise.identity.logout_all.request",
      ],
    },
    open({ context: _context }) {
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      if (input.admission.audit !== input.audit || !input.source.isCurrent())
        throw new Error("enterprise identity registration is not current");
      let active = true;
      const dispatcher = createEnterpriseIdentityDispatcher({
        display: async ({ enterpriseContext }) => {
          if (!active) throw new Error("enterprise identity lease is closed");
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          if (enterpriseContext.principal.principalType === "break_glass_owner") {
            return createEnterpriseIdentityDisplayProjection(enterpriseContext.principal);
          }
          const records = await input.source.listPrincipalRecords(
            enterpriseContext.principal.organizationId,
          );
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          if (!active) throw new Error("enterprise identity lease is closed");
          const record = records.find(
            (candidate) =>
              candidate.principalId === enterpriseContext.principal.principalId &&
              candidate.organizationId === enterpriseContext.principal.organizationId &&
              candidate.status === "active",
          );
          if (!record) throw new Error("enterprise identity projection is not current");
          return createEnterpriseIdentityDisplayProjection(
            enterpriseContext.principal,
            record.displayName,
          );
        },
        listPrincipals: async ({ enterpriseContext }) => {
          if (!active) throw new Error("enterprise identity lease is closed");
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          const result = await input.source.listPrincipalRecords(
            enterpriseContext.principal.organizationId,
          );
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          if (!active) throw new Error("enterprise identity lease is closed");
          return result;
        },
        logoutAll: async ({ enterpriseContext }) => {
          if (!active) throw new Error("enterprise identity lease is closed");
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          const result =
            (await input.admission.registry.logoutAll(
              enterpriseContext.principal,
              enterpriseContext.principal.principalId,
              enterpriseContext.principal.organizationId,
            )) > 0;
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          if (!active) throw new Error("enterprise identity lease is closed");
          return result;
        },
      });
      const guardedDispatcher: EnterpriseSessionDispatcher = {
        handle: async (request) => {
          if (!active) return false;
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          const result = await dispatcher.handle(request);
          productionAuditCapabilityIssuer.requireCurrent(input.audit);
          return active ? result : false;
        },
        consumeResponse: dispatcher.consumeResponse
          ? (value) => {
              if (!active) return null;
              try {
                productionAuditCapabilityIssuer.requireCurrent(input.audit);
                return dispatcher.consumeResponse?.(value) ?? null;
              } catch {
                return null;
              }
            }
          : undefined,
        requestPolicyForType: dispatcher.requestPolicyForType
          ? (type) => {
              if (!active) return null;
              try {
                productionAuditCapabilityIssuer.requireCurrent(input.audit);
                return dispatcher.requestPolicyForType?.(type) ?? null;
              } catch {
                return null;
              }
            }
          : undefined,
      };
      return {
        dispatcher: guardedDispatcher,
        close: () => {
          active = false;
        },
      };
    },
  };
}
