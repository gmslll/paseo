import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import type { CollabPresenceControl } from "./presence-roster.js";

export type CollabPresenceRequest = Extract<
  SessionInboundMessage,
  { type: "collab.presence.beat.request" }
>;

export function handleCollabPresenceRequest(
  control: CollabPresenceControl,
  msg: CollabPresenceRequest,
  actor: { principalId: string; displayName?: string } | null,
  nowMs: number,
  hostNodeId: string | null = null,
): SessionOutboundMessage {
  const entries =
    actor === null
      ? control.list(msg.workspaceId, nowMs)
      : control.beat({
          workspaceId: msg.workspaceId,
          principalId: actor.principalId,
          displayName: actor.displayName ?? msg.displayName,
          clientId: msg.clientId,
          focusAgentId: msg.focusAgentId,
          nowMs,
        });
  return {
    type: "collab.presence.beat.response",
    payload: {
      requestId: msg.requestId,
      workspaceId: msg.workspaceId,
      entries: [...entries],
      ...(hostNodeId
        ? { hostNode: { nodeId: hostNodeId, heartbeatAt: new Date(nowMs).toISOString() } }
        : {}),
    },
  };
}
