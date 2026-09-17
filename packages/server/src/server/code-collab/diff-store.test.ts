import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDiffStorePath, diffStorePaths } from "./diff-paths.js";
import { CHUNK_BYTES, DiffStore, MAX_CONTENT_BYTES } from "./diff-store.js";

const WORKSPACE = "wks_0123456789abcdef";

let home: string;
let store: DiffStore;
let clock: number;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "diff-store-"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
  store = DiffStore.open({
    path: ensureDiffStorePath(diffStorePaths(home), WORKSPACE),
    now: () => clock,
  });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("storing what a turn changed", () => {
  test("content survives the round trip through compression and chunking", () => {
    // Larger than one chunk, so reassembly order is exercised rather than assumed.
    const content = text("line\n".repeat(CHUNK_BYTES / 2));

    const recorded = store.putContent(content);

    expect(recorded.kind).toBe("text");
    expect(store.readContent(recorded.sha256!)).toEqual(content);
  });

  test("an empty file is content, not an absence", () => {
    const recorded = store.putContent(text(""));

    expect(recorded.kind).toBe("text");
    expect(store.readContent(recorded.sha256!)).toEqual(text(""));
  });

  test("the same bytes are stored once, however many files hold them", () => {
    const content = text("shared\n".repeat(1000));

    const first = store.putContent(content);
    const second = store.putContent(content);

    expect(second.sha256).toBe(first.sha256);
    // One snapshot and one chunk row: a file a turn left untouched costs nothing to record again.
    expect(countRows(store, "snapshots")).toBe(1);
    expect(countRows(store, "chunks")).toBe(1);
  });

  test("two files sharing a leading chunk share that chunk", () => {
    const shared = "a".repeat(CHUNK_BYTES);

    const first = store.putContent(text(`${shared}first`));
    const second = store.putContent(text(`${shared}second`));

    expect(second.sha256).not.toBe(first.sha256);
    // Two snapshots, three chunks: the shared leading chunk is stored once.
    expect(countRows(store, "snapshots")).toBe(2);
    expect(countRows(store, "chunks")).toBe(3);
  });

  test("binary and oversized content is recorded by kind without content", () => {
    const binary = new Uint8Array([0x89, 0x50, 0x00, 0x4e, 0x47]);
    const oversized = new Uint8Array(MAX_CONTENT_BYTES + 1);

    expect(store.putContent(binary)).toEqual({ kind: "binary", sha256: null });
    // No diff a reader could use, so ADR-0044 keeps it out rather than paying to compress it.
    expect(store.putContent(oversized)).toEqual({ kind: "too_large", sha256: null });
    expect(countRows(store, "snapshots")).toBe(0);
  });

  test("an unknown snapshot reads as absent rather than throwing", () => {
    expect(store.readContent("f".repeat(64))).toBeNull();
  });
});

describe("what a turn recorded", () => {
  test("keeps each file's before and after, and leaves the head where the turn left it", () => {
    const before = store.putContent(text("one\n"));
    const after = store.putContent(text("two\n"));

    store.recordTurn({
      turnId: "turn-1",
      agentId: "agent-1",
      startedAt: clock,
      endedAt: clock + 1000,
      files: [{ path: "src/a.ts", before, after }],
    });

    expect(store.listTurns()).toEqual([
      { turnId: "turn-1", agentId: "agent-1", startedAt: clock, endedAt: clock + 1000 },
    ]);
    expect(store.turnFiles("turn-1")).toEqual([
      {
        path: "src/a.ts",
        kind: "text",
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
      },
    ]);
    // The next turn's before image is this turn's after image, without re-reading the working tree.
    expect(store.pathHead("src/a.ts")).toEqual({ kind: "text", sha256: after.sha256 });
  });

  test("an edit outside a turn moves the head, so the next turn does not claim it", () => {
    const byTurn = store.putContent(text("from the turn\n"));
    store.recordTurn({
      turnId: "turn-1",
      agentId: "agent-1",
      startedAt: clock,
      endedAt: clock + 1,
      files: [{ path: "src/a.ts", before: { kind: "missing", sha256: null }, after: byTurn }],
    });

    const byHand = store.putContent(text("edited by hand\n"));
    store.setPathHead("src/a.ts", byHand);

    expect(store.pathHead("src/a.ts")).toEqual({ kind: "text", sha256: byHand.sha256 });
    // The turn's own record is unchanged: what it did is not rewritten by what happened after.
    expect(store.turnFiles("turn-1")[0]!.afterSha256).toBe(byTurn.sha256);
  });

  test("newest turns come back first", () => {
    for (const [index, turnId] of ["turn-1", "turn-2", "turn-3"].entries()) {
      store.recordTurn({
        turnId,
        agentId: "agent-1",
        startedAt: clock + index * 1000,
        endedAt: null,
        files: [],
      });
    }

    expect(store.listTurns().map((turn) => turn.turnId)).toEqual(["turn-3", "turn-2", "turn-1"]);
  });

  test("a path with no head reads as absent", () => {
    expect(store.pathHead("never/seen.ts")).toBeNull();
  });
});

/** Reads a table's size through the store's own database handle. */
function countRows(subject: DiffStore, table: string): number {
  const database = Reflect.get(subject, "database") as {
    prepare(sql: string): { get(): unknown };
  };
  return (database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number })
    .total;
}
