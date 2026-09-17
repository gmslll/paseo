import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { FileObserver, FileObserverCallback } from "../file-observer/index.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
  type WorkspaceMutation,
} from "../workspace-registry.js";
import { diffStorePath, diffStorePaths } from "./diff-paths.js";
import { createTurnDiffRuntime, type TurnDiffRuntime } from "./turn-diff-runtime.js";

const WORKSPACE = "wks_0123456789abcdef";
const AGENT = "agent-1";
const TURN = "turn-1";

let home: string;
let repo: string;
let runtime: TurnDiffRuntime;
let subscribers: Array<(event: AgentManagerEvent) => void>;
let observerCallback: FileObserverCallback | null;
let subscribeCount: number;
let workspaces: Map<string, PersistedWorkspaceRecord>;
let mutationListeners: Array<(mutation: WorkspaceMutation) => void | Promise<void>>;
let clock: number;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function write(relativePath: string, content: string): void {
  writeFileSync(path.join(repo, relativePath), content);
}

function workspaceRecord(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: WORKSPACE,
    projectId: "prj_1",
    cwd: repo,
    kind: "directory",
    displayName: "repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function emit(event: AgentStreamEvent): void {
  for (const subscriber of subscribers.slice()) {
    subscriber({ type: "agent_stream", agentId: AGENT, event });
  }
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "turn-diff-home-"));
  repo = mkdtempSync(path.join(tmpdir(), "turn-diff-repo-"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
  subscribers = [];
  observerCallback = null;
  subscribeCount = 0;
  mutationListeners = [];
  workspaces = new Map([[WORKSPACE, workspaceRecord()]]);

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("kept.txt", "committed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  const observer: FileObserver = {
    subscribe: async (_directory, callback) => {
      subscribeCount += 1;
      observerCallback = callback;
      return { updateIgnore: async () => {}, unsubscribe: async () => {} };
    },
    getDiagnostics: () => ({}) as never,
    close: async () => {},
  };

  runtime = createTurnDiffRuntime({
    paseoHome: home,
    observer,
    agents: {
      subscribe: (callback) => {
        subscribers.push(callback);
        return () => {
          const index = subscribers.indexOf(callback);
          if (index >= 0) subscribers.splice(index, 1);
        };
      },
      getAgent: (id) => (id === AGENT ? { workspaceId: WORKSPACE } : null),
    },
    workspaces: {
      list: async () => [...workspaces.values()],
      get: async (id) => workspaces.get(id) ?? null,
      subscribeToMutations: (listener) => {
        mutationListeners.push(listener);
        return () => {
          const index = mutationListeners.indexOf(listener);
          if (index >= 0) mutationListeners.splice(index, 1);
        };
      },
    },
    logger: createTestLogger(),
    now: () => clock,
  });
  await runtime.start();
});

afterEach(async () => {
  await runtime.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("turn diff runtime", () => {
  test("a finished turn is listed and its files can be read", async () => {
    emit({ type: "turn_started", provider: "claude", turnId: TURN });
    write("kept.txt", "changed by the turn\n");
    observerCallback?.(null, [{ path: path.join(repo, "kept.txt"), type: "update" }]);
    emit({ type: "turn_completed", provider: "claude", turnId: TURN });
    await runtime.whenIdle();

    const listed = await runtime.listTurns({ workspaceId: WORKSPACE, agentId: AGENT });
    expect(listed).toEqual([
      {
        turnId: TURN,
        agentId: AGENT,
        startedAt: new Date(clock).toISOString(),
        endedAt: new Date(clock).toISOString(),
        fileCount: 1,
      },
    ]);
    const files = await runtime.getFiles({ workspaceId: WORKSPACE, turnId: TURN });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("kept.txt");
    expect(files[0]!.additions).toBeGreaterThan(0);
  });

  test("another Agent's turn is not listed for this Workspace", async () => {
    for (const subscriber of subscribers.slice()) {
      subscriber({
        type: "agent_stream",
        agentId: "agent-elsewhere",
        event: { type: "turn_started", provider: "claude", turnId: "turn-x" },
      });
      subscriber({
        type: "agent_stream",
        agentId: "agent-elsewhere",
        event: { type: "turn_completed", provider: "claude", turnId: "turn-x" },
      });
    }
    await runtime.whenIdle();

    expect(await runtime.listTurns({ workspaceId: WORKSPACE })).toEqual([]);
  });

  test("archive deletes the store so the next Workspace does not inherit it", async () => {
    emit({ type: "turn_started", provider: "claude", turnId: TURN });
    write("kept.txt", "changed by the turn\n");
    emit({ type: "turn_completed", provider: "claude", turnId: TURN });
    await runtime.whenIdle();
    expect(existsSync(diffStorePath(diffStorePaths(home), WORKSPACE))).toBe(true);

    const archived = workspaceRecord({ archivedAt: "2026-01-02T00:00:00.000Z" });
    workspaces.delete(WORKSPACE);
    for (const listener of mutationListeners.slice()) {
      await listener({ kind: "archive", workspaceId: WORKSPACE, workspace: archived });
    }

    expect(await runtime.listTurns({ workspaceId: WORKSPACE })).toEqual([]);
    expect(existsSync(diffStorePath(diffStorePaths(home), WORKSPACE))).toBe(false);
  });

  test("the injected observer is the one capture subscribes to", () => {
    // WorkspaceGitService already holds one recursive watcher. A second would double inotify/FSEvents.
    expect(subscribeCount).toBe(1);
  });
});
