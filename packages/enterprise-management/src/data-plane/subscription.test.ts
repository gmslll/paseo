import { describe, expect, test } from "vitest";

import {
  COLLAB_STREAM_LIMITS,
  CollabSubscriptionEventSchema,
} from "@getpaseo/protocol/enterprise-collaboration";
import { openSqliteDatabase } from "../sqlite.js";
import { DATA_PLANE_SCHEMA, createStreamStore, type StreamStore } from "./stream-store.js";
import { collectSubscriptionEvents } from "./subscription.js";

const CONTAINER = "cws_0123456789abcdef";

function createStore(): StreamStore {
  const database = openSqliteDatabase(":memory:");
  database.exec(DATA_PLANE_SCHEMA);
  return createStreamStore({ database, clock: { nowMs: () => 0 } });
}

function append(store: StreamStore, segment: string, seq: number, size = 8): void {
  const result = store.append({
    containerId: CONTAINER,
    segment,
    producerId: `prod-${segment}`,
    producerEpoch: 1,
    producerSeq: seq,
    update: new Uint8Array(size),
  });
  if (result.kind !== "appended") throw new Error(`append failed: ${result.kind}`);
}

describe("collaboration subscription", () => {
  test("returns data for every segment named in the cursors, then a control per segment", () => {
    const store = createStore();
    append(store, "meta", 1);
    append(store, "meta", 2);
    append(store, "wf", 1);

    const events = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000001", wf: "00000000000000000001" },
    });

    // The events go out on the wire as-is, so hold them to the frozen contract rather than only to
    // the local types.
    for (const event of events) CollabSubscriptionEventSchema.parse(event);

    const data = events.filter((event) => event.type === "data");
    expect(data.map((event) => event.segment)).toEqual(["meta", "meta", "wf"]);
    // Every named segment reports where the reader should resume, even when it had nothing new.
    const control = events.filter((event) => event.type === "control");
    expect(control.map((event) => event.segment).sort()).toEqual(["meta", "wf"]);
    expect(control.every((event) => event.upToDate)).toBe(true);
  });

  test("resumes from each cursor independently", () => {
    const store = createStore();
    append(store, "meta", 1);
    append(store, "meta", 2);
    append(store, "meta", 3);

    const events = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000003" },
    });

    expect(events.filter((event) => event.type === "data")).toHaveLength(1);
    const control = events.find((event) => event.type === "control")!;
    expect(control.nextOffset).toBe("00000000000000000004");
  });

  test("encodes updates as base64 so they survive a JSON event", () => {
    const store = createStore();
    store.append({
      containerId: CONTAINER,
      segment: "meta",
      producerId: "prod-a",
      producerEpoch: 1,
      producerSeq: 1,
      update: Uint8Array.from([0x00, 0xff, 0x10]),
    });

    const [first] = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000001" },
    });

    if (first?.type !== "data") throw new Error("expected a data event");
    expect(Buffer.from(first.update, "base64")).toEqual(Buffer.from([0x00, 0xff, 0x10]));
  });

  test("stops at the event ceiling and says so instead of streaming the rest", () => {
    const store = createStore();
    for (let seq = 1; seq <= COLLAB_STREAM_LIMITS.maxSubscriberQueueEvents + 50; seq += 1) {
      append(store, "meta", seq);
    }

    const events = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000001" },
    });

    const data = events.filter((event) => event.type === "data");
    expect(data.length).toBeLessThanOrEqual(COLLAB_STREAM_LIMITS.maxSubscriberQueueEvents);
    const control = events.at(-1);
    // ADR-0032: overflow sends control with overflow set, and the subscription ends there.
    expect(control?.type).toBe("control");
    if (control?.type !== "control") throw new Error("expected a control event");
    expect(control.overflow).toBe(true);
    expect(control.upToDate).toBe(false);
  });

  test("stops at the byte ceiling as well", () => {
    const store = createStore();
    const chunk = 256 * 1024;
    const needed = Math.ceil(COLLAB_STREAM_LIMITS.maxSubscriberQueueBytes / chunk) + 2;
    for (let seq = 1; seq <= needed; seq += 1) {
      append(store, "meta", seq, chunk);
    }

    const events = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000001" },
    });

    const control = events.at(-1);
    if (control?.type !== "control") throw new Error("expected a control event");
    expect(control.overflow).toBe(true);
    const bytes = events
      .filter((event) => event.type === "data")
      .reduce((total, event) => total + Buffer.from(event.update, "base64").byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(COLLAB_STREAM_LIMITS.maxSubscriberQueueBytes);
  });

  test("reports a segment the reader has never seen from its lower bound", () => {
    const store = createStore();
    append(store, "meta", 1);

    const events = collectSubscriptionEvents({
      store,
      containerId: CONTAINER,
      cursors: { meta: "00000000000000000001", wf: "00000000000000000001" },
    });

    const wf = events.find((event) => event.type === "control" && event.segment === "wf");
    if (wf?.type !== "control") throw new Error("expected a control event for wf");
    expect(wf.nextOffset).toBe("00000000000000000001");
    expect(wf.upToDate).toBe(true);
  });
});
