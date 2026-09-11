import { describe, expect, test, vi } from "vitest";
import { createEnterpriseFetchAgentsStartScheduler } from "./session.js";
import { createFetchAgentsStartBatcher } from "./fetch-agents-start-batcher.js";

describe("fetch agents start batcher", () => {
  test("flushes bounded FIFO batches", async () => {
    const release = vi.fn(async () => {});
    const scheduler = createFetchAgentsStartBatcher(
      createEnterpriseFetchAgentsStartScheduler(release),
      2,
    );
    const promises = [scheduler.waitForStart(), scheduler.waitForStart(), scheduler.waitForStart()];
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(promises);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
