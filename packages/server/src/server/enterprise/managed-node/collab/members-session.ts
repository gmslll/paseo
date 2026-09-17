import type { SessionInboundMessage, SessionOutboundMessage } from "../../../messages.js";
import { COLLAB_MEMBERS_UNAVAILABLE, type CollabMembersControl } from "./members-control.js";

export type CollabMembersRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "collab.members.list.request"
      | "collab.members.set.request"
      | "collab.members.remove.request";
  }
>;

export function collabMembersAction(
  type: CollabMembersRequest["type"],
): "workspace.metadata.read" | "workspace.manage" {
  return type === "collab.members.list.request" ? "workspace.metadata.read" : "workspace.manage";
}

export async function handleCollabMembersRequest(
  control: CollabMembersControl,
  msg: CollabMembersRequest,
  actorPrincipalId: string | null,
): Promise<SessionOutboundMessage> {
  switch (msg.type) {
    case "collab.members.list.request": {
      const snapshot = control.list(msg.workspaceId, actorPrincipalId);
      return {
        type: "collab.members.list.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          workspaceUid: snapshot.workspaceUid,
          viewerRole: snapshot.viewerRole,
          revoked: snapshot.revoked,
          revokeReason: snapshot.revokeReason,
          members: [...snapshot.members],
        },
      };
    }
    case "collab.members.set.request": {
      if (!actorPrincipalId) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      const members = await control.set(
        msg.workspaceId,
        actorPrincipalId,
        msg.principalId,
        msg.role,
      );
      return {
        type: "collab.members.set.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          members: [...members],
        },
      };
    }
    case "collab.members.remove.request": {
      if (!actorPrincipalId) throw new Error(COLLAB_MEMBERS_UNAVAILABLE);
      const members = await control.remove(msg.workspaceId, actorPrincipalId, msg.principalId);
      return {
        type: "collab.members.remove.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          members: [...members],
        },
      };
    }
  }
}
