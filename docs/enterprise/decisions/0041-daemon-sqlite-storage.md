# ADR-0041: Daemon SQLite storage

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The daemon uses `node:sqlite` for stores that need transactions, crash-safe claims, or content
addressing: the delegation outbox, the per-turn diff store, the collaboration repo, the local task
store, and pull request poller state.

- One helper opens every database: WAL journal, `synchronous=FULL`, foreign keys on, and
  `BEGIN IMMEDIATE` for writes.
- Each database has a `schema_meta(version)` table. Schema changes are additive
  `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN` statements. There is no migration
  framework.
- Synchronous SQLite work that can block for long, such as diff snapshot compression, runs in a
  `worker_threads` worker.

JSON registries for Agents, Projects, Workspaces, schedules, and enterprise identity stay as they
are.

## Amends

- `docs/data-model.md`: file-based JSON remains the default; the stores above are the exceptions.

## Acceptance

Helper tests use a real temporary database and cover rollback on throw, WAL mode, and schema version
recording. Release validation loads `node:sqlite` inside the packaged Electron daemon.
