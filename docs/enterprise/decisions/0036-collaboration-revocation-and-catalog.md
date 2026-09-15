# ADR-0036: Collaboration revocation, tombstones, and workspace catalog

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

Each node keeps `$PASEO_HOME/enterprise/collab/workspace-catalog.json`. An entry records
`workspaceUid`, `localWorkspaceId`, `ownerPrincipalId`, members, `state`, `cachedAt`, and
`remoteMissingAt`. States are `active`, `remote_missing`, and `revoked`.

- A plane 404 for a Workspace sets `remote_missing`. Syncing stops, members are denied on the node,
  and the owner keeps local access.
- An explicit plane revocation sets `revoked`. Every member Session for that Workspace receives a
  tombstone and its subscriptions close.
- While the plane is unreachable, member access follows the policy-staleness fail-closed rule in
  master spec §5.1.8. Owners keep local access.

When a member is removed:

1. the plane increments the member's Grant version;
2. the member's SSE subscriptions receive `revoked` and close;
3. the node tears down the member's direct and headless Sessions;
4. clients evict the replica partition keyed by `(organizationId, principalId, workspaceUid)`.

## Amends

- ADR-0027: transfer keeps members (ADR-0033).
- Master spec §10.2 revocation delivery and §10.3 cache keys, which gain `workspaceUid`.

## Acceptance

Tests cover each catalog state transition, member denial on `remote_missing`, tombstone delivery on
removal, and replica eviction on the client.
