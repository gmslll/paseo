import { performance } from "node:perf_hooks";

import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient, type ConnectionState } from "@getpaseo/client/internal/daemon-client";

import { createCase20ArtifactWriter, type Case20ArtifactWriter } from "./artifact.js";
import { parseCase20CliArguments, readPrivateManifest } from "./manifest.js";
import {
  assertCase20MetricsPreflight,
  countDaemonAuditErrors,
  sampleDaemonResources,
} from "./metrics.js";
import {
  type Case20ClientRecord,
  type Case20Counts,
  type Case20Failure,
  type Case20FinalActiveSample,
  type Case20RetainedRssCheckpointPlan,
  type Case20RetainedRssSample,
  type Case20ResourceSample,
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

interface ConnectedClient {
  readonly config: Case20PartAClientFixture;
  readonly client: PaseoApi;
  readonly daemonClient: DaemonClient;
  readonly releaseTimeline: () => void;
  readonly releaseConnection: () => void;
  readonly lifecycle: ConnectionLifecycle;
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
  canarySequence: number;
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
): Promise<ConnectedClient> {
  const daemonClient = new DaemonClient({
    url: fixture.daemonUrl,
    clientId: config.clientId,
    clientType: "cli",
    password: config.personalAccessToken,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
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

async function measureAgentList(
  connected: ConnectedClient,
  state: PartAMeasurementState,
  baseline: boolean,
): Promise<readonly string[]> {
  const started = performance.now();
  let ok = false;
  try {
    const response = await connected.client.agents.list({ page: { limit: 200 } });
    ok = true;
    return response.entries.map((entry) => entry.agent.id);
  } finally {
    await recordRpc({
      state,
      clientId: connected.config.clientId,
      name: "fetch_agents",
      durationMs: performance.now() - started,
      ok,
      baseline,
    });
  }
}

async function measureWrongRoute(
  connected: ConnectedClient,
  foreignAgentId: string,
  state: PartAMeasurementState,
  baseline: boolean,
): Promise<boolean> {
  const started = performance.now();
  let denied = false;
  try {
    denied = (await connected.client.agents.ref(foreignAgentId).refresh()) === null;
  } catch (error) {
    denied = isCase20AccessDenial(error);
  } finally {
    await recordRpc({
      state,
      clientId: connected.config.clientId,
      name: "foreign_fetch_agent_denial",
      durationMs: performance.now() - started,
      ok: denied,
      baseline,
    });
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
      sample: (tSec) =>
        sampleDaemonResources({
          daemonPid: fixture.daemonPid,
          daemonLogPath: fixture.daemonLogPath,
          tSec,
        }),
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
  const deadline = input.startedAtMs + input.manifest.durationSec * 1_000;
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
  const state: PartAMeasurementState = {
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
      await waitForInitialMetrics(fixture);
      if (fixture.clients.length < 2) throw new Error("Case20 Part A fixture is incomplete");
      for (const config of fixture.clients)
        clients.push(await connectClient(fixture, config, state));
      await runBaseline(clients, state);
      for (const client of clients) {
        await artifact.append({
          type: "client_connected",
          at: client.connectedAt,
          clientId: client.config.clientId,
          principalId: client.config.principalId,
        });
      }
      streamCoverageStartedAt = new Date();
      await artifact.append(
        {
          type: "stream_coverage_started",
          at: streamCoverageStartedAt.toISOString(),
          clients: clients.length,
        },
        { durable: true },
      );
      await startConversations(clients, state);
      measurementStartedAt = new Date();
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
