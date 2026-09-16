import { LoroDoc } from "loro-crdt";

import {
  COLLAB_SEGMENT_COMPACTED,
  StreamOffsetSchema,
  parseCollabSegment,
} from "@getpaseo/protocol/enterprise-collaboration";

import {
  openDaemonDatabase,
  transaction,
  type SqliteDatabase,
} from "../../../sqlite/open-database.js";

/**
 * The node's local replica of the collaboration streams (ADR-0032, ADR-0035).
 *
 * The plan says only "same tables as Lody" plus `producer_state` and `rpc_inbox`; the columns below
 * are this repository's design, derived from contracts that are already settled rather than invented:
 * fencing fields mirror the plane's `ds_producers`, offsets are the 20-digit strings of ADR-0032,
 * and the inbox deduplicates by `rpcId` with an expiry per ADR-0035. ADR-0032 and ADR-0035 record
 * the schema so it can be reviewed as a contract instead of read out of this file.
 *
 * Two different things are called an epoch. `producer_state.epoch` is the *producer* epoch that
 * fences a previous boot's stragglers: it rises once per boot, and the plane rejects an append
 * carrying a stale one. The *timeline* epoch that groups rows inside a session document is
 * unrelated, lives in the document, and is never stored here.
 *
 * `transaction()` issues an unconditional BEGIN IMMEDIATE, so it does not nest. Every public method
 * opens at most one and never calls another that would.
 */

