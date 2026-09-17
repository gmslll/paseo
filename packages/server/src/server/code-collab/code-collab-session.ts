import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { TurnDiffControl } from "./turn-diff-runtime.js";

export const TURN_DIFF_UNAVAILABLE = "Per-turn diffs are unavailable on this daemon";

export type CodeCollabTurnDiffRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "code_collab.turn_diff.list_turns.request"
      | "code_collab.turn_diff.get_files.request"
      | "code_collab.all_changes.get_diff.request";
  }
>;

export function codeCollabTurnDiffAction(
  type: CodeCollabTurnDiffRequest["type"],
): "workspace.metadata.read" | "workspace.content.read" {
  return type === "code_collab.turn_diff.list_turns.request"
    ? "workspace.metadata.read"
    : "workspace.content.read";
}

export async function handleCodeCollabTurnDiffRequest(
  control: TurnDiffControl,
  msg: CodeCollabTurnDiffRequest,
): Promise<SessionOutboundMessage> {
  switch (msg.type) {
    case "code_collab.turn_diff.list_turns.request":
      return {
        type: "code_collab.turn_diff.list_turns.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          turns: await control.listTurns({
            workspaceId: msg.workspaceId,
            agentId: msg.agentId,
            limit: msg.limit,
          }),
        },
      };
    case "code_collab.turn_diff.get_files.request":
      return {
        type: "code_collab.turn_diff.get_files.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          turnId: msg.turnId,
          files: await control.getFiles({
            workspaceId: msg.workspaceId,
            turnId: msg.turnId,
            ignoreWhitespace: msg.ignoreWhitespace,
          }),
        },
      };
    case "code_collab.all_changes.get_diff.request":
      return {
        type: "code_collab.all_changes.get_diff.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          files: await control.getAllChanges({
            workspaceId: msg.workspaceId,
            agentId: msg.agentId,
            ignoreWhitespace: msg.ignoreWhitespace,
          }),
        },
      };
  }
}
