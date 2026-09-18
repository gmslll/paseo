import { describe, expect, test } from "vitest";

import { LoroDoc } from "loro-crdt";

import { openSqliteDatabase } from "../sqlite.js";
import { DATA_PLANE_SCHEMA, createStreamStore, type StreamStore } from "./stream-store.js";

const CONTAINER = "cws_0123456789abcdef";
const NODE = "nod_0123456789abcdef";

function createStore(updates = 3): StreamStore {
  const database = openSqliteDatabase(":memory:");
  database.exec(DATA_PLANE_SCHEMA);
  return createStreamStore({
    database,
    clock: { nowMs: () => 0 },
    // Small, so the behaviour can be observed without generating 5,000 real updates.
    compaction: { updates },
  });
}

/**
 * A real Loro update, not arbitrary bytes. Random bytes would make importBatch report pending,
 * compaction would decline for that reason, and a test asserting "nothing was compacted" would
 * pass without exercising anything.
 */
function loroUpdate(text: string): Uint8Array {
  const document = new LoroDoc();
  document.getText("body").insert(0, text);
  document.commit();
  return document.export({ mode: "update" });
}

function append(store: StreamStore, segment: string, seq: number, text: string): void {
  const result = store.append({
    containerId: CONTAINER,
    segment,
    producerId: `prod-${segment}-${seq}`,
    producerEpoch: 1,
    producerSeq: 1,
    update: loroUpdate(text),
  });
  if (result.kind !== "appended") throw new Error(`append failed: ${result.kind}`);
}

describe("stream compaction", () => {
  test("folds a document segment once it passes the threshold", () => {
    const store = createStore(3);
    for (let seq = 1; seq <= 3; seq += 1) append(store, "meta", seq, `line-${seq}`);

    const read = store.read({ containerId: CONTAINER, segment: "meta" });

    // Everything folded, so the stream now starts after the last folded message.
    expect(read.lowerBoundOffset).toBe("00000000000000000004");
    expect(read.messages).toHaveLength(0);
  });

  test("hands a reader below the bound the snapshot instead of history it cannot fetch", () => {
    const store = createStore(3);
    for (let seq = 1; seq <= 3; seq += 1) append(store, "meta", seq, `line-${seq}`);

    const read = store.read({
      containerId: CONTAINER,
      segment: "meta",
      fromOffset: "00000000000000000001",
    });

    expect(read.snapshot).toBeInstanceOf(Uint8Array);
    // The snapshot has to carry what the discarded updates built, or compaction lost history.
    const restored = new LoroDoc();
    expect(restored.importBatch([read.snapshot!]).pending).toBeNull();
    const body = restored.getText("body").toString();
    for (let seq = 1; seq <= 3; seq += 1) expect(body).toContain(`line-${seq}`);
  });

  test("sends no snapshot to a reader at or above the bound", () => {
    const store = createStore(3);
    for (let seq = 1; seq <= 3; seq += 1) append(store, "meta", seq, `line-${seq}`);

    const read = store.read({
      containerId: CONTAINER,
      segment: "meta",
      fromOffset: "00000000000000000004",
    });

    expect(read.snapshot).toBeUndefined();
  });

  test("never folds a log segment, however far past the threshold", () => {
    const store = createStore(3);
    const segment = `rpc:req:${NODE}`;
    for (let seq = 1; seq <= 6; seq += 1) append(store, segment, seq, `call-${seq}`);

    const read = store.read({ containerId: CONTAINER, segment });

    // ADR-0032: rpc segments carry discrete envelopes. Replacing them with a snapshot would drop
    // messages that cannot be reconstructed, so the stream keeps all six.
    expect(read.lowerBoundOffset).toBe("00000000000000000001");
    expect(read.messages).toHaveLength(6);
    expect(read.snapshot).toBeUndefined();
  });

  test("leaves a document segment alone until it is due", () => {
    const store = createStore(5);
    for (let seq = 1; seq <= 4; seq += 1) append(store, "meta", seq, `line-${seq}`);

    const read = store.read({ containerId: CONTAINER, segment: "meta" });

    expect(read.lowerBoundOffset).toBe("00000000000000000001");
    expect(read.messages).toHaveLength(4);
  });
});
