# ADR-0026: Provider history and search resource contract

- Status: Accepted (P0 denial contract; resource-specific design deferred)
- Date: 2026-09-11
- Decision owner: Enterprise integration owner

## Problem

The implementation master requires that Provider history and search cannot disclose another
Principal's content through recents, search, or imported sessions. Existing contracts do not define
a canonical Provider-history resource kind, resource reference, or server-side resolver. ADR-0012
adds an optional `workspaceId` to legacy Provider requests, but that compatibility field is not an
authorization contract. ADR-0024 also leaves search out of its four-family content-read scope.

Treating provider recents/search as a generic RPC, a cwd/path lookup, or a legacy fallback would
make W2 authorization non-exhaustive and would permit cross-Principal inference.

## Accepted P0 denial contract

P0 does not add Provider-history/search wire families, resource kinds, or legacy compatibility
fields. When an enterprise Session reaches an existing Provider recents or search entry point, the
server must perform the enterprise admission check before any Provider, filesystem, cache, or
search work. It returns exactly one correlated, redacted `access_denied` response containing the
existing request correlation (`requestId` where present) and no Provider/resource details. The
response shape is identical for foreign, missing, stale, unbound, and no-Grant cases, and the
denial has zero side effects.

The corresponding enterprise capabilities remain absent. Absence is not a `false` advertisement
and does not authorize a client fallback to global recents, cwd/path reads, or another generic
search/history RPC. The existing `provider.history.read` and `provider.history.import` actions do
not bypass this P0 denial contract.

## Deferred resource-specific design

Future resource-specific recent/search families may define a server-resolved ProviderHistory
reference, selector, bounded opaque pagination, and canonical redacted payload. That design is
deferred and must return to `DECISION_REQUIRED` before implementation. It must not be inferred from
the existing `workspaceId` compatibility field or from static/unit evidence.

## Fail-closed and capability rule

Until a future family is separately accepted and has W0 strict schemas, a W2 exhaustive
inventory/resolver, a W3 current Session/receipt consumer, required Grant/action/audit checks, a
production Provider source, and real foreign/missing/no-Grant denial evidence, enterprise mode must
keep its capability absent and enforce the P0 denial above. Static handlers, unit/source tests, or a
legacy `workspaceId` field do not constitute a production call site or capability evidence.

## Ownership and acceptance gates

- W0 owns this denial contract and any future wire schemas after a new decision.
- W2 owns the existing-entry inventory, admission check, and non-enumerating denial behavior.
- W3 owns Session correlation and required denial audit assembly.
- W5 owns the Provider source boundary; W7 supplies real Darwin evidence where the production
  boundary is packaged or desktop-facing.

Acceptance of any future read capability requires two-Principal real-daemon evidence proving
authorized recent/search reads, foreign and missing references, no-Grant denial with zero side
effects, and no disclosure through global recents or search. Until then only the P0 denial contract
is active.
