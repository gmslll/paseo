import {
  CASE20_MINIMUM_DURATION_SEC,
  CASE20_PART_A_CLIENT_COUNT,
  CASE20_THRESHOLDS,
  type Case20Failure,
  type Case20RetainedRssCheckpointPlan,
  type Case20RetainedRssSample,
  type Case20ResourceSample,
  type Case20RunMeasurements,
  type Case20Summary,
} from "./model.js";
import { CASE20_GC_ACK_TIMEOUT_MS, case20RetainedRssScheduledSeconds } from "./retained-rss.js";

interface Distribution {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function distribution(values: readonly number[]): Distribution {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const right = Math.floor(sorted.length / 2);
  const rightValue = sorted[right] ?? 0;
  if (sorted.length % 2 === 1) return rightValue;
  return ((sorted[right - 1] ?? 0) + rightValue) / 2;
}

export function theilSenSlopePerMinute(
  samples: readonly { readonly tSec: number; readonly value: number }[],
): number {
  const slopes: number[] = [];
  for (let left = 0; left < samples.length; left += 1) {
    for (let right = left + 1; right < samples.length; right += 1) {
      const elapsedMinutes = (samples[right].tSec - samples[left].tSec) / 60;
      if (elapsedMinutes > 0)
        slopes.push((samples[right].value - samples[left].value) / elapsedMinutes);
    }
  }
  return median(slopes);
}

function failure(
  code: string,
  metric: string,
  observed: number | string,
  threshold: number | string,
  evidenceRef: string,
): Case20Failure {
  return { code, metric, observed, threshold, evidenceRef };
}

function addEqualityFailures(
  failures: Case20Failure[],
  counts: Case20RunMeasurements["counts"],
): void {
  for (const key of [
    "unexpectedDisconnects",
    "crossPrincipalViolations",
    "wrongRouteViolations",
    "writeConflicts",
    "auditErrors",
    "providerCrashes",
    "providerRestarts",
  ] as const) {
    if (counts[key] !== CASE20_THRESHOLDS[key]) {
      failures.push(
        failure("nonzero_safety_counter", `counts.${key}`, counts[key], 0, "raw.jsonl"),
      );
    }
  }
}

function addProvenanceFailures(
  failures: Case20Failure[],
  measurements: Case20RunMeasurements,
): void {
  if (!/^[0-9a-f]{40}$/.test(measurements.provenance.commit))
    failures.push(
      failure(
        "invalid_commit_provenance",
        "provenance.commit",
        measurements.provenance.commit,
        "40 lowercase hexadecimal characters",
        "raw.jsonl",
      ),
    );
  if (!/^[0-9a-f]{40}$/.test(measurements.provenance.tree))
    failures.push(
      failure(
        "invalid_tree_provenance",
        "provenance.tree",
        measurements.provenance.tree,
        "40 lowercase hexadecimal characters",
        "raw.jsonl",
      ),
    );
  if (!measurements.provenance.trackedClean)
    failures.push(
      failure("tracked_worktree_dirty", "provenance.trackedClean", "false", "true", "raw.jsonl"),
    );
  for (const [name, digest] of [
    ["statusSha256", measurements.provenance.statusSha256],
    ["diffSha256", measurements.provenance.diffSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest))
      failures.push(
        failure("invalid_worktree_digest", `provenance.${name}`, digest, "sha256", "raw.jsonl"),
      );
  }
  if (!/^[0-9a-f]{64}$/.test(measurements.provenance.manifestSha256))
    failures.push(
      failure(
        "invalid_manifest_digest",
        "provenance.manifestSha256",
        measurements.provenance.manifestSha256,
        "sha256",
        "raw.jsonl",
      ),
    );
  if (measurements.part !== "B") return;
  for (const provider of ["codex", "claude"] as const) {
    const version = measurements.provenance.binaries[provider];
    if (!version || version === "unavailable")
      failures.push(
        failure(
          "provider_version_unavailable",
          `provenance.binaries.${provider}`,
          version ?? "missing",
          "available",
          "raw.jsonl",
        ),
      );
  }
}

function activeTail(samples: readonly Case20ResourceSample[]): readonly Case20ResourceSample[] {
  const end = samples.at(-1)?.tSec ?? 0;
  return samples.filter((sample) => sample.tSec >= end - 20 * 60);
}

interface RetainedRssSummaryResult {
  readonly valid: boolean;
  readonly summary?: NonNullable<Case20Summary["resources"]["rss"]["retained"]>;
}

interface RetainedRssScheduleValidation {
  readonly valid: boolean;
  readonly plannedDurationSec: number;
}

function isValidRetainedRssScheduleCheckpoint(
  checkpoint: Case20RetainedRssCheckpointPlan | undefined,
  index: number,
  expectedScheduledTSec: number,
  requestIds: ReadonlySet<string>,
): boolean {
  return Boolean(
    checkpoint &&
    checkpoint.index === index &&
    checkpoint.scheduledTSec === expectedScheduledTSec &&
    typeof checkpoint.requestId === "string" &&
    checkpoint.requestId.length > 0 &&
    !requestIds.has(checkpoint.requestId),
  );
}

function validateRetainedRssSchedule(
  schedule: NonNullable<Case20RunMeasurements["retainedRssSchedule"]>,
  durationSec: number,
  required: boolean,
  failures: Case20Failure[],
): RetainedRssScheduleValidation {
  let valid = true;
  const plannedDurationSec = schedule.at(-1)?.scheduledTSec;
  const minimumDurationSec = required ? CASE20_MINIMUM_DURATION_SEC : 1;
  const durationValid =
    typeof plannedDurationSec === "number" &&
    Number.isInteger(plannedDurationSec) &&
    plannedDurationSec >= minimumDurationSec &&
    plannedDurationSec <= durationSec;
  if (!durationValid) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_schedule_invalid",
        "resources.rss.retained.schedule.durationSec",
        plannedDurationSec ?? "missing",
        `${minimumDurationSec}..${durationSec}`,
        "raw.jsonl",
      ),
    );
  }
  const expectedSeconds = durationValid
    ? case20RetainedRssScheduledSeconds(plannedDurationSec)
    : [];
  if (schedule.length !== expectedSeconds.length) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_schedule_invalid",
        "resources.rss.retained.schedule.length",
        schedule.length,
        expectedSeconds.length,
        "raw.jsonl",
      ),
    );
  }
  const requestIds = new Set<string>();
  for (const [index, expectedScheduledTSec] of expectedSeconds.entries()) {
    const checkpoint = schedule[index];
    if (
      !isValidRetainedRssScheduleCheckpoint(checkpoint, index, expectedScheduledTSec, requestIds)
    ) {
      valid = false;
      failures.push(
        failure(
          "retained_rss_schedule_invalid",
          `resources.rss.retained.schedule.${index}`,
          checkpoint
            ? `${checkpoint.index}:${checkpoint.scheduledTSec}:${checkpoint.requestId.length}`
            : "missing",
          `${index}:${expectedScheduledTSec}:unique requestId`,
          "raw.jsonl",
        ),
      );
    }
    if (typeof checkpoint?.requestId === "string" && checkpoint.requestId)
      requestIds.add(checkpoint.requestId);
  }
  return {
    valid,
    plannedDurationSec: durationValid ? plannedDurationSec : 0,
  };
}

