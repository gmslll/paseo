import type { SessionInboundMessage } from "../messages.js";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";

/** The server-bound context supplied to an enterprise RPC handler. */
export interface EnterpriseDispatchContext {
  readonly sessionId: string;
  readonly clientId: string;
  /** Server-retained credential identifier; raw credentials never cross this seam. */
  readonly credentialId: string;
  readonly enterpriseContext: EnterpriseSessionContext;
}

/** W3 routing seam; domain policy and handlers remain owned by their workstreams. */
export interface EnterpriseSessionDispatcher {
  handle(input: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
  }): Promise<boolean> | boolean;
}

export const ENTERPRISE_UNAVAILABLE_ERROR = "Enterprise operation unavailable";

export function isEnterpriseRequest(message: SessionInboundMessage): boolean {
  return message.type.startsWith("enterprise.") && message.type.endsWith(".request");
}

export async function dispatchEnterpriseRequest(
  dispatcher: EnterpriseSessionDispatcher | null,
  sessionContext: EnterpriseDispatchContext,
  message: SessionInboundMessage,
): Promise<boolean> {
  if (!dispatcher) return false;
  return (await dispatcher.handle({ sessionContext, message })) === true;
}
