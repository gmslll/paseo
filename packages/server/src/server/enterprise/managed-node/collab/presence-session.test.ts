import { describe, expect, test } from "vitest";
import { createCollabPresenceRoster } from "./presence-roster.js";
import { handleCollabPresenceRequest } from "./presence-session.js";

const ADA = "usr_aaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-09-17T00:00:00.000Z");

describe("collab presence session", () => {
  test("a beat records the Principal and returns the roster", () => {
    const response = handleCollabPresenceRequest(
      createCollabPresenceRoster(),
      {
        type: "collab.presence.beat.request",
        requestId: "r1",
        workspaceId: "ws-1",
        clientId: "client-a",
        focusAgentId: "agent-1",
      },
      { principalId: ADA, displayName: "Ada" },
      NOW,
    );

    expect(response).toMatchObject({
      type: "collab.presence.beat.response",
      payload: {
        requestId: "r1",
        workspaceId: "ws-1",
        entries: [
          {
            kind: "principal",
            principalId: ADA,
            displayName: "Ada",
            clientId: "client-a",
            focusAgentId: "agent-1",
          },
        ],
      },
    });
  });

  test("without a Principal the roster is read and not written", () => {
    const roster = createCollabPresenceRoster();
    const response = handleCollabPresenceRequest(
      roster,
      {
        type: "collab.presence.beat.request",
        requestId: "r2",
        workspaceId: "ws-1",
        clientId: "client-a",
        focusAgentId: null,
      },
      null,
      NOW,
    );

    expect(response).toMatchObject({
      type: "collab.presence.beat.response",
      payload: { entries: [] },
    });
    expect(roster.list("ws-1", NOW)).toEqual([]);
  });
});
