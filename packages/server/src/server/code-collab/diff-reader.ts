import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGitCommand } from "../../utils/run-git-command.js";
import { parseDiff, type ParsedDiffFile } from "../utils/diff-highlighter.js";
import { ensurePrivateDirectory } from "../private-files.js";
import type { DiffStore, TurnFileRow } from "./diff-store.js";

// Reading a turn back (ADR-0044): the stored before and after images are written side by side and
// compared with `git diff --no-index`, so the daemon has one diff implementation rather than two.

/** Git exits 1 when the files differ, which is the answer rather than a failure. */
const DIFFERENCES_FOUND = 1;

/** The same ceiling the checkout diff uses for one file. */
const MAX_DIFF_BYTES = 1024 * 1024;

const READ_ONLY_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

export interface TurnDiffOptions {
  readonly ignoreWhitespace?: boolean;
}

/**
 * The files one turn changed, as the checkout diff already describes a change.
 *
 * `status` carries only what the parser's vocabulary has words for. A symlink is expressed
 * structurally instead — empty hunks with `isNew`/`isDeleted` — rather than borrowed from a status
 * that would say something untrue about it. A file the turn created or deleted is an ordinary diff
 * against an empty side, so it keeps its hunks.
 */
export async function readTurnDiff(
  store: DiffStore,
  turnId: string,
  options: TurnDiffOptions = {},
): Promise<ParsedDiffFile[]> {
  return readFiles(store, store.turnFiles(turnId), options);
}

/** The conversation's accumulated effect: first before-image vs last after-image per path. */
export async function readAllChangesDiff(
  store: DiffStore,
  options: TurnDiffOptions & { agentId?: string } = {},
): Promise<ParsedDiffFile[]> {
  return readFiles(store, store.accumulatedFiles({ agentId: options.agentId }), options);
}

async function readFiles(
  store: DiffStore,
  files: TurnFileRow[],
  options: TurnDiffOptions,
): Promise<ParsedDiffFile[]> {
  if (files.length === 0) return [];

  const workspace = mkdtempSync(path.join(tmpdir(), "paseo-turn-diff-"));
  ensurePrivateDirectory(workspace);
  try {
    const parsed: ParsedDiffFile[] = [];
    for (const file of files) {
      parsed.push(await readOneFile(store, workspace, file, options));
    }
    return parsed;
  } finally {
    // The images are Workspace file contents; they live only as long as the comparison.
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function readOneFile(
  store: DiffStore,
  workspace: string,
  file: TurnFileRow,
  options: TurnDiffOptions,
): Promise<ParsedDiffFile> {
  const placeholder = placeholderFor(file);
  if (placeholder) return placeholder;

  const before = file.beforeSha256 ? store.readContent(file.beforeSha256) : null;
  const after = file.afterSha256 ? store.readContent(file.afterSha256) : null;
  const beforePath = path.join(workspace, "before");
  const afterPath = path.join(workspace, "after");
  writeFileSync(beforePath, before ?? new Uint8Array(), { mode: 0o600 });
  writeFileSync(afterPath, after ?? new Uint8Array(), { mode: 0o600 });

  const result = await runGitCommand(
    [
      "diff",
      ...(options.ignoreWhitespace ? ["-w"] : []),
      "--no-index",
      "--",
      beforePath,
      afterPath,
    ],
    {
      cwd: workspace,
      envOverlay: READ_ONLY_GIT_ENV,
      maxOutputBytes: MAX_DIFF_BYTES,
      acceptExitCodes: [0, DIFFERENCES_FOUND],
    },
  );

  const [only] = parseDiff(result.stdout);
  if (!only) {
    return {
      path: file.path,
      isNew: before === null && after !== null,
      isDeleted: before !== null && after === null,
      additions: 0,
      deletions: 0,
      hunks: [],
      status: "ok",
    };
  }
  return {
    ...only,
    // --no-index names the temporary files it was given, which means nothing to a reader. The path
    // the turn recorded is the one that does.
    path: file.path,
    isNew: before === null,
    isDeleted: after === null,
    ...(result.truncated ? { status: "too_large" as const } : {}),
  };
}

/**
 * A file with nothing to compare, described by why rather than by a diff.
 *
 * `missing` is not one of these. A turn that deleted a file still holds its before image, and a
 * turn that created one still holds its after image; both are ordinary diffs against an empty side,
 * and answering them with an empty placeholder would drop the lines that changed.
 */
function placeholderFor(file: TurnFileRow): ParsedDiffFile | null {
  const base = {
    path: file.path,
    isNew: file.beforeSha256 === null,
    isDeleted: file.afterSha256 === null && file.kind !== "text",
    additions: 0,
    deletions: 0,
    hunks: [],
  };
  if (file.kind === "binary") return { ...base, status: "binary" };
  if (file.kind === "too_large") return { ...base, status: "too_large" };
  // A symlink has no word in the parser's vocabulary, and borrowing one would misreport it. The
  // empty hunks plus isNew/isDeleted say what happened without claiming more.
  if (file.kind === "symlink") return base;
  return null;
}
