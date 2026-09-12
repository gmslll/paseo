import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { promisify } from "node:util";

import type { Case20Provenance } from "./model.js";

const executeFile = promisify(execFile);

async function commandOutput(
  command: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const result = await executeFile(command, [...args], {
    cwd,
    timeout: 15_000,
    maxBuffer: 16 << 20,
  });
  return result.stdout;
}

async function commandVersion(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await executeFile(command, [...args], { timeout: 15_000 });
    return `${result.stdout}\n${result.stderr}`.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
}

export async function createCase20Provenance(input: {
  readonly manifest: unknown;
  readonly binaries?: Readonly<Record<string, string>>;
  readonly repositoryRoot?: string;
}): Promise<Case20Provenance> {
  const [commitOutput, treeOutput, status, diff, untrackedOutput] = await Promise.all([
    commandOutput("git", ["rev-parse", "HEAD"], input.repositoryRoot),
    commandOutput("git", ["rev-parse", "HEAD^{tree}"], input.repositoryRoot),
    commandOutput(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      input.repositoryRoot,
    ),
    commandOutput("git", ["diff", "--binary", "HEAD", "--"], input.repositoryRoot),
    commandOutput(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      input.repositoryRoot,
    ),
  ]);
  const commit = commitOutput.trim();
  const tree = treeOutput.trim();
  const untrackedFiles = Object.freeze(untrackedOutput.split("\0").filter(Boolean).sort());
  const binaries: Record<string, string> = {};
  for (const [name, command] of Object.entries(input.binaries ?? {})) {
    binaries[name] = await commandVersion(command, ["--version"]);
  }
  return Object.freeze({
    commit,
    tree,
    trackedClean: diff.length === 0,
    statusSha256: createHash("sha256").update(status).digest("hex"),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    untrackedFiles,
    platform: os.platform(),
    architecture: os.arch(),
    nodeVersion: process.version,
    manifestSha256: createHash("sha256").update(JSON.stringify(input.manifest)).digest("hex"),
    binaries: Object.freeze(binaries),
  });
}
