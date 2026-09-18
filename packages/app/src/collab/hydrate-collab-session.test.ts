import { describe, expect, test } from "vitest";
import { displayedCollabStream, hydrateCollabSessionDocument } from "./hydrate-collab-session";
import type { StreamItem } from "@/types/stream";

function key(epoch: string, seq: number): string {
  return `${epoch}/${String(seq).padStart(12, "0")}`;
}

describe("hydrateCollabSessionDocument", () => {
  test("pages committed rows into stream items in seq order and keeps in-flight text in the head", () => {
    const hydrated = hydrateCollabSessionDocument({
      epoch: "e1",
      provider: "claude",
      rows: {
        [key("e1", 1)]: {
          seq: 1,
          timestamp: "2026-09-18T00:00:00.000Z",
          item: {
            type: "user_message",
            text: "hi",
            author: { principalId: "usr_aaaaaaaaaaaaaaaa" },
          },
        },
        [key("e1", 2)]: {
          seq: 2,
          timestamp: "2026-09-18T00:00:01.000Z",
          item: { type: "assistant_message", text: "hello" },
        },
        [key("e2", 1)]: {
          seq: 1,
          timestamp: "2026-09-18T00:00:02.000Z",
          item: { type: "user_message", text: "other epoch" },
        },
      },
      stream: { turnId: "turn-9", text: "still typing" },
    });

    expect(hydrated.items.map((item) => item.kind)).toEqual(["user_message", "assistant_message"]);
    expect(hydrated.items[0]).toMatchObject({
      kind: "user_message",
      text: "hi",
      author: { principalId: "usr_aaaaaaaaaaaaaaaa" },
    });
    expect(hydrated.head).toMatchObject([{ kind: "assistant_message", text: "still typing" }]);
    expect(hydrated.hasOlder).toBe(false);
  });

  test("skips rows that are not timeline items", () => {
    const hydrated = hydrateCollabSessionDocument({
      epoch: "e1",
      provider: "claude",
      rows: {
        [key("e1", 1)]: {
          seq: 1,
          timestamp: "2026-09-18T00:00:00.000Z",
          item: { not: "a timeline item" },
        },
      },
      stream: null,
    });

    expect(hydrated.items).toEqual([]);
    expect(hydrated.head).toEqual([]);
  });

  test("a CRDT page replaces the daemon stream; an unread replica leaves it in place", () => {
    const local: StreamItem[] = [
      { kind: "user_message", id: "local", text: "local", timestamp: new Date() },
    ];
    const plane: StreamItem[] = [
      { kind: "user_message", id: "plane", text: "plane", timestamp: new Date() },
    ];
    expect(displayedCollabStream({ items: null, head: null }, local, undefined).items).toBe(local);
    expect(displayedCollabStream({ items: plane, head: [] }, local, undefined)).toEqual({
      items: plane,
      head: [],
    });
  });
});
