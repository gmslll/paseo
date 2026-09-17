import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  CollabMembersListRequestSchema,
  CollabMembersListResponseSchema,
  CollabPresenceBeatRequestSchema,
  CollabPresenceBeatResponseSchema,
  CollabWorkspaceEnableRequestSchema,
  CollabWorkspaceEnableResponseSchema,
  ENTERPRISE_FEATURE_FLAGS,
  SendAgentMessageRequestSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

const NEW_FEATURES = {
  enterpriseCollaborationV1: true,
  localPlanes: true,
  terminalPlane: true,
  dataPlane: true,
  managedRuntimes: true,
  orchestrationOutbox: true,
  codeCollabTurnDiff: true,
  taskBoard: true,
  taskReview: true,
};

describe("collaboration and local runtime feature flags", () => {
  test("a new daemon advertises each flag as an optional server_info feature", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: NEW_FEATURES,
    });

    expect(parsed.features).toMatchObject(NEW_FEATURES);
  });

  test("an old daemon without the flags still parses", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "server-1",
      features: {},
    });

    for (const flag of Object.keys(NEW_FEATURES)) {
      expect(parsed.features?.[flag as keyof typeof NEW_FEATURES]).toBeUndefined();
    }
  });

  test("the frozen enterprise V1 flag list does not grow (ADR-0008)", () => {
    expect(ENTERPRISE_FEATURE_FLAGS).not.toContain("enterpriseCollaborationV1");
    expect(ENTERPRISE_FEATURE_FLAGS).toHaveLength(13);
  });
});

describe("collab member RPCs", () => {
  test("list members is optional on an old client and required fields parse", () => {
    const request = CollabMembersListRequestSchema.parse({
      type: "collab.members.list.request",
      requestId: "r1",
      workspaceId: "ws-1",
    });
    expect(request.workspaceId).toBe("ws-1");
    const response = CollabMembersListResponseSchema.parse({
      type: "collab.members.list.response",
      payload: {
        requestId: "r1",
        workspaceId: "ws-1",
        workspaceUid: "cws_0123456789abcdef",
        viewerRole: "owner",
        revoked: false,
        members: [{ principalId: "usr_aaaaaaaaaaaaaaaa", role: "owner" }],
      },
    });
    expect(response.payload.members).toHaveLength(1);
    const listed = CollabMembersListResponseSchema.parse({
      type: "collab.members.list.response",
      payload: {
        requestId: "r1",
        workspaceId: "ws-1",
        workspaceUid: null,
        viewerRole: null,
        revoked: false,
        members: [],
        collaborationEnabled: false,
        canEnable: true,
      },
    });
    expect(listed.payload.canEnable).toBe(true);
  });

  test("enable collaboration names the local workspace only", () => {
    const request = CollabWorkspaceEnableRequestSchema.parse({
      type: "collab.workspace.enable.request",
      requestId: "r3",
      workspaceId: "ws-1",
    });
    expect(request.workspaceId).toBe("ws-1");
    const response = CollabWorkspaceEnableResponseSchema.parse({
      type: "collab.workspace.enable.response",
      payload: {
        requestId: "r3",
        workspaceId: "ws-1",
        workspaceUid: "cws_0123456789abcdef",
        viewerRole: "owner",
        members: [{ principalId: "usr_aaaaaaaaaaaaaaaa", role: "owner" }],
      },
    });
    expect(response.payload.workspaceUid).toBe("cws_0123456789abcdef");
  });

  test("a presence beat carries the roster without a prompt", () => {
    const request = CollabPresenceBeatRequestSchema.parse({
      type: "collab.presence.beat.request",
      requestId: "r2",
      workspaceId: "ws-1",
      clientId: "client-a",
      focusAgentId: null,
    });
    expect(request.focusAgentId).toBeNull();
    const response = CollabPresenceBeatResponseSchema.parse({
      type: "collab.presence.beat.response",
      payload: {
        requestId: "r2",
        workspaceId: "ws-1",
        entries: [
          {
            kind: "principal",
            principalId: "usr_aaaaaaaaaaaaaaaa",
            clientId: "client-a",
            focusAgentId: null,
            heartbeatAt: "2026-09-17T00:00:00.000Z",
          },
        ],
      },
    });
    expect(response.payload.entries).toHaveLength(1);
  });
});

describe("shared turn attribution", () => {
  const author = { principalId: "usr_0123456789abcdef", displayName: "Alice" };

  test("user messages carry an optional author", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({ type: "user_message", text: "hi", author }),
    ).toEqual({ type: "user_message", text: "hi", author });
    expect(AgentTimelineItemPayloadSchema.parse({ type: "user_message", text: "hi" })).toEqual({
      type: "user_message",
      text: "hi",
    });
  });

  test("an author must be an authenticated Principal ID", () => {
    expect(
      AgentTimelineItemPayloadSchema.safeParse({
        type: "user_message",
        text: "hi",
        author: { principalId: "alice" },
      }).success,
    ).toBe(false);
  });

  test("an old app parses a user message that carries an author", () => {
    const LegacyUserMessageSchema = z.object({
      type: z.literal("user_message"),
      text: z.string(),
      messageId: z.string().optional(),
      clientMessageId: z.string().optional(),
    });

    expect(LegacyUserMessageSchema.parse({ type: "user_message", text: "hi", author })).toEqual({
      type: "user_message",
      text: "hi",
    });
  });

  test("send requests accept an optional shared turn policy and old daemons ignore it", () => {
    const request = {
      type: "send_agent_message_request",
      requestId: "request-1",
      agentId: "agent-1",
      text: "hi",
      sharedTurnPolicy: "queue",
    };
    expect(SendAgentMessageRequestSchema.parse(request).sharedTurnPolicy).toBe("queue");
    expect(
      SendAgentMessageRequestSchema.safeParse({ ...request, sharedTurnPolicy: "later" }).success,
    ).toBe(false);

    const LegacySendSchema = z.object({
      type: z.literal("send_agent_message_request"),
      requestId: z.string(),
      agentId: z.string(),
      text: z.string(),
    });
    expect(LegacySendSchema.parse(request)).not.toHaveProperty("sharedTurnPolicy");
  });

  test("Agent snapshots expose queued turns as optional metadata without prompt text", () => {
    const queuedTurns = AgentSnapshotPayloadSchema.shape.queuedTurns;
    const queued = [{ messageId: "m1", author, queuedAt: "2026-09-16T00:00:00.000Z" }];

    expect(queuedTurns.parse(undefined)).toBeUndefined();
    expect(queuedTurns.parse(queued)).toEqual(queued);
    expect(queuedTurns.parse([{ ...queued[0], text: "secret prompt" }])).toEqual(queued);
  });
});
