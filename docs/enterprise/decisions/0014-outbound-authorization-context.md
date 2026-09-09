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

## Decision

`EnterpriseWorkspaceAuthorizationRecord` is a row ID plus optional wire owner fields.
`ResourceAuthorization.filterWorkspaces` accepts and returns the caller's same row type. The
enterprise adapter excludes legacy-owner-only and partial-owner rows. `AuthorizedWorkspace`
requires the complete owner envelope.

`ResourceAuthorization.canEmit` receives a third, non-wire `OutboundAuthorizationContext` created
from server request or emit state. Its discriminated branches are:

- `resources`, with at least one server-resolved `GlobalResourceRef`; and
- `transport_control`, limited to a matching `pong` or `server_info` message.

`rpc_error`, status updates other than `server_info`, source events, and binary data are not
transport-control bypasses. `rpc_error` uses the resource context associated with its request ID.
If no such context exists, the server may send only a fixed redacted protocol error.

## Ownership

- W2 implements persisted-row quarantine and resource assertions.
- W3 carries server-side request/emit context into every outbound check.
- Clients cannot submit `OutboundAuthorizationContext`.
