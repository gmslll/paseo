import {
  createEnterpriseFetchAgentsStartScheduler,
  type EnterpriseFetchAgentsStartScheduler,
} from "./session.js";
export function createFetchAgentsStartBatcher(
  options: {
    schedule?: (cb: () => void) => unknown;
    cancel?: (handle: unknown) => void;
    capacity?: number;
  } = {},
): { scheduler: EnterpriseFetchAgentsStartScheduler; close(): void } {
  const capacity = options.capacity ?? 32;
  if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("capacity must be positive");
  let queue: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let scheduled = false;
  let closed = false;
  let handle: unknown;
  let epoch = 0;
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    const e = epoch;
    try {
      handle = options.schedule
        ? options.schedule(() => {
            if (e === epoch) flush();
          })
        : setImmediate(() => {
            if (e === epoch) flush();
          });
    } catch (error) {
      scheduled = false;
      handle = undefined;
      for (const ticket of queue.splice(0)) ticket.reject(error);
    }
  };
  const flush = () => {
    scheduled = false;
    handle = undefined;
    if (closed) return;
    const batch = queue.splice(0, capacity);
    if (queue.length) schedule();
    for (const ticket of batch) ticket.resolve();
  };
  const scheduler = createEnterpriseFetchAgentsStartScheduler(
    () =>
      new Promise<void>((resolve, reject) => {
        if (closed) resolve();
        else {
          if (queue.length === capacity) {
            for (const r of queue.splice(0)) r.resolve();
          }
          queue.push({ resolve, reject });
          schedule();
        }
      }),
  );
  return Object.freeze({
    scheduler,
    close() {
      closed = true;
      epoch++;
      try {
        if (handle !== undefined) {
          if (options.cancel) {
            try {
              options.cancel(handle);
            } catch {
              /* isolate cancellation failures */
            }
          } else clearImmediate(handle as NodeJS.Immediate);
        }
      } finally {
        scheduled = false;
        handle = undefined;
        for (const ticket of queue.splice(0)) ticket.resolve();
      }
    },
  });
}
