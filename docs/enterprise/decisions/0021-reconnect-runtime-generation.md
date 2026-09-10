# ADR-0021: Reconnect must replace the session authorization runtime

Status: Accepted

## Context

Reconnect replaces the W1 opaque admission handle when the authorization
generation changes. W2 runtime records are bound to that exact handle and to the
Session authorization identity. Reusing the old runtime after a successful W1
replacement would make binary/resource checks stale even if the Session object is
kept for continuity.

## Decision

On enterprise reconnect, W1 must create a new W2 authorization runtime for the
new handle before publishing the replacement. W3 exposes one closed, atomic
runtime replacement operation on Session: it validates the new runtime against
the Session identity, installs it, and releases the old runtime exactly once.
If validation or installation fails, the new runtime and handle are released and
the old Session remains untouched. A full Session reconstruction is an allowed
equivalent only if it preserves the same cleanup and publication guarantees.

## Required evidence

- Old runtime becomes non-current immediately after replacement.
- New runtime is bound to the new handle and exact Session identity.
- Binary delivery during the swap is serialized; no frame is sent through the
  old runtime after replacement.
- Failure leaves the old Session usable or tears it down once, with no leaked
  handle/runtime.

Accepted evidence: integration commit `247296832` and the W1 reconnect relay
matrix covering generation replacement and teardown ownership.
