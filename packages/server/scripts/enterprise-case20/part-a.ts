import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import {
  DaemonClient,
  type ConnectionState,
  type DaemonClientTrace,
  type Logger,
  type WebSocketFactory,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";

import { createCase20ArtifactWriter, type Case20ArtifactWriter } from "./artifact.js";
import { parseCase20CliArguments, readPrivateManifest } from "./manifest.js";
import {
  assertCase20MetricsPreflight,
  countDaemonAuditErrors,
  sampleDaemonResources,
} from "./metrics.js";
import {
  CASE20_PART_A_CLIENT_COUNT,
  CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES,
  CASE20_RPC_REQUEST_ID_PATTERN,
  type Case20DaemonRpcDiagnostic,
  type Case20DaemonRpcDiagnosticFailureCode,
  type Case20DaemonRuntimeObservationEvent,
  type Case20DaemonRuntimeObservationFailureCode,
  type Case20DaemonRuntimeResourceSampleKind,
  type Case20ClientRpcTraceEvent,
  type Case20ClientRuntimeMetricsEvent,
  type Case20ClientRecord,
  type Case20Counts,
  type Case20Failure,
  type Case20FinalActiveSample,
  type Case20ObservedInboundMessageType,
  type Case20ObservedRpcName,
  type Case20ObservedRpcResponseType,
  type Case20RawEvent,
  type Case20RpcDiagnosticEvent,
  type Case20RpcDiagnosticJoinFailureCode,
  type Case20RpcDiagnosticRejectedEvent,
  type Case20RpcDiagnosticRejectionReason,
  type Case20RetainedRssCheckpointPlan,
  type Case20RetainedRssSample,
  type Case20ResourceSample,
  type Case20RunnerEventLoopDelayEvent,
  PartAManifestSchema,
  type PartAManifest,
} from "./model.js";
import {
  createCase20PartAFixture,
  type Case20PartAClientFixture,
  type Case20PartAFixture,
} from "./part-a-fixture.js";
import { createCase20Provenance } from "./provenance.js";
import {
  case20RetainedRssCheckpointDelayMs,
  captureCase20FinalCheckpointBeforeCanary,
  captureCase20RetainedRssCheckpoint,
  createCase20RetainedRssSchedule,
} from "./retained-rss.js";
import { buildCase20Summary } from "./summary.js";

interface ConnectionLifecycle {
  intentionalClose: boolean;
  connected: boolean;
  lastStatus: ConnectionState["status"];
}

export function createCase20CliWebSocketFactory(): WebSocketFactory {
  return (url, options) =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
    }) as unknown as WebSocketLike;
}

interface ConnectedClient {
  readonly config: Case20PartAClientFixture;
  readonly client: PaseoApi;
  readonly daemonClient: DaemonClient;
  readonly releaseTimeline: () => void;
  readonly releaseConnection: () => void;
  readonly lifecycle: ConnectionLifecycle;
  readonly observation: Case20ClientObservationController;
  readonly connectedAt: string;
}

export interface Case20TimelineCleanupTarget {
  readonly clientId: string;
  readonly daemonClient: Pick<DaemonClient, "subscribeRawMessages" | "close">;
  readonly releaseTimeline: () => void;
}

export interface Case20TimelineCleanupResult {
  readonly clientId: string;
  readonly timelineError: Error | null;
  readonly closeError: Error | null;
}

interface StreamCounter {
  events: number;
  ownedCanaries: number;
  foreignAgentEvents: number;
  foreignCanaries: number;
  timelineEvents: number;
  timelineCanaries: number;
}

interface CanaryWaiter {
  readonly armedAt: number;
  readonly expectedCanary: string;
  readonly promise: Promise<number>;
  resolve(): void;
  cancel(): void;
}

interface PartAMeasurementState {
  readonly artifact: Case20ArtifactWriter;
  readonly counts: Case20Counts;
  readonly feedbackLatencyMs: number[];
  readonly rpcLatencyMs: Record<string, number[]>;
  readonly rpcBaselineLatencyMs: Record<string, number[]>;
  readonly resourceSamples: Case20ResourceSample[];
  readonly retainedRssSamples: Case20RetainedRssSample[];
  readonly evidenceFailures: Case20Failure[];
  readonly streamCounters: Map<string, StreamCounter>;
  readonly canaryWaiters: Map<string, CanaryWaiter>;
  readonly observedCanaries: Set<string>;
  readonly observedTimelineCanaries: Set<string>;
  readonly finalCanaries: Map<string, string>;
  readonly finalAgentCanaries: Set<string>;
  readonly finalTimelineCanaries: Set<string>;
  readonly observationBuffer: Case20ObservationBuffer;
  readonly rpcDiagnosticJoiner: Case20RpcDiagnosticJoiner;
  readonly observationFailureKeys: Set<string>;
  daemonRuntimeObservation: Case20DaemonRuntimeObservationRecorder | null;
  canarySequence: number;
}

type Case20ObservationEvent =
  | Case20ClientRuntimeMetricsEvent
  | Case20ClientRpcTraceEvent
  | Case20DaemonRuntimeObservationEvent
  | Case20RunnerEventLoopDelayEvent;

type Case20ObservationFailureCode =
  | "client_runtime_metrics_invalid"
  | "client_rpc_trace_invalid"
  | "observation_buffer_limit_exceeded"
  | "runner_event_loop_delay_invalid"
  | Case20DaemonRuntimeObservationFailureCode
  | Case20DaemonRpcDiagnosticFailureCode
  | Case20RpcDiagnosticJoinFailureCode;

const CASE20_OBSERVATION_EVENT_CAPACITY = 100_000;
const CASE20_OBSERVATION_FAILURE_RESERVE = 128;
const CASE20_TRACE_DEPTH_LIMIT = 16;
const CASE20_TRACE_CHILD_LIMIT = 16;
const CASE20_TRACE_TARGET_FRAME_LIMIT = 2;
const CASE20_RPC_DIAGNOSTIC_JOIN_CAPACITY = 50_000;

export interface Case20ObservationBuffer {
  readonly size: number;
  record(event: Case20RawEvent): boolean;
  recordFailure(event: Case20RawEvent): boolean;
  drain(): Case20RawEvent[];
}

export function createCase20ObservationBuffer(input: {
  readonly onOverflow: () => void;
  readonly capacity?: number;
  readonly reservedFailureEvents?: number;
}): Case20ObservationBuffer {
  const capacity = input.capacity ?? CASE20_OBSERVATION_EVENT_CAPACITY;
  const reservedFailureEvents = input.reservedFailureEvents ?? CASE20_OBSERVATION_FAILURE_RESERVE;
  if (
    !Number.isInteger(capacity) ||
    !Number.isInteger(reservedFailureEvents) ||
    capacity <= 1 ||
    reservedFailureEvents <= 0 ||
    reservedFailureEvents >= capacity
  )
    throw new Error("Case20 observation buffer limits are invalid");
  const events: Case20RawEvent[] = [];
  const dataCapacity = capacity - reservedFailureEvents;
  let overflowReported = false;
  return {
    get size() {
      return events.length;
    },
    record(event) {
      if (events.length >= dataCapacity) {
        if (!overflowReported) {
          overflowReported = true;
          try {
            input.onOverflow();
          } catch {
            // Observation limits must not change the business Promise path.
          }
        }
        return false;
      }
      events.push(event);
      return true;
    },
    recordFailure(event) {
      if (events.length >= capacity) return false;
      events.push(event);
      return true;
    },
    drain() {
      return events.splice(0, events.length);
    },
  };
}

export function recordCase20RpcDiagnosticEvent(
  buffer: Case20ObservationBuffer,
  event: Case20RpcDiagnosticEvent | Case20RpcDiagnosticRejectedEvent,
): void {
  const recorded =
    event.type === "rpc_diagnostic_rejected" ? buffer.recordFailure(event) : buffer.record(event);
  if (!recorded) throw new Error("Case20 RPC diagnostic event buffer is full");
}

export interface Case20DaemonRuntimeObservationRecorder {
  recordResource(input: {
    readonly resourceSampleKind: Exclude<Case20DaemonRuntimeResourceSampleKind, "final_drain">;
    readonly resourceTSec: number;
  }): Promise<void>;
  finish(resourceTSec: number): Promise<void>;
}

export function createCase20DaemonRuntimeObservationRecorder(input: {
  readonly collect: Case20PartAFixture["collectDaemonRuntimeObservation"];
  readonly record: (event: Case20DaemonRuntimeObservationEvent) => void;
  readonly onFailure: (code: Case20DaemonRuntimeObservationFailureCode) => void;
}): Case20DaemonRuntimeObservationRecorder {
  let finalAttempted = false;
  const collect = async (
    resourceSampleKind: Case20DaemonRuntimeResourceSampleKind,
    resourceTSec: number,
    final: boolean,
  ) => {
    if (finalAttempted) {
      input.onFailure(
        final ? "daemon_runtime_observation_duplicate" : "daemon_runtime_observation_out_of_order",
      );
      return;
    }
    if (final) finalAttempted = true;
    try {
      const batch = await input.collect({ resourceSampleKind, resourceTSec, final });
      for (const failure of batch.failures) input.onFailure(failure);
      if (batch.observation) input.record(batch.observation);
    } catch {
      input.onFailure("daemon_runtime_observation_invalid");
    }
  };
  return {
    recordResource: ({ resourceSampleKind, resourceTSec }) =>
      collect(resourceSampleKind, resourceTSec, false),
    finish: (resourceTSec) => collect("final_drain", resourceTSec, true),
  };
}

interface Case20ExpectedRpcDiagnostic {
  readonly clientId: string;
  readonly sequence: number;
  readonly baseline: boolean;
  readonly name: Case20ObservedRpcName;
  readonly requestId: string;
  readonly rpcStartedMonotonicUnixMs: number;
  clientTrace: Case20ClientRpcTraceEvent | null;
  daemonDiagnostic: Case20DaemonRpcDiagnostic | null;
}

export interface Case20RpcDiagnosticJoiner {
  expect(input: {
    readonly clientId: string;
    readonly sequence: number;
    readonly baseline: boolean;
    readonly name: Case20ObservedRpcName;
    readonly requestId: string;
    readonly rpcStartedMonotonicUnixMs: number;
  }): void;
  recordClient(trace: Case20ClientRpcTraceEvent): void;
  recordDaemon(diagnostic: Case20DaemonRpcDiagnostic): void;
  recordDaemonFailure(failure: Case20DaemonRpcDiagnosticFailureCode): void;
  finish(): void;
}

function expectedDaemonTypes(name: Case20ObservedRpcName): {
  readonly requestType: Case20DaemonRpcDiagnostic["requestType"];
  readonly responseType: Case20DaemonRpcDiagnostic["responseType"];
} {
  return name === "fetch_agents"
    ? { requestType: "fetch_agents_request", responseType: "fetch_agents_response" }
    : { requestType: "fetch_agent_request", responseType: "rpc_error" };
}

function validClientRpcTraceShape(trace: unknown): trace is Case20ClientRpcTraceEvent {
  if (!isRecord(trace)) return false;
  const finiteFields = [
    trace.rpcStartedMonotonicUnixMs,
    trace.messageOutboundBeginMonotonicUnixMs,
    trace.messageOutboundEndMonotonicUnixMs,
    trace.frameOutboundBeginMonotonicUnixMs,
    trace.frameOutboundEndMonotonicUnixMs,
    trace.frameBeginMonotonicUnixMs,
    trace.frameEndMonotonicUnixMs,
    trace.promiseResumedMonotonicUnixMs,
    trace.callbackTotalMs,
    trace.decodeBeforeParseMs,
    trace.jsonParseMs,
    trace.aotValidateMs,
    trace.dispatchAndWaiterMs,
    trace.frameEndToPromiseResumeMs,
  ];
  return (
    Reflect.ownKeys(trace).length === 22 &&
    trace.type === "client_rpc_trace" &&
    typeof trace.at === "string" &&
    typeof trace.clientId === "string" &&
    /^case20-client-[0-9]{2}$/.test(trace.clientId) &&
    typeof trace.sequence === "number" &&
    Number.isInteger(trace.sequence) &&
    trace.sequence > 0 &&
    typeof trace.baseline === "boolean" &&
    (trace.name === "fetch_agents" || trace.name === "foreign_fetch_agent_denial") &&
    trace.messageType === targetMessageType(trace.name) &&
    typeof trace.requestId === "string" &&
    CASE20_RPC_REQUEST_ID_PATTERN.test(trace.requestId) &&
    finiteFields.every(isFiniteNonNegative)
  );
}

