import { fileURLToPath } from "node:url";

import { z } from "zod";

export const CASE20_MINIMUM_DURATION_SEC = 30 * 60;
export const CASE20_PART_A_CLIENT_COUNT = 10;
export type Case20Mode = "formal" | "smoke";

export const CASE20_THRESHOLDS = Object.freeze({
  feedbackP95Ms: 2_000,
  businessSuccessRate: 0.999,
  unexpectedDisconnects: 0,
  crossPrincipalViolations: 0,
  wrongRouteViolations: 0,
  writeConflicts: 0,
  auditErrors: 0,
  providerCrashes: 0,
  providerRestarts: 0,
  rssSlopeMiBPerMin: 1,
  rssEndDeltaMiB: 128,
  fdEndDelta: 10,
  swapDeltaMiB: 0,
  eventLoopP99Ms: 100,
  rpcP95Ratio: 1.25,
  endSessions: 0,
});

const privateFilePath = z.string().min(1);
const defaultArtifactRoot = fileURLToPath(
  new URL("../../../../.artifacts/case20", import.meta.url),
);

export const PartAManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["formal", "smoke"]),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/),
    artifactRoot: privateFilePath.default(defaultArtifactRoot),
    durationSec: z.number().int().positive().default(CASE20_MINIMUM_DURATION_SEC),
    sampleIntervalMs: z.number().int().min(1_000).max(60_000).default(10_000),
    workloadIntervalMs: z.number().int().min(250).max(30_000).default(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "formal" && value.durationSec < CASE20_MINIMUM_DURATION_SEC)
      context.addIssue({ code: "custom", path: ["durationSec"], message: "formal requires 1800s" });
    if (value.mode === "smoke" && value.durationSec >= CASE20_MINIMUM_DURATION_SEC)
      context.addIssue({
        code: "custom",
        path: ["durationSec"],
        message: "smoke must be under 1800s",
      });
  });

export type PartAManifest = z.infer<typeof PartAManifestSchema>;

export const PartBManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["formal", "smoke"]),
    runId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/),
    artifactRoot: privateFilePath.default(defaultArtifactRoot),
    durationSec: z.number().int().positive().default(CASE20_MINIMUM_DURATION_SEC),
    sampleIntervalMs: z.number().int().min(1_000).max(60_000).default(10_000),
    turnIntervalMs: z.number().int().min(1_000).max(120_000).default(30_000),
    workspaceRoot: privateFilePath,
    paidProviderUseAcknowledged: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "formal" && value.durationSec < CASE20_MINIMUM_DURATION_SEC)
      context.addIssue({ code: "custom", path: ["durationSec"], message: "formal requires 1800s" });
    if (value.mode === "smoke" && value.durationSec >= CASE20_MINIMUM_DURATION_SEC)
      context.addIssue({
        code: "custom",
        path: ["durationSec"],
        message: "smoke must be under 1800s",
      });
  });

export type PartBManifest = z.infer<typeof PartBManifestSchema>;

export interface Case20ClientRecord {
  readonly id: string;
  readonly principalId: string;
  readonly provider?: "codex" | "claude";
  readonly connectedAt: string;
  readonly disconnectedAt: string;
}

export interface Case20Counts {
  requests: number;
  succeeded: number;
  failed: number;
  unexpectedDisconnects: number;
  crossPrincipalViolations: number;
  wrongRouteViolations: number;
  writeConflicts: number;
  auditErrors: number;
  providerCrashes: number;
  providerRestarts: number;
}

export interface Case20ResourceSample {
  readonly tSec: number;
  readonly rssMiB: number;
  readonly fdCount: number;
  readonly swapMiB: number;
  readonly eventLoopP99Ms: number;
  readonly sessions: number | null;
  readonly sockets: number | null;
  readonly processes: readonly {
    readonly pid: number;
    readonly parentPid: number;
    readonly identity: string;
    readonly rssMiB: number;
    readonly fdCount: number;
  }[];
}

export interface Case20RetainedRssCheckpointPlan {
  readonly index: number;
  readonly requestId: string;
  readonly scheduledTSec: number;
}

export interface Case20RetainedRssSample extends Case20RetainedRssCheckpointPlan {
  readonly actualTSec: number;
  readonly acknowledgedInMs: number;
  readonly gcDurationMs: number;
  readonly treeRssMiB: number;
  readonly daemonMainIdentity: string;
  readonly daemonMainRssMiB: number;
  readonly sample: Case20ResourceSample;
}

