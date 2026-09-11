import { fork, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES,
  CASE20_RPC_REQUEST_ID_PATTERN,
  type Case20DaemonRpcDiagnostic,
  type Case20DaemonRpcDiagnosticBatch,
  type Case20DaemonRpcDiagnosticFailureCode,
  type Case20DaemonRpcDiagnosticPhase,
  type Case20DaemonRpcDiagnosticRequestType,
  type Case20DaemonRpcDiagnosticResponseType,
  type Case20Mode,
  type Case20RetainedRssCheckpointPlan,
} from "./model.js";
import {
  CASE20_GC_ACK_TIMEOUT_MS,
  type Case20GarbageCollectionAcknowledgement,
  type Case20GarbageCollectionRequest,
} from "./retained-rss.js";

const CASE20_DAEMON_RPC_DIAGNOSTIC_CAPACITY = 50_000;
export const CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT = 256;
const CASE20_DAEMON_RPC_DIAGNOSTIC_MAX_BATCHES =
  Math.ceil(CASE20_DAEMON_RPC_DIAGNOSTIC_CAPACITY / CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT) + 1;

interface ParsedDaemonRpcDiagnosticObservation {
  readonly phase: Case20DaemonRpcDiagnosticPhase;
  readonly requestId: string;
  readonly requestType?: Case20DaemonRpcDiagnosticRequestType;
  readonly responseType?: Case20DaemonRpcDiagnosticResponseType;
  readonly monotonicUnixMs: number;
}

interface PendingDaemonRpcDiagnostic {
  readonly requestId: string;
  readonly requestType: Case20DaemonRpcDiagnosticRequestType;
  responseType: Case20DaemonRpcDiagnosticResponseType | null;
  readonly phases: Array<{
    readonly phase: Case20DaemonRpcDiagnosticPhase;
    readonly monotonicUnixMs: number;
  }>;
}

export interface Case20DaemonRpcDiagnosticCollector {
  observe(observation: unknown): void;
  drain(input: { readonly limit: number; readonly final: boolean }): Case20DaemonRpcDiagnosticBatch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDiagnosticPhase(value: unknown): value is Case20DaemonRpcDiagnosticPhase {
  return CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.some((phase) => phase === value);
}

function isDiagnosticRequestType(value: unknown): value is Case20DaemonRpcDiagnosticRequestType {
  return value === "fetch_agents_request" || value === "fetch_agent_request";
}

function isDiagnosticResponseType(value: unknown): value is Case20DaemonRpcDiagnosticResponseType {
  return (
    value === "fetch_agents_response" || value === "fetch_agent_response" || value === "rpc_error"
  );
}

function parseDaemonRpcDiagnosticObservation(value: unknown): ParsedDaemonRpcDiagnosticObservation {
  if (!isRecord(value) || !isDiagnosticPhase(value.phase))
    throw new Error("Case20 daemon RPC diagnostic observation is invalid");
  const phaseIndex = CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.indexOf(value.phase);
  const requestPhase = phaseIndex < 3;
  const expectedKeys = requestPhase
    ? ["phase", "requestId", "requestType", "atUnixMs"]
    : ["phase", "requestId", "responseType", "atUnixMs"];
  if (
    Reflect.ownKeys(value).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(value, key)) ||
    typeof value.requestId !== "string" ||
    !CASE20_RPC_REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.atUnixMs !== "number" ||
    !Number.isFinite(value.atUnixMs) ||
    value.atUnixMs < 0 ||
    (requestPhase
      ? !isDiagnosticRequestType(value.requestType)
      : !isDiagnosticResponseType(value.responseType))
  )
    throw new Error("Case20 daemon RPC diagnostic observation fields are invalid");
  return {
    phase: value.phase,
    requestId: value.requestId,
    ...(requestPhase
      ? { requestType: value.requestType as Case20DaemonRpcDiagnosticRequestType }
      : { responseType: value.responseType as Case20DaemonRpcDiagnosticResponseType }),
    monotonicUnixMs: value.atUnixMs,
  };
}