function validClientRpcTraceOrder(trace: Case20ClientRpcTraceEvent): boolean {
  return (
    trace.rpcStartedMonotonicUnixMs <= trace.messageOutboundBeginMonotonicUnixMs &&
    trace.messageOutboundBeginMonotonicUnixMs <= trace.messageOutboundEndMonotonicUnixMs &&
    trace.messageOutboundEndMonotonicUnixMs <= trace.frameOutboundBeginMonotonicUnixMs &&
    trace.frameOutboundBeginMonotonicUnixMs <= trace.frameOutboundEndMonotonicUnixMs &&
    trace.frameOutboundEndMonotonicUnixMs <= trace.frameBeginMonotonicUnixMs &&
    trace.frameBeginMonotonicUnixMs <= trace.frameEndMonotonicUnixMs &&
    trace.frameEndMonotonicUnixMs <= trace.promiseResumedMonotonicUnixMs
  );
}

function isDaemonRequestType(value: unknown): value is Case20DaemonRpcDiagnostic["requestType"] {
  return value === "fetch_agents_request" || value === "fetch_agent_request";
}

function isDaemonResponseType(value: unknown): value is Case20DaemonRpcDiagnostic["responseType"] {
  return (
    value === "fetch_agents_response" || value === "fetch_agent_response" || value === "rpc_error"
  );
}

function validDaemonRpcDiagnosticShape(
  diagnostic: unknown,
): diagnostic is Case20DaemonRpcDiagnostic {
  if (
    !isRecord(diagnostic) ||
    Reflect.ownKeys(diagnostic).length !== 4 ||
    typeof diagnostic.requestId !== "string" ||
    !CASE20_RPC_REQUEST_ID_PATTERN.test(diagnostic.requestId) ||
    !isDaemonRequestType(diagnostic.requestType) ||
    !isDaemonResponseType(diagnostic.responseType) ||
    !Array.isArray(diagnostic.phases) ||
    diagnostic.phases.length !== CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.length
  )
    return false;
  return diagnostic.phases.every(
    (sample, index) =>
      isRecord(sample) &&
      Reflect.ownKeys(sample).length === 2 &&
      sample.phase === CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES[index] &&
      isFiniteNonNegative(sample.monotonicUnixMs),
  );
}

function validDaemonRpcDiagnosticOrder(diagnostic: Case20DaemonRpcDiagnostic): boolean {
  let previous = -1;
  return diagnostic.phases.every((sample) => {
    const valid = sample.monotonicUnixMs >= previous;
    previous = sample.monotonicUnixMs;
    return valid;
  });
}

function nullableTimestamp(value: unknown): number | null {
  return isFiniteNonNegative(value) ? value : null;
}

function diagnosticBoundary(
  diagnostic: Case20DaemonRpcDiagnostic | null,
  index: number,
): number | null {
  if (!diagnostic || !Array.isArray(diagnostic.phases)) return null;
  return nullableTimestamp(diagnostic.phases[index]?.monotonicUnixMs);
}

export function createCase20RpcDiagnosticJoiner(input: {
  readonly record: (event: Case20RpcDiagnosticEvent | Case20RpcDiagnosticRejectedEvent) => void;
  readonly onFailure: (code: Case20ObservationFailureCode, clientId?: string) => void;
  readonly capacity?: number;
  readonly nowIso?: () => string;
}): Case20RpcDiagnosticJoiner {
  const capacity = input.capacity ?? CASE20_RPC_DIAGNOSTIC_JOIN_CAPACITY;
  if (!Number.isInteger(capacity) || capacity <= 0)
    throw new Error("Case20 RPC diagnostic join capacity is invalid");
  const expected = new Map<string, Case20ExpectedRpcDiagnostic>();
  const knownRequestIds = new Set<string>();
  const nextClientSequence = new Map<string, number>();
  const nextDaemonSequence = new Map<string, number>();
  let finished = false;
  let firstRejectionRecorded = false;
  const fail = (code: Case20ObservationFailureCode, clientId?: string) => {
    try {
      input.onFailure(code, clientId);
    } catch {
      // Diagnostic failures cannot change the measured RPC Promise path.
    }
  };
  const discard = (requestId: string) => {
    expected.delete(requestId);
  };
  const recordFirstRejection = (
    entry: Case20ExpectedRpcDiagnostic,
    expectedSequence: number,
    reason: Case20RpcDiagnosticRejectionReason,
  ) => {
    if (firstRejectionRecorded) return;
    firstRejectionRecorded = true;
    const daemonTypes = expectedDaemonTypes(entry.name);
    const client = entry.clientTrace;
    const daemon = entry.daemonDiagnostic;
    try {
      input.record({
        type: "rpc_diagnostic_rejected",
        at: input.nowIso?.() ?? new Date().toISOString(),
        clientId: entry.clientId,
        sequence: entry.sequence,
        expectedSequence,
        name: entry.name,
        requestType:
          daemon && isDaemonRequestType(daemon.requestType)
            ? daemon.requestType
            : daemonTypes.requestType,
        responseType:
          daemon && isDaemonResponseType(daemon.responseType)
            ? daemon.responseType
            : daemonTypes.responseType,
        reason,
        boundaries: {
          clientRpcStartedMonotonicUnixMs: nullableTimestamp(
            client?.rpcStartedMonotonicUnixMs ?? entry.rpcStartedMonotonicUnixMs,
          ),
          clientMessageOutboundBeginMonotonicUnixMs: nullableTimestamp(
            client?.messageOutboundBeginMonotonicUnixMs,
          ),
          clientMessageOutboundEndMonotonicUnixMs: nullableTimestamp(
            client?.messageOutboundEndMonotonicUnixMs,
          ),
          clientFrameOutboundBeginMonotonicUnixMs: nullableTimestamp(
            client?.frameOutboundBeginMonotonicUnixMs,
          ),
          clientFrameOutboundEndMonotonicUnixMs: nullableTimestamp(
            client?.frameOutboundEndMonotonicUnixMs,
          ),
          clientFrameBeginMonotonicUnixMs: nullableTimestamp(client?.frameBeginMonotonicUnixMs),
          clientFrameEndMonotonicUnixMs: nullableTimestamp(client?.frameEndMonotonicUnixMs),
          clientPromiseResumedMonotonicUnixMs: nullableTimestamp(
            client?.promiseResumedMonotonicUnixMs,
          ),
          daemonFrameReceivedMonotonicUnixMs: diagnosticBoundary(daemon, 0),
          daemonResponseDeliverReturnMonotonicUnixMs: diagnosticBoundary(
            daemon,
            CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES.length - 1,
          ),
        },
      });
    } catch {
      fail("rpc_diagnostic_join_invalid", entry.clientId);
    }
  };
  const rejectOutOfOrder = (
    entry: Case20ExpectedRpcDiagnostic,
    expectedSequence: number,
    reason: Case20RpcDiagnosticRejectionReason,
  ) => {
    recordFirstRejection(entry, expectedSequence, reason);
    fail("rpc_diagnostic_join_out_of_order", entry.clientId);
    discard(entry.requestId);
  };
  const tryJoin = (entry: Case20ExpectedRpcDiagnostic) => {
    const client = entry.clientTrace;
    const daemon = entry.daemonDiagnostic;
    if (!client || !daemon) return;
    const daemonTypes = expectedDaemonTypes(entry.name);
    const daemonSequence = nextDaemonSequence.get(entry.clientId) ?? 1;
    // The runner and daemon child establish independent performance.timeOrigin values without
    // offset calibration. Their timestamps remain diagnostic; only each process's order is strict.
    if (daemon.requestType !== daemonTypes.requestType)
      return rejectOutOfOrder(entry, daemonSequence, "request_type_mismatch");
    if (daemon.responseType !== daemonTypes.responseType)
      return rejectOutOfOrder(entry, daemonSequence, "response_type_mismatch");
    if (entry.sequence !== daemonSequence)
      return rejectOutOfOrder(entry, daemonSequence, "joined_sequence_mismatch");
    nextDaemonSequence.set(entry.clientId, daemonSequence + 1);
    try {
      input.record({
        type: "rpc_diagnostic",
        at: input.nowIso?.() ?? new Date().toISOString(),
        clientId: entry.clientId,
        sequence: entry.sequence,
        baseline: entry.baseline,
        name: entry.name,
        requestId: entry.requestId,
        requestType: daemon.requestType,
        responseType: daemon.responseType,
        client: {
          rpcStartedMonotonicUnixMs: client.rpcStartedMonotonicUnixMs,
          messageOutboundBeginMonotonicUnixMs: client.messageOutboundBeginMonotonicUnixMs,
          messageOutboundEndMonotonicUnixMs: client.messageOutboundEndMonotonicUnixMs,
          frameOutboundBeginMonotonicUnixMs: client.frameOutboundBeginMonotonicUnixMs,
          frameOutboundEndMonotonicUnixMs: client.frameOutboundEndMonotonicUnixMs,
          frameBeginMonotonicUnixMs: client.frameBeginMonotonicUnixMs,
          frameEndMonotonicUnixMs: client.frameEndMonotonicUnixMs,
          promiseResumedMonotonicUnixMs: client.promiseResumedMonotonicUnixMs,
          callbackTotalMs: client.callbackTotalMs,
          decodeBeforeParseMs: client.decodeBeforeParseMs,
          jsonParseMs: client.jsonParseMs,
          aotValidateMs: client.aotValidateMs,
          dispatchAndWaiterMs: client.dispatchAndWaiterMs,
          frameEndToPromiseResumeMs: client.frameEndToPromiseResumeMs,
        },
        daemon: { phases: daemon.phases },
        crossProcessClock: {
          calibrated: false,
          frameOutboundEndToDaemonFrameReceivedMs:
            daemon.phases[0]!.monotonicUnixMs - client.frameOutboundEndMonotonicUnixMs,
          daemonResponseDeliverReturnToClientFrameBeginMs:
            client.frameBeginMonotonicUnixMs - daemon.phases.at(-1)!.monotonicUnixMs,
        },
      });
    } catch {
      fail("rpc_diagnostic_join_invalid", entry.clientId);
    }
    discard(entry.requestId);
  };
  return {
    expect(value) {
      if (
        finished ||
        !/^case20-client-[0-9]{2}$/.test(value.clientId) ||
        !Number.isInteger(value.sequence) ||
        value.sequence <= 0 ||
        typeof value.baseline !== "boolean" ||
        (value.name !== "fetch_agents" && value.name !== "foreign_fetch_agent_denial") ||
        !CASE20_RPC_REQUEST_ID_PATTERN.test(value.requestId) ||
        !isFiniteNonNegative(value.rpcStartedMonotonicUnixMs)
      ) {
        fail("rpc_diagnostic_join_invalid", value.clientId);
        return;
      }
      if (knownRequestIds.has(value.requestId)) {
        fail("rpc_diagnostic_join_duplicate", value.clientId);
        return;
      }
      if (knownRequestIds.size >= capacity) {
        fail("rpc_diagnostic_join_overflow", value.clientId);
        return;
      }
      const expectedSequence = nextClientSequence.get(value.clientId) ?? 1;
      if (value.sequence !== expectedSequence) {
        recordFirstRejection(
          {
            ...value,
            clientTrace: null,
            daemonDiagnostic: null,
          },
          expectedSequence,
          "expected_sequence_mismatch",
        );
        fail("rpc_diagnostic_join_out_of_order", value.clientId);
        return;
      }
      nextClientSequence.set(value.clientId, expectedSequence + 1);
      knownRequestIds.add(value.requestId);
      expected.set(value.requestId, {
        clientId: value.clientId,
        sequence: value.sequence,
        baseline: value.baseline,
        name: value.name,
        requestId: value.requestId,
        rpcStartedMonotonicUnixMs: value.rpcStartedMonotonicUnixMs,
        clientTrace: null,
        daemonDiagnostic: null,
      });
    },
    recordClient(trace) {
      const entry = expected.get(trace.requestId);
      if (!entry) {
        fail("rpc_diagnostic_join_invalid", trace.clientId);
        return;
      }
      if (entry.clientTrace) {
        fail("rpc_diagnostic_join_duplicate", entry.clientId);
        discard(entry.requestId);
        return;
      }
      entry.clientTrace = trace;
      const clientShapeValid = validClientRpcTraceShape(trace);
      if (!clientShapeValid) {
        rejectOutOfOrder(
          entry,
          nextDaemonSequence.get(entry.clientId) ?? 1,
          "client_trace_invalid",
        );
        return;
      }
      if (!validClientRpcTraceOrder(trace)) {
        rejectOutOfOrder(
          entry,
          nextDaemonSequence.get(entry.clientId) ?? 1,
          "client_trace_out_of_order",
        );
        return;
      }
      if (
        trace.clientId !== entry.clientId ||
        trace.sequence !== entry.sequence ||
        trace.baseline !== entry.baseline ||
        trace.name !== entry.name ||
        trace.rpcStartedMonotonicUnixMs !== entry.rpcStartedMonotonicUnixMs
      ) {
        rejectOutOfOrder(
          entry,
          nextDaemonSequence.get(entry.clientId) ?? 1,
          "client_expectation_mismatch",
        );
        return;
      }
      tryJoin(entry);
    },
    recordDaemon(diagnostic) {
      const entry = expected.get(diagnostic.requestId);
      if (!entry) {
        fail("rpc_diagnostic_join_invalid");
        return;
      }
      if (entry.daemonDiagnostic) {
        fail("rpc_diagnostic_join_duplicate", entry.clientId);
        discard(entry.requestId);
        return;
      }
      entry.daemonDiagnostic = diagnostic;
      const daemonShapeValid = validDaemonRpcDiagnosticShape(diagnostic);
      if (!daemonShapeValid) {
        rejectOutOfOrder(
          entry,
          nextDaemonSequence.get(entry.clientId) ?? 1,
          "daemon_trace_invalid",
        );
        return;
      }
      if (!validDaemonRpcDiagnosticOrder(diagnostic)) {
        rejectOutOfOrder(
          entry,
          nextDaemonSequence.get(entry.clientId) ?? 1,
          "daemon_trace_out_of_order",
        );
        return;
      }
      tryJoin(entry);
    },
    recordDaemonFailure(failure) {
      fail(failure);
    },
    finish() {
      if (finished) return;
      finished = true;
      for (const entry of expected.values()) fail("rpc_diagnostic_join_missing", entry.clientId);
      expected.clear();
    },
  };
}

