import {
  COLLAB_STREAM_LIMITS,
  type CollabSubscriptionEvent,
} from "@getpaseo/protocol/enterprise-collaboration";

import type { StreamMessage, StreamStore } from "./stream-store.js";

// The pure core of a multiplexed subscription (ADR-0032): given one cursor per segment, produce the
// events a subscriber should receive right now. Transport is somebody else's problem — SSE and
// long-poll both call this and differ only in how they frame what comes back.
//
// Every segment named in the cursors gets a control event, including one that had nothing new, so a
// subscriber always learns where to resume and whether it is caught up.

// A read returns whole rows, and one row may be as large as COLLAB_STREAM_LIMITS.maxAppendBytes, so
// bounding a read by the event budget alone would let a single read materialize up to two thousand
// megabyte rows to fill an eight megabyte queue. Pull in batches and stop once the budget is spent.
// The batch size trades reads against that worst case: 64 rows caps a read at 64 MiB, while real
// updates are small enough that most segments drain in one.
const READ_BATCH_ROWS = 64;

export interface SubscriptionPollInput {
  readonly store: StreamStore;
  readonly containerId: string;
  /** Segment name to the offset the subscriber resumes from, inclusive. */
  readonly cursors: Readonly<Record<string, string>>;
}

export function collectSubscriptionEvents(input: SubscriptionPollInput): CollabSubscriptionEvent[] {
  const events: CollabSubscriptionEvent[] = [];
  // Annotated because COLLAB_STREAM_LIMITS is `as const`: a property access is not a fresh literal,
  // so these would keep the literal types 2000 and 8388608 and refuse to be decremented.
  let remainingEvents: number = COLLAB_STREAM_LIMITS.maxSubscriberQueueEvents;
  let remainingBytes: number = COLLAB_STREAM_LIMITS.maxSubscriberQueueBytes;

  // Sorted so the same cursors always produce the same event order, whatever order the request
  // happened to list its segments in.
  for (const segment of Object.keys(input.cursors).sort()) {
    let result = input.store.read({
      containerId: input.containerId,
      segment,
      fromOffset: input.cursors[segment],
      limit: READ_BATCH_ROWS,
    });
    // Captured from the first read on purpose: `result` is reassigned per batch, and the bound a
    // subscriber is told is the one that held when its poll started.
    const lowerBoundOffset = result.lowerBoundOffset;
    let nextOffset = result.nextOffset;
    let lastEmitted: string | null = null;
    let overflow = false;

    for (;;) {
      // fromOffset is inclusive, so a continuation read hands back the row we stopped on. Offsets
      // are zero-padded decimals, which makes lexical order stream order.
      const batch: StreamMessage[] =
        lastEmitted === null
          ? result.messages
          : result.messages.filter((message) => message.offset > lastEmitted!);
      for (const message of batch) {
        if (remainingEvents === 0 || message.update.byteLength > remainingBytes) {
          overflow = true;
          // Resume at the first message that did not fit, not at the end of the stream.
          nextOffset = message.offset;
          break;
        }
        events.push({
          type: "data",
          containerId: input.containerId,
          segment,
          offset: message.offset,
          update: Buffer.from(message.update).toString("base64"),
        });
        remainingEvents -= 1;
        remainingBytes -= message.update.byteLength;
        lastEmitted = message.offset;
      }
      if (overflow || batch.length === 0 || result.upToDate) break;
      result = input.store.read({
        containerId: input.containerId,
        segment,
        fromOffset: lastEmitted!,
        limit: READ_BATCH_ROWS,
      });
      nextOffset = result.nextOffset;
    }

    events.push({
      type: "control",
      containerId: input.containerId,
      segment,
      nextOffset,
      lowerBoundOffset,
      upToDate: overflow ? false : result.upToDate,
      ...(overflow ? { overflow: true } : {}),
    });
    // Overflow closes the subscription (ADR-0032). Segments after this one are left to the
    // resubscribe, which starts from the cursors the subscriber has just been given.
    if (overflow) break;
  }

  return events;
}