function responseMatchesRequest(
  requestType: Case20DaemonRpcDiagnosticRequestType,
  responseType: Case20DaemonRpcDiagnosticResponseType,
): boolean {
  if (responseType === "rpc_error") return true;
  return requestType === "fetch_agents_request"
    ? responseType === "fetch_agents_response"
    : responseType === "fetch_agent_response";
}

export function createCase20DaemonRpcDiagnosticCollector(input?: {
  readonly capacity?: number;
}): Case20DaemonRpcDiagnosticCollector {
  const capacity = input?.capacity ?? CASE20_DAEMON_RPC_DIAGNOSTIC_CAPACITY;
  if (!Number.isInteger(capacity) || capacity <= 0)
    throw new Error("Case20 daemon RPC diagnostic capacity is invalid");
  const seenRequestIds = new Set<string>();
  const pending = new Map<string, PendingDaemonRpcDiagnostic>();
  const completed: Case20DaemonRpcDiagnostic[] = [];
  const failures = new Set<Case20DaemonRpcDiagnosticFailureCode>();
  let sealed = false;
  let overflowed = false;
  const fail = (code: Case20DaemonRpcDiagnosticFailureCode, requestId?: string) => {
    failures.add(code);
    if (requestId) pending.delete(requestId);
  };
  return {
    observe(value) {
      if (overflowed) return;
      if (sealed) {
        fail("daemon_rpc_diagnostic_invalid");
        return;
      }
      let observation: ParsedDaemonRpcDiagnosticObservation;
      try {
        observation = parseDaemonRpcDiagnosticObservation(value);
      } catch {
        fail("daemon_rpc_diagnostic_invalid");
        return;
      }
      const phaseIndex = CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.indexOf(observation.phase);
      if (phaseIndex === 0) {
        if (seenRequestIds.has(observation.requestId)) {
          fail("daemon_rpc_diagnostic_duplicate", observation.requestId);
          return;
        }
        if (seenRequestIds.size >= capacity) {
          overflowed = true;
          fail("daemon_rpc_diagnostic_overflow");
          return;
        }
        seenRequestIds.add(observation.requestId);
        pending.set(observation.requestId, {
          requestId: observation.requestId,
          requestType: observation.requestType!,
          responseType: null,
          phases: [{ phase: observation.phase, monotonicUnixMs: observation.monotonicUnixMs }],
        });
        return;
      }
      const current = pending.get(observation.requestId);
      if (!current) {
        fail(
          seenRequestIds.has(observation.requestId)
            ? "daemon_rpc_diagnostic_duplicate"
            : "daemon_rpc_diagnostic_out_of_order",
        );
        return;
      }
      if (phaseIndex < current.phases.length) {
        fail("daemon_rpc_diagnostic_duplicate", observation.requestId);
        return;
      }
      const previous = current.phases.at(-1)!;
      if (
        phaseIndex !== current.phases.length ||
        observation.monotonicUnixMs < previous.monotonicUnixMs ||
        (phaseIndex < 3 && observation.requestType !== current.requestType)
      ) {
        fail("daemon_rpc_diagnostic_out_of_order", observation.requestId);
        return;
      }
      if (phaseIndex >= 3) {
        const responseType = observation.responseType!;
        if (
          !responseMatchesRequest(current.requestType, responseType) ||
          (current.responseType !== null && current.responseType !== responseType)
        ) {
          fail("daemon_rpc_diagnostic_out_of_order", observation.requestId);
          return;
        }
        current.responseType = responseType;
      }
      current.phases.push({
        phase: observation.phase,
        monotonicUnixMs: observation.monotonicUnixMs,
      });
      if (phaseIndex !== CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.length - 1) return;
      if (!current.responseType) {
        fail("daemon_rpc_diagnostic_missing", observation.requestId);
        return;
      }
      pending.delete(observation.requestId);
      completed.push({
        requestId: current.requestId,
        requestType: current.requestType,
        responseType: current.responseType,
        phases: current.phases,
      });
    },
    drain({ limit, final }) {
      if (
        !Number.isInteger(limit) ||
        limit <= 0 ||
        limit > CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT
      )
        throw new Error("Case20 daemon RPC diagnostic batch limit is invalid");
      if (final && !sealed) {
        sealed = true;
        if (pending.size > 0) failures.add("daemon_rpc_diagnostic_missing");
        pending.clear();
      }
      const diagnostics = completed.splice(0, limit);
      const remaining = limit - diagnostics.length;
      const batchFailures = [...failures].slice(0, remaining);
      for (const failure of batchFailures) failures.delete(failure);
      return {
        diagnostics,
        failures: batchFailures,
        done: sealed && completed.length === 0 && failures.size === 0,
      };
    },
  };
}

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
  collectRpcDiagnostics(
    consume: (batch: Case20DaemonRpcDiagnosticBatch) => void | Promise<void>,
  ): Promise<void>;
  close(): Promise<Case20AuditVerification>;
}