interface Case20CompletedTraceSection {
  readonly name: string;
  readonly args?: Record<string, string>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly children: readonly Case20CompletedTraceSection[];
}

interface Case20OpenTraceSection {
  readonly name: string;
  readonly args?: Record<string, string>;
  readonly startedAtMs: number;
  readonly children: Case20CompletedTraceSection[];
}

interface Case20ArmedRpcTrace {
  readonly sequence: number;
  readonly baseline: boolean;
  readonly name: Case20ObservedRpcName;
  readonly requestType: Case20DaemonRpcDiagnostic["requestType"];
  readonly messageType: Case20ObservedRpcResponseType;
  readonly requestId: string;
  readonly rpcStartedMonotonicUnixMs: number;
}

export interface Case20ClientObservationController {
  readonly logger: Logger;
  readonly trace: DaemonClientTrace;
  armRpc(input: {
    readonly name: Case20ObservedRpcName;
    readonly baseline: boolean;
    readonly requestId: string;
    readonly rpcStartedMonotonicUnixMs: number;
  }): number;
  finishRpc(promiseResumedMonotonicUnixMs: number): void;
  seal(): void;
}

export function createCase20ObservedRpcTiming(input: {
  readonly startedAtMs: number;
  readonly nowMs: () => number;
  readonly nowMonotonicUnixMs: () => number;
  readonly finishRpc: (promiseResumedMonotonicUnixMs: number) => void;
}): {
  markPromiseResumed(): void;
  finish(recordDuration: (durationMs: number) => Promise<void>): Promise<void>;
} {
  let promiseResumedMonotonicUnixMs: number | null = null;
  return {
    markPromiseResumed() {
      promiseResumedMonotonicUnixMs ??= input.nowMonotonicUnixMs();
    },
    async finish(recordDuration) {
      const durationMs = input.nowMs() - input.startedAtMs;
      try {
        await recordDuration(durationMs);
      } finally {
        input.finishRpc(promiseResumedMonotonicUnixMs ?? Number.NaN);
      }
    },
  };
}

export function prepareCase20ObservedRpc(input: {
  readonly clientId: string;
  readonly name: Case20ObservedRpcName;
  readonly baseline: boolean;
  readonly requestId: string;
  readonly observation: Pick<Case20ClientObservationController, "armRpc">;
  readonly joiner: Pick<Case20RpcDiagnosticJoiner, "expect">;
  readonly nowMonotonicUnixMs: () => number;
  readonly nowDurationMs: () => number;
}): { readonly measuredStartedAtMs: number } {
  const rpcStartedMonotonicUnixMs = input.nowMonotonicUnixMs();
  const sequence = input.observation.armRpc({
    name: input.name,
    baseline: input.baseline,
    requestId: input.requestId,
    rpcStartedMonotonicUnixMs,
  });
  input.joiner.expect({
    clientId: input.clientId,
    sequence,
    baseline: input.baseline,
    name: input.name,
    requestId: input.requestId,
    rpcStartedMonotonicUnixMs,
  });
  return { measuredStartedAtMs: input.nowDurationMs() };
}

const CASE20_OBSERVED_MESSAGE_TYPES = [
  "fetch_agents_response",
  "rpc_error",
  "agent_stream",
] as const;
const CASE20_CONNECTION_STATUSES = [
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "disposed",
] as const;

function isCase20ConnectionStatus(
  value: unknown,
): value is Case20ClientRuntimeMetricsEvent["connectionStatus"] {
  return CASE20_CONNECTION_STATUSES.some((status) => status === value);
}

const case20ConsoleLogger: Logger = {
  debug() {},
  info: (object, message) => console.log(message, object),
  warn: (object, message) => console.warn(message, object),
  error: (object, message) => console.error(message, object),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isInteger(value);
}

function isObservedMessageType(value: unknown): value is Case20ObservedInboundMessageType {
  return CASE20_OBSERVED_MESSAGE_TYPES.some((candidate) => candidate === value);
}

function parseObservedCountRows(value: unknown): Map<Case20ObservedInboundMessageType, number> {
  if (!Array.isArray(value)) throw new Error("Case20 client metric counts are not an array");
  const result = new Map<Case20ObservedInboundMessageType, number>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2 || !isObservedMessageType(row[0])) continue;
    if (!isNonNegativeInteger(row[1]) || result.has(row[0]))
      throw new Error("Case20 client metric count row is invalid");
    result.set(row[0], row[1]);
  }
  return result;
}

interface Case20ObservedHandlerTiming {
  readonly count: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
}

function parseObservedHandlerRows(
  value: unknown,
): Map<Case20ObservedInboundMessageType, Case20ObservedHandlerTiming> {
  if (!Array.isArray(value)) throw new Error("Case20 client handler metrics are not an array");
  const result = new Map<Case20ObservedInboundMessageType, Case20ObservedHandlerTiming>();
  for (const row of value) {
    if (!isRecord(row) || !isObservedMessageType(row.type)) continue;
    if (
      !isNonNegativeInteger(row.count) ||
      !isFiniteNonNegative(row.totalMs) ||
      !isFiniteNonNegative(row.avgMs) ||
      !isFiniteNonNegative(row.maxMs) ||
      result.has(row.type)
    )
      throw new Error("Case20 client handler metric row is invalid");
    result.set(row.type, {
      count: row.count,
      totalMs: row.totalMs,
      avgMs: row.avgMs,
      maxMs: row.maxMs,
    });
  }
  return result;
}

function parseCase20ClientRuntimeMetrics(
  clientId: string,
  at: string,
  value: unknown,
): Case20ClientRuntimeMetricsEvent {
  if (!isRecord(value)) throw new Error("Case20 client runtime metric is not an object");
  if (
    !isFiniteNonNegative(value.windowMs) ||
    !isFiniteNonNegative(value.rollingWindowMs) ||
    value.rollingWindowMs <= 0 ||
    !isNonNegativeInteger(value.bucketCount) ||
    typeof value.final !== "boolean" ||
    (value.connectionPath !== "direct" && value.connectionPath !== "relay") ||
    !isCase20ConnectionStatus(value.connectionStatus)
  )
    throw new Error("Case20 client runtime metric envelope is invalid");
  const counts = parseObservedCountRows(value.inboundMessageTypesTop);
  const bytes = parseObservedCountRows(value.inboundMessageBytesTop);
  const handlers = parseObservedHandlerRows(value.handlerTimingTop);
  const messages = CASE20_OBSERVED_MESSAGE_TYPES.flatMap((messageType) => {
    const count = counts.get(messageType);
    const byteCount = bytes.get(messageType);
    const handler = handlers.get(messageType);
    if (count === undefined && byteCount === undefined && handler === undefined) return [];
    if (count === undefined || byteCount === undefined || !handler || handler.count !== count)
      throw new Error("Case20 client runtime metric target rows are incomplete");
    return [
      {
        messageType,
        count,
        bytes: byteCount,
        handlerCount: handler.count,
        handlerTotalMs: handler.totalMs,
        handlerAvgMs: handler.avgMs,
        handlerMaxMs: handler.maxMs,
      },
    ];
  });
  return {
    type: "client_runtime_metrics",
    at,
    clientId,
    windowMs: value.windowMs,
    rollingWindowMs: value.rollingWindowMs,
    bucketCount: value.bucketCount,
    final: value.final,
    connectionPath: value.connectionPath,
    connectionStatus: value.connectionStatus,
    messages,
  };
}

function findCompletedTraceSections(
  section: Case20CompletedTraceSection,
  name: string,
): Case20CompletedTraceSection[] {
  const matches = section.name === name ? [section] : [];
  for (const child of section.children) matches.push(...findCompletedTraceSections(child, name));
  return matches;
}

function targetMessageType(name: Case20ObservedRpcName): Case20ObservedRpcResponseType {
  return name === "fetch_agents" ? "fetch_agents_response" : "rpc_error";
}

function targetRequestType(name: Case20ObservedRpcName): Case20DaemonRpcDiagnostic["requestType"] {
  return name === "fetch_agents" ? "fetch_agents_request" : "fetch_agent_request";
}

function finiteDuration(endedAtMs: number, startedAtMs: number): number {
  const duration = endedAtMs - startedAtMs;
  if (!isFiniteNonNegative(duration)) throw new Error("Case20 client trace duration is invalid");
  return duration;
}