function isConsistentRetainedRssOsSample(
  sample: Case20RetainedRssSample,
  main: Case20ResourceSample["processes"][number] | undefined,
): boolean {
  return (
    sample.sample.tSec === sample.actualTSec &&
    Number.isFinite(sample.treeRssMiB) &&
    sample.treeRssMiB >= 0 &&
    Number.isFinite(sample.daemonMainRssMiB) &&
    sample.daemonMainRssMiB >= 0 &&
    typeof sample.daemonMainIdentity === "string" &&
    sample.daemonMainIdentity.length > 0 &&
    sample.sample.rssMiB === sample.treeRssMiB &&
    Boolean(main) &&
    main?.rssMiB === sample.daemonMainRssMiB
  );
}

function validateRetainedRssSample(input: {
  readonly sample: Case20RetainedRssSample;
  readonly index: number;
  readonly previousActualTSec: number;
  readonly daemonMainIdentity: string;
  readonly failures: Case20Failure[];
}): boolean {
  const { sample, index, failures } = input;
  let valid = true;
  if (!Number.isFinite(sample.actualTSec) || sample.actualTSec <= input.previousActualTSec) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_actual_time_not_monotonic",
        `resources.rss.retained.samples.${index}.actualTSec`,
        sample.actualTSec,
        `>${input.previousActualTSec}`,
        "raw.jsonl",
      ),
    );
  }
  if (
    !Number.isFinite(sample.acknowledgedInMs) ||
    sample.acknowledgedInMs < 0 ||
    sample.acknowledgedInMs > CASE20_GC_ACK_TIMEOUT_MS
  ) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_ack_timeout",
        `resources.rss.retained.samples.${index}.acknowledgedInMs`,
        sample.acknowledgedInMs,
        `0..${CASE20_GC_ACK_TIMEOUT_MS}`,
        "raw.jsonl",
      ),
    );
  }
  if (
    !Number.isFinite(sample.gcDurationMs) ||
    sample.gcDurationMs < 0 ||
    sample.gcDurationMs > sample.acknowledgedInMs
  ) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_gc_duration_invalid",
        `resources.rss.retained.samples.${index}.gcDurationMs`,
        sample.gcDurationMs,
        `0..${sample.acknowledgedInMs}`,
        "raw.jsonl",
      ),
    );
  }
  const main = sample.sample.processes.find(
    (process) => process.identity === sample.daemonMainIdentity,
  );
  if (!isConsistentRetainedRssOsSample(sample, main)) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_sample_invalid",
        `resources.rss.retained.samples.${index}.sample`,
        "inconsistent",
        "OS sample matches retained metadata",
        "raw.jsonl",
      ),
    );
  }
  if (sample.daemonMainIdentity !== input.daemonMainIdentity) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_main_identity_changed",
        `resources.rss.retained.samples.${index}.daemonMainIdentity`,
        sample.daemonMainIdentity,
        input.daemonMainIdentity,
        "raw.jsonl",
      ),
    );
  }
  if (sample.sample.sessions !== CASE20_PART_A_CLIENT_COUNT) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_active_sessions_invalid",
        `resources.rss.retained.samples.${index}.sessions`,
        String(sample.sample.sessions),
        CASE20_PART_A_CLIENT_COUNT,
        "raw.jsonl",
      ),
    );
  }
  if (sample.sample.sockets !== CASE20_PART_A_CLIENT_COUNT) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_active_sockets_invalid",
        `resources.rss.retained.samples.${index}.sockets`,
        String(sample.sample.sockets),
        CASE20_PART_A_CLIENT_COUNT,
        "raw.jsonl",
      ),
    );
  }
  return valid;
}