export const COLLAB_REPO_SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS documents (
  segment TEXT PRIMARY KEY,
  snapshot_bytes BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_updates (
  segment TEXT NOT NULL,
  producer_seq INTEGER NOT NULL,
  producer_epoch INTEGER NOT NULL,
  update_bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (segment, producer_seq)
);
CREATE TABLE IF NOT EXISTS producer_state (
  segment TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_cursors (
  segment TEXT PRIMARY KEY,
  next_offset TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rpc_inbox (
  rpc_id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rpc_inbox_by_expiry ON rpc_inbox (expires_at);
`;

function migrateCollabRepo(database: SqliteDatabase, fromVersion: number): void {
  if (fromVersion < 1) {
    database.exec(SCHEMA_V1);
  }
}

export interface CollabRepoStoreOptions {
  path: string;
  now?: () => number;
}

export interface PendingUpdate {
  readonly segment: string;
  readonly producerSeq: number;
  readonly producerEpoch: number;
  readonly update: Uint8Array;
}

export interface ProducerState {
  readonly producerId: string;
  readonly epoch: number;
  readonly lastSeq: number;
}

export interface RemoteUpdate {
  readonly offset: string;
  readonly update: Uint8Array;
}

interface DocumentRow {
  snapshot_bytes: Uint8Array;
}

interface PendingRow {
  segment: string;
  producer_seq: number;
  producer_epoch: number;
  update_bytes: Uint8Array;
}

interface ProducerRow {
  producer_id: string;
  epoch: number;
  last_seq: number;
}

export class CollabRepoError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CollabRepoError";
  }
}

function assertSegment(segment: string): void {
  if (parseCollabSegment(segment) === null) {
    throw new CollabRepoError(`Unknown collaboration segment '${segment}'`, "UNKNOWN_SEGMENT");
  }
}

function assertOffset(offset: string): void {
  if (!StreamOffsetSchema.safeParse(offset).success) {
    throw new CollabRepoError(`Invalid stream offset '${offset}'`, "INVALID_OFFSET");
  }
}

export class CollabRepoStore {
  private readonly now: () => number;
  private readonly documents = new Map<string, LoroDoc>();

  private constructor(
    private readonly database: SqliteDatabase,
    options: CollabRepoStoreOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  static open(options: CollabRepoStoreOptions): CollabRepoStore {
    const database = openDaemonDatabase({
      path: options.path,
      schemaVersion: COLLAB_REPO_SCHEMA_VERSION,
      migrate: migrateCollabRepo,
    });
    return new CollabRepoStore(database, options);
  }

  close(): void {
    this.documents.clear();
    this.database.close();
  }

  /**
   * Raises the producer epoch for this segment and restarts the sequence. Called once per boot
   * before anything is produced: appends from a previous boot that are still in flight carry the
   * older epoch, and the plane answers those with 403 instead of interleaving them.
   *
   * Updates already queued under the old epoch are re-stamped rather than dropped, so work that
   * survived the crash is still uploaded — under the epoch the plane will now accept.
   */
  beginProducerEpoch(segment: string, producerId: string): ProducerState {
    assertSegment(segment);
    const at = this.now();
    return transaction(this.database, () => {
      const current = this.database
        .prepare("SELECT producer_id, epoch, last_seq FROM producer_state WHERE segment = ?")
        .get(segment) as ProducerRow | undefined;
      const epoch = (current?.epoch ?? 0) + 1;
      const pending = this.database
        .prepare("SELECT COUNT(*) AS total FROM pending_updates WHERE segment = ?")
        .get(segment) as { total: number };
      this.database
        .prepare(
          `INSERT INTO producer_state (segment, producer_id, epoch, last_seq, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(segment) DO UPDATE SET
             producer_id = excluded.producer_id,
             epoch = excluded.epoch,
             last_seq = excluded.last_seq,
             updated_at = excluded.updated_at`,
        )
        .run(segment, producerId, epoch, pending.total, at);
      this.database
        .prepare("UPDATE pending_updates SET producer_epoch = ? WHERE segment = ?")
        .run(epoch, segment);
      this.resequencePending(segment);
      return { producerId, epoch, lastSeq: pending.total };
    });
  }

  /** Renumbers surviving updates to 1..n so the sequence the plane sees has no gaps. */
  private resequencePending(segment: string): void {
    const rows = this.database
      .prepare("SELECT producer_seq FROM pending_updates WHERE segment = ? ORDER BY producer_seq")
      .all(segment) as Array<{ producer_seq: number }>;
    // Move them out of the way first: the target numbers overlap the current ones.
    this.database
      .prepare("UPDATE pending_updates SET producer_seq = producer_seq + ? WHERE segment = ?")
      .run(rows.length + 1, segment);
    const update = this.database.prepare(
      "UPDATE pending_updates SET producer_seq = ? WHERE segment = ? AND producer_seq = ?",
    );
    rows.forEach((row, index) => {
      update.run(index + 1, segment, row.producer_seq + rows.length + 1);
    });
  }

  producerState(segment: string): ProducerState | null {
    const row = this.database
      .prepare("SELECT producer_id, epoch, last_seq FROM producer_state WHERE segment = ?")
      .get(segment) as ProducerRow | undefined;
    return row ? { producerId: row.producer_id, epoch: row.epoch, lastSeq: row.last_seq } : null;
  }

  /**
   * Records local work: applies it to the replica and queues it for upload in one transaction, so a
   * crash never leaves a segment whose document moved without the matching update queued.
   */
  enqueueLocalUpdate(segment: string, update: Uint8Array): PendingUpdate {
    assertSegment(segment);
    const at = this.now();
    return transaction(this.database, () => {
      const producer = this.database
        .prepare("SELECT producer_id, epoch, last_seq FROM producer_state WHERE segment = ?")
        .get(segment) as ProducerRow | undefined;
      if (!producer) {
        throw new CollabRepoError(
          `Segment '${segment}' has no producer epoch; call beginProducerEpoch first`,
          "NO_PRODUCER_EPOCH",
        );
      }
      const producerSeq = producer.last_seq + 1;
      this.applyToDocument(segment, [update], at);
      this.database
        .prepare(
          `INSERT INTO pending_updates (segment, producer_seq, producer_epoch, update_bytes, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(segment, producerSeq, producer.epoch, update, at);
      this.database
        .prepare("UPDATE producer_state SET last_seq = ?, updated_at = ? WHERE segment = ?")
        .run(producerSeq, at, segment);
      return { segment, producerSeq, producerEpoch: producer.epoch, update };
    });
  }

  /**
   * Changes this segment's replica and queues exactly the delta the change produced.
   *
   * Prefer this over exporting an update by hand and passing it to `enqueueLocalUpdate`: the
   * version has to be read before the mutation and handed back to `export`, and a caller that
   * forgets sends a whole snapshot as if it were an increment.
   */
  applyLocalChange(segment: string, mutate: (document: LoroDoc) => void): PendingUpdate | null {
    assertSegment(segment);
    const document = this.document(segment);
    const from = document.version();
    mutate(document);
    document.commit();
    const update = document.export({ mode: "update", from });
    // A mutation that changed nothing still commits; queuing an empty update would spend a producer
    // sequence and a round trip on it.
    if (update.byteLength === 0) return null;
    return this.enqueueLocalUpdate(segment, update);
  }

  listPendingUpdates(segment?: string, limit = 256): PendingUpdate[] {
    const rows = (
      segment === undefined
        ? this.database
            .prepare(
              "SELECT segment, producer_seq, producer_epoch, update_bytes FROM pending_updates ORDER BY segment, producer_seq LIMIT ?",
            )
            .all(limit)
        : this.database
            .prepare(
              "SELECT segment, producer_seq, producer_epoch, update_bytes FROM pending_updates WHERE segment = ? ORDER BY producer_seq LIMIT ?",
            )
            .all(segment, limit)
    ) as PendingRow[];
    return rows.map((row) => ({
      segment: row.segment,
      producerSeq: row.producer_seq,
      producerEpoch: row.producer_epoch,
      update: row.update_bytes,
    }));
  }

  /** Drops updates the plane has acknowledged. Uploads are ordered, so this clears a prefix. */
  confirmUploaded(segment: string, throughProducerSeq: number): number {
    const result = this.database
      .prepare("DELETE FROM pending_updates WHERE segment = ? AND producer_seq <= ?")
      .run(segment, throughProducerSeq);
    return Number(result.changes);
  }

  /**
   * Applies a batch read from the plane and advances the cursor in one transaction. Batched because
   * the replica is re-exported once per call: per-update snapshots would cost O(document) each.
   *
   * `nextOffset` is the plane's own, not the last message's. A read's `fromOffset` is inclusive, so
   * resuming from the last offset applied would fetch that message again on every poll.
   */
  applyRemoteUpdates(
    segment: string,
    updates: readonly RemoteUpdate[],
    nextOffset: string,
  ): string | null {
    assertSegment(segment);
    assertOffset(nextOffset);
    if (updates.length === 0) return this.remoteCursor(segment);
    for (const entry of updates) assertOffset(entry.offset);
    const at = this.now();
    return transaction(this.database, () => {
      this.applyToDocument(
        segment,
        updates.map((entry) => entry.update),
        at,
      );
      this.database
        .prepare(
          `INSERT INTO remote_cursors (segment, next_offset, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(segment) DO UPDATE SET
             next_offset = excluded.next_offset, updated_at = excluded.updated_at`,
        )
        .run(segment, nextOffset, at);
      return nextOffset;
    });
  }

  remoteCursor(segment: string): string | null {
    const row = this.database
      .prepare("SELECT next_offset FROM remote_cursors WHERE segment = ?")
      .get(segment) as { next_offset: string } | undefined;
    return row?.next_offset ?? null;
  }

  /** Every segment's resume point, which is what the uplink sends to re-subscribe after a restart. */
  remoteCursors(): Record<string, string> {
    const rows = this.database
      .prepare("SELECT segment, next_offset FROM remote_cursors ORDER BY segment")
      .all() as Array<{ segment: string; next_offset: string }>;
    return Object.fromEntries(rows.map((row) => [row.segment, row.next_offset]));
  }

  /** The replica's bytes, for handing a fresh peer a starting point. */
  documentSnapshot(segment: string): Uint8Array | null {
    const row = this.database
      .prepare("SELECT snapshot_bytes FROM documents WHERE segment = ?")
      .get(segment) as DocumentRow | undefined;
    return row?.snapshot_bytes ?? null;
  }

  document(segment: string): LoroDoc {
    const cached = this.documents.get(segment);
    if (cached) return cached;
    const row = this.database
      .prepare("SELECT snapshot_bytes FROM documents WHERE segment = ?")
      .get(segment) as DocumentRow | undefined;
    const document = new LoroDoc();
    if (row) document.importBatch([row.snapshot_bytes]);
    this.documents.set(segment, document);
    return document;
  }

  private applyToDocument(segment: string, updates: readonly Uint8Array[], at: number): void {
    // Only the segments ADR-0032 marks as documents hold a replica. A log segment's bytes are the
    // entry — `rpc:req` and `rpc:res` carry JSON envelopes — and importing those into a LoroDoc
    // fails on the magic bytes. The same matrix the plane compacts by answers it here, so the two
    // sides cannot disagree about which segments are documents.
    const parsed = parseCollabSegment(segment);
    if (!parsed || !COLLAB_SEGMENT_COMPACTED[parsed.kind]) return;
    const document = this.document(segment);
    const status = document.importBatch(updates as Uint8Array[]);
    if (status.pending !== null) {
      throw new CollabRepoError(
        `Segment '${segment}' received an update with missing dependencies`,
        "PENDING_DEPENDENCIES",
      );
    }
    this.database
      .prepare(
        `INSERT INTO documents (segment, snapshot_bytes, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(segment) DO UPDATE SET
           snapshot_bytes = excluded.snapshot_bytes,
           updated_at = excluded.updated_at`,
      )
      .run(segment, document.export({ mode: "snapshot" }), at);
  }

  /**
   * Remembers an RPC id, returning false when it has been seen (ADR-0035 deduplicates in the local
   * inbox). Expiry is the caller's, taken from the attestation rather than a local default, so a
   * replay cannot outlive the window the plane signed.
   */
  rememberRpc(rpcId: string, method: string, expiresAtMs: number): boolean {
    const at = this.now();
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO rpc_inbox (rpc_id, method, received_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(rpcId, method, at, expiresAtMs);
    return Number(result.changes) > 0;
  }

  sweepRpcInbox(): number {
    const result = this.database
      .prepare("DELETE FROM rpc_inbox WHERE expires_at <= ?")
      .run(this.now());
    return Number(result.changes);
  }
}
