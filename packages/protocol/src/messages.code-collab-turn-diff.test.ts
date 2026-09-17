import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  CodeCollabAllChangesGetDiffRequestSchema,
  CodeCollabTurnDiffGetFilesRequestSchema,
  CodeCollabTurnDiffListTurnsRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const turn = {
  turnId: "turn-1",
  agentId: "agent-1",
  startedAt: "2026-09-16T08:00:00.000Z",
  endedAt: "2026-09-16T08:01:00.000Z",
  fileCount: 2,
};

const file = {
  path: "src/a.ts",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 1,
  hunks: [],
};

describe("code collab turn-diff RPCs", () => {
  test("the session union accepts list, get_files, and all_changes requests", () => {
    const list = {
      type: "code_collab.turn_diff.list_turns.request",
      requestId: "r1",
      workspaceId: "wks_1",
      agentId: "agent-1",
      limit: 20,
    };
    const files = {
      type: "code_collab.turn_diff.get_files.request",
      requestId: "r2",
      workspaceId: "wks_1",
      turnId: "turn-1",
    };
    const all = {
      type: "code_collab.all_changes.get_diff.request",
      requestId: "r3",
      workspaceId: "wks_1",
    };

    expect(SessionInboundMessageSchema.parse(list)).toEqual(list);
    expect(SessionInboundMessageSchema.parse(files)).toEqual(files);
    expect(SessionInboundMessageSchema.parse(all)).toEqual(all);
    expect(
      CodeCollabTurnDiffListTurnsRequestSchema.safeParse({ ...list, limit: 201 }).success,
    ).toBe(false);
    expect(
      CodeCollabTurnDiffGetFilesRequestSchema.safeParse({ ...files, turnId: "" }).success,
    ).toBe(true);
    expect(
      CodeCollabAllChangesGetDiffRequestSchema.safeParse({ ...all, ignoreWhitespace: true })
        .success,
    ).toBe(true);
  });

  test("clients parse responses, including an empty turn", () => {
    const list = {
      type: "code_collab.turn_diff.list_turns.response",
      payload: { requestId: "r1", workspaceId: "wks_1", turns: [turn] },
    };
    const files = {
      type: "code_collab.turn_diff.get_files.response",
      payload: { requestId: "r2", workspaceId: "wks_1", turnId: "turn-1", files: [file] },
    };
    const empty = {
      type: "code_collab.all_changes.get_diff.response",
      payload: { requestId: "r3", workspaceId: "wks_1", files: [] },
    };

    expect(SessionOutboundMessageSchema.parse(list)).toEqual(list);
    expect(SessionOutboundMessageSchema.parse(files)).toEqual(files);
    expect(SessionOutboundMessageSchema.parse(empty)).toEqual(empty);
  });

  test("an older client parses fields a newer daemon adds", () => {
    const LegacyTurnSchema = z.object({
      turnId: z.string(),
      agentId: z.string(),
      fileCount: z.number(),
    });
    const newer = { ...turn, author: "alice", additions: 4 };

    expect(LegacyTurnSchema.parse(newer)).toEqual({
      turnId: "turn-1",
      agentId: "agent-1",
      fileCount: 2,
    });
  });
});