function validateRetainedRssSamples(
  schedule: NonNullable<Case20RunMeasurements["retainedRssSchedule"]>,
  samples: NonNullable<Case20RunMeasurements["retainedRssSamples"]>,
  failures: Case20Failure[],
): boolean {
  let valid = true;
  if (samples.length !== schedule.length) {
    valid = false;
    failures.push(
      failure(
        "retained_rss_checkpoint_count",
        "resources.rss.retained.samples.length",
        samples.length,
        schedule.length,
        "raw.jsonl",
      ),
    );
  }
  let previousActualTSec = Number.NEGATIVE_INFINITY;
  let daemonMainIdentity: string | null = null;
  for (const [index, checkpoint] of schedule.entries()) {
    const sample = samples[index];
    if (
      !sample ||
      sample.index !== checkpoint.index ||
      sample.requestId !== checkpoint.requestId ||
      sample.scheduledTSec !== checkpoint.scheduledTSec
    ) {
      valid = false;
      failures.push(
        failure(
          "retained_rss_checkpoint_mismatch",
          `resources.rss.retained.samples.${index}`,
          sample ? `${sample.index}:${sample.scheduledTSec}:${sample.requestId}` : "missing",
          `${checkpoint.index}:${checkpoint.scheduledTSec}:${checkpoint.requestId}`,
          "raw.jsonl",
        ),
      );
      continue;
    }
    daemonMainIdentity ??= sample.daemonMainIdentity;
    valid =
      validateRetainedRssSample({
        sample,
        index,
        previousActualTSec,
        daemonMainIdentity,
        failures,
      }) && valid;
    previousActualTSec = sample.actualTSec;
  }
  return valid;
}

