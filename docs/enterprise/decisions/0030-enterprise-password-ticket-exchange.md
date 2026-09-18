# ADR-0030: Enterprise password ticket exchange

- Status: Accepted
- Date: 2026-09-12
- Decision owner: Enterprise integration owner

## Decision

Human Principals may sign in with a unique, case-insensitive username and password. The management
plane stores a bcrypt cost-12 password hash and never sends the password to a Paseo node. A client
submits the password over management-plane HTTPS and receives a short-lived Session Ticket bound to
one node, Paseo server, Principal, credential, client, Grant version, and revocation epoch. The
client then authenticates its direct WebSocket connection with that ticket.

The node exposes an unauthenticated `/api/enterprise/bootstrap` projection containing only the
management URL, node ID, and Paseo server ID. This lets a signed-out client find the password
exchange endpoint without opening an anonymous enterprise WebSocket. Standalone nodes return 404.

Personal access tokens remain available for administrator automation, recovery, and explicit token
sign-in. The management console continues to use an administrator PAT so an employee password
cannot become a management API credential.

Password reset replaces the credential ID, rotates the Principal Grant version, and increments the
revocation epoch. Nodes reject tickets issued before that change. The password exchange accepts at
most five failed attempts per source-address and normalized username in 60 seconds; its bounded
ledger holds at most 4,096 keys.

## Boundaries

- Password login is available only for human Principals and direct node connections.
- Passwords stay in component and request memory, are cleared after the request, and never enter
  host profiles, lifecycle projections, logs, audit events, node policy, or artifacts.
- The exchange returns only a node endpoint, expiry, and signed ticket. It does not return Grants or
  management credentials.
- Existing local daemon passwords remain the local break-glass Owner channel.

## Acceptance

Unit and browser tests cover bcrypt parameters, case-insensitive usernames, wrong-password denial,
bounded rate limiting, CORS from the desktop origin, node and server binding, password reset
revocation, secret-free client state, duplicate-submit suppression, managed-node discovery, and
standalone-node omission. Release validation also signs in a packaged desktop client against a real
management service and managed node.
