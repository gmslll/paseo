import { fork, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Case20Mode, Case20RetainedRssCheckpointPlan } from "./model.js";
import {
  CASE20_GC_ACK_TIMEOUT_MS,
  type Case20GarbageCollectionAcknowledgement,
  type Case20GarbageCollectionRequest,
} from "./retained-rss.js";

export interface Case20PartAClientFixture {
  readonly clientId: string;
  readonly principalId: string;
  readonly personalAccessToken: string;
  readonly agentId: string;
  readonly streamCanary: string;
}

export interface Case20AuditVerification {
  readonly restored: true;
  readonly filesScanned: number;
  readonly auditFiles: number;
}

export interface Case20PartAFixture {
  readonly daemonUrl: string;
  readonly daemonPid: number;
  readonly daemonLogPath: string;
  readonly childLogPath: string;
  readonly clients: readonly Case20PartAClientFixture[];
  collectGarbage(
    request: Case20GarbageCollectionRequest,
  ): Promise<Case20GarbageCollectionAcknowledgement>;
  close(): Promise<Case20AuditVerification>;
}

type ChildMessage =
  | {
      readonly type: "ready";
      readonly daemonUrl: string;
      readonly daemonPid: number;
      readonly clients: readonly Case20PartAClientFixture[];
    }
  | Case20GarbageCollectionAcknowledgement
  | {
      readonly type: "gc_checkpoint_failed";
      readonly requestId: string;
      readonly index: number;
      readonly scheduledTSec: number;
      readonly message: string;
    }
  | { readonly type: "closed"; readonly audit: Case20AuditVerification }
  | { readonly type: "failed"; readonly phase: "start" | "close"; readonly message: string };

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "ready" ||
    type === "gc_checkpoint_ack" ||
    type === "gc_checkpoint_failed" ||
    type === "closed" ||
    type === "failed"
  );
}

function waitForMessage(
  child: ChildProcess,
  accept: (message: ChildMessage) => boolean,
  timeoutMs: number,
  timeoutMessage = "Case20 daemon child timed out",
  signal?: AbortSignal,
): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    const onMessage = (value: unknown) => {
      if (!isChildMessage(value) || !accept(value)) return;
      finish(null, value);
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      finish(new Error(`Case20 daemon child exited early (${String(code)}/${String(exitSignal)})`));
    };
    const finish = (error: Error | null, message?: ChildMessage) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (message) resolve(message);
    };
    const onAbort = () => finish(new Error("Case20 daemon child message wait cancelled"));
    child.on("message", onMessage);
    child.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Case20 daemon child did not exit after cleanup"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sendShutdownToChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send({ type: "shutdown" }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendGarbageCollectionToChild(
  child: ChildProcess,
  request: Case20GarbageCollectionRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.send(request, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function daemonChildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(?:token|key|secret|password|cookie|authorization|credential)/i.test(key),
    ),
  );
}

export function case20PartAChildExecArgv(input: {
  readonly runningFromTypeScript: boolean;
  readonly mode: Case20Mode;
}): readonly string[] {
  return [...(input.runningFromTypeScript ? ["--import", "tsx"] : []), "--expose-gc"];
}

