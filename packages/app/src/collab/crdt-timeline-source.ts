/**
 * Pages a session document's committed rows by epoch and sequence (ADR-0031).
 *
 * The node projector keys rows as `${epoch}/${seq padded to 12}`. This reader orders that map
 * without depending on arrival order, and without touching the existing stream reducer.
 */

export interface SessionTimelineRow {
  readonly seq: number;
  readonly timestamp: string;
  readonly item: unknown;
  readonly turnId?: string;
}

export interface SessionTimelinePage {
  readonly items: readonly SessionTimelineEntry[];
  readonly nextCursor: { epoch: string; seq: number } | null;
  readonly hasOlder: boolean;
}

export interface SessionTimelineEntry {
  readonly epoch: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly turnId?: string;
  readonly item: unknown;
}

const ROW_KEY = /^(.+)\/(\d{12})$/;

export function parseSessionRowKey(key: string): { epoch: string; seq: number } | null {
  const match = ROW_KEY.exec(key);
  if (!match) return null;
  return { epoch: match[1]!, seq: Number(match[2]) };
}

export function pageSessionTimeline(
  rows: Readonly<Record<string, SessionTimelineRow>>,
  options: {
    epoch: string;
    limit: number;
    direction?: "tail" | "before";
    beforeSeq?: number;
  },
): SessionTimelinePage {
  const limit = options.limit;
  const parsed = Object.entries(rows).flatMap(([key, row]) => {
    const identity = parseSessionRowKey(key);
    if (!identity || identity.epoch !== options.epoch) return [];
    return [
      {
        epoch: identity.epoch,
        seq: identity.seq,
        timestamp: row.timestamp,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
      },
    ];
  });
  parsed.sort((left, right) => left.seq - right.seq);

  const direction = options.direction ?? "tail";
  const window =
    direction === "before"
      ? parsed.filter((entry) => entry.seq < (options.beforeSeq ?? Number.POSITIVE_INFINITY))
      : parsed;
  const page = window.slice(-limit);
  const first = page[0];
  const olderThanPage = first ? parsed.some((entry) => entry.seq < first.seq) : parsed.length > 0;
  return {
    items: page,
    nextCursor: first ? { epoch: first.epoch, seq: first.seq } : null,
    hasOlder: olderThanPage,
  };
}
