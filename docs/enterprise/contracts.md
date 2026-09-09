# Enterprise protocol and Port contracts

These contracts are the W0 boundary for the enterprise workstreams. The schemas and TypeScript
interfaces live in `packages/protocol/src/messages.ts` and
`packages/protocol/src/browser-automation/`.

## Compatibility

All additions to an existing wire shape are optional. Parse the wire shape first, then call the
explicit normalizer or projection helper. Do not put transforms, catches, or preprocessors in a
new enterprise wire schema. Tagged unions use a discriminator.

The five `ENTERPRISE_FEATURE_FLAGS` fields must stay identical in the constant, wire schema,
`server_info`, and normalizer. A missing field normalizes to `false`. The V1 vocabularies are
closed by [ADR 0008](decisions/0008-enterprise-v1-enum-freeze.md).

New enterprise RPCs use top-level request parameters and dotted request/response names:

| Capability                          | RPCs                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enterpriseIdentityV1`              | `enterprise.identity.get_current`, `enterprise.identity.list_principals`, `enterprise.identity.logout_all`                                                                         |
| `enterpriseResourceAuthorizationV1` | `enterprise.access.list_grants`, `enterprise.access.update_grants`, `enterprise.organization.list_resources`, `enterprise.placement.resolve_workspace`                             |
| `enterpriseAuditV1`                 | `enterprise.audit.list_events`                                                                                                                                                     |
| `enterpriseBrowserProfilesV1`       | `enterprise.browser.list_profiles`, `enterprise.browser.bind_profile`, `enterprise.resource.acquire_lease`, `enterprise.resource.renew_lease`, `enterprise.resource.release_lease` |
| `enterpriseDistributedNodeV1`       | `enterprise.node.list_nodes`, `enterprise.node.set_drain`                                                                                                                          |

Do not accept actor, holder, organization, credential, or execution-node authority from a client
request. `nodeId` in `node.set_drain` is the requested resource target, not authenticated context.

## Identity and authorization

`PrincipalAuthenticator` authenticates the connection entry point. `IdentityResolver` resolves a
credential for trusted internal use; it does not replace entry authentication.

`PrincipalContext` includes `grantVersion`. Session reuse binds organization, Principal,
credential ID, Grant version, and client ID. The binding contains no bearer secret. Normalize
Grant ordering before deciding whether a semantic change needs a new version.

`ResourceAuthorization` accepts full authenticated context and server-resolved resource IDs.
`filterWorkspaces` accepts legacy or partially owned persisted rows and preserves the caller's row
type; an enterprise adapter quarantines missing or partial ownership. `assertWorkspace`,
`assertAgent`, `assertBrowserProfile`, and `assertAppSlot` return fully authorized resources.

Every outbound authorization call also receives a non-wire `OutboundAuthorizationContext`.
Resource-bearing output requires at least one server-resolved `GlobalResourceRef`. The only
transport-control bypasses are a matching `pong` and `server_info`. `rpc_error` inherits the
request's resource context or becomes a fixed redacted protocol error.

## Replaceable Ports

Business code depends on `PrincipalAuthenticator`, `IdentityResolver`, `ResourceAuthorization`,
`PlacementResolver`, `LeaseCoordinator`, and `AuditSink`. The `Local*Contract` interfaces identify
the P0 in-process adapters with one standalone `NodeContext`; callers do not hardcode a singleton
daemon or derive a node from a path or resource ID.

Typed Port plus typed in-memory adapter tests are accepted contract evidence. Runtime integration
evidence follows [ADR 0009](decisions/0009-p0-evidence-and-capacity-gates.md).

## Ownership, Profiles, and leases

Legacy Agent and Workspace owner fields remain optional on the wire. Call
`normalizeEnterpriseResourceOwner`; all fields absent means a legacy row and a partial set throws.
Enterprise creation passes `AgentOwnershipEnvelope` before the first Agent storage write.

`BrowserProfileRecord.homeNodeId` is its only Profile node field. `ResourceLease` and
`GlobalResourceRef` use `nodeId`. Browser and AppSlot leases are discriminated so their ID prefixes
cannot be crossed. Lease wire requests contain only user intent; trusted holder, organization,
node, and TTL inputs belong to `LeaseCoordinator`.

Browser automation declares optional `enterpriseProfiles: { version: 1 }`. Normalize host
capabilities explicitly. Send the Profile/lease/fencing envelope only to a host declaring V1;
Agent-visible command arguments never contain a Profile ID.

## UI projections

UI RPCs return the projections in
[ADR 0011](decisions/0011-enterprise-ui-projections-and-credential-memory.md). Projection helpers
construct identity and Browser Profile summaries field by field. Organization resources are a
metadata-only discriminated union. Open navigation, operation, and reason-code strings are display
inputs; filter unknown values with `normalizeEnterpriseDisplayStrings` and never treat them as
authorization.

Enterprise events are `enterprise.identity.scope_refreshed`,
`enterprise.identity.credential_revoked`, `enterprise.resource.waiting`, and
`enterprise.resource.status`. Emit them only within the matching enterprise capability flow.

## Existing Workspace requests

The cwd-based request fields and upload correlation rules are owned by
[ADR 0012](decisions/0012-workspace-wire-context-and-entry-inventory.md). A missing `workspaceId`
keeps old single-user payloads parseable. It is not an enterprise fallback. Public Workspace
Service Proxy admission follows
[ADR 0010](decisions/0010-execution-actions-app-slot-and-service-proxy.md).
