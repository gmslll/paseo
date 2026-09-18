# ADR 0004: Agent ownership envelope handoff

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

An enterprise Agent must have Workspace-derived ownership before its first `AgentStorage` write. The original workstream list does not assign the narrow handoff through Agent creation. Adding ownership after creation would leave a persisted record temporarily unowned.

## Decision

W0 defines `AgentOwnershipEnvelope` as `workspaceId` plus the complete `EnterpriseResourceOwner` fields.

W2 may modify `packages/server/src/server/agent/agent-manager.ts`, `packages/server/src/server/agent/agent-projections.ts`, and their colocated tests only to pass and retain this envelope before the first `AgentStorage` write. W3 constructs the envelope from an authorized Workspace and the authenticated `PrincipalContext`, then supplies it to the W2-owned handoff.

## Reason

Ownership must be present at the first durable boundary. A narrow typed envelope lets W2 preserve the invariant without taking over Session or Provider behavior.

## Boundary

- W0 owns the envelope schema and type.
- W2 owns persistence validation and the minimal Agent creation/projection handoff.
- W3 owns construction at the authorized Session boundary.
- W5 and the existing Agent owners retain Provider launch policy and all other lifecycle behavior.
- The envelope cannot be derived from `cwd`, an Agent ID, or client-supplied ownership fields.
