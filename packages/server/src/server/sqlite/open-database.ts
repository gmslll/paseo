import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// Daemon SQLite stores (ADR-0041). @types/node@20 predates the node:sqlite typings, so this file
// declares the slice the daemon uses. The module loads when a database opens, so importing this
// file never fails on a runtime without node:sqlite.

interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: readonly unknown[]): SqliteRunResult;
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  readonly DatabaseSync: new (path: string) => SqliteDatabase;
}

const require = createRequire(import.meta.url);

export class DaemonDatabaseSchemaTooNewError extends Error {
  constructor(
    public readonly databasePath: string,
    public readonly storedVersion: number,
    public readonly supportedVersion: number,
  ) {
    super(
      `${databasePath} has schema version ${storedVersion}; this daemon supports up to ${supportedVersion}`,
    );
    this.name = "DaemonDatabaseSchemaTooNewError";
  }
}

export interface OpenDaemonDatabaseOptions {
  path: string;
  schemaVersion: number;
  /**
   * Runs inside the schema transaction when the stored version is older. Use only additive
   * statements: CREATE TABLE IF NOT EXISTS and ALTER TABLE ... ADD COLUMN.
   */
  migrate: (database: SqliteDatabase, fromVersion: number) => void;
}

export function openDaemonDatabase(options: OpenDaemonDatabaseOptions): SqliteDatabase {
  mkdirSync(path.dirname(options.path), { recursive: true });
  const sqlite = require("node:sqlite") as NodeSqliteModule;
  const database = new sqlite.DatabaseSync(options.path);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
    );
    transaction(database, () => {
      const row = database.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as
        | { version: number }
        | undefined;
      const storedVersion = row?.version ?? 0;
      if (storedVersion > options.schemaVersion) {
        throw new DaemonDatabaseSchemaTooNewError(
          options.path,
          storedVersion,
          options.schemaVersion,
        );
      }
      if (storedVersion === options.schemaVersion) {
        return;
      }
      options.migrate(database, storedVersion);
      database
        .prepare(
          "INSERT INTO schema_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
        )
        .run(options.schemaVersion);
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function transaction<T>(database: SqliteDatabase, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new Error("transaction and rollback failed", { cause: rollbackError });
    }
    throw error;
  }
}
