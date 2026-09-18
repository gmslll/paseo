import { describe, expect, test } from "vitest";

import { COLLAB_STREAM_LIMITS } from "@getpaseo/protocol/enterprise-collaboration";
import { openSqliteDatabase } from "../sqlite.js";
import { DATA_PLANE_SCHEMA, createStreamStore, type StreamStore } from "./stream-store.js";

const CONTAINER = "cws_0123456789abcdef";
const OTHER_CONTAINER = "cws_fedcba9876543210";
const START = Date.parse("2026-09-16T00:00:00.000Z");

function createStore(): StreamStore {
  const database = openSqliteDatabase(":memory:");
  database.exec(DATA_PLANE_SCHEMA);
  return createStreamStore({ database, clock: { nowMs: () => START } });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function append(
  store: StreamStore,
  input: {
    segment?: string;
    containerId?: string;
    producerId?: string;
    producerEpoch?: number;
    producerSeq: number;
    update?: Uint8Array;
  },
) {
  return store.append({
    containerId: input.containerId ?? CONTAINER,
    segment: input.segment ?? "meta",
    producerId: input.producerId ?? "prod-a",
    producerEpoch: input.producerEpoch ?? 1,
    producerSeq: input.producerSeq,
    update: input.update ?? bytes(`update-${input.producerSeq}`),
  });
}

describe("collaboration stream store", () => {
  test("assigns offsets that sort in stream order", () => {
    const store = createStore();

    const first = append(store, { producerSeq: 1 });
    const second = append(store, { producerSeq: 2 });

    expect(first).toMatchObject({ kind: "appended" });
    expect(second).toMatchObject({ kind: "appended" });
    if (first.kind !== "appended" || second.kind !== "appended") throw new Error("not appended");
    // Zero-padded to 20 digits so lexical order equals stream order (ADR-0032).
    expect(first.offset).toMatch(/^\d{20}$/);
    expect(second.offset).toMatch(/^\d{20}$/);
    expect(first.offset < second.offset).toBe(true);
  });

  test("reads back from an offset and reports the next offset", () => {
    const store = createStore();
    append(store, { producerSeq: 1, update: bytes("one") });
    const second = append(store, { producerSeq: 2, update: bytes("two") });
    if (second.kind !== "appended") throw new Error("not appended");

    const all = store.read({ containerId: CONTAINER, segment: "meta" });
    expect(all.messages.map((message) => new TextDecoder().decode(message.update))).toEqual([
      "one",
      "two",
    ]);
    expect(all.nextOffset > second.offset).toBe(true);
    expect(all.upToDate).toBe(true);

    const tail = store.read({ containerId: CONTAINER, segment: "meta", fromOffset: second.offset });
    expect(tail.messages.map((message) => new TextDecoder().decode(message.update))).toEqual([
      "two",
    ]);
  });

  test("refuses a stale producer epoch and a sequence gap, and ignores a replayed sequence", () => {
    const store = createStore();
    append(store, { producerSeq: 1 });
    append(store, { producerSeq: 2 });

    // A duplicate is not an error: the producer retried a write that already landed.
    const duplicate = append(store, { producerSeq: 2 });
    expect(duplicate).toMatchObject({ kind: "duplicate" });

    expect(append(store, { producerSeq: 9 })).toMatchObject({ kind: "gap", expectedSeq: 3 });
    expect(append(store, { producerEpoch: 0, producerSeq: 3 })).toMatchObject({
      kind: "stale_epoch",
      currentEpoch: 1,
    });

    // None of the refusals wrote a row.
    expect(store.read({ containerId: CONTAINER, segment: "meta" }).messages).toHaveLength(2);
  });

  test("lets a restarted producer replay under a new epoch without duplicating rows", () => {
    const store = createStore();
    append(store, { producerSeq: 1, update: bytes("one") });
    append(store, { producerSeq: 2, update: bytes("two") });

    // The producer restarted, does not know what landed, and replays from its own beginning.
    expect(append(store, { producerEpoch: 2, producerSeq: 1, update: bytes("one") })).toMatchObject(
      { kind: "duplicate" },
    );
    expect(append(store, { producerEpoch: 2, producerSeq: 2, update: bytes("two") })).toMatchObject(
      { kind: "duplicate" },
    );
    const resumed = append(store, { producerEpoch: 2, producerSeq: 3, update: bytes("three") });
    expect(resumed).toMatchObject({ kind: "appended" });

    expect(
      store
        .read({ containerId: CONTAINER, segment: "meta" })
        .messages.map((message) => new TextDecoder().decode(message.update)),
    ).toEqual(["one", "two", "three"]);
  });

  test("refuses an append larger than the contract allows", () => {
    const store = createStore();

    const oversized = append(store, {
      producerSeq: 1,
      update: new Uint8Array(COLLAB_STREAM_LIMITS.maxAppendBytes + 1),
    });

    expect(oversized).toMatchObject({
      kind: "too_large",
      limitBytes: COLLAB_STREAM_LIMITS.maxAppendBytes,
    });
    expect(store.read({ containerId: CONTAINER, segment: "meta" }).messages).toHaveLength(0);
  });

  test("keeps segments and containers independent", () => {
    const store = createStore();
    append(store, { producerSeq: 1, update: bytes("meta-one") });
    append(store, { segment: "wf", producerSeq: 1, update: bytes("wf-one") });
    append(store, { containerId: OTHER_CONTAINER, producerSeq: 1, update: bytes("other-one") });

    const read = (containerId: string, segment: string) =>
      store
        .read({ containerId, segment })
        .messages.map((message) => new TextDecoder().decode(message.update));

    expect(read(CONTAINER, "meta")).toEqual(["meta-one"]);
    expect(read(CONTAINER, "wf")).toEqual(["wf-one"]);
    expect(read(OTHER_CONTAINER, "meta")).toEqual(["other-one"]);
  });
});
