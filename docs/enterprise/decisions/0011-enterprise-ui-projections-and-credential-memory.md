# ADR 0011: Enterprise UI projections and credential memory

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

The app needs identity, Browser Profile, resource, and organization metadata without receiving
authentication material, Browser Profile storage keys, or content it has not opened. Persisting a
personal access token in a Host Profile or AsyncStorage would also place the token in durable app
state outside the P0 credential boundary.

## Decision

Enterprise UI RPCs use dedicated projections:

- `get_current` returns `CurrentIdentityProjection`, not `PrincipalContext`;
- `list_profiles` returns `BrowserProfileSummary` and
  `BrowserProfileBindingProjection`, not `BrowserProfileRecord`;
- `resource.status` returns `EnterpriseResourceStatusProjection` with a
  `GlobalResourceRef`, UI state, redacted label, queue metadata, and projected operations, but no
  holder;
- `organization.list_resources` returns Principal summaries and metadata-only discriminated
  Workspace, Agent, Browser Profile, and AppSlot rows.

Navigation, operation, and reason-code values are open strings on the wire. The client explicitly
normalizes them against its supported display vocabulary and ignores unknown values. They never
authorize a server operation.

Boss metadata access does not require `identity.manage`. Boss content still uses each existing
resource-specific read operation; W3 rechecks W2 authorization for every read and W7 verifies the
audit event. Do not add a generic content payload RPC.

P0 stores the personal access token only in a process-memory `CredentialVault`. Do not put it in a
Host Profile, AsyncStorage, IndexedDB, navigation state, or logs.

W6 may make the minimum route, sidebar, Agent panel, and localization wiring needed to consume
these projections. W6 does not own server authorization, cache safety keys, or credential
persistence.

## Consequences

- Projection helpers construct safe output field by field.
- UI stores may cache projections, but not raw `PrincipalContext`, full Browser Profile records,
  or access tokens.
- New display values can ship without breaking old clients; unsupported values remain hidden.
