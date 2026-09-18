# ADR 0005: Grant version in Session binding

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

`credentialId` identifies a credential but does not change when the same Principal's Grants change. Reconnect must not reuse a Session bound to an older authorization generation.

## Decision

`PrincipalContext` includes `grantVersion: string`. Every semantic Grant change creates a new version, even if the credential remains the same.

The enterprise Session binding contains at least `organizationId + principalId + credentialId + grantVersion + clientId`. Its canonical key contains those fields in that order and contains no bearer token, credential secret, Grant body, or customer content.

`enterprise.identity.get_current.response` returns a `CurrentIdentityProjection` containing
`grantVersion`. It never returns `PrincipalContext.grants` or `PrincipalContext.credentialId`.

## Reason

A first-class version makes authorization changes explicit and avoids deriving a durable identity
from mutable Grant content. It also keeps reconnect comparison small and secret-free.

## Boundary

- W1 assigns and validates `grantVersion` during admission and reconnect.
- W2 changes the version when Grant semantics change and provides resource-authorization invalidation.
- W3 includes the version in Session binding and actively tears down stale subscriptions and outbound state.
- `normalizeResourceGrants` remains the canonical ordering helper for Grant persistence and comparison; it does not replace `grantVersion`.
