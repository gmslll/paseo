import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentManagerEvent } from "../../../agent/agent-manager.js";
import type { ManagedAgent } from "../../../agent/agent-projections.js";
import type {
  AgentPermissionRequest,
  AgentSession,
  AgentTimelineItem,
} from "../../../agent/agent-sdk-types.js";
import { collabPaths, ensureCollabRepoPath } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";
import { TimelineProjector } from "./timeline-projector.js";

const AGENT_ID = "agent-123";
const CONTAINER = "cws_0123456789abcdef";
const SEGMENT = `s:${AGENT_ID}`;

let directory: string;
let clock: number;
let store: CollabRepoStore;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "timeline-projector-"));
  clock = 1_700_000_000_000;
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

function projector(throttleMs = 250): TimelineProjector {
  return new TimelineProjector({ store, agentId: AGENT_ID, throttleMs, now: () => clock });
}

/** Mirrors the fixture in agent-projections.test.ts, trimmed to what toAgentPayload reads. */
function managedAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id: AGENT_ID,
    provider: "claude",
    cwd: "/tmp/project",
    session: {} as AgentSession,
    sessionId: "session-123",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: {
      provider: "claude",
      cwd: "/tmp/project",
      model: "claude-3.5-sonnet",
      // ADR-0031 keeps these off the plane. They are set here so the test can prove they do not
      // reach the document rather than assume it.
      systemPrompt: "a secret system prompt",
      mcpServers: { secret: { command: "nc", args: ["10.0.0.1", "4444"] } },
    },
    lifecycle: "idle",
    createdAt: now,
    updatedAt: now,
    availableModes: [{ id: "plan", label: "Planning" }],
    currentModeId: "plan",
    pendingPermissions: new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: { provider: "claude", sessionId: "session-123" },
    persistence: { provider: "claude", sessionId: "persist-1" },
    lastUsage: undefined,
    lastError: undefined,
    historyPrimed: true,
    lastUserMessageAt: now,
    attention: { requiresAttention: false },
    labels: [],
    ...overrides,
  } as ManagedAgent;
}

function timelineEvent(
  item: AgentTimelineItem,
  input: { seq: number; epoch?: string; turnId?: string },
): AgentManagerEvent {
  return {
    type: "agent_stream",
    agentId: AGENT_ID,
    seq: input.seq,
    epoch: input.epoch ?? "ep1",
    event: {
      type: "timeline",
      provider: "claude",
      item,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      timestamp: "2025-01-01T00:00:02.000Z",
    },
  };
}

function document() {
  return store.document(SEGMENT).toJSON() as {
    meta?: Record<string, unknown>;
    rows?: Record<string, { item: AgentTimelineItem; seq: number }>;
    stream?: { turnId: string | null; text: string };
  };
}

describe("projecting an Agent's state", () => {
  test("publishes the wire projection and nothing the plane must not hold", () => {
    projector().handleEvent({ type: "agent_state", agent: managedAgent() });

    const meta = document().meta!;
    expect(meta.id).toBe(AGENT_ID);
    expect(meta.provider).toBe("claude");
    expect(meta.model).toBe("claude-3.5-sonnet");
    // toAgentPayload names the fields it emits, so these are absent by construction rather than by
    // a deny list that a new field could slip past.
    expect(JSON.stringify(document())).not.toContain("a secret system prompt");
    expect(JSON.stringify(document())).not.toContain("4444");
    expect(meta.systemPrompt).toBeUndefined();
    expect(meta.mcpServers).toBeUndefined();
  });

  test("ignores another Agent's events", () => {
    const other = managedAgent({ id: "agent-other" });

    projector().handleEvent({ type: "agent_state", agent: other });

    expect(document().meta).toBeUndefined();
    expect(store.listPendingUpdates(SEGMENT)).toHaveLength(0);
  });
});

describe("committing timeline rows", () => {
  test("keys a row by epoch and sequence so order does not depend on arrival", () => {
    const subject = projector();

    subject.handleEvent(
      timelineEvent({ type: "user_message", text: "do the thing" }, { seq: 7, epoch: "ep2" }),
    );

    const rows = document().rows!;
    expect(Object.keys(rows)).toEqual(["ep2/000000000007"]);
    expect(rows["ep2/000000000007"]!.item).toEqual({ type: "user_message", text: "do the thing" });
  });

  test("queues one update per change rather than a snapshot", () => {
    const subject = projector();
    subject.handleEvent({ type: "agent_state", agent: managedAgent() });
    const afterMeta = store.listPendingUpdates(SEGMENT).length;

    subject.handleEvent(timelineEvent({ type: "user_message", text: "hi" }, { seq: 1 }));

    expect(afterMeta).toBe(1);
    expect(store.listPendingUpdates(SEGMENT)).toHaveLength(2);
  });
});

