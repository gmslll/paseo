import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { PersistedWorkspaceRecord } from "../../../workspace-registry.js";
import { collabPaths, ensureCollabRepoPath } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";
import { MetaProjector, type MetaWorkspaceStore } from "./meta-projector.js";

const CONTAINER = "cws_0123456789abcdef";
const WORKSPACE_ID = "wks_local_1";
const SEGMENT = "wf";

let directory: string;
let clock: number;
let store: CollabRepoStore;
let record: PersistedWorkspaceRecord;

function baseRecord(): PersistedWorkspaceRecord {
  return {
    workspaceId: WORKSPACE_ID,
    projectId: "prj_1",
    cwd: "/tmp/project",
    kind: "worktree",
    displayName: "feature/refactor",
    title: null,
    branch: "feature/refactor",
    baseBranch: "main",
    worktreeRoot: "/tmp/project",
    mainRepoRoot: "/tmp/repo",
    isPaseoOwnedWorktree: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
  } as PersistedWorkspaceRecord;
}

/** Only the two methods the projector uses, which is what its option type asks for. */
function registry(): MetaWorkspaceStore {
  return {
    get: async (workspaceId: string) => (workspaceId === WORKSPACE_ID ? record : null),
    update: async (
      workspaceId: string,
      updater: (current: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ) => {
      if (workspaceId !== WORKSPACE_ID) return null;
      record = updater(record);
      return record;
    },
  };
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "meta-projector-"));
  clock = Date.parse("2025-06-01T00:00:00.000Z");
  record = baseRecord();
  store = CollabRepoStore.open({
    path: ensureCollabRepoPath(collabPaths(directory), CONTAINER),
    now: () => clock,
  });
  store.beginProducerEpoch(SEGMENT, "nod_0123456789abcdef");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function projector(): MetaProjector {
  return new MetaProjector({
    store,
    containerId: CONTAINER,
    workspaceId: WORKSPACE_ID,
    registry: registry(),
    now: () => clock,
  });
}

function meta(): Record<string, unknown> {
  const document = store.document(SEGMENT).toJSON() as { meta?: Record<string, unknown> };
  return document.meta ?? {};
}

/** Writes a key into the document the way a collaborator's update would arrive. */
function editorWrites(key: string, value: unknown): void {
  store.applyLocalChange(SEGMENT, (document) => {
    document.getMap("meta").set(key, value as never);
  });
}

describe("publishing the node's view", () => {
  test("carries the derived fields and the two an editor owns", () => {
    projector().publish(record);

    const published = meta();
    expect(published.cwd).toBe("/tmp/project");
    expect(published.displayName).toBe("feature/refactor");
    expect(published.branch).toBe("feature/refactor");
    expect(published.title).toBeNull();
    expect(published.pinnedAt).toBeNull();
  });
});

describe("what an editor may change", () => {
  test("persists a title and publishes what was stored", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("title", "  Refactor the parser  ");

    const result = await subject.reconcile();

    // Trimmed the same way workspace.title.set trims it on a direct connection.
    expect(result.applied).toEqual(["title"]);
    expect(record.title).toBe("Refactor the parser");
    expect(meta().title).toBe("Refactor the parser");
  });

  test("persists a pin", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("pinnedAt", "2025-06-01T12:00:00.000Z");

    const result = await subject.reconcile();

    expect(result.applied).toEqual(["pinnedAt"]);
    expect(record.pinnedAt).toBe("2025-06-01T12:00:00.000Z");
  });

  test("clears a title back to the derived name", async () => {
    record = { ...record, title: "Old name" } as PersistedWorkspaceRecord;
    const subject = projector();
    subject.publish(record);
    editorWrites("title", "   ");

    await subject.reconcile();

    expect(record.title).toBeNull();
  });

  test("writes nothing when the document agrees with the record", async () => {
    const subject = projector();
    subject.publish(record);
    const before = store.listPendingUpdates(SEGMENT).length;

    const result = await subject.reconcile();

    expect(result).toEqual({ applied: [], corrected: [] });
    expect(store.listPendingUpdates(SEGMENT)).toHaveLength(before);
  });
});

describe("what an editor may not change", () => {
  test("refuses a derived field and publishes the node's value back", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("cwd", "/tmp/somewhere-else");

    const result = await subject.reconcile();

    expect(result.corrected).toContain("cwd");
    expect(record.cwd).toBe("/tmp/project");
    // Refusing quietly would leave the replica believing the move took.
    expect(meta().cwd).toBe("/tmp/project");
  });

  test("refuses the trust marker, which gates automation", async () => {
    const subject = projector();
    subject.publish(record);
    // A real divergence rather than null over an absent field: writing null where the node also
    // holds null is indistinguishable from agreeing, so it is not something reconcile can refuse.
    editorWrites("untrustedSource", { kind: "hook", url: "https://example.test/hook" });

    const result = await subject.reconcile();

    expect(result.corrected).toContain("untrustedSource");
    expect(record.untrustedSource).toBeUndefined();
  });

  test("refuses the ownership revision rather than accept a transfer from a client", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("ownershipRevision", "own_9999999999999999");

    const result = await subject.reconcile();

    // ADR-0027 owns transfers. Taking this from a document would be privilege escalation.
    expect(result.corrected).toContain("ownershipRevision");
    expect(record.ownershipRevision).toBeUndefined();
  });

  test("refuses a title that is not a string and leaves the record alone", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("title", 42);

    const result = await subject.reconcile();

    expect(result.applied).toEqual([]);
    expect(result.corrected).toContain("title");
    expect(record.title).toBeNull();
    expect(meta().title).toBeNull();
  });

  test("refuses a pin that is not a timestamp", async () => {
    const subject = projector();
    subject.publish(record);
    editorWrites("pinnedAt", "whenever");

    const result = await subject.reconcile();

    expect(result.corrected).toContain("pinnedAt");
    expect(record.pinnedAt).toBeNull();
  });
});