export function createCase20ClientObservationController(input: {
  readonly clientId: string;
  readonly record: (event: Case20ObservationEvent) => void;
  readonly onFailure: (code: Case20ObservationFailureCode) => void;
  readonly nowMonotonicUnixMs?: () => number;
  readonly nowIso?: () => string;
  readonly delegateLogger?: Logger;
}): Case20ClientObservationController {
  const nowMonotonicUnixMs =
    input.nowMonotonicUnixMs ?? (() => performance.timeOrigin + performance.now());
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const delegate = input.delegateLogger ?? case20ConsoleLogger;
  const traceStack: Case20OpenTraceSection[] = [];
  const targetFrames: Case20CompletedTraceSection[] = [];
  const reportedFailures = new Set<Case20ObservationFailureCode>();
  let armed: Case20ArmedRpcTrace | null = null;
  let sequence = 0;
  let finalRuntimeMetrics = 0;
  let sealed = false;
  let suppressedTraceDepth = 0;
  let targetOutboundMessage: Case20CompletedTraceSection | null = null;
  let targetOutboundFrame: Case20CompletedTraceSection | null = null;
  let pendingLivenessPingMessage: Case20CompletedTraceSection | null = null;
  let livenessPingPairSeen = false;
  let traceInvalid = false;
  const reportFailure = (code: Case20ObservationFailureCode) => {
    if (reportedFailures.has(code)) return;
    reportedFailures.add(code);
    try {
      input.onFailure(code);
    } catch {
      // Observation failures must not change the business Promise path.
    }
  };
  const invalidateTrace = () => {
    traceInvalid = true;
    reportFailure("client_rpc_trace_invalid");
  };
  const safeRecord = (event: Case20ObservationEvent) => {
    try {
      input.record(event);
    } catch {
      reportFailure(
        event.type === "client_rpc_trace"
          ? "client_rpc_trace_invalid"
          : "client_runtime_metrics_invalid",
      );
    }
  };
  const logger: Logger = {
    debug: (object, message) => delegate.debug(object, message),
    info: (object, message) => {
      if (message !== "ws_runtime_metrics_client") {
        delegate.info(object, message);
        return;
      }
      try {
        const event = parseCase20ClientRuntimeMetrics(input.clientId, nowIso(), object);
        if (event.final) {
          finalRuntimeMetrics += 1;
          if (finalRuntimeMetrics !== 1) throw new Error("Duplicate final client metrics");
        }
        safeRecord(event);
      } catch {
        reportFailure("client_runtime_metrics_invalid");
      }
    },
    warn: (object, message) => delegate.warn(object, message),
    error: (object, message) => delegate.error(object, message),
  };
  const captureOutboundMessage = (
    completed: Case20CompletedTraceSection,
    parent: Case20OpenTraceSection | undefined,
    target: Case20ArmedRpcTrace,
  ): boolean => {
    if (completed.name !== "paseo.ws.message.outbound") return false;
    const args = completed.args;
    if (args?.envelopeType === "ping" && args.messageType === "ping") {
      if (
        parent ||
        Reflect.ownKeys(args).length !== 2 ||
        !targetOutboundFrame ||
        targetFrames.length !== 0 ||
        pendingLivenessPingMessage ||
        livenessPingPairSeen
      ) {
        invalidateTrace();
      } else {
        pendingLivenessPingMessage = completed;
      }
      return true;
    }
    if (
      parent ||
      !args ||
      Reflect.ownKeys(args).length !== 2 ||
      args.envelopeType !== "session" ||
      args.messageType !== target.requestType ||
      targetOutboundMessage ||
      targetOutboundFrame
    ) {
      invalidateTrace();
    } else {
      targetOutboundMessage = completed;
    }
    return true;
  };
  const capturePendingLivenessPingFrame = (
    completed: Case20CompletedTraceSection,
    parent: Case20OpenTraceSection | undefined,
  ): boolean => {
    if (!pendingLivenessPingMessage) return false;
    const args = completed.args;
    if (
      parent ||
      !args ||
      Reflect.ownKeys(args).length !== 2 ||
      args.kind !== "text" ||
      !/^\d+$/.test(args.size ?? "") ||
      !targetOutboundFrame ||
      targetFrames.length !== 0 ||
      livenessPingPairSeen ||
      completed.startedAtMs < pendingLivenessPingMessage.endedAtMs
    ) {
      invalidateTrace();
    } else {
      pendingLivenessPingMessage = null;
      livenessPingPairSeen = true;
    }
    return true;
  };
  const captureOutboundFrame = (
    completed: Case20CompletedTraceSection,
    parent: Case20OpenTraceSection | undefined,
  ): boolean => {
    if (completed.name !== "paseo.ws.frame.outbound") return false;
    if (capturePendingLivenessPingFrame(completed, parent)) return true;
    const args = completed.args;
    if (
      parent ||
      !args ||
      Reflect.ownKeys(args).length !== 2 ||
      args.kind !== "text" ||
      !/^\d+$/.test(args.size ?? "") ||
      !targetOutboundMessage ||
      targetOutboundFrame ||
      completed.startedAtMs < targetOutboundMessage.endedAtMs
    ) {
      invalidateTrace();
    } else {
      targetOutboundFrame = completed;
    }
    return true;
  };
  const captureInboundTarget = (
    completed: Case20CompletedTraceSection,
    target: Case20ArmedRpcTrace,
  ) => {
    if (completed.name !== "paseo.ws.frame.inbound") return;
    const messages = findCompletedTraceSections(completed, "paseo.ws.message.inbound");
    if (messages.length !== 1 || messages[0]?.args?.messageType !== target.messageType) return;
    if (targetFrames.length >= CASE20_TRACE_TARGET_FRAME_LIMIT) {
      invalidateTrace();
    } else {
      targetFrames.push(completed);
    }
  };
  const trace: DaemonClientTrace = {
    isEnabled: () => armed !== null,
    beginSection(name, args) {
      if (!armed) return;
      try {
        if (suppressedTraceDepth > 0 || traceStack.length >= CASE20_TRACE_DEPTH_LIMIT) {
          suppressedTraceDepth += 1;
          invalidateTrace();
          return;
        }
        traceStack.push({ name, args, startedAtMs: nowMonotonicUnixMs(), children: [] });
      } catch {
        invalidateTrace();
      }
    },
    endSection() {
      if (!armed) return;
      try {
        if (suppressedTraceDepth > 0) {
          suppressedTraceDepth -= 1;
          return;
        }
        const open = traceStack.pop();
        if (!open) throw new Error("Case20 client trace stack underflow");
        const completed: Case20CompletedTraceSection = {
          ...open,
          endedAtMs: nowMonotonicUnixMs(),
        };
        const parent = traceStack.at(-1);
        if (parent) {
          if (parent.children.length >= CASE20_TRACE_CHILD_LIMIT) {
            invalidateTrace();
          } else {
            parent.children.push(completed);
          }
        }
        if (pendingLivenessPingMessage && completed.name !== "paseo.ws.frame.outbound") {
          invalidateTrace();
          return;
        }
        if (captureOutboundMessage(completed, parent, armed)) return;
        if (captureOutboundFrame(completed, parent)) return;
        captureInboundTarget(completed, armed);
      } catch {
        invalidateTrace();
      }
    },
  };
  return {
    logger,
    trace,
    armRpc(rpc) {
      sequence += 1;
      const invalidIdentity =
        !CASE20_RPC_REQUEST_ID_PATTERN.test(rpc.requestId) ||
        !isFiniteNonNegative(rpc.rpcStartedMonotonicUnixMs);
      traceInvalid = sealed || armed !== null || traceStack.length > 0 || invalidIdentity;
      if (traceInvalid) {
        invalidateTrace();
        traceStack.length = 0;
        targetFrames.length = 0;
        suppressedTraceDepth = 0;
      }
      targetOutboundMessage = null;
      targetOutboundFrame = null;
      pendingLivenessPingMessage = null;
      livenessPingPairSeen = false;
      if (sealed || invalidIdentity) return sequence;
      armed = {
        sequence,
        name: rpc.name,
        baseline: rpc.baseline,
        requestType: targetRequestType(rpc.name),
        messageType: targetMessageType(rpc.name),
        requestId: rpc.requestId,
        rpcStartedMonotonicUnixMs: rpc.rpcStartedMonotonicUnixMs,
      };
      return sequence;
    },
    finishRpc(promiseResumedMonotonicUnixMs) {
      const target = armed;
      armed = null;
      try {
        if (
          !target ||
          traceInvalid ||
          traceStack.length !== 0 ||
          suppressedTraceDepth !== 0 ||
          !targetOutboundMessage ||
          !targetOutboundFrame ||
          pendingLivenessPingMessage ||
          targetFrames.length !== 1
        )
          throw new Error("Case20 client target trace is incomplete");
        const frame = targetFrames[0]!;
        const parses = findCompletedTraceSections(frame, "paseo.ws.json.parse");
        const messages = findCompletedTraceSections(frame, "paseo.ws.message.inbound");
        if (parses.length !== 1 || messages.length !== 1)
          throw new Error("Case20 client target trace phases are incomplete");
        const parse = parses[0]!;
        const message = messages[0]!;
        if (
          target.rpcStartedMonotonicUnixMs > targetOutboundMessage.startedAtMs ||
          targetOutboundMessage.startedAtMs > targetOutboundMessage.endedAtMs ||
          targetOutboundMessage.endedAtMs > targetOutboundFrame.startedAtMs ||
          targetOutboundFrame.startedAtMs > targetOutboundFrame.endedAtMs ||
          targetOutboundFrame.endedAtMs > frame.startedAtMs ||
          frame.endedAtMs > promiseResumedMonotonicUnixMs
        )
          throw new Error("Case20 client target trace order is invalid");
        safeRecord({
          type: "client_rpc_trace",
          at: nowIso(),
          clientId: input.clientId,
          sequence: target.sequence,
          baseline: target.baseline,
          name: target.name,
          messageType: target.messageType,
          requestId: target.requestId,
          rpcStartedMonotonicUnixMs: target.rpcStartedMonotonicUnixMs,
          messageOutboundBeginMonotonicUnixMs: targetOutboundMessage.startedAtMs,
          messageOutboundEndMonotonicUnixMs: targetOutboundMessage.endedAtMs,
          frameOutboundBeginMonotonicUnixMs: targetOutboundFrame.startedAtMs,
          frameOutboundEndMonotonicUnixMs: targetOutboundFrame.endedAtMs,
          frameBeginMonotonicUnixMs: frame.startedAtMs,
          frameEndMonotonicUnixMs: frame.endedAtMs,
          promiseResumedMonotonicUnixMs,
          callbackTotalMs: finiteDuration(frame.endedAtMs, frame.startedAtMs),
          decodeBeforeParseMs: finiteDuration(parse.startedAtMs, frame.startedAtMs),
          jsonParseMs: finiteDuration(parse.endedAtMs, parse.startedAtMs),
          aotValidateMs: finiteDuration(message.startedAtMs, parse.endedAtMs),
          dispatchAndWaiterMs: finiteDuration(frame.endedAtMs, message.endedAtMs),
          frameEndToPromiseResumeMs: finiteDuration(promiseResumedMonotonicUnixMs, frame.endedAtMs),
        });
      } catch {
        reportFailure("client_rpc_trace_invalid");
      } finally {
        traceStack.length = 0;
        targetFrames.length = 0;
        suppressedTraceDepth = 0;
        targetOutboundMessage = null;
        targetOutboundFrame = null;
        pendingLivenessPingMessage = null;
        livenessPingPairSeen = false;
        traceInvalid = false;
      }
    },
    seal() {
      if (sealed) return;
      sealed = true;
      if (armed || traceStack.length > 0 || suppressedTraceDepth > 0 || pendingLivenessPingMessage)
        reportFailure("client_rpc_trace_invalid");
      if (finalRuntimeMetrics !== 1) reportFailure("client_runtime_metrics_invalid");
      armed = null;
      traceStack.length = 0;
      targetFrames.length = 0;
      suppressedTraceDepth = 0;
      targetOutboundMessage = null;
      targetOutboundFrame = null;
      pendingLivenessPingMessage = null;
      livenessPingPairSeen = false;
      traceInvalid = false;
    },
  };
}

