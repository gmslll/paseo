import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

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
  type Case20Counts,
  type Case20RunMeasurements,
} from "./model.js";
import { assertCase20PartBProviderPreflight } from "./provider-preflight.js";
import { isCase20AccessDenial, isUnexpectedCase20ConnectionTerminal } from "./part-a.js";
import {
  case20ProviderOptions,
  isCompleteCase20ProviderProbe,
  parseCase20ProcessRows,
} from "./part-b.js";
import { createCase20Provenance } from "./provenance.js";
import {
  createCase20AllowlistedBaseEnvironment,
  getCase20RealProviderConfig,
  installCase20ProviderParentEnvironment,
} from "./real-providers.js";
import { assertFileContainsNoSecrets } from "./secret-scan.js";
import { buildCase20Summary, theilSenSlopePerMinute } from "./summary.js";

const temporaryRoots: string[] = [];
const executeFile = promisify(execFile);

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

function measurements(overrides: Partial<Case20RunMeasurements> = {}): Case20RunMeasurements {
  const startedAt = "2026-09-11T00:00:00.000Z";
  const endedAt = "2026-09-11T00:30:00.000Z";
  return {
    schemaVersion: 1,
    runId: "case20-test",
    startedAt,
    endedAt,
    durationSec: 1_800,
    part: "A",
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
    clients: Array.from({ length: CASE20_PART_A_CLIENT_COUNT }, (_, index) => ({
      id: `client-${index}`,
      principalId: `usr_${index.toString(16).padStart(16, "0")}`,
      connectedAt: startedAt,
      disconnectedAt: endedAt,
    })),
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
    resourceSamples: Array.from({ length: 181 }, (_, index) => ({
      tSec: index * 10,
      rssMiB: 100,
      fdCount: 20,
      swapMiB: 0,
      eventLoopP99Ms: 10,
      sessions: index === 180 ? 0 : 10,
      sockets: index === 180 ? 0 : 10,
      processes: [],
    })),
    sampleIntervalMs: 10_000,
    ...overrides,
  };
}

describe("Case20 evidence helpers", () => {
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
    await writer.append({
      type: "run_started",
      at: "2026-09-11T00:00:00.000Z",
      part: "A",
      mode: "smoke",
      runId: "artifact",
    });
    expect(() =>
      writer.append({
        type: "client_connected",
        at: "2026-09-11T00:00:00.000Z",
        clientId: "Bearer secret-material-value",
        principalId: "usr_0000000000000001",
      }),
    ).toThrow("credential-like");
    await writer.finish(buildCase20Summary(measurements({ runId: "artifact" })));
    await writer.close();
    expect(await readFile(writer.rawPath, "utf8")).toContain('"type":"run_started"');
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