function buildRetainedRssSummary(
  measurements: Case20RunMeasurements,
  failures: Case20Failure[],
): RetainedRssSummaryResult {
  const schedule = measurements.retainedRssSchedule;
  const samples = measurements.retainedRssSamples;
  const required = measurements.part === "A" && measurements.mode === "formal";
  if (!schedule || !samples) {
    if (required && !schedule)
      failures.push(
        failure(
          "retained_rss_schedule_missing",
          "resources.rss.retained.schedule",
          "missing",
          "fixed before measurement",
          "raw.jsonl",
        ),
      );
    if (required && !samples)
      failures.push(
        failure(
          "retained_rss_samples_missing",
          "resources.rss.retained.samples",
          "missing",
          "complete fixed schedule",
          "raw.jsonl",
        ),
      );
    return { valid: false };
  }

  const scheduleValidation = validateRetainedRssSchedule(
    schedule,
    measurements.durationSec,
    required,
    failures,
  );
  const samplesValid = validateRetainedRssSamples(schedule, samples, failures);

  const finalTwentyStart = Math.max(0, scheduleValidation.plannedDurationSec - 20 * 60);
  const finalTwenty = samples.filter((sample) => sample.scheduledTSec >= finalTwentyStart);
  const summary = {
    series: samples.map((sample) => ({
      index: sample.index,
      requestId: sample.requestId,
      scheduledTSec: sample.scheduledTSec,
      actualTSec: sample.actualTSec,
      acknowledgedInMs: sample.acknowledgedInMs,
      gcDurationMs: sample.gcDurationMs,
      treeMiB: sample.treeRssMiB,
      daemonMainMiB: sample.daemonMainRssMiB,
    })),
    last20MinTreeTheilSenMiBPerMin: theilSenSlopePerMinute(
      finalTwenty.map((sample) => ({ tSec: sample.scheduledTSec, value: sample.treeRssMiB })),
    ),
    last20MinDaemonMainTheilSenMiBPerMin: theilSenSlopePerMinute(
      finalTwenty.map((sample) => ({
        tSec: sample.scheduledTSec,
        value: sample.daemonMainRssMiB,
      })),
    ),
  };
  return { valid: scheduleValidation.valid && samplesValid, summary };
}

function buildResourceSummary(
  samples: readonly Case20ResourceSample[],
  postClose: Case20ResourceSample | undefined,
  retained: RetainedRssSummaryResult["summary"],
) {
  const first = samples[0] ?? {
    tSec: 0,
    rssMiB: 0,
    fdCount: 0,
    swapMiB: 0,
    eventLoopP99Ms: 0,
    sessions: null,
    sockets: null,
    processes: [],
  };
  const last = samples.at(-1) ?? first;
  const tail = activeTail(samples);
  const rssSlope = theilSenSlopePerMinute(
    tail.map((sample) => ({ tSec: sample.tSec, value: sample.rssMiB })),
  );
  const fdSlope = theilSenSlopePerMinute(
    tail.map((sample) => ({ tSec: sample.tSec, value: sample.fdCount })),
  );
  return {
    rss: {
      warmupMiB: first.rssMiB,
      series: samples.map((sample) => ({ tSec: sample.tSec, MiB: sample.rssMiB })),
      last20MinTheilSenMiBPerMin: rssSlope,
      rawLast20MinTheilSenMiBPerMin: rssSlope,
      ...(retained ? { retained } : {}),
      endMiB: last.rssMiB,
      endLimitMiB: first.rssMiB + CASE20_THRESHOLDS.rssEndDeltaMiB,
    },
    fd: {
      warmup: first.fdCount,
      end: last.fdCount,
      endLimit: first.fdCount + CASE20_THRESHOLDS.fdEndDelta,
      series: samples.map((sample) => ({ tSec: sample.tSec, count: sample.fdCount })),
      sustainedPositiveSlope: fdSlope > 0,
    },
    swap: {
      warmupMiB: first.swapMiB,
      endMiB: last.swapMiB,
      deltaMiB: last.swapMiB - first.swapMiB,
    },
    eventLoop: {
      p99Ms: samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.eventLoopP99Ms)),
    },
    sessions: {
      warmup: first.sessions,
      activeEnd: last.sessions,
      postClose: postClose?.sessions ?? null,
    },
    sockets: {
      warmup: first.sockets,
      activeEnd: last.sockets,
      postClose: postClose?.sockets ?? null,
    },
    providerSessionsClosed: null,
  } as const;
}

