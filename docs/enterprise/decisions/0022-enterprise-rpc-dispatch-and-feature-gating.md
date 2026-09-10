# ADR-0022: Register enterprise RPC dispatch and feature gates

Status: Accepted

## Context

The protocol and authorization inventory declare enterprise request/response
types, but the server request dispatcher currently has no enterprise cases and
`server_info.features` does not advertise the enterprise capability flags.
Typed policy modules therefore have no production call site, which leaves the
release checklist cases at `MISSING_CALL_SITE`.

## Decision

Integration/root owns cross-domain assembly: bootstrap/runtime construction, the
single dispatcher registry, feature computation, and the final real-daemon
integration. W3 owns the session dispatch seam, receipt lifecycle, and daemon
client wrappers. W1 owns identity handlers; W2 owns access, organization, and
local placement handlers; W4 owns browser and lease handlers; W7 owns audit
handlers and their adversarial evidence. W6 only consumes production ports after
the corresponding feature is advertised. Node management is W8/P2 and is not
implemented in this batch.

Batch A delivers the W3 seam and client wrappers, with a completeness API and
all enterprise flags absent by default. Unregistered operations return the
uniform non-enumerating unavailable response. Batch B delivers the Identity,
ResourceAuthorization, BrowserProfiles/Lease, and Audit families. Batch C
assembles each family and advertises its flag only after its handlers,
lifecycle, and denial evidence are complete. Batch D adds W6 consumers and
real-daemon two-Principal/concurrency evidence for every operation.

Every handler receives a server-bound current Principal/session context and
reuses the W1/W2/W3 current guards and authority receipts. Domain policy stays
in its owning family; the registry only routes already-resolved requests.

The same enterprise runtime state must drive the four P0/P1 feature
advertisements:
`enterpriseIdentityV1`, `enterpriseResourceAuthorizationV1`,
`enterpriseBrowserProfilesV1`, and `enterpriseAuditV1`. A feature is advertised
only when its complete server handler and lifecycle dependencies are ready;
clients gate the feature once from `server_info` and do not use a fallback.
The protocol's fifth `enterpriseDistributedNodeV1` flag remains absent until
the W8/P2 implementation is delivered.

## Required evidence

- Real daemon requests for every registered operation, including foreign and
  missing resource identifiers, with one uniform denial and no side effects.
- `server_info` advertises exactly the capabilities whose handlers are ready;
  disabled or unavailable capabilities are absent.
- Two principals exercise the same operation concurrently without cross-tenant
  data, cache, audit, or lease effects.

Accepted by W0 in the 2026-09-10 integration decision. This decision crosses
W0 protocol, W1 identity, W2 authorization, W3 lifecycle, W4 browser, and W6
UI ownership; the owner split above prevents a domain policy from being hidden
inside the registry.
