# ADR-0050: Local plane break-glass admission

- Status: DECISION_REQUIRED
- Date: 2026-09-16
- Decision owner: Enterprise integration owner
- Raised by: W3 while implementing the local planes of [ADR-0038](0038-local-transport-planes.md)

## Problem

ADR-0038 states that in enterprise mode "the local token alone is admitted only as break-glass Owner
when explicitly enabled, and always writes a high-priority audit event". Implementing that clause
literally means minting a `break_glass_owner` Principal from the local token alone.

Break-glass already exists, and it is not token-only. `EnterprisePrincipalAuthenticator` admits the
daemon password as break-glass Owner when the connection is `transport: "direct"` with
`peer: "loopback"` or `"local_ipc"`, and it already writes `identity.break_glass.use` with
`priority: "high"` at `durability: "required"`. The control plane passes exactly that context, so an
operator who holds the daemon password can already recover an enterprise node over `run/control.sock`
today. That path is covered by `production-control-plane.test.ts`, which proves local token alone is
401, PAT alone is 401, and only token plus credential reaches 101.

So the unimplemented part of the clause is specifically a **no-password** path, and it changes the
guard on Owner authority:

| Path                   | What the caller must hold                           |
| ---------------------- | --------------------------------------------------- |
| Password break-glass   | the daemon password, plus read access to `run/`     |
| Token-only break-glass | read access to `run/local-token` (a 0600 file) only |

Anything running as the daemon's user — an Agent process, a shell hook, a compromised dev tool —
can read `run/local-token`. Under the token-only path that becomes full Owner of an enterprise node,
with every `ENTERPRISE_ACTION` over the whole organization selector. The audit event records it but
does not prevent it.

## Why this is not being implemented under ADR-0038

Two reasons, both procedural rather than a judgment on the merits:

1. **Workstream boundary.** Minting a break-glass Principal without the password means changing
   `enterprise/identity/authenticator.ts`, which is W1-owned. The local planes are W3. `CLAUDE.md`
   requires a cross-boundary change to stop and hand a `DECISION_REQUIRED` ADR to the integration
   owner rather than be implemented in place.
2. **The enabling switch has no safe home yet.** It must not be reachable from
   `set_daemon_config_request`: `MutableDaemonConfigSchema` is a protocol schema a client with
   `daemon.manage` can write, so putting the flag there would let a client turn on
   Owner-by-local-token over the wire. It belongs in the immutable startup config
   (`PaseoDaemonConfig`, fed from the on-disk `features` block), which is a W0/W1 surface.

## Options

1. **Drop the clause.** Password break-glass already covers local recovery over the planes. ADR-0038
   is amended to say the local token alone is never sufficient in enterprise mode. Nothing to build.
2. **Implement it as written**, behind an immutable, non-client-writable startup flag that defaults
   to off, with the existing high-priority required audit event, and a test proving token-only stays
   401 while the flag is off.
3. **Narrow it.** The local token alone admits a diagnostic identity that can read probe-level state
   and nothing else, never Owner. Recovery still requires the password.

## Recommendation

Option 1, unless there is a concrete recovery scenario where the operator has lost the daemon
password but still has filesystem access as the daemon user. The daemon password is a secret the
operator holds; `run/local-token` is a file every process running as that user can read. Treating
the two as equivalent on a multi-user node collapses the distinction the enterprise admission model
rests on. If such a scenario exists, option 3 serves it without granting Owner.

## Consequences until this is decided

- The local planes ship without any token-only admission. In enterprise mode the control plane
  requires a PAT, Session Ticket, or the daemon password, exactly as `production-control-plane.test.ts`
  proves.
- ADR-0038's break-glass sentence is annotated to point here so it is not read as implemented.

## Amends

- [ADR-0038](0038-local-transport-planes.md) break-glass admission clause.
