import {
  createEnterpriseFetchAgentsStartScheduler,
  type EnterpriseFetchAgentsStartScheduler,
} from "./session.js";

export function createFetchAgentsStartBatcher(
  scheduler: EnterpriseFetchAgentsStartScheduler,
  capacity = 32,
): EnterpriseFetchAgentsStartScheduler {
  let queue: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = queue.splice(0, capacity);
    if (queue.length > 0) schedule();
    if (batch.length === 0) return;
    Promise.resolve()
      .then(() => scheduler.waitForStart())
      .then(
        () => {
          for (const ticket of batch) ticket.resolve();
          return undefined;
        },
        (error) => {
          for (const ticket of batch) ticket.reject(error);
          return undefined;
        },
      );
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(flush);
  };
  return createEnterpriseFetchAgentsStartScheduler(
    () =>
      new Promise<void>((resolve, reject) => {
        queue.push({ resolve, reject });
        schedule();
      }),
  );
}
