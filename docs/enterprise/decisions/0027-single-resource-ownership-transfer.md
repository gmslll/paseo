# ADR-0027: Single-resource ownership transfer contract

- Status: DECISION_REQUIRED
- Date: 2026-09-11
- Decision owner: Enterprise integration owner

## Problem

P0 case 3 requires that when an owner transfers a subscribed Workspace or Agent to another
Principal, the former owner immediately stops receiving events. The current protocol and
production tree contain no callable Workspace/Agent owner-transfer API, transfer event, or
receipt. Existing `expectedRevision` fields belong to file/config mutation and cannot authorize an
ownership change.

## Minimum P0 contract for decision

Add one typed, single-resource ownership-transfer operation for the existing Workspace and Agent
resource kinds. The request contains exactly the existing canonical `GlobalResourceRef`,
`requestId`, `expectedOwnerPrincipalId`, `expectedRevision`, and `newPrincipalId`. The server
resolves the current resource and owner; the client cannot choose an organization, node, owner,
revision source, or alternate resource path.

The operation checks the current authenticated Principal, resource owner, revision, organization,
node, and grant before any mutation. Foreign, missing, guessed, stale, disabled, or mismatched
requests return one correlated redacted denial with zero source, subscription, cache, or audit
side effects. A successful transfer atomically updates the canonical owner/source and revision,
emits the required audit event, and returns a correlated receipt containing the new owner and
revision.

The commit boundary must synchronously invalidate every subscription and Principal-scoped cache
held by the old owner and reject late events from the old owner/generation. The new Principal may
access the resource only through a newly evaluated Grant and current Session binding; no old
receipt, subscription, cache, or event is reusable.

## Production and compatibility rule

This decision does not add a generic mutation fallback or reinterpret existing Workspace/Agent
requests. Until the operation has a W0 strict schema, W2 inventory and current-owner/revision
resolver, W3 receipt and subscription-generation consumer, required audit, and W7 real two-Principal
evidence, enterprise mode must keep the transfer capability absent and reject attempted transfer
requests fail-closed. Legacy single-user behavior remains unchanged.

## Ownership and acceptance gates

- W0 owns the strict request/response/receipt schema, compatibility and purity tests.
- W2 owns the exhaustive operation inventory, PlacementResolver/resource source, current owner and
  revision checks, Grant admission, and uniform denial.
- W3 owns Session receipt consumption, subscription/cache teardown, generation fencing, and late-event
  rejection.
- W7 owns the real two-Principal Workspace/Agent transfer E2E, including required audit and no-leak
  assertions; integration owns final production wiring.

Acceptance requires A→B transfer for one Workspace and one Agent, proving atomic owner/source update,
old subscription/cache/event invalidation, B access under a new Grant, correlated required audit,
and identical zero-side-effect denial for foreign, stale, and guessed references.
