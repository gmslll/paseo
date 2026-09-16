import { LoroDoc } from "loro-crdt";

import {
  COLLAB_SEGMENT_COMPACTED,
  COLLAB_STREAM_LIMITS,
  parseCollabSegment,
} from "@getpaseo/protocol/enterprise-collaboration";

import { type SqliteDatabase, transaction } from "../sqlite.js";

// Append-only streams for the collaboration data plane (ADR-0032). One stream per container and
// segment. Producers fence their own writes with an epoch and a sequence, so a producer that
// restarts and replays what it already sent is answered as a duplicate instead of writing the row
// twice.
//
// Offsets are the stream's own sequence, zero-padded so lexical order equals stream order. They are
// deliberately not the producer's sequence: several producers may share a segment, and a reader
// resumes from where the stream is, not from where any one producer is.

const OFFSET_DIGITS = 20;

// `offset` is a SQL keyword, hence `stream_offset`.
export const DATA_PLANE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ds_streams (
  container_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  lower_bound_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (container_id, segment)
);
CREATE TABLE IF NOT EXISTS ds_messages (
  container_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  stream_offset TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_epoch INTEGER NOT NULL,
  producer_seq INTEGER NOT NULL,
  update_bytes BLOB NOT NULL,
  appended_at TEXT NOT NULL,
  PRIMARY KEY (container_id, segment, sequence)
);
CREATE INDEX IF NOT EXISTS ds_messages_by_offset
  ON ds_messages (container_id, segment, stream_offset);
CREATE UNIQUE INDEX IF NOT EXISTS ds_messages_by_producer_seq
  ON ds_messages (container_id, segment, producer_id, producer_seq);
