import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type pino from "pino";

import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { FileObserver } from "../file-observer/index.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceMutation,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import { diffStorePaths, ensureDiffStorePath, removeDiffStore } from "./diff-paths.js";
import { readAllChangesDiff, readTurnDiff } from "./diff-reader.js";
import { DiffStore } from "./diff-store.js";
import { createTurnDiffCapture, type TurnDiffCapture } from "./turn-diff-capture.js";

/** ADR-0044: turns expire after 30 days. */
export const TURN_DIFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** ADR-0044: each Workspace store is capped at 512 MiB compressed. */
export const TURN_DIFF_STORE_CAP_BYTES = 512 * 1024 * 1024;

export interface TurnSummary {
  readonly turnId: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly fileCount: number;
}

export interface TurnDiffControl {
  listTurns(input: {
    workspaceId: string;
    agentId?: string;
    limit?: number;
  }): Promise<TurnSummary[]>;
  getFiles(input: {
    workspaceId: string;
    turnId: string;
    ignoreWhitespace?: boolean;
  }): Promise<ParsedDiffFile[]>;
  getAllChanges(input: {
    workspaceId: string;
    agentId?: string;
    ignoreWhitespace?: boolean;
  }): Promise<ParsedDiffFile[]>;
  close(): Promise<void>;
}

export interface TurnDiffRuntime extends TurnDiffControl {
  start(): Promise<void>;
  /** Resolves once every capture has finished the work already dispatched. */
  whenIdle(): Promise<void>;
}

interface TurnDiffAgents {
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  getAgent(id: string): { workspaceId?: string } | null;
}

interface WorkspaceEntry {
  readonly workspaceId: string;
  readonly store: DiffStore;
  readonly capture: TurnDiffCapture;
}

export interface TurnDiffRuntimeOptions {
  readonly paseoHome: string;
  readonly observer: FileObserver;
  readonly agents: TurnDiffAgents;
  readonly workspaces: Pick<WorkspaceRegistry, "list" | "get"> & {
    subscribeToMutations?(
      listener: (mutation: WorkspaceMutation) => void | Promise<void>,
    ): () => void;
  };
  readonly logger: pino.Logger;
  readonly now?: () => number;
}

export function createTurnDiffRuntime(options: TurnDiffRuntimeOptions): TurnDiffRuntime {
  const paths = diffStorePaths(options.paseoHome);
  const now = options.now ?? Date.now;
  const entries = new Map<string, WorkspaceEntry>();
  let unsubscribeMutations: (() => void) | null = null;
  let closed = false;

  function housekeep(store: DiffStore): void {
    store.evictTurnsBefore(now() - TURN_DIFF_TTL_MS);
    store.enforceSizeCap(TURN_DIFF_STORE_CAP_BYTES);
  }

  function toSummary(row: {
    turnId: string;
    agentId: string;
    startedAt: number;
    endedAt: number | null;
    fileCount: number;
  }): TurnSummary {
    return {
      turnId: row.turnId,
      agentId: row.agentId,
      startedAt: new Date(row.startedAt).toISOString(),
      endedAt: row.endedAt === null ? null : new Date(row.endedAt).toISOString(),
      fileCount: row.fileCount,
    };
  }

  async function attach(workspace: PersistedWorkspaceRecord): Promise<void> {
    if (closed || workspace.archivedAt || entries.has(workspace.workspaceId)) return;
    const store = DiffStore.open({
      path: ensureDiffStorePath(paths, workspace.workspaceId),
      now,
    });
    housekeep(store);
    const capture = createTurnDiffCapture({
      store,
      agents: options.agents,
      observer: options.observer,
      cwd: workspace.cwd,
      now,
      ownsAgent: (agentId) =>
        options.agents.getAgent(agentId)?.workspaceId === workspace.workspaceId,
    });
    try {
      await capture.start();
    } catch (error) {
      store.close();
      options.logger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Turn diff capture failed to start",
      );
      return;
    }
    entries.set(workspace.workspaceId, {
      workspaceId: workspace.workspaceId,
      store,
      capture,
    });
  }

  async function detach(workspaceId: string, removeStore: boolean): Promise<void> {
    const entry = entries.get(workspaceId);
    if (entry) {
      entries.delete(workspaceId);
      await entry.capture.close();
      entry.store.close();
    }
    if (removeStore) removeDiffStore(paths, workspaceId);
  }

  async function ensure(workspaceId: string): Promise<WorkspaceEntry | null> {
    const existing = entries.get(workspaceId);
    if (existing) return existing;
    const workspace = await options.workspaces.get(workspaceId);
    if (!workspace || workspace.archivedAt) return null;
    await attach(workspace);
    return entries.get(workspaceId) ?? null;
  }

  async function handleMutation(mutation: WorkspaceMutation): Promise<void> {
    if (closed) return;
    if (mutation.kind === "archive" || mutation.kind === "remove") {
      await detach(mutation.workspaceId, true);
      return;
    }
    if (mutation.workspace) await attach(mutation.workspace);
  }

  return {
    async start(): Promise<void> {
      if (closed) throw new Error("turn diff runtime is closed");
      for (const workspace of await options.workspaces.list()) {
        await attach(workspace);
      }
      unsubscribeMutations =
        options.workspaces.subscribeToMutations?.((mutation) => {
          void handleMutation(mutation);
        }) ?? null;
    },
    async listTurns(input): Promise<TurnSummary[]> {
      const entry = await ensure(input.workspaceId);
      if (!entry) return [];
      housekeep(entry.store);
      return entry.store.listTurns({ limit: input.limit, agentId: input.agentId }).map(toSummary);
    },
    async getFiles(input): Promise<ParsedDiffFile[]> {
      const entry = await ensure(input.workspaceId);
      if (!entry) return [];
      housekeep(entry.store);
      return readTurnDiff(entry.store, input.turnId, {
        ignoreWhitespace: input.ignoreWhitespace,
      });
    },
    async getAllChanges(input): Promise<ParsedDiffFile[]> {
      const entry = await ensure(input.workspaceId);
      if (!entry) return [];
      housekeep(entry.store);
      return readAllChangesDiff(entry.store, {
        agentId: input.agentId,
        ignoreWhitespace: input.ignoreWhitespace,
      });
    },
    whenIdle(): Promise<void> {
      return Promise.all([...entries.values()].map((entry) => entry.capture.whenIdle())).then(
        () => undefined,
      );
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeMutations?.();
      unsubscribeMutations = null;
      const attached = [...entries.values()];
      entries.clear();
      for (const entry of attached) {
        await entry.capture.close();
        entry.store.close();
      }
    },
  };
}
