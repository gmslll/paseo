import {
  AgentTimelineItemPayloadSchema,
  type AgentStreamEventPayload,
} from "@getpaseo/protocol/messages";
import { hydrateStreamState, type StreamItem } from "@/types/stream";
import { pageSessionTimeline, type SessionTimelineRow } from "./crdt-timeline-source";

const DEFAULT_PAGE_LIMIT = 500;

export interface HydratedCollabSession {
  readonly items: StreamItem[];
  readonly head: StreamItem[];
  readonly hasOlder: boolean;
}

/**
 * Turns a session document page into the stream items the existing renderer already knows.
 * Does not write the session store; the collab timeline is a second reader, not a second writer.
 */
export function hydrateCollabSessionDocument(input: {
  epoch: string;
  rows: Readonly<Record<string, SessionTimelineRow>>;
  stream: { turnId: string | null; text: string } | null;
  provider: string;
  limit?: number;
}): HydratedCollabSession {
  const page = pageSessionTimeline(input.rows, {
    epoch: input.epoch,
    limit: input.limit ?? DEFAULT_PAGE_LIMIT,
  });
  const events = page.items.flatMap((entry) => {
    const item = AgentTimelineItemPayloadSchema.safeParse(entry.item);
    if (!item.success) return [];
    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: input.provider,
      item: item.data,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
    };
    return [
      {
        event,
        timestamp: new Date(entry.timestamp),
        timelineCursor: { epoch: entry.epoch, seq: entry.seq },
      },
    ];
  });
  const streamText = input.stream?.text ?? "";
  const head =
    streamText.length > 0
      ? hydrateStreamState([
          {
            event: {
              type: "timeline",
              provider: input.provider,
              item: { type: "assistant_message", text: streamText },
              ...(input.stream?.turnId ? { turnId: input.stream.turnId } : {}),
            },
            timestamp: new Date(),
          },
        ])
      : [];
  return {
    items: hydrateStreamState(events, { source: "canonical" }),
    head,
    hasOlder: page.hasOlder,
  };
}

export function displayedCollabStream(
  collab: { items: StreamItem[] | null; head: StreamItem[] | null },
  daemonItems: StreamItem[],
  daemonHead: StreamItem[] | undefined,
): { items: StreamItem[]; head: StreamItem[] | undefined } {
  if (collab.items === null) {
    return { items: daemonItems, head: daemonHead };
  }
  return { items: collab.items, head: collab.head ?? [] };
}
