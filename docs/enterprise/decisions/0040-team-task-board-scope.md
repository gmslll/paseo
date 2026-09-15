# ADR-0040: Team task board scope

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A team task board with a review flow is in scope. A task links Workspaces, Agent sessions, and pull
requests and moves through `backlog`, `todo`, `in_progress`, `needs_review`, `done`, and `canceled`.
Agents may be started from a task and may request review.

A generic employee-facing workflow orchestrator, shift scheduling, and rostering remain out of
scope. The board does not dispatch work to employees automatically.

## Amends

- Master spec §3, first bullet.

## Related

ADR-0046 task documents and state machine, ADR-0047 task grants, ADR-0048 review policy, and
ADR-0049 pull request links.
