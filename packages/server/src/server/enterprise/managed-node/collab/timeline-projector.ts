import type { AgentStreamEvent } from "@getpaseo/protocol/agent-types";
import { formatCollabSegment } from "@getpaseo/protocol/enterprise-collaboration";

import type { AgentManagerEvent } from "../../../agent/agent-manager.js";
import { toAgentPayload } from "../../../agent/agent-projections.js";
import type { CollabRepoStore } from "./loro-repo-store.js";

/**
 * Publishes one Agent's session document (ADR-0031, ADR-0032).
 *
 * The node is the only writer of `s:<agentId>`, so everything a collaborator sees about an Agent
 * arrives through here. Three things live in the document: `meta`, the Agent's projected state;
 * `rows`, the committed timeline keyed by `<epoch>/<seq>`; and `stream`, whatever the current turn
 * has emitted but not committed.
 *
 * Only `toAgentPayload` decides what `meta` carries. It names each field it emits rather than
 * removing the ones it must not, so the credentials, cookies, system prompts and MCP server
 * definitions ADR-0031 keeps off the plane are absent by construction — a field added to the Agent
 * later does not silently start replicating.
 *
 * Streaming deltas are coalesced: a turn emits them faster than a stream should carry appends, and
 * every one of them is superseded by the committed row that follows. `flush` is called on the
 * interval and whenever a turn ends, so nothing waits on a timer to become visible.
 */

export const STREAM_THROTTLE_MS = 250;

/** Loro map keys inside a session document. */
const META_KEY = "meta";
const ROWS_KEY = "rows";
const STREAM_KEY = "stream";

export interface TimelineProjectorOptions {
  readonly store: CollabRepoStore;
  readonly agentId: string;
  readonly throttleMs?: number;
  readonly now?: () => number;
}

export interface AgentSubscription {
  subscribe(
    callback: (event: AgentManagerEvent) => void,
    options?: { agentId?: string; replayState?: boolean },
  ): () => void;
}

export class TimelineProjector {
  private readonly segment: string;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private pending: {
    readonly event: Extract<AgentManagerEvent, { type: "agent_stream" }>;
    readonly stream: Extract<AgentStreamEvent, { type: "timeline" }>;
    readonly turnId: string | null;
    readonly text: string;
  } | null = null;
  private lastStreamAt = -Infinity;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: TimelineProjectorOptions) {
    this.segment = formatCollabSegment({ kind: "session", agentId: options.agentId });
    this.throttleMs = options.throttleMs ?? STREAM_THROTTLE_MS;
    this.now = options.now ?? Date.now;
  }

  /** The segment this projector owns, which is what the uplink flushes. */
  get segmentName(): string {
    return this.segment;
  }

  /**
   * Starts projecting. `replayState` is left on so the document is brought up to date with the
   * Agent as it stands, rather than only with what happens after this call.
   */
  attach(agents: AgentSubscription): void {
    if (this.unsubscribe) throw new Error("timeline projector is already attached");
    this.unsubscribe = agents.subscribe((event) => this.handleEvent(event), {
      agentId: this.options.agentId,
      replayState: true,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.commitPending();
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  handleEvent(event: AgentManagerEvent): void {
    if (this.stopped) return;
    switch (event.type) {
      case "agent_state":
        if (event.agent.id !== this.options.agentId) return;
        this.writeMeta(event);
        return;
      case "timeline_replacement":
        if (event.agentId !== this.options.agentId) return;
        this.replaceEpoch(event.epoch);
        return;
      case "agent_stream":
        if (event.agentId !== this.options.agentId) return;
        this.handleStream(event);
        return;
      case "provider_subagent":
        // Subagents have their own documents; nothing about them belongs in this one.
        return;
    }
  }

  /** Publishes the in-flight text now, whatever the throttle would have said. */
  flush(): void {
    if (!this.pending) return;
    this.writeStream(this.pending.turnId, this.pending.text);
  }

  private writeStream(turnId: string | null, text: string): void {
    this.lastStreamAt = this.now();
    this.options.store.applyLocalChange(this.segment, (document) => {
      const stream = document.getMap(STREAM_KEY);
      stream.set("turnId", turnId);
      stream.set("text", text);
    });
  }

  /**
   * Turns the in-flight text into a committed row and empties the stream key. Called when the turn
   * ends and when a different kind of item arrives, because either one makes the text final.
   */
  private commitPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.commitRow(pending.event, pending.stream);
  }

  private writeMeta(event: Extract<AgentManagerEvent, { type: "agent_state" }>): void {
    const payload = toAgentPayload(event.agent);
    this.options.store.applyLocalChange(this.segment, (document) => {
      const meta = document.getMap(META_KEY);
      for (const [key, value] of Object.entries(payload)) {
        meta.set(key, value as never);
      }
    });
  }

  private handleStream(event: Extract<AgentManagerEvent, { type: "agent_stream" }>): void {
    const stream = event.event;
    if (stream.type === "timeline") {
      // Assistant text is re-sent in full as it grows, so a turn would otherwise append a row per
      // keystroke-sized revision. Hold the latest, publish it to the stream key at most every
      // throttle window, and commit one row when it stops growing.
      if (stream.item.type === "assistant_message") {
        this.pending = {
          event,
          stream,
          turnId: stream.turnId ?? null,
          text: stream.item.text,
        };
        if (this.now() - this.lastStreamAt >= this.throttleMs) this.flush();
        return;
      }
      // Anything else is discrete. Commit the text that came before it first, or a tool call would
      // land in the document ahead of the sentence that introduced it.
      this.commitPending();
      this.commitRow(event, stream);
      return;
    }
    // A turn ending makes the text final whichever way it ended.
    if (
      stream.type === "turn_completed" ||
      stream.type === "turn_failed" ||
      stream.type === "turn_canceled"
    ) {
      this.commitPending();
    }
  }

  /**
   * Appends a committed row. Keyed by epoch and sequence so two nodes replaying the same timeline
   * converge on one row rather than appending twice, and so a reader can order rows without
   * depending on the order updates happened to arrive.
   */
  private commitRow(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    stream: Extract<AgentStreamEvent, { type: "timeline" }>,
  ): void {
    const epoch = event.epoch ?? "0";
    const seq = event.seq ?? 0;
    const row = {
      seq,
      timestamp: stream.timestamp ?? event.timestamp ?? new Date(this.now()).toISOString(),
      item: stream.item,
      ...(stream.turnId ? { turnId: stream.turnId } : {}),
    };
    this.options.store.applyLocalChange(this.segment, (document) => {
      document.getMap(ROWS_KEY).set(`${epoch}/${String(seq).padStart(12, "0")}`, row as never);
      // The committed row supersedes whatever was streaming toward it.
      document.getMap(STREAM_KEY).set("text", "");
    });
  }

  private replaceEpoch(epoch: string): void {
    this.options.store.applyLocalChange(this.segment, (document) => {
      // ADR-0032: a timeline that no longer matches Provider history starts a new epoch and is
      // published as a replacement. Old rows stay; readers follow `currentEpoch`.
      document.getMap(META_KEY).set("currentEpoch", epoch);
    });
  }
}