interface Case20EventLoopDelayHistogram {
  readonly count: number;
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
}

interface Case20ScheduledInterval {
  unref?(): unknown;
}

export function createCase20RunnerEventLoopDelayObserver(input: {
  readonly intervalMs: number;
  readonly record: (event: Case20RunnerEventLoopDelayEvent) => void;
  readonly onFailure: (code: Case20ObservationFailureCode) => void;
  readonly histogram?: Case20EventLoopDelayHistogram;
  readonly nowUnixMs?: () => number;
  readonly schedule?: (handler: () => void, intervalMs: number) => Case20ScheduledInterval;
  readonly cancel?: (interval: Case20ScheduledInterval) => void;
}): { finish(): void } {
  const histogram =
    input.histogram ?? (monitorEventLoopDelay({ resolution: 10 }) as IntervalHistogram);
  const nowUnixMs = input.nowUnixMs ?? Date.now;
  const schedule = input.schedule ?? ((handler, intervalMs) => setInterval(handler, intervalMs));
  const cancel =
    input.cancel ?? ((interval) => clearInterval(interval as ReturnType<typeof setInterval>));
  let windowStartedAtMs = nowUnixMs();
  let finished = false;
  let failureReported = false;
  const reportFailure = () => {
    if (failureReported) return;
    failureReported = true;
    try {
      input.onFailure("runner_event_loop_delay_invalid");
    } catch {
      // Observation failures must not change the workload timer path.
    }
  };
  const capture = (final: boolean) => {
    if (finished && !final) return;
    const windowEndedAtMs = nowUnixMs();
    try {
      const sampleCount = histogram.count;
      const values =
        sampleCount === 0
          ? { p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }
          : {
              p50Ms: histogram.percentile(50) / 1_000_000,
              p95Ms: histogram.percentile(95) / 1_000_000,
              p99Ms: histogram.percentile(99) / 1_000_000,
              maxMs: histogram.max / 1_000_000,
            };
      if (
        !isNonNegativeInteger(sampleCount) ||
        !isFiniteNonNegative(windowStartedAtMs) ||
        !isFiniteNonNegative(windowEndedAtMs) ||
        windowEndedAtMs < windowStartedAtMs ||
        !Object.values(values).every(isFiniteNonNegative)
      )
        throw new Error("Case20 runner event-loop metric is invalid");
      input.record({
        type: "runner_event_loop_delay",
        at: new Date(windowEndedAtMs).toISOString(),
        windowStartedAtMs,
        windowEndedAtMs,
        intervalMs: input.intervalMs,
        sampleCount,
        ...values,
        final,
      });
    } catch {
      reportFailure();
    } finally {
      windowStartedAtMs = windowEndedAtMs;
      try {
        histogram.reset();
      } catch {
        reportFailure();
      }
    }
  };
  let interval: Case20ScheduledInterval;
  try {
    if (!isFiniteNonNegative(input.intervalMs) || input.intervalMs <= 0)
      throw new Error("Case20 runner event-loop interval is invalid");
    histogram.enable();
    interval = schedule(() => capture(false), input.intervalMs);
    interval.unref?.();
  } catch {
    reportFailure();
    try {
      histogram.disable();
    } catch {
      reportFailure();
    }
    return { finish() {} };
  }
  return {
    finish() {
      if (finished) return;
      finished = true;
      try {
        cancel(interval);
      } catch {
        reportFailure();
      }
      capture(true);
      try {
        histogram.disable();
      } catch {
        reportFailure();
      }
    },
  };
}

function createCounts(): Case20Counts {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    unexpectedDisconnects: 0,
    crossPrincipalViolations: 0,
    wrongRouteViolations: 0,
    writeConflicts: 0,
    auditErrors: 0,
    providerCrashes: 0,
    providerRestarts: 0,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface Case20PartAMeasurementBoundary {
  readonly streamCoverageStartedAtMs: number;
  readonly measurementStartedAtMs: number;
  readonly sessions: number;
  readonly sockets: number;
}

export function case20MeasuredWorkloadDeadlineMs(
  measurementStartedAtMs: number,
  durationSec: number,
): number {
  return measurementStartedAtMs + durationSec * 1_000;
}

export async function establishCase20PartAMeasurementBoundary(input: {
  readonly sample: () => Promise<Pick<Case20ResourceSample, "sessions" | "sockets">>;
  readonly markStreamCoverageStarted: (startedAtMs: number) => Promise<void>;
  readonly startStreams: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly pause?: (milliseconds: number) => Promise<void>;
}): Promise<Case20PartAMeasurementBoundary> {
  const now = input.now ?? Date.now;
  const pause = input.pause ?? sleep;
  const timeoutMs = input.timeoutMs ?? 40_000;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const deadline = now() + timeoutMs;
  let lastObserved = "unavailable";
  let lastError: unknown;
  while (now() < deadline) {
    let sample: Pick<Case20ResourceSample, "sessions" | "sockets">;
    try {
      sample = await input.sample();
    } catch (error) {
      lastError = error;
      await pause(pollIntervalMs);
      continue;
    }
    const observedAt = now();
    lastObserved = `${String(sample.sessions)}/${String(sample.sockets)}`;
    if (
      observedAt <= deadline &&
      sample.sessions === CASE20_PART_A_CLIENT_COUNT &&
      sample.sockets === CASE20_PART_A_CLIENT_COUNT
    ) {
      const streamCoverageStartedAtMs = now();
      await input.markStreamCoverageStarted(streamCoverageStartedAtMs);
      await input.startStreams();
      return {
        streamCoverageStartedAtMs,
        measurementStartedAtMs: now(),
        sessions: sample.sessions,
        sockets: sample.sockets,
      };
    }
    await pause(pollIntervalMs);
  }
  throw new Error(
    `Case20 did not observe exactly ${CASE20_PART_A_CLIENT_COUNT} sessions and ${CASE20_PART_A_CLIENT_COUNT} sockets before measurement (last ${lastObserved})`,
    { cause: lastError },
  );
}

function case20Error(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function releaseCase20TimelineAndWaitForEmpty(
  target: Case20TimelineCleanupTarget,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let releaseRawMessages: (() => void) | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseRawMessages?.();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`Case20 timeline cleanup timed out for ${target.clientId}`)),
      timeoutMs,
    );
    try {
      releaseRawMessages = target.daemonClient.subscribeRawMessages((message) => {
        if (
          message.type === "agent.timeline.set_subscription.response" &&
          message.payload.agentIds.length === 0
        )
          finish();
      });
      target.releaseTimeline();
    } catch (error) {
      finish(case20Error(error));
    }
  });
}

export async function cleanupCase20TimelineClients(
  targets: readonly Case20TimelineCleanupTarget[],
  timeoutMs = 10_000,
): Promise<readonly Case20TimelineCleanupResult[]> {
  const timelineErrors = await Promise.all(
    targets.map(async (target) => {
      try {
        await releaseCase20TimelineAndWaitForEmpty(target, timeoutMs);
        return null;
      } catch (error) {
        return case20Error(error);
      }
    }),
  );
  const closeErrors = await Promise.all(
    targets.map(async (target) => {
      try {
        await target.daemonClient.close();
        return null;
      } catch (error) {
        return case20Error(error);
      }
    }),
  );
  return targets.map((target, index) => ({
    clientId: target.clientId,
    timelineError: timelineErrors[index] ?? null,
    closeError: closeErrors[index] ?? null,
  }));
}

function recordDurableFailure(state: PartAMeasurementState, failure: Case20Failure): void {
  state.evidenceFailures.push(failure);
  void state.artifact
    .append({ type: "failure", at: new Date().toISOString(), failure }, { durable: true })
    .catch(() => {
      state.counts.auditErrors += 1;
    });
}

function case20ObservationFailureMetric(code: Case20ObservationFailureCode): string {
  if (code === "observation_buffer_limit_exceeded") return "runner.observation_buffer";
  if (code.startsWith("runner_")) return "runner.event_loop_delay";
  if (code.startsWith("daemon_runtime_")) return "daemon.runtime_observation";
  if (code.startsWith("daemon_rpc_")) return "daemon.rpc_diagnostic";
  if (code.startsWith("rpc_diagnostic_join_")) return "rpc.diagnostic_join";
  return "client.observation";
}

function bufferCase20ObservationFailure(
  state: PartAMeasurementState,
  code: Case20ObservationFailureCode,
  clientId?: string,
): void {
  const key = `${clientId ?? "runner"}:${code}`;
  if (state.observationFailureKeys.has(key)) return;
  state.observationFailureKeys.add(key);
  state.counts.auditErrors += 1;
  const failure: Case20Failure = {
    code,
    metric: case20ObservationFailureMetric(code),
    observed: clientId ?? "runner",
    threshold: "complete valid observation",
    evidenceRef: "raw.jsonl",
  };
  state.evidenceFailures.push(failure);
  state.observationBuffer.recordFailure({
    type: "failure",
    at: new Date().toISOString(),
    failure,
  });
}

async function flushCase20ObservationEvents(state: PartAMeasurementState): Promise<void> {
  for (const event of state.observationBuffer.drain()) await state.artifact.append(event);
}

function streamCounter(state: PartAMeasurementState, clientId: string): StreamCounter {
  let counter = state.streamCounters.get(clientId);
  if (!counter) {
    counter = {
      events: 0,
      ownedCanaries: 0,
      foreignAgentEvents: 0,
      foreignCanaries: 0,
      timelineEvents: 0,
      timelineCanaries: 0,
    };
    state.streamCounters.set(clientId, counter);
  }
  return counter;
}

function armCanaryWaiter(
  state: PartAMeasurementState,
  clientId: string,
  expectedCanary: string,
): CanaryWaiter {
  if (state.canaryWaiters.has(clientId))
    throw new Error(`Canary waiter already armed for ${clientId}`);
  const armedAt = performance.now();
  let settle: ((value: number) => void) | null = null;
  let rejectPromise: ((reason: Error) => void) | null = null;
  let settled = false;
  const promise = new Promise<number>((resolve, reject) => {
    settle = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    state.canaryWaiters.delete(clientId);
    rejectPromise?.(new Error(`First owned canary exceeded 2000ms for ${clientId}`));
  }, 2_000);
  const waiter: CanaryWaiter = {
    armedAt,
    expectedCanary,
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.canaryWaiters.delete(clientId);
      settle?.(performance.now() - armedAt);
    },
    cancel() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.canaryWaiters.delete(clientId);
      rejectPromise?.(new Error(`Canary waiter canceled for ${clientId}`));
    },
  };
  state.canaryWaiters.set(clientId, waiter);
  return waiter;
}

export function isUnexpectedCase20ConnectionTerminal(input: {
  readonly previous: ConnectionState["status"];
  readonly current: ConnectionState["status"];
  readonly connected: boolean;
  readonly intentionalClose: boolean;
}): boolean {
  return (
    input.connected &&
    !input.intentionalClose &&
    (input.current === "disconnected" ||
      (input.current === "disposed" && input.previous !== "disconnected"))
  );
}

function observeConnection(
  state: PartAMeasurementState,
  clientId: string,
  lifecycle: ConnectionLifecycle,
  status: ConnectionState,
): void {
  const previous = lifecycle.lastStatus;
  lifecycle.lastStatus = status.status;
  if (status.status === "connected") lifecycle.connected = true;
  const unexpectedTerminal = isUnexpectedCase20ConnectionTerminal({
    previous,
    current: status.status,
    connected: lifecycle.connected,
    intentionalClose: lifecycle.intentionalClose,
  });
  if (!unexpectedTerminal) return;
  state.counts.unexpectedDisconnects += 1;
  recordDurableFailure(state, {
    code: "unexpected_disconnect",
    metric: "connection.status",
    observed: status.status,
    threshold: "connected until intentional close",
    evidenceRef: "raw.jsonl",
  });
  void state.artifact
    .append(
      {
        type: "client_disconnected",
        at: new Date().toISOString(),
        clientId,
        expected: false,
      },
      { durable: true },
    )
    .catch(() => {
      state.counts.auditErrors += 1;
    });
}

