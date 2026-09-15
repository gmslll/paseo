# ADR-0042: Durable delegation outbox

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

Agent-to-Agent delegation is recorded in `$PASEO_HOME/orchestration/operations.sqlite3` before it
runs, and its completion is delivered back to the requester from that record.

- An operation is keyed by `(requesterAgentId, operationId)`. Kinds are `agent_create`,
  `agent_create_many`, `agent_prompt`, and `agent_prompt_many`.
- The operation stores a SHA-256 fingerprint of its canonical command. Replaying the same key with
  the same fingerprint returns the stored operation; a different fingerprint fails with
  `OPERATION_ID_CONFLICT`.
- Fan-out items materialize one at a time behind claim tokens, so a retry never creates a second
  Agent.
- A human prompt resets an Agent's chain depth to 0. An outbox-started turn records requester depth
  plus one. Accepting an operation at depth 32 fails with `CHAIN_DEPTH_EXCEEDED`.
- Each daemon boot has a `workerBootId`. Deliveries move through `ready`, `claimed`, `prepared`,
  `started`, and `uncertain`. At boot, claims from an older boot return to `ready` and `started`
  becomes `uncertain`.
- An uncertain delivery searches the requester timeline for its deterministic message ID
  `op:<operationId>:d:<n>`. If found it is consumed; otherwise it retries once and then records
  `DELIVERY_EXECUTION_UNCERTAIN` in the completion.
- Completion is injected with `steer` and that message ID so existing prompt echo reconciliation
  removes duplicates.
- Operations have a deadline between 60 seconds and 7 days, 24 hours by default. Items past the
  deadline finish as `timed_out`.

Feature flag: `orchestrationOutbox`. RPCs: `orchestration.operation.list`,
`orchestration.operation.get`, `orchestration.operation.cancel`, and the push message
`orchestration.operation.update`.

## Amends

- `docs/agent-lifecycle.md` finish notification semantics.

## Acceptance

Tests kill the worker between each delivery phase and prove exactly one visible completion after
restart, cover idempotent replay and conflict, chain depth, deadlines, and fan-out without duplicate
Agents.
