import { describe, expect, test } from "vitest";

import { pageSessionTimeline, parseSessionRowKey } from "./crdt-timeline-source";

function row(seq: number, text: string) {
  return {
    seq,
    timestamp: "2026-09-17T00:00:00.000Z",
    item: { type: "user_message", text },
  };
}

function key(epoch: string, seq: number): string {
  return `${epoch}/${String(seq).padStart(12, "0")}`;
}

describe("session timeline pages", () => {
  test("a tail page is the latest rows of that epoch, ordered by seq", () => {
    const rows = {
      [key("e1", 1)]: row(1, "one"),
      [key("e2", 1)]: row(1, "other-epoch"),
      [key("e1", 3)]: row(3, "three"),
      [key("e1", 2)]: row(2, "two"),
    };

    const page = pageSessionTimeline(rows, { epoch: "e1", limit: 2 });

    expect(page.items.map((item) => (item.item as { text: string }).text)).toEqual([
      "two",
      "three",
    ]);
    expect(page.hasOlder).toBe(true);
    expect(page.nextCursor).toEqual({ epoch: "e1", seq: 2 });
  });

  test("before walks older rows without crossing the epoch", () => {
    const rows = {
      [key("e1", 1)]: row(1, "one"),
      [key("e1", 2)]: row(2, "two"),
      [key("e1", 3)]: row(3, "three"),
    };

    const page = pageSessionTimeline(rows, {
      epoch: "e1",
      limit: 2,
      direction: "before",
      beforeSeq: 3,
    });

    expect(page.items.map((item) => (item.item as { text: string }).text)).toEqual(["one", "two"]);
    expect(page.hasOlder).toBe(false);
  });

  test("a row key is epoch then a 12-digit seq, the same shape the projector writes", () => {
    expect(parseSessionRowKey(key("abc", 7))).toEqual({ epoch: "abc", seq: 7 });
    expect(parseSessionRowKey("not-a-row")).toBeNull();
  });
});
