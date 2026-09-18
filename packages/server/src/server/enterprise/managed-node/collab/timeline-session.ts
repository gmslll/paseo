import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import { COLLAB_TIMELINE_UNAVAILABLE, type CollabTimelineControl } from "./timeline-control.js";

export type CollabTimelineRequest = Extract<
  SessionInboundMessage,
  { type: "collab.timeline.get.request" }
>;

export function handleCollabTimelineRequest(
  control: CollabTimelineControl,
  msg: CollabTimelineRequest,
): SessionOutboundMessage {
  const document = control.get(msg.workspaceId, msg.agentId);
  return {
    type: "collab.timeline.get.response",
    payload: {
      requestId: msg.requestId,
      workspaceId: msg.workspaceId,
      agentId: msg.agentId,
      epoch: document.epoch,
      rows: document.rows,
      stream: document.stream,
    },
  };
}

export { COLLAB_TIMELINE_UNAVAILABLE };
