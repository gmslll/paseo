import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  DaemonDatabaseSchemaTooNewError,
  type SqliteDatabase,
  openDaemonDatabase,
  transaction,
} from "./open-database.js";

let directory: string;
let databasePath: string;
const openDatabases: SqliteDatabase[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-daemon-sqlite-"));
  databasePath = path.join(directory, "nested", "store.sqlite3");
});

afterEach(async () => {
  closeAll();
  await rm(directory, { recursive: true, force: true });
});

function open(
  schemaVersion: number,
  migrate: (database: SqliteDatabase, fromVersion: number) => void,
): SqliteDatabase {
  const database = openDaemonDatabase({ path: databasePath, schemaVersion, migrate });
  openDatabases.push(database);
  return database;
}

function closeAll(): void {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
}

function createItems(database: SqliteDatabase): void {
  database.exec("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY)");
}

function createItemsThenFail(database: SqliteDatabase): void {
  createItems(database);
  throw new Error("migration failed");
}

describe("openDaemonDatabase", () => {
  test("creates the parent directory with WAL, full sync, and foreign keys", () => {
    const database = open(1, createItems);

    expect(database.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  test("migrates from the stored version and records the new version once", () => {
    const calls: number[] = [];
    open(1, (database, fromVersion) => {
      calls.push(fromVersion);
      createItems(database);
    });
    closeAll();

    open(1, (_database, fromVersion) => calls.push(fromVersion));
    closeAll();

    const database = open(2, (migrating, fromVersion) => {
      calls.push(fromVersion);
      migrating.exec("ALTER TABLE items ADD COLUMN label TEXT");
    });

    expect(calls).toEqual([0, 1]);
    expect(database.prepare("SELECT version FROM schema_meta").get()).toEqual({ version: 2 });
    database.prepare("INSERT INTO items (id, label) VALUES (?, ?)").run("a", "label");
  });

  test("a failed migration leaves neither tables nor a schema version", () => {
    expect(() => open(1, createItemsThenFail)).toThrow("migration failed");

    const tablesSeenByRetry: unknown[] = [];
    const calls: number[] = [];
    const database = open(1, (migrating, fromVersion) => {
      calls.push(fromVersion);
      tablesSeenByRetry.push(
        migrating.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").get(),
      );
      createItems(migrating);
    });

    expect(calls).toEqual([0]);
    expect(tablesSeenByRetry).toEqual([undefined]);
    expect(database.prepare("SELECT version FROM schema_meta").get()).toEqual({ version: 1 });
  });

  test("refuses a database written by a newer schema", () => {
    open(3, createItems);
    closeAll();

    let caught: unknown;
    try {
      open(2, createItems);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DaemonDatabaseSchemaTooNewError);
    expect(caught).toMatchObject({ storedVersion: 3, supportedVersion: 2 });
  });
});

test("transaction commits the operation result and rolls back when the operation throws", () => {
  const database = open(1, createItems);
  const insert = database.prepare("INSERT INTO items (id) VALUES (?)");

  expect(transaction(database, () => insert.run("kept").changes)).toBe(1);
  expect(() =>
    transaction(database, () => {
      insert.run("discarded");
      throw new Error("abort");
    }),
  ).toThrow("abort");

  expect(database.prepare("SELECT id FROM items ORDER BY id").all()).toEqual([{ id: "kept" }]);
});
