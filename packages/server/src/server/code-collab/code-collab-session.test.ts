import { describe, expect, test } from "vitest";

import {
  handleCodeCollabTurnDiffRequest,
  codeCollabTurnDiffAction,
} from "./code-collab-session.js";
import type { TurnDiffControl } from "./turn-diff-runtime.js";

const turns = [
  {
    turnId: "turn-1",
    agentId: "agent-1",
    startedAt: "2026-09-16T08:00:00.000Z",
    endedAt: "2026-09-16T08:01:00.000Z",
    fileCount: 1,
  },
];

const files = [
  {
    path: "src/a.ts",
    isNew: false,
    isDeleted: false,
    additions: 1,
    deletions: 0,
    hunks: [],
  },
];

function control(overrides: Partial<TurnDiffControl> = {}): TurnDiffControl {
  return {
    listTurns: async () => turns,
    getFiles: async () => files,
    getAllChanges: async () => files,
    close: async () => undefined,
    ...overrides,
  };
}

describe("code collab session RPCs", () => {
  test("list_turns is metadata; file bodies are content", () => {
    expect(codeCollabTurnDiffAction("code_collab.turn_diff.list_turns.request")).toBe(
      "workspace.metadata.read",
    );
    expect(codeCollabTurnDiffAction("code_collab.turn_diff.get_files.request")).toBe(
      "workspace.content.read",
    );
    expect(codeCollabTurnDiffAction("code_collab.all_changes.get_diff.request")).toBe(
      "workspace.content.read",
    );
  });

  test("list_turns returns what the store listed", async () => {
    const response = await handleCodeCollabTurnDiffRequest(control(), {
      type: "code_collab.turn_diff.list_turns.request",
      requestId: "r1",
      workspaceId: "wks_1",
      agentId: "agent-1",
    });

    expect(response).toEqual({
      type: "code_collab.turn_diff.list_turns.response",
      payload: { requestId: "r1", workspaceId: "wks_1", turns },
    });
  });

  test("get_files returns the parsed diff for that turn", async () => {
    const response = await handleCodeCollabTurnDiffRequest(control(), {
      type: "code_collab.turn_diff.get_files.request",
      requestId: "r2",
      workspaceId: "wks_1",
      turnId: "turn-1",
    });

    expect(response).toEqual({
      type: "code_collab.turn_diff.get_files.response",
      payload: { requestId: "r2", workspaceId: "wks_1", turnId: "turn-1", files },
    });
  });

  test("an unknown turn is an empty file list, not a guessed diff", async () => {
    const response = await handleCodeCollabTurnDiffRequest(control({ getFiles: async () => [] }), {
      type: "code_collab.turn_diff.get_files.request",
      requestId: "r3",
      workspaceId: "wks_1",
      turnId: "missing",
    });

    expect(response).toEqual({
      type: "code_collab.turn_diff.get_files.response",
      payload: { requestId: "r3", workspaceId: "wks_1", turnId: "missing", files: [] },
    });
  });

  test("all_changes returns the accumulated files", async () => {
    const response = await handleCodeCollabTurnDiffRequest(control(), {
      type: "code_collab.all_changes.get_diff.request",
      requestId: "r4",
      workspaceId: "wks_1",
    });

    expect(response).toEqual({
      type: "code_collab.all_changes.get_diff.response",
      payload: { requestId: "r4", workspaceId: "wks_1", files },
    });
  });
});