CREATE TABLE IF NOT EXISTS ds_producers (
  container_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (container_id, segment, producer_id)
);
CREATE TABLE IF NOT EXISTS ds_snapshots (
  container_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  upto_sequence INTEGER NOT NULL,
  snapshot_bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (container_id, segment)
);
`;

export interface Clock {
  nowMs(): number;
}

export interface StreamAppendInput {
  containerId: string;
  segment: string;
  producerId: string;
  producerEpoch: number;
  producerSeq: number;
  update: Uint8Array;
}

export type StreamAppendResult =
  | { kind: "appended"; offset: string }
  | { kind: "duplicate"; offset: string | null }
  | { kind: "stale_epoch"; currentEpoch: number }
  | { kind: "gap"; expectedSeq: number }
  | { kind: "too_large"; limitBytes: number }
  | { kind: "closed" };

export interface StreamReadInput {
  containerId: string;
  segment: string;
  /** Inclusive: reading from a message's own offset returns that message again. */
  fromOffset?: string;
  limit?: number;
}

export interface StreamMessage {
  offset: string;
  update: Uint8Array;
}

export interface StreamReadResult {
  messages: StreamMessage[];
  /** The offset a future append will take, so a reader can resume without re-reading. */
  nextOffset: string;
  /** Everything below this has been compacted away; a reader under it needs the snapshot first. */
  lowerBoundOffset: string;
  upToDate: boolean;
  /**
   * Present only when the caller asked for an offset below the lower bound. It carries the state
   * the discarded messages built, so the reader can start from it instead of from history it can
   * no longer fetch (ADR-0032).
   */
  snapshot?: Uint8Array;
}

export interface StreamStore {
  append(input: StreamAppendInput): StreamAppendResult;
  read(input: StreamReadInput): StreamReadResult;
}

function formatOffset(sequence: number): string {
  return String(sequence).padStart(OFFSET_DIGITS, "0");
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("stream message is not binary");
}

interface StreamRow {
  next_sequence: number;
  lower_bound_sequence: number;
  closed_at: string | null;
}

interface ProducerRow {
  epoch: number;
  last_seq: number;
}

/**
 * Folds a segment's stored updates into one snapshot, or declines.
 *
 * Compaction is the only operation here that destroys history, so it refuses on anything it cannot
 * confirm:
 *
 * - only segments ADR-0032 marks as documents, read from the contract's own map rather than a copy;
 * - `pending` from importBatch means an update could not be applied for want of its causal
 *   dependencies, and a snapshot taken then would silently omit it;
 * - the snapshot is re-imported into a fresh document before anything is deleted, so "it restores"
 *   is checked rather than assumed.
 *
 * `{ mode: "snapshot" }` and not `shallow-snapshot`, which keeps only history after a frontier.
 */
function buildSegmentSnapshot(segment: string, updates: Uint8Array[]): Uint8Array | null {
  const parsed = parseCollabSegment(segment);
  if (!parsed || !COLLAB_SEGMENT_COMPACTED[parsed.kind]) return null;

  try {
    const document = new LoroDoc();
    if (document.importBatch(updates).pending !== null) return null;

    const snapshot = document.export({ mode: "snapshot" });
    const restored = new LoroDoc();
    if (restored.importBatch([snapshot]).pending !== null) return null;
    return snapshot;
  } catch {
    // A payload that is not a Loro update at all lands here — a corrupt row, or a segment whose
    // writer sent something else. Compaction declines, because it must never be able to fail the
    // append that triggered it. Refusing leaves the stream exactly as it was.
    return null;
  }
}

export function createStreamStore(options: {
  database: SqliteDatabase;
  clock?: Clock;
  /**
   * Defaults to the contract's thresholds. Configurable because 5,000 updates or 8 MiB is a lot of
   * real CRDT traffic to generate before the behaviour can be observed at all.
   */
  compaction?: { updates?: number; bytes?: number };
}): StreamStore {
  const { database } = options;
  const clock = options.clock ?? { nowMs: () => Date.now() };
  const compactionUpdates = options.compaction?.updates ?? COLLAB_STREAM_LIMITS.compactionUpdates;
  const compactionBytes = options.compaction?.bytes ?? COLLAB_STREAM_LIMITS.compactionBytes;

  const selectStream = database.prepare(
    "SELECT next_sequence, lower_bound_sequence, closed_at FROM ds_streams WHERE container_id = ? AND segment = ?",
  );
  const insertStream = database.prepare(
    "INSERT INTO ds_streams (container_id, segment, next_sequence, lower_bound_sequence, created_at, closed_at) VALUES (?, ?, 1, 1, ?, NULL)",
  );
  const bumpStream = database.prepare(
    "UPDATE ds_streams SET next_sequence = ? WHERE container_id = ? AND segment = ?",
  );
  const selectProducer = database.prepare(
    "SELECT epoch, last_seq FROM ds_producers WHERE container_id = ? AND segment = ? AND producer_id = ?",
  );
  const upsertProducer = database.prepare(
    `INSERT INTO ds_producers (container_id, segment, producer_id, epoch, last_seq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (container_id, segment, producer_id)
     DO UPDATE SET epoch = excluded.epoch, last_seq = excluded.last_seq, updated_at = excluded.updated_at`,
  );
  const insertMessage = database.prepare(
    `INSERT INTO ds_messages
       (container_id, segment, sequence, stream_offset, producer_id, producer_epoch, producer_seq, update_bytes, appended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectMessageOffset = database.prepare(
    "SELECT stream_offset FROM ds_messages WHERE container_id = ? AND segment = ? AND producer_id = ? AND producer_seq = ?",
  );
  const selectMessages = database.prepare(
    `SELECT stream_offset, update_bytes FROM ds_messages
     WHERE container_id = ? AND segment = ? AND stream_offset >= ?
     ORDER BY sequence ASC LIMIT ?`,
  );
  const measureRange = database.prepare(
    `SELECT COUNT(*) AS count, SUM(LENGTH(update_bytes)) AS bytes FROM ds_messages
     WHERE container_id = ? AND segment = ? AND sequence >= ? AND sequence <= ?`,
  );
  const selectRange = database.prepare(
    `SELECT update_bytes FROM ds_messages
     WHERE container_id = ? AND segment = ? AND sequence >= ? AND sequence <= ?
     ORDER BY sequence ASC`,
  );
  const upsertSnapshot = database.prepare(
    `INSERT INTO ds_snapshots (container_id, segment, upto_sequence, snapshot_bytes, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (container_id, segment)
     DO UPDATE SET upto_sequence = excluded.upto_sequence,
       snapshot_bytes = excluded.snapshot_bytes, created_at = excluded.created_at`,
  );
  const deleteRange = database.prepare(
    "DELETE FROM ds_messages WHERE container_id = ? AND segment = ? AND sequence >= ? AND sequence <= ?",
  );
  const setLowerBound = database.prepare(
    "UPDATE ds_streams SET lower_bound_sequence = ? WHERE container_id = ? AND segment = ?",
  );
  const selectSnapshot = database.prepare(
    "SELECT snapshot_bytes FROM ds_snapshots WHERE container_id = ? AND segment = ?",
  );

  function loadStream(containerId: string, segment: string, createdAt: string): StreamRow {
    const existing = selectStream.get(containerId, segment) as StreamRow | undefined;
    if (existing) return existing;
    insertStream.run(containerId, segment, createdAt);
    return { next_sequence: 1, lower_bound_sequence: 1, closed_at: null };
  }

  /**
   * Folds everything from the lower bound through the just-appended sequence into a snapshot, when
   * the segment has grown past either threshold. Runs inside the append transaction, so the
   * snapshot, the deletion, and the new lower bound commit together or not at all.
   *
   * Every refusal leaves the stream exactly as it was. A stream that keeps its history costs disk
   * and nothing else; one compacted on a snapshot that cannot be restored has lost it.
   */
  function compactIfDue(
    containerId: string,
    segment: string,
    lowerBound: number,
    throughSequence: number,
    at: string,
  ): void {
    const totals = measureRange.get(containerId, segment, lowerBound, throughSequence) as
      | { count?: number; bytes?: number | null }
      | undefined;
    const count = Number(totals?.count ?? 0);
    const bytes = Number(totals?.bytes ?? 0);
    if (count < compactionUpdates && bytes < compactionBytes) return;

    const rows = selectRange.all(containerId, segment, lowerBound, throughSequence) as Array<{
      update_bytes: unknown;
    }>;
    const snapshot = buildSegmentSnapshot(
      segment,
      rows.map((row) => toBytes(row.update_bytes)),
    );
    if (!snapshot) return;

    upsertSnapshot.run(containerId, segment, throughSequence, snapshot, at);
    deleteRange.run(containerId, segment, lowerBound, throughSequence);
    setLowerBound.run(throughSequence + 1, containerId, segment);
  }

  return {
    append(input) {
      if (input.update.byteLength > COLLAB_STREAM_LIMITS.maxAppendBytes) {
        return { kind: "too_large", limitBytes: COLLAB_STREAM_LIMITS.maxAppendBytes };
      }
      return transaction(database, () => {
        const at = new Date(clock.nowMs()).toISOString();
        const stream = loadStream(input.containerId, input.segment, at);
        if (stream.closed_at !== null) return { kind: "closed" } as const;

        const producer = selectProducer.get(input.containerId, input.segment, input.producerId) as
          | ProducerRow
          | undefined;

        if (producer && input.producerEpoch < producer.epoch) {
          return { kind: "stale_epoch", currentEpoch: producer.epoch } as const;
        }
        // The sequence watermark survives an epoch change: a restarted producer keeps one logical
        // sequence, so replayed writes are recognized rather than appended again.
        const lastSeq = producer?.last_seq ?? 0;
        if (input.producerSeq <= lastSeq) {
          const row = selectMessageOffset.get(
            input.containerId,
            input.segment,
            input.producerId,
            input.producerSeq,
          ) as { stream_offset: string } | undefined;
          if (producer && input.producerEpoch > producer.epoch) {
            upsertProducer.run(
              input.containerId,
              input.segment,
              input.producerId,
              input.producerEpoch,
              producer.last_seq,
              at,
            );
          }
          return { kind: "duplicate", offset: row?.stream_offset ?? null } as const;
        }
        if (input.producerSeq > lastSeq + 1) {
          return { kind: "gap", expectedSeq: lastSeq + 1 } as const;
        }

        const sequence = stream.next_sequence;
        const offset = formatOffset(sequence);
        insertMessage.run(
          input.containerId,
          input.segment,
          sequence,
          offset,
          input.producerId,
          input.producerEpoch,
          input.producerSeq,
          input.update,
          at,
        );
        bumpStream.run(sequence + 1, input.containerId, input.segment);
        upsertProducer.run(
          input.containerId,
          input.segment,
          input.producerId,
          input.producerEpoch,
          input.producerSeq,
          at,
        );
        compactIfDue(input.containerId, input.segment, stream.lower_bound_sequence, sequence, at);
        return { kind: "appended", offset } as const;
      });
    },

    read(input) {
      const stream = selectStream.get(input.containerId, input.segment) as StreamRow | undefined;
      const nextSequence = stream?.next_sequence ?? 1;
      const lowerBound = stream?.lower_bound_sequence ?? 1;
      const limit = input.limit ?? 1_000;
      const rows = selectMessages.all(
        input.containerId,
        input.segment,
        input.fromOffset ?? formatOffset(lowerBound),
        limit,
      ) as Array<{ stream_offset: string; update_bytes: unknown }>;
      const messages = rows.map((row) => ({
        offset: row.stream_offset,
        update: toBytes(row.update_bytes),
      }));
      const last = messages.at(-1);
      // A reader that asked for history the stream no longer holds gets the snapshot that replaced
      // it. Asking from at or above the lower bound needs nothing extra, so nothing is sent.
      const below =
        input.fromOffset !== undefined && input.fromOffset < formatOffset(lowerBound)
          ? (selectSnapshot.get(input.containerId, input.segment) as
              | { snapshot_bytes: unknown }
              | undefined)
          : undefined;
      return {
        messages,
        nextOffset: formatOffset(nextSequence),
        lowerBoundOffset: formatOffset(lowerBound),
        upToDate: last === undefined || last.offset === formatOffset(nextSequence - 1),
        ...(below ? { snapshot: toBytes(below.snapshot_bytes) } : {}),
      };
    },
  };
}
