# ADR-0025: Browser Profile runtime authorization lifecycle

Status: Accepted (contract; implementation pending)

## Context

Cases 8 and 9 cross four owners: an authenticated Session receives a Browser Profile lease from
W4, the W3 lifecycle owns the Session generation, and the Desktop preload/main process owns the
WebView registry and partition handles. ADR-0017 defines the authorization fields and canonical
paths, but does not specify the production handoff or exact-generation teardown. Without that
contract, a logout or Principal revoke can leave an old WebView, partition, or lease handle alive.

This contract adds no Session wire field and does not authorize a PAT, structural cast, or
client-supplied generation.

## ADR-0017 runtime authorization boundary

ADR-0017 remains authoritative. W3 combines the existing strict
`enterprise.browser.list_profiles`, `enterprise.browser.bind_profile`, and lease responses with
its local opaque `bindingRevision` and `lifecycleGeneration` to form exactly this six-field,
non-wire runtime authorization:

```ts
type BrowserProfileRuntimeAuthorization = {
  organizationId: string;
  homeNodeId: string;
  workspaceId: string;
  browserProfileId: string;
  bindingRevision: string;
  lifecycleGeneration: string;
};
```

`bindingRevision` and `lifecycleGeneration` are opaque W3 runtime values. Automation lease and
fencing remain the separate `BrowserProfileLeaseContext`; they are never added to this type.
`partitionKey`, `downloadRoot`, PATs, credential material, and WebView/Browser IDs are never in
runtime authorization or Session responses.

## Required handoff

The accepted production path is:

1. **Authenticated WS → W3 lifecycle** carries only the existing strict list/bind/lease response
   projections. W3 validates the current Session/receipt and combines the projections with its
   local `bindingRevision` and `lifecycleGeneration`; no client generation or structural object is
   trusted.
2. **W3 → Desktop preload port** exposes only
   `hydrateBrowserProfileAuthorizations(currentProjections, exactGeneration)` and
   `revokeBrowserProfileGeneration(exactOldGeneration)`. The bridge validates/clones the six-field
   authorization and binds it to the sending `WebContents`.
3. **Desktop preload → main registry** calls the existing
   `BrowserProfileRuntimeAuthorizationRegistry.hydrate/revoke` seam. Preload/main resolve
   canonical partition/download paths from trusted node configuration and receive no path, PAT, or
   arbitrary registry operation.
4. **WebView/automation gates** require an exact current authorization match on host WebContents,
   organization, node, Workspace, Profile, binding revision, and lifecycle generation. Automation
   additionally requires the separately supplied current `BrowserProfileLeaseContext`. A mismatch
   returns unavailable and performs no attach or IO.

## Exact teardown semantics

On `logout_all`, credential revoke, Session close, binding replacement, lease release/expiry, or
node drain, W3 first calls `revokeBrowserProfileGeneration` for the exact old generation. Revoke is
ordered before publishing the new generation and is idempotent. Desktop main must, for every
matching old authorization:

- remove the allowlist entry;
- reject new attach/popup/download/automation checks;
- close the associated Browser WebView and invalidate its partition/session handle;
- release the separate lease/fencing context through W4;
- drop any queued or in-flight operation whose generation is old.

Late responses, old Browser IDs, old handles, and old authorizations are rejected after teardown.
Only then does W3 publish the new generation. A new generation cannot reuse an old authorization
object. Teardown does not clear persistent Profile partition storage: the Profile is an
organization resource and case 9 requires the same Profile to survive restart. Access after login
B requires a new Session binding and current Grant. Storage is cleared only by explicit Profile
deletion or security cleanup. If any required close/release step fails, the authorization remains
revoked and the failure is surfaced; no reattach fallback is allowed.

## Minimal typed ports and ownership

- **W4**: Profile binding and the separate `BrowserProfileLeaseContext`/fencing authority.
- **W3**: authenticated WS association, local binding revision and Session generation source,
  `hydrateBrowserProfileAuthorizations`/`revokeBrowserProfileGeneration`, exact-generation revoke
  ordering, lifecycle error aggregation, and no-fallback routing.
- **Desktop preload/main**: validated bridge, host WebContents binding, allowlist hydrate/revoke,
  WebView/partition destruction, and attach-time exact-match checks.
- **W5**: Browser automation/file consumers must pass the server-held capability/lease context and
  reject stale generations; they do not mint or persist it.
- **W7**: real cross-process evidence for revoke, close, and failure durability; no secret or
  partition path is recorded in audit.
- **W6**: consumes only projected Profile state and lifecycle status; it never creates or stores a
  runtime authorization.

## Required E2E evidence

The decision is not complete without production-boundary tests covering:

- authenticated WS handoff of a W4-minted capability into W3 and Desktop preload/main;
- case 8: logout A/revoke followed by login B, proving old generation WebViews, partition handles,
  pending operations, caches, drafts, attachments, and tabs are all closed or rejected;
- case 9: two Profiles have isolated Cookie/LocalStorage, survive restart independently, and never
  cross-route Browser IDs;
- old-generation attach/popup/download/automation rejection after revoke, including late WS
  responses and lease-release failures.

Existing typed entry points to extend are
`packages/server/src/server/enterprise/browser/lease-manager.test.ts`,
`packages/server/src/server/enterprise/browser/production-bundle.test.ts`,
`packages/desktop/src/features/browser-profile.test.ts`,
`packages/desktop/src/features/browser-webviews/registry.test.ts`,
`packages/desktop/src/features/browser-webviews/index.test.ts`, and
`packages/app/src/runtime/enterprise-workbench-host.test.ts`. None alone is production E2E
evidence; the missing gate is the real authenticated WS/relay + Electron harness.

## Decision requested

Integration/root accepts this contract. Cases 8 and 9 remain unclosed until the required real
WS/relay + Electron harness exercises it; the Browser Profile capability must not be advertised as
complete before that evidence.
