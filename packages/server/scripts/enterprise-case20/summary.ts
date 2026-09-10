import {
  CASE20_MINIMUM_DURATION_SEC,
  CASE20_PART_A_CLIENT_COUNT,
  CASE20_THRESHOLDS,
  type Case20Failure,
  type Case20ResourceSample,
  type Case20RunMeasurements,
  type Case20Summary,
} from "./model.js";

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
  return percentile(slopes, 0.5);
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

function buildResourceSummary(samples: readonly Case20ResourceSample[]) {
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
    sessions: { warmup: first.sessions, end: last.sessions },
    sockets: { warmup: first.sockets, end: last.sockets },
    providerSessionsClosed: null,
  } as const;
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
  const successRate =
    measurements.counts.requests === 0
      ? 0
      : measurements.counts.succeeded / measurements.counts.requests;
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
  const resourcesBase = buildResourceSummary(measurements.resourceSamples);
  const resources = {
    ...resourcesBase,
    providerSessionsClosed: measurements.providerSessionsClosed ?? null,
  } as const;
  addSamplingFailures(failures, measurements);
  if (resources.rss.last20MinTheilSenMiBPerMin > CASE20_THRESHOLDS.rssSlopeMiBPerMin)
    failures.push(
      failure(
        "rss_slope",
        "resources.rss.last20MinTheilSenMiBPerMin",
        resources.rss.last20MinTheilSenMiBPerMin,
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
  if (resources.swap.deltaMiB > CASE20_THRESHOLDS.swapDeltaMiB)
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
  if (measurements.part === "A" && resources.sessions.end !== CASE20_THRESHOLDS.endSessions)
    failures.push(
      failure(
        "sessions_not_closed",
        "resources.sessions.end",
        String(resources.sessions.end),
        CASE20_THRESHOLDS.endSessions,
        "raw.jsonl",
      ),
    );
  if (measurements.part === "A" && resources.sockets.end !== 0)
    failures.push(
      failure(
        "sockets_not_closed",
        "resources.sockets.end",
        String(resources.sockets.end),
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
    latencyMs: { feedback, rpc, business: { successRate } },
    resources,
    thresholds: CASE20_THRESHOLDS,
    pass: eligible && failures.length === 0,
    failures,
  };
}
