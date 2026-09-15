# ADR-0045: Turn diff and task content read views

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

ADR-0024 content reads gain three views:

- Agent view `turn_diff` returns the files changed by one turn from the per-turn diff store.
- Task views `body` and `review` return task description, comments, and review threads.

A Principal without Workspace membership or ownership reads these views only with
`workspace.content.read`. Each such read appends a `required` audit event
(`code_collab.turn_diff.viewed` or `task.content.viewed`) before content is returned. An audit
append failure denies the read. Owner and member reads are not audited, matching timeline reads.

## Amends

- ADR-0024 view vocabulary. The existing views are unchanged.

## Acceptance

Tests cover owner reads without audit, Boss reads with a content Grant and audit, Boss denial
without a Grant, and denial when the audit append fails.
