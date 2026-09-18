# ADR-0034: Shared Agent turn control

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The author of a turn's user message controls that turn.

- The same Principal keeps today's `interrupt` and `steer` behavior.
- A different editor who sends while a turn runs is queued in FIFO order. The queue is visible as
  `queuedTurns` on the Agent snapshot and in the session document.
- Editors may `steer` a running turn. Only the Workspace owner may interrupt another Principal's
  turn.
- Editors may cancel. Cancelling another Principal's turn writes a `required` audit event.
- Tool permission requests are answered only by the turn controller or the Workspace owner.
- Every user message carries `author` with the authenticated Principal ID.

`ActiveTurnBehaviorSchema` is not widened. A send request may carry optional
`sharedTurnPolicy: "queue" | "interrupt"`; the daemon resolves the effective behavior from the
authenticated Principal and role, never from the client value alone.

Files stay on disk with last-writer-wins guarded by the existing `expectedRevision`. There is no
text CRDT for workspace files in this release.

## Amends

- Master spec §15.1 actor semantics: the audit actor of a turn is its author, not the Workspace
  owner.
- `docs/timeline-sync.md` submission rules for collaborative Workspaces.

## Acceptance

Tests cover same-Principal behavior, cross-Principal queueing, owner interrupt, audited cross-author
cancel, permission-response authorization, and author attribution in both the timeline and audit.