async function connectClient(
  fixture: Case20PartAFixture,
  config: Case20PartAClientFixture,
  state: PartAMeasurementState,
  runtimeMetricsIntervalMs: number,
): Promise<ConnectedClient> {
  const observation = createCase20ClientObservationController({
    clientId: config.clientId,
    record: (event) => {
      if (event.type === "client_rpc_trace") state.rpcDiagnosticJoiner.recordClient(event);
      else state.observationBuffer.record(event);
    },
    onFailure: (code) => bufferCase20ObservationFailure(state, code, config.clientId),
  });
  const daemonClient = new DaemonClient({
    url: fixture.daemonUrl,
    clientId: config.clientId,
    clientType: "cli",
    password: config.personalAccessToken,
    webSocketFactory: createCase20CliWebSocketFactory(),
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    logger: observation.logger,
    trace: observation.trace,
    runtimeMetricsIntervalMs,
    runtimeMetricsWindowMs: runtimeMetricsIntervalMs,
  });
  const lifecycle: ConnectionLifecycle = {
    intentionalClose: false,
    connected: false,
    lastStatus: "idle",
  };
  const releaseConnection = daemonClient.subscribeConnectionStatus((status) =>
    observeConnection(state, config.clientId, lifecycle, status),
  );
  const client = createPaseoApi(daemonClient);
  const foreignCanaries = fixture.clients
    .filter((candidate) => candidate.clientId !== config.clientId)
    .map((candidate) => candidate.streamCanary);
  daemonClient.on("agent_stream", (message) => {
    const serialized = JSON.stringify(message.payload.event);
    const ownedAgent = message.payload.agentId === config.agentId;
    const ownedCanary = serialized.includes(config.streamCanary);
    const foreignCanary = foreignCanaries.some((canary) => serialized.includes(canary));
    const counter = streamCounter(state, config.clientId);
    counter.events += 1;
    if (!ownedAgent) counter.foreignAgentEvents += 1;
    if (foreignCanary) counter.foreignCanaries += 1;
    if (ownedAgent && ownedCanary) {
      counter.ownedCanaries += 1;
      state.observedCanaries.add(config.clientId);
      const waiter = state.canaryWaiters.get(config.clientId);
      if (waiter && serialized.includes(waiter.expectedCanary)) waiter.resolve();
      const finalCanary = state.finalCanaries.get(config.clientId);
      if (finalCanary && serialized.includes(finalCanary))
        state.finalAgentCanaries.add(config.clientId);
    }
    if (ownedAgent && !foreignCanary) return;
    state.counts.crossPrincipalViolations += 1;
    recordDurableFailure(state, {
      code: "cross_principal_agent_stream",
      metric: "agent_stream",
      observed: message.payload.agentId,
      threshold: config.agentId,
      evidenceRef: "raw.jsonl",
    });
  });
  try {
    await daemonClient.connect();
    const releaseTimeline = daemonClient.subscribeAgentTimeline(config.agentId, (message) => {
      const counter = streamCounter(state, config.clientId);
      counter.timelineEvents += 1;
      if (
        message.type === "agent_stream" &&
        JSON.stringify(message.payload.event).includes(config.streamCanary)
      ) {
        counter.timelineCanaries += 1;
        state.observedTimelineCanaries.add(config.clientId);
        const finalCanary = state.finalCanaries.get(config.clientId);
        if (finalCanary && JSON.stringify(message.payload.event).includes(finalCanary))
          state.finalTimelineCanaries.add(config.clientId);
      }
    });
    await releaseTimeline.ready;
    return {
      config,
      client,
      daemonClient,
      releaseTimeline,
      releaseConnection,
      lifecycle,
      observation,
      connectedAt: new Date().toISOString(),
    };
  } catch (error) {
    lifecycle.intentionalClose = true;
    let releaseFailure: unknown;
    try {
      releaseConnection();
    } catch (failure) {
      releaseFailure = failure;
    }
    const closeError = await daemonClient.close().then(
      () => null,
      (failure: unknown) => failure,
    );
    observation.seal();
    const cleanupFailures = [releaseFailure, closeError].filter(
      (failure): failure is NonNullable<typeof failure> =>
        failure !== undefined && failure !== null,
    );
    if (cleanupFailures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the connection error as cause and first member.
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Case20 client connection cleanup failed",
        { cause: error },
      );
    throw error;
  }
}

async function flushStreamAggregates(state: PartAMeasurementState): Promise<void> {
  for (const [clientId, counter] of state.streamCounters) {
    if (
      counter.events === 0 &&
      counter.ownedCanaries === 0 &&
      counter.foreignAgentEvents === 0 &&
      counter.foreignCanaries === 0 &&
      counter.timelineEvents === 0 &&
      counter.timelineCanaries === 0
    )
      continue;
    await state.artifact.append({
      type: "agent_stream_aggregate",
      at: new Date().toISOString(),
      clientId,
      ...counter,
    });
    counter.events = 0;
    counter.ownedCanaries = 0;
    counter.foreignAgentEvents = 0;
    counter.foreignCanaries = 0;
    counter.timelineEvents = 0;
    counter.timelineCanaries = 0;
  }
}

function pushLatency(target: Record<string, number[]>, name: string, durationMs: number): void {
  (target[name] ??= []).push(durationMs);
}

async function recordRpc(input: {
  readonly state: PartAMeasurementState;
  readonly clientId: string;
  readonly name: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly baseline: boolean;
}): Promise<void> {
  pushLatency(
    input.baseline ? input.state.rpcBaselineLatencyMs : input.state.rpcLatencyMs,
    input.name,
    input.durationMs,
  );
  await input.state.artifact.append({
    type: "rpc",
    at: new Date().toISOString(),
    clientId: input.clientId,
    name: input.name,
    durationMs: input.durationMs,
    ok: input.ok,
    baseline: input.baseline,
  });
}

function createCase20RpcRequestId(): string {
  return `case20-rpc-${randomBytes(16).toString("hex")}`;
}

async function measureAgentList(
  connected: ConnectedClient,
  state: PartAMeasurementState,
  baseline: boolean,
): Promise<readonly string[]> {
  const requestId = createCase20RpcRequestId();
  const prepared = prepareCase20ObservedRpc({
    clientId: connected.config.clientId,
    name: "fetch_agents",
    baseline,
    requestId,
    observation: connected.observation,
    joiner: state.rpcDiagnosticJoiner,
    nowMonotonicUnixMs: () => performance.timeOrigin + performance.now(),
    nowDurationMs: () => performance.now(),
  });
  const timing = createCase20ObservedRpcTiming({
    startedAtMs: prepared.measuredStartedAtMs,
    nowMs: () => performance.now(),
    nowMonotonicUnixMs: () => performance.timeOrigin + performance.now(),
    finishRpc: (promiseResumedMonotonicUnixMs) =>
      connected.observation.finishRpc(promiseResumedMonotonicUnixMs),
  });
  let ok = false;
  try {
    const response = await connected.client.agents.list({ requestId, page: { limit: 200 } });
    timing.markPromiseResumed();
    ok = true;
    return response.entries.map((entry) => entry.agent.id);
  } catch (error) {
    timing.markPromiseResumed();
    throw error;
  } finally {
    await timing.finish((durationMs) =>
      recordRpc({
        state,
        clientId: connected.config.clientId,
        name: "fetch_agents",
        durationMs,
        ok,
        baseline,
      }),
    );
  }
}

async function measureWrongRoute(
  connected: ConnectedClient,
  foreignAgentId: string,
  state: PartAMeasurementState,
  baseline: boolean,
): Promise<boolean> {
  const requestId = createCase20RpcRequestId();
  const prepared = prepareCase20ObservedRpc({
    clientId: connected.config.clientId,
    name: "foreign_fetch_agent_denial",
    baseline,
    requestId,
    observation: connected.observation,
    joiner: state.rpcDiagnosticJoiner,
    nowMonotonicUnixMs: () => performance.timeOrigin + performance.now(),
    nowDurationMs: () => performance.now(),
  });
  const timing = createCase20ObservedRpcTiming({
    startedAtMs: prepared.measuredStartedAtMs,
    nowMs: () => performance.now(),
    nowMonotonicUnixMs: () => performance.timeOrigin + performance.now(),
    finishRpc: (promiseResumedMonotonicUnixMs) =>
      connected.observation.finishRpc(promiseResumedMonotonicUnixMs),
  });
  let denied = false;
  try {
    const agent = await connected.client.agents.ref(foreignAgentId).refresh(requestId);
    timing.markPromiseResumed();
    denied = agent === null;
  } catch (error) {
    timing.markPromiseResumed();
    denied = isCase20AccessDenial(error);
  } finally {
    await timing.finish((durationMs) =>
      recordRpc({
        state,
        clientId: connected.config.clientId,
        name: "foreign_fetch_agent_denial",
        durationMs,
        ok: denied,
        baseline,
      }),
    );
  }
  return denied;
}

export function case20ConcurrentBaselineForeignAgentIds(
  clients: readonly { readonly agentId: string }[],
): readonly string[] {
  if (clients.length < 2) throw new Error("Case20 concurrent baseline requires two clients");
  return clients.map((_, index) => {
    const neighbour = clients[(index + 1) % clients.length];
    if (!neighbour) throw new Error("Case20 concurrent baseline neighbour missing");
    return neighbour.agentId;
  });
}

export function isCase20AccessDenial(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "access_denied" || code === "not_found";
}

export function classifyCase20AgentList(
  ownedAgentId: string,
  ids: readonly string[],
): { readonly ownedAgentVisible: boolean; readonly foreignAgentCount: number } {
  return {
    ownedAgentVisible: ids.includes(ownedAgentId),
    foreignAgentCount: ids.filter((id) => id !== ownedAgentId).length,
  };
}

function recordIsolation(
  client: ConnectedClient,
  ids: readonly string[],
  state: PartAMeasurementState,
): boolean {
  const result = classifyCase20AgentList(client.config.agentId, ids);
  if (!result.ownedAgentVisible) {
    recordDurableFailure(state, {
      code: "owned_agent_missing",
      metric: "agent.list",
      observed: ids.length,
      threshold: "owned agent visible",
      evidenceRef: "raw.jsonl",
    });
  }
  if (result.foreignAgentCount > 0) {
    state.counts.crossPrincipalViolations += result.foreignAgentCount;
    recordDurableFailure(state, {
      code: "cross_principal_agent_visible",
      metric: "agent.list.foreign",
      observed: result.foreignAgentCount,
      threshold: 0,
      evidenceRef: "raw.jsonl",
    });
  }
  return result.ownedAgentVisible && result.foreignAgentCount === 0;
}

async function runBaseline(
  clients: readonly ConnectedClient[],
  state: PartAMeasurementState,
): Promise<void> {
  const foreignAgentIds = case20ConcurrentBaselineForeignAgentIds(
    clients.map((client) => client.config),
  );
  await Promise.all(
    clients.map(async (client, index) => {
      const foreignAgentId = foreignAgentIds[index];
      if (!foreignAgentId) throw new Error("Case20 concurrent baseline target missing");
      const ids = await measureAgentList(client, state, true);
      if (!recordIsolation(client, ids, state))
        throw new Error(`Case20 baseline isolation failed for ${client.config.clientId}`);
      if (!(await measureWrongRoute(client, foreignAgentId, state, true)))
        throw new Error(
          `Case20 baseline did not deny a foreign agent for ${client.config.clientId}`,
        );
    }),
  );
}

