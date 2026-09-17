import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { diffStorePaths, ensureDiffStorePath } from "./diff-paths.js";
import { readAllChangesDiff, readTurnDiff } from "./diff-reader.js";
import { DiffStore, type RecordedContent } from "./diff-store.js";

const WORKSPACE = "wks_0123456789abcdef";
const ABSENT: RecordedContent = { kind: "missing", sha256: null };

let home: string;
let store: DiffStore;
let clock: number;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "diff-reader-"));
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

function recordTurn(
  files: Array<{ path: string; before: RecordedContent; after: RecordedContent }>,
) {
  store.recordTurn({
    turnId: "turn-1",
    agentId: "agent-1",
    startedAt: clock,
    endedAt: clock + 1,
    files,
  });
}

describe("reading back what a turn changed", () => {
  test("a changed file comes back with hunks under the path the turn recorded", async () => {
    const before = store.putContent(text("one\ntwo\nthree\n"));
    const after = store.putContent(text("one\nTWO\nthree\n"));
    recordTurn([{ path: "src/a.ts", before, after }]);

    const [file] = await readTurnDiff(store, "turn-1");

    // --no-index names the temporary files it compared; the reader must see the real path.
    expect(file!.path).toBe("src/a.ts");
    expect(file!.hunks.length).toBeGreaterThan(0);
    expect(file!.additions).toBe(1);
    expect(file!.deletions).toBe(1);
    expect(file!.isNew).toBe(false);
    expect(file!.isDeleted).toBe(false);
  });

  test("a file the turn created reads as new", async () => {
    const after = store.putContent(text("fresh\n"));
    recordTurn([{ path: "src/new.ts", before: ABSENT, after }]);

    const [file] = await readTurnDiff(store, "turn-1");

    expect(file!.path).toBe("src/new.ts");
    expect(file!.isNew).toBe(true);
    expect(file!.isDeleted).toBe(false);
    expect(file!.additions).toBe(1);
  });

  test("a file the turn deleted reads as deleted", async () => {
    const before = store.putContent(text("going away\n"));
    recordTurn([{ path: "src/gone.ts", before, after: ABSENT }]);

    const [file] = await readTurnDiff(store, "turn-1");

    expect(file!.path).toBe("src/gone.ts");
    expect(file!.isDeleted).toBe(true);
    expect(file!.deletions).toBe(1);
  });

  test("content the store never held is described by why, not by a diff", async () => {
    const binary = store.putContent(new Uint8Array([0x00, 0x01, 0x02]));
    const oversized = { kind: "too_large", sha256: null } as const;
    recordTurn([
      { path: "assets/logo.png", before: ABSENT, after: binary },
      { path: "data/big.bin", before: ABSENT, after: oversized },
    ]);

    const files = await readTurnDiff(store, "turn-1");

    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["assets/logo.png", "binary"],
      ["data/big.bin", "too_large"],
    ]);
    expect(files.every((file) => file.hunks.length === 0)).toBe(true);
  });

  test("a symlink is neither binary nor oversized, so it claims neither", async () => {
    recordTurn([{ path: "link", before: ABSENT, after: { kind: "symlink", sha256: null } }]);

    const [file] = await readTurnDiff(store, "turn-1");

    // The parser's vocabulary has no word for it; borrowing one would misreport what happened.
    expect(file!.status).toBeUndefined();
    expect(file!.hunks).toEqual([]);
  });

  test("a turn that changed nothing reads as no files", async () => {
    recordTurn([]);

    expect(await readTurnDiff(store, "turn-1")).toEqual([]);
    expect(await readTurnDiff(store, "turn-unknown")).toEqual([]);
  });

  test("all changes span the first before-image and the last after-image", async () => {
    const original = store.putContent(text("one\n"));
    const mid = store.putContent(text("two\n"));
    const latest = store.putContent(text("three\n"));
    store.recordTurn({
      turnId: "turn-1",
      agentId: "agent-1",
      startedAt: clock,
      endedAt: clock + 1,
      files: [{ path: "src/a.ts", before: original, after: mid }],
    });
    store.recordTurn({
      turnId: "turn-2",
      agentId: "agent-1",
      startedAt: clock + 2,
      endedAt: clock + 3,
      files: [{ path: "src/a.ts", before: mid, after: latest }],
    });

    const [file] = await readAllChangesDiff(store);

    expect(file!.path).toBe("src/a.ts");
    expect(file!.additions).toBe(1);
    expect(file!.deletions).toBe(1);
  });

  test("an unchanged file produces no hunks rather than a failure", async () => {
    const same = store.putContent(text("identical\n"));
    recordTurn([{ path: "src/same.ts", before: same, after: same }]);

    const [file] = await readTurnDiff(store, "turn-1");

    // git exits 1 when files differ and 0 when they do not; both are answers, not failures.
    expect(file!.path).toBe("src/same.ts");
    expect(file!.hunks).toEqual([]);
    expect(file!.status).toBe("ok");
  });
});