export interface Case20PrincipalStreamActivity {
  readonly clientId: string;
  readonly principalId: string;
  readonly ownedCanaries: number;
  readonly timelineCanaries: number;
}

export interface Case20FinalActiveSample {
  readonly at: string;
  readonly sample: Case20ResourceSample;
  readonly principalStreams?: readonly Case20PrincipalStreamActivity[];
}

export interface Case20Failure {
  readonly code: string;
  readonly metric: string;
  readonly observed: number | string;
  readonly threshold: number | string;
  readonly evidenceRef: string;
}

export interface Case20RunMeasurements {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly measurementEndedAt: string;
  readonly durationSec: number;
  readonly part: "A" | "B";
  readonly mode: Case20Mode;
  readonly provenance: Case20Provenance;
  readonly clients: readonly Case20ClientRecord[];
  readonly counts: Readonly<Case20Counts>;
  readonly feedbackLatencyMs: readonly number[];
  readonly rpcLatencyMs: Readonly<Record<string, readonly number[]>>;
  readonly rpcBaselineLatencyMs: Readonly<Record<string, readonly number[]>>;
  readonly resourceSamples: readonly Case20ResourceSample[];
  readonly retainedRssSchedule?: readonly Case20RetainedRssCheckpointPlan[];
  readonly retainedRssSamples?: readonly Case20RetainedRssSample[];
  readonly finalActiveSample?: Case20FinalActiveSample;
  readonly postCloseResourceSample?: Case20ResourceSample;
  readonly streamCoverageStartedAt?: string;
  readonly sampleIntervalMs: number;
  readonly providerSessionsClosed?: boolean;
  readonly paidProviderUseAcknowledged?: true;
  readonly evidenceFailures?: readonly Case20Failure[];
}

export interface Case20Summary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly measurementEndedAt: string;
  readonly durationSec: number;
  readonly part: "A" | "B";
  readonly mode: Case20Mode;
  readonly eligible: boolean;
  readonly paidProviderUseAcknowledged?: true;
  readonly provenance: Case20Provenance;
  readonly clients: readonly Case20ClientRecord[];
  readonly counts: Readonly<Case20Counts>;
  readonly finalActiveSample?: Case20FinalActiveSample;
  readonly postCloseResourceSample?: Case20ResourceSample;
  readonly streamCoverageStartedAt?: string;
  readonly latencyMs: {
    readonly feedback:
      | {
          readonly p50: number;
          readonly p95: number;
          readonly p99: number;
          readonly max: number;
        }
      | { readonly status: "not_applicable" };
    readonly rpc: Readonly<
      Record<
        string,
        {
          readonly count: number;
          readonly p50: number;
          readonly p95: number;
          readonly p99: number;
          readonly baselineP95: number;
          readonly ratioToBaseline: number;
        }
      >
    >;
    readonly business: { readonly successRate: number };
  };
  readonly resources: {
    readonly rss: {
      readonly warmupMiB: number;
      readonly series: readonly { readonly tSec: number; readonly MiB: number }[];
      readonly last20MinTheilSenMiBPerMin: number;
      readonly rawLast20MinTheilSenMiBPerMin: number;
      readonly retained?: {
        readonly series: readonly {
          readonly index: number;
          readonly requestId: string;
          readonly scheduledTSec: number;
          readonly actualTSec: number;
          readonly acknowledgedInMs: number;
          readonly gcDurationMs: number;
          readonly treeMiB: number;
          readonly daemonMainMiB: number;
        }[];
        readonly last20MinTreeTheilSenMiBPerMin: number;
        readonly last20MinDaemonMainTheilSenMiBPerMin: number;
      };
      readonly endMiB: number;
      readonly endLimitMiB: number;
    };
    readonly fd: {
      readonly warmup: number;
      readonly end: number;
      readonly endLimit: number;
      readonly series: readonly { readonly tSec: number; readonly count: number }[];
      readonly sustainedPositiveSlope: boolean;
    };
    readonly swap: {
      readonly warmupMiB: number;
      readonly endMiB: number;
      readonly deltaMiB: number;
    };
    readonly eventLoop: { readonly p99Ms: number };
    readonly sessions: {
      readonly warmup: number | null;
      readonly activeEnd: number | null;
      readonly postClose: number | null;
    };
    readonly sockets: {
      readonly warmup: number | null;
      readonly activeEnd: number | null;
      readonly postClose: number | null;
    };
    readonly providerSessionsClosed: boolean | null;
  };
  readonly thresholds: typeof CASE20_THRESHOLDS;
  readonly pass: boolean;
  readonly failures: readonly Case20Failure[];
}

