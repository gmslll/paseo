import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";
import {
  DaemonClient,
  type DaemonClientTrace,
  type Logger,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import {
  assertCase20ArtifactSecretFree,
  createCase20ArtifactWriter,
  validateCase20RawJsonl,
  writeCase20BufferCompletely,
} from "./artifact.js";
import { readPrivateManifest } from "./manifest.js";
import {
  CASE20_PART_A_CLIENT_COUNT,
  PartAManifestSchema,
  PartBManifestSchema,
  type Case20ClientRpcTraceEvent,
  type Case20ClientRuntimeMetricsEvent,
  type Case20Counts,
  type Case20RawEvent,
  type Case20RetainedRssCheckpointPlan,
  type Case20RetainedRssSample,
  type Case20ResourceSample,
  type Case20RunMeasurements,
} from "./model.js";
import { assertCase20PartBProviderPreflight } from "./provider-preflight.js";
import {
  case20ConcurrentBaselineForeignAgentIds,
  case20MeasuredWorkloadDeadlineMs,
  classifyCase20AgentList,
  cleanupCase20TimelineClients,
  createCase20ClientObservationController,
  createCase20ObservationBuffer,
  createCase20ObservedRpcTiming,
  createCase20RpcDiagnosticJoiner,
  createCase20RunnerEventLoopDelayObserver,
  establishCase20PartAMeasurementBoundary,
  isCase20AccessDenial,
  isUnexpectedCase20ConnectionTerminal,
  prepareCase20ObservedRpc,
  recordCase20RpcDiagnosticEvent,
} from "./part-a.js";
import {
  CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT,
  case20PartAChildExecArgv,
  createCase20DaemonRpcDiagnosticCollector,
} from "./part-a-fixture.js";
import {
  case20RetainedRssCheckpointDelayMs,
  captureCase20FinalCheckpointBeforeCanary,
  captureCase20RetainedRssCheckpoint,
  createCase20GarbageCollectionController,
  createCase20RetainedRssSchedule,
  installCase20ChildMessageHandler,
  type Case20GarbageCollectionRequest,
} from "./retained-rss.js";
import {
  case20ProviderOptions,
  isCompleteCase20ProviderProbe,
  parseCase20ProcessRows,
} from "./part-b.js";
import { createCase20Provenance } from "./provenance.js";
import {
  assertCase20GeneratedProviderHomeSecretFree,
  captureCase20ImmutableProviderFiles,
  createCase20AllowlistedBaseEnvironment,
  getCase20RealProviderConfig,
  installCase20ProviderParentEnvironment,
} from "./real-providers.js";
import { assertFileContainsNoSecrets } from "./secret-scan.js";
import { buildCase20Summary, theilSenSlopePerMinute } from "./summary.js";

const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);
type Case20ClientObservationTestEvent = Case20ClientRuntimeMetricsEvent | Case20ClientRpcTraceEvent;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function counts(overrides: Partial<Case20Counts> = {}): Case20Counts {
  return {
    requests: 1_000,
    succeeded: 1_000,
    failed: 0,
    unexpectedDisconnects: 0,
    crossPrincipalViolations: 0,
    wrongRouteViolations: 0,
    writeConflicts: 0,
    auditErrors: 0,
    providerCrashes: 0,
    providerRestarts: 0,
    ...overrides,
  };
}

// oxlint-disable-next-line complexity -- this fixture builds the complete cross-field evidence model.
function measurements(overrides: Partial<Case20RunMeasurements> = {}): Case20RunMeasurements {
  const startedAt = "2026-09-11T00:00:00.000Z";
  const endedAt = overrides.endedAt ?? "2026-09-11T00:30:00.000Z";
  const measurementEndedAt = overrides.measurementEndedAt ?? endedAt;
  const durationSec = overrides.durationSec ?? 1_800;
  const part = overrides.part ?? "A";
  const clients =
    overrides.clients ??
    Array.from({ length: CASE20_PART_A_CLIENT_COUNT }, (_, index) => ({
      id: `client-${index}`,
      principalId: `usr_${index.toString(16).padStart(16, "0")}`,
      connectedAt: startedAt,
      disconnectedAt: endedAt,
    }));
  const resourceSamples =
    overrides.resourceSamples ??
    Array.from({ length: 181 }, (_, index) => ({
      tSec: index * 10,
      rssMiB: 100,
      fdCount: 20,
      swapMiB: 0,
      eventLoopP99Ms: 10,
      sessions: 10,
      sockets: 10,
      processes: [],
    }));
  const retainedRssSchedule: readonly Case20RetainedRssCheckpointPlan[] | undefined =
    overrides.retainedRssSchedule ??
    (part === "A"
      ? createCase20RetainedRssSchedule(
          durationSec,
          (() => {
            let sequence = 0;
            return () => `gc-request-${sequence++}`;
          })(),
        )
      : undefined);
  const retainedRssSamples: readonly Case20RetainedRssSample[] | undefined =
    overrides.retainedRssSamples ??
    retainedRssSchedule?.map((checkpoint) => {
      const actualTSec = checkpoint.scheduledTSec + checkpoint.index / 100;
      const sample: Case20ResourceSample = {
        tSec: actualTSec,
        rssMiB: 100,
        fdCount: 20,
        swapMiB: 0,
        eventLoopP99Ms: 10,
        sessions: 10,
        sockets: 10,
        processes: [
          {
            pid: 42,
            parentPid: 1,
            identity: "f".repeat(64),
            rssMiB: 80,
            fdCount: 10,
          },
        ],
      };
      return {
        ...checkpoint,
        actualTSec,
        acknowledgedInMs: 5,
        gcDurationMs: 2,
        treeRssMiB: sample.rssMiB,
        daemonMainIdentity: sample.processes[0]!.identity,
        daemonMainRssMiB: sample.processes[0]!.rssMiB,
        sample,
      };
    });
  const finalActiveSample =
    overrides.finalActiveSample ??
    (resourceSamples.at(-1)
      ? {
          at: measurementEndedAt,
          sample: resourceSamples.at(-1)!,
          ...(part === "A"
            ? {
                principalStreams: clients.map((client) => ({
                  clientId: client.id,
                  principalId: client.principalId,
                  ownedCanaries: 1,
                  timelineCanaries: 1,
                })),
              }
            : {}),
        }
      : undefined);
  return {
    schemaVersion: 1,
    runId: "case20-test",
    startedAt,
    endedAt,
    measurementEndedAt,
    durationSec,
    part,
    mode: "formal",
    provenance: {
      commit: "a".repeat(40),
      tree: "c".repeat(40),
      trackedClean: true,
      statusSha256: "d".repeat(64),
      diffSha256: "e".repeat(64),
      untrackedFiles: [],
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "v22.0.0",
      manifestSha256: "b".repeat(64),
      binaries: {},
    },
    clients,
    counts: counts(),
    feedbackLatencyMs: Array.from({ length: CASE20_PART_A_CLIENT_COUNT }, () => 100),
    rpcLatencyMs: {
      fetch_agents: [100, 110, 120, 115, 105, 111, 109, 108, 112, 114],
      foreign_fetch_agent_denial: [100, 110, 120, 115, 105, 111, 109, 108, 112, 114],
    },
    rpcBaselineLatencyMs: {
      fetch_agents: [100, 100, 100],
      foreign_fetch_agent_denial: [100, 100, 100],
    },
    resourceSamples,
    ...(retainedRssSchedule ? { retainedRssSchedule } : {}),
    ...(retainedRssSamples ? { retainedRssSamples } : {}),
    ...(finalActiveSample ? { finalActiveSample } : {}),
    ...(part === "A"
      ? {
          streamCoverageStartedAt: "2026-09-10T23:59:59.000Z",
          postCloseResourceSample: {
            ...resourceSamples.at(-1)!,
            tSec: (resourceSamples.at(-1)?.tSec ?? 0) + 1,
            sessions: 0,
            sockets: 0,
          },
        }
      : {}),
    sampleIntervalMs: 10_000,
    ...overrides,
  };
}

function retainedMemorySample(
  checkpoint: Case20RetainedRssSample,
  input: {
    readonly treeRssMiB: number;
    readonly daemonMainRssMiB: number;
    readonly actualTSec?: number;
    readonly daemonMainIdentity?: string;
    readonly sessions?: number;
    readonly sockets?: number;
  },
): Case20RetainedRssSample {
  const actualTSec = input.actualTSec ?? checkpoint.actualTSec;
  const daemonMainIdentity = input.daemonMainIdentity ?? checkpoint.daemonMainIdentity;
  return {
    ...checkpoint,
    actualTSec,
    treeRssMiB: input.treeRssMiB,
    daemonMainIdentity,
    daemonMainRssMiB: input.daemonMainRssMiB,
    sample: {
      ...checkpoint.sample,
      tSec: actualTSec,
      rssMiB: input.treeRssMiB,
      sessions: input.sessions ?? checkpoint.sample.sessions,
      sockets: input.sockets ?? checkpoint.sample.sockets,
      processes: Array.from(checkpoint.sample.processes, (process) => ({
        ...process,
        identity: daemonMainIdentity,
        rssMiB: input.daemonMainRssMiB,
      })),
    },
  };
}

function noopLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createCase20ObservationTransport() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  let onMessage: (data: unknown, isBinary: boolean) => void = () => {};
  let onOpen: () => void = () => {};
  const transport: DaemonTransport = {
    send(data) {
      sent.push(data);
    },
    close() {},
    onMessage(handler) {
      onMessage = handler;
      return () => {};
    },
    onOpen(handler) {
      onOpen = handler;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
  const triggerSessionMessage = (message: SessionOutboundMessage) => {
    onMessage(JSON.stringify({ type: "session", message }), false);
  };
  return {
    transport,
    sent,
    triggerOpen() {
      onOpen();
      triggerSessionMessage({
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_case20_observation",
          hostname: null,
          version: null,
        },
      });
      sent.length = 0;
    },
    triggerSessionMessage,
  };
}

function parseCase20ObservationRequest(frame: string | Uint8Array | ArrayBuffer): {
  readonly type: string;
  readonly requestId: string;
} {
  if (typeof frame !== "string") throw new Error("Expected text request frame");
  const envelope = JSON.parse(frame) as {
    readonly type: string;
    readonly message: { readonly type: string; readonly requestId: string };
  };
  return envelope.message;
}

function emitCase20TraceFrame(
  trace: DaemonClientTrace,
  messageType: string,
  envelopeType = "session",
): void {
  trace.beginSection("paseo.ws.frame.inbound", { kind: "text", size: "100" });
  trace.beginSection("paseo.ws.json.parse", { size: "100" });
  trace.endSection();
  trace.beginSection("paseo.ws.message.inbound", {
    envelopeType,
    messageType,
  });
  trace.endSection();
  trace.endSection();
}

function emitCase20TraceOutboundMessage(
  trace: DaemonClientTrace,
  messageType: string,
  envelopeType = "session",
): void {
  trace.beginSection("paseo.ws.message.outbound", {
    envelopeType,
    messageType,
  });
  trace.endSection();
}

function emitCase20TraceOutboundFrame(trace: DaemonClientTrace): void {
  trace.beginSection("paseo.ws.frame.outbound", { kind: "text", size: "100" });
  trace.endSection();
}

function emitCase20TraceOutbound(trace: DaemonClientTrace, messageType: string): void {
  emitCase20TraceOutboundMessage(trace, messageType);
  emitCase20TraceOutboundFrame(trace);
}

function emitCase20LivenessPing(trace: DaemonClientTrace): void {
  emitCase20TraceOutboundMessage(trace, "ping", "ping");
  emitCase20TraceOutboundFrame(trace);
}

const CASE20_TEST_RPC_PHASES = [
  "frame.received",
  "session.call",
  "session.enter",
  "response.deliver.begin",
  "response.stringify.begin",
  "response.stringify.return",
  "response.send.begin",
  "response.send.return",
  "response.deliver.return",
] as const;

function observeCompleteCase20DaemonRpc(input: {
  readonly collector: ReturnType<typeof createCase20DaemonRpcDiagnosticCollector>;
  readonly requestId: string;
  readonly requestType: "fetch_agents_request" | "fetch_agent_request";
  readonly responseType: "fetch_agents_response" | "fetch_agent_response" | "rpc_error";
  readonly startedAtUnixMs: number;
}): void {
  for (const [index, phase] of CASE20_TEST_RPC_PHASES.entries()) {
    input.collector.observe({
      phase,
      requestId: input.requestId,
      ...(index < 3 ? { requestType: input.requestType } : { responseType: input.responseType }),
      atUnixMs: input.startedAtUnixMs + index,
    });
  }
}

function case20TestDaemonDiagnostic(input: {
  readonly requestId: string;
  readonly requestType: "fetch_agents_request" | "fetch_agent_request";
  readonly responseType: "fetch_agents_response" | "fetch_agent_response" | "rpc_error";
  readonly startedAtUnixMs: number;
}) {
  return {
    requestId: input.requestId,
    requestType: input.requestType,
    responseType: input.responseType,
    phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
      phase,
      monotonicUnixMs: input.startedAtUnixMs + index,
    })),
  };
}