export async function createCase20PartAFixture(input: {
  readonly daemonLogPath: string;
  readonly childLogPath: string;
  readonly mode: Case20Mode;
  readonly retainedRssSchedule: readonly Case20RetainedRssCheckpointPlan[];
}): Promise<Case20PartAFixture> {
  const childLog = await open(input.childLogPath, "wx", 0o600);
  const runningFromTypeScript = fileURLToPath(import.meta.url).endsWith(".ts");
  const childModule = fileURLToPath(
    new URL(runningFromTypeScript ? "./part-a-daemon.ts" : "./part-a-daemon.js", import.meta.url),
  );
  let child: ChildProcess;
  try {
    child = fork(childModule, [], {
      execArgv: [...case20PartAChildExecArgv({ runningFromTypeScript, mode: input.mode })],
      env: {
        ...daemonChildEnvironment(),
        CASE20_DAEMON_LOG_PATH: input.daemonLogPath,
        CASE20_MODE: input.mode,
        CASE20_RETAINED_RSS_SCHEDULE: JSON.stringify(input.retainedRssSchedule),
      },
      stdio: ["ignore", childLog.fd, childLog.fd, "ipc"],
    });
  } catch (error) {
    const closeFailure = await childLog.close().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (closeFailure !== null)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the fork error as its cause and first member.
      throw new AggregateError([error, closeFailure], "Case20 child fork cleanup failed", {
        cause: error,
      });
    throw error;
  }
  let closed = false;
  let garbageCollectionInFlight = false;
  try {
    const message = await waitForMessage(
      child,
      (candidate) => candidate.type === "ready" || candidate.type === "failed",
      90_000,
    );
    if (message.type === "failed")
      throw new Error(`Case20 daemon ${message.phase} failed: ${message.message}`);
    if (message.type !== "ready")
      throw new Error("Case20 daemon child returned an invalid start message");
    return {
      daemonUrl: message.daemonUrl,
      daemonPid: message.daemonPid,
      daemonLogPath: input.daemonLogPath,
      childLogPath: input.childLogPath,
      clients: message.clients,
      async collectGarbage(request) {
        if (closed) throw new Error("Case20 daemon child is closed");
        if (garbageCollectionInFlight)
          throw new Error("Case20 daemon child already has a GC checkpoint in flight");
        garbageCollectionInFlight = true;
        try {
          const pendingController = new AbortController();
          const pending = waitForMessage(
            child,
            (candidate) =>
              (candidate.type === "gc_checkpoint_ack" ||
                candidate.type === "gc_checkpoint_failed") &&
              candidate.requestId === request.requestId,
            CASE20_GC_ACK_TIMEOUT_MS,
            `Case20 GC checkpoint ${request.index} acknowledgement timed out`,
            pendingController.signal,
          );
          try {
            await sendGarbageCollectionToChild(child, request);
          } catch (error) {
            pendingController.abort();
            await pending.catch(() => undefined);
            throw error;
          }
          const result = await pending;
          if (result.type === "gc_checkpoint_failed") throw new Error(result.message);
          if (
            result.type !== "gc_checkpoint_ack" ||
            result.index !== request.index ||
            result.requestId !== request.requestId ||
            result.scheduledTSec !== request.scheduledTSec ||
            !Number.isFinite(result.gcDurationMs) ||
            result.gcDurationMs < 0
          )
            throw new Error("Case20 daemon child returned an invalid GC acknowledgement");
          return result;
        } finally {
          garbageCollectionInFlight = false;
        }
      },
      async close() {
        if (closed) throw new Error("Case20 daemon child was already closed");
        closed = true;
        const pending = waitForMessage(
          child,
          (candidate) => candidate.type === "closed" || candidate.type === "failed",
          90_000,
        );
        const exited = waitForExit(child, 10_000);
        let result: ChildMessage;
        try {
          await sendShutdownToChild(child);
          [result] = await Promise.all([pending, exited]);
        } catch (error) {
          child.kill("SIGTERM");
          const cleanup = await Promise.allSettled([pending, exited, childLog.close()]);
          const failures = cleanup
            .filter((entry) => entry.status === "rejected")
            .map((entry) => entry.reason);
          if (failures.length > 0)
            // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the shutdown error as its cause and first member.
            throw new AggregateError(
              [error, ...failures],
              "Case20 daemon child shutdown cleanup failed",
              { cause: error },
            );
          throw error;
        }
        await childLog.close();
        if (result.type === "failed")
          throw new Error(`Case20 daemon ${result.phase} failed: ${result.message}`);
        if (result.type !== "closed")
          throw new Error("Case20 daemon child returned an invalid close message");
        return result.audit;
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    const cleanup = await Promise.allSettled([waitForExit(child, 10_000), childLog.close()]);
    const failures = cleanup
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the startup error as cause and first member.
      throw new AggregateError([error, ...failures], "Case20 child startup cleanup failed", {
        cause: error,
      });
    throw error;
  }
}
