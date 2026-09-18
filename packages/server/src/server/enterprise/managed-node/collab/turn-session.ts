import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import { COLLAB_TURN_UNAVAILABLE, type CollabTurnControl } from "./turn-control.js";

export type CollabTurnRequest = Extract<
  SessionInboundMessage,
  { type: "collab.turn.send.request" | "collab.turn.cancel.request" }
>;

export async function handleCollabTurnRequest(
  control: CollabTurnControl,
  msg: CollabTurnRequest,
  actor: { principalId: string; credentialId: string; clientId: string } | null,
): Promise<SessionOutboundMessage> {
  if (!actor) throw new Error(COLLAB_TURN_UNAVAILABLE);
  if (msg.type === "collab.turn.cancel.request") {
    const result = await control.cancel({
      workspaceId: msg.workspaceId,
      actorPrincipalId: actor.principalId,
      credentialId: actor.credentialId,
      clientId: actor.clientId,
      agentId: msg.agentId,
      requestId: msg.requestId,
    });
    return {
      type: "collab.turn.cancel.response",
      payload: {
        requestId: msg.requestId,
        workspaceId: msg.workspaceId,
        agentId: msg.agentId,
        accepted: result.accepted,
        ...(result.error ? { error: result.error } : {}),
      },
    };
  }
  const result = await control.send({
    workspaceId: msg.workspaceId,
    actorPrincipalId: actor.principalId,
    credentialId: actor.credentialId,
    clientId: actor.clientId,
    agentId: msg.agentId,
    text: msg.text,
    requestId: msg.requestId,
    messageId: msg.messageId,
    sharedTurnPolicy: msg.sharedTurnPolicy,
  });
  return {
    type: "collab.turn.send.response",
    payload: {
      requestId: msg.requestId,
      workspaceId: msg.workspaceId,
      agentId: msg.agentId,
      accepted: result.accepted,
      ...(result.error ? { error: result.error } : {}),
    },
  };
}