export interface Case20DaemonRpcDiagnosticDrainRequest {
  readonly type: "rpc_diagnostics_drain";
  readonly batchId: string;
  readonly batchIndex: number;
  readonly limit: number;
  readonly final: boolean;
}

interface Case20DaemonRpcDiagnosticBatchMessage extends Case20DaemonRpcDiagnosticBatch {
  readonly type: "rpc_diagnostic_batch";
  readonly batchId: string;
  readonly batchIndex: number;
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
  | Case20DaemonRpcDiagnosticBatchMessage
  | { readonly type: "closed"; readonly audit: Case20AuditVerification }
  | { readonly type: "failed"; readonly phase: "start" | "close"; readonly message: string };

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  return (
    type === "ready" ||
    type === "gc_checkpoint_ack" ||
    type === "gc_checkpoint_failed" ||
    type === "rpc_diagnostic_batch" ||
    type === "closed" ||
    type === "failed"
  );
}

function isSafeDiagnosticBatchId(value: unknown): value is string {
  return typeof value === "string" && /^case20-diagnostic-batch-[0-9]+$/.test(value);
}

function parseDaemonRpcDiagnostic(value: unknown): Case20DaemonRpcDiagnostic {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 4)
    throw new Error("Case20 daemon RPC diagnostic is invalid");
  if (
    typeof value.requestId !== "string" ||
    !CASE20_RPC_REQUEST_ID_PATTERN.test(value.requestId) ||
    !isDiagnosticRequestType(value.requestType) ||
    !isDiagnosticResponseType(value.responseType) ||
    !responseMatchesRequest(value.requestType, value.responseType) ||
    !Array.isArray(value.phases) ||
    value.phases.length !== CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.length
  )
    throw new Error("Case20 daemon RPC diagnostic fields are invalid");
  let previous = -1;
  const phases = value.phases.map((phase, index) => {
    if (
      !isRecord(phase) ||
      Reflect.ownKeys(phase).length !== 2 ||
      phase.phase !== CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES[index] ||
      typeof phase.monotonicUnixMs !== "number" ||
      !Number.isFinite(phase.monotonicUnixMs) ||
      phase.monotonicUnixMs < 0 ||
      phase.monotonicUnixMs < previous
    )
      throw new Error("Case20 daemon RPC diagnostic phase is invalid");
    previous = phase.monotonicUnixMs;
    return { phase: CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES[index]!, monotonicUnixMs: previous };
  });
  return {
    requestId: value.requestId,
    requestType: value.requestType,
    responseType: value.responseType,
    phases,
  };
}

