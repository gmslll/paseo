import { describe, expect, test } from "vitest";
import { PRESENCE_TTL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { createCollabPresenceRoster } from "./presence-roster.js";

const ADA = "usr_aaaaaaaaaaaaaaaa";
const BOB = "usr_bbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-09-17T00:01:30.000Z");

describe("collab presence roster", () => {
  test("two Principals on the same Workspace see each other", () => {
    const roster = createCollabPresenceRoster();
    roster.beat({
      workspaceId: "ws-1",
      principalId: ADA,
      displayName: "Ada",
      clientId: "client-a",
      focusAgentId: "agent-1",
      nowMs: NOW,
    });
    const entries = roster.beat({
      workspaceId: "ws-1",
      principalId: BOB,
      displayName: "Bob",
      clientId: "client-b",
      focusAgentId: null,
      nowMs: NOW,
    });

    expect(entries.map((entry) => entry.kind === "principal" && entry.principalId)).toEqual([
      ADA,
      BOB,
    ]);
  });

  test("an expired heartbeat is dropped", () => {
    const roster = createCollabPresenceRoster();
    roster.beat({
      workspaceId: "ws-1",
      principalId: ADA,
      clientId: "client-a",
      focusAgentId: null,
      nowMs: NOW - PRESENCE_TTL_MS,
    });

    expect(roster.list("ws-1", NOW)).toEqual([]);
  });

  test("a different Workspace does not see this roster", () => {
    const roster = createCollabPresenceRoster();
    roster.beat({
      workspaceId: "ws-1",
      principalId: ADA,
      clientId: "client-a",
      focusAgentId: null,
      nowMs: NOW,
    });

    expect(roster.list("ws-2", NOW)).toEqual([]);
  });
});
