# ADR-0043: Delegation authority and MCP caller capability

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Problem

The Agent MCP route `/mcp/agents` (`packages/server/src/server/bootstrap.ts`) reads the calling
Agent from the `callerAgentId` query parameter. With a daemon password set, the route requires the
per-run capability token, but every Agent receives that same token, so any Agent can name another
Agent. Without a daemon password the route accepts any local request. Either way the caller
inherits the named Agent's tool policy, parent relationship, and Workspace.

## Decision

- The daemon mints a per-Agent caller token when it builds the Agent's MCP configuration:
  `pmc1.<base64url Agent ID>.<base64url HMAC-SHA256>`, keyed by 32 random bytes generated for each
  daemon run and held only in memory. Tokens from an earlier run do not verify.
- The token travels in the `x-paseo-agent-caller` header, not the URL, so request debug logs never
  contain it.
- The route derives the caller Agent only from a verified token. A request naming `callerAgentId` in
  the query is rejected with 401. A request with neither is a top-level caller, as before.
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
