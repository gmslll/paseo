# ADR 0017: Browser Profile runtime authorization

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

`BrowserProfileRecord` contains node-local `partitionKey` and `downloadRoot` values. They cannot be
exposed through UI projections or accepted from the renderer. Electron still needs an allowlist
before attaching a Profile WebView, including for a tab opened by the user before an automation
request arrives.

## Decision

W4 defines a non-wire `BrowserProfileRuntimeAuthorization` with exactly these fields:

- `organizationId`;
- `homeNodeId`;
- `workspaceId`;
- `browserProfileId`;
- `bindingRevision`;
- `lifecycleGeneration`.

W3 creates `bindingRevision` as an opaque in-memory revision whenever an authenticated Profile
binding set changes. It is not a wire field or an authorization fact. W3 hydrates and revokes these
entries through the Desktop bridge. Electron main binds each entry to the sending host WebContents
and the current lifecycle generation.

Electron main derives the persistent partition and download directory from a strictly validated
`browserProfileId` and trusted node configuration. A caller cannot provide either path. The W4
Profile store validates persisted `partitionKey` and `downloadRoot` against the node's canonical
runtime path resolver and quarantines a mismatched record.

Attach, popup, download, and automation paths require an active allowlist entry for the same host,
organization, node, Workspace, Profile, binding revision, and lifecycle generation. Automation also
requires the daemon-supplied lease and fencing context. Revocation or generation replacement
unregisters and destroys affected browser instances. An existing Browser ID cannot change its
Workspace or Profile binding.

## Ownership

- W4 owns the runtime authorization type, canonical path resolver, Electron allowlist, Browser
  registry enforcement, and Desktop bridge methods.
- W3 calls hydrate and revoke only from authenticated Profile and binding projections and owns the
  lifecycle generation.
- W1 supplies normalized host capability, trusted node identity, and actual response sender identity
  to the Broker registration path.
- W6 renders projected Profile state and does not create runtime authorization records.
- W7 owns cross-process Electron evidence.

## Boundary

- This decision adds no Session wire field and does not expose `partitionKey` or `downloadRoot` to
  W6, Agent tools, or Browser Automation commands.
- Legacy single-user tabs keep `persist:paseo-browser` behind the existing capability gate.
- `BrowserProfileRuntimeAuthorization` is an in-process/Desktop integration contract. It does not
  replace ResourceAuthorization, Profile binding authorization, leases, or fencing.
