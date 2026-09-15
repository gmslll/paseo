# ADR-0043: Delegation authority and MCP caller capability

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Problem

The Agent MCP route reads the calling Agent from the `callerAgentId` query parameter
(`packages/server/src/server/bootstrap.ts`). Any local process that reaches the route can claim to be
any Agent and inherit its tool policy.

## Decision

- The daemon mints a per-Agent capability token when it builds the Agent's MCP configuration. The
  token is an HMAC-SHA256 over the Agent ID and daemon boot ID with a key held only in daemon
  memory.
- The MCP route accepts only that token and derives the caller Agent from it. A bare
  `callerAgentId` is rejected. Tokens from an earlier boot are rejected.
- Delegation authority is the caller Agent's persisted Workspace owner, resolved through
  `OwnerRegistry` and frozen when the operation is accepted. Tool arguments never supply a Principal
  or Workspace authority.
- Create targets require `assertWorkspace(ctx, "workspace.write", workspaceId)`. Prompt targets
  require `assertAgent(ctx, "workspace.write", agentId)`. A denied target creates nothing.
- Each delivery rechecks the requester's Grant version. A revoked Grant finishes the operation with
  `AUTHORIZATION_REVOKED` and injects nothing.
- Child Agents inherit the requester Workspace ownership.
- Standalone mode uses the existing legacy authorization, which allows the call.

Audit events `orchestration.operation.accepted`, `.denied`, `.finished`, and
`orchestration.delivery.consumed`, `.uncertain` use the requester as actor. Denials are `required`.

## Acceptance

Tests prove a forged or missing token is rejected, a token survives only its boot, a foreign
Workspace target is denied with zero Agents created and one audit event, and a revoked Grant stops
delivery.
