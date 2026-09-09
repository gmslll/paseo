# ADR 0003: W1 config ownership and session authorization generation

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

W1 must configure the P0 enterprise identity adapter, but its original exclusive list does not include the persisted daemon configuration files. Reconnect also needs a stable way to reject an old authorization generation.

## Decision

W1 may modify `packages/server/src/server/config.ts`, `packages/server/src/server/persisted-config.ts`, and their colocated tests only for the minimal `enterpriseMultiUser` configuration fragment defined by the master specification. Other configuration semantics remain with their existing owners.

As accepted in [ADR 0005](0005-grant-version-session-binding.md), `PrincipalContext.grantVersion` is the authorization generation. W1 binds reconnect identity to `organizationId + principalId + credentialId + grantVersion + clientId`.

W2 and W3 provide the active invalidation interface that stops reuse and outbound delivery after a Grant or credential change. Reconnect admission compares the explicit Session binding fields; it does not replace live revocation.

## Reason

The local identity adapter needs persisted enablement, organization, node, management mode, and legacy-record policy. Limiting W1 to that fragment avoids parallel edits to unrelated daemon configuration.

The binding uses explicit authenticated identity fields and contains no credential secret. Canonical Grant ordering remains useful when W2 decides whether a semantic Grant change requires a new version.

## Boundary

- W0 owns `ConnectionContext`, `PrincipalAuthenticator`, `IdentityResolver`, and `PrincipalContext` contracts.
- `PrincipalAuthenticator.authenticateBearer` is the connection-entry authentication seam. `IdentityResolver` does not replace it.
- W1 owns credential verification, context construction, and `grantVersion` reconnect comparison.
- W2 owns resource authorization and Grant-change semantics.
- W3 owns Session subscription teardown, cache/session cleanup, and active outbound invalidation.
- Session binding contains no bearer secret and is not an authorization decision by itself.