function parseDaemonRpcDiagnosticBatchMessage(
  value: unknown,
  expected: { readonly batchId: string; readonly batchIndex: number },
): Case20DaemonRpcDiagnosticBatch {
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).length !== 6 ||
    value.type !== "rpc_diagnostic_batch" ||
    value.batchId !== expected.batchId ||
    value.batchIndex !== expected.batchIndex ||
    !Array.isArray(value.diagnostics) ||
    !Array.isArray(value.failures) ||
    typeof value.done !== "boolean" ||
    value.diagnostics.length + value.failures.length > CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT
  )
    throw new Error("Case20 daemon RPC diagnostic batch is invalid");
  const diagnostics = value.diagnostics.map(parseDaemonRpcDiagnostic);
  const failures = value.failures.map((failure) => {
    if (
      failure !== "daemon_rpc_diagnostic_invalid" &&
      failure !== "daemon_rpc_diagnostic_missing" &&
      failure !== "daemon_rpc_diagnostic_duplicate" &&
      failure !== "daemon_rpc_diagnostic_out_of_order" &&
      failure !== "daemon_rpc_diagnostic_overflow"
    )
      throw new Error("Case20 daemon RPC diagnostic failure is invalid");
    return failure;
  });
  return { diagnostics, failures, done: value.done };
}

export function installCase20DaemonRpcDiagnosticDrainHandler(input: {
  readonly source: {
    on(event: "message", listener: (value: unknown) => void): void;
    off(event: "message", listener: (value: unknown) => void): void;
  };
  readonly collector: Case20DaemonRpcDiagnosticCollector;
  readonly isClosing: () => boolean;
  readonly send: (message: Case20DaemonRpcDiagnosticBatchMessage) => void;
}): () => void {
  let expectedBatchIndex = 0;
  let sealed = false;
  const onMessage = (value: unknown) => {
    if (input.isClosing() || !isRecord(value) || value.type !== "rpc_diagnostics_drain") return;
    if (
      Reflect.ownKeys(value).length !== 5 ||
      !isSafeDiagnosticBatchId(value.batchId) ||
      value.batchIndex !== expectedBatchIndex ||
      !Number.isInteger(value.batchIndex) ||
      value.limit !== CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT ||
      typeof value.final !== "boolean" ||
      value.final !== !sealed
    )
      return;
    const batch = input.collector.drain({ limit: value.limit, final: value.final });
    sealed = true;
    input.send({
      type: "rpc_diagnostic_batch",
      batchId: value.batchId,
      batchIndex: value.batchIndex,
      ...batch,
    });
    expectedBatchIndex += 1;
  };
  input.source.on("message", onMessage);
  return () => input.source.off("message", onMessage);
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

function sendRpcDiagnosticDrainToChild(
  child: ChildProcess,
  request: Case20DaemonRpcDiagnosticDrainRequest,
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
  let rpcDiagnosticCollectionInFlight = false;
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
      async collectRpcDiagnostics(consume) {
        if (closed) throw new Error("Case20 daemon child is closed");
        if (rpcDiagnosticCollectionInFlight)
          throw new Error("Case20 daemon child already has diagnostic collection in flight");
        rpcDiagnosticCollectionInFlight = true;
        try {
          for (
            let batchIndex = 0;
            batchIndex < CASE20_DAEMON_RPC_DIAGNOSTIC_MAX_BATCHES;
            batchIndex += 1
          ) {
            const batchId = `case20-diagnostic-batch-${batchIndex}`;
            const pendingController = new AbortController();
            const pending = waitForMessage(
              child,
              (candidate) =>
                candidate.type === "rpc_diagnostic_batch" &&
                candidate.batchId === batchId &&
                candidate.batchIndex === batchIndex,
              10_000,
              `Case20 daemon RPC diagnostic batch ${batchIndex} timed out`,
              pendingController.signal,
            );
            try {
              await sendRpcDiagnosticDrainToChild(child, {
                type: "rpc_diagnostics_drain",
                batchId,
                batchIndex,
                limit: CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT,
                final: batchIndex === 0,
              });
            } catch (error) {
              pendingController.abort();
              await pending.catch(() => undefined);
              throw error;
            }
            const diagnosticMessage = await pending;
            const batch = parseDaemonRpcDiagnosticBatchMessage(diagnosticMessage, {
              batchId,
              batchIndex,
            });
            await consume(batch);
            if (batch.done) return;
          }
          throw new Error("Case20 daemon RPC diagnostic batches exceeded the collection limit");
        } finally {
          rpcDiagnosticCollectionInFlight = false;
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
