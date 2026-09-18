# ADR-0050: Local plane break-glass admission

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-16)
- Raised by: W3 while implementing the local planes of [ADR-0038](0038-local-transport-planes.md)

## Decision

In enterprise mode the local token alone admits no one. ADR-0038's clause allowing it to admit a
break-glass Owner when explicitly enabled is withdrawn and will not be implemented.

Break-glass over the local planes keeps working by presenting the daemon password:
`EnterprisePrincipalAuthenticator` admits it over a `direct` connection from `loopback` or
`local_ipc`, and writes `identity.break_glass.use` with `priority: "high"` at
`durability: "required"`. The control plane already passes exactly that context, so an operator who
holds the password can recover an enterprise node over `run/control.sock` today.

No configuration flag is added. Nothing in `MutableDaemonConfig` — which a client with
`daemon.manage` can write over the wire — can enable token-only admission, because the capability
does not exist.

## Why

The withdrawn clause was a **no-password** path, and it changed what guards Owner authority:

| Path                   | What the caller must hold                           |
| ---------------------- | --------------------------------------------------- |
| Password break-glass   | the daemon password, plus read access to `run/`     |
| Token-only break-glass | read access to `run/local-token` (a 0600 file) only |

Anything running as the daemon's user — an Agent process, a shell hook, a compromised dev tool —
can read `run/local-token`. Under the token-only path that became full Owner of an enterprise node,
holding every `ENTERPRISE_ACTION` over the whole organization selector. The audit event would have
recorded it without preventing it. The daemon password is a secret the operator holds; the local
token is a file every process running as that user can read, and treating the two as equivalent on
a multi-user node collapses the distinction the enterprise admission model rests on.

Implementing it would also have meant changing `enterprise/identity/authenticator.ts`, which is
W1-owned, from W3.

## Consequences

- In enterprise mode the control plane requires a PAT, Session Ticket, or the daemon password,
  exactly as `production-control-plane.test.ts` proves: local token alone is 401, PAT alone is 401,
  and only token plus credential reaches 101.
- ADR-0038's break-glass sentence is amended to state the rule rather than defer it.

## Amends

- [ADR-0038](0038-local-transport-planes.md) break-glass admission clause.
