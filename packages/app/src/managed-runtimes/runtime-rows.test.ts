import { describe, expect, it } from "vitest";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import { buildManagedRuntimeRows } from "./runtime-rows";

function status(overrides: Partial<ManagedRuntimeStatus>): ManagedRuntimeStatus {
  return {
    runtimeName: "claude-code",
    pinnedVersion: "2.1.258",
    activeVersion: null,
    installedVersions: [],
    status: "not_installed",
    commandPath: null,
    error: null,
    ...overrides,
  };
}

describe("buildManagedRuntimeRows", () => {
  it("shows the command of an installed runtime and offers no install", () => {
    const [row] = buildManagedRuntimeRows([
      status({
        status: "installed",
        activeVersion: "2.1.258",
        commandPath: "/paseo/runtimes/bin/claude-code",
      }),
    ]);

    expect(row).toEqual({
      runtimeName: "claude-code",
      status: "installed",
      badgeVariant: "success",
      pinnedVersion: "2.1.258",
      activeVersion: "2.1.258",
      commandPath: "/paseo/runtimes/bin/claude-code",
      failure: null,
      canInstall: false,
    });
  });

  it("offers install for missing, mismatched, and failed pins and keeps the failure", () => {
    const rows = buildManagedRuntimeRows([
      status({ status: "not_installed" }),
      status({ runtimeName: "codex", status: "mismatch" }),
      status({ runtimeName: "kimi", status: "failed", error: "codex artifact sha256 mismatch" }),
    ]);

    expect(rows.map((row) => [row.runtimeName, row.badgeVariant, row.canInstall])).toEqual([
      ["claude-code", "warning", true],
      ["codex", "error", true],
      ["kimi", "error", true],
    ]);
    expect(rows[2]?.failure).toBe("codex artifact sha256 mismatch");
  });

  it("offers no install while installing or when the runtime is no longer pinned", () => {
    const rows = buildManagedRuntimeRows([
      status({ status: "installing" }),
      status({ runtimeName: "codex", status: "not_pinned", pinnedVersion: null }),
    ]);

    expect(rows.map((row) => row.canInstall)).toEqual([false, false]);
  });
});
