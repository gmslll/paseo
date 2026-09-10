import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { OutboundAuthorityReceiptPolicy } from "../enterprise/access/event-action-map.js";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";

/** The server-bound context supplied to an enterprise RPC handler. */
export interface EnterpriseDispatchContext {
  readonly sessionId: string;
  readonly clientId: string;
  /** Server-retained credential identifier; raw credentials never cross this seam. */
  readonly credentialId: string;
  readonly sessionBindingGeneration: string;
  readonly enterpriseContext: EnterpriseSessionContext;
}

export type EnterpriseDispatchResult = SessionOutboundMessage | false;
export type EnterpriseIdentityRequestType =
  | "enterprise.identity.get_current.request"
  | "enterprise.identity.logout_all.request";
export type EnterpriseIdentityResponseType =
  | "enterprise.identity.get_current.response"
  | "enterprise.identity.logout_all.response";
export interface EnterpriseIdentitySelfPolicyDescriptor {
  readonly requestTypes: readonly EnterpriseIdentityRequestType[];
  readonly responseTypes: readonly EnterpriseIdentityResponseType[];
  readonly requiresCurrentSessionBinding: true;
}
export const ENTERPRISE_IDENTITY_SELF_POLICY: EnterpriseIdentitySelfPolicyDescriptor =
  Object.freeze({
    requestTypes: Object.freeze([
      "enterprise.identity.get_current.request",
      "enterprise.identity.logout_all.request",
    ] as const),
    responseTypes: Object.freeze([
      "enterprise.identity.get_current.response",
      "enterprise.identity.logout_all.response",
    ] as const),
    requiresCurrentSessionBinding: true,
  });
export function registerEnterpriseIdentitySelfPolicy(
  dispatcher: EnterpriseSessionDispatcher,
): EnterpriseSessionDispatcher {
  return {
    handle: async (input) => {
      const result = await dispatcher.handle(input);
      if (result === false) return false;
      return isIdentitySelfResponse(result) ? result : false;
    },
  };
}
export function isIdentitySelfRequest(message: SessionInboundMessage): boolean {
  return (
    message.type === "enterprise.identity.get_current.request" ||
    message.type === "enterprise.identity.logout_all.request"
  );
}
export function isIdentitySelfResponse(message: SessionOutboundMessage): boolean {
  return (
    message.type === "enterprise.identity.get_current.response" ||
    message.type === "enterprise.identity.logout_all.response"
  );
}
export function resolveEnterpriseReceiptPolicy(
  requestType: string,
): OutboundAuthorityReceiptPolicy | null {
  if (requestType === "enterprise.identity.get_current.request") {
    return {
      event: "enterprise.identity.get_current.response",
      requestType: "enterprise.identity.get_current.request",
      daemonPermission: null,
      enterpriseActions: ["identity.manage"],
      emission: "terminal",
    };
  }
  if (requestType === "enterprise.identity.logout_all.request") {
    return {
      event: "enterprise.identity.logout_all.response",
      requestType: "enterprise.identity.logout_all.request",
      daemonPermission: null,
      enterpriseActions: ["identity.manage"],
      emission: "terminal",
    };
  }
  return null;
}

/** W3 routing seam; domain policy and handlers remain owned by their workstreams. */
export interface EnterpriseSessionDispatcher {
  handle(input: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
  }): Promise<SessionOutboundMessage | false> | SessionOutboundMessage | false;
}

export const ENTERPRISE_UNAVAILABLE_ERROR = "Enterprise operation unavailable";

export function isEnterpriseRequest(message: SessionInboundMessage): boolean {
  return message.type.startsWith("enterprise.") && message.type.endsWith(".request");
}

export async function dispatchEnterpriseRequest(
  dispatcher: EnterpriseSessionDispatcher | null,
  sessionContext: EnterpriseDispatchContext,
  message: SessionInboundMessage,
): Promise<SessionOutboundMessage | false> {
  if (!dispatcher) return false;
  return await dispatcher.handle({ sessionContext, message });
}
