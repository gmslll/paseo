import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildProviderRegistry } from "../agent/provider-registry.js";
import { ClaudeAgentClient, resolveClaudeCodeVersion } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import type {
  ManagedBinaryResolution,
  ManagedProviderBinary,
  ManagedRuntimeBindings,
} from "./managed-provider-binary.js";
import { versionScript } from "./test-archive.js";

const logger = pino({ level: "silent" });
let directory: string;
let managedCommand: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-managed-wiring-"));
  managedCommand = path.join(directory, "managed-claude");
  await writeFile(managedCommand, versionScript("2.1.258 (Claude Code)"));
  await chmod(managedCommand, 0o755);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function binding(resolution: ManagedBinaryResolution): ManagedProviderBinary {
  return { resolve: async () => resolution };
}

function installed(): ManagedProviderBinary {
  return binding({
    kind: "installed",
    runtimeName: "claude-code",
    version: "2.1.258",
    commandPath: managedCommand,
    allowCommandOverride: false,
  });
}

const missingForbidden = binding({
  kind: "unavailable",
  runtimeName: "claude-code",
  reason: "not_installed",
  pathFallback: "forbid",
  allowCommandOverride: false,
});

describe("managed runtime Provider wiring", () => {
  test("Claude reads its version from the installed managed runtime", async () => {
    await expect(resolveClaudeCodeVersion(undefined, undefined, installed())).resolves.toBe(
      "2.1.258",
    );
    expect(await new ClaudeAgentClient({ logger, managedBinary: installed() }).isAvailable()).toBe(
      true,
    );
  });

  test("Claude is unavailable when the pinned runtime is missing and PATH fallback is forbidden", async () => {
    expect(
      await new ClaudeAgentClient({ logger, managedBinary: missingForbidden }).isAvailable(),
    ).toBe(false);
    await expect(resolveClaudeCodeVersion(undefined, undefined, missingForbidden)).rejects.toThrow(
      "Claude binary not found",
    );
  });

  test("Codex availability follows the managed runtime decision", async () => {
    expect(
      await new CodexAppServerAgentClient(logger, undefined, {
        managedBinary: missingForbidden,
      }).isAvailable(),
    ).toBe(false);
    expect(
      await new CodexAppServerAgentClient(logger, undefined, {
        managedBinary: installed(),
      }).isAvailable(),
    ).toBe(true);
  });

  test("the registry binds built-in and derived clients to their base Provider runtime", async () => {
    const requestedProviders: string[] = [];
    const runtimes: ManagedRuntimeBindings = {
      bindingFor(providerId) {
        requestedProviders.push(providerId);
        return missingForbidden;
      },
    };

    const registry = buildProviderRegistry(logger, {
      managedRuntimes: runtimes,
      providerOverrides: { "claude-profile": { extends: "claude", label: "Claude profile" } },
    });

    expect(requestedProviders).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(requestedProviders.filter((provider) => provider === "claude").length).toBeGreaterThan(
      1,
    );
    expect(registry["claude-profile"]?.derivedFromProviderId).toBe("claude");
  });
});