function addMeasurementBoundaryFailures(
  failures: Case20Failure[],
  measurements: Case20RunMeasurements,
): void {
  const startedAtMs = Date.parse(measurements.startedAt);
  const measurementEndedAtMs = Date.parse(measurements.measurementEndedAt);
  const measuredDurationSec = (measurementEndedAtMs - startedAtMs) / 1_000;
  if (
    !Number.isFinite(measuredDurationSec) ||
    Math.abs(measuredDurationSec - measurements.durationSec) > 0.001
  ) {
    failures.push(
      failure(
        "measurement_duration_mismatch",
        "measurementEndedAt",
        Number.isFinite(measuredDurationSec) ? measuredDurationSec : "invalid timestamp",
        measurements.durationSec,
        "raw.jsonl",
      ),
    );
  }
  if (measurements.endedAt !== measurements.measurementEndedAt) {
    failures.push(
      failure(
        "measurement_end_mismatch",
        "endedAt",
        measurements.endedAt,
        measurements.measurementEndedAt,
        "summary.json",
      ),
    );
  }
  const finalActive = measurements.finalActiveSample;
  const lastActive = measurements.resourceSamples.at(-1);
  if (!finalActive || !lastActive) {
    failures.push(
      failure(
        "final_active_sample_missing",
        "finalActiveSample",
        "missing",
        "captured before teardown",
        "raw.jsonl",
      ),
    );
  } else {
    if (finalActive.at !== measurements.measurementEndedAt)
      failures.push(
        failure(
          "final_active_sample_time_mismatch",
          "finalActiveSample.at",
          finalActive.at,
          measurements.measurementEndedAt,
          "raw.jsonl",
        ),
      );
    if (JSON.stringify(finalActive.sample) !== JSON.stringify(lastActive))
      failures.push(
        failure(
          "final_active_sample_not_last",
          "finalActiveSample.sample",
          finalActive.sample.tSec,
          lastActive.tSec,
          "raw.jsonl",
        ),
      );
  }
  if (measurements.part !== "A") return;
  const coverageStartedAtMs = Date.parse(measurements.streamCoverageStartedAt ?? "");
  if (!Number.isFinite(coverageStartedAtMs) || coverageStartedAtMs > startedAtMs)
    failures.push(
      failure(
        "stream_setup_coverage_missing",
        "streamCoverageStartedAt",
        measurements.streamCoverageStartedAt ?? "missing",
        `<=${measurements.startedAt}`,
        "raw.jsonl",
      ),
    );
  const expected = new Map(
    measurements.clients.map((client) => [client.id, client.principalId] as const),
  );
  const activities = finalActive?.principalStreams ?? [];
  const observed = new Map(activities.map((activity) => [activity.clientId, activity] as const));
  const everyPrincipalActive =
    activities.length === expected.size &&
    observed.size === expected.size &&
    [...expected].every(([clientId, principalId]) => {
      const activity = observed.get(clientId);
      return (
        activity?.principalId === principalId &&
        activity.ownedCanaries > 0 &&
        activity.timelineCanaries > 0
      );
    });
  if (!everyPrincipalActive)
    failures.push(
      failure(
        "final_principal_stream_activity_missing",
        "finalActiveSample.principalStreams",
        activities.filter((activity) => activity.ownedCanaries > 0 && activity.timelineCanaries > 0)
          .length,
        expected.size,
        "raw.jsonl",
      ),
    );
}

