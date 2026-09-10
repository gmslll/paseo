import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { promisify } from "node:util";

import pino from "pino";

import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  ToolCallTimelineItem,
} from "../../src/server/agent/agent-sdk-types.js";
import { createCase20ArtifactWriter, type Case20ArtifactWriter } from "./artifact.js";
import { parseCase20CliArguments, readPrivateManifest } from "./manifest.js";
import { assertCase20MetricsPreflight, sampleRunnerProcessTree } from "./metrics.js";
import {
  type Case20ClientRecord,
  type Case20Counts,
  type Case20Failure,
  type Case20ResourceSample,
  PartBManifestSchema,
  type PartBManifest,
} from "./model.js";
import {
  assertCase20PartBProviderPreflight,
  type Case20Provider as Provider,
} from "./provider-preflight.js";
import { createCase20Provenance } from "./provenance.js";
import {
  canRunCase20Provider,
  createCase20ProviderEnvironment,
  installCase20ProviderParentEnvironment,
  type Case20ProviderEnvironment,
} from "./real-providers.js";
import { assertFileContainsNoSecrets } from "./secret-scan.js";
import { buildCase20Summary } from "./summary.js";

const executeFile = promisify(execFile);
const RESOURCE_SAMPLE_INTERVAL_MS = 10_000;
const BASELINE_TURNS_PER_PROVIDER = 3;
const PARENT_SECRET_SENTINEL_KEY = "PASEO_CASE20_PARENT_SECRET_SENTINEL";

export interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
  readonly identity: string;
}

interface ProviderRun {
  readonly provider: Provider;
  readonly client: AgentClient;
  readonly environment: Case20ProviderEnvironment;
  readonly knownSecrets: readonly string[];
  readonly session: AgentSession;
  readonly connectedAt: string;
  persistenceId: string | null;
  readonly workspace: string;
  readonly logPath: string;
  readonly destination: ReturnType<typeof pino.destination>;
  readonly processBaseline: ReadonlyMap<number, string>;
  rootProcess: ProcessRow | null;
  readonly observedProcesses: Map<number, string>;
}

interface PartBState {
  readonly artifact: Case20ArtifactWriter;
  readonly counts: Case20Counts;
  readonly rpcLatencyMs: Record<string, number[]>;
  readonly rpcBaselineLatencyMs: Record<string, number[]>;
  readonly resourceSamples: Case20ResourceSample[];
  readonly evidenceFailures: Case20Failure[];
  readonly runnerBaseline: ReadonlyMap<number, string>;
  readonly providerRuns: ProviderRun[];
  readonly processFailures: Set<string>;
  fatalProcessFailure: Error | null;
}

export interface ProbeResult {
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

export function isCompleteCase20ProviderProbe(probe: ProbeResult): boolean {
  return (
    probe.allowedRead &&
    probe.allowedWrite &&
    probe.childCommand &&
    probe.outsideReadDenied &&
    probe.outsideWriteDenied &&
    probe.networkDenied &&
    probe.parentEnvironmentIsolated &&
    probe.shellToolCompleted &&
    probe.toolCalls > 0
  );
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

async function recordFailure(state: PartBState, failure: Case20Failure): Promise<void> {
  state.evidenceFailures.push(failure);
  await state.artifact.append(
    { type: "failure", at: new Date().toISOString(), failure },
    { durable: true },
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertNoFatalProcessFailure(state: PartBState): void {
  if (state.fatalProcessFailure) throw state.fatalProcessFailure;
}

async function sleepWhileHealthy(state: PartBState, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    assertNoFatalProcessFailure(state);
    await sleep(Math.min(500, deadline - Date.now()));
  }
  assertNoFatalProcessFailure(state);
}

function persistenceId(session: AgentSession): string {
  const handle = session.describePersistence();
  const id = handle?.nativeHandle ?? handle?.sessionId ?? session.id;
  if (!id) throw new Error("Case20 provider did not expose a persistent session identity");
  return id;
}

function providerLogger(destination: ReturnType<typeof pino.destination>) {
  return pino(
    {
      level: "debug",
      redact: {
        paths: [
          "*.token",
          "*.password",
          "*.authorization",
          "*.credential",
          "*.secret",
          "*.apiKey",
          "*.env",
          "env",
          "headers",
          "req.headers",
          "runtimeSettings.env",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}

export function case20ProviderOptions(
  provider: Provider,
  workspace: string,
): AgentSessionConfig["providerOptions"] {
  if (provider === "codex") {
    return {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: [workspace],
        network_access: false,
        exclude_slash_tmp: true,
        exclude_tmpdir_env_var: true,
      },
      web_search: "disabled",
    };
  }
  return {
    disallowedTools: ["WebFetch", "WebSearch"],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: [],
        deniedDomains: ["*"],
        strictAllowlist: true,
        allowManagedDomainsOnly: true,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      filesystem: {
        allowRead: [workspace],
        allowWrite: [workspace],
        allowManagedReadPathsOnly: true,
      },
    },
    settings: { permissions: { deny: ["WebFetch(*)", "WebSearch(*)"] } },
  };
}

export function parseCase20ProcessRows(output: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const command = match[4];
    if (/(?:^|\/)(?:ps|lsof|sysctl)$/.test(command)) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command,
      identity: createHash("sha256").update(`${match[1]}\0${match[3]}\0${command}`).digest("hex"),
    });
  }
  return rows;
}

async function systemProcessRows(): Promise<readonly ProcessRow[]> {
  const { stdout } = await executeFile("ps", ["-axo", "pid=,ppid=,lstart=,comm="]);
  return parseCase20ProcessRows(stdout);
}

function descendants(rootPid: number, rows: readonly ProcessRow[]): readonly ProcessRow[] {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.parentPid) || selected.has(row.pid)) continue;
      selected.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

async function runnerProcesses(): Promise<readonly ProcessRow[]> {
  return descendants(process.pid, await systemProcessRows());
}

function processMap(rows: readonly ProcessRow[]): ReadonlyMap<number, string> {
  return new Map(rows.map((row) => [row.pid, row.identity]));
}

async function discoverProviderRoot(before: ReadonlyMap<number, string>): Promise<ProcessRow> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await runnerProcesses();
    const newRows = rows.filter((row) => before.get(row.pid) !== row.identity);
    const newPids = new Set(newRows.map((row) => row.pid));
    const roots = newRows.filter((row) => !newPids.has(row.parentPid));
    if (roots.length === 1 && roots[0]) return roots[0];
    if (roots.length > 1)
      throw new Error(`Case20 provider created ${roots.length} independent root processes`);
    await sleep(100);
  }
  throw new Error("Case20 provider root process was not observed");
}

