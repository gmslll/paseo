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

## Required evidence

- A real daemon worker with enterprise configuration reaches bootstrap using
  the production factory without test-only dependencies.
- The factory rejects unavailable audit, identity, GrantStore, OwnerRegistry,
  authorization, or workspace providers with zero listener/Session/binary
  publication and complete cleanup.
- A Darwin cross-flow proves one audit → admission handle → W2 runtime → W5
  runtime → Session chain, including reconnect generation and release.

Until this ADR is accepted and implemented, enterprise production startup and
the remaining dispatcher families stay unavailable by default.