function businessSuccessRate(
  failures: Case20Failure[],
  counts: Case20RunMeasurements["counts"],
): number {
  const outcomes = counts.succeeded + counts.failed;
  if (outcomes !== counts.requests)
    failures.push(
      failure(
        "request_outcome_mismatch",
        "counts.succeeded+counts.failed",
        outcomes,
        counts.requests,
        "raw.jsonl",
      ),
    );
  const rawRate = counts.requests === 0 ? 0 : counts.succeeded / counts.requests;
  if (!Number.isFinite(rawRate) || rawRate < 0 || rawRate > 1)
    failures.push(
      failure(
        "invalid_business_success_rate",
        "latencyMs.business.successRate",
        Number.isFinite(rawRate) ? rawRate : "non-finite",
        "0..1",
        "raw.jsonl",
      ),
    );
  return Math.min(1, Math.max(0, Number.isFinite(rawRate) ? rawRate : 0));
}

function addSamplingFailures(failures: Case20Failure[], measurements: Case20RunMeasurements): void {
  const samples = measurements.resourceSamples;
  if (samples.length < 2) {
    failures.push(
      failure("missing_resource_samples", "resources.samples", samples.length, ">=2", "raw.jsonl"),
    );
    return;
  }
  if (measurements.durationSec < CASE20_MINIMUM_DURATION_SEC) return;
  const maximumGapSec = Math.max(1, measurements.sampleIntervalMs / 1_000) * 2;
  const gaps = samples.slice(1).map((sample, index) => sample.tSec - samples[index].tSec);
  const largestGapSec = Math.max(...gaps);
  if (largestGapSec > maximumGapSec) {
    failures.push(
      failure(
        "resource_sample_gap",
        "resources.maximumGapSec",
        largestGapSec,
        maximumGapSec,
        "raw.jsonl",
      ),
    );
  }
  const tailStart = Math.max(0, measurements.durationSec - 20 * 60);
  const finalTwenty = samples.filter((sample) => sample.tSec >= tailStart);
  const requiredTailSamples = Math.floor((20 * 60 * 1_000) / measurements.sampleIntervalMs) - 1;
  if (finalTwenty.length < requiredTailSamples) {
    failures.push(
      failure(
        "final_20m_coverage",
        "resources.final20mSamples",
        finalTwenty.length,
        requiredTailSamples,
        "raw.jsonl",
      ),
    );
  }
  const last = samples.at(-1);
  if (!last || measurements.durationSec - last.tSec > maximumGapSec) {
    failures.push(
      failure(
        "final_resource_sample_missing",
        "resources.finalSampleAgeSec",
        last ? measurements.durationSec - last.tSec : "missing",
        maximumGapSec,
        "raw.jsonl",
      ),
    );
  }
}