export interface Case20Provenance {
  readonly commit: string;
  readonly tree: string;
  readonly trackedClean: boolean;
  readonly statusSha256: string;
  readonly diffSha256: string;
  readonly untrackedFiles: readonly string[];
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly manifestSha256: string;
  readonly binaries: Readonly<Record<string, string>>;
}

export type Case20ObservedRpcName = "fetch_agents" | "foreign_fetch_agent_denial";
export type Case20ObservedInboundMessageType =
  | "fetch_agents_response"
  | "rpc_error"
  | "agent_stream";
export type Case20ObservedRpcResponseType = Exclude<
  Case20ObservedInboundMessageType,
  "agent_stream"
>;

export const CASE20_RPC_REQUEST_ID_PATTERN = /^case20-rpc-[0-9a-f]{32}$/;

export const CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES = [
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

export type Case20DaemonRpcDiagnosticPhase = (typeof CASE20_DAEMON_RPC_DIAGNOSTIC_PHASES)[number];
export type Case20DaemonRpcDiagnosticRequestType = "fetch_agents_request" | "fetch_agent_request";
export type Case20DaemonRpcDiagnosticResponseType =
  | "fetch_agents_response"
  | "fetch_agent_response"
  | "rpc_error";
export type Case20DaemonRpcDiagnosticFailureCode =
  | "daemon_rpc_diagnostic_invalid"
  | "daemon_rpc_diagnostic_missing"
  | "daemon_rpc_diagnostic_duplicate"
  | "daemon_rpc_diagnostic_out_of_order"
  | "daemon_rpc_diagnostic_overflow";

export type Case20RpcDiagnosticJoinFailureCode =
  | "rpc_diagnostic_join_invalid"
  | "rpc_diagnostic_join_missing"
  | "rpc_diagnostic_join_duplicate"
  | "rpc_diagnostic_join_out_of_order"
  | "rpc_diagnostic_join_overflow";

export interface Case20DaemonRpcDiagnosticPhaseSample {
  readonly phase: Case20DaemonRpcDiagnosticPhase;
  readonly monotonicUnixMs: number;
}

export interface Case20DaemonRpcDiagnostic {
  readonly requestId: string;
  readonly requestType: Case20DaemonRpcDiagnosticRequestType;
  readonly responseType: Case20DaemonRpcDiagnosticResponseType;
  readonly phases: readonly Case20DaemonRpcDiagnosticPhaseSample[];
}

export interface Case20DaemonRpcDiagnosticBatch {
  readonly diagnostics: readonly Case20DaemonRpcDiagnostic[];
  readonly failures: readonly Case20DaemonRpcDiagnosticFailureCode[];
  readonly done: boolean;
}

export type Case20DaemonRuntimeObservationFailureCode =
  | "daemon_runtime_observation_invalid"
  | "daemon_runtime_observation_missing"
  | "daemon_runtime_observation_duplicate"
  | "daemon_runtime_observation_out_of_order"
  | "daemon_runtime_observation_overflow";

export interface Case20DaemonGarbageCollectionSample {
  readonly startMonotonicUnixMs: number;
  readonly durationMs: number;
  readonly kind: number;
  readonly flags: number;
}

export type Case20DaemonRuntimeResourceSampleKind =
  | "resource"
  | "retained_resource"
  | "final_active_sample"
  | "final_drain";

export interface Case20DaemonRuntimeObservationEvent {
  readonly type: "daemon_runtime_observation";
  readonly at: string;
  readonly sequence: number;
  readonly final: boolean;
  readonly resourceSampleKind: Case20DaemonRuntimeResourceSampleKind;
  readonly resourceTSec: number;
  readonly windowStartedMonotonicUnixMs: number;
  readonly windowEndedMonotonicUnixMs: number;
  readonly windowMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly eventLoopIdleMs: number;
  readonly eventLoopActiveMs: number;
  readonly eventLoopUtilization: number;
  readonly garbageCollections: readonly Case20DaemonGarbageCollectionSample[];
}

export interface Case20DaemonRuntimeObservationBatch {
  readonly observation: Case20DaemonRuntimeObservationEvent | null;
  readonly failures: readonly Case20DaemonRuntimeObservationFailureCode[];
  readonly done: boolean;
}

export interface Case20ClientRuntimeMessageMetric {
  readonly messageType: Case20ObservedInboundMessageType;
  readonly count: number;
  readonly bytes: number;
  readonly handlerCount: number;
  readonly handlerTotalMs: number;
  readonly handlerAvgMs: number;
  readonly handlerMaxMs: number;
}

export interface Case20ClientRuntimeMetricsEvent {
  readonly type: "client_runtime_metrics";
  readonly at: string;
  readonly clientId: string;
  readonly windowMs: number;
  readonly rollingWindowMs: number;
  readonly bucketCount: number;
  readonly final: boolean;
  readonly connectionPath: "direct" | "relay";
  readonly connectionStatus: "idle" | "connecting" | "connected" | "disconnected" | "disposed";
  readonly messages: readonly Case20ClientRuntimeMessageMetric[];
}

export interface Case20ClientRpcTraceEvent {
  readonly type: "client_rpc_trace";
  readonly at: string;
  readonly clientId: string;
  readonly sequence: number;
  readonly baseline: boolean;
  readonly name: Case20ObservedRpcName;
  readonly messageType: Case20ObservedRpcResponseType;
  readonly requestId: string;
  readonly rpcStartedMonotonicUnixMs: number;
  readonly messageOutboundBeginMonotonicUnixMs: number;
  readonly messageOutboundEndMonotonicUnixMs: number;
  readonly frameOutboundBeginMonotonicUnixMs: number;
  readonly frameOutboundEndMonotonicUnixMs: number;
  readonly frameBeginMonotonicUnixMs: number;
  readonly frameEndMonotonicUnixMs: number;
  readonly promiseResumedMonotonicUnixMs: number;
  readonly callbackTotalMs: number;
  readonly decodeBeforeParseMs: number;
  readonly jsonParseMs: number;
  readonly aotValidateMs: number;
  readonly dispatchAndWaiterMs: number;
  readonly frameEndToPromiseResumeMs: number;
}

export interface Case20RpcDiagnosticEvent {
  readonly type: "rpc_diagnostic";
  readonly at: string;
  readonly clientId: string;
  readonly sequence: number;
  readonly baseline: boolean;
  readonly name: Case20ObservedRpcName;
  readonly requestId: string;
  readonly requestType: Case20DaemonRpcDiagnosticRequestType;
  readonly responseType: Case20DaemonRpcDiagnosticResponseType;
  readonly client: {
    readonly rpcStartedMonotonicUnixMs: number;
    readonly messageOutboundBeginMonotonicUnixMs: number;
    readonly messageOutboundEndMonotonicUnixMs: number;
    readonly frameOutboundBeginMonotonicUnixMs: number;
    readonly frameOutboundEndMonotonicUnixMs: number;
    readonly frameBeginMonotonicUnixMs: number;
    readonly frameEndMonotonicUnixMs: number;
    readonly promiseResumedMonotonicUnixMs: number;
    readonly callbackTotalMs: number;
    readonly decodeBeforeParseMs: number;
    readonly jsonParseMs: number;
    readonly aotValidateMs: number;
    readonly dispatchAndWaiterMs: number;
    readonly frameEndToPromiseResumeMs: number;
  };
  readonly daemon: {
    readonly phases: readonly Case20DaemonRpcDiagnosticPhaseSample[];
  };
  readonly crossProcessClock: {
    readonly calibrated: false;
    readonly frameOutboundEndToDaemonFrameReceivedMs: number;
    readonly daemonResponseDeliverReturnToClientFrameBeginMs: number;
  };
}

export type Case20RpcDiagnosticRejectionReason =
  | "expected_sequence_mismatch"
  | "client_trace_invalid"
  | "client_trace_out_of_order"
  | "client_expectation_mismatch"
  | "daemon_trace_invalid"
  | "daemon_trace_out_of_order"
  | "request_type_mismatch"
  | "response_type_mismatch"
  | "joined_sequence_mismatch";

export interface Case20RpcDiagnosticRejectedEvent {
  readonly type: "rpc_diagnostic_rejected";
  readonly at: string;
  readonly clientId: string;
  readonly sequence: number;
  readonly expectedSequence: number;
  readonly name: Case20ObservedRpcName;
  readonly requestType: Case20DaemonRpcDiagnosticRequestType;
  readonly responseType: Case20DaemonRpcDiagnosticResponseType;
  readonly reason: Case20RpcDiagnosticRejectionReason;
  readonly boundaries: {
    readonly clientRpcStartedMonotonicUnixMs: number | null;
    readonly clientMessageOutboundBeginMonotonicUnixMs: number | null;
    readonly clientMessageOutboundEndMonotonicUnixMs: number | null;
    readonly clientFrameOutboundBeginMonotonicUnixMs: number | null;
    readonly clientFrameOutboundEndMonotonicUnixMs: number | null;
    readonly clientFrameBeginMonotonicUnixMs: number | null;
    readonly clientFrameEndMonotonicUnixMs: number | null;
    readonly clientPromiseResumedMonotonicUnixMs: number | null;
    readonly daemonFrameReceivedMonotonicUnixMs: number | null;
    readonly daemonResponseDeliverReturnMonotonicUnixMs: number | null;
  };
}

export interface Case20RunnerEventLoopDelayEvent {
  readonly type: "runner_event_loop_delay";
  readonly at: string;
  readonly windowStartedAtMs: number;
  readonly windowEndedAtMs: number;
  readonly intervalMs: number;
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly final: boolean;
}

export type Case20RawEvent =
  | {
      readonly type: "run_started";
      readonly at: string;
      readonly part: "A" | "B";
      readonly mode: Case20Mode;
      readonly runId: string;
      readonly paidProviderUseAcknowledged?: true;
    }
  | {
      readonly type: "client_connected";
      readonly at: string;
      readonly clientId: string;
      readonly principalId: string;
    }
  | {
      readonly type: "stream_coverage_started";
      readonly at: string;
      readonly clients: number;
    }
  | { readonly type: "provenance"; readonly at: string; readonly value: Case20Provenance }
  | {
      readonly type: "client_disconnected";
      readonly at: string;
      readonly clientId: string;
      readonly expected: boolean;
    }
  | {
      readonly type: "rpc";
      readonly at: string;
      readonly clientId: string;
      readonly name: string;
      readonly durationMs: number;
      readonly ok: boolean;
      readonly baseline: boolean;
    }
  | Case20ClientRuntimeMetricsEvent
  | Case20RpcDiagnosticEvent
  | Case20RpcDiagnosticRejectedEvent
  | Case20DaemonRuntimeObservationEvent
  | Case20RunnerEventLoopDelayEvent
  | {
      readonly type: "feedback";
      readonly at: string;
      readonly clientId: string;
      readonly durationMs: number;
      readonly thresholdMs: number;
    }
  | {
      readonly type: "agent_stream_aggregate";
      readonly at: string;
      readonly clientId: string;
      readonly events: number;
      readonly ownedCanaries: number;
      readonly foreignAgentEvents: number;
      readonly foreignCanaries: number;
      readonly timelineEvents: number;
      readonly timelineCanaries: number;
    }
  | {
      readonly type: "process_lifecycle";
      readonly at: string;
      readonly provider: "codex" | "claude";
      readonly event:
        | "root_started"
        | "root_observed"
        | "root_exited"
        | "root_replaced"
        | "new_root_detected"
        | "orphan_detected";
      readonly pid: number;
      readonly identity: string;
    }
  | {
      readonly type: "provider_cleanup";
      readonly at: string;
      readonly observedProcessCount: number;
      readonly aliveProcessCount: number;
      readonly providerSessionsClosed: boolean;
    }
  | {
      readonly type: "provider_probe";
      readonly at: string;
      readonly provider: "codex" | "claude";
      readonly allowedRead: boolean;
      readonly allowedWrite: boolean;
      readonly childCommand: boolean;
      readonly outsideReadDenied: boolean;
      readonly outsideWriteDenied: boolean;
      readonly networkDenied: boolean;
      readonly parentEnvironmentIsolated: boolean;
      readonly shellToolCompleted: boolean;
      readonly toolCalls: number;
    }
  | {
      readonly type: "audit_chain";
      readonly at: string;
      readonly restored: true;
      readonly filesScanned: number;
      readonly auditFiles: number;
    }
  | {
      readonly type: "retained_rss_schedule";
      readonly at: string;
      readonly checkpoints: readonly Case20RetainedRssCheckpointPlan[];
    }
  | {
      readonly type: "retained_resource";
      readonly at: string;
      readonly checkpoint: Case20RetainedRssSample;
    }
  | { readonly type: "resource"; readonly at: string; readonly sample: Case20ResourceSample }
  | ({
      readonly type: "final_active_sample";
      readonly measurementEndedAt: string;
    } & Case20FinalActiveSample)
  | {
      readonly type: "post_close_resource";
      readonly at: string;
      readonly sample: Case20ResourceSample;
    }
  | {
      readonly type: "provider_turn";
      readonly at: string;
      readonly provider: "codex" | "claude";
      readonly durationMs: number;
      readonly ok: boolean;
      readonly baseline: boolean;
    }
  | { readonly type: "failure"; readonly at: string; readonly failure: Case20Failure }
  | { readonly type: "run_finished"; readonly at: string; readonly pass: boolean };
