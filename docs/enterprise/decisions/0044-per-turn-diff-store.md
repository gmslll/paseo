# ADR-0044: Per-turn diff store

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The daemon records what each Agent turn changed in
`$PASEO_HOME/code-collab/<workspaceId>/diff-store.sqlite3`.

- Content is addressed by SHA-256 in 256 KiB chunks compressed with zstd from `node:zlib`. Files
  larger than 10 MiB raw, binaries, and symlinks are recorded by kind without content.
- Tables: `chunks`, `snapshots`, `snapshot_chunks`, `turns`, `turn_files`, and `path_heads`.
- Capture subscribes to turn start and terminal turn events through `agentManager.subscribe`. The
  changed path set is the union of file observer events and `git status --porcelain -z`. The before
  image is the recorded path head, then the HEAD blob, then `missing`.
- Edits outside a turn update path heads after a debounce so the next turn's before image is
  correct.
- Turns expire after 30 days. Each Workspace store is capped at 512 MiB compressed. Removing a
  Workspace deletes its store.
- Reads write snapshots to temporary files and run `git diff --no-index`; the existing checkout diff
  parser returns `ParsedDiffFile[]`.

Human edits made during a turn are attributed to that turn. Non-git Workspaces rely on file observer
events only.

Feature flag: `codeCollabTurnDiff`. RPCs: `code_collab.turn_diff.list_turns`,
`code_collab.turn_diff.get_files`, and `code_collab.all_changes.get_diff`.

## The Workspace directory is named by hash

This decision writes the store to `$PASEO_HOME/code-collab/<workspaceId>/diff-store.sqlite3`. The
implementation puts it under `sha256(workspaceId)` instead.

`generateWorkspaceId` produces `wks_<hex>`, but the persisted schema types the field as a bare
string and ids such as `/tmp/repo` and `""` are in use, so the id reaching `path.join` is not
guaranteed to be one segment. Validating a shape the type does not promise would refuse Workspaces
the rest of the daemon serves; joining the id as written would let one escape the root. Hashing
gives every id exactly one safe segment, which is what the daemon already does wherever a name has
to reach the filesystem.

The mapping is not lost: a Workspace's store is found by hashing its id again. Nothing outside this
module needs to read the directory by name.

## Acceptance

Tests use a real temporary git repository and cover capture of only touched files, chunk dedupe,
compression round trip, eviction releasing chunks, and foreign Agent denial.
