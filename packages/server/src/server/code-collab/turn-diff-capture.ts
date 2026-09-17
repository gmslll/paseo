import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { runGitCommand } from "../../utils/run-git-command.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { getAgentStreamEventTurnId, isTurnTerminalStreamEvent } from "../agent/agent-sdk-types.js";
import type { FileChange, FileObserver, FileObserverSubscription } from "../file-observer/index.js";
import type { DiffStore, RecordedContent, TurnFileInput } from "./diff-store.js";

// Recording what each turn changed (ADR-0044). The changed path set is the union of what the file
// observer saw and what git reports, because neither alone is enough: git misses a Workspace that
// is not a repository, and the observer misses what changed while it was catching up.

const DEFAULT_HEAD_DEBOUNCE_MS = 2_000;

const READ_ONLY_GIT_ENV = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

/** Nothing to record: a turn nobody is recorded as owning, or one that touched no file. */
const ABSENT: RecordedContent = { kind: "missing", sha256: null };

export interface TurnDiffCaptureOptions {
  readonly store: DiffStore;
  readonly agents: { subscribe(callback: (event: AgentManagerEvent) => void): () => void };
  readonly observer: FileObserver;
  /** Which Agents' turns belong to this store. */
  readonly ownsAgent: (agentId: string) => boolean;
  readonly cwd: string;
  readonly now?: () => number;
  /** How long an edit outside a turn waits before it becomes the next turn's before image. */
  readonly headDebounceMs?: number;
}

export interface TurnDiffCapture {
  start(): Promise<void>;
  /**
   * Resolves once the work already dispatched has finished.
   *
   * Recording a turn reads git, which takes as long as it takes, so the terminal event cannot wait
   * for it. Shutdown and anyone reading the store straight afterwards still have to.
   */
  whenIdle(): Promise<void>;
  /** Exposed for the caller that drives shutdown; safe to call twice. */
  close(): Promise<void>;
}

interface PendingTurn {
  readonly turnId: string;
  readonly agentId: string;
  readonly startedAt: number;
  readonly touched: Set<string>;
}