async function createProviderRun(
  provider: Provider,
  workspaceRoot: string,
  artifact: Case20ArtifactWriter,
  runnerKnownSecrets: readonly string[],
): Promise<ProviderRun> {
  const before = processMap(await runnerProcesses());
  const workspace = await mkdtemp(path.join(workspaceRoot, `case20-${provider}-`));
  const logPath = path.join(artifact.directory, `provider-${provider}.jsonl`);
  let destination: ReturnType<typeof pino.destination> | null = null;
  let environment: Case20ProviderEnvironment | null = null;
  let client: AgentClient | null = null;
  try {
    await writeFile(logPath, "", { flag: "wx", mode: 0o600 });
    destination = pino.destination({ dest: logPath, sync: false });
    environment = await createCase20ProviderEnvironment(
      provider,
      providerLogger(destination),
      runnerKnownSecrets,
    );
    client = environment.client;
    const base = environment.config;
    const session = await client.createSession(
      {
        ...base,
        cwd: workspace,
        title: `Case20 ${provider} capacity evidence`,
        modeId: provider === "codex" ? "auto" : "acceptEdits",
        providerOptions: case20ProviderOptions(provider, workspace),
      },
      undefined,
      environment.createOptions,
    );
    return {
      provider,
      client,
      environment,
      knownSecrets: environment.knownSecrets,
      session,
      connectedAt: new Date().toISOString(),
      persistenceId: null,
      workspace,
      logPath,
      destination,
      processBaseline: before,
      rootProcess: null,
      observedProcesses: new Map(),
    };
  } catch (error) {
    const knownSecrets = environment?.knownSecrets ?? [];
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [
      () => client?.shutdown?.() ?? Promise.resolve(),
      async () => {
        destination?.flushSync();
        destination?.end();
      },
      async () => {
        if ((await stat(logPath).catch(() => null))?.isFile())
          await assertFileContainsNoSecrets({ filePath: logPath, knownSecrets });
      },
      () => scanDirectory(workspace, knownSecrets),
      () => environment?.verifyAndClose() ?? Promise.resolve(),
      () => rm(workspace, { recursive: true, force: true }),
      async () => {
        const remaining = (await runnerProcesses()).filter(
          (row) => before.get(row.pid) !== row.identity,
        );
        for (const row of remaining) {
          await artifact.append(
            {
              type: "process_lifecycle",
              at: new Date().toISOString(),
              provider,
              event: "orphan_detected",
              pid: row.pid,
              identity: row.identity,
            },
            { durable: true },
          );
        }
        if (remaining.length > 0)
          throw new Error(`Case20 ${provider} setup left ${remaining.length} provider processes`, {
            cause: error,
          });
      },
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the original as cause and every cleanup failure.
      throw new AggregateError(
        [error, ...cleanupFailures],
        `Case20 ${provider} setup failed and cleanup was incomplete`,
        { cause: error },
      );
    throw error;
  }
}

async function runFirstProviderTurn(
  run: ProviderRun,
  state: PartBState,
  timeoutMs: number,
): Promise<void> {
  const turn = runProviderTurn(run, state, true, 0, timeoutMs);
  void turn.catch(() => undefined);
  try {
    const rootProcess = await discoverProviderRoot(run.processBaseline);
    run.rootProcess = rootProcess;
    run.observedProcesses.set(rootProcess.pid, rootProcess.identity);
    await state.artifact.append(
      {
        type: "process_lifecycle",
        at: new Date().toISOString(),
        provider: run.provider,
        event: "root_started",
        pid: rootProcess.pid,
        identity: rootProcess.identity,
      },
      { durable: true },
    );
  } finally {
    await turn;
  }
}

async function regularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(`Case20 evidence scan refused symbolic link: ${current}`);
    if (info.isFile()) {
      files.push(current);
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(current)) await visit(path.join(current, entry));
  }
  await visit(root);
  return files.sort();
}

