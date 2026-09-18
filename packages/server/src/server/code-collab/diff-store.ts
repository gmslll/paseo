import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { openDaemonDatabase, transaction, type SqliteDatabase } from "../sqlite/open-database.js";

/**
 * What one Agent turn changed, content-addressed (ADR-0044).
 *
 * Content is stored once per SHA-256 and shared by every snapshot that holds it, so a file the turn
 * left untouched costs nothing and a revert costs nothing twice. Chunking keeps a large file from
 * being rewritten whole when one hunk moves.
 */
export const DIFF_STORE_SCHEMA_VERSION = 1;

// @types/node@20 predates the zstd bindings, which this runtime has: the daemon checks
// `typeof zstdCompressSync === "function"` at v22. Declaring the slice used here keeps the store on
// the real API rather than a cast, the same way the SQLite helper declares node:sqlite.
interface ZstdSlice {
  zstdCompressSync(data: Uint8Array): Buffer;
  zstdDecompressSync(data: Uint8Array): Buffer;
}

const require = createRequire(import.meta.url);
const zstd = require("node:zlib") as ZstdSlice;

/** 256 KiB, the chunk size ADR-0044 fixes. */
export const CHUNK_BYTES = 256 * 1024;

/** Above this a file is recorded by kind without content, as are binaries and symlinks. */
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  sha256 TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  raw_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  sha256 TEXT PRIMARY KEY,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot_chunks (
  snapshot_sha256 TEXT NOT NULL REFERENCES snapshots (sha256) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  chunk_sha256 TEXT NOT NULL REFERENCES chunks (sha256),
  PRIMARY KEY (snapshot_sha256, ordinal)
);
CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS turns_by_started_at ON turns (started_at DESC);
CREATE TABLE IF NOT EXISTS turn_files (
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_sha256 TEXT REFERENCES snapshots (sha256),
  after_sha256 TEXT REFERENCES snapshots (sha256),
  PRIMARY KEY (turn_id, path)
);
CREATE TABLE IF NOT EXISTS path_heads (
  path TEXT PRIMARY KEY,
  snapshot_sha256 TEXT REFERENCES snapshots (sha256),
  kind TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * How a file was recorded. `text` carries content; the rest name why it does not, which is what a
 * reader shows instead of a diff.
 */
export type DiffFileKind = "text" | "binary" | "too_large" | "symlink" | "missing";

export interface DiffStoreOptions {
  readonly path: string;
  readonly now?: () => number;
}

export interface RecordedContent {
  readonly kind: DiffFileKind;
  /** Null when the kind carries no content. */
  readonly sha256: string | null;
}

export interface TurnFileInput {
  readonly path: string;
  readonly before: RecordedContent;
  readonly after: RecordedContent;
}

export interface TurnFileRow {
  readonly path: string;
  readonly kind: DiffFileKind;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
}

export interface TurnRow {
  readonly turnId: string;
  readonly agentId: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly fileCount: number;
}

export class DiffStoreError extends Error {
  constructor(
    message: string,
    public readonly code: "UNKNOWN_SNAPSHOT" | "UNKNOWN_TURN",
  ) {
    super(message);
    this.name = "DiffStoreError";
  }
}

export class DiffStore {
  private readonly now: () => number;

  private constructor(
    private readonly database: SqliteDatabase,
    now: () => number,
  ) {
    this.now = now;
  }

  static open(options: DiffStoreOptions): DiffStore {
    const database = openDaemonDatabase({
      path: options.path,
      schemaVersion: DIFF_STORE_SCHEMA_VERSION,
      migrate: (db) => db.exec(SCHEMA),
    });
    return new DiffStore(database, options.now ?? Date.now);
  }

  close(): void {
    this.database.close();
  }

  /**
   * Stores a file's bytes and returns how it was recorded.
   *
   * Oversized and binary content is recorded by kind alone: ADR-0044 keeps it out of the store
   * rather than paying to compress what no reader can diff.
   */
  putContent(content: Uint8Array): RecordedContent {
    if (content.byteLength > MAX_CONTENT_BYTES) return { kind: "too_large", sha256: null };
    if (isBinary(content)) return { kind: "binary", sha256: null };

    const sha256 = digestOf(content);
    const at = this.now();
    transaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT sha256 FROM snapshots WHERE sha256 = ?")
        .get(sha256);
      if (existing) return;
      this.database
        .prepare("INSERT INTO snapshots (sha256, byte_size, created_at) VALUES (?, ?, ?)")
        .run(sha256, content.byteLength, at);
      for (const [ordinal, chunk] of chunksOf(content).entries()) {
        const chunkSha = digestOf(chunk);
        // One row per distinct chunk: the same bytes in two files, or unchanged across turns, are
        // stored once.
        this.database
          .prepare(
            "INSERT INTO chunks (sha256, bytes, raw_size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING",
          )
          .run(chunkSha, zstd.zstdCompressSync(chunk), chunk.byteLength, at);
        this.database
          .prepare(
            "INSERT INTO snapshot_chunks (snapshot_sha256, ordinal, chunk_sha256) VALUES (?, ?, ?)",
          )
          .run(sha256, ordinal, chunkSha);
      }
    });
    return { kind: "text", sha256 };
  }

  /** Reassembles stored content, or null when the snapshot is unknown. */
  readContent(sha256: string): Uint8Array | null {
    const rows = this.database
      .prepare(
        "SELECT c.bytes AS bytes FROM snapshot_chunks sc JOIN chunks c ON c.sha256 = sc.chunk_sha256 WHERE sc.snapshot_sha256 = ? ORDER BY sc.ordinal",
      )
      .all(sha256) as Array<{ bytes: Uint8Array }>;
    if (rows.length === 0) return null;
    // Buffer is a Uint8Array subclass, so returning one typechecks and then compares and
    // serializes differently at the caller. Hand back what the signature says.
    return new Uint8Array(Buffer.concat(rows.map((row) => zstd.zstdDecompressSync(row.bytes))));
  }

  /** Records one turn and the files it touched, in a single transaction. */
  recordTurn(input: {
    readonly turnId: string;
    readonly agentId: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly files: readonly TurnFileInput[];
  }): void {
    transaction(this.database, () => {
      this.database
        .prepare(
          "INSERT INTO turns (turn_id, agent_id, started_at, ended_at) VALUES (?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET ended_at = excluded.ended_at",
        )
        .run(input.turnId, input.agentId, input.startedAt, input.endedAt);
      for (const file of input.files) {
        this.database
          .prepare(
            `INSERT INTO turn_files (turn_id, path, kind, before_sha256, after_sha256)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(turn_id, path) DO UPDATE SET
               kind = excluded.kind,
               before_sha256 = excluded.before_sha256,
               after_sha256 = excluded.after_sha256`,
          )
          .run(input.turnId, file.path, file.after.kind, file.before.sha256, file.after.sha256);
        // The head follows what the turn left behind, so the next turn's before image is this one's
        // after image without re-reading the working tree.
        this.database
          .prepare(
            `INSERT INTO path_heads (path, snapshot_sha256, kind, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
               snapshot_sha256 = excluded.snapshot_sha256,
               kind = excluded.kind,
               updated_at = excluded.updated_at`,
          )
          .run(file.path, file.after.sha256, file.after.kind, this.now());
      }
    });
  }

  listTurns(options: { limit?: number; agentId?: string } = {}): TurnRow[] {
    const limit = options.limit ?? 50;
    const rows = options.agentId
      ? (this.database
          .prepare(
            `SELECT t.turn_id, t.agent_id, t.started_at, t.ended_at,
                    COUNT(tf.path) AS file_count
             FROM turns t
             LEFT JOIN turn_files tf ON tf.turn_id = t.turn_id
             WHERE t.agent_id = ?
             GROUP BY t.turn_id
             ORDER BY t.started_at DESC
             LIMIT ?`,
          )
          .all(options.agentId, limit) as Array<{
          turn_id: string;
          agent_id: string;
          started_at: number;
          ended_at: number | null;
          file_count: number;
        }>)
      : (this.database
          .prepare(
            `SELECT t.turn_id, t.agent_id, t.started_at, t.ended_at,
                    COUNT(tf.path) AS file_count
             FROM turns t
             LEFT JOIN turn_files tf ON tf.turn_id = t.turn_id
             GROUP BY t.turn_id
             ORDER BY t.started_at DESC
             LIMIT ?`,
          )
          .all(limit) as Array<{
          turn_id: string;
          agent_id: string;
          started_at: number;
          ended_at: number | null;
          file_count: number;
        }>);
    return rows.map((row) => ({
      turnId: row.turn_id,
      agentId: row.agent_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      fileCount: Number(row.file_count),
    }));
  }

  /**
   * One row per path touched by matching turns: the first before-image and the last after-image.
   *
   * That is the "all changes" view (ADR-0044): the conversation's accumulated effect, not one turn
   * and not the current git working tree.
   */
  accumulatedFiles(options: { agentId?: string } = {}): TurnFileRow[] {
    const turns = this.listTurns({ limit: 10_000, agentId: options.agentId });
    const firstBefore = new Map<string, string | null>();
    const latest = new Map<string, TurnFileRow>();
    for (const turn of turns.toReversed()) {
      for (const file of this.turnFiles(turn.turnId)) {
        if (!firstBefore.has(file.path)) firstBefore.set(file.path, file.beforeSha256);
        latest.set(file.path, file);
      }
    }
    return [...latest.values()]
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        beforeSha256: firstBefore.get(file.path) ?? file.beforeSha256,
        afterSha256: file.afterSha256,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  turnFiles(turnId: string): TurnFileRow[] {
    const rows = this.database
      .prepare(
        "SELECT path, kind, before_sha256, after_sha256 FROM turn_files WHERE turn_id = ? ORDER BY path",
      )
      .all(turnId) as Array<{
      path: string;
      kind: string;
      before_sha256: string | null;
      after_sha256: string | null;
    }>;
    return rows.map((row) => ({
      path: row.path,
      kind: row.kind as DiffFileKind,
      beforeSha256: row.before_sha256,
      afterSha256: row.after_sha256,
    }));
  }

  /** The compressed bytes this Workspace's store holds, which is what the cap is measured against. */
  compressedBytes(): number {
    const row = this.database
      .prepare("SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS total FROM chunks")
      .get() as { total: number };
    return Number(row.total);
  }

  /**
   * Drops turns that started before the cutoff and releases what nothing else holds.
   *
   * Returns the number of turns removed.
   */
  evictTurnsBefore(cutoffMs: number): number {
    return transaction(this.database, () => {
      const removed = this.database
        .prepare("DELETE FROM turns WHERE started_at < ?")
        .run(cutoffMs).changes;
      this.releaseUnreferenced();
      return Number(removed);
    });
  }

  /**
   * Drops the oldest turns until the store fits the cap, and releases what nothing else holds.
   *
   * A path head can hold content alive after its turn is gone — that is the point of a head, since
   * the next turn's before image is read from it — so a store made entirely of current heads can sit
   * above the cap with nothing left to drop. Returns the number of turns removed.
   */
  enforceSizeCap(maxCompressedBytes: number): number {
    return transaction(this.database, () => {
      let removed = 0;
      while (this.compressedBytes() > maxCompressedBytes) {
        const oldest = this.database
          .prepare("SELECT turn_id FROM turns ORDER BY started_at ASC LIMIT 1")
          .get() as { turn_id: string } | undefined;
        if (!oldest) break;
        this.database.prepare("DELETE FROM turns WHERE turn_id = ?").run(oldest.turn_id);
        this.releaseUnreferenced();
        removed += 1;
      }
      return removed;
    });
  }

  /**
   * Releases snapshots no turn or head still names, then the chunks no snapshot still names.
   *
   * Chunks are deliberately not cascaded from snapshots: one chunk belongs to every snapshot whose
   * content contains it, so it goes only when the last of them does. Runs inside a caller's
   * transaction, which is the only place it is correct.
   */
  private releaseUnreferenced(): void {
    this.database.exec(
      `DELETE FROM snapshots WHERE sha256 NOT IN (
         SELECT before_sha256 FROM turn_files WHERE before_sha256 IS NOT NULL
         UNION SELECT after_sha256 FROM turn_files WHERE after_sha256 IS NOT NULL
         UNION SELECT snapshot_sha256 FROM path_heads WHERE snapshot_sha256 IS NOT NULL
       )`,
    );
    this.database.exec(
      "DELETE FROM chunks WHERE sha256 NOT IN (SELECT chunk_sha256 FROM snapshot_chunks)",
    );
  }

  /** What the store last saw at this path, which is the next turn's before image. */
  pathHead(filePath: string): RecordedContent | null {
    const row = this.database
      .prepare("SELECT snapshot_sha256, kind FROM path_heads WHERE path = ?")
      .get(filePath) as { snapshot_sha256: string | null; kind: string } | undefined;
    return row ? { kind: row.kind as DiffFileKind, sha256: row.snapshot_sha256 } : null;
  }

  /** Records an edit made outside a turn, so the next turn does not attribute it to itself. */
  setPathHead(filePath: string, content: RecordedContent): void {
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO path_heads (path, snapshot_sha256, kind, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             snapshot_sha256 = excluded.snapshot_sha256,
             kind = excluded.kind,
             updated_at = excluded.updated_at`,
        )
        .run(filePath, content.sha256, content.kind, this.now());
    });
  }
}

/**
 * The 256 KiB chunks a snapshot is stored as. An empty file is one empty chunk rather than none:
 * a snapshot with no rows would read back as an unknown snapshot.
 */
function chunksOf(content: Uint8Array): Uint8Array[] {
  if (content.byteLength === 0) return [content];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < content.byteLength; offset += CHUNK_BYTES) {
    chunks.push(content.subarray(offset, Math.min(offset + CHUNK_BYTES, content.byteLength)));
  }
  return chunks;
}

function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * A NUL byte in the first 8 KiB, which is what git uses to decide the same question. Reading
 * further costs more than it settles: a file that is text for 8 KiB and binary after is not one a
 * reader wants a diff of either.
 */
function isBinary(content: Uint8Array): boolean {
  const limit = Math.min(content.byteLength, 8 * 1024);
  for (let index = 0; index < limit; index += 1) {
    if (content[index] === 0) return true;
  }
  return false;
}
