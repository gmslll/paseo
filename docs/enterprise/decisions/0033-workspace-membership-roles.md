# ADR-0033: Workspace membership roles

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A collaborative Workspace keeps exactly one `ownerPrincipalId` and adds members with one role each:

| Role     | Enterprise actions on that Workspace                                                       |
| -------- | ------------------------------------------------------------------------------------------ |
| `owner`  | `workspace.metadata.read`, `workspace.content.read`, `workspace.write`, `workspace.manage` |
| `editor` | `workspace.metadata.read`, `workspace.content.read`, `workspace.write`                     |
| `viewer` | `workspace.metadata.read`, `workspace.content.read`                                        |

The plane projects each membership into `ResourceGrant` entries with the existing
`{ kind: "workspace", workspaceIds }` selector. No enterprise action or selector kind is added
(ADR-0008). Any membership change increments the member's Grant version, which reuses the existing
Session invalidation path.

Invitations stay inside one organization. Public share links are out of scope.

## Amends

- Master spec §9.1: one owner plus members instead of owner-only access.
- Master spec §8.3 preset table and §2.3 employee visibility.
- Master spec §11.2: collaborators share a cwd only through membership in the single Workspace
  record. Registering a second Workspace record for the same cwd stays forbidden.

## Node policy

`getNodePolicy` sends `workspaceMemberships` only to nodes whose heartbeat declares the
`collaborationV1` capability, and only for Workspaces placed on that node. Older nodes parse the
policy response strictly and must never receive the field.

## Ownership transfer

ADR-0027 transfer removes the previous owner's access. Members keep their roles. When the new owner
was an editor or viewer, the membership row is replaced by the owner role.

## Acceptance

Tests cover role × action authorization, membership Grant projection, Grant version increment and
Session teardown, per-node policy filtering, capability-gated policy delivery, and transfer member
reconciliation.