function nextCanary(connected: ConnectedClient, state: PartAMeasurementState): string {
  state.canarySequence += 1;
  return `${connected.config.streamCanary}:${state.canarySequence}`;
}

async function sendOwnedCanary(
  connected: ConnectedClient,
  state: PartAMeasurementState,
  expectedCanary = nextCanary(connected, state),
): Promise<void> {
  state.counts.requests += 1;
  const waiter = armCanaryWaiter(state, connected.config.clientId, expectedCanary);
  const canary = waiter.promise;
  void canary.catch(() => undefined);
  const started = performance.now();
  let ok = false;
  try {
    await connected.client.agents.ref(connected.config.agentId).send(expectedCanary);
    const latency = await canary;
    state.feedbackLatencyMs.push(latency);
    await state.artifact.append({
      type: "feedback",
      at: new Date().toISOString(),
      clientId: connected.config.clientId,
      durationMs: latency,
      thresholdMs: 2_000,
    });
    state.counts.succeeded += 1;
    ok = true;
  } catch (error) {
    waiter.cancel();
    state.counts.failed += 1;
    throw error;
  } finally {
    await state.artifact.append({
      type: "rpc",
      at: new Date().toISOString(),
      clientId: connected.config.clientId,
      name: "send_agent_message",
      durationMs: performance.now() - started,
      ok,
      baseline: false,
    });
  }
}

async function startConversations(
  clients: readonly ConnectedClient[],
  state: PartAMeasurementState,
): Promise<void> {
  await Promise.all(clients.map((connected) => sendOwnedCanary(connected, state)));
}

async function runWorkloadCycle(
  clients: readonly ConnectedClient[],
  state: PartAMeasurementState,
): Promise<void> {
  await Promise.all(
    clients.map(async (connected, index) => {
      if (connected.daemonClient.getConnectionState().status !== "connected")
        throw new Error(`Case20 client disconnected: ${connected.config.clientId}`);
      state.counts.requests += 1;
      try {
        const ids = await measureAgentList(connected, state, false);
        if (recordIsolation(connected, ids, state)) state.counts.succeeded += 1;
        else state.counts.failed += 1;
      } catch (error) {
        state.counts.failed += 1;
        throw error;
      }
      const neighbour = clients[(index + 1) % clients.length];
      if (!neighbour) throw new Error("Case20 neighbour client missing");
      state.counts.requests += 1;
      try {
        if (await measureWrongRoute(connected, neighbour.config.agentId, state, false)) {
          state.counts.succeeded += 1;
        } else {
          state.counts.failed += 1;
          state.counts.wrongRouteViolations += 1;
          recordDurableFailure(state, {
            code: "foreign_route_not_denied",
            metric: "foreign_fetch_agent_denial",
            observed: connected.config.clientId,
            threshold: "access_denied or not_found",
            evidenceRef: "raw.jsonl",
          });
        }
      } catch (error) {
        state.counts.failed += 1;
        throw error;
      }
      await sendOwnedCanary(connected, state);
    }),
  );
}

async function waitForInitialMetrics(fixture: Case20PartAFixture): Promise<Case20ResourceSample> {
  const deadline = Date.now() + 40_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await sampleDaemonResources({
        daemonPid: fixture.daemonPid,
        daemonLogPath: fixture.daemonLogPath,
        tSec: 0,
      });
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw new Error("Case20 did not observe ws_runtime_metrics within 40 seconds", {
    cause: lastError,
  });
}

async function sampleDuringRun(
  fixture: Case20PartAFixture,
  startedAtMs: number,
  state: PartAMeasurementState,
): Promise<void> {
  const sample = await sampleDaemonResources({
    daemonPid: fixture.daemonPid,
    daemonLogPath: fixture.daemonLogPath,
    tSec: (Date.now() - startedAtMs) / 1_000,
  });
  await state.daemonRuntimeObservation?.recordResource({
    resourceSampleKind: "resource",
    resourceTSec: sample.tSec,
  });
  state.resourceSamples.push(sample);
  await state.artifact.append({ type: "resource", at: new Date().toISOString(), sample });
  await flushStreamAggregates(state);
}

async function captureRetainedRss(
  plan: Case20RetainedRssCheckpointPlan,
  fixture: Case20PartAFixture,
  startedAtMs: number,
  state: PartAMeasurementState,
): Promise<void> {
  try {
    const checkpoint = await captureCase20RetainedRssCheckpoint({
      plan,
      daemonPid: fixture.daemonPid,
      measurementStartedAtMs: startedAtMs,
      collectGarbage: (request) => fixture.collectGarbage(request),
      sample: async (tSec) => {
        const sample = await sampleDaemonResources({
          daemonPid: fixture.daemonPid,
          daemonLogPath: fixture.daemonLogPath,
          tSec,
        });
        await state.daemonRuntimeObservation?.recordResource({
          resourceSampleKind: "retained_resource",
          resourceTSec: sample.tSec,
        });
        return sample;
      },
    });
    state.retainedRssSamples.push(checkpoint);
    await state.artifact.append(
      { type: "retained_resource", at: new Date().toISOString(), checkpoint },
      { durable: true },
    );
  } catch (error) {
    recordDurableFailure(state, {
      code:
        error instanceof Error && /acknowledgement timed out/i.test(error.message)
          ? "retained_rss_ack_timeout"
          : "retained_rss_checkpoint_failed",
      metric: `resources.rss.retained.checkpoint.${plan.index}`,
      observed: error instanceof Error ? error.message : "failed",
      threshold: `${plan.index}:${plan.scheduledTSec}:${plan.requestId}`,
      evidenceRef: "raw.jsonl",
    });
  }
}

async function waitForClosedSessions(
  fixture: Case20PartAFixture,
  startedAtMs: number,
): Promise<Case20ResourceSample> {
  const deadline = Date.now() + 40_000;
  let last: Case20ResourceSample | null = null;
  while (Date.now() < deadline) {
    last = await sampleDaemonResources({
      daemonPid: fixture.daemonPid,
      daemonLogPath: fixture.daemonLogPath,
      tSec: (Date.now() - startedAtMs) / 1_000,
    });
    if (last.sessions === 0 && last.sockets === 0) return last;
    await sleep(1_000);
  }
  if (!last) throw new Error("Case20 final daemon metrics unavailable");
  return last;
}

async function captureFinalActiveSample(input: {
  readonly fixture: Case20PartAFixture;
  readonly clients: readonly ConnectedClient[];
  readonly state: PartAMeasurementState;
  readonly startedAtMs: number;
}): Promise<Case20FinalActiveSample> {
  await flushStreamAggregates(input.state);
  for (const client of input.clients) {
    const canary = nextCanary(client, input.state);
    input.state.finalCanaries.set(client.config.clientId, canary);
  }
  await Promise.all(
    input.clients.map((client) => {
      const canary = input.state.finalCanaries.get(client.config.clientId);
      if (!canary) throw new Error(`Case20 final canary missing for ${client.config.clientId}`);
      return sendOwnedCanary(client, input.state, canary);
    }),
  );
  const streamDeadline = Date.now() + 2_000;
  while (
    Date.now() < streamDeadline &&
    input.clients.some(
      (client) =>
        !input.state.finalAgentCanaries.has(client.config.clientId) ||
        !input.state.finalTimelineCanaries.has(client.config.clientId),
    )
  )
    await sleep(10);
  const sample = await sampleDaemonResources({
    daemonPid: input.fixture.daemonPid,
    daemonLogPath: input.fixture.daemonLogPath,
    tSec: (Date.now() - input.startedAtMs) / 1_000,
  });
  input.state.resourceSamples.push(sample);
  const finalActive: Case20FinalActiveSample = {
    at: new Date().toISOString(),
    sample,
    principalStreams: input.clients.map((client) => ({
      clientId: client.config.clientId,
      principalId: client.config.principalId,
      ownedCanaries: input.state.finalAgentCanaries.has(client.config.clientId) ? 1 : 0,
      timelineCanaries: input.state.finalTimelineCanaries.has(client.config.clientId) ? 1 : 0,
    })),
  };
  await input.state.daemonRuntimeObservation?.recordResource({
    resourceSampleKind: "final_active_sample",
    resourceTSec: sample.tSec,
  });
  await input.state.artifact.append({ type: "resource", at: finalActive.at, sample });
  await input.state.artifact.append(
    {
      type: "final_active_sample",
      measurementEndedAt: finalActive.at,
      ...finalActive,
    },
    { durable: true },
  );
  await flushStreamAggregates(input.state);
  return finalActive;
}

async function runMeasuredWorkload(input: {
  readonly manifest: PartAManifest;
  readonly fixture: Case20PartAFixture;
  readonly clients: readonly ConnectedClient[];
  readonly state: PartAMeasurementState;
  readonly startedAtMs: number;
  readonly retainedRssSchedule: readonly Case20RetainedRssCheckpointPlan[];
}): Promise<void> {
  let sampleTail = Promise.resolve();
  let retainedTail = Promise.resolve();
  const sample = () => {
    sampleTail = sampleTail
      .then(() => sampleDuringRun(input.fixture, input.startedAtMs, input.state))
      .catch((error: unknown) => {
        recordDurableFailure(input.state, {
          code: "resource_sample_failed",
          metric: "resources.sample",
          observed: error instanceof Error ? error.name : "unknown",
          threshold: "sampled",
          evidenceRef: "raw.jsonl",
        });
      });
  };
  sample();
  const sampler = setInterval(sample, input.manifest.sampleIntervalMs);
  const retainedTimers = input.retainedRssSchedule
    .filter(
      (checkpoint) =>
        checkpoint.scheduledTSec > 0 && checkpoint.scheduledTSec < input.manifest.durationSec,
    )
    .map((checkpoint) =>
      setTimeout(
        () => {
          retainedTail = retainedTail.then(() =>
            captureRetainedRss(checkpoint, input.fixture, input.startedAtMs, input.state),
          );
        },
        case20RetainedRssCheckpointDelayMs(input.startedAtMs, checkpoint.scheduledTSec),
      ),
    );
  const deadline = case20MeasuredWorkloadDeadlineMs(input.startedAtMs, input.manifest.durationSec);
  try {
    while (Date.now() < deadline) {
      await runWorkloadCycle(input.clients, input.state);
      await sleep(Math.min(input.manifest.workloadIntervalMs, Math.max(0, deadline - Date.now())));
    }
  } finally {
    clearInterval(sampler);
    for (const timer of retainedTimers) clearTimeout(timer);
    await sampleTail;
    await retainedTail;
  }
}

