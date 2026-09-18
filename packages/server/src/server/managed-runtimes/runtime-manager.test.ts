import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ManagedRuntimePolicy } from "@getpaseo/protocol/managed-runtimes";

import { installManagedRuntime } from "./runtime-installer.js";
import {
  ManagedRuntimeManager,
  ManagedRuntimeNotPinnedError,
  createDirectoryArtifactSource,
  loadLocalManagedRuntimePolicy,
  staticManagedRuntimePolicySource,
} from "./runtime-manager.js";
import { type ManagedRuntimePaths, managedRuntimePaths } from "./runtime-paths.js";
import { createTestTarGz, sha256Hex, versionScript } from "./test-archive.js";

const PLATFORM_ARCH = "darwin-arm64";
let paseoHome: string;
let paths: ManagedRuntimePaths;
let archive: Buffer;

beforeEach(async () => {
  paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-runtime-manager-"));
  paths = managedRuntimePaths(paseoHome);
  archive = createTestTarGz([
    { name: "bin/claude", content: versionScript("2.1.258 (Claude Code)"), mode: 0o755 },
  ]);
  await mkdir(paths.artifacts, { recursive: true });
  await writeFile(path.join(paths.artifacts, sha256Hex(archive)), archive);
});

afterEach(async () => {
  await rm(paseoHome, { recursive: true, force: true });
});

function policy(overrides: Partial<ManagedRuntimePolicy> = {}): ManagedRuntimePolicy {
  return {
    schemaVersion: 1,
    policyVersion: 3,
    pathFallback: "forbid",
    allowCommandOverride: false,
    autoInstall: false,
    runtimes: [
      {
        runtimeName: "claude-code",
        version: "2.1.258",
        providerIds: ["claude"],
        artifacts: [
          {
            platformArch: PLATFORM_ARCH,
            fileName: "claude.tar.gz",
            archiveFormat: "tar.gz",
            sha256: sha256Hex(archive),
            sizeBytes: archive.length,
            command: "bin/claude",
            launcher: "exec",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function manager(
  current: ManagedRuntimePolicy | null,
  platformArch: string | null = PLATFORM_ARCH,
): ManagedRuntimeManager {
  return new ManagedRuntimeManager({
    paths,
    policySource: staticManagedRuntimePolicySource(current, "local_policy"),
    artifactSource: createDirectoryArtifactSource(paths.artifacts),
    logger: pino({ level: "silent" }),
    platformArch,
  });
}

describe("ManagedRuntimeManager", () => {
  test("leaves Providers unmanaged without a policy or a pin for that Provider", async () => {
    expect(await manager(null).resolveProvider("claude")).toEqual({ kind: "unmanaged" });
    expect(await manager(policy()).resolveProvider("codex")).toEqual({ kind: "unmanaged" });
    expect(await manager(null).status()).toEqual([]);
  });

  test("reports a pinned runtime that is not installed with the policy fallback rule", async () => {
    const runtimes = manager(policy());

    expect(await runtimes.resolveProvider("claude")).toEqual({
      kind: "unavailable",
      runtimeName: "claude-code",
      reason: "not_installed",
      pathFallback: "forbid",
      allowCommandOverride: false,
    });
    expect(await runtimes.status()).toEqual([
      {
        runtimeName: "claude-code",
        pinnedVersion: "2.1.258",
        activeVersion: null,
        installedVersions: [],
        status: "not_installed",
        commandPath: null,
        error: null,
      },
    ]);
  });

  test("installs a pinned runtime and resolves the Provider to its command", async () => {
    const runtimes = manager(policy());

    const status = await runtimes.install("claude-code");
    const resolution = await runtimes.resolveProvider("claude");

    expect(status).toMatchObject({ status: "installed", activeVersion: "2.1.258" });
    expect(resolution).toEqual({
      kind: "installed",
      runtimeName: "claude-code",
      version: "2.1.258",
      commandPath: path.join(paths.root, "claude-code", "2.1.258", PLATFORM_ARCH, "bin", "claude"),
      allowCommandOverride: false,
    });
  });

  test("treats an install whose metadata no longer matches the pin as a mismatch", async () => {
    const current = policy();
    await manager(current).install("claude-code");
    const repinned = policy();
    repinned.runtimes[0]!.artifacts[0]!.sha256 = "f".repeat(64);

    const runtimes = manager(repinned);

    expect(await runtimes.resolveProvider("claude")).toMatchObject({
      kind: "unavailable",
      reason: "mismatch",
    });
    expect((await runtimes.status())[0]).toMatchObject({ status: "mismatch" });
  });

  test("starts an install in the background when the policy enables auto install", async () => {
    const runtimes = manager(policy({ autoInstall: true }));

    expect(await runtimes.resolveProvider("claude")).toMatchObject({
      kind: "unavailable",
      reason: "installing",
    });
    await runtimes.whenIdle();

    expect(await runtimes.resolveProvider("claude")).toMatchObject({ kind: "installed" });
  });

  test("records a failed install on the runtime status", async () => {
    const broken = policy();
    broken.runtimes[0]!.artifacts[0]!.sha256 = "0".repeat(64);
    await writeFile(path.join(paths.artifacts, "0".repeat(64)), archive);
    const runtimes = manager(broken);

    await expect(runtimes.install("claude-code")).rejects.toMatchObject({
      name: "ManagedRuntimeIntegrityError",
    });

    expect((await runtimes.status())[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("sha256 mismatch"),
    });
  });

  test("reports an unsupported platform and refuses runtimes that are not pinned", async () => {
    const runtimes = manager(policy(), "linux-x64");

    expect(await runtimes.resolveProvider("claude")).toMatchObject({
      kind: "unavailable",
      reason: "unsupported_platform",
    });
    await expect(runtimes.install("codex")).rejects.toBeInstanceOf(ManagedRuntimeNotPinnedError);
  });

  test("an install by another manager instance is visible without reinstalling", async () => {
    const current = policy();
    await installManagedRuntime({
      paths,
      pin: current.runtimes[0]!,
      artifact: current.runtimes[0]!.artifacts[0]!,
      source: createDirectoryArtifactSource(paths.artifacts),
      installSource: "management_plane",
      policyVersion: 3,
    });

    expect(await manager(current).resolveProvider("claude")).toMatchObject({ kind: "installed" });
  });
});

describe("loadLocalManagedRuntimePolicy", () => {
  test("returns null when the policy file is absent and throws on an invalid policy", async () => {
    expect(await loadLocalManagedRuntimePolicy(paths.localPolicy)).toBeNull();

    await writeFile(paths.localPolicy, JSON.stringify({ schemaVersion: 1, runtimes: "all" }));
    await expect(loadLocalManagedRuntimePolicy(paths.localPolicy)).rejects.toThrow();

    await writeFile(paths.localPolicy, JSON.stringify(policy()));
    expect(await loadLocalManagedRuntimePolicy(paths.localPolicy)).toEqual(policy());
  });
});
