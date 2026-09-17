import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";

import { ensurePrivateDirectory } from "../private-files.js";

// Layout for the per-turn diff store (ADR-0044). The tree holds Workspace file contents, so every
// directory is created 0700 for the same reason ADR-0031 gives the collaboration replica.

export const CODE_COLLAB_DIRECTORY = "code-collab";
export const DIFF_STORE_FILE = "diff-store.sqlite3";

export interface DiffStorePaths {
  readonly root: string;
}

export function diffStorePaths(paseoHome: string): DiffStorePaths {
  return Object.freeze({ root: path.join(paseoHome, CODE_COLLAB_DIRECTORY) });
}

/**
 * The directory holding one Workspace's store, named by the hash of its id rather than the id.
 *
 * A Workspace id is a bare string: `generateWorkspaceId` produces `wks_<hex>`, but the persisted
 * schema accepts anything and ids like `/tmp/repo` and `""` are in use. Validating a shape the type
 * does not guarantee would refuse Workspaces the rest of the daemon serves, and joining the id
 * directly would let one escape this root. Hashing settles both: every id yields exactly one safe
 * segment, which is what the daemon already does wherever a name has to reach the filesystem.
 */
export function diffStoreDirectory(paths: DiffStorePaths, workspaceId: string): string {
  const digest = createHash("sha256").update(workspaceId, "utf8").digest("hex");
  return path.join(paths.root, digest);
}

export function diffStorePath(paths: DiffStorePaths, workspaceId: string): string {
  return path.join(diffStoreDirectory(paths, workspaceId), DIFF_STORE_FILE);
}

/** Creates the Workspace's directory 0700 and returns the database path inside it. */
export function ensureDiffStorePath(paths: DiffStorePaths, workspaceId: string): string {
  ensurePrivateDirectory(diffStoreDirectory(paths, workspaceId));
  return diffStorePath(paths, workspaceId);
}

/** Drops the Workspace's store directory. Missing is a no-op: archive can race with a first write. */
export function removeDiffStore(paths: DiffStorePaths, workspaceId: string): void {
  rmSync(diffStoreDirectory(paths, workspaceId), { recursive: true, force: true });
}
