import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import {
  COLLAB_STREAM_TOKEN_UNAVAILABLE,
  type CollabStreamTokenControl,
} from "./stream-token-control.js";

export type CollabStreamTokenRequest = Extract<
  SessionInboundMessage,
  { type: "collab.stream.token.request" }
>;

export async function handleCollabStreamTokenRequest(
  control: CollabStreamTokenControl,
  msg: CollabStreamTokenRequest,
  actorPrincipalId: string | null,
): Promise<SessionOutboundMessage> {
  if (!actorPrincipalId) throw new Error(COLLAB_STREAM_TOKEN_UNAVAILABLE);
  const issued = await control.issue({
    workspaceId: msg.workspaceId,
    actorPrincipalId,
    clientId: msg.clientId,
  });
  return {
    type: "collab.stream.token.response",
    payload: {
      requestId: msg.requestId,
      workspaceId: msg.workspaceId,
      token: issued.token,
      expiresAt: issued.expiresAt,
      managementBaseUrl: issued.managementBaseUrl,
    },
  };
}

export { COLLAB_STREAM_TOKEN_UNAVAILABLE };
