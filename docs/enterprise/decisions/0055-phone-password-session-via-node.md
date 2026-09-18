# ADR-0055: Phone password login through the node HTTP proxy

- Status: DECISION_REQUIRED
- Date: 2026-09-18
- Raised by: USB debug App sign-in against a local management plane
- Decision owner: Enterprise integration owner

## Context

ADR-0030 is Accepted. A human Principal submits username and password over
management-plane HTTPS and receives a short-lived node Session Ticket. The
plane stores the bcrypt hash and never sends the password to a Paseo node. The
node only exposes unauthenticated `GET /api/enterprise/bootstrap` so a
signed-out client can find that plane URL.

A USB or LAN phone cannot pin the local plane CA. `fetch` to
`https://192.168.1.42:17443/v1/auth/password/session` fails TLS. The same
constraint already forced collab off the plane: ADR-0032 presence/SSE stays
client-only, and `collab.subscription.poll` has the node mint the stream token
and long-poll with CA-pinned HTTPS.

Uncommitted work on `enterprise/lody-m0-contracts` adds
`POST /api/enterprise/password-session` on the node. The App posts
`{ username, password, clientId, ttlMs }` to the node over the existing
direct HTTP connection (`localhost:6767` via `adb reverse`). The node fills
`nodeId`, CA-pins, and forwards to `/v1/auth/password/session`. The password
is request memory only: not logged, not stored, not copied into host
profiles. Wrong password is `401`. The ticket is still `pmt_v1.` and still
binds node, server, Principal, client, Grant version, and revocation epoch.

This is the collab poll shape applied to password exchange. It contradicts
the ADR-0030 sentence that the password never reaches a Paseo node.

## Options

1. Keep the node forwarder as the phone and other non-pinning client path.
   Amend ADR-0030: the App must not dial the plane; the node may forward the
   password exchange with CA-pinned HTTPS and must not persist the secret.
2. Keep ADR-0030 as written. The App POSTs to the plane. Phones then need a
   trusted CA, a debug network-security override, or an
   `allowInsecureLoopback` HTTP listener whose issuer still matches
   `relationship.managementBaseUrl`.
3. Restrict the forwarder to development builds (`sh.paseo.debug`) and leave
   packaged clients on plane HTTPS.

## Ask

Which option is V1 for USB/LAN phones signing in to a self-signed local
plane? Do not expand or delete `POST /api/enterprise/password-session` until
that is chosen.

Pickup: [collab-scene-3-remaining.md](../collab-scene-3-remaining.md).
