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

describe("making room", () => {
  /** A turn that wrote one file nobody else references, so dropping it should release the bytes. */
  function turnWriting(turnId: string, startedAt: number, content: string): void {
    const after = store.putContent(text(content));
    store.recordTurn({
      turnId,
      agentId: "agent-1",
      startedAt,
      endedAt: startedAt + 1,
      files: [{ path: `${turnId}.txt`, before: { kind: "missing", sha256: null }, after }],
    });
    // The head would otherwise hold this content alive after the turn is gone.
    store.setPathHead(`${turnId}.txt`, { kind: "missing", sha256: null });
  }

  test("an expired turn takes its chunks with it", () => {
    turnWriting("turn-old", clock, "old content\n".repeat(100));
    turnWriting("turn-new", clock + 10_000, "new content\n".repeat(100));
    expect(countRows(store, "chunks")).toBe(2);

    const removed = store.evictTurnsBefore(clock + 5_000);

    expect(removed).toBe(1);
    expect(store.listTurns().map((turn) => turn.turnId)).toEqual(["turn-new"]);
    // Released, not merely unlinked: the chunk goes when the last snapshot naming it does.
    expect(countRows(store, "chunks")).toBe(1);
    expect(countRows(store, "snapshots")).toBe(1);
  });

  test("content two turns share survives the first one's eviction", () => {
    const shared = store.putContent(text("shared\n".repeat(100)));
    for (const [index, turnId] of ["turn-1", "turn-2"].entries()) {
      store.recordTurn({
        turnId,
        agentId: "agent-1",
        startedAt: clock + index * 10_000,
        endedAt: null,
        files: [{ path: "shared.txt", before: { kind: "missing", sha256: null }, after: shared }],
      });
    }
    store.setPathHead("shared.txt", { kind: "missing", sha256: null });

    store.evictTurnsBefore(clock + 5_000);

    // One chunk belongs to every snapshot containing it, so the surviving turn keeps it.
    expect(store.readContent(shared.sha256!)).not.toBeNull();
    expect(countRows(store, "chunks")).toBe(1);
  });

  test("the cap drops the oldest turns until the store fits", () => {
    for (const [index, turnId] of ["turn-1", "turn-2", "turn-3"].entries()) {
      turnWriting(turnId, clock + index * 1_000, `body ${turnId} `.repeat(500));
    }
    const full = store.compressedBytes();
    expect(full).toBeGreaterThan(0);

    const removed = store.enforceSizeCap(Math.floor(full / 2));

    expect(removed).toBeGreaterThan(0);
    expect(store.compressedBytes()).toBeLessThanOrEqual(Math.floor(full / 2));
    // Oldest first: what survives is the newest work.
    expect(store.listTurns().map((turn) => turn.turnId)).toEqual(
      ["turn-3", "turn-2", "turn-1"].slice(0, 3 - removed),
    );
  });

  test("a store held entirely by current heads stops rather than spinning", () => {
    // Heads are what the next turn's before image is read from, so their content cannot be dropped.
    const after = store.putContent(text("held by the head\n".repeat(200)));
    store.recordTurn({
      turnId: "turn-1",
      agentId: "agent-1",
      startedAt: clock,
      endedAt: null,
      files: [{ path: "kept.txt", before: { kind: "missing", sha256: null }, after }],
    });

    const removed = store.enforceSizeCap(1);

    expect(removed).toBe(1);
    // Above the cap and nothing left to drop: it returns instead of looping.
    expect(store.compressedBytes()).toBeGreaterThan(1);
    expect(store.readContent(after.sha256!)).not.toBeNull();
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
