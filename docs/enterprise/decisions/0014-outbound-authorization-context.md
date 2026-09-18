# ADR 0014: Persisted owner filtering and outbound authorization context

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Persisted Workspace rows can have all owner fields missing or only a partial owner envelope during
upgrade and corruption cases. Requiring complete ownership at the `filterWorkspaces` type boundary
would prevent W2 from quarantining those rows.

Some outbound messages have no resource key. Passing only the message to `canEmit` would encourage
W3 to infer authority from payload text, a cwd, or a client field. Treating all status and error
messages as transport control would leak resource existence and paths.

Legitimate identity, access, audit, node, Hub, daemon, plugin, and Provider responses also may not
identify a Workspace, Agent, Browser Profile, or App Slot. Giving them a fabricated
`GlobalResourceRef` would make the reference lie about the authority that admitted the request.

## Decision

`EnterpriseWorkspaceAuthorizationRecord` is a row ID plus optional wire owner fields.
`ResourceAuthorization.filterWorkspaces` accepts and returns the caller's same row type. The
enterprise adapter excludes legacy-owner-only and partial-owner rows. `AuthorizedWorkspace`
requires the complete owner envelope.

`ResourceAuthorization.canEmit` receives a third, non-wire `OutboundAuthorizationContext` created
from server request or emit state. Its strict discriminated branches are:

- `resources`, with at least one server-resolved `GlobalResourceRef`; and
- `authority`, containing a strict `authorized_request` receipt or `identity_self` authority; and
- `transport_control`, limited to a matching `pong` or `server_info` message.

An `authorized_request` authority carries a server-minted opaque `receiptId`, the authorized
`requestId` and open-string `requestType`, and the current `sessionBindingKey` and
`sessionBindingGeneration`. W3 registers the receipt only after successful inbound authorization.
The server-side receipt record binds the exact Principal organization, principal, credential, and
Grant version; node; Session and client; generation; and request type and ID. A client can neither
submit nor mint this non-wire context.

W2 keeps an exhaustive request-to-outbound-message table even though `requestType` stays open in
the W0 schema. Before emission, `canEmit` verifies the event/request pair and request ID, the
receipt's current Session and Principal binding, the original coarse permission and enterprise
action, and the current Grant guard. A receipt is invalid after use or when its request ends,
fails, is cancelled, or loses its Session binding.

`identity_self` carries the current `sessionBindingKey` and `sessionBindingGeneration` and is
limited to that bound Session. Its strict `message` object is discriminated by `type`; the exact
allowlist is
`enterprise.identity.get_current.response`, `enterprise.identity.logout_all.response`,
`enterprise.identity.scope_refreshed`, and `enterprise.identity.credential_revoked`. The two
responses require the matching `requestId`; the two events carry no request ID. W2 and W3 reject a
different event type, request ID, Session binding key, or generation. This branch does not confer
organization-wide identity authority.

Every context and nested authority object rejects unknown fields, empty required strings, and
wrong value types. `GlobalResourceRef` remains limited to its existing four resource kinds; the
authority branch is not a general bypass.

`rpc_error`, status updates other than `server_info`, source events, and binary data are not
transport-control bypasses. `rpc_error` uses the resource context associated with its request ID.
If no such context exists, the server may send only a fixed redacted protocol error.

Organization resource metadata adds no V1 action. Organization-wide metadata uses an
`organization` selector with `workspace.metadata.read`; a row bound to a Workspace may instead be
shown after that Workspace is authorized for metadata read. Browser Profile management still
requires `browser.profile.manage`, and execution requires `browser.use` or `app.use`. An unbound
Browser Profile or App Slot row with no applicable organization authorization is hidden.

## Ownership

- W2 implements persisted-row quarantine and resource assertions.
- W2 owns the exhaustive request/event mapping and all `canEmit` permission, action, Grant, and
  receipt-validity checks.
- W3 registers and invalidates authorized-request receipts and carries server-side request/emit
  context into every outbound check.
- Clients cannot submit `OutboundAuthorizationContext`.
