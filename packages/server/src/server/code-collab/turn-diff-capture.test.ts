import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import type { FileObserver, FileObserverCallback } from "../file-observer/index.js";
import { diffStorePaths, ensureDiffStorePath } from "./diff-paths.js";
import { DiffStore } from "./diff-store.js";
import { createTurnDiffCapture, type TurnDiffCapture } from "./turn-diff-capture.js";

const AGENT = "agent-1";
const TURN = "turn-1";

let home: string;
let repo: string;
let store: DiffStore;
let capture: TurnDiffCapture;
let subscribers: Array<(event: AgentManagerEvent) => void>;
let observerCallback: FileObserverCallback | null;
let clock: number;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function write(relativePath: string, content: string): void {
  writeFileSync(path.join(repo, relativePath), content);
}

/** Records the callback so the test can deliver events, as the real observer would. */
function fakeObserver(): FileObserver {
  return {
    subscribe: async (_directory, callback) => {
      observerCallback = callback;
      return { updateIgnore: async () => {}, unsubscribe: async () => {} };
    },
    getDiagnostics: () => ({}) as never,
    close: async () => {},
  };
}

function emit(event: AgentStreamEvent): void {
  for (const subscriber of subscribers.slice()) {
    subscriber({ type: "agent_stream", agentId: AGENT, event });
  }
}

function observed(relativePath: string): void {
  observerCallback?.(null, [{ path: path.join(repo, relativePath), type: "update" }]);
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "capture-home-"));
  repo = mkdtempSync(path.join(tmpdir(), "capture-repo-"));
  clock = Date.parse("2026-01-01T00:00:00.000Z");
  subscribers = [];
  observerCallback = null;

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write("kept.txt", "committed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  store = DiffStore.open({
    path: ensureDiffStorePath(diffStorePaths(home), "wks_0123456789abcdef"),
    now: () => clock,
  });
  capture = createTurnDiffCapture({
    store,
    agents: {
      subscribe: (callback) => {
        subscribers.push(callback);
        return () => {
          const index = subscribers.indexOf(callback);
          if (index >= 0) subscribers.splice(index, 1);
        };
      },
    },
    observer: fakeObserver(),
    ownsAgent: (agentId) => agentId === AGENT,
    cwd: repo,
    now: () => clock,
    headDebounceMs: 1,
  });
  await capture.start();
});

afterEach(async () => {
  await capture.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Recording reads git, so a terminal event cannot wait for it. The capture exposes the same promise
 * shutdown waits on, which is what an assertion has to wait on too — counting microtasks would not
 * cover a spawned process.
 */
async function settle(): Promise<void> {
  await capture.whenIdle();
}

describe("recording what a turn changed", () => {
  test("records only the files the turn touched, with the committed content as before", async () => {
    emit({ type: "turn_started", provider: "claude", turnId: TURN });
    write("kept.txt", "changed by the turn\n");
    await settle();
    emit({ type: "turn_completed", provider: "claude", turnId: TURN });
    await settle();

    const files = store.turnFiles(TURN);
    expect(files.map((file) => file.path)).toEqual(["kept.txt"]);
    const before = store.readContent(files[0]!.beforeSha256!);
    // git reported the change, and HEAD supplied the before image the store had never seen.
    expect(new TextDecoder().decode(before!)).toBe("committed\n");
    expect(new TextDecoder().decode(store.readContent(files[0]!.afterSha256!)!)).toBe(
      "changed by the turn\n",
    );
  });

  test("a turn with no id is not recorded against one", async () => {
    emit({ type: "turn_started", provider: "claude" });
    write("kept.txt", "orphan edit\n");
    emit({ type: "turn_completed", provider: "claude" });
    await settle();

    // Guessing which turn this belonged to would attribute the work to the wrong one.
    expect(store.listTurns()).toEqual([]);
  });

  test("another Agent's turn is not this store's business", async () => {
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
    await settle();

    expect(store.listTurns()).toEqual([]);
  });

  test("a human edit during the turn is attributed to that turn", async () => {
    emit({ type: "turn_started", provider: "claude", turnId: TURN });
    // Untracked, so git status sees it too; the observer is what catches it in a non-git Workspace.
    write("by-hand.txt", "typed while the turn ran\n");
    observed("by-hand.txt");
    await settle();
    emit({ type: "turn_completed", provider: "claude", turnId: TURN });
    await settle();

    expect(store.turnFiles(TURN).map((file) => file.path)).toContain("by-hand.txt");
  });

  test("an edit outside a turn moves the head instead of joining the next turn", async () => {
    write("kept.txt", "edited between turns\n");
    observed("kept.txt");
    // The head moves on a debounce, so wait for the timer and then for the work it started.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    const head = store.pathHead("kept.txt");
    expect(head).not.toBeNull();
    expect(new TextDecoder().decode(store.readContent(head!.sha256!)!)).toBe(
      "edited between turns\n",
    );

    // The next turn starts from that edit, not from what HEAD still holds.
    emit({ type: "turn_started", provider: "claude", turnId: TURN });
    write("kept.txt", "then the turn changed it\n");
    await settle();
    emit({ type: "turn_completed", provider: "claude", turnId: TURN });
    await settle();

    const before = store.turnFiles(TURN).find((file) => file.path === "kept.txt")!.beforeSha256!;
    expect(new TextDecoder().decode(store.readContent(before)!)).toBe("edited between turns\n");
  });

  test("a Workspace git cannot report is carried by the observer alone", async () => {
    // ADR-0044 leaves a non-git Workspace to the observer. Without a repository `git status` fails
    // and contributes nothing, so whatever is recorded here came from the observer.
    const plain = mkdtempSync(path.join(tmpdir(), "capture-plain-"));
    const plainStore = DiffStore.open({
      path: ensureDiffStorePath(diffStorePaths(home), "wks_plain"),
      now: () => clock,
    });
    let deliver: FileObserverCallback | null = null;
    const plainCapture = createTurnDiffCapture({
      store: plainStore,
      agents: {
        subscribe: (callback) => {
          subscribers.push(callback);
          return () => {
            const index = subscribers.indexOf(callback);
            if (index >= 0) subscribers.splice(index, 1);
          };
        },
      },
      observer: {
        subscribe: async (_directory, callback) => {
          deliver = callback;
          return { updateIgnore: async () => {}, unsubscribe: async () => {} };
        },
        getDiagnostics: () => ({}) as never,
        close: async () => {},
      },
      ownsAgent: (agentId) => agentId === AGENT,
      cwd: plain,
      now: () => clock,
      headDebounceMs: 1,
    });
    await plainCapture.start();

    try {
      emit({ type: "turn_started", provider: "claude", turnId: "turn-plain" });
      writeFileSync(path.join(plain, "note.md"), "written outside git\n");
      deliver!(null, [{ path: path.join(plain, "note.md"), type: "create" }]);
      emit({ type: "turn_completed", provider: "claude", turnId: "turn-plain" });
      await plainCapture.whenIdle();

      expect(plainStore.turnFiles("turn-plain").map((file) => file.path)).toEqual(["note.md"]);
    } finally {
      await plainCapture.close();
      plainStore.close();
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("a turn that ended without starting records nothing", async () => {
    emit({ type: "turn_completed", provider: "claude", turnId: "never-started" });
    await settle();

    expect(store.listTurns()).toEqual([]);
  });
});
