import { createRequire } from "node:module";

interface StatementResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: readonly unknown[]): StatementResult;
  get(...parameters: readonly unknown[]): unknown;
  all(...parameters: readonly unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as {
  readonly DatabaseSync: new (path: string) => SqliteDatabase;
};

export function openSqliteDatabase(path: string): SqliteDatabase {
  return new sqlite.DatabaseSync(path);
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
      const failure = new Error("transaction and rollback failed", { cause: rollbackError });
      Object.defineProperty(failure, "transactionError", {
        value: error,
        enumerable: false,
      });
      throw failure;
    }
    throw error;
  }
}
