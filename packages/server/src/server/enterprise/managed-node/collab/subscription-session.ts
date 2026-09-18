import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import {
  COLLAB_SUBSCRIPTION_UNAVAILABLE,
  type CollabSubscriptionControl,
} from "./subscription-control.js";

export type CollabSubscriptionRequest = Extract<
  SessionInboundMessage,
  { type: "collab.subscription.poll.request" }
>;

export async function handleCollabSubscriptionRequest(
  control: CollabSubscriptionControl,
  msg: CollabSubscriptionRequest,
  actorPrincipalId: string | null,
): Promise<SessionOutboundMessage> {
  if (!actorPrincipalId) throw new Error(COLLAB_SUBSCRIPTION_UNAVAILABLE);
  const result = await control.poll({
    workspaceId: msg.workspaceId,
    actorPrincipalId,
    clientId: msg.clientId,
    ...(msg.subscriptionId ? { subscriptionId: msg.subscriptionId } : {}),
  });
  return {
    type: "collab.subscription.poll.response",
    payload: {
      requestId: msg.requestId,
      workspaceId: msg.workspaceId,
      subscriptionId: result.subscriptionId,
      events: [...result.events],
    },
  };
}

export { COLLAB_SUBSCRIPTION_UNAVAILABLE };
