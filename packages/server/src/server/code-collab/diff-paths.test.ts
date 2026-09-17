import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  diffStoreDirectory,
  diffStorePath,
  diffStorePaths,
  ensureDiffStorePath,
  CODE_COLLAB_DIRECTORY,
  DIFF_STORE_FILE,
} from "./diff-paths.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "diff-paths-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("where a Workspace's diff store lives", () => {
  test("keeps every Workspace under the one root", () => {
    const paths = diffStorePaths(home);

    expect(paths.root).toBe(path.join(home, CODE_COLLAB_DIRECTORY));
    expect(diffStorePath(paths, "wks_0123456789abcdef")).toBe(
      path.join(diffStoreDirectory(paths, "wks_0123456789abcdef"), DIFF_STORE_FILE),
    );
  });

  test("a Workspace id that looks like a path cannot escape the root", () => {
    const paths = diffStorePaths(home);

    // The persisted schema accepts any string, and ids like these are in use, so the directory name
    // is derived rather than taken. None of them may reach outside the root.
    for (const workspaceId of ["../../etc", "/tmp/repo", "", "a/b/c", ".."]) {
      const directory = diffStoreDirectory(paths, workspaceId);
      expect(directory.startsWith(`${paths.root}${path.sep}`)).toBe(true);
      expect(path.relative(paths.root, directory).includes("..")).toBe(false);
    }
  });

  test("distinct ids get distinct directories, and one id is stable", () => {
    const paths = diffStorePaths(home);

    expect(diffStoreDirectory(paths, "wks_a")).not.toBe(diffStoreDirectory(paths, "wks_b"));
    expect(diffStoreDirectory(paths, "wks_a")).toBe(diffStoreDirectory(paths, "wks_a"));
  });

  test("creates the directory private, because it holds Workspace file contents", () => {
    const paths = diffStorePaths(home);

    const created = ensureDiffStorePath(paths, "wks_0123456789abcdef");

    expect(created).toBe(diffStorePath(paths, "wks_0123456789abcdef"));
    const mode = statSync(path.dirname(created)).mode & 0o777;
    // ADR-0031's reason applies here too: the tree holds plaintext content.
    expect(mode).toBe(0o700);
  });
});
