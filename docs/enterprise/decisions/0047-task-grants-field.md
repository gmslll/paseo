# ADR-0047: Task grants field

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Problem

ADR-0008 freezes `EnterpriseAction`. Task permissions need actions the V1 vocabulary lacks.

## Decision

Task permissions travel in a separate optional `taskGrants` field on the Principal policy and the
identity projection. Each entry is `{ action, boardId }` with actions `task.read`, `task.write`,
`task.manage`, and `task.review`.

| Holder        | Allowed                                            |
| ------------- | -------------------------------------------------- |
| `task.manage` | create, assign, cancel, reopen `done`              |
| `task.write`  | create, comment, transition tasks assigned to self |
| `task.read`   | read and comment                                   |
| `task.review` | submit review verdicts                             |

An editor who is not the assignee may review when the board policy allows it. Boss visibility is
metadata only unless the Principal also holds `workspace.content.read`, and content reads follow
ADR-0045.

The field is sent only to nodes and clients that declare `taskBoard` support. Its absence means no
task permissions.

## Acceptance

Protocol tests prove old clients parse policy with `taskGrants`, and authorization tests cover each
action against each transition.