describe("coalescing assistant text", () => {
  test("holds the growing text instead of committing a row per revision", () => {
    const subject = projector();

    // The provider re-sends the whole message as it grows; the first one opens the window.
    subject.handleEvent(timelineEvent({ type: "assistant_message", text: "Hel" }, { seq: 1 }));
    subject.handleEvent(timelineEvent({ type: "assistant_message", text: "Hello" }, { seq: 1 }));
    subject.handleEvent(timelineEvent({ type: "assistant_message", text: "Hello wo" }, { seq: 1 }));

    expect(document().rows).toBeUndefined();
    expect(document().stream!.text).toBe("Hel");
  });

  test("publishes again once the throttle window has passed", () => {
    const subject = projector();
    subject.handleEvent(timelineEvent({ type: "assistant_message", text: "Hel" }, { seq: 1 }));
    subject.handleEvent(timelineEvent({ type: "assistant_message", text: "Hello" }, { seq: 1 }));

    clock += 250;
    subject.handleEvent(
      timelineEvent({ type: "assistant_message", text: "Hello world" }, { seq: 1 }),
    );

    expect(document().stream!.text).toBe("Hello world");
    expect(document().rows).toBeUndefined();
  });

  test("commits one row when the turn ends and empties the stream", () => {
    const subject = projector();
    subject.handleEvent(
      timelineEvent({ type: "assistant_message", text: "Hello world" }, { seq: 4, turnId: "t1" }),
    );

    subject.handleEvent({
      type: "agent_stream",
      agentId: AGENT_ID,
      event: { type: "turn_completed", provider: "claude", turnId: "t1" },
    });

    const state = document();
    expect(Object.keys(state.rows!)).toEqual(["ep1/000000000004"]);
    expect(state.rows!["ep1/000000000004"]!.item).toEqual({
      type: "assistant_message",
      text: "Hello world",
    });
    expect(state.stream!.text).toBe("");
  });

  test("commits the text before a discrete item that follows it", () => {
    const subject = projector();
    subject.handleEvent(
      timelineEvent({ type: "assistant_message", text: "Let me look" }, { seq: 2 }),
    );

    // A discrete item must not swallow the sentence that introduced it: both rows exist, and the
    // zero-padded key is what orders them. A reader sorts the keys rather than trusting the order a
    // map hands them back in, which is why this sorts too.
    subject.handleEvent(timelineEvent({ type: "error", message: "nope" }, { seq: 3 }));

    const rows = document().rows!;
    expect(Object.keys(rows).sort()).toEqual(["ep1/000000000002", "ep1/000000000003"]);
    expect(rows["ep1/000000000002"]!.item).toEqual({
      type: "assistant_message",
      text: "Let me look",
    });
    expect(rows["ep1/000000000003"]!.item).toEqual({ type: "error", message: "nope" });
  });

  test("stopping publishes text the turn never finished", () => {
    const subject = projector();
    subject.handleEvent(
      timelineEvent({ type: "assistant_message", text: "half a th" }, { seq: 9 }),
    );

    subject.stop();

    // A daemon shutting down mid-turn would otherwise leave the last thing said only in memory.
    expect(document().rows!["ep1/000000000009"]!.item).toEqual({
      type: "assistant_message",
      text: "half a th",
    });
  });
});

describe("a replaced timeline", () => {
  test("records the new epoch without disturbing the rows already published", () => {
    const subject = projector();
    subject.handleEvent(timelineEvent({ type: "user_message", text: "first" }, { seq: 1 }));

    subject.handleEvent({ type: "timeline_replacement", agentId: AGENT_ID, epoch: "ep2" });

    // ADR-0032: a mismatch starts a new epoch and publishes a replacement rather than editing rows
    // a reader may already have.
    expect(document().meta!.currentEpoch).toBe("ep2");
    expect(Object.keys(document().rows!)).toEqual(["ep1/000000000001"]);
  });
});
