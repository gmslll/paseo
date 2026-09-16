import { COLLAB_STREAM_LIMITS } from "@getpaseo/protocol/enterprise-collaboration";

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

export function createStreamStore(options: {
  database: SqliteDatabase;
  clock?: Clock;
}): StreamStore {
  const { database } = options;
  const clock = options.clock ?? { nowMs: () => Date.now() };

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

  function loadStream(containerId: string, segment: string, createdAt: string): StreamRow {
    const existing = selectStream.get(containerId, segment) as StreamRow | undefined;
    if (existing) return existing;
    insertStream.run(containerId, segment, createdAt);
    return { next_sequence: 1, lower_bound_sequence: 1, closed_at: null };
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
      return {
        messages,
        nextOffset: formatOffset(nextSequence),
        lowerBoundOffset: formatOffset(lowerBound),
        upToDate: last === undefined || last.offset === formatOffset(nextSequence - 1),
      };
    },
  };
}
