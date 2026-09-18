# ADR-0046: Task documents and state machine

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A board is a data plane container `brd_<16 hex>` owned by an organization. Tasks are `tsk_<16 hex>`.

| Segment        | Content                                                              | Writer           |
| -------------- | -------------------------------------------------------------------- | ---------------- |
| `ti`           | task index rows: title, status, assignee, priority, order, updatedAt | plane projection |
| `tk:<taskId>`  | meta, body text, links, comments, review comments                    | board editors    |
| `tks:<taskId>` | status, assignee, review snapshot, review verdicts                   | plane only       |
| `rp`           | parsed `REVIEW.md` and source commit                                 | plane only       |

Status changes go only through `task.item.transition_status`. Document edits to `tks` or `rp` from
clients or nodes are rejected.

| From         | To           | Condition                                                        |
| ------------ | ------------ | ---------------------------------------------------------------- |
| backlog      | todo         | none                                                             |
| todo         | in_progress  | none                                                             |
| in_progress  | needs_review | a linked session has captured turns, or a pull request is linked |
| needs_review | done         | review policy satisfied (ADR-0048)                               |
| needs_review | in_progress  | changes requested                                                |
| done         | in_progress  | board manager only                                               |
| any          | canceled     | none                                                             |
| canceled     | backlog      | none                                                             |

The node that owns a linked Workspace supplies turn evidence through machine RPC.

Standalone daemons use `$PASEO_HOME/tasks/tasks.sqlite3` with one Principal; assignment and review
collapse to the owner.

Feature flags: `taskBoard` and `taskReview`. RPCs: `task.board.list_tasks`, `task.item.create`,
`task.item.update`, `task.item.transition_status`, `task.review.submit`, and
`task.review.get_policy`.

## Acceptance

State machine tests cover every transition and gate. A plane test proves client and node writes to
`tks` and `rp` are rejected. The local store passes the same state machine tests.
