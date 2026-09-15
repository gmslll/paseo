import { describe, expect, test } from "vitest";
import type { ManagedRuntimeStatus } from "@getpaseo/protocol/managed-runtimes";
import { render } from "../../output/render.js";
import { runtimeStatusSchema } from "./status.js";

const installed: ManagedRuntimeStatus = {
  runtimeName: "claude-code",
  pinnedVersion: "2.1.258",
  activeVersion: "2.1.258",
  installedVersions: ["2.1.258"],
  status: "installed",
  commandPath: "/paseo/runtimes/bin/claude-code",
  error: null,
};

const failed: ManagedRuntimeStatus = {
  runtimeName: "codex",
  pinnedVersion: "0.153.4",
  activeVersion: null,
  installedVersions: [],
  status: "failed",
  commandPath: null,
  error: "codex artifact sha256 mismatch",
};

function list(data: ManagedRuntimeStatus[]) {
  return { type: "list" as const, data, schema: runtimeStatusSchema };
}

describe("runtime status output", () => {
  test("table output shows versions, status, and the command or failure for each runtime", () => {
    const output = render(list([installed, failed]), { noColor: true });

    expect(output.split("\n")[0]).toMatch(/^RUNTIME\s+PINNED\s+ACTIVE\s+STATUS\s+COMMAND\s*$/);
    expect(output).toContain("/paseo/runtimes/bin/claude-code");
    expect(output).toMatch(/codex\s+0\.153\.4\s+-\s+failed\s+codex artifact sha256 mismatch/);
  });

  test("quiet output prints only runtime names", () => {
    expect(render(list([installed, failed]), { quiet: true })).toBe("claude-code\ncodex");
  });

  test("structured output preserves the daemon status", () => {
    expect(render(list([installed]), { format: "json" })).toBe(
      JSON.stringify([installed], null, 2),
    );
  });
});
