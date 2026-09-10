# ADR-0023: Production enterprise runtime factory ownership

Status: **DECISION_REQUIRED**

## Context

Enterprise mode currently has only the bootstrap dependency hook
`createEnterpriseAdmissionRuntime`. No production implementation constructs the
runtime used by the daemon worker. The required objects are distributed across
W1 identity/admission, W2 GrantStore/OwnerRegistry/authorization state, W3
session receipt state, and W5 workspace runtime. Starting enterprise mode from
`daemon-worker.ts` therefore fails closed because no factory is supplied.

The dispatcher registry and feature flags are now assembled by integration, but
they cannot create or infer these authority objects. A test fixture or a
structural cast would break the same-source and current-guard contracts.

## Decision required

Integration/root must own one production factory module and pass its bound
factory to `createPaseoDaemon`. The factory must construct and retain, in this
order:

1. the current ProductionAuditCapability and canonical NodeContext;
2. the W2 authoritative GrantStore, OwnerRegistry, and ResourceAuthorization;
3. the W1 EnterpriseAdmission and its identity persistence/invalidation ports;
4. the W3 EnterpriseAgentSessionContextRegistry and receipt/emission state;
5. the W5 workspace-files provider and its release barrier.

The returned `EnterpriseAdmissionRuntime` must preserve exact object identity
for audit, admission, node, current guards, and provider state. Any missing,
foreign, non-current, or non-release-ready dependency rejects construction
before a listener or Session is published. Failure cleanup must await each
created resource once and aggregate errors in primary-to-dependent order.

`daemon-worker.ts` must receive this factory through a typed integration
dependency. W1, W2, W3, and W5 must expose only the narrow constructor ports
needed by the factory; they must not assemble cross-domain policy in their own
worktrees.

## W0 owner ruling for production storage sources

W0 does not authorize integration/root to create a second identity or Grant
storage implementation. W1 must expose the typed production identity side, and
W2 must expose the typed production Grant side. Integration/root owns only the
cross-domain composition adapter and the factory lifecycle:

- W1 owns durable Principal identity metadata and credential persistence under
  `enterprise/identity/**`. Its production adapter must use the existing
  `IdentityRegistry` durability and credential-verification behavior, expose a
  typed Principal identity source, and provide a non-noop credential
  invalidation publisher bound to the current admission issuer. The publisher
  must invalidate the exact credential or Principal authority after the
  credential mutation commits and expose the event for W3-owned active-Session
  teardown.
- W2 owns `FileBackedGrantStorage`, the authoritative `GrantStore`, Grant
  versions, and Grant invalidation under `enterprise/access/**`. The production
  Principal Grant projection must read the exact `GrantStore` instance retained
  by the production authorization provider; it must not open a second Grants
  file or construct a second store.
- Integration/root may derive and freeze the canonical
  `paseoHome/enterprise/{principals,credentials,grants}.json` paths and compose a
  `PrincipalGrantSource` from the W1 Principal identity source plus the W2
  authoritative `GrantStore`. The composition must require exact Principal and
  organization agreement and return the W2 Grant version and normalized Grants.
  It then constructs W1 admission, wires the W1 invalidation publisher to W3
  Session cleanup, and retains those same objects for per-Session runtime
  construction.

There is no memory-backed, empty-registry, no-op invalidation, synthetic
Principal, structural-cast, or owner-only fallback in enterprise mode. Missing,
corrupt, foreign, or mismatched identity/Grant state rejects the production
factory before the listener or any Session is published. W1 and W2 may add the
narrow typed constructors needed by this ruling inside their existing owned
directories; no protocol or wire field is added.

## Required evidence

- A real daemon worker with enterprise configuration reaches bootstrap using
  the production factory without test-only dependencies.
- The factory rejects unavailable audit, identity, GrantStore, OwnerRegistry,
  authorization, or workspace providers with zero listener/Session/binary
  publication and complete cleanup.
- Restart evidence proves Principal and credential persistence, Grant
  persistence, and exact reattachment to one authoritative `GrantStore`.
- Credential revoke, rotate, and logout-all evidence proves committed
  invalidation reaches admission authority and W3 Session teardown; a missing or
  failed invalidation publisher fails closed rather than degrading to a no-op.
- A Darwin cross-flow proves one audit → admission handle → W2 runtime → W5
  runtime → Session chain, including reconnect generation and release.

Until this ADR is accepted and implemented, enterprise production startup and
the remaining dispatcher families stay unavailable by default.