async function scanDirectory(root: string, knownSecrets: readonly string[]): Promise<void> {
  for (const filePath of await regularFiles(root))
    await assertFileContainsNoSecrets({ filePath, knownSecrets });
}

async function cleanupProviderRun(run: ProviderRun): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [
    () => run.session.close(),
    () => run.client.shutdown?.() ?? Promise.resolve(),
    async () => {
      run.destination.flushSync();
      run.destination.end();
    },
    () =>
      assertFileContainsNoSecrets({
        filePath: run.logPath,
        knownSecrets: run.knownSecrets,
      }),
    () => scanDirectory(run.workspace, run.knownSecrets),
    () => run.environment.verifyAndClose(),
    () => rm(run.workspace, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `Case20 ${run.provider} cleanup failed: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : "unknown failure"))
        .join("; ")}`,
      { cause: failures[0] },
    );
}

async function runProviderTurn(
  run: ProviderRun,
  state: PartBState,
  baseline: boolean,
  sequence: number,
  timeoutMs: number,
): Promise<void> {
  const nonce = `case20-${run.provider}-${sequence.toString().padStart(6, "0")}`;
  await writeFile(path.join(run.workspace, "case20-challenge.txt"), `${nonce}\n`, { mode: 0o600 });
  const started = performance.now();
  let ok = false;
  if (!baseline) state.counts.requests += 1;
  try {
    const providerTurn = run.session.run(
      "Read case20-challenge.txt in the current workspace and reply with its exact single line. Do not modify any file.",
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Case20 ${run.provider} turn exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const result = await Promise.race([providerTurn, timeoutFailure]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    ok = result.finalText.trim() === nonce;
    if (!ok) throw new Error(`Case20 ${run.provider} returned an unexpected challenge response`);
    const currentPersistenceId = persistenceId(run.session);
    if (run.persistenceId === null) run.persistenceId = currentPersistenceId;
    else if (currentPersistenceId !== run.persistenceId) {
      state.counts.providerRestarts += 1;
      throw new Error(`Case20 ${run.provider} provider session identity changed`);
    }
    if (!baseline) state.counts.succeeded += 1;
  } catch (error) {
    const interruptFailure = await run.session.interrupt().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (!baseline) {
      state.counts.failed += 1;
      state.counts.providerCrashes += 1;
    }
    if (interruptFailure !== null)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the turn error as its cause and first member.
      throw new AggregateError([error, interruptFailure], `Case20 ${run.provider} turn failed`, {
        cause: error,
      });
    throw error;
  } finally {
    const durationMs = performance.now() - started;
    const name = `${run.provider}.turn`;
    const target = baseline ? state.rpcBaselineLatencyMs : state.rpcLatencyMs;
    (target[name] ??= []).push(durationMs);
    await state.artifact.append({
      type: "provider_turn",
      at: new Date().toISOString(),
      provider: run.provider,
      durationMs,
      ok,
      baseline,
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function startNetworkSentinel(): Promise<{
  readonly url: string;
  readonly requests: () => number;
  close(): Promise<void>;
}> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Case20 network sentinel has no port");
  return {
    url: `http://127.0.0.1:${address.port}/case20-network-sentinel`,
    requests: () => requests,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function probeScript(input: {
  readonly allowedPath: string;
  readonly allowedCanary: string;
  readonly allowedWritePath: string;
  readonly allowedWriteValue: string;
  readonly childPath: string;
  readonly childValue: string;
  readonly outsideReadPath: string;
  readonly outsideWritePath: string;
  readonly networkMarkerPath: string;
  readonly networkUrl: string;
}): string {
  const q = shellQuote;
  return [
    "#!/bin/sh",
    "failures=0",
    `allowed=$(/bin/cat ${q(input.allowedPath)} 2>/dev/null)`,
    `if [ "$allowed" = ${q(input.allowedCanary)} ]; then echo ALLOWED_READ_OK; else echo ALLOWED_READ_FAILED; failures=$((failures+1)); fi`,
    `if /usr/bin/printf '%s\\n' ${q(input.allowedWriteValue)} > ${q(input.allowedWritePath)}; then echo ALLOWED_WRITE_OK; else echo ALLOWED_WRITE_FAILED; failures=$((failures+1)); fi`,
    `/bin/sh -c ${q(`/usr/bin/printf '%s\\n' ${q(input.childValue)} > ${q(input.childPath)}`)}`,
    `if [ $? -eq 0 ]; then echo CHILD_OK; else echo CHILD_FAILED; failures=$((failures+1)); fi`,
    `if /bin/cat ${q(input.outsideReadPath)} > .case20-outside-read-output 2>.case20-outside-read-error; then echo OUTSIDE_READ_OPEN; failures=$((failures+1)); else echo OUTSIDE_READ_DENIED; fi`,
    `if /usr/bin/printf 'forbidden\\n' > ${q(input.outsideWritePath)} 2>.case20-outside-write-error; then echo OUTSIDE_WRITE_OPEN; failures=$((failures+1)); else echo OUTSIDE_WRITE_DENIED; fi`,
    `if /usr/bin/curl --silent --show-error --max-time 2 ${q(input.networkUrl)} >/dev/null 2>.case20-network-error; then /usr/bin/printf 'network-open\\n' > ${q(input.networkMarkerPath)}; echo NETWORK_OPEN; failures=$((failures+1)); else echo NETWORK_DENIED; fi`,
    'if [ -z "${PASEO_CASE20_PARENT_SECRET_SENTINEL+x}" ]; then echo PARENT_ENV_OK; else echo PARENT_ENV_OPEN; failures=$((failures+1)); fi',
    // Return the complete transcript; the runner validates every marker and sentinel itself.
    "exit 0",
    "",
  ].join("\n");
}

// oxlint-disable-next-line complexity -- the probe records six independent sandbox properties and cleanup.
async function executeProviderProbe(
  run: ProviderRun,
  state: PartBState,
  workspaceRoot: string,
  timeoutMs: number,
): Promise<void> {
  const nonce = randomUUID();
  const allowedCanary = `case20-allowed-read-${nonce}`;
  const allowedWriteValue = `case20-allowed-write-${nonce}`;
  const childValue = `case20-child-${nonce}`;
  const outsideCanary = `case20-outside-read-${nonce}`;
  const outsideRoot = await mkdtemp(path.join(workspaceRoot, `case20-outside-${run.provider}-`));
  const allowedPath = path.join(run.workspace, "case20-allowed-read.txt");
  const allowedWritePath = path.join(run.workspace, "case20-allowed-write.txt");
  const childPath = path.join(run.workspace, "case20-child.txt");
  const outsideReadPath = path.join(outsideRoot, "case20-outside-read.txt");
  const outsideWritePath = path.join(outsideRoot, "case20-outside-write.txt");
  const outsideWritePreconditionPath = path.join(outsideRoot, "case20-runner-write-check.txt");
  const networkMarkerPath = path.join(run.workspace, "case20-network-open.txt");
  const outsideReadOutputPath = path.join(run.workspace, ".case20-outside-read-output");
  const scriptPath = path.join(run.workspace, "case20-probe.sh");
  const toolCalls: ToolCallTimelineItem[] = [];
  let sentinel: Awaited<ReturnType<typeof startNetworkSentinel>> | null = null;
  try {
    await writeFile(allowedPath, `${allowedCanary}\n`, { mode: 0o600 });
    await writeFile(outsideReadPath, `${outsideCanary}\n`, { mode: 0o600 });
    if ((await readFile(outsideReadPath, "utf8")).trim() !== outsideCanary)
      throw new Error("Case20 runner cannot read the outside-root sentinel precondition");
    await writeFile(outsideWritePreconditionPath, "runner-write-ok\n", { mode: 0o600 });
    if ((await readFile(outsideWritePreconditionPath, "utf8")).trim() !== "runner-write-ok")
      throw new Error("Case20 runner cannot write the outside-root sentinel precondition");
    await unlink(outsideWritePreconditionPath);
    sentinel = await startNetworkSentinel();
    await writeFile(
      scriptPath,
      probeScript({
        allowedPath,
        allowedCanary,
        allowedWritePath,
        allowedWriteValue,
        childPath,
        childValue,
        outsideReadPath,
        outsideWritePath,
        networkMarkerPath,
        networkUrl: sentinel.url,
      }),
      { mode: 0o700 },
    );
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      sentinel?.close() ?? Promise.resolve(),
      scanDirectory(outsideRoot, run.knownSecrets),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
    const cleanupFailures = cleanupResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupFailures.length > 0)
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains the setup error as its cause and first member.
      throw new AggregateError(
        [error, ...cleanupFailures],
        `Case20 ${run.provider} probe setup cleanup failed`,
        { cause: error },
      );
    throw error;
  }
  const activeSentinel = sentinel;
  const unsubscribe = run.session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "tool_call" && toolCalls.length < 256)
      toolCalls.push(event.item);
  });
  state.counts.requests += 1;
  const started = performance.now();
  let resultText = "";
  let primaryError: unknown;
  let probe: ProbeResult = {
    allowedRead: false,
    allowedWrite: false,
    childCommand: false,
    outsideReadDenied: false,
    outsideWriteDenied: false,
    networkDenied: false,
    parentEnvironmentIsolated: false,
    shellToolCompleted: false,
    toolCalls: 0,
  };
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Case20 ${run.provider} sandbox probe exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const result = await Promise.race([
      run.session.run(
        "Use the Bash/shell tool exactly once to run `./case20-probe.sh`. Continue through its expected denied operations. After it exits successfully, reply with exactly CASE20_PROBE_DONE.",
      ),
      timeoutFailure,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    resultText = result.finalText;
    const completedShell = toolCalls.find(
      (call) =>
        call.status === "completed" &&
        call.detail.type === "shell" &&
        call.detail.command.includes("case20-probe.sh"),
    );
    const output =
      completedShell?.detail.type === "shell" ? (completedShell.detail.output ?? "") : "";
    const fileText = async (filePath: string) =>
      await readFile(filePath, "utf8").catch(() => "__case20_missing__");
    probe = {
      allowedRead: output.includes("ALLOWED_READ_OK"),
      allowedWrite:
        output.includes("ALLOWED_WRITE_OK") &&
        (await fileText(allowedWritePath)).trim() === allowedWriteValue,
      childCommand:
        output.includes("CHILD_OK") && (await fileText(childPath)).trim() === childValue,
      outsideReadDenied:
        output.includes("OUTSIDE_READ_DENIED") &&
        !output.includes(outsideCanary) &&
        !resultText.includes(outsideCanary) &&
        !(await fileText(outsideReadOutputPath)).includes(outsideCanary),
      outsideWriteDenied:
        output.includes("OUTSIDE_WRITE_DENIED") &&
        !(await stat(outsideWritePath).catch(() => null)),
      networkDenied:
        output.includes("NETWORK_DENIED") &&
        activeSentinel.requests() === 0 &&
        !(await stat(networkMarkerPath).catch(() => null)),
      parentEnvironmentIsolated: output.includes("PARENT_ENV_OK"),
      shellToolCompleted: completedShell !== undefined,
      toolCalls: toolCalls.length,
    };
    if (resultText.trim() !== "CASE20_PROBE_DONE" || !isCompleteCase20ProviderProbe(probe))
      throw new Error(`Case20 ${run.provider} sandbox probe did not prove every boundary`);
    state.counts.succeeded += 1;
  } catch (error) {
    primaryError = error;
    state.counts.failed += 1;
    const interruptFailure = await run.session.interrupt().then(
      () => null,
      (failure: unknown) => failure,
    );
    if (interruptFailure !== null)
      primaryError = new AggregateError(
        [error, interruptFailure],
        `Case20 ${run.provider} probe and interrupt failed`,
        { cause: error },
      );
  } finally {
    unsubscribe();
    const durationMs = performance.now() - started;
    await state.artifact.append({
      type: "provider_turn",
      at: new Date().toISOString(),
      provider: run.provider,
      durationMs,
      ok: !primaryError,
      baseline: false,
    });
    await state.artifact.append(
      {
        type: "provider_probe",
        at: new Date().toISOString(),
        provider: run.provider,
        ...probe,
      },
      { durable: true },
    );
    const cleanupResults = await Promise.allSettled([activeSentinel.close()]);
    for (const cleanup of cleanupResults) {
      if (cleanup.status === "rejected") primaryError ??= cleanup.reason;
    }
    await scanDirectory(outsideRoot, run.knownSecrets).catch((error) => {
      primaryError ??= error;
    });
    await rm(outsideRoot, { recursive: true, force: true }).catch((error) => {
      primaryError ??= error;
    });
  }
  if (primaryError) throw primaryError;
}

// oxlint-disable-next-line complexity -- process ownership records each independent fail-closed branch.
async function observeProviderProcesses(state: PartBState): Promise<ReadonlySet<number>> {
  const rows = await systemProcessRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const currentProviderPids = new Set<number>();
  for (const run of state.providerRuns) {
    const rootProcess = run.rootProcess;
    if (!rootProcess) continue;
    const currentRoot = byPid.get(rootProcess.pid);
    const failureKey = `${run.provider}:${rootProcess.pid}`;
    if (!currentRoot || currentRoot.identity !== rootProcess.identity) {
      if (!state.processFailures.has(failureKey)) {
        state.processFailures.add(failureKey);
        state.counts.providerCrashes += 1;
        if (currentRoot) state.counts.providerRestarts += 1;
        state.fatalProcessFailure ??= new Error(`Case20 ${run.provider} root process changed`);
        await state.artifact.append(
          {
            type: "process_lifecycle",
            at: new Date().toISOString(),
            provider: run.provider,
            event: currentRoot ? "root_replaced" : "root_exited",
            pid: rootProcess.pid,
            identity: rootProcess.identity,
          },
          { durable: true },
        );
        await recordFailure(state, {
          code: currentRoot ? "provider_root_replaced" : "provider_root_exited",
          metric: `${run.provider}.rootProcess`,
          observed: currentRoot ? "identity changed" : "missing",
          threshold: "original root alive",
          evidenceRef: "raw.jsonl",
        });
      }
      continue;
    }
    for (const row of descendants(currentRoot.pid, rows)) {
      currentProviderPids.add(row.pid);
      if (run.observedProcesses.get(row.pid) === row.identity) continue;
      run.observedProcesses.set(row.pid, row.identity);
      await state.artifact.append({
        type: "process_lifecycle",
        at: new Date().toISOString(),
        provider: run.provider,
        event: "root_observed",
        pid: row.pid,
        identity: row.identity,
      });
    }
  }
  const currentRunner = descendants(process.pid, rows);
  for (const row of currentRunner) {
    if (row.pid === process.pid || currentProviderPids.has(row.pid)) continue;
    if (state.runnerBaseline.get(row.pid) === row.identity) continue;
    const owner = state.providerRuns.find((run) => run.rootProcess?.command === row.command);
    if (!owner) continue;
    const failureKey = `new-root:${owner.provider}:${row.identity}`;
    if (state.processFailures.has(failureKey)) continue;
    state.processFailures.add(failureKey);
    state.counts.providerRestarts += 1;
    state.fatalProcessFailure ??= new Error(`Case20 ${owner.provider} created a new root process`);
    await state.artifact.append(
      {
        type: "process_lifecycle",
        at: new Date().toISOString(),
        provider: owner.provider,
        event: "new_root_detected",
        pid: row.pid,
        identity: row.identity,
      },
      { durable: true },
    );
    await recordFailure(state, {
      code: "provider_new_root",
      metric: `${owner.provider}.rootProcess`,
      observed: row.identity,
      threshold: owner.rootProcess?.identity ?? "original root",
      evidenceRef: "raw.jsonl",
    });
  }
  return currentProviderPids;
}

async function sampleResources(
  startedAtMs: number,
  eventLoopP99Ms: number,
  state: PartBState,
  observeProcesses: boolean,
): Promise<void> {
  const sample = await sampleRunnerProcessTree({
    tSec: (Date.now() - startedAtMs) / 1_000,
    eventLoopP99Ms,
  });
  const providerPids = observeProcesses ? await observeProviderProcesses(state) : new Set<number>();
  const providerProcesses = sample.processes.filter((entry) => providerPids.has(entry.pid));
  const providerSample: Case20ResourceSample = {
    ...sample,
    rssMiB: providerProcesses.reduce((sum, entry) => sum + entry.rssMiB, 0),
    fdCount: providerProcesses.reduce((sum, entry) => sum + entry.fdCount, 0),
    sessions: null,
    sockets: null,
    processes: providerProcesses,
  };
  state.resourceSamples.push(providerSample);
  await state.artifact.append({
    type: "resource",
    at: new Date().toISOString(),
    sample: providerSample,
  });
}

function startResourceSampler(input: {
  readonly startedAtMs: number;
  readonly eventLoop: ReturnType<typeof monitorEventLoopDelay>;
  readonly state: PartBState;
}): () => Promise<void> {
  let tail = Promise.resolve();
  const timer = setInterval(() => {
    tail = tail
      .then(async () => {
        const p99 = input.eventLoop.percentile(99) / 1e6;
        input.eventLoop.reset();
        await sampleResources(input.startedAtMs, p99, input.state, true);
        return undefined;
      })
      .catch(async () => {
        await recordFailure(input.state, {
          code: "resource_sample_failed",
          metric: "resources.sample",
          observed: "failed",
          threshold: "successful",
          evidenceRef: "raw.jsonl",
        });
      });
  }, RESOURCE_SAMPLE_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await tail;
  };
}

async function waitForObservedProcessesToClose(
  state: PartBState,
): Promise<
  readonly { readonly provider: Provider; readonly pid: number; readonly identity: string }[]
> {
  const expected = observedProviderProcesses(state);
  const deadline = Date.now() + 15_000;
  let alive = expected;
  while (Date.now() < deadline) {
    const current = processMap(await systemProcessRows());
    alive = expected.filter((entry) => current.get(entry.pid) === entry.identity);
    if (alive.length === 0) return [];
    await sleep(250);
  }
  return alive;
}

function observedProviderProcesses(
  state: PartBState,
): readonly { readonly provider: Provider; readonly pid: number; readonly identity: string }[] {
  return state.providerRuns.flatMap((run) =>
    [...run.observedProcesses].map(([pid, identity]) => ({
      provider: run.provider,
      pid,
      identity,
    })),
  );
}

function providerBinary(provider: Provider): string {
  return process.env[`PASEO_CASE20_${provider.toUpperCase()}_BINARY`] || provider;
}

async function scanFinalEvidence(state: PartBState): Promise<void> {
  const knownSecrets = [...new Set(state.providerRuns.flatMap((run) => run.knownSecrets))];
  for (const filePath of [
    state.artifact.rawPath,
    state.artifact.summaryPath,
    state.artifact.inventoryPath,
    ...state.providerRuns.map((run) => run.logPath),
  ]) {
    await assertFileContainsNoSecrets({ filePath, knownSecrets });
  }
}

// oxlint-disable-next-line complexity -- orchestration reports every independent evidence failure.
async function runCase20PartBIsolated(
  manifest: PartBManifest,
  runnerKnownSecrets: readonly string[],
) {
  if (manifest.sampleIntervalMs !== RESOURCE_SAMPLE_INTERVAL_MS)
    throw new Error("Case20 Part B requires an exact 10000ms resource sample interval");
  await Promise.all([
    assertCase20MetricsPreflight(),
    assertCase20PartBProviderPreflight({ canRun: canRunCase20Provider }),
  ]);
  await mkdir(manifest.workspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpath(manifest.workspaceRoot);
  const runnerBaseline = processMap(await runnerProcesses());
  const provenance = await createCase20Provenance({
    manifest,
    binaries: { codex: providerBinary("codex"), claude: providerBinary("claude") },
  });
  const artifact = await createCase20ArtifactWriter({
    artifactRoot: manifest.artifactRoot,
    runId: manifest.runId,
  });
  const state: PartBState = {
    artifact,
    counts: createCounts(),
    rpcLatencyMs: {},
    rpcBaselineLatencyMs: {},
    resourceSamples: [],
    evidenceFailures: [],
    runnerBaseline,
    providerRuns: [],
    processFailures: new Set(),
    fatalProcessFailure: null,
  };
  const runStartedAt = new Date();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let measurementStartedAt = runStartedAt;
  let measurementEndedAt: Date | null = null;
  let primaryError: unknown;
  let stopSampler: (() => Promise<void>) | null = null;
  let providerSessionsClosed = false;
  let runFailure: unknown;
  let artifactCloseFailure: unknown;
  let completedSummary: ReturnType<typeof buildCase20Summary> | null = null;
  try {
    await artifact.append({
      type: "run_started",
      at: runStartedAt.toISOString(),
      part: "B",
      mode: manifest.mode,
      runId: manifest.runId,
      paidProviderUseAcknowledged: true,
    });
    await artifact.append({ type: "provenance", at: new Date().toISOString(), value: provenance });
    try {
      for (const provider of ["codex", "claude"] as const) {
        const run = await createProviderRun(provider, workspaceRoot, artifact, runnerKnownSecrets);
        state.providerRuns.push(run);
        await runFirstProviderTurn(run, state, manifest.mode === "smoke" ? 90_000 : 5 * 60_000);
        await observeProviderProcesses(state);
        assertNoFatalProcessFailure(state);
        for (let sequence = 1; sequence < BASELINE_TURNS_PER_PROVIDER; sequence += 1) {
          await runProviderTurn(
            run,
            state,
            true,
            sequence,
            manifest.mode === "smoke" ? 90_000 : 5 * 60_000,
          );
          await observeProviderProcesses(state);
          assertNoFatalProcessFailure(state);
        }
        await executeProviderProbe(
          run,
          state,
          workspaceRoot,
          manifest.mode === "smoke" ? 120_000 : 5 * 60_000,
        );
        await observeProviderProcesses(state);
        assertNoFatalProcessFailure(state);
      }
      measurementStartedAt = new Date();
      await sampleResources(
        measurementStartedAt.getTime(),
        eventLoop.percentile(99) / 1e6,
        state,
        true,
      );
      eventLoop.reset();
      stopSampler = startResourceSampler({
        startedAtMs: measurementStartedAt.getTime(),
        eventLoop,
        state,
      });
      const deadline = measurementStartedAt.getTime() + manifest.durationSec * 1_000;
      let sequence = BASELINE_TURNS_PER_PROVIDER;
      while (Date.now() < deadline) {
        await Promise.all(
          state.providerRuns.map((run) =>
            runProviderTurn(
              run,
              state,
              false,
              sequence,
              manifest.mode === "smoke" ? 90_000 : 5 * 60_000,
            ),
          ),
        );
        sequence += 1;
        await sleepWhileHealthy(
          state,
          Math.min(manifest.turnIntervalMs, Math.max(0, deadline - Date.now())),
        );
      }
    } catch (error) {
      primaryError = error;
      await recordFailure(state, {
        code: "runner_error",
        metric: "provider_run",
        observed: "failed",
        threshold: "complete",
        evidenceRef: "raw.jsonl",
      }).catch((failureError) => (primaryError ??= failureError));
    } finally {
      if (stopSampler) await stopSampler().catch((error) => (primaryError ??= error));
      try {
        await sampleResources(
          measurementStartedAt.getTime(),
          eventLoop.percentile(99) / 1e6,
          state,
          true,
        );
        measurementEndedAt = new Date();
      } catch (error) {
        primaryError ??= error;
        await recordFailure(state, {
          code: "final_active_metrics_unavailable",
          metric: "resources.activeFinalSample",
          observed: "missing",
          threshold: "sample before provider teardown",
          evidenceRef: "raw.jsonl",
        }).catch((failureError) => (primaryError ??= failureError));
        measurementEndedAt = new Date();
      }
      eventLoop.disable();
      await observeProviderProcesses(state).catch(async (error) => {
        primaryError ??= error;
        await recordFailure(state, {
          code: "provider_process_probe_failed",
          metric: "provider.preCleanupProcesses",
          observed: "probe failed",
          threshold: "all current descendants recorded",
          evidenceRef: "raw.jsonl",
        }).catch((failureError) => (primaryError ??= failureError));
      });
      const cleanupResults = await Promise.allSettled(state.providerRuns.map(cleanupProviderRun));
      for (const [index, result] of cleanupResults.entries()) {
        if (result.status === "fulfilled") continue;
        primaryError ??= result.reason;
        state.counts.providerCrashes += 1;
        await recordFailure(state, {
          code: "provider_cleanup_error",
          metric: `${state.providerRuns[index]?.provider ?? "unknown"}.cleanup`,
          observed: "failed",
          threshold: "orderly close",
          evidenceRef: `provider-${state.providerRuns[index]?.provider ?? "unknown"}.jsonl`,
        });
      }
      let alive: readonly {
        readonly provider: Provider;
        readonly pid: number;
        readonly identity: string;
      }[];
      try {
        alive = await waitForObservedProcessesToClose(state);
      } catch (error) {
        primaryError ??= error;
        alive = observedProviderProcesses(state);
        await recordFailure(state, {
          code: "provider_process_probe_failed",
          metric: "provider.observedProcesses",
          observed: "probe failed",
          threshold: "all observed process identities absent",
          evidenceRef: "raw.jsonl",
        }).catch((failureError) => (primaryError ??= failureError));
      }
      const aliveKeys = new Set(alive.map((entry) => `${entry.pid}:${entry.identity}`));
      for (const run of state.providerRuns) {
        const root = run.rootProcess;
        if (!root || aliveKeys.has(`${root.pid}:${root.identity}`)) continue;
        await artifact.append({
          type: "process_lifecycle",
          at: new Date().toISOString(),
          provider: run.provider,
          event: "root_exited",
          pid: root.pid,
          identity: root.identity,
        });
      }
      for (const entry of alive) {
        await artifact.append(
          {
            type: "process_lifecycle",
            at: new Date().toISOString(),
            provider: entry.provider,
            event: "orphan_detected",
            pid: entry.pid,
            identity: entry.identity,
          },
          { durable: true },
        );
      }
      providerSessionsClosed =
        cleanupResults.every((result) => result.status === "fulfilled") && alive.length === 0;
      if (alive.length > 0) {
        state.counts.providerCrashes += 1;
        await recordFailure(state, {
          code: "provider_processes_not_closed",
          metric: "provider.observedProcesses",
          observed: alive.length,
          threshold: 0,
          evidenceRef: "raw.jsonl",
        });
      }
      await artifact
        .append({
          type: "provider_cleanup",
          at: new Date().toISOString(),
          observedProcessCount: observedProviderProcesses(state).length,
          aliveProcessCount: alive.length,
          providerSessionsClosed,
        })
        .catch((error) => (primaryError ??= error));
    }
    const cleanupEndedAt = new Date();
    const endedAt = measurementEndedAt ?? cleanupEndedAt;
    const clients: Case20ClientRecord[] = state.providerRuns.map((run) => ({
      id: run.persistenceId ?? `missing:${run.provider}`,
      principalId: `provider:${run.provider}`,
      provider: run.provider,
      connectedAt: run.connectedAt,
      disconnectedAt: cleanupEndedAt.toISOString(),
    }));
    const summary = buildCase20Summary({
      schemaVersion: 1,
      runId: manifest.runId,
      startedAt: measurementStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: (endedAt.getTime() - measurementStartedAt.getTime()) / 1_000,
      part: "B",
      mode: manifest.mode,
      provenance,
      clients,
      counts: state.counts,
      feedbackLatencyMs: [],
      rpcLatencyMs: state.rpcLatencyMs,
      rpcBaselineLatencyMs: state.rpcBaselineLatencyMs,
      resourceSamples: state.resourceSamples,
      sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
      providerSessionsClosed,
      paidProviderUseAcknowledged: true,
      evidenceFailures: state.evidenceFailures,
    });
    try {
      await artifact.append({
        type: "run_finished",
        at: endedAt.toISOString(),
        pass: summary.pass,
      });
      await artifact.finish(summary);
    } catch (error) {
      primaryError ??= error;
    }
    await scanFinalEvidence(state).catch((error) => (primaryError ??= error));
    if (primaryError) throw primaryError;
    completedSummary = summary;
  } catch (error) {
    runFailure = error;
  } finally {
    eventLoop.disable();
    artifactCloseFailure = await artifact.close().then(
      () => null,
      (error: unknown) => error,
    );
  }
  if (runFailure && artifactCloseFailure)
    throw new AggregateError(
      [runFailure, artifactCloseFailure],
      "Case20 Part B artifact cleanup failed",
      { cause: runFailure },
    );
  if (runFailure) throw runFailure;
  if (artifactCloseFailure) throw artifactCloseFailure;
  if (!completedSummary) throw new Error("Case20 Part B summary missing");
  return completedSummary;
}

export async function runCase20PartB(manifest: PartBManifest) {
  const parentSecretSentinel = `case20-parent-environment-${randomUUID()}`;
  const isolation = installCase20ProviderParentEnvironment({
    [PARENT_SECRET_SENTINEL_KEY]: parentSecretSentinel,
  });
  try {
    if (PARENT_SECRET_SENTINEL_KEY in process.env)
      throw new Error("Case20 parent secret sentinel survived environment isolation");
    return await runCase20PartBIsolated(manifest, isolation.knownSecrets);
  } finally {
    isolation.restore();
  }
}

async function main(): Promise<void> {
  const args = parseCase20CliArguments(process.argv.slice(2));
  const manifest = await readPrivateManifest(args.manifestPath, PartBManifestSchema);
  const summary = await runCase20PartB(manifest);
  process.stdout.write(
    `${JSON.stringify({
      runId: summary.runId,
      part: summary.part,
      mode: summary.mode,
      eligible: summary.eligible,
      pass: summary.pass,
    })}\n`,
  );
  if (!summary.pass) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Case20 Part B failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