export function createTurnDiffCapture(options: TurnDiffCaptureOptions): TurnDiffCapture {
  const now = options.now ?? Date.now;
  const debounceMs = options.headDebounceMs ?? DEFAULT_HEAD_DEBOUNCE_MS;
  const pending = new Map<string, PendingTurn>();
  const outsideTurn = new Set<string>();
  let headTimer: NodeJS.Timeout | null = null;
  // One chain rather than loose promises: two turns ending together would otherwise interleave
  // their git reads and their path-head writes, and close() would have nothing to wait for.
  let tail: Promise<void> = Promise.resolve();
  let unsubscribeAgents: (() => void) | null = null;
  let subscription: FileObserverSubscription | null = null;
  let closed = false;

  function relative(absolute: string): string | null {
    const value = path.relative(options.cwd, absolute);
    // Something outside the Workspace is not this store's business.
    return value.length > 0 && !value.startsWith("..") ? value : null;
  }

  function noteChange(change: FileChange): void {
    const filePath = relative(change.path);
    if (!filePath) return;
    if (pending.size > 0) {
      // A human edit during a turn belongs to that turn (ADR-0044), so every open turn takes it.
      for (const turn of pending.values()) turn.touched.add(filePath);
      return;
    }
    outsideTurn.add(filePath);
    scheduleHeadUpdate();
  }

  function track(work: () => Promise<void>): void {
    tail = tail.then(work).catch(() => undefined);
  }

  function scheduleHeadUpdate(): void {
    if (headTimer || closed) return;
    headTimer = setTimeout(() => {
      headTimer = null;
      track(applyHeadUpdates);
    }, debounceMs);
    headTimer.unref?.();
  }

  /**
   * Moves the heads for edits made outside a turn, so the next turn's before image is what the file
   * actually held rather than what the last turn left.
   */
  async function applyHeadUpdates(): Promise<void> {
    const paths = [...outsideTurn];
    outsideTurn.clear();
    for (const filePath of paths) {
      if (closed) return;
      options.store.setPathHead(filePath, readWorkingCopy(filePath));
    }
  }

  function readWorkingCopy(filePath: string): RecordedContent {
    const absolute = path.join(options.cwd, filePath);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      return ABSENT;
    }
    if (stats.isSymbolicLink()) return { kind: "symlink", sha256: null };
    if (!stats.isFile()) return ABSENT;
    try {
      return options.store.putContent(readFileSync(absolute));
    } catch {
      return ABSENT;
    }
  }

  /** What the turn started from: the head this store recorded, then HEAD, then nothing. */
  async function beforeImageOf(filePath: string): Promise<RecordedContent> {
    const head = options.store.pathHead(filePath);
    if (head) return head;
    const committed = await readCommittedBlob(options.cwd, filePath);
    return committed ? options.store.putContent(committed) : ABSENT;
  }

  async function changedPaths(turn: PendingTurn): Promise<string[]> {
    const fromGit = await gitChangedPaths(options.cwd);
    return [...new Set([...turn.touched, ...fromGit])].sort();
  }

  async function recordTurn(turn: PendingTurn): Promise<void> {
    if (closed) return;
    const paths = await changedPaths(turn);
    if (closed) return;
    const files: TurnFileInput[] = [];
    for (const filePath of paths) {
      const before = await beforeImageOf(filePath);
      files.push({ path: filePath, before, after: readWorkingCopy(filePath) });
    }
    options.store.recordTurn({
      turnId: turn.turnId,
      agentId: turn.agentId,
      startedAt: turn.startedAt,
      endedAt: now(),
      files,
    });
  }

  function handleEvent(event: AgentManagerEvent): void {
    if (closed || event.type !== "agent_stream") return;
    if (!options.ownsAgent(event.agentId)) return;
    const turnId = getAgentStreamEventTurnId(event.event);
    // A turn with no id cannot be recorded against one, and guessing would attribute work to the
    // wrong turn.
    if (!turnId) return;

    if (event.event.type === "turn_started") {
      pending.set(turnId, {
        turnId,
        agentId: event.agentId,
        startedAt: now(),
        // Edits already queued belong to this turn: they happened while it was starting.
        touched: new Set(outsideTurn),
      });
      outsideTurn.clear();
      return;
    }
    if (!isTurnTerminalStreamEvent(event.event)) return;
    const turn = pending.get(turnId);
    if (!turn) return;
    pending.delete(turnId);
    track(() => recordTurn(turn));
  }

  return {
    async start(): Promise<void> {
      if (closed) throw new Error("turn diff capture is closed");
      unsubscribeAgents = options.agents.subscribe(handleEvent);
      subscription = await options.observer.subscribe(options.cwd, (error, events) => {
        if (error) return;
        for (const change of events) noteChange(change);
      });
    },
    whenIdle(): Promise<void> {
      return tail;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (headTimer) clearTimeout(headTimer);
      headTimer = null;
      unsubscribeAgents?.();
      unsubscribeAgents = null;
      await subscription?.unsubscribe();
      subscription = null;
      // Work already in flight holds the store open; dropping it here is what wrote to a closed
      // database.
      await tail;
    },
  };
}

/**
 * The paths git reports as changed, or none when this is not a repository.
 *
 * ADR-0044 leaves a non-git Workspace to the observer alone, so a failure here is an empty set
 * rather than an error: the union still carries what the observer saw.
 */
async function gitChangedPaths(cwd: string): Promise<string[]> {
  try {
    const result = await runGitCommand(["--literal-pathspecs", "status", "--porcelain=v1", "-z"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const paths: string[] = [];
    for (const token of result.stdout.split("\0")) {
      // `XY <path>`: two status columns, a space, then the path.
      if (token.length < 4) continue;
      paths.push(token.slice(3));
    }
    return paths;
  } catch {
    return [];
  }
}

async function readCommittedBlob(cwd: string, filePath: string): Promise<Uint8Array | null> {
  try {
    const result = await runGitCommand(["show", `HEAD:${filePath}`], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    return new TextEncoder().encode(result.stdout);
  } catch {
    return null;
  }
}
