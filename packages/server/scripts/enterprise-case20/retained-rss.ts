import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  Case20ResourceSample,
  Case20RetainedRssCheckpointPlan,
  Case20RetainedRssSample,
} from "./model.js";

export const CASE20_RETAINED_RSS_CHECKPOINT_INTERVAL_SEC = 5 * 60;
export const CASE20_GC_ACK_TIMEOUT_MS = 10_000;

export interface Case20GarbageCollectionRequest extends Case20RetainedRssCheckpointPlan {
  readonly type: "gc_checkpoint";
}

export interface Case20GarbageCollectionAcknowledgement extends Case20RetainedRssCheckpointPlan {
  readonly type: "gc_checkpoint_ack";
  readonly gcDurationMs: number;
}

export interface Case20GarbageCollectionFailure extends Case20RetainedRssCheckpointPlan {
  readonly type: "gc_checkpoint_failed";
  readonly message: string;
}

export interface Case20GarbageCollectionController {
  run(request: Case20GarbageCollectionRequest): Case20GarbageCollectionAcknowledgement;
}

export interface Case20ChildMessageSource {
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
}

export function case20RetainedRssScheduledSeconds(durationSec: number): readonly number[] {
  if (!Number.isInteger(durationSec) || durationSec <= 0)
    throw new Error("Case20 retained RSS duration must be a positive integer");
  const scheduledSeconds: number[] = [];
  for (
    let scheduledTSec = 0;
    scheduledTSec < durationSec;
    scheduledTSec += CASE20_RETAINED_RSS_CHECKPOINT_INTERVAL_SEC
  )
    scheduledSeconds.push(scheduledTSec);
  if (scheduledSeconds.at(-1) !== durationSec) scheduledSeconds.push(durationSec);
  return scheduledSeconds;
}

export function createCase20RetainedRssSchedule(
  durationSec: number,
  createRequestId: () => string = randomUUID,
): readonly Case20RetainedRssCheckpointPlan[] {
  return case20RetainedRssScheduledSeconds(durationSec).map((scheduledTSec, index) => ({
    index,
    requestId: createRequestId(),
    scheduledTSec,
  }));
}

export function case20RetainedRssCheckpointDelayMs(
  measurementStartedAtMs: number,
  scheduledTSec: number,
  nowMs = Date.now(),
): number {
  return Math.max(0, measurementStartedAtMs + scheduledTSec * 1_000 - nowMs);
}

export function createCase20GarbageCollectionController(input: {
  readonly schedule: readonly Case20RetainedRssCheckpointPlan[];
  readonly collectGarbage: () => void;
  readonly monotonicNow?: () => number;
}): Case20GarbageCollectionController {
  const monotonicNow = input.monotonicNow ?? performance.now.bind(performance);
  let nextIndex = 0;
  return {
    run(request) {
      const expected = input.schedule[nextIndex];
      if (
        !expected ||
        request.type !== "gc_checkpoint" ||
        request.index !== expected.index ||
        request.requestId !== expected.requestId ||
        request.scheduledTSec !== expected.scheduledTSec
      )
        throw new Error(
          "Case20 GC checkpoint is out of order or does not match the fixed schedule",
        );
      const startedAt = monotonicNow();
      input.collectGarbage();
      const gcDurationMs = monotonicNow() - startedAt;
      nextIndex += 1;
      return {
        type: "gc_checkpoint_ack",
        ...expected,
        gcDurationMs,
      };
    },
  };
}

export function installCase20ChildMessageHandler(input: {
  readonly source: Case20ChildMessageSource;
  readonly parseGarbageCollectionRequest: (message: unknown) => Case20GarbageCollectionRequest;
  readonly garbageCollection: Case20GarbageCollectionController;
  readonly isClosing: () => boolean;
  readonly send: (
    message: Case20GarbageCollectionAcknowledgement | Case20GarbageCollectionFailure,
  ) => void;
  readonly shutdown: () => void;
}): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    input.source.off("message", onMessage);
  };
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { readonly type?: unknown }).type === "shutdown"
    ) {
      release();
      input.shutdown();
      return;
    }
    let request: Case20GarbageCollectionRequest | null = null;
    try {
      request = input.parseGarbageCollectionRequest(message);
      if (input.isClosing()) throw new Error("Case20 daemon child is closing");
      input.send(input.garbageCollection.run(request));
    } catch (error) {
      input.send({
        type: "gc_checkpoint_failed",
        requestId: request?.requestId ?? "invalid",
        index: request?.index ?? -1,
        scheduledTSec: request?.scheduledTSec ?? -1,
        message: error instanceof Error ? error.message : "Case20 GC checkpoint failed",
      });
    }
  };
  input.source.on("message", onMessage);
  return release;
}

export async function captureCase20FinalCheckpointBeforeCanary<T>(input: {
  readonly captureCheckpoint: () => Promise<void>;
  readonly captureFinalActive: () => Promise<T>;
}): Promise<T> {
  await input.captureCheckpoint();
  return input.captureFinalActive();
}

export async function captureCase20RetainedRssCheckpoint(input: {
  readonly plan: Case20RetainedRssCheckpointPlan;
  readonly daemonPid: number;
  readonly measurementStartedAtMs: number;
  readonly collectGarbage: (
    request: Case20GarbageCollectionRequest,
  ) => Promise<Case20GarbageCollectionAcknowledgement>;
  readonly sample: (tSec: number) => Promise<Case20ResourceSample>;
  readonly wallNow?: () => number;
  readonly monotonicNow?: () => number;
}): Promise<Case20RetainedRssSample> {
  const wallNow = input.wallNow ?? Date.now;
  const monotonicNow = input.monotonicNow ?? performance.now.bind(performance);
  const requestedAt = monotonicNow();
  const acknowledgement = await input.collectGarbage({
    type: "gc_checkpoint",
    ...input.plan,
  });
  const acknowledgedInMs = monotonicNow() - requestedAt;
  if (
    acknowledgement.type !== "gc_checkpoint_ack" ||
    acknowledgement.index !== input.plan.index ||
    acknowledgement.requestId !== input.plan.requestId ||
    acknowledgement.scheduledTSec !== input.plan.scheduledTSec
  )
    throw new Error("Case20 GC checkpoint acknowledgement mismatch");
  const actualTSec = (wallNow() - input.measurementStartedAtMs) / 1_000;
  const sample = await input.sample(actualTSec);
  const daemonMain = sample.processes.find((process) => process.pid === input.daemonPid);
  if (!daemonMain) throw new Error("Case20 retained RSS sample omitted the daemon main process");
  return {
    ...input.plan,
    actualTSec,
    acknowledgedInMs,
    gcDurationMs: acknowledgement.gcDurationMs,
    treeRssMiB: sample.rssMiB,
    daemonMainIdentity: daemonMain.identity,
    daemonMainRssMiB: daemonMain.rssMiB,
    sample,
  };
}
