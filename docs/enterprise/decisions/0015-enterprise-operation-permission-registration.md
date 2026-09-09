# ADR 0015: Register enterprise RPCs in the operation permission gate

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

The W0 enterprise request and response schemas are members of `SessionInboundMessageSchema` and
`SessionOutboundMessageSchema`. The existing operation permission tables are exhaustive over those
unions. Adding the enterprise RPCs therefore makes the W2-owned
`packages/server/src/server/authorization/operation-permissions.ts` fail typecheck until every new
operation is registered.

W0 cannot omit the schemas from the Session unions: the daemon must parse the requests, generated
outbound validation must cover the responses, and integration must not create an unvalidated
enterprise side channel. W0 also cannot choose the legacy daemon permission for each operation;
that mapping is part of W2 authorization policy.

## Decision

The integration owner will add the minimum integration bridge after merging W0, then W2 will
register every `enterprise.*.request` and matching response or event in the operation permission
gate. The legacy operation gate remains the first coarse check and `ResourceAuthorization` remains
the mandatory resource-scoped check. W0 does not modify the W2-owned authorization directory.
This registration and its colocated tests are W2's first integration task.

Until that exhaustive table is registered, whole-repository typecheck is an accepted cross-stream
blocker for the standalone W0 commit. Protocol and client builds and protocol typecheck must still
pass in the isolated W0 worktree.

## Boundary

- W0 owns the protocol schemas and generated-validator compatibility evidence.
- W2 owns the operation-to-permission policy and resource authorization implementation.
- No enterprise operation may receive a `null` requirement only to satisfy exhaustiveness unless
  the integration owner explicitly accepts that mapping.