// oxlint-disable-next-line complexity -- the summary reports every independent release threshold.
export function buildCase20Summary(measurements: Case20RunMeasurements): Case20Summary {
  const failures: Case20Failure[] = [...(measurements.evidenceFailures ?? [])];
  const eligible = measurements.mode === "formal";
  if (!eligible) {
    failures.push(failure("smoke_ineligible", "mode", measurements.mode, "formal", "summary.json"));
  }
  if (measurements.durationSec < CASE20_MINIMUM_DURATION_SEC) {
    failures.push(
      failure(
        "insufficient_duration",
        "durationSec",
        measurements.durationSec,
        CASE20_MINIMUM_DURATION_SEC,
        "summary.json",
      ),
    );
  }
  if (measurements.part === "A" && measurements.clients.length !== CASE20_PART_A_CLIENT_COUNT) {
    failures.push(
      failure(
        "invalid_client_count",
        "clients.length",
        measurements.clients.length,
        CASE20_PART_A_CLIENT_COUNT,
        "summary.json",
      ),
    );
  }
  if (measurements.part === "B") {
    const providers = new Set(measurements.clients.map((client) => client.provider));
    if (!providers.has("codex") || !providers.has("claude")) {
      failures.push(
        failure(
          "missing_provider",
          "clients.provider",
          [...providers].sort().join(","),
          "claude,codex",
          "summary.json",
        ),
      );
    }
    if (measurements.paidProviderUseAcknowledged !== true)
      failures.push(
        failure(
          "paid_provider_use_not_acknowledged",
          "paidProviderUseAcknowledged",
          "missing",
          "true",
          "summary.json",
        ),
      );
  }
  addProvenanceFailures(failures, measurements);
  addEqualityFailures(failures, measurements.counts);
  addMeasurementBoundaryFailures(failures, measurements);
  const successRate = businessSuccessRate(failures, measurements.counts);
  if (successRate < CASE20_THRESHOLDS.businessSuccessRate) {
    failures.push(
      failure(
        "business_success_rate",
        "latencyMs.business.successRate",
        successRate,
        CASE20_THRESHOLDS.businessSuccessRate,
        "raw.jsonl",
      ),
    );
  }
  const feedback =
    measurements.part === "B"
      ? ({ status: "not_applicable" } as const)
      : distribution(measurements.feedbackLatencyMs);
  if (
    measurements.part === "A" &&
    measurements.feedbackLatencyMs.length < CASE20_PART_A_CLIENT_COUNT
  ) {
    failures.push(
      failure(
        "insufficient_feedback_samples",
        "latencyMs.feedback.count",
        measurements.feedbackLatencyMs.length,
        CASE20_PART_A_CLIENT_COUNT,
        "raw.jsonl",
      ),
    );
  }
  if (
    measurements.part === "A" &&
    "p95" in feedback &&
    feedback.p95 > CASE20_THRESHOLDS.feedbackP95Ms
  ) {
    failures.push(
      failure(
        "feedback_latency",
        "latencyMs.feedback.p95",
        feedback.p95,
        CASE20_THRESHOLDS.feedbackP95Ms,
        "raw.jsonl",
      ),
    );
  }
  const rpc: Record<
    string,
    {
      count: number;
      p50: number;
      p95: number;
      p99: number;
      baselineP95: number;
      ratioToBaseline: number;
    }
  > = {};
  const requiredRpcNames =
    measurements.part === "A"
      ? ["fetch_agents", "foreign_fetch_agent_denial"]
      : ["codex.turn", "claude.turn"];
  for (const name of requiredRpcNames) {
    const baselineCount = measurements.rpcBaselineLatencyMs[name]?.length ?? 0;
    const loadedCount = measurements.rpcLatencyMs[name]?.length ?? 0;
    if (baselineCount < 3) {
      failures.push(
        failure(
          "insufficient_rpc_baseline",
          `latencyMs.rpc.${name}.baselineCount`,
          baselineCount,
          3,
          "raw.jsonl",
        ),
      );
    }
    if (baselineCount > 10) {
      failures.push(
        failure(
          "unbounded_rpc_baseline",
          `latencyMs.rpc.${name}.baselineCount`,
          baselineCount,
          "<=10",
          "raw.jsonl",
        ),
      );
    }
    const minimumLoaded = measurements.mode === "formal" ? 10 : 1;
    if (loadedCount < minimumLoaded) {
      failures.push(
        failure(
          "insufficient_rpc_samples",
          `latencyMs.rpc.${name}.count`,
          loadedCount,
          minimumLoaded,
          "raw.jsonl",
        ),
      );
    }
  }
  for (const [name, values] of Object.entries(measurements.rpcLatencyMs)) {
    const current = distribution(values);
    const baselineP95 = distribution(measurements.rpcBaselineLatencyMs[name] ?? []).p95;
    const ratioToBaseline = baselineP95 > 0 ? current.p95 / baselineP95 : Number.POSITIVE_INFINITY;
    rpc[name] = {
      count: values.length,
      p50: current.p50,
      p95: current.p95,
      p99: current.p99,
      baselineP95,
      ratioToBaseline,
    };
    if (!Number.isFinite(ratioToBaseline) || ratioToBaseline > CASE20_THRESHOLDS.rpcP95Ratio) {
      failures.push(
        failure(
          "rpc_latency_ratio",
          `latencyMs.rpc.${name}.ratioToBaseline`,
          ratioToBaseline,
          CASE20_THRESHOLDS.rpcP95Ratio,
          "raw.jsonl",
        ),
      );
    }
  }
  const retainedRss = buildRetainedRssSummary(measurements, failures);
  const resourcesBase = buildResourceSummary(
    measurements.resourceSamples,
    measurements.postCloseResourceSample,
    retainedRss.summary,
  );
  const resources = {
    ...resourcesBase,
    providerSessionsClosed: measurements.providerSessionsClosed ?? null,
  } as const;
  addSamplingFailures(failures, measurements);
  let gatedRssSlope: number | undefined;
  if (measurements.part === "A") {
    if (retainedRss.valid) gatedRssSlope = retainedRss.summary?.last20MinTreeTheilSenMiBPerMin;
  } else {
    gatedRssSlope = resources.rss.rawLast20MinTheilSenMiBPerMin;
  }
  if (gatedRssSlope !== undefined && gatedRssSlope > CASE20_THRESHOLDS.rssSlopeMiBPerMin)
    failures.push(
      failure(
        "rss_slope",
        measurements.part === "A"
          ? "resources.rss.retained.last20MinTreeTheilSenMiBPerMin"
          : "resources.rss.rawLast20MinTheilSenMiBPerMin",
        gatedRssSlope,
        CASE20_THRESHOLDS.rssSlopeMiBPerMin,
        "raw.jsonl",
      ),
    );
  if (resources.rss.endMiB > resources.rss.endLimitMiB)
    failures.push(
      failure(
        "rss_end",
        "resources.rss.endMiB",
        resources.rss.endMiB,
        resources.rss.endLimitMiB,
        "raw.jsonl",
      ),
    );
  if (resources.fd.end > resources.fd.endLimit)
    failures.push(
      failure("fd_end", "resources.fd.end", resources.fd.end, resources.fd.endLimit, "raw.jsonl"),
    );
  if (resources.fd.sustainedPositiveSlope)
    failures.push(
      failure("fd_slope", "resources.fd.sustainedPositiveSlope", "true", "false", "raw.jsonl"),
    );
  if (resources.swap.deltaMiB !== CASE20_THRESHOLDS.swapDeltaMiB)
    failures.push(
      failure(
        "swap_growth",
        "resources.swap.deltaMiB",
        resources.swap.deltaMiB,
        CASE20_THRESHOLDS.swapDeltaMiB,
        "raw.jsonl",
      ),
    );
  if (resources.eventLoop.p99Ms > CASE20_THRESHOLDS.eventLoopP99Ms)
    failures.push(
      failure(
        "event_loop_delay",
        "resources.eventLoop.p99Ms",
        resources.eventLoop.p99Ms,
        CASE20_THRESHOLDS.eventLoopP99Ms,
        "raw.jsonl",
      ),
    );
  if (measurements.part === "A" && resources.sessions.postClose !== CASE20_THRESHOLDS.endSessions)
    failures.push(
      failure(
        "sessions_not_closed",
        "resources.sessions.postClose",
        String(resources.sessions.postClose),
        CASE20_THRESHOLDS.endSessions,
        "raw.jsonl",
      ),
    );
  if (measurements.part === "A" && resources.sockets.postClose !== 0)
    failures.push(
      failure(
        "sockets_not_closed",
        "resources.sockets.postClose",
        String(resources.sockets.postClose),
        0,
        "raw.jsonl",
      ),
    );
  if (measurements.part === "B" && resources.providerSessionsClosed !== true)
    failures.push(
      failure(
        "provider_sessions_not_closed",
        "resources.providerSessionsClosed",
        String(resources.providerSessionsClosed),
        "true",
        "raw.jsonl",
      ),
    );
  return {
    schemaVersion: 1,
    runId: measurements.runId,
    startedAt: measurements.startedAt,
    endedAt: measurements.endedAt,
    measurementEndedAt: measurements.measurementEndedAt,
    durationSec: measurements.durationSec,
    part: measurements.part,
    mode: measurements.mode,
    eligible,
    ...(measurements.paidProviderUseAcknowledged === true
      ? { paidProviderUseAcknowledged: true as const }
      : {}),
    provenance: measurements.provenance,
    clients: measurements.clients,
    counts: measurements.counts,
    ...(measurements.finalActiveSample
      ? { finalActiveSample: measurements.finalActiveSample }
      : {}),
    ...(measurements.postCloseResourceSample
      ? { postCloseResourceSample: measurements.postCloseResourceSample }
      : {}),
    ...(measurements.streamCoverageStartedAt
      ? { streamCoverageStartedAt: measurements.streamCoverageStartedAt }
      : {}),
    latencyMs: { feedback, rpc, business: { successRate } },
    resources,
    thresholds: CASE20_THRESHOLDS,
    pass: eligible && failures.length === 0,
    failures,
  };
}
