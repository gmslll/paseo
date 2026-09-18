# ADR-0023: Production enterprise runtime factory ownership

Status: **ACCEPTED (contract; implementation pending)**

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

## Accepted contract

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

## Minimal identity document and invalidation event

The W1 durable Principal source uses one strict, versioned document. This is an
internal file contract, not a wire shape; unknown keys, mismatched record keys,
empty required strings, invalid identifiers, and persisted `break_glass_owner`
records are rejected.

```ts
const EnterpriseIdentityPrincipalRecordSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  organizationId: OrganizationIdSchema,
  principalType: z.enum(["human", "service"]),
  status: z.enum(["active", "disabled", "revoked"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  displayName: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const EnterpriseIdentityDocumentSchema = z
  .strictObject({
    version: z.literal(1),
    principals: z.record(PrincipalIdSchema, EnterpriseIdentityPrincipalRecordSchema),
  })
  .superRefine((document, ctx) => {
    for (const [key, principal] of Object.entries(document.principals)) {
      if (key !== principal.principalId) {
        ctx.addIssue({
          code: "custom",
          path: ["principals", key],
          message: "principal key mismatch",
        });
      }
    }
  });
```

The W1 registry's existing committed mutation event remains an internal
`CredentialInvalidation` input. The integration bridge enriches it with the
current W2 Grant version and fans it out once per affected live Session to the
W3 teardown registry:

```ts
type CredentialInvalidationKind =
  | "credential.revoke"
  | "credential.rotate"
  | "principal.logout_all";

const CredentialIdSchema = z.string().regex(/^cred_[0-9a-f]{24}$/);

const CredentialInvalidationEventSchema = z.strictObject({
  kind: z.enum(["credential.revoke", "credential.rotate", "principal.logout_all"]),
  credentialIds: z
    .array(CredentialIdSchema)
    .min(1)
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "duplicate credential id" });
    }),
  principalId: PrincipalIdSchema,
  organizationId: OrganizationIdSchema,
  grantVersion: z.string().min(1),
  sessionBindingGeneration: z.string().min(1),
});

interface CredentialInvalidationEvent {
  readonly kind: CredentialInvalidationKind;
  readonly credentialIds: readonly [string, ...string[]];
  readonly principalId: PrincipalId;
  readonly organizationId: OrganizationId;
  readonly grantVersion: string;
  /** Exactly one currently bound Session generation; never a client field. */
  readonly sessionBindingGeneration: string;
}

interface CredentialInvalidationPublisher {
  publishCredentialInvalidation(event: CredentialInvalidationEvent): Promise<void>;
}
```

The runtime schema for this event is strict and requires non-empty
`credentialIds`, `grantVersion`, and `sessionBindingGeneration`; it rejects
unknown fields and duplicate or invalid identifiers. The bridge first commits
the W1 mutation, invalidates the matching W1 admission credential or Principal
authority, resolves the current Grant version from the same W2 `GrantStore`,
then publishes one event for each current Session generation. A multi-Session
`logout_all` therefore produces multiple events with distinct generations. If
there is no live Session, no W3 event is needed, but admission invalidation is
still mandatory. Any issuer or teardown-publisher failure rejects the operation
after commit via the existing committed-invalidation error; it must never
degrade to a no-op.

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
- Strict identity-document tests cover versioning, Principal key equality,
  unknown-field rejection, and restart durability. Event tests cover two
  concurrent Sessions, distinct generation fan-out, current Grant-version
  binding, and issuer/teardown failure handling.
- A Darwin cross-flow proves one audit → admission handle → W2 runtime → W5
  runtime → Session chain, including reconnect generation and release.

This contract is accepted, but enterprise production startup and the remaining
dispatcher families stay unavailable by default until the typed sources, bridge,
root factory, daemon-worker injection, and required real-daemon evidence are
implemented.