function case20TestClientTrace(input: {
  readonly requestId: string;
  readonly clientId?: string;
  readonly sequence?: number;
  readonly baseline?: boolean;
  readonly name?: "fetch_agents" | "foreign_fetch_agent_denial";
  readonly rpcStartedMonotonicUnixMs?: number;
  readonly messageOutboundBeginMonotonicUnixMs?: number;
  readonly messageOutboundEndMonotonicUnixMs?: number;
  readonly frameOutboundBeginMonotonicUnixMs?: number;
  readonly frameOutboundEndMonotonicUnixMs?: number;
  readonly frameBeginMonotonicUnixMs?: number;
}): Case20ClientRpcTraceEvent {
  const name = input.name ?? "fetch_agents";
  const rpcStartedMonotonicUnixMs = input.rpcStartedMonotonicUnixMs ?? 100;
  const frameBeginMonotonicUnixMs = input.frameBeginMonotonicUnixMs ?? 120;
  return {
    type: "client_rpc_trace",
    at: "2026-09-11T00:00:00.000Z",
    clientId: input.clientId ?? "case20-client-01",
    sequence: input.sequence ?? 1,
    baseline: input.baseline ?? false,
    name,
    messageType: name === "fetch_agents" ? "fetch_agents_response" : "rpc_error",
    requestId: input.requestId,
    rpcStartedMonotonicUnixMs,
    messageOutboundBeginMonotonicUnixMs:
      input.messageOutboundBeginMonotonicUnixMs ?? rpcStartedMonotonicUnixMs + 1,
    messageOutboundEndMonotonicUnixMs:
      input.messageOutboundEndMonotonicUnixMs ?? rpcStartedMonotonicUnixMs + 2,
    frameOutboundBeginMonotonicUnixMs:
      input.frameOutboundBeginMonotonicUnixMs ?? rpcStartedMonotonicUnixMs + 3,
    frameOutboundEndMonotonicUnixMs:
      input.frameOutboundEndMonotonicUnixMs ?? rpcStartedMonotonicUnixMs + 4,
    frameBeginMonotonicUnixMs,
    frameEndMonotonicUnixMs: frameBeginMonotonicUnixMs + 10,
    promiseResumedMonotonicUnixMs: frameBeginMonotonicUnixMs + 11,
    callbackTotalMs: 10,
    decodeBeforeParseMs: 1,
    jsonParseMs: 2,
    aotValidateMs: 3,
    dispatchAndWaiterMs: 4,
    frameEndToPromiseResumeMs: 1,
  };
}

