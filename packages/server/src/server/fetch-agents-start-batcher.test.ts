import { describe, expect, test } from "vitest";
/* oxlint-disable max-nested-callbacks */
import { createFetchAgentsStartBatcher } from "./fetch-agents-start-batcher.js";

describe("fetch agents start batcher", () => {
  test.each([0, -1, 1.5])("rejects invalid capacity %s", (capacity) => {
    expect(() => createFetchAgentsStartBatcher({ capacity })).toThrow("capacity must be positive");
  });

  test("flushes one deterministic callback FIFO", async () => {
    const callbacks: Array<() => void> = [];
    const batcher = createFetchAgentsStartBatcher({
      capacity: 32,
      schedule: (cb) => {
        callbacks.push(cb);
        return cb;
      },
    });
    const order: number[] = [];
    const pending = Array.from({ length: 10 }, (_, value) =>
      (async () => {
        await batcher.scheduler.waitForStart();
        order.push(value);
      })(),
    );
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect(order).toEqual([]);
    await Promise.resolve();
    await Promise.all(pending);
    expect(order).toEqual(Array.from({ length: 10 }, (_, i) => i));
    batcher.close();
  });

  test("capacity overflow creates FIFO batches and close is idempotent", async () => {
    const callbacks: Array<() => void> = [];
    const batcher = createFetchAgentsStartBatcher({
      capacity: 2,
      schedule: (cb) => {
        callbacks.push(cb);
        return cb;
      },
    });
    const order: number[] = [];
    const pending = [0, 1, 2, 3].map((value) =>
      batcher.scheduler.waitForStart().then(() => order.push(value)),
    );
    expect(callbacks).toHaveLength(1);
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    callbacks.shift()!();
    expect(order).toEqual([0, 1]);
    expect(callbacks).toHaveLength(0);
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3]);
    await Promise.all(pending);
    batcher.close();
    batcher.close();
  });

  test("schedule failure rejects tickets without poisoning subsequent work", async () => {
    const callbacks: Array<() => void> = [];
    let fail = true;
    const batcher = createFetchAgentsStartBatcher({
      schedule: (cb) => {
        if (fail) {
          fail = false;
          throw new Error("schedule");
        }
        callbacks.push(cb);
        return cb;
      },
    });
    await expect(batcher.scheduler.waitForStart()).rejects.toThrow("schedule");
    const next = batcher.scheduler.waitForStart();
    callbacks.shift()!();
    await expect(next).resolves.toBeUndefined();
    batcher.close();
  });

  test("cancel failure still settles pending and future tickets", async () => {
    const callbacks: Array<() => void> = [];
    let cancelCalls = 0;
    const batcher = createFetchAgentsStartBatcher({
      schedule: (cb) => {
        callbacks.push(cb);
        return cb;
      },
      cancel: () => {
        cancelCalls++;
        throw new Error("cancel");
      },
    });
    const pending = batcher.scheduler.waitForStart();
    batcher.close();
    await expect(pending).resolves.toBeUndefined();
    await expect(batcher.scheduler.waitForStart()).resolves.toBeUndefined();
    callbacks[0]?.();
    batcher.close();
    expect(cancelCalls).toBe(1);
  });
});
