import {
  projectCurrentIdentity,
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

export interface EnterpriseIdentityHandlerDeps {
  readonly listPrincipals: (
    context: EnterpriseDispatchContext,
  ) => Promise<readonly EnterprisePrincipalRecord[]>;
  readonly logoutAll: (context: EnterpriseDispatchContext) => Promise<boolean>;
  readonly display?: {
    readonly displayName?: string;
    readonly navigation?: readonly string[];
    readonly allowedOperations?: readonly string[];
  };
}

export function createEnterpriseIdentityDispatcher(
  deps: EnterpriseIdentityHandlerDeps,
): EnterpriseSessionDispatcher {
  return {
    async handle({ sessionContext, message }): Promise<SessionOutboundMessage | false> {
      if (message.type === "enterprise.identity.get_current.request") {
        const identity: CurrentIdentityProjection = projectCurrentIdentity(
          sessionContext.enterpriseContext.principal,
          sessionContext.enterpriseContext.node,
          {
            displayName: deps.display?.displayName,
            navigation: deps.display?.navigation ?? [],
            allowedOperations: deps.display?.allowedOperations ?? [],
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
    consumeResponse: (({ response }) =>
      isIdentitySelfResponse(response)
        ? ({
            response,
            receiptClassification: "identity_self",
          } satisfies EnterpriseDispatchResponse)
        : null) satisfies EnterpriseResponseContextConsumer["consumeResponse"],
  };
}
