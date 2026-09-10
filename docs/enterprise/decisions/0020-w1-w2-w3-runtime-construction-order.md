# ADR-0020: Preconstruct session authorization before enterprise runtime

Status: Accepted

## Context

The W2 production authorization factory requires the opaque admission handle,
the session's `SessionAuthorization`, and the canonical `sessionId`. The current
W3 Session constructor creates the latter two internally, while W1 must create
the W2 runtime before constructing an enterprise Session so a failed factory
cannot publish a partially authorized Session.

## Decision

Use the preconstruction seam (方案 A): W1 creates the canonical `sessionId` and
`SessionAuthorization`, calls `createEnterpriseAuthorizationRuntime`, and passes
the resulting frozen runtime plus those exact objects into `SessionOptions`.
If the factory returns `null` or a current check fails, W1 does not construct an
enterprise Session. W3 must preserve object identity and must not recreate either
value. Legacy sessions keep their existing constructor path.

## Consequences

Session construction remains synchronous and cleanup can await the runtime's
shared `release()` barrier. The Session options surface gains a typed
preconstructed authorization/session identity seam. W1 owns production assembly;
W3 owns consumption and cleanup. No W2 implementation changes are required.

## Required evidence

- W1→W2→W3 integration creates the runtime before enterprise Session creation.
- Factory `null`, admission revoke, or audit close produces no Session or binary
  delivery.
- The injected authorization and session ID are identical to the values used by
  the runtime, and cleanup awaits `runtime.release()` exactly once.

Accepted evidence: integration commits `82e951186`, `8bbee493e`, `24aac92cb`, and
the Darwin ownership cross-flow test in `production-ownership-crossflow.test.ts`.
