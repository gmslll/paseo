import path from "node:path";

import {
  COLLAB_DIRECTORY,
  COLLAB_REPO_FILE,
  ENTERPRISE_DIRECTORY,
  collabContainerKind,
} from "@getpaseo/protocol/enterprise-collaboration";

import { ensurePrivateDirectory } from "../../../private-files.js";

// Layout for the node-side replica (ADR-0032). The tree holds plaintext Workspace content, which
// ADR-0031 accepts only on an encrypted volume, so every directory here is created 0700 rather than
// left to the database helper's plain mkdir.

export interface CollabPaths {
  readonly root: string;
}

export function collabPaths(paseoHome: string): CollabPaths {
  return Object.freeze({
    root: path.join(paseoHome, ENTERPRISE_DIRECTORY, COLLAB_DIRECTORY),
  });
}

/**
 * Container ids are `cws_<16 hex>` or `brd_<16 hex>`, so they never contain a separator or `..`.
 * Validating here keeps a malformed id from escaping the collab root when it reaches path.join.
 */
export function collabContainerDirectory(paths: CollabPaths, containerId: string): string {
  if (collabContainerKind(containerId) === null) {
    throw new Error(`Invalid collaboration container id '${containerId}'`);
  }
  return path.join(paths.root, containerId);
}

export function collabRepoPath(paths: CollabPaths, containerId: string): string {
  return path.join(collabContainerDirectory(paths, containerId), COLLAB_REPO_FILE);
}

/** Creates the container directory 0700 and returns the repository path inside it. */
export function ensureCollabRepoPath(paths: CollabPaths, containerId: string): string {
  ensurePrivateDirectory(collabContainerDirectory(paths, containerId));
  return collabRepoPath(paths, containerId);
}
