# ADR-0037: Data plane audit

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The plane writes its own audit events into the existing `audit_events` table under a reserved plane
node row created at bootstrap. Events use the `AuditEvent` shape and the same SHA-256 hash chain as
node audit.

`required` durability applies to:

- opening a content subscription or single-stream read by a non-member with a content Grant;
- dispatching a turn through machine RPC;
- membership invite, accept, role change, and removal;
- collaboration enable and disable on a Workspace.

Other data plane events are `buffered`. Events never contain prompt bodies, document bytes, file
contents, tokens, or cookies.

## Amends

- Master spec §15.2: the daily JSONL rule applies to node-local audit only.
- Master spec §5.1.7 audit aggregation: plane-origin events join the global index directly.

## Acceptance

Tests prove a failed `required` append denies the operation, the plane chain verifies after restart,
and no event metadata contains document or prompt bytes.
