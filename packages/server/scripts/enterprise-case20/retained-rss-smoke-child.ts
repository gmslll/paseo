import type { Case20RetainedRssCheckpointPlan } from "./model.js";
import {
  createCase20GarbageCollectionController,
  installCase20ChildMessageHandler,
  type Case20GarbageCollectionRequest,
} from "./retained-rss.js";

const schedule = JSON.parse(
  process.env.CASE20_RETAINED_RSS_SCHEDULE ?? "null",
) as readonly Case20RetainedRssCheckpointPlan[];
const collectGarbage = (globalThis as { readonly gc?: () => void }).gc;
if (!Array.isArray(schedule) || schedule.length < 2 || !collectGarbage)
  throw new Error("Case20 retained RSS child smoke environment invalid");

const garbageCollection = createCase20GarbageCollectionController({
  schedule,
  collectGarbage,
});
let releaseMessageHandler: () => void = () => undefined;
releaseMessageHandler = installCase20ChildMessageHandler({
  source: {
    on: (_event, listener) => process.on("message", listener),
    off: (_event, listener) => process.off("message", listener),
  },
  parseGarbageCollectionRequest: (message) => message as Case20GarbageCollectionRequest,
  garbageCollection,
  isClosing: () => false,
  send: (message) => {
    process.send?.(message);
  },
  shutdown: () => {
    releaseMessageHandler();
    process.send?.({ type: "smoke_closed" }, () => process.disconnect?.());
  },
});
process.send?.({ type: "smoke_ready" });