// oxlint-disable-next-line complexity -- orchestration records each independent cleanup failure.
export async function runCase20PartA(manifest: PartAManifest) {
  const retainedRssSchedule = createCase20RetainedRssSchedule(manifest.durationSec);
  await assertCase20MetricsPreflight();
  const provenance = await createCase20Provenance({ manifest });
  const artifact = await createCase20ArtifactWriter({
    artifactRoot: manifest.artifactRoot,
    runId: manifest.runId,
  });
  let state: PartAMeasurementState;
  const observationBuffer = createCase20ObservationBuffer({
    onOverflow: () => bufferCase20ObservationFailure(state, "observation_buffer_limit_exceeded"),
  });
  const rpcDiagnosticJoiner = createCase20RpcDiagnosticJoiner({
    record: (event) => recordCase20RpcDiagnosticEvent(state.observationBuffer, event),
    onFailure: (code, clientId) => bufferCase20ObservationFailure(state, code, clientId),
  });
  state = {
    artifact,
    counts: createCounts(),
    feedbackLatencyMs: [],
    rpcLatencyMs: {},
    rpcBaselineLatencyMs: {},
    resourceSamples: [],
    retainedRssSamples: [],
    evidenceFailures: [],
    streamCounters: new Map(),
    canaryWaiters: new Map(),
    observedCanaries: new Set(),
    observedTimelineCanaries: new Set(),
    finalCanaries: new Map(),
    finalAgentCanaries: new Set(),
    finalTimelineCanaries: new Set(),
    observationBuffer,
    rpcDiagnosticJoiner,
    observationFailureKeys: new Set(),
    daemonRuntimeObservation: null,
    canarySequence: 0,
  };
  const runStartedAt = new Date();
  const daemonLogPath = `${artifact.directory}/daemon.log`;
  const childLogPath = `${artifact.directory}/daemon-child.log`;
  let fixture: Case20PartAFixture | null = null;
  let clients: ConnectedClient[] = [];
  let measurementStartedAt = runStartedAt;
  let measurementEndedAt: Date | null = null;
  let streamCoverageStartedAt: Date | null = null;
  let finalActiveSample: Case20FinalActiveSample | undefined;
  let postCloseResourceSample: Case20ResourceSample | undefined;
  let runnerEventLoopObserver: { finish(): void } | null = null;
  let primaryError: unknown;
  let runFailure: unknown;
  let artifactCloseFailure: unknown;
  let completedSummary: ReturnType<typeof buildCase20Summary> | null = null;
  try {
    await artifact.append({
      type: "run_started",
      at: runStartedAt.toISOString(),
      part: "A",
      mode: manifest.mode,
      runId: manifest.runId,
    });
    await artifact.append(
      {
        type: "retained_rss_schedule",
        at: new Date().toISOString(),
        checkpoints: retainedRssSchedule,
      },
      { durable: true },
    );
    await artifact.append({ type: "provenance", at: new Date().toISOString(), value: provenance });
    try {
      fixture = await createCase20PartAFixture({
        daemonLogPath,
        childLogPath,
        mode: manifest.mode,
        retainedRssSchedule,
      });
      state.daemonRuntimeObservation = createCase20DaemonRuntimeObservationRecorder({
        collect: (input) => fixture!.collectDaemonRuntimeObservation(input),
        record: (event) => {
          state.observationBuffer.record(event);
        },
        onFailure: (code) => bufferCase20ObservationFailure(state, code),
      });
      await waitForInitialMetrics(fixture);
      if (fixture.clients.length < 2) throw new Error("Case20 Part A fixture is incomplete");
      for (const config of fixture.clients)
        clients.push(await connectClient(fixture, config, state, manifest.sampleIntervalMs));
      runnerEventLoopObserver = createCase20RunnerEventLoopDelayObserver({
        intervalMs: manifest.sampleIntervalMs,
        record: (event) => {
          state.observationBuffer.record(event);
        },
        onFailure: (code) => bufferCase20ObservationFailure(state, code),
      });
      await runBaseline(clients, state);
      for (const client of clients) {
        await artifact.append({
          type: "client_connected",
          at: client.connectedAt,
          clientId: client.config.clientId,
          principalId: client.config.principalId,
        });
      }
      const measurementBoundary = await establishCase20PartAMeasurementBoundary({
        sample: () =>
          sampleDaemonResources({
            daemonPid: fixture!.daemonPid,
            daemonLogPath: fixture!.daemonLogPath,
            tSec: 0,
          }),
        markStreamCoverageStarted: async (startedAtMs) => {
          streamCoverageStartedAt = new Date(startedAtMs);
          await artifact.append(
            {
              type: "stream_coverage_started",
              at: streamCoverageStartedAt.toISOString(),
              clients: clients.length,
            },
            { durable: true },
          );
        },
        startStreams: () => startConversations(clients, state),
      });
      measurementStartedAt = new Date(measurementBoundary.measurementStartedAtMs);
      await captureRetainedRss(
        retainedRssSchedule[0]!,
        fixture,
        measurementStartedAt.getTime(),
        state,
      );
      await runMeasuredWorkload({
        manifest,
        fixture,
        clients,
        state,
        startedAtMs: measurementStartedAt.getTime(),
        retainedRssSchedule,
      });
      finalActiveSample = await captureCase20FinalCheckpointBeforeCanary({
        captureCheckpoint: () =>
          captureRetainedRss(
            retainedRssSchedule.at(-1)!,
            fixture!,
            measurementStartedAt.getTime(),
            state,
          ),
        captureFinalActive: () =>
          captureFinalActiveSample({
            fixture: fixture!,
            clients,
            state,
            startedAtMs: measurementStartedAt.getTime(),
          }),
      });
      measurementEndedAt = new Date(finalActiveSample.at);
    } catch (error) {
      primaryError = error;
      recordDurableFailure(state, {
        code: "runner_error",
        metric: "run",
        observed: "failed",
        threshold: "complete",
        evidenceRef: "raw.jsonl",
      });
    } finally {
      measurementEndedAt ??= new Date();
      await state.daemonRuntimeObservation?.finish(
        Math.max(0, (measurementEndedAt.getTime() - measurementStartedAt.getTime()) / 1_000),
      );
      runnerEventLoopObserver?.finish();
      for (const waiter of state.canaryWaiters.values()) waiter.cancel();
      for (const client of clients) {
        client.lifecycle.intentionalClose = true;
      }
      for (const client of clients) {
        if (!state.observedCanaries.has(client.config.clientId))
          state.evidenceFailures.push({
            code: "agent_stream_canary_missing",
            metric: "agent_stream.ownedCanary",
            observed: client.config.clientId,
            threshold: "observed",
            evidenceRef: "raw.jsonl",
          });
        if (!state.observedTimelineCanaries.has(client.config.clientId))
          state.evidenceFailures.push({
            code: "timeline_canary_missing",
            metric: "agent.timeline.ownedCanary",
            observed: client.config.clientId,
            threshold: "observed",
            evidenceRef: "raw.jsonl",
          });
      }
      const clientCleanupResults = await cleanupCase20TimelineClients(
        clients.map((client) => ({
          clientId: client.config.clientId,
          daemonClient: client.daemonClient,
          releaseTimeline: client.releaseTimeline,
        })),
      );
      for (const client of clients) client.observation.seal();
      for (const result of clientCleanupResults) {
        if (result.timelineError) {
          primaryError ??= result.timelineError;
          state.evidenceFailures.push({
            code: "timeline_cleanup_failed",
            metric: "agent_stream.unsubscribe",
            observed: result.clientId,
            threshold: "empty subscription acknowledged",
            evidenceRef: "raw.jsonl",
          });
        }
        if (result.closeError) {
          primaryError ??= result.closeError;
          state.counts.auditErrors += 1;
          state.evidenceFailures.push({
            code: "client_cleanup_failed",
            metric: "client.close",
            observed: result.clientId,
            threshold: "closed",
            evidenceRef: "raw.jsonl",
          });
        }
      }
      for (const client of clients) client.releaseConnection();
      if (fixture) {
        await fixture
          .collectRpcDiagnostics((batch) => {
            for (const failure of batch.failures)
              state.rpcDiagnosticJoiner.recordDaemonFailure(failure);
            for (const diagnostic of batch.diagnostics)
              state.rpcDiagnosticJoiner.recordDaemon(diagnostic);
          })
          .catch(() => {
            bufferCase20ObservationFailure(state, "daemon_rpc_diagnostic_invalid");
          });
      }
      state.rpcDiagnosticJoiner.finish();
      await flushCase20ObservationEvents(state).catch((error) => {
        primaryError ??= error;
        state.counts.auditErrors += 1;
        state.evidenceFailures.push({
          code: "client_observation_flush_failed",
          metric: "client.observation",
          observed: "failed",
          threshold: "all buffered observations persisted",
          evidenceRef: "raw.jsonl",
        });
      });
      await flushStreamAggregates(state).catch((error) => {
        primaryError ??= error;
        state.counts.auditErrors += 1;
      });
      const disconnectedAt = new Date().toISOString();
      for (const client of clients) {
        await artifact
          .append({
            type: "client_disconnected",
            at: disconnectedAt,
            clientId: client.config.clientId,
            expected: true,
          })
          .catch((error) => {
            primaryError ??= error;
            state.counts.auditErrors += 1;
          });
      }
      if (fixture) {
        try {
          postCloseResourceSample = await waitForClosedSessions(
            fixture,
            measurementStartedAt.getTime(),
          );
          await artifact.append({
            type: "post_close_resource",
            at: new Date().toISOString(),
            sample: postCloseResourceSample,
          });
        } catch (error) {
          primaryError ??= error;
          state.evidenceFailures.push({
            code: "final_metrics_unavailable",
            metric: "resources",
            observed: "missing",
            threshold: "final sample",
            evidenceRef: "daemon.log",
          });
        }
        try {
          const audit = await fixture.close();
          await artifact.append({
            type: "audit_chain",
            at: new Date().toISOString(),
            restored: audit.restored,
            filesScanned: audit.filesScanned,
            auditFiles: audit.auditFiles,
          });
        } catch (error) {
          primaryError ??= error;
          state.counts.auditErrors += 1;
        }
        state.counts.auditErrors += await countDaemonAuditErrors(fixture.daemonLogPath).catch(
          () => 1,
        );
      }
    }
    const cleanupEndedAt = new Date();
    const endedAt = measurementEndedAt ?? cleanupEndedAt;
    const clientRecords: Case20ClientRecord[] = clients.map((client) => ({
      id: client.config.clientId,
      principalId: client.config.principalId,
      connectedAt: client.connectedAt,
      disconnectedAt: cleanupEndedAt.toISOString(),
    }));
    const summary = buildCase20Summary({
      schemaVersion: 1,
      runId: manifest.runId,
      startedAt: measurementStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      measurementEndedAt: endedAt.toISOString(),
      durationSec: (endedAt.getTime() - measurementStartedAt.getTime()) / 1_000,
      part: "A",
      mode: manifest.mode,
      provenance,
      clients: clientRecords,
      counts: state.counts,
      feedbackLatencyMs: state.feedbackLatencyMs,
      rpcLatencyMs: state.rpcLatencyMs,
      rpcBaselineLatencyMs: state.rpcBaselineLatencyMs,
      resourceSamples: state.resourceSamples,
      retainedRssSchedule,
      retainedRssSamples: state.retainedRssSamples,
      finalActiveSample,
      postCloseResourceSample,
      ...(streamCoverageStartedAt
        ? { streamCoverageStartedAt: streamCoverageStartedAt.toISOString() }
        : {}),
      sampleIntervalMs: manifest.sampleIntervalMs,
      evidenceFailures: state.evidenceFailures,
    });
    await artifact.append({ type: "run_finished", at: endedAt.toISOString(), pass: summary.pass });
    const knownSecrets = fixture?.clients.map((client) => client.personalAccessToken) ?? [];
    await artifact.finish(summary, {
      knownSecrets,
      evidenceFiles: [childLogPath, daemonLogPath],
    });
    if (primaryError) throw primaryError;
    completedSummary = summary;
  } catch (error) {
    runFailure = error;
  } finally {
    artifactCloseFailure = await artifact.close().then(
      () => null,
      (error: unknown) => error,
    );
  }
  if (runFailure && artifactCloseFailure)
    throw new AggregateError(
      [runFailure, artifactCloseFailure],
      "Case20 Part A artifact cleanup failed",
      { cause: runFailure },
    );
  if (runFailure) throw runFailure;
  if (artifactCloseFailure) throw artifactCloseFailure;
  if (!completedSummary) throw new Error("Case20 Part A summary missing");
  return completedSummary;
}

async function main(): Promise<void> {
  const args = parseCase20CliArguments(process.argv.slice(2));
  const manifest = await readPrivateManifest(args.manifestPath, PartAManifestSchema);
  const summary = await runCase20PartA(manifest);
  process.stdout.write(
    `${JSON.stringify({ runId: summary.runId, part: summary.part, mode: summary.mode, eligible: summary.eligible, pass: summary.pass })}\n`,
  );
  if (!summary.pass) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Case20 Part A failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
