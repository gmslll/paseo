import { describe, expect, test } from "vitest";

import type {
  ManagedBinaryResolution,
  ManagedProviderBinary,
} from "../managed-runtimes/managed-provider-binary.js";
import {
  checkProviderLaunchAvailable,
  resolveManagedProviderLaunch,
} from "./provider-launch-config.js";

const PATH_BINARY = "/usr/local/bin/claude-from-path";
const MANAGED_BINARY = "/home/u/.paseo/runtimes/claude-code/2.1.258/darwin-arm64/bin/claude";

const defaultBinary = { command: "claude", resolvePath: async () => PATH_BINARY };

function managed(resolution: ManagedBinaryResolution): ManagedProviderBinary {
  return { resolve: async () => resolution };
}

async function resolveAvailability(input: Parameters<typeof resolveManagedProviderLaunch>[0]) {
  const resolved = await resolveManagedProviderLaunch(input);
  return {
    launch: resolved.launch,
    availability: await checkProviderLaunchAvailable(resolved.launch, resolved.defaultBinary),
  };
}

describe("resolveManagedProviderLaunch", () => {
  test("an unmanaged Provider resolves exactly as before", async () => {
    const { launch, availability } = await resolveAvailability({
      defaultBinary,
      managed: managed({ kind: "unmanaged" }),
    });

    expect(launch).toEqual({ command: "claude", args: [], source: "default" });
    expect(availability).toEqual({ available: true, resolvedPath: PATH_BINARY });
  });

  test("an installed runtime wins over the binary found on PATH", async () => {
    const { availability } = await resolveAvailability({
      defaultBinary,
      managed: managed({
        kind: "installed",
        runtimeName: "claude-code",
        version: "2.1.258",
        commandPath: MANAGED_BINARY,
        allowCommandOverride: false,
      }),
    });

    expect(availability).toEqual({ available: true, resolvedPath: MANAGED_BINARY });
  });

  test("a missing pinned runtime makes the Provider unavailable when fallback is forbidden", async () => {
    const { availability } = await resolveAvailability({
      defaultBinary,
      managed: managed({
        kind: "unavailable",
        runtimeName: "claude-code",
        reason: "not_installed",
        pathFallback: "forbid",
        allowCommandOverride: false,
      }),
    });

    expect(availability).toEqual({ available: false, resolvedPath: null });
  });

  test("a missing pinned runtime falls back to PATH when the policy allows it", async () => {
    const { availability } = await resolveAvailability({
      defaultBinary,
      managed: managed({
        kind: "unavailable",
        runtimeName: "claude-code",
        reason: "installing",
        pathFallback: "allow",
        allowCommandOverride: false,
      }),
    });

    expect(availability).toEqual({ available: true, resolvedPath: PATH_BINARY });
  });

  test("a replacing command override is ignored unless the policy allows overrides", async () => {
    const installed = (allowCommandOverride: boolean): ManagedBinaryResolution => ({
      kind: "installed",
      runtimeName: "claude-code",
      version: "2.1.258",
      commandPath: MANAGED_BINARY,
      allowCommandOverride,
    });
    const commandConfig = { mode: "replace" as const, argv: ["/opt/custom-claude", "--flag"] };

    const locked = await resolveManagedProviderLaunch({
      commandConfig,
      defaultBinary,
      managed: managed(installed(false)),
    });
    const allowed = await resolveManagedProviderLaunch({
      commandConfig,
      defaultBinary,
      managed: managed(installed(true)),
    });

    expect(locked.launch).toEqual({ command: "claude", args: [], source: "default" });
    expect(allowed.launch).toEqual({
      command: "/opt/custom-claude",
      args: ["--flag"],
      source: "override",
    });
  });

  test("appended arguments still apply to the managed runtime", async () => {
    const { launch, availability } = await resolveAvailability({
      commandConfig: { mode: "append", args: ["--verbose"] },
      defaultBinary,
      managed: managed({
        kind: "installed",
        runtimeName: "claude-code",
        version: "2.1.258",
        commandPath: MANAGED_BINARY,
        allowCommandOverride: false,
      }),
    });

    expect(launch).toEqual({ command: "claude", args: ["--verbose"], source: "append" });
    expect(availability.resolvedPath).toBe(MANAGED_BINARY);
  });
});