describe("Case20 evidence helpers", () => {
  test("collects complete daemon RPC phases in bounded batches for success and rpc_error", () => {
    const collector = createCase20DaemonRpcDiagnosticCollector({ capacity: 4 });
    observeCompleteCase20DaemonRpc({
      collector,
      requestId: "case20-rpc-00000000000000000000000000000001",
      requestType: "fetch_agents_request",
      responseType: "fetch_agents_response",
      startedAtUnixMs: 100,
    });
    observeCompleteCase20DaemonRpc({
      collector,
      requestId: "case20-rpc-00000000000000000000000000000002",
      requestType: "fetch_agent_request",
      responseType: "rpc_error",
      startedAtUnixMs: 200,
    });

    expect(collector.drain({ limit: 1, final: true })).toEqual({
      diagnostics: [
        {
          requestId: "case20-rpc-00000000000000000000000000000001",
          requestType: "fetch_agents_request",
          responseType: "fetch_agents_response",
          phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
            phase,
            monotonicUnixMs: 100 + index,
          })),
        },
      ],
      failures: [],
      done: false,
    });
    expect(collector.drain({ limit: 1, final: false })).toEqual({
      diagnostics: [
        {
          requestId: "case20-rpc-00000000000000000000000000000002",
          requestType: "fetch_agent_request",
          responseType: "rpc_error",
          phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
            phase,
            monotonicUnixMs: 200 + index,
          })),
        },
      ],
      failures: [],
      done: true,
    });
  });

  test("fails closed for missing, duplicate, out-of-order, overflow, and unknown daemon fields", () => {
    const requestId = "case20-rpc-00000000000000000000000000000003";
    const missing = createCase20DaemonRpcDiagnosticCollector({ capacity: 2 });
    missing.observe({
      phase: "frame.received",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 1,
    });
    expect(missing.drain({ limit: 2, final: true })).toEqual({
      diagnostics: [],
      failures: ["daemon_rpc_diagnostic_missing"],
      done: true,
    });

    const duplicate = createCase20DaemonRpcDiagnosticCollector({ capacity: 2 });
    duplicate.observe({
      phase: "frame.received",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 1,
    });
    duplicate.observe({
      phase: "frame.received",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 2,
    });
    expect(duplicate.drain({ limit: 2, final: true })).toEqual({
      diagnostics: [],
      failures: ["daemon_rpc_diagnostic_duplicate"],
      done: true,
    });

    const outOfOrder = createCase20DaemonRpcDiagnosticCollector({ capacity: 2 });
    outOfOrder.observe({
      phase: "frame.received",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 1,
    });
    outOfOrder.observe({
      phase: "session.enter",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 2,
    });
    expect(outOfOrder.drain({ limit: 2, final: true })).toEqual({
      diagnostics: [],
      failures: ["daemon_rpc_diagnostic_out_of_order"],
      done: true,
    });

    const overflow = createCase20DaemonRpcDiagnosticCollector({ capacity: 1 });
    observeCompleteCase20DaemonRpc({
      collector: overflow,
      requestId,
      requestType: "fetch_agents_request",
      responseType: "fetch_agents_response",
      startedAtUnixMs: 10,
    });
    overflow.observe({
      phase: "frame.received",
      requestId: "case20-rpc-00000000000000000000000000000004",
      requestType: "fetch_agent_request",
      atUnixMs: 30,
    });
    expect(overflow.drain({ limit: 1, final: true })).toEqual({
      diagnostics: [
        {
          requestId,
          requestType: "fetch_agents_request",
          responseType: "fetch_agents_response",
          phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
            phase,
            monotonicUnixMs: 10 + index,
          })),
        },
      ],
      failures: [],
      done: false,
    });
    expect(overflow.drain({ limit: 1, final: false })).toEqual({
      diagnostics: [],
      failures: ["daemon_rpc_diagnostic_overflow"],
      done: true,
    });

    const unknown = createCase20DaemonRpcDiagnosticCollector({ capacity: 2 });
    unknown.observe({
      phase: "frame.received",
      requestId,
      requestType: "fetch_agents_request",
      atUnixMs: 1,
      personalAccessToken: "pso_u_private.secret-material-that-must-never-persist",
      privatePath: "/private/runner/home",
    });
    const unknownResult = unknown.drain({ limit: 2, final: true });
    expect(unknownResult).toEqual({
      diagnostics: [],
      failures: ["daemon_rpc_diagnostic_invalid"],
      done: true,
    });
    expect(JSON.stringify(unknownResult)).not.toContain("secret-material");
    expect(JSON.stringify(unknownResult)).not.toContain("/private/runner/home");
  });

  test("drains daemon RPC diagnostics through bounded child IPC batches", async () => {
    const child = fork(
      fileURLToPath(new URL("./rpc-diagnostic-smoke-child.ts", import.meta.url)),
      [],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const send = (message: object) =>
      new Promise<void>((resolve, reject) => {
        child.send(message, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    try {
      expect((await once(child, "message"))[0]).toEqual({ type: "smoke_ready" });
      const response = once(child, "message");
      await send({
        type: "rpc_diagnostics_drain",
        batchId: "case20-diagnostic-batch-0",
        batchIndex: 0,
        limit: CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT,
        final: true,
      });
      const firstBatch = (await response)[0] as {
        readonly diagnostics: readonly unknown[];
        readonly failures: readonly unknown[];
        readonly done: boolean;
      };
      expect(firstBatch.diagnostics).toHaveLength(CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT);
      expect(firstBatch.failures).toEqual([]);
      expect(firstBatch.done).toBe(false);
      const finalResponse = once(child, "message");
      await send({
        type: "rpc_diagnostics_drain",
        batchId: "case20-diagnostic-batch-1",
        batchIndex: 1,
        limit: CASE20_DAEMON_RPC_DIAGNOSTIC_BATCH_LIMIT,
        final: false,
      });
      expect((await finalResponse)[0]).toEqual({
        type: "rpc_diagnostic_batch",
        batchId: "case20-diagnostic-batch-1",
        batchIndex: 1,
        diagnostics: [
          {
            requestId: "case20-rpc-00000000000000000000000000000101",
            requestType: "fetch_agents_request",
            responseType: "fetch_agents_response",
            phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
              phase,
              monotonicUnixMs: 25_700 + index,
            })),
          },
        ],
        failures: [],
        done: true,
      });
      const closed = once(child, "message");
      const exited = once(child, "exit");
      await send({ type: "shutdown" });
      expect((await closed)[0]).toEqual({ type: "smoke_closed" });
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });

  test("joins registered client and daemon success and rpc_error diagnostics into raw events", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const joiner = createCase20RpcDiagnosticJoiner({
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowIso: () => "2026-09-11T00:00:01.000Z",
    });
    const listRequestId = "case20-rpc-00000000000000000000000000000021";
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 1,
      baseline: true,
      name: "fetch_agents",
      requestId: listRequestId,
      rpcStartedMonotonicUnixMs: 100,
    });
    joiner.recordClient(case20TestClientTrace({ requestId: listRequestId, baseline: true }));
    joiner.recordDaemon(
      case20TestDaemonDiagnostic({
        requestId: listRequestId,
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        startedAtUnixMs: 105,
      }),
    );
    const denialRequestId = "case20-rpc-00000000000000000000000000000022";
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 2,
      baseline: false,
      name: "foreign_fetch_agent_denial",
      requestId: denialRequestId,
      rpcStartedMonotonicUnixMs: 200,
    });
    joiner.recordClient(
      case20TestClientTrace({
        requestId: denialRequestId,
        sequence: 2,
        name: "foreign_fetch_agent_denial",
        rpcStartedMonotonicUnixMs: 200,
        frameBeginMonotonicUnixMs: 220,
      }),
    );
    joiner.recordDaemon(
      case20TestDaemonDiagnostic({
        requestId: denialRequestId,
        requestType: "fetch_agent_request",
        responseType: "rpc_error",
        startedAtUnixMs: 205,
      }),
    );
    joiner.recordDaemon(
      case20TestDaemonDiagnostic({
        requestId: "case20-rpc-00000000000000000000000000000029",
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        startedAtUnixMs: 300,
      }),
    );
    joiner.finish();

    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "rpc_diagnostic",
        clientId: "case20-client-01",
        sequence: 1,
        baseline: true,
        name: "fetch_agents",
        requestId: listRequestId,
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        client: expect.objectContaining({
          rpcStartedMonotonicUnixMs: 100,
          messageOutboundBeginMonotonicUnixMs: 101,
          messageOutboundEndMonotonicUnixMs: 102,
          frameOutboundBeginMonotonicUnixMs: 103,
          frameOutboundEndMonotonicUnixMs: 104,
          frameBeginMonotonicUnixMs: 120,
          frameEndMonotonicUnixMs: 130,
          promiseResumedMonotonicUnixMs: 131,
        }),
        daemon: {
          phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
            phase,
            monotonicUnixMs: 105 + index,
          })),
        },
        crossProcessClock: {
          calibrated: false,
          frameOutboundEndToDaemonFrameReceivedMs: 1,
          daemonResponseDeliverReturnToClientFrameBeginMs: 7,
        },
      }),
      expect.objectContaining({
        type: "rpc_diagnostic",
        sequence: 2,
        name: "foreign_fetch_agent_denial",
        requestId: denialRequestId,
        requestType: "fetch_agent_request",
        responseType: "rpc_error",
      }),
    ]);
    expect(failures).toEqual(["rpc_diagnostic_join_invalid"]);
    expect(JSON.stringify(events)).not.toContain("private/");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  test("joins diagnostics across positive and negative uncalibrated process clock offsets", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const joiner = createCase20RpcDiagnosticJoiner({
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
    });
    const clientAhead = "case20-rpc-00000000000000000000000000000031";
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 1,
      baseline: false,
      name: "fetch_agents",
      requestId: clientAhead,
      rpcStartedMonotonicUnixMs: 1_000,
    });
    joiner.recordClient(
      case20TestClientTrace({
        requestId: clientAhead,
        rpcStartedMonotonicUnixMs: 1_000,
        frameBeginMonotonicUnixMs: 1_020,
      }),
    );
    joiner.recordDaemon(
      case20TestDaemonDiagnostic({
        requestId: clientAhead,
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        startedAtUnixMs: 105,
      }),
    );

    const daemonAhead = "case20-rpc-00000000000000000000000000000032";
    joiner.expect({
      clientId: "case20-client-02",
      sequence: 1,
      baseline: false,
      name: "fetch_agents",
      requestId: daemonAhead,
      rpcStartedMonotonicUnixMs: 100,
    });
    joiner.recordClient(
      case20TestClientTrace({ requestId: daemonAhead, clientId: "case20-client-02" }),
    );
    joiner.recordDaemon(
      case20TestDaemonDiagnostic({
        requestId: daemonAhead,
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        startedAtUnixMs: 1_005,
      }),
    );
    joiner.finish();

    expect(failures).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "rpc_diagnostic",
        sequence: 1,
        crossProcessClock: {
          calibrated: false,
          frameOutboundEndToDaemonFrameReceivedMs: -899,
          daemonResponseDeliverReturnToClientFrameBeginMs: 907,
        },
      }),
      expect.objectContaining({
        type: "rpc_diagnostic",
        sequence: 1,
        crossProcessClock: {
          calibrated: false,
          frameOutboundEndToDaemonFrameReceivedMs: 901,
          daemonResponseDeliverReturnToClientFrameBeginMs: -893,
        },
      }),
    ]);
  });

  test("persists the first rejected join with allowlisted identity, reason, and boundaries", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const joiner = createCase20RpcDiagnosticJoiner({
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowIso: () => "2026-09-11T00:00:02.000Z",
    });
    const first = "case20-rpc-00000000000000000000000000000033";
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 1,
      baseline: false,
      name: "fetch_agents",
      requestId: first,
      rpcStartedMonotonicUnixMs: 100,
    });
    joiner.recordClient(
      case20TestClientTrace({
        requestId: first,
        messageOutboundBeginMonotonicUnixMs: 102,
        messageOutboundEndMonotonicUnixMs: 101,
      }),
    );
    const second = "case20-rpc-00000000000000000000000000000034";
    joiner.expect({
      clientId: "case20-client-02",
      sequence: 1,
      baseline: false,
      name: "fetch_agents",
      requestId: second,
      rpcStartedMonotonicUnixMs: 200,
    });
    const invalidDaemon = case20TestDaemonDiagnostic({
      requestId: second,
      requestType: "fetch_agents_request",
      responseType: "fetch_agents_response",
      startedAtUnixMs: 205,
    });
    joiner.recordDaemon({
      ...invalidDaemon,
      phases: invalidDaemon.phases.map((sample, index) =>
        index === 4 ? { phase: sample.phase, monotonicUnixMs: 204 } : sample,
      ),
    });
    joiner.finish();

    expect(failures).toEqual([
      "rpc_diagnostic_join_out_of_order",
      "rpc_diagnostic_join_out_of_order",
    ]);
    expect(events).toEqual([
      {
        type: "rpc_diagnostic_rejected",
        at: "2026-09-11T00:00:02.000Z",
        clientId: "case20-client-01",
        sequence: 1,
        expectedSequence: 1,
        name: "fetch_agents",
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        reason: "client_trace_out_of_order",
        boundaries: {
          clientRpcStartedMonotonicUnixMs: 100,
          clientMessageOutboundBeginMonotonicUnixMs: 102,
          clientMessageOutboundEndMonotonicUnixMs: 101,
          clientFrameOutboundBeginMonotonicUnixMs: 103,
          clientFrameOutboundEndMonotonicUnixMs: 104,
          clientFrameBeginMonotonicUnixMs: 120,
          clientFrameEndMonotonicUnixMs: 130,
          clientPromiseResumedMonotonicUnixMs: 131,
          daemonFrameReceivedMonotonicUnixMs: null,
          daemonResponseDeliverReturnMonotonicUnixMs: null,
        },
      },
    ]);
  });

  test("persists daemon internal order and type rejection reasons without unknown fields", () => {
    const reject = (
      diagnostic: ReturnType<typeof case20TestDaemonDiagnostic>,
      expectedReason: string,
    ) => {
      const events: Case20RawEvent[] = [];
      const failures: string[] = [];
      const joiner = createCase20RpcDiagnosticJoiner({
        record: (event) => events.push(event),
        onFailure: (code) => failures.push(code),
      });
      joiner.expect({
        clientId: "case20-client-01",
        sequence: 1,
        baseline: false,
        name: "fetch_agents",
        requestId: diagnostic.requestId,
        rpcStartedMonotonicUnixMs: 100,
      });
      joiner.recordClient(case20TestClientTrace({ requestId: diagnostic.requestId }));
      joiner.recordDaemon(diagnostic);
      joiner.finish();
      expect(failures).toEqual(["rpc_diagnostic_join_out_of_order"]);
      expect(events).toEqual([
        expect.objectContaining({
          type: "rpc_diagnostic_rejected",
          sequence: 1,
          expectedSequence: 1,
          name: "fetch_agents",
          requestType: diagnostic.requestType,
          responseType: diagnostic.responseType,
          reason: expectedReason,
          boundaries: expect.objectContaining({
            clientFrameOutboundEndMonotonicUnixMs: 104,
            daemonFrameReceivedMonotonicUnixMs: 105,
            daemonResponseDeliverReturnMonotonicUnixMs: 113,
          }),
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("private/");
      expect(JSON.stringify(events)).not.toContain("secret");
    };

    const internalOrder = case20TestDaemonDiagnostic({
      requestId: "case20-rpc-00000000000000000000000000000035",
      requestType: "fetch_agents_request",
      responseType: "fetch_agents_response",
      startedAtUnixMs: 105,
    });
    reject(
      {
        ...internalOrder,
        phases: internalOrder.phases.map((sample, index) =>
          index === 4 ? { phase: sample.phase, monotonicUnixMs: 104 } : sample,
        ),
      },
      "daemon_trace_out_of_order",
    );
    reject(
      {
        ...case20TestDaemonDiagnostic({
          requestId: "case20-rpc-00000000000000000000000000000037",
          requestType: "fetch_agents_request",
          responseType: "fetch_agents_response",
          startedAtUnixMs: 105,
        }),
        ignoredUnknown: "private/secret-token",
      } as ReturnType<typeof case20TestDaemonDiagnostic>,
      "daemon_trace_invalid",
    );
    reject(
      case20TestDaemonDiagnostic({
        requestId: "case20-rpc-00000000000000000000000000000036",
        requestType: "fetch_agent_request",
        responseType: "rpc_error",
        startedAtUnixMs: 105,
      }),
      "request_type_mismatch",
    );
    reject(
      case20TestDaemonDiagnostic({
        requestId: "case20-rpc-00000000000000000000000000000039",
        requestType: "fetch_agents_request",
        responseType: "rpc_error",
        startedAtUnixMs: 105,
      }),
      "response_type_mismatch",
    );
  });

  test("persists a true expected sequence mismatch and fails closed", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const joiner = createCase20RpcDiagnosticJoiner({
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
    });
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 2,
      baseline: false,
      name: "fetch_agents",
      requestId: "case20-rpc-00000000000000000000000000000038",
      rpcStartedMonotonicUnixMs: 100,
    });
    joiner.finish();

    expect(failures).toEqual(["rpc_diagnostic_join_out_of_order"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "rpc_diagnostic_rejected",
        clientId: "case20-client-01",
        sequence: 2,
        expectedSequence: 1,
        name: "fetch_agents",
        requestType: "fetch_agents_request",
        responseType: "fetch_agents_response",
        reason: "expected_sequence_mismatch",
      }),
    ]);
  });

  test("reserves raw buffer capacity for the first rejected join", () => {
    const failures: string[] = [];
    const buffer = createCase20ObservationBuffer({
      capacity: 3,
      reservedFailureEvents: 1,
      onOverflow: () => failures.push("overflow"),
    });
    const ordinaryEvent: Case20RawEvent = {
      type: "run_started",
      at: "2026-09-11T00:00:00.000Z",
      part: "A",
      mode: "smoke",
      runId: "clock-contract",
    };
    expect(buffer.record(ordinaryEvent)).toBe(true);
    expect(buffer.record(ordinaryEvent)).toBe(true);
    const joiner = createCase20RpcDiagnosticJoiner({
      record: (event) => recordCase20RpcDiagnosticEvent(buffer, event),
      onFailure: (code) => failures.push(code),
    });
    joiner.expect({
      clientId: "case20-client-01",
      sequence: 2,
      baseline: false,
      name: "fetch_agents",
      requestId: "case20-rpc-00000000000000000000000000000040",
      rpcStartedMonotonicUnixMs: 100,
    });

    expect(failures).toEqual(["rpc_diagnostic_join_out_of_order"]);
    expect(buffer.drain()).toEqual([
      ordinaryEvent,
      ordinaryEvent,
      expect.objectContaining({
        type: "rpc_diagnostic_rejected",
        sequence: 2,
        expectedSequence: 1,
        reason: "expected_sequence_mismatch",
      }),
    ]);
  });

  test("fails closed on missing, duplicate, and overflow joins", () => {
    const run = (
      exercise: (joiner: ReturnType<typeof createCase20RpcDiagnosticJoiner>) => void,
      capacity = 4,
    ) => {
      const events: Case20RawEvent[] = [];
      const failures: string[] = [];
      const joiner = createCase20RpcDiagnosticJoiner({
        record: (event) => events.push(event),
        onFailure: (code) => failures.push(code),
        capacity,
      });
      exercise(joiner);
      joiner.finish();
      expect(events).toEqual([]);
      return failures;
    };
    const expected = (requestId: string, sequence = 1, clientId = "case20-client-01") => ({
      clientId,
      sequence,
      baseline: false,
      name: "fetch_agents" as const,
      requestId,
      rpcStartedMonotonicUnixMs: 100,
    });
    const first = "case20-rpc-00000000000000000000000000000031";
    const second = "case20-rpc-00000000000000000000000000000032";

    expect(run((joiner) => joiner.expect(expected(first)))).toEqual([
      "rpc_diagnostic_join_missing",
    ]);
    expect(
      run((joiner) => {
        joiner.expect(expected(first));
        joiner.expect(expected(first));
      }),
    ).toEqual(["rpc_diagnostic_join_duplicate", "rpc_diagnostic_join_missing"]);
    expect(
      run((joiner) => {
        joiner.expect(expected(first));
        const trace = case20TestClientTrace({ requestId: first });
        joiner.recordClient(trace);
        joiner.recordClient(trace);
      }),
    ).toEqual(["rpc_diagnostic_join_duplicate"]);
    expect(
      run((joiner) => {
        joiner.expect(expected(first));
        const diagnostic = case20TestDaemonDiagnostic({
          requestId: first,
          requestType: "fetch_agents_request",
          responseType: "fetch_agents_response",
          startedAtUnixMs: 105,
        });
        joiner.recordDaemon(diagnostic);
        joiner.recordDaemon(diagnostic);
      }),
    ).toEqual(["rpc_diagnostic_join_duplicate"]);
    expect(
      run((joiner) => {
        joiner.expect(expected(first));
        joiner.expect(expected(second, 1, "case20-client-02"));
      }, 1),
    ).toEqual(["rpc_diagnostic_join_overflow", "rpc_diagnostic_join_missing"]);
  });

  test("caps buffered observations and reserves a durable fail-closed marker", () => {
    const overflowSignals: string[] = [];
    const failure: Case20RawEvent = {
      type: "failure",
      at: "2026-09-11T00:00:00.000Z",
      failure: {
        code: "observation_buffer_limit_exceeded",
        metric: "runner.observation_buffer",
        observed: "runner",
        threshold: "complete valid observation",
        evidenceRef: "raw.jsonl",
      },
    };
    let buffer: ReturnType<typeof createCase20ObservationBuffer>;
    buffer = createCase20ObservationBuffer({
      capacity: 4,
      reservedFailureEvents: 1,
      onOverflow: () => {
        overflowSignals.push("limit");
        expect(buffer.recordFailure(failure)).toBe(true);
      },
    });
    const observation: Case20RawEvent = {
      type: "runner_event_loop_delay",
      at: "2026-09-11T00:00:01.000Z",
      windowStartedAtMs: 0,
      windowEndedAtMs: 1_000,
      intervalMs: 1_000,
      sampleCount: 1,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      maxMs: 4,
      final: false,
    };

    expect(buffer.record(observation)).toBe(true);
    expect(buffer.record(observation)).toBe(true);
    expect(buffer.record(observation)).toBe(true);
    expect(buffer.record(observation)).toBe(false);
    expect(buffer.record(observation)).toBe(false);
    expect(buffer.size).toBe(4);
    expect(overflowSignals).toEqual(["limit"]);
    expect(buffer.drain()).toEqual([observation, observation, observation, failure]);
    expect(buffer.size).toBe(0);
  });

  test("strictly allowlists client runtime metric windows in memory", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const controller = createCase20ClientObservationController({
      clientId: "case20-client-01",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowIso: () => "2026-09-11T00:00:01.000Z",
      delegateLogger: noopLogger(),
    });
    controller.logger.info(
      {
        windowMs: 1_000,
        rollingWindowMs: 1_000,
        bucketCount: 1,
        final: false,
        connectionPath: "direct",
        serverId: "private-hostname.invalid",
        connectionStatus: "connected",
        inboundMessageTypesTop: [
          ["agent_stream", 99],
          ["fetch_agents_response", 3],
          ["rpc_error", 2],
        ],
        inboundMessageBytesTop: [
          ["agent_stream", 9_999],
          ["fetch_agents_response", 300],
          ["rpc_error", 120],
        ],
        inboundAgentStreamAgentsTop: [["agt_private", 99]],
        handlerTimingTop: [
          { type: "agent_stream", count: 99, totalMs: 90, avgMs: 0.91, maxMs: 2 },
          { type: "fetch_agents_response", count: 3, totalMs: 12, avgMs: 4, maxMs: 6 },
          { type: "rpc_error", count: 2, totalMs: 8, avgMs: 4, maxMs: 5 },
        ],
        privatePath: "/private/runner/home",
        personalAccessToken: "pso_u_private.secret-material-that-must-never-persist",
      },
      "ws_runtime_metrics_client",
    );
    for (let index = 0; index < 2; index += 1) {
      controller.logger.info(
        {
          windowMs: -1,
          rollingWindowMs: 1_000,
          bucketCount: 1,
          final: false,
          connectionPath: "direct",
          connectionStatus: "connected",
          inboundMessageTypesTop: [],
          inboundMessageBytesTop: [],
          handlerTimingTop: [],
        },
        "ws_runtime_metrics_client",
      );
    }
    controller.logger.info(
      {
        windowMs: 1_000,
        rollingWindowMs: 1_000,
        bucketCount: 0,
        final: true,
        connectionPath: "direct",
        connectionStatus: "connected",
        inboundMessageTypesTop: [],
        inboundMessageBytesTop: [],
        handlerTimingTop: [],
      },
      "ws_runtime_metrics_client",
    );
    controller.seal();

    expect(events).toEqual([
      {
        type: "client_runtime_metrics",
        at: "2026-09-11T00:00:01.000Z",
        clientId: "case20-client-01",
        windowMs: 1_000,
        rollingWindowMs: 1_000,
        bucketCount: 1,
        final: false,
        connectionPath: "direct",
        connectionStatus: "connected",
        messages: [
          {
            messageType: "fetch_agents_response",
            count: 3,
            bytes: 300,
            handlerCount: 3,
            handlerTotalMs: 12,
            handlerAvgMs: 4,
            handlerMaxMs: 6,
          },
          {
            messageType: "rpc_error",
            count: 2,
            bytes: 120,
            handlerCount: 2,
            handlerTotalMs: 8,
            handlerAvgMs: 4,
            handlerMaxMs: 5,
          },
          {
            messageType: "agent_stream",
            count: 99,
            bytes: 9_999,
            handlerCount: 99,
            handlerTotalMs: 90,
            handlerAvgMs: 0.91,
            handlerMaxMs: 2,
          },
        ],
      },
      {
        type: "client_runtime_metrics",
        at: "2026-09-11T00:00:01.000Z",
        clientId: "case20-client-01",
        windowMs: 1_000,
        rollingWindowMs: 1_000,
        bucketCount: 0,
        final: true,
        connectionPath: "direct",
        connectionStatus: "connected",
        messages: [],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-hostname");
    expect(JSON.stringify(events)).not.toContain("agt_private");
    expect(JSON.stringify(events)).not.toContain("/private/runner/home");
    expect(JSON.stringify(events)).not.toContain("secret-material");
    expect(failures).toEqual(["client_runtime_metrics_invalid"]);
  });

  test("records only the armed target frame with nested LIFO trace timings", () => {
    const events: Case20ClientObservationTestEvent[] = [];
    const failures: string[] = [];
    const times = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 23, 25, 26, 30];
    const controller = createCase20ClientObservationController({
      clientId: "case20-client-02",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowMonotonicUnixMs: () => times.shift()!,
      nowIso: () => "2026-09-11T00:00:02.000Z",
      delegateLogger: noopLogger(),
    });

    expect(
      controller.armRpc({
        name: "fetch_agents",
        baseline: true,
        requestId: "case20-rpc-00000000000000000000000000000011",
        rpcStartedMonotonicUnixMs: 0,
      }),
    ).toBe(1);
    expect(controller.trace.isEnabled()).toBe(true);
    emitCase20TraceOutbound(controller.trace, "fetch_agents_request");
    emitCase20TraceFrame(controller.trace, "agent_stream");
    emitCase20TraceFrame(controller.trace, "fetch_agents_response");
    controller.finishRpc(32);

    expect(controller.trace.isEnabled()).toBe(false);
    expect(events).toEqual([
      {
        type: "client_rpc_trace",
        at: "2026-09-11T00:00:02.000Z",
        clientId: "case20-client-02",
        sequence: 1,
        baseline: true,
        name: "fetch_agents",
        messageType: "fetch_agents_response",
        requestId: "case20-rpc-00000000000000000000000000000011",
        rpcStartedMonotonicUnixMs: 0,
        messageOutboundBeginMonotonicUnixMs: 1,
        messageOutboundEndMonotonicUnixMs: 2,
        frameOutboundBeginMonotonicUnixMs: 3,
        frameOutboundEndMonotonicUnixMs: 4,
        frameBeginMonotonicUnixMs: 20,
        frameEndMonotonicUnixMs: 30,
        promiseResumedMonotonicUnixMs: 32,
        callbackTotalMs: 10,
        decodeBeforeParseMs: 1,
        jsonParseMs: 2,
        aotValidateMs: 2,
        dispatchAndWaiterMs: 4,
        frameEndToPromiseResumeMs: 2,
      },
    ]);
    expect(failures).toEqual([]);
  });

  test("fails closed on missing, duplicate, crossed, non-target, multi-frame, and out-of-order outbound traces", () => {
    const run = (exercise: (trace: DaemonClientTrace) => void): string[] => {
      const events: Case20ClientObservationTestEvent[] = [];
      const failures: string[] = [];
      let now = 1;
      const controller = createCase20ClientObservationController({
        clientId: "case20-client-02",
        record: (event) => events.push(event),
        onFailure: (code) => failures.push(code),
        nowMonotonicUnixMs: () => now++,
        delegateLogger: noopLogger(),
      });
      controller.armRpc({
        name: "fetch_agents",
        baseline: false,
        requestId: "case20-rpc-00000000000000000000000000000016",
        rpcStartedMonotonicUnixMs: 0,
      });
      exercise(controller.trace);
      emitCase20TraceFrame(controller.trace, "fetch_agents_response");
      controller.finishRpc(now + 1);
      expect(events).toEqual([]);
      return failures;
    };

    expect(run(() => {})).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        emitCase20TraceOutboundMessage(trace, "fetch_agents_request");
        emitCase20TraceOutboundMessage(trace, "fetch_agents_request");
        emitCase20TraceOutboundFrame(trace);
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        trace.beginSection("paseo.ws.message.outbound", {
          envelopeType: "session",
          messageType: "fetch_agents_request",
        });
        emitCase20TraceOutboundFrame(trace);
        trace.endSection();
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        emitCase20TraceOutbound(trace, "fetch_agent_request");
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        emitCase20TraceOutboundMessage(trace, "fetch_agents_request");
        emitCase20TraceOutboundFrame(trace);
        emitCase20TraceOutboundFrame(trace);
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        emitCase20TraceOutboundFrame(trace);
        emitCase20TraceOutboundMessage(trace, "fetch_agents_request");
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
  });

  test("ignores one complete liveness ping pair between the target send and response", () => {
    const events: Case20ClientObservationTestEvent[] = [];
    const failures: string[] = [];
    let now = 1;
    const controller = createCase20ClientObservationController({
      clientId: "case20-client-04",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowMonotonicUnixMs: () => now++,
      delegateLogger: noopLogger(),
    });
    controller.armRpc({
      name: "fetch_agents",
      baseline: false,
      requestId: "case20-rpc-00000000000000000000000000000017",
      rpcStartedMonotonicUnixMs: 0,
    });
    emitCase20TraceOutbound(controller.trace, "fetch_agents_request");
    emitCase20LivenessPing(controller.trace);
    emitCase20TraceFrame(controller.trace, "pong", "pong");
    emitCase20TraceFrame(controller.trace, "fetch_agents_response");
    controller.finishRpc(now + 1);

    expect(failures).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "client_rpc_trace",
        clientId: "case20-client-04",
        requestId: "case20-rpc-00000000000000000000000000000017",
        messageOutboundBeginMonotonicUnixMs: 1,
        messageOutboundEndMonotonicUnixMs: 2,
        frameOutboundBeginMonotonicUnixMs: 3,
        frameOutboundEndMonotonicUnixMs: 4,
        frameBeginMonotonicUnixMs: 15,
        frameEndMonotonicUnixMs: 20,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('"ping"');
    expect(JSON.stringify(events)).not.toContain('"pong"');
  });

  test("fails closed on incomplete, duplicate, nested, misplaced, and non-ping concurrent outbound", () => {
    const run = (
      exercise: (trace: DaemonClientTrace) => void,
      options: { targetFrameComplete?: boolean } = {},
    ): string[] => {
      const events: Case20ClientObservationTestEvent[] = [];
      const failures: string[] = [];
      let now = 1;
      const controller = createCase20ClientObservationController({
        clientId: "case20-client-04",
        record: (event) => events.push(event),
        onFailure: (code) => failures.push(code),
        nowMonotonicUnixMs: () => now++,
        delegateLogger: noopLogger(),
      });
      controller.armRpc({
        name: "fetch_agents",
        baseline: false,
        requestId: "case20-rpc-00000000000000000000000000000018",
        rpcStartedMonotonicUnixMs: 0,
      });
      if (options.targetFrameComplete === false) {
        emitCase20TraceOutboundMessage(controller.trace, "fetch_agents_request");
      } else {
        emitCase20TraceOutbound(controller.trace, "fetch_agents_request");
      }
      exercise(controller.trace);
      if (options.targetFrameComplete === false) emitCase20TraceOutboundFrame(controller.trace);
      emitCase20TraceFrame(controller.trace, "fetch_agents_response");
      controller.finishRpc(now + 1);
      expect(events).toEqual([]);
      return failures;
    };

    expect(run((trace) => emitCase20TraceOutboundMessage(trace, "ping", "ping"))).toEqual([
      "client_rpc_trace_invalid",
    ]);
    expect(
      run((trace) => {
        emitCase20TraceOutboundMessage(trace, "ping", "ping");
        emitCase20TraceOutboundMessage(trace, "ping", "ping");
        emitCase20TraceOutboundFrame(trace);
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(
      run((trace) => {
        trace.beginSection("paseo.ws.frame.inbound", { kind: "text", size: "100" });
        emitCase20LivenessPing(trace);
        trace.endSection();
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(run((trace) => emitCase20LivenessPing(trace), { targetFrameComplete: false })).toEqual([
      "client_rpc_trace_invalid",
    ]);
    expect(
      run((trace) => {
        emitCase20LivenessPing(trace);
        emitCase20TraceOutboundFrame(trace);
      }),
    ).toEqual(["client_rpc_trace_invalid"]);
    expect(run((trace) => emitCase20TraceOutbound(trace, "client_heartbeat"))).toEqual([
      "client_rpc_trace_invalid",
    ]);
    expect(
      run((trace) => {
        emitCase20LivenessPing(trace);
        emitCase20LivenessPing(trace);
      }),
    ).toEqual(["client_rpc_trace_invalid"]);

    const events: Case20ClientObservationTestEvent[] = [];
    const failures: string[] = [];
    let now = 1;
    const controller = createCase20ClientObservationController({
      clientId: "case20-client-04",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      nowMonotonicUnixMs: () => now++,
      delegateLogger: noopLogger(),
    });
    controller.armRpc({
      name: "fetch_agents",
      baseline: false,
      requestId: "case20-rpc-00000000000000000000000000000019",
      rpcStartedMonotonicUnixMs: 0,
    });
    emitCase20TraceOutbound(controller.trace, "fetch_agents_request");
    emitCase20TraceFrame(controller.trace, "fetch_agents_response");
    emitCase20LivenessPing(controller.trace);
    controller.finishRpc(now + 1);
    expect(events).toEqual([]);
    expect(failures).toEqual(["client_rpc_trace_invalid"]);
  });

  test("keeps observation work outside the existing RPC latency duration", async () => {
    let durationClock = 10;
    let monotonicClock = 1_010;
    let durationClockReads = 0;
    let monotonicClockReads = 0;
    let recordedDuration = -1;
    let tracedPromiseResume = -1;
    const registrationEvents: string[] = [];
    const prepared = prepareCase20ObservedRpc({
      clientId: "case20-client-02",
      name: "fetch_agents",
      baseline: true,
      requestId: "case20-rpc-00000000000000000000000000000015",
      observation: {
        armRpc: (input) => {
          registrationEvents.push(`arm:${input.rpcStartedMonotonicUnixMs}`);
          durationClock += 10;
          return 1;
        },
      },
      joiner: {
        expect: (input) => {
          registrationEvents.push(`expect:${input.rpcStartedMonotonicUnixMs}`);
          durationClock += 20;
        },
      },
      nowMonotonicUnixMs: () => {
        registrationEvents.push("diagnostic-start");
        return monotonicClock;
      },
      nowDurationMs: () => {
        registrationEvents.push("measured-start");
        return durationClock;
      },
    });
    const timing = createCase20ObservedRpcTiming({
      startedAtMs: prepared.measuredStartedAtMs,
      nowMs: () => {
        durationClockReads += 1;
        return durationClock;
      },
      nowMonotonicUnixMs: () => {
        monotonicClockReads += 1;
        return monotonicClock;
      },
      finishRpc: (promiseResumedAtMs) => {
        tracedPromiseResume = promiseResumedAtMs;
        durationClock = 200;
      },
    });

    expect(prepared.measuredStartedAtMs).toBe(40);
    expect(registrationEvents).toEqual([
      "diagnostic-start",
      "arm:1010",
      "expect:1010",
      "measured-start",
    ]);
    durationClock = 60;
    monotonicClock = 1_020;
    timing.markPromiseResumed();
    durationClock = 60;
    await timing.finish(async (durationMs) => {
      recordedDuration = durationMs;
      durationClock = 100;
    });

    expect(recordedDuration).toBe(20);
    expect(tracedPromiseResume).toBe(1_020);
    expect(durationClockReads).toBe(1);
    expect(monotonicClockReads).toBe(1);
    expect(durationClock).toBe(200);
  });

  test("fails closed when an armed trace receives no target response frame", () => {
    const events: Case20ClientObservationTestEvent[] = [];
    const failures: string[] = [];
    const controller = createCase20ClientObservationController({
      clientId: "case20-client-02",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      delegateLogger: noopLogger(),
    });

    controller.armRpc({
      name: "foreign_fetch_agent_denial",
      baseline: false,
      requestId: "case20-rpc-00000000000000000000000000000012",
      rpcStartedMonotonicUnixMs: performance.timeOrigin + performance.now(),
    });
    emitCase20TraceFrame(controller.trace, "agent_stream");
    controller.finishRpc(performance.timeOrigin + performance.now());
    controller.finishRpc(performance.timeOrigin + performance.now());

    expect(events).toEqual([]);
    expect(failures).toEqual(["client_rpc_trace_invalid"]);
  });

  test("observes real DaemonClient fetch and denial responses through a fake transport", async () => {
    const events: Case20ClientObservationTestEvent[] = [];
    const failures: string[] = [];
    const observation = createCase20ClientObservationController({
      clientId: "case20-client-03",
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      delegateLogger: noopLogger(),
    });
    const fake = createCase20ObservationTransport();
    const client = new DaemonClient({
      url: "ws://case20-observation.invalid",
      clientId: "case20-client-03",
      transportFactory: () => fake.transport,
      reconnect: { enabled: false },
      logger: observation.logger,
      trace: observation.trace,
      runtimeMetricsIntervalMs: 60_000,
      runtimeMetricsWindowMs: 60_000,
    });
    try {
      const connectPromise = client.connect();
      fake.triggerOpen();
      await connectPromise;

      const listRequestId = "case20-rpc-00000000000000000000000000000013";
      expect(
        observation.armRpc({
          name: "fetch_agents",
          baseline: true,
          requestId: listRequestId,
          rpcStartedMonotonicUnixMs: performance.timeOrigin + performance.now(),
        }),
      ).toBe(1);
      const listPromise = client.fetchAgents({ requestId: listRequestId, page: { limit: 1 } });
      const listRequest = parseCase20ObservationRequest(fake.sent.at(-1)!);
      expect(listRequest.requestId).toBe(listRequestId);
      queueMicrotask(() =>
        fake.triggerSessionMessage({
          type: "fetch_agents_response",
          payload: {
            requestId: listRequest.requestId,
            entries: [],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        }),
      );
      await listPromise;
      observation.finishRpc(performance.timeOrigin + performance.now());

      const denialRequestId = "case20-rpc-00000000000000000000000000000014";
      expect(
        observation.armRpc({
          name: "foreign_fetch_agent_denial",
          baseline: false,
          requestId: denialRequestId,
          rpcStartedMonotonicUnixMs: performance.timeOrigin + performance.now(),
        }),
      ).toBe(2);
      const denialPromise = client.fetchAgent("agt_foreign", denialRequestId);
      const denialRequest = parseCase20ObservationRequest(fake.sent.at(-1)!);
      expect(denialRequest.requestId).toBe(denialRequestId);
      queueMicrotask(() =>
        fake.triggerSessionMessage({
          type: "rpc_error",
          payload: {
            requestId: denialRequest.requestId,
            requestType: "fetch_agent_request",
            error: "Resource unavailable",
            code: "access_denied",
          },
        }),
      );
      let denial: unknown;
      try {
        await denialPromise;
      } catch (error) {
        denial = error;
      }
      observation.finishRpc(performance.timeOrigin + performance.now());
      expect(isCase20AccessDenial(denial)).toBe(true);
    } finally {
      await client.close();
    }
    observation.seal();

    expect(failures).toEqual([]);
    expect(
      events
        .filter((event) => event.type === "client_rpc_trace")
        .map((event) => ({
          sequence: event.sequence,
          name: event.name,
          baseline: event.baseline,
          messageType: event.messageType,
          requestId: event.requestId,
        })),
    ).toEqual([
      {
        sequence: 1,
        name: "fetch_agents",
        baseline: true,
        messageType: "fetch_agents_response",
        requestId: "case20-rpc-00000000000000000000000000000013",
      },
      {
        sequence: 2,
        name: "foreign_fetch_agent_denial",
        baseline: false,
        messageType: "rpc_error",
        requestId: "case20-rpc-00000000000000000000000000000014",
      },
    ]);
    for (const event of events.filter((candidate) => candidate.type === "client_rpc_trace")) {
      expect(event.rpcStartedMonotonicUnixMs).toBeLessThanOrEqual(
        event.messageOutboundBeginMonotonicUnixMs,
      );
      expect(event.messageOutboundBeginMonotonicUnixMs).toBeLessThanOrEqual(
        event.messageOutboundEndMonotonicUnixMs,
      );
      expect(event.messageOutboundEndMonotonicUnixMs).toBeLessThanOrEqual(
        event.frameOutboundBeginMonotonicUnixMs,
      );
      expect(event.frameOutboundBeginMonotonicUnixMs).toBeLessThanOrEqual(
        event.frameOutboundEndMonotonicUnixMs,
      );
      expect(event.frameOutboundEndMonotonicUnixMs).toBeLessThanOrEqual(
        event.frameBeginMonotonicUnixMs,
      );
    }
    const runtime = events.filter((event) => event.type === "client_runtime_metrics");
    expect(runtime).toHaveLength(1);
    expect(runtime[0]).toMatchObject({
      clientId: "case20-client-03",
      rollingWindowMs: 60_000,
      final: true,
      messages: [
        { messageType: "fetch_agents_response", count: 1, handlerCount: 1 },
        { messageType: "rpc_error", count: 1, handlerCount: 1 },
      ],
    });
  });

  test("buffers runner event-loop windows and stops without a live timer", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const times = [1_000, 2_000, 2_500];
    let tick: (() => void) | null = null;
    let unrefs = 0;
    let cancels = 0;
    let enables = 0;
    let disables = 0;
    let resets = 0;
    const histogram = {
      count: 4,
      max: 4_000_000,
      enable() {
        enables += 1;
      },
      disable() {
        disables += 1;
      },
      reset() {
        resets += 1;
      },
      percentile(percentile: number) {
        return new Map([
          [50, 1_000_000],
          [95, 2_000_000],
          [99, 3_000_000],
        ]).get(percentile)!;
      },
    };
    const observer = createCase20RunnerEventLoopDelayObserver({
      intervalMs: 1_000,
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      histogram,
      nowUnixMs: () => times.shift()!,
      schedule(handler) {
        tick = handler;
        return { unref: () => (unrefs += 1) };
      },
      cancel() {
        cancels += 1;
      },
    });
    const runTick = tick as (() => void) | null;
    if (!runTick) throw new Error("Case20 event-loop timer was not scheduled");
    runTick();
    observer.finish();
    observer.finish();
    runTick();

    expect(events).toEqual([
      {
        type: "runner_event_loop_delay",
        at: "1970-01-01T00:00:02.000Z",
        windowStartedAtMs: 1_000,
        windowEndedAtMs: 2_000,
        intervalMs: 1_000,
        sampleCount: 4,
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        maxMs: 4,
        final: false,
      },
      {
        type: "runner_event_loop_delay",
        at: "1970-01-01T00:00:02.500Z",
        windowStartedAtMs: 2_000,
        windowEndedAtMs: 2_500,
        intervalMs: 1_000,
        sampleCount: 4,
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        maxMs: 4,
        final: true,
      },
    ]);
    expect({ enables, disables, resets, unrefs, cancels }).toEqual({
      enables: 1,
      disables: 1,
      resets: 2,
      unrefs: 1,
      cancels: 1,
    });
    expect(failures).toEqual([]);
  });

  test("fails closed on an invalid runner event-loop window", () => {
    const events: Case20RawEvent[] = [];
    const failures: string[] = [];
    const observer = createCase20RunnerEventLoopDelayObserver({
      intervalMs: 1_000,
      record: (event) => events.push(event),
      onFailure: (code) => failures.push(code),
      histogram: {
        count: 1,
        max: Number.NaN,
        enable() {},
        disable() {},
        reset() {},
        percentile: () => 1_000_000,
      },
      nowUnixMs: () => 1_000,
      schedule: () => ({ unref() {} }),
      cancel() {},
    });

    observer.finish();
    observer.finish();
    expect(events).toEqual([]);
    expect(failures).toEqual(["runner_event_loop_delay_invalid"]);
  });

  test("fixes retained RSS checkpoints before a run and always includes the end", () => {
    let sequence = 0;
    const schedule = createCase20RetainedRssSchedule(1_901, () => `gc-${sequence++}`);

    expect(schedule).toEqual([
      { index: 0, requestId: "gc-0", scheduledTSec: 0 },
      { index: 1, requestId: "gc-1", scheduledTSec: 300 },
      { index: 2, requestId: "gc-2", scheduledTSec: 600 },
      { index: 3, requestId: "gc-3", scheduledTSec: 900 },
      { index: 4, requestId: "gc-4", scheduledTSec: 1_200 },
      { index: 5, requestId: "gc-5", scheduledTSec: 1_500 },
      { index: 6, requestId: "gc-6", scheduledTSec: 1_800 },
      { index: 7, requestId: "gc-7", scheduledTSec: 1_901 },
    ]);
    expect(case20RetainedRssCheckpointDelayMs(1_000, 300, 1_100)).toBe(299_900);
    expect(case20RetainedRssCheckpointDelayMs(1_000, 300, 400_000)).toBe(0);
  });

  test("starts measurement only after active metrics reach exact 10/10", async () => {
    let clock = 0;
    let streamStartedAt = -1;
    const events: string[] = [];
    const observations = [
      { sessions: 0, sockets: 0 },
      { sessions: 10, sockets: 9 },
      { sessions: 10, sockets: 10 },
    ];
    const boundary = await establishCase20PartAMeasurementBoundary({
      sample: async () => {
        const observation = observations.shift()!;
        events.push(`sample:${observation.sessions}/${observation.sockets}`);
        return observation;
      },
      markStreamCoverageStarted: async (startedAtMs) => {
        events.push(`coverage:${startedAtMs}`);
      },
      startStreams: async () => {
        streamStartedAt = clock;
        events.push("streams-started");
        clock += 50;
      },
      now: () => clock,
      pause: async (milliseconds) => {
        events.push("pause");
        clock += milliseconds;
      },
      timeoutMs: 5_000,
      pollIntervalMs: 1_000,
    });

    expect(events).toEqual([
      "sample:0/0",
      "pause",
      "sample:10/9",
      "pause",
      "sample:10/10",
      "coverage:2000",
      "streams-started",
    ]);
    expect(boundary).toEqual({
      streamCoverageStartedAtMs: 2_000,
      measurementStartedAtMs: 2_050,
      sessions: 10,
      sockets: 10,
    });
    const deadline = case20MeasuredWorkloadDeadlineMs(boundary.measurementStartedAtMs, 1_800);
    expect(deadline - boundary.measurementStartedAtMs).toBe(1_800_000);
    expect(boundary.measurementStartedAtMs - streamStartedAt).toBe(50);
    expect(deadline - streamStartedAt).toBe(1_800_050);
  });

  test("fails closed when active metrics never reach exact 10/10", async () => {
    let clock = 0;
    let samples = 0;
    let coverageStarted = false;
    let streamsStarted = false;
    await expect(
      establishCase20PartAMeasurementBoundary({
        sample: async () => {
          samples += 1;
          return { sessions: 10, sockets: 9 };
        },
        markStreamCoverageStarted: async () => {
          coverageStarted = true;
        },
        startStreams: async () => {
          streamsStarted = true;
        },
        now: () => clock,
        pause: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 2_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow("exactly 10 sessions and 10 sockets");
    expect(samples).toBe(2);
    expect(coverageStarted).toBe(false);
    expect(streamsStarted).toBe(false);
  });

  test("propagates a stream start failure without retrying after exact 10/10 readiness", async () => {
    const failure = new Error("first canary failed");
    let samples = 0;
    let streamStarts = 0;
    await expect(
      establishCase20PartAMeasurementBoundary({
        sample: async () => {
          samples += 1;
          return { sessions: 10, sockets: 10 };
        },
        markStreamCoverageStarted: async () => undefined,
        startStreams: async () => {
          streamStarts += 1;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(samples).toBe(1);
    expect(streamStarts).toBe(1);
  });

  test("collects each planned GC checkpoint exactly once before sampling OS RSS", async () => {
    let gcCalls = 0;
    let clock = 10;
    const schedule = createCase20RetainedRssSchedule(
      301,
      (() => {
        let sequence = 0;
        return () => `gc-${sequence++}`;
      })(),
    );
    const controller = createCase20GarbageCollectionController({
      schedule,
      collectGarbage: () => {
        gcCalls += 1;
      },
      monotonicNow: () => clock++,
    });
    const events: string[] = [];
    const first = await captureCase20RetainedRssCheckpoint({
      plan: schedule[0]!,
      daemonPid: 42,
      measurementStartedAtMs: 1_000,
      collectGarbage: async (request) => {
        events.push("gc");
        return controller.run(request);
      },
      sample: async (tSec) => {
        events.push("sample");
        return {
          tSec,
          rssMiB: 125,
          fdCount: 20,
          swapMiB: 0,
          eventLoopP99Ms: 12,
          sessions: 10,
          sockets: 10,
          processes: [
            {
              pid: 42,
              parentPid: 1,
              identity: "a".repeat(64),
              rssMiB: 100,
              fdCount: 10,
            },
            {
              pid: 43,
              parentPid: 42,
              identity: "b".repeat(64),
              rssMiB: 25,
              fdCount: 10,
            },
          ],
        };
      },
      wallNow: () => 1_250,
      monotonicNow: (() => {
        let value = 20;
        return () => value++;
      })(),
    });

    expect(events).toEqual(["gc", "sample"]);
    expect(gcCalls).toBe(1);
    expect(first).toMatchObject({
      index: 0,
      requestId: "gc-0",
      scheduledTSec: 0,
      actualTSec: 0.25,
      acknowledgedInMs: 1,
      gcDurationMs: 1,
      treeRssMiB: 125,
      daemonMainIdentity: "a".repeat(64),
      daemonMainRssMiB: 100,
    });
    expect(() => controller.run({ type: "gc_checkpoint", ...schedule[0]! })).toThrow(
      "out of order",
    );
    expect(() => controller.run({ type: "gc_checkpoint", ...schedule[2]! })).toThrow(
      "out of order",
    );
    expect(gcCalls).toBe(1);
    expect(controller.run({ type: "gc_checkpoint", ...schedule[1]! })).toMatchObject({
      type: "gc_checkpoint_ack",
      index: 1,
      requestId: "gc-1",
      scheduledTSec: 300,
    });
    expect(gcCalls).toBe(2);
  });

  test("handles multiple child GC checkpoints and removes the message listener on shutdown", () => {
    const source = new EventEmitter();
    const schedule = createCase20RetainedRssSchedule(
      300,
      (() => {
        let sequence = 0;
        return () => `gc-child-${sequence++}`;
      })(),
    );
    const sent: unknown[] = [];
    let shutdowns = 0;
    const release = installCase20ChildMessageHandler({
      source: {
        on: (_event, listener) => source.on("message", listener),
        off: (_event, listener) => source.off("message", listener),
      },
      parseGarbageCollectionRequest: (message) => message as Case20GarbageCollectionRequest,
      garbageCollection: createCase20GarbageCollectionController({
        schedule,
        collectGarbage: () => undefined,
      }),
      isClosing: () => false,
      send: (message) => sent.push(message),
      shutdown: () => {
        shutdowns += 1;
      },
    });

    expect(source.listenerCount("message")).toBe(1);
    for (const checkpoint of schedule)
      source.emit("message", { type: "gc_checkpoint", ...checkpoint });
    expect(sent).toMatchObject([
      { type: "gc_checkpoint_ack", ...schedule[0] },
      { type: "gc_checkpoint_ack", ...schedule[1] },
    ]);
    source.emit("message", { type: "shutdown" });
    expect(shutdowns).toBe(1);
    expect(source.listenerCount("message")).toBe(0);
    source.emit("message", { type: "gc_checkpoint", ...schedule[0] });
    expect(sent).toHaveLength(2);
    release();
    expect(source.listenerCount("message")).toBe(0);
  });

  test("forks with explicit GC, acknowledges multiple checkpoints, and exits after shutdown", async () => {
    const schedule = createCase20RetainedRssSchedule(
      300,
      (() => {
        let sequence = 0;
        return () => `gc-smoke-${sequence++}`;
      })(),
    );
    const child = fork(
      fileURLToPath(new URL("./retained-rss-smoke-child.ts", import.meta.url)),
      [],
      {
        execArgv: [...case20PartAChildExecArgv({ runningFromTypeScript: true, mode: "smoke" })],
        env: {
          CASE20_RETAINED_RSS_SCHEDULE: JSON.stringify(schedule),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const send = (message: object) =>
      new Promise<void>((resolve, reject) => {
        child.send(message, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    try {
      const [ready] = await once(child, "message");
      expect(ready).toEqual({ type: "smoke_ready" });
      for (const checkpoint of schedule) {
        const response = once(child, "message");
        await send({ type: "gc_checkpoint", ...checkpoint });
        const [acknowledgement] = await response;
        expect(acknowledgement).toMatchObject({
          type: "gc_checkpoint_ack",
          ...checkpoint,
        });
      }
      const closed = once(child, "message");
      const exited = once(child, "exit");
      await send({ type: "shutdown" });
      expect((await closed)[0]).toEqual({ type: "smoke_closed" });
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  });

  test("captures the forced final retained checkpoint before the final stream canary", async () => {
    const events: string[] = [];
    const result = await captureCase20FinalCheckpointBeforeCanary({
      captureCheckpoint: async () => {
        events.push("retained-final");
      },
      captureFinalActive: async () => {
        events.push("final-canary");
        return "final-active";
      },
    });

    expect(events).toEqual(["retained-final", "final-canary"]);
    expect(result).toBe("final-active");
  });

  test("always exposes explicit GC to the formal Part A child", () => {
    expect(case20PartAChildExecArgv({ runningFromTypeScript: true, mode: "formal" })).toEqual([
      "--import",
      "tsx",
      "--expose-gc",
    ]);
    expect(case20PartAChildExecArgv({ runningFromTypeScript: false, mode: "formal" })).toEqual([
      "--expose-gc",
    ]);
  });

  test("does not sample RSS when the GC acknowledgement mismatches the plan", async () => {
    const plan = { index: 0, requestId: "gc-exact", scheduledTSec: 0 } as const;
    let samples = 0;
    await expect(
      captureCase20RetainedRssCheckpoint({
        plan,
        daemonPid: 42,
        measurementStartedAtMs: 0,
        collectGarbage: async () => ({
          type: "gc_checkpoint_ack",
          ...plan,
          requestId: "gc-wrong",
          gcDurationMs: 1,
        }),
        sample: async () => {
          samples += 1;
          throw new Error("must not sample");
        },
      }),
    ).rejects.toThrow("acknowledgement mismatch");
    expect(samples).toBe(0);
  });

  test("awaits every empty timeline acknowledgement before closing clients", async () => {
    const events: string[] = [];
    const listeners = new Map<string, (message: SessionOutboundMessage) => void>();
    const targets = Array.from({ length: CASE20_PART_A_CLIENT_COUNT }, (_, index) => {
      const clientId = `client-${index}`;
      return {
        clientId,
        daemonClient: {
          subscribeRawMessages(handler: (message: SessionOutboundMessage) => void) {
            events.push(`armed:${clientId}`);
            listeners.set(clientId, handler);
            return () => listeners.delete(clientId);
          },
          async close() {
            events.push(`closed:${clientId}`);
          },
        },
        releaseTimeline() {
          events.push(`released:${clientId}`);
        },
      };
    });
    const cleanup = cleanupCase20TimelineClients(targets, 1_000);
    await Promise.resolve();
    expect(events.filter((event) => event.startsWith("armed:"))).toHaveLength(10);
    expect(events.filter((event) => event.startsWith("released:"))).toHaveLength(10);
    expect(events.filter((event) => event.startsWith("closed:"))).toEqual([]);
    for (const target of targets) {
      listeners.get(target.clientId)?.({
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: `ack-${target.clientId}`, agentIds: [] },
      });
    }
    const results = await cleanup;

    expect(results).toEqual(
      targets.map((target) => ({
        clientId: target.clientId,
        timelineError: null,
        closeError: null,
      })),
    );
    expect(events.filter((event) => event.startsWith("closed:"))).toHaveLength(10);
  });

  test("still closes every client after an empty timeline acknowledgement timeout", async () => {
    let closed = 0;
    const [result] = await cleanupCase20TimelineClients(
      [
        {
          clientId: "client-timeout",
          daemonClient: {
            subscribeRawMessages() {
              return () => undefined;
            },
            async close() {
              closed += 1;
            },
          },
          releaseTimeline() {},
        },
      ],
      5,
    );

    expect(result?.clientId).toBe("client-timeout");
    expect(result?.timelineError).toBeInstanceOf(Error);
    expect(result?.closeError).toBeNull();
    expect(closed).toBe(1);
  });

  test("accepts a complete Part A summary and reports every breached gate", () => {
    expect(buildCase20Summary(measurements()).pass).toBe(true);

    const failed = buildCase20Summary(
      measurements({
        durationSec: 1_799,
        counts: counts({
          requests: 1_000,
          succeeded: 998,
          crossPrincipalViolations: 1,
          providerCrashes: 1,
        }),
        feedbackLatencyMs: [2_001],
        rpcLatencyMs: { fetch_agents: [126] },
        resourceSamples: [
          measurements().resourceSamples[0],
          {
            tSec: 1_799,
            rssMiB: 230,
            fdCount: 31,
            swapMiB: 1,
            eventLoopP99Ms: 101,
            sessions: 1,
            sockets: 1,
            processes: [],
          },
        ],
        postCloseResourceSample: {
          tSec: 1_800,
          rssMiB: 999,
          fdCount: 999,
          swapMiB: 999,
          eventLoopP99Ms: 999,
          sessions: 1,
          sockets: 1,
          processes: [],
        },
      }),
    );
    expect(failed.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "insufficient_duration",
        "nonzero_safety_counter",
        "business_success_rate",
        "feedback_latency",
        "rpc_latency_ratio",
        "rss_end",
        "fd_end",
        "swap_growth",
        "event_loop_delay",
        "sessions_not_closed",
        "sockets_not_closed",
      ]),
    );
  });

  test("computes the median pairwise RSS slope", () => {
    expect(
      theilSenSlopePerMinute([
        { tSec: 0, value: 100 },
        { tSec: 60, value: 101 },
        { tSec: 120, value: 102 },
      ]),
    ).toBe(1);
  });

  test("averages the two middle Theil-Sen slopes across the release threshold", () => {
    const slope = theilSenSlopePerMinute([
      { tSec: 0, value: 100 },
      { tSec: 60, value: 100 },
      { tSec: 120, value: 100 },
      { tSec: 180, value: 107 },
    ]);
    expect(slope).toBeCloseTo(7 / 6);
    expect(slope).toBeGreaterThan(1);
  });

  test("gates formal Part A on fixed retained tree RSS while preserving raw RSS", () => {
    const raw = Array.from(measurements().resourceSamples, (sample) => ({
      ...sample,
      rssMiB: 100 + sample.tSec / 30,
    }));
    const retained = Array.from(measurements().retainedRssSamples!, (checkpoint) =>
      retainedMemorySample(checkpoint, {
        treeRssMiB: 100 + checkpoint.scheduledTSec / 120,
        daemonMainRssMiB: 80 + checkpoint.scheduledTSec / 240,
      }),
    );
    const summary = buildCase20Summary(
      measurements({ resourceSamples: raw, retainedRssSamples: retained }),
    );

    expect(summary.resources.rss).toMatchObject({
      rawLast20MinTheilSenMiBPerMin: 2,
      last20MinTheilSenMiBPerMin: 2,
      retained: {
        last20MinTreeTheilSenMiBPerMin: 0.5,
        last20MinDaemonMainTheilSenMiBPerMin: 0.25,
      },
    });
    expect(summary.failures.map((failure) => failure.code)).not.toContain("rss_slope");
  });

  test("fails formal Part A instead of falling back when retained RSS is absent", () => {
    const {
      retainedRssSchedule: _schedule,
      retainedRssSamples: _samples,
      ...withoutRetainedRss
    } = measurements();
    const summary = buildCase20Summary(withoutRetainedRss);

    expect(summary.pass).toBe(false);
    expect(summary.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["retained_rss_schedule_missing", "retained_rss_samples_missing"]),
    );
    expect(summary.resources.rss.retained).toBeUndefined();
  });

  test("fails closed on every malformed formal retained sequence without raw RSS fallback", () => {
    const base = measurements();
    const rawWithFailingSlope = Array.from(base.resourceSamples, (sample) => ({
      ...sample,
      rssMiB: 100 + sample.tSec / 30,
    }));
    const schedule = base.retainedRssSchedule!;
    const samples = base.retainedRssSamples!;
    const changedIdentity = retainedMemorySample(samples[1]!, {
      treeRssMiB: samples[1]!.treeRssMiB,
      daemonMainRssMiB: samples[1]!.daemonMainRssMiB,
      daemonMainIdentity: "9".repeat(64),
    });
    const inactive = retainedMemorySample(samples[1]!, {
      treeRssMiB: samples[1]!.treeRssMiB,
      daemonMainRssMiB: samples[1]!.daemonMainRssMiB,
      sessions: 9,
      sockets: 9,
    });
    const cases = [
      {
        name: "missing checkpoint",
        measurements: { retainedRssSamples: samples.slice(0, -1) },
        codes: ["retained_rss_checkpoint_count"],
      },
      {
        name: "duplicate checkpoint",
        measurements: { retainedRssSamples: [samples[0]!, samples[0]!, ...samples.slice(2)] },
        codes: ["retained_rss_checkpoint_mismatch"],
      },
      {
        name: "out-of-order checkpoint",
        measurements: {
          retainedRssSamples: [samples[1]!, samples[0]!, ...samples.slice(2)],
        },
        codes: ["retained_rss_checkpoint_mismatch"],
      },
      {
        name: "non-monotonic actual time",
        measurements: {
          retainedRssSamples: [
            samples[0]!,
            retainedMemorySample(samples[1]!, {
              actualTSec: samples[0]!.actualTSec,
              treeRssMiB: samples[1]!.treeRssMiB,
              daemonMainRssMiB: samples[1]!.daemonMainRssMiB,
            }),
            ...samples.slice(2),
          ],
        },
        codes: ["retained_rss_actual_time_not_monotonic"],
      },
      {
        name: "ack timeout",
        measurements: {
          retainedRssSamples: [{ ...samples[0]!, acknowledgedInMs: 10_001 }, ...samples.slice(1)],
        },
        codes: ["retained_rss_ack_timeout"],
      },
      {
        name: "main identity change",
        measurements: {
          retainedRssSamples: [samples[0]!, changedIdentity, ...samples.slice(2)],
        },
        codes: ["retained_rss_main_identity_changed"],
      },
      {
        name: "inactive sessions and sockets",
        measurements: {
          retainedRssSamples: [samples[0]!, inactive, ...samples.slice(2)],
        },
        codes: ["retained_rss_active_sessions_invalid", "retained_rss_active_sockets_invalid"],
      },
      {
        name: "duplicate fixed request id",
        measurements: {
          retainedRssSchedule: [
            schedule[0]!,
            { ...schedule[1]!, requestId: schedule[0]!.requestId },
            ...schedule.slice(2),
          ],
        },
        codes: ["retained_rss_schedule_invalid"],
      },
    ] as const;

    for (const malformed of cases) {
      const summary = buildCase20Summary(
        measurements({ resourceSamples: rawWithFailingSlope, ...malformed.measurements }),
      );
      const codes = summary.failures.map((failure) => failure.code);
      for (const code of malformed.codes) expect(codes, malformed.name).toContain(code);
      expect(codes, malformed.name).not.toContain("rss_slope");
      expect(summary.pass, malformed.name).toBe(false);
    }
  });

  test("uses only fixed scheduled times for the retained slope window", () => {
    const base = measurements();
    const retainedRssSamples = Array.from(base.retainedRssSamples!, (checkpoint, index) => {
      const actualTSec = index + 1;
      const treeRssMiB = 100 + checkpoint.scheduledTSec / 120;
      return retainedMemorySample(checkpoint, {
        actualTSec,
        treeRssMiB,
        daemonMainRssMiB: treeRssMiB - 20,
      });
    });
    const summary = buildCase20Summary(measurements({ retainedRssSamples }));

    expect(summary.resources.rss.retained).toMatchObject({
      last20MinTreeTheilSenMiBPerMin: 0.5,
      series: retainedRssSamples.map((sample) => ({
        index: sample.index,
        scheduledTSec: sample.scheduledTSec,
        actualTSec: sample.actualTSec,
      })),
    });
  });

  test("rejects a formal retained schedule that does not cover the full minimum interval", () => {
    let sequence = 0;
    const retainedRssSchedule = createCase20RetainedRssSchedule(600, () => `short-${sequence++}`);
    const summary = buildCase20Summary(measurements({ retainedRssSchedule }));

    expect(summary.failures.map((failure) => failure.code)).toContain(
      "retained_rss_schedule_invalid",
    );
    expect(summary.failures.map((failure) => failure.code)).not.toContain("rss_slope");
  });

  test("uses only active samples for duration and resource gates", () => {
    const summary = buildCase20Summary(
      measurements({
        postCloseResourceSample: {
          tSec: 99_999,
          rssMiB: 10_000,
          fdCount: 10_000,
          swapMiB: 10_000,
          eventLoopP99Ms: 10_000,
          sessions: 0,
          sockets: 0,
          processes: [],
        },
      }),
    );
    expect(summary.pass).toBe(true);
    expect(summary.durationSec).toBe(1_800);
    expect(summary.resources).toMatchObject({
      rss: { endMiB: 100, last20MinTheilSenMiBPerMin: 0 },
      fd: { end: 20, sustainedPositiveSlope: false },
      swap: { deltaMiB: 0 },
      eventLoop: { p99Ms: 10 },
      sessions: { activeEnd: 10, postClose: 0 },
      sockets: { activeEnd: 10, postClose: 0 },
    });
  });

  test("requires final active stream evidence for every Part A principal", () => {
    const base = measurements();
    const failed = buildCase20Summary(
      measurements({
        finalActiveSample: {
          ...base.finalActiveSample!,
          principalStreams: base.finalActiveSample?.principalStreams?.slice(1),
        },
      }),
    );
    expect(failed.failures.map((entry) => entry.code)).toContain(
      "final_principal_stream_activity_missing",
    );
  });

  test("requires exactly one bounded outcome per counted request", () => {
    const failed = buildCase20Summary(
      measurements({ counts: counts({ requests: 1_000, succeeded: 1_001, failed: 0 }) }),
    );
    expect(failed.failures.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["request_outcome_mismatch", "invalid_business_success_rate"]),
    );
    expect(failed.latencyMs.business.successRate).toBe(1);
  });

  test("requires swap delta to be exactly zero", () => {
    const active = Array.from(measurements().resourceSamples, (sample, index) => ({
      ...sample,
      swapMiB: index === 0 ? 1 : 0,
    }));
    const failed = buildCase20Summary(measurements({ resourceSamples: active }));
    expect(failed.failures.map((entry) => entry.code)).toContain("swap_growth");
    expect(failed.resources.swap.deltaMiB).toBe(-1);
  });

  test("rejects formal evidence from a dirty tracked worktree", () => {
    const summary = buildCase20Summary(
      measurements({ provenance: { ...measurements().provenance, trackedClean: false } }),
    );
    expect(summary.failures.map((entry) => entry.code)).toContain("tracked_worktree_dirty");
    expect(summary.pass).toBe(false);
  });

  test("binds provenance to the committed tree and records tracked and untracked state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-provenance-"));
    temporaryRoots.push(root);
    await executeFile("git", ["init", "--quiet"], { cwd: root });
    await executeFile("git", ["config", "user.name", "Case20 Test"], { cwd: root });
    await executeFile("git", ["config", "user.email", "case20@example.invalid"], { cwd: root });
    const trackedPath = path.join(root, "tracked.txt");
    await writeFile(trackedPath, "committed\n", { mode: 0o600 });
    await executeFile("git", ["add", "tracked.txt"], { cwd: root });
    await executeFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    await writeFile(path.join(root, "untracked.txt"), "inventory-only\n", { mode: 0o600 });
    const clean = await createCase20Provenance({
      manifest: { schemaVersion: 1 },
      repositoryRoot: root,
    });
    expect(clean).toMatchObject({
      trackedClean: true,
      untrackedFiles: ["untracked.txt"],
      tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      statusSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      diffSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await writeFile(trackedPath, "changed\n", { mode: 0o600 });
    const dirty = await createCase20Provenance({
      manifest: { schemaVersion: 1 },
      repositoryRoot: root,
    });
    expect(dirty.trackedClean).toBe(false);
    expect(dirty.tree).toBe(clean.tree);
    expect(dirty.diffSha256).not.toBe(clean.diffSha256);
  });

  test("keeps Part A manifests secret-free and enforces private permissions", async () => {
    expect(() =>
      PartAManifestSchema.parse({
        schemaVersion: 1,
        mode: "formal",
        runId: "run",
        durationSec: 1_800,
        personalAccessToken: "must-not-be-accepted",
      }),
    ).toThrow();
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-manifest-"));
    temporaryRoots.push(root);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, mode: "formal", runId: "run", durationSec: 1_800 }),
      { mode: 0o600 },
    );
    await expect(readPrivateManifest(manifestPath, PartAManifestSchema)).resolves.toMatchObject({
      runId: "run",
    });
    if (process.platform !== "win32") {
      const linkPath = path.join(root, "manifest-link.json");
      await symlink(manifestPath, linkPath);
      await expect(readPrivateManifest(linkPath, PartAManifestSchema)).rejects.toThrow(
        "regular file",
      );
      await chmod(manifestPath, 0o644);
      await expect(readPrivateManifest(manifestPath, PartAManifestSchema)).rejects.toThrow("0600");
    }
  });

  test("requires an explicit paid real-provider acknowledgement for Part B smoke", () => {
    const base = {
      schemaVersion: 1,
      mode: "smoke",
      runId: "paid-smoke",
      durationSec: 10,
      workspaceRoot: "/private/case20",
    } as const;
    expect(() => PartBManifestSchema.parse(base)).toThrow();
    expect(PartBManifestSchema.parse({ ...base, paidProviderUseAcknowledged: true })).toMatchObject(
      { mode: "smoke", paidProviderUseAcknowledged: true },
    );
  });

  test("writes private append-only artifacts and rejects credential material", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-artifact-"));
    temporaryRoots.push(root);
    const writer = await createCase20ArtifactWriter({ artifactRoot: root, runId: "artifact" });
    const artifactMeasurements = measurements({ runId: "artifact" });
    await writer.append({
      type: "run_started",
      at: "2026-09-11T00:00:00.000Z",
      part: "A",
      mode: "smoke",
      runId: "artifact",
    });
    await writer.append(
      {
        type: "retained_rss_schedule",
        at: "2026-09-11T00:00:00.000Z",
        checkpoints: artifactMeasurements.retainedRssSchedule!,
      },
      { durable: true },
    );
    await writer.append(
      {
        type: "retained_resource",
        at: "2026-09-11T00:00:00.000Z",
        checkpoint: artifactMeasurements.retainedRssSamples![0]!,
      },
      { durable: true },
    );
    await writer.append({
      type: "client_runtime_metrics",
      at: "2026-09-11T00:00:01.000Z",
      clientId: "case20-client-01",
      windowMs: 1_000,
      rollingWindowMs: 1_000,
      bucketCount: 1,
      final: false,
      connectionPath: "direct",
      connectionStatus: "connected",
      messages: [
        {
          messageType: "rpc_error",
          count: 1,
          bytes: 120,
          handlerCount: 1,
          handlerTotalMs: 2,
          handlerAvgMs: 2,
          handlerMaxMs: 2,
        },
      ],
    });
    await writer.append({
      type: "rpc_diagnostic",
      at: "2026-09-11T00:00:01.500Z",
      clientId: "case20-client-01",
      sequence: 1,
      baseline: false,
      name: "foreign_fetch_agent_denial",
      requestId: "case20-rpc-00000000000000000000000000000041",
      requestType: "fetch_agent_request",
      responseType: "rpc_error",
      client: {
        rpcStartedMonotonicUnixMs: 100,
        messageOutboundBeginMonotonicUnixMs: 101,
        messageOutboundEndMonotonicUnixMs: 102,
        frameOutboundBeginMonotonicUnixMs: 103,
        frameOutboundEndMonotonicUnixMs: 104,
        frameBeginMonotonicUnixMs: 120,
        frameEndMonotonicUnixMs: 124,
        promiseResumedMonotonicUnixMs: 124.1,
        callbackTotalMs: 4,
        decodeBeforeParseMs: 0.1,
        jsonParseMs: 0.2,
        aotValidateMs: 0.3,
        dispatchAndWaiterMs: 0.4,
        frameEndToPromiseResumeMs: 0.1,
      },
      daemon: {
        phases: CASE20_TEST_RPC_PHASES.map((phase, index) => ({
          phase,
          monotonicUnixMs: 101 + index,
        })),
      },
    });
    await writer.append({
      type: "runner_event_loop_delay",
      at: "2026-09-11T00:00:02.000Z",
      windowStartedAtMs: 1_000,
      windowEndedAtMs: 2_000,
      intervalMs: 1_000,
      sampleCount: 10,
      p50Ms: 1,
      p95Ms: 2,
      p99Ms: 3,
      maxMs: 4,
      final: false,
    });
    expect(() =>
      writer.append({
        type: "client_connected",
        at: "2026-09-11T00:00:00.000Z",
        clientId: "Bearer secret-material-value",
        principalId: "usr_0000000000000001",
      }),
    ).toThrow("credential-like");
    await writer.finish(buildCase20Summary(artifactMeasurements));
    await writer.close();
    const raw = await readFile(writer.rawPath, "utf8");
    expect(raw).toContain('"type":"run_started"');
    expect(raw).toContain('"type":"retained_rss_schedule"');
    expect(raw).toContain('"type":"retained_resource"');
    expect(raw).toContain('"type":"client_runtime_metrics"');
    expect(raw).toContain('"type":"rpc_diagnostic"');
    expect(raw).toContain('"type":"runner_event_loop_delay"');
    const inventory = JSON.parse(await readFile(writer.inventoryPath, "utf8")) as {
      readonly entries: readonly {
        readonly name: string;
        readonly size: number;
        readonly sha256: string;
      }[];
    };
    expect(inventory.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "raw.jsonl",
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
        expect.objectContaining({
          name: "summary.json",
          size: expect.any(Number),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      ]),
    );
    expect(() =>
      assertCase20ArtifactSecretFree({ authorization: "redacted-but-key-is-forbidden" }),
    ).toThrow("secret-bearing key");
  });

  test("deletes an unfinished run before inventory when the final scan finds a secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-artifact-secret-"));
    temporaryRoots.push(root);
    const writer = await createCase20ArtifactWriter({ artifactRoot: root, runId: "rejected" });
    const secret = "case20-private-material-7d3b2a9845f1";
    await writer.append({
      type: "client_connected",
      at: "2026-09-11T00:00:00.000Z",
      clientId: secret,
      principalId: createHash("sha256").update(secret).digest("hex"),
    });
    await expect(
      writer.finish(buildCase20Summary(measurements({ runId: "rejected" })), {
        knownSecrets: [secret],
      }),
    ).rejects.toThrow("secret material");
    await expect(stat(writer.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(writer.close()).resolves.toBeUndefined();
  });

  test("bounds artifact backpressure instead of retaining an unbounded write queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-artifact-pressure-"));
    temporaryRoots.push(root);
    const writer = await createCase20ArtifactWriter({ artifactRoot: root, runId: "pressure" });
    const writes = Array.from({ length: 300 }, (_, index) =>
      writer.append({
        type: "run_started",
        at: "2026-09-11T00:00:00.000Z",
        part: "A",
        mode: "smoke",
        runId: `pressure-${index}`,
      }),
    );
    const results = await Promise.allSettled(writes);
    expect(results.filter((result) => result.status === "rejected").length).toBeGreaterThan(0);
    await writer.close();
  });

  test("completes short writes and rejects truncated raw JSONL before inventory", async () => {
    const expected = Buffer.from("line-one\nline-two\n");
    const actual = Buffer.alloc(expected.length);
    await writeCase20BufferCompletely(expected, async (buffer, offset, length) => {
      const written = Math.min(3, length);
      Buffer.from(buffer).copy(actual, offset, offset, offset + written);
      return written;
    });
    expect(actual).toEqual(expected);

    const root = await mkdtemp(path.join(os.tmpdir(), "case20-jsonl-"));
    temporaryRoots.push(root);
    const rawPath = path.join(root, "raw.jsonl");
    await writeFile(rawPath, '{"type":"run_started"}', { mode: 0o600 });
    await expect(validateCase20RawJsonl(rawPath)).rejects.toThrow("truncated");
    await writeFile(rawPath, '{"type":"run_started"}\nnot-json\n', { mode: 0o600 });
    await expect(validateCase20RawJsonl(rawPath)).rejects.toThrow();
  });

  test("counts every nonintentional terminal connection transition once", () => {
    expect(
      isUnexpectedCase20ConnectionTerminal({
        previous: "connected",
        current: "disconnected",
        connected: true,
        intentionalClose: false,
      }),
    ).toBe(true);
    expect(
      isUnexpectedCase20ConnectionTerminal({
        previous: "disconnected",
        current: "disposed",
        connected: true,
        intentionalClose: false,
      }),
    ).toBe(false);
    expect(
      isUnexpectedCase20ConnectionTerminal({
        previous: "connected",
        current: "disposed",
        connected: true,
        intentionalClose: true,
      }),
    ).toBe(false);
  });

  test("accepts only exact access denials as wrong-route evidence", () => {
    expect(isCase20AccessDenial({ code: "access_denied" })).toBe(true);
    expect(isCase20AccessDenial({ code: "not_found" })).toBe(true);
    expect(isCase20AccessDenial({ code: "internal_error" })).toBe(false);
    expect(isCase20AccessDenial(new Error("socket disconnected"))).toBe(false);
  });

  test("builds a same-shape concurrent baseline across all ten clients", () => {
    const clients = Array.from({ length: CASE20_PART_A_CLIENT_COUNT }, (_, index) => ({
      agentId: `agent-${index + 1}`,
    }));

    expect(case20ConcurrentBaselineForeignAgentIds(clients)).toEqual([
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
      "agent-7",
      "agent-8",
      "agent-9",
      "agent-10",
      "agent-1",
    ]);
  });

  test("classifies a missing owned agent as a single failed isolation outcome", () => {
    expect(classifyCase20AgentList("owned", [])).toEqual({
      ownedAgentVisible: false,
      foreignAgentCount: 0,
    });
    expect(classifyCase20AgentList("owned", ["owned"])).toEqual({
      ownedAgentVisible: true,
      foreignAgentCount: 0,
    });
  });

  test("detects known secrets, fingerprints, JWTs, and bearer material in logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-secret-scan-"));
    temporaryRoots.push(root);
    const logPath = path.join(root, "provider.jsonl");
    const secret = "case20-known-secret-value";
    await writeFile(logPath, `${createHash("sha256").update(secret).digest("hex")}\n`, {
      mode: 0o600,
    });
    await expect(
      assertFileContainsNoSecrets({ filePath: logPath, knownSecrets: [secret] }),
    ).rejects.toThrow("secret material");
    await writeFile(logPath, "eyJheader12345.eyJpayload12345.signature12345\n", { mode: 0o600 });
    await expect(
      assertFileContainsNoSecrets({ filePath: logPath, knownSecrets: [] }),
    ).rejects.toThrow("secret material");
  });

  test("fails closed when either real provider preflight is unavailable", async () => {
    await expect(
      assertCase20PartBProviderPreflight({ canRun: async (provider) => provider === "codex" }),
    ).rejects.toThrow("claude");
    await expect(
      assertCase20PartBProviderPreflight({ canRun: async () => true }),
    ).resolves.toBeUndefined();
  });

  test("forces safe modes for both real provider runs", () => {
    expect(getCase20RealProviderConfig("codex").modeId).toBe("auto");
    expect(getCase20RealProviderConfig("claude").modeId).toBe("acceptEdits");
    expect(case20ProviderOptions("codex", "/private/workspace")).toMatchObject({
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: false, writable_roots: ["/private/workspace"] },
      web_search: "disabled",
    });
    expect(case20ProviderOptions("claude", "/private/workspace")).toMatchObject({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { deniedDomains: ["*"], allowLocalBinding: false },
        filesystem: {
          allowRead: ["/private/workspace"],
          allowWrite: ["/private/workspace"],
          allowManagedReadPathsOnly: true,
        },
      },
    });
  });

  test("requires tool-backed proof for every provider sandbox boundary", () => {
    const complete = {
      allowedRead: true,
      allowedWrite: true,
      childCommand: true,
      outsideReadDenied: true,
      outsideWriteDenied: true,
      networkDenied: true,
      parentEnvironmentIsolated: true,
      shellToolCompleted: true,
      toolCalls: 1,
    } as const;
    expect(isCompleteCase20ProviderProbe(complete)).toBe(true);
    expect(isCompleteCase20ProviderProbe({ ...complete, toolCalls: 0 })).toBe(false);
    expect(isCompleteCase20ProviderProbe({ ...complete, shellToolCompleted: false })).toBe(false);
    expect(isCompleteCase20ProviderProbe({ ...complete, parentEnvironmentIsolated: false })).toBe(
      false,
    );
    expect(isCompleteCase20ProviderProbe({ ...complete, outsideWriteDenied: false })).toBe(false);
  });

  test("isolates provider parent and tool environments from unrelated secrets", () => {
    const secret = "case20-parent-secret-sentinel-value";
    expect(
      createCase20AllowlistedBaseEnvironment({ PATH: "/bin", UNRELATED_SECRET: secret }),
    ).toEqual({ PATH: "/bin" });
    const before = process.env.UNRELATED_SECRET;
    const isolation = installCase20ProviderParentEnvironment({ UNRELATED_SECRET: secret });
    try {
      expect(process.env.UNRELATED_SECRET).toBeUndefined();
      expect(isolation.environment.UNRELATED_SECRET).toBeUndefined();
      expect(isolation.knownSecrets).toContain(secret);
    } finally {
      isolation.restore();
    }
    expect(process.env.UNRELATED_SECRET).toBe(before);
  });

  test("verifies only the provider credential and config allowlist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-provider-allowlist-"));
    temporaryRoots.push(root);
    const credentialPath = path.join(root, "auth.json");
    const configPath = path.join(root, "config.toml");
    const unrelatedPath = path.join(root, "history.jsonl");
    await Promise.all([
      writeFile(credentialPath, "credential", { mode: 0o600 }),
      writeFile(configPath, "config", { mode: 0o600 }),
      writeFile(unrelatedPath, "history", { mode: 0o600 }),
    ]);
    const verify = await captureCase20ImmutableProviderFiles([credentialPath, configPath]);
    await writeFile(unrelatedPath, "provider-owned history update", { mode: 0o600 });
    await expect(verify()).resolves.toBeUndefined();
    await writeFile(configPath, "changed", { mode: 0o600 });
    await expect(verify()).rejects.toThrow("original source file");
  });

  test("allows only Codex executable shims in generated provider state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "case20-provider-symlink-"));
    temporaryRoots.push(root);
    const generatedRoot = path.join(root, "generated");
    const toolDirectory = path.join(generatedRoot, "codex-home", "tmp", "arg0", "codex-arg0ABC123");
    const codexBinary = path.join(root, "codex");
    await mkdir(toolDirectory, { recursive: true, mode: 0o700 });
    await writeFile(codexBinary, "binary", { mode: 0o700 });
    await Promise.all(
      ["applypatch", "apply_patch", "codex-execve-wrapper"].map(async (name) =>
        symlink(codexBinary, path.join(toolDirectory, name)),
      ),
    );

    await expect(
      assertCase20GeneratedProviderHomeSecretFree({
        root: generatedRoot,
        knownSecrets: [],
        provider: "codex",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCase20GeneratedProviderHomeSecretFree({
        root: generatedRoot,
        knownSecrets: [],
        provider: "claude",
      }),
    ).rejects.toThrow("symbolic link");

    const unexpectedRoot = path.join(root, "unexpected");
    await mkdir(unexpectedRoot, { mode: 0o700 });
    await symlink(codexBinary, path.join(unexpectedRoot, "apply_patch"));
    await expect(
      assertCase20GeneratedProviderHomeSecretFree({
        root: unexpectedRoot,
        knownSecrets: [],
        provider: "codex",
      }),
    ).rejects.toThrow("symbolic link");
  });

  test("binds provider process identity to PID, start time, and command", () => {
    const first = parseCase20ProcessRows("42 1 Wed Sep 11 03:00:00 2026 /usr/local/bin/codex\n")[0];
    const restarted = parseCase20ProcessRows(
      "42 1 Wed Sep 11 03:00:01 2026 /usr/local/bin/codex\n",
    )[0];
    expect(first).toMatchObject({ pid: 42, parentPid: 1, command: "/usr/local/bin/codex" });
    expect(restarted?.identity).not.toBe(first?.identity);
  });

  test("requires dense formal sampling and explicit provider cleanup", () => {
    const failed = buildCase20Summary(
      measurements({
        part: "B",
        paidProviderUseAcknowledged: true,
        provenance: {
          ...measurements().provenance,
          binaries: { codex: "codex-cli 1.0.0", claude: "claude 1.0.0" },
        },
        clients: [
          {
            id: "codex",
            principalId: "provider:codex",
            provider: "codex",
            connectedAt: "2026-09-11T00:00:00.000Z",
            disconnectedAt: "2026-09-11T00:30:00.000Z",
          },
          {
            id: "claude",
            principalId: "provider:claude",
            provider: "claude",
            connectedAt: "2026-09-11T00:00:00.000Z",
            disconnectedAt: "2026-09-11T00:30:00.000Z",
          },
        ],
        resourceSamples: [measurements().resourceSamples[0], measurements().resourceSamples[180]],
        providerSessionsClosed: false,
      }),
    );
    expect(failed.failures.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "resource_sample_gap",
        "final_20m_coverage",
        "provider_sessions_not_closed",
      ]),
    );
    expect(failed.latencyMs.feedback).toEqual({ status: "not_applicable" });
  });

  test("accepts dense Part B evidence with explicit N/A feedback and bounded baselines", () => {
    const successful = buildCase20Summary(
      measurements({
        part: "B",
        paidProviderUseAcknowledged: true,
        provenance: {
          ...measurements().provenance,
          binaries: { codex: "codex-cli 1.0.0", claude: "claude 1.0.0" },
        },
        clients: [
          {
            id: "codex-session",
            principalId: "provider:codex",
            provider: "codex",
            connectedAt: "2026-09-11T00:00:00.000Z",
            disconnectedAt: "2026-09-11T00:30:00.000Z",
          },
          {
            id: "claude-session",
            principalId: "provider:claude",
            provider: "claude",
            connectedAt: "2026-09-11T00:00:00.000Z",
            disconnectedAt: "2026-09-11T00:30:00.000Z",
          },
        ],
        feedbackLatencyMs: [],
        rpcLatencyMs: {
          "codex.turn": Array.from({ length: 10 }, () => 100),
          "claude.turn": Array.from({ length: 10 }, () => 100),
        },
        rpcBaselineLatencyMs: {
          "codex.turn": [100, 100, 100],
          "claude.turn": [100, 100, 100],
        },
        providerSessionsClosed: true,
      }),
    );
    expect(successful.pass).toBe(true);
    expect(successful.latencyMs.feedback).toEqual({ status: "not_applicable" });
  });

  test("fails missing feedback and required RPC distributions", () => {
    const failed = buildCase20Summary(
      measurements({
        feedbackLatencyMs: [],
        rpcLatencyMs: {},
        rpcBaselineLatencyMs: {},
      }),
    );
    expect(failed.failures.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "insufficient_feedback_samples",
        "insufficient_rpc_baseline",
        "insufficient_rpc_samples",
      ]),
    );
  });

  test("keeps smoke evidence ineligible and separates duration contracts", () => {
    expect(() =>
      PartAManifestSchema.parse({
        schemaVersion: 1,
        mode: "formal",
        runId: "formal",
        durationSec: 1,
      }),
    ).toThrow("1800");
    expect(() =>
      PartAManifestSchema.parse({
        schemaVersion: 1,
        mode: "smoke",
        runId: "smoke",
        durationSec: 1_800,
      }),
    ).toThrow("under 1800");
    const smoke = buildCase20Summary(
      measurements({ mode: "smoke", durationSec: 10, endedAt: "2026-09-11T00:00:10.000Z" }),
    );
    expect(smoke.eligible).toBe(false);
    expect(smoke.pass).toBe(false);
    expect(smoke.failures.map((entry) => entry.code)).toContain("smoke_ineligible");
  });
});
