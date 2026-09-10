# ADR-0024: Enterprise resource-specific content-read contract

Status: Accepted

## Context

The enterprise protocol has metadata, authorization, lease, and file seams, but it does not
yet have a contract for reading protected resource content. The master specification requires
that Workspace/Agent content, Browser Profile state, and App Slot state are separately authorized
and audited. A generic `content.read` RPC or a legacy fallback would erase the resource kind,
permit an authority mismatch, and make the W2/W3 receipt checks non-exhaustive.

This ADR is the accepted P0 contract. It does not by itself advertise a feature; each optional
capability remains absent until its complete family is production-ready.

## Proposed minimum P0 contract

Add exactly four resource-specific request/response pairs; do not add a generic content RPC and do
not route these operations through a legacy single-user fallback:

```ts
enterprise.workspace.content.read.request / response;
enterprise.agent.content.read.request / response;
enterprise.browser_profile.content.read.request / response;
enterprise.app_slot.content.read.request / response;
```

Each pair is a separately tagged, W0-owned strict schema. The request contains only user intent:

```ts
type ContentReadRequestBase = {
  requestId: string;
  resource: GlobalResourceRef;
  selector: ResourceSpecificContentSelector;
  page: { cursor?: string; limit: number };
};
```

`resource` is the `(organizationId, nodeId, resourceKind, localResourceId)` reference. The server
must resolve the current reference and compare every field; a client-supplied reference is not
authority and cannot choose a node or organization. `selector` is closed and resource-specific,
with its exact wire shape defined and versioned by W0 (never delegated to an adapter):

- `workspace`: `{ kind: "workspace", view: "timeline" | "files" }`;
- `agent`: `{ kind: "agent", view: "transcript" | "artifacts" }`;
- `browser_profile`: `{ kind: "browser_profile", view: "state" | "artifacts" }`;
- `app_slot`: `{ kind: "app_slot", view: "state" | "artifacts" }`.

W0 likewise owns one strict canonical item projection per family; adapters implement those shapes
but may not add wire fields. Each selector rejects fields from the other three families.
`page.cursor` is opaque, is scoped to the exact Principal, resource, selector, and
Session, and `page.limit` is bounded by the server. No batch, arbitrary path, or unbounded page is
part of P0.

Every response is the matching dotted response type and has one canonical envelope:

```ts
type ContentReadResponseBase<Item, Selector> = {
  requestId: string;
  resource: GlobalResourceRef;
  selector: Selector;
  page: { items: readonly Item[]; nextCursor: string | null };
};
```

`Item` is a strict, family-owned canonical projection; it is not a JSON passthrough and never
contains bearer tokens, credentials, cookies, prompts, or audit internals. The response resource
must be the server-resolved reference, and an empty page is valid only after authorization of the
current resource. No response may contain a resource from another family.

## Authorization and failure semantics

W3 consumes the inbound request and its server-minted `authorized_request` receipt/context. The
receipt binds the exact Principal, organization, credential, Grant version, node, Session/client,
generation, request type, request ID, and resource reference. Clients never submit or modify that
context. The receipt is single-use and expires when the request ends.

W2 re-resolves the current resource and owner, checks the current Grant version and the existing
family action: `workspace.content.read` for Workspace and Agent (Agent first resolves its owning
Workspace), `browser.use` for Browser Profile, and `app.use` for App Slot. It rejects stale,
foreign, missing, or mismatched references.
W2 performs the final `canEmit`/receipt guard before the domain adapter reads anything.

W7 receives a required-durability audit append for every authorized content read, before the
response is emitted. The audit input contains Actor, exact resource reference, family action,
selector summary, reason/ticket when required by policy, and outcome; it never contains content or
secrets. If the required audit append fails, the read fails closed and no content is returned.

Foreign and missing resources use the same redacted denial shape and timing. A missing Grant,
stale receipt, owner mismatch, disabled Principal, or invalid selector has zero domain reads,
zero content cache writes, zero lease changes, and zero audit append side effects. No generic
legacy response is allowed.

## Owner split and P0 boundary

- **W0**: add the four strict protocol pairs, canonical envelope, selector/item schemas, exhaustive
  request/response inventory, client wrappers, purity tests, and compatibility tests. W0 does not
  implement domain reads.
- **W2**: own `PlacementResolver`, `OrganizationResourceSource`, current owner/resource
  resolution, Grant/action checks, receipt revalidation, and uniform denial semantics.
- **W3**: own Session dispatcher registration, request/response pairing, receipt/context
  consumption, generation binding, and no-fallback routing.
- **W4**: own Browser Profile selector/item adapter and its profile/binding/lease authority.
- **W5**: own Workspace, Agent, and App Slot content adapters and local runtime/file reads.
- **W7**: own required-durability audit append and adversarial evidence; no content is copied into
  audit records.
- **W6**: consume only after the corresponding server handler, lifecycle, and feature gate are
  complete; no UI fallback is part of P0.

The optional capabilities are:

- `enterpriseWorkspaceContentReadV1`
- `enterpriseAgentContentReadV1`
- `enterpriseBrowserProfileContentReadV1`
- `enterpriseAppSlotContentReadV1`

Each capability is `true` only when that family's strict schema, production handler, receipt/current
checks, required audit, and foreign/missing/no-Grant denial evidence are all ready. Otherwise the
field is absent from `server_info` and normalizes to unavailable; there is no fallback flag.

P0 is limited to one bounded page per family, current-resource authorization, receipt/context
consumption, required audit, and real foreign/missing/no-Grant denial evidence. Streaming,
multi-resource batch reads, writes, export/download packaging, search, and legacy compatibility
remain out of scope until a separate decision.

Integration/root accepts this four-family contract and owner split. W0 may now add the strict wire
schemas and client wrappers; production handlers and capability advertisement remain owned by the
corresponding integration/domain workstreams.
