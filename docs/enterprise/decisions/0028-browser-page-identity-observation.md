# ADR-0028: Browser page identity observation ownership

- Status: Accepted (implementation pending)
- Date: 2026-09-11
- Decision owner: Enterprise integration owner

## Decision

Browser page identity observation is a server- and host-owned fact used to gate Browser Profile
actions. The observation path is not a caller assertion and is not inferred from an Agent message.

- **W4** owns the browser-tools observation adapter, the daemon-side observation registry, and the
  Desktop publisher that forwards observations to the authenticated Session.
- **W0** owns the strict optional wire schema and optional capability flag. The capability remains
  absent until the observer transport, bootstrap, W2 gate, production publisher, and E2E evidence
  are all ready.
- **W1** supplies only authenticated `clientId` and `homeNodeId` binding. It does not attest page
  identity or browser state.
- **W2** verifies the nominal observation before Browser authorization and applies the existing
  resource/action Grant checks. A missing, stale, malformed, or mismatched observation fails
  closed.
- **W7** owns the real mismatch E2E, including a page-account/Profile mismatch and denial before
  any high-risk Browser action or side effect.

Observation and invalidation are separate protocol contracts. W0 defines the strict
`enterprise.browser.page_identity.observe.request/response` path and the independent
`enterprise.browser.page_identity.invalidate.request/response` path, with
`enterpriseBrowserPageIdentityObservationV1` and `enterpriseBrowserPageIdentityInvalidationV1`
advertised independently. The overall page-identity capability is ready only when both contracts,
their production handlers, current-generation checks, required audit, denial evidence, and E2E
gates are ready; otherwise the capability remains absent.

Every lifecycle boundary must invalidate before replacing or releasing an observation:
navigation start, navigation replacement, WebView/guest destroy, Browser unregister, exact
generation revoke or logout, and host teardown. Invalidation is the revocation boundary; an
observation TTL is freshness metadata only and never substitutes for explicit invalidation or
generation fencing.

The W4 candidate `aaf0418e4` is not independently mergeable. It must land only with the observer
transport and bootstrap wiring, W2 authorization gate, capability computation, and W7 mismatch E2E
as one closed production chain.

## Wire and trust boundary

W0's future wire addition is a strict, optional observation projection and capability. It may carry
only server/adapter-produced identity facts correlated to the current Session, Browser Profile, and
generation. Unknown fields, empty values, stale generations, or invalid correlations are rejected;
absence is represented by an absent capability, never by a client-side fallback.

Callers and Agents must never self-report or override `hostname`, page/account hash, filesystem
path, PAT, credential, lease, partition, or Browser ID as identity evidence. Those values are not
authority fields. The client cannot manufacture an observation to satisfy W2, and W1's
`clientId`/`homeNodeId` binding cannot substitute for page identity.

## Acceptance gates

Acceptance requires one production chain covering: W4 adapter and daemon registry, authenticated
observer transport through bootstrap/Desktop publisher, W2 nominal verification before Browser
authorization, optional capability advertisement only when the chain is release-ready, and W7 real
page-account/Profile mismatch denial. Unit or static adapter evidence alone is insufficient.
