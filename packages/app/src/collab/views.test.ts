import { describe, expect, test } from "vitest";
import { PRESENCE_TTL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { COLLAB_COPY } from "./copy";
import {
  projectAuthorLabel,
  projectPresence,
  projectQueuedTurnBanner,
  projectRevokeBanner,
} from "./views";

const copy = COLLAB_COPY.en;
const ADA = "usr_aaaaaaaaaaaaaaaa";
const BOB = "usr_bbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-09-17T00:01:30.000Z");

describe("collab views", () => {
  test("presence keeps live people, drops expired heartbeats, and hides nodes", () => {
    const people = projectPresence({
      now: NOW,
      viewerPrincipalId: ADA,
      copy,
      entries: [
        {
          kind: "node",
          nodeId: "nod_0123456789abcdef",
          heartbeatAt: "2026-09-17T00:01:30.000Z",
        },
        {
          kind: "principal",
          principalId: BOB,
          displayName: "Bob",
          clientId: "client-old",
          focusAgentId: null,
          heartbeatAt: new Date(NOW - PRESENCE_TTL_MS).toISOString(),
        },
        {
          kind: "principal",
          principalId: ADA,
          displayName: "Ada",
          clientId: "client-a",
          focusAgentId: "agent-1",
          heartbeatAt: "2026-09-17T00:01:00.000Z",
        },
        {
          kind: "principal",
          principalId: ADA,
          displayName: "Ada",
          clientId: "client-b",
          focusAgentId: null,
          heartbeatAt: "2026-09-17T00:01:20.000Z",
        },
      ],
    });

    expect(people).toEqual([
      {
        principalId: ADA,
        label: "You",
        isSelf: true,
        clientCount: 2,
        focusAgentId: "agent-1",
      },
    ]);
  });

  test("an author label is the display name, or You, and stays hidden without an author", () => {
    expect(
      projectAuthorLabel({
        author: { principalId: BOB, displayName: "Bob" },
        viewerPrincipalId: ADA,
        copy,
      }),
    ).toBe("Bob");
    expect(
      projectAuthorLabel({
        author: { principalId: ADA },
        viewerPrincipalId: ADA,
        copy,
      }),
    ).toBe("You");
    expect(projectAuthorLabel({ author: null, viewerPrincipalId: ADA, copy })).toBeNull();
  });

  test("a single other person's queued turn names them", () => {
    expect(
      projectQueuedTurnBanner({
        viewerPrincipalId: ADA,
        copy,
        queuedTurns: [
          {
            messageId: "m1",
            author: { principalId: BOB, displayName: "Bob" },
            queuedAt: "2026-09-17T00:00:01.000Z",
          },
        ],
      }),
    ).toEqual({ title: "Bob is waiting", description: "" });
  });

  test("the queued banner never includes prompt text and names the waiting person", () => {
    const banner = projectQueuedTurnBanner({
      viewerPrincipalId: ADA,
      copy,
      queuedTurns: [
        {
          messageId: "m2",
          author: { principalId: BOB, displayName: "Bob" },
          queuedAt: "2026-09-17T00:00:02.000Z",
        },
        {
          messageId: "m1",
          author: { principalId: BOB, displayName: "Bob" },
          queuedAt: "2026-09-17T00:00:01.000Z",
        },
      ],
    });

    expect(banner).toEqual({ title: "2 messages waiting", description: "" });
    expect(JSON.stringify(banner)).not.toMatch(/secret|prompt|hi/i);
  });

  test("your own queued turn is called out without the others' names", () => {
    expect(
      projectQueuedTurnBanner({
        viewerPrincipalId: ADA,
        copy,
        queuedTurns: [
          {
            messageId: "m1",
            author: { principalId: ADA },
            queuedAt: "2026-09-17T00:00:01.000Z",
          },
        ],
      }),
    ).toEqual({ title: "Your message is waiting", description: "" });
  });

  test("a membership revoke has a specific banner, a live replica has none", () => {
    expect(
      projectRevokeBanner({
        revoked: true,
        reason: "membership_removed",
        copy,
      }),
    ).toEqual({
      title: "Access removed",
      description: "You no longer have access to this workspace.",
    });
    expect(projectRevokeBanner({ revoked: false, reason: null, copy })).toBeNull();
  });
});
