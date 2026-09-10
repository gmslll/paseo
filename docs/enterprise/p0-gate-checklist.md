# Enterprise P0 security gate evidence

This checklist mirrors `ENTERPRISE_IMPLEMENTATION_MASTER.md` section 22.1. It records discoverable
evidence and release gaps. `EVIDENCE` means only that an accepted evidence-shaped test exists; it
does not mean the end-to-end case passes. `MISSING_CALL_SITE` means the production boundary is not
yet proven to invoke the tested policy. `RED` is a known release blocker or missing mandatory real
run. Do not replace these labels with `PASS` without attaching raw release-run evidence.

Current blocking-state count, with every case counted once: `EVIDENCE` 18 (cases 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
12, 14, 15, 16, 17, 18, and 19), `MISSING_CALL_SITE` 1, and `RED` 1 (case 20), leaving 2 cases not fully closed. Case
10 is now closed by the production run below. Static or unit-level evidence for the remaining
missing cases is not counted as a second case.
The `8dee12c94` cold-home provisioning/authentication run does not change
this gate count: it proves startup and authority restoration, not the missing RPC-family call sites
or audit-flow/package evidence. The W7 audit storage candidate has real Darwin dirfd-relative race coverage
in `darwin-audit-file-system.test.ts`; packaged-runtime build, tracing, and desktop-unpack evidence
remain separate release gates.

## Production wiring snapshot

- W3's `DaemonClient.enterpriseFileDownload` seam carries `serverId`, `workspaceId`,
  `relativePath`, optional cancellation, and optional scope generation to a host-supplied request
  function. The seam has no bearer or token field. The real `createPaseoDaemon` + public HTTP
  evidence for cases 6 and 7 remains `EVIDENCE`; the client seam alone does not prove every
  Host/App consumer or packaged runtime is wired.
- The production enterprise runtime factory now supplies the current provider/store, durable
  principal source, Admission, grant/credential setup, and W3 receipt/audit wiring. The real Darwin
  workspace/agent content run at `3598dd23c` is production call-site evidence for cases 16 and 17:
  authorized workspace timeline and live Agent transcript reads succeed, foreign metadata-only
  listing is redacted, and denied content reads create no allowed audit event.
- Feature computation continues to omit unavailable enterprise flags rather than advertising them as
  `false`; browser Profile and App Slot content families still require their own production handler
  evidence. A static handler or bootstrap assembly test must not be recorded as a production call site.
- The real Darwin Browser lease lifecycle run at `6abb1f911` closes and reopens the production bundle
  against the same persisted home, rejects the pre-restart lease without invoking authorization,
  and proves monotonic fencing before allowing a new lease.
- The production secret-canary chain now covers direct WebSocket (`e8de02d5c`), relay
  (`5c232e848`), and client cache/process lifecycle (`6af714dc9`): PAT/fingerprint absence is
  verified across protocol/Admission, snapshots, logs, audit, credential persistence, AsyncStorage,
  localStorage, console, and real HTTP fetch, with wrong/revoked/logout-old-generation network
  rejection. This closes case 15 without extrapolation.
- The real production case-18 run at `97705f923` proves manage-only C can list/bind, A can perform
  `browser.use` content reads, and C's real or guessed Profile receives the same redacted denial;
  capability state and required audit evidence are included.
- The production HostRuntime residue run at `0690348d8` clears four Zustand residue families before
  network/browser teardown, isolates B from late A events, and verifies the enterprise file seam is
  generation-bound; this closes case 8.
- The real Darwin `createPaseoDaemon` two-Principal cross-flow at `f1a101ae5` is the production WebSocket
  call-site evidence for cases 1, 2, 4, and 5: directory/list and metadata reads, workspace write/archive
  denials, timeline tail/before/after and gap recovery, Agent search, provider recents, child-Agent
  list/timeline, and tombstone delivery are exercised with foreign/guessed resources redacted or denied
  without unauthorized source effects.
- Case 3 is closed by the integrated transfer chain: W2 handler/CAS/audit and stores (`7c13b1906`),
  W3 local seal and multi-Session tombstone fanout (`74603994c`, `f027ac25f`), client app-memory/
  SQLite/timeline/provider eviction (`1543d4ce1`), and W7 production transfer/restart old-A denial /
  new-B authorization plus multi-Session tombstone delivery (`c92031b7c`, `99b527a43`, `885b00873`).
- W4 production Browser handle bind/cleanup (`26a175f99`), W3 Session waiting routing (`73ebdde08`),
  and the real Darwin production WS run at `5686ecc8e` close case 10: concurrent A/D writers on one
  Profile produce A as holder and D in its original Session's exclusive FIFO waiting position 1,
  with A/C at zero; after A release, D acquires and releases, and listener-before-release ordering
  proves no race.

| Case | Required behavior                                                                                                 | Current state       | Existing evidence or missing boundary                                                                                                                                                                                                                                                                                                                                                              |
| ---: | ----------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    1 | Employee A cannot list, read, update, or archive employee B's Workspace or Agent.                                 | `EVIDENCE` (closed) | Real Darwin `createPaseoDaemon` two-Principal WebSocket flow at `f1a101ae5` proves A sees only its Workspace/Agent directory rows; foreign fetch, update, archive, workspace title/pin/archive, and content requests are denied with persisted state unchanged.                                                                                                                                    |
|    2 | Guessed foreign `workspaceId`, `agentId`, and `browserId` receive one non-enumerating denial.                     | `EVIDENCE` (closed) | The same production flow compares foreign and guessed Agent/Workspace denials, exercises foreign Profile/resource requests, and verifies redacted responses without foreign identifiers, secret markers, or unauthorized source effects.                                                                                                                                                           |
|    3 | After A transfers a subscribed resource to B, A receives no later event.                                          | `EVIDENCE` (closed) | W2 handler/CAS/audit and stores (`7c13b1906`), W3 local seal and multi-Session tombstone fanout (`74603994c`, `f027ac25f`), client app-memory/SQLite/timeline/provider eviction (`1543d4ce1`), and W7 production transfer/restart old-A denial/new-B allow plus multi-Session tombstone delivery (`c92031b7c`, `99b527a43`, `885b00873`) prove atomic revocation and no late events.               |
|    4 | Timeline tail/before/after/gap recovery never exposes B's messages to A.                                          | `EVIDENCE` (closed) | The production flow at `f1a101ae5` denies A's foreign Agent timeline tail/before/after-gap, prompt, and subscription requests and observes no later foreign event after a denied subscription.                                                                                                                                                                                                     |
|    5 | Search, provider recents, child Agents, and Tombstones reveal nothing about B.                                    | `EVIDENCE` (closed) | The same production flow returns no foreign Agent search or provider-recents results, denies repository search and child-Agent list/timeline requests, preserves the provider source call count, and emits no foreign tombstone after archive.                                                                                                                                                     |
|    6 | Download tokens are Principal/Workspace-bound, expire, and are single-use.                                        | `EVIDENCE`          | W7's real Darwin `createPaseoDaemon` + public `/api/files/download` fetch proves Principal/Workspace binding, one-use, replay/closed rejection, wrong-PAT denial, and zero-read failures; policy tests cover expiry and concurrent consume. W3's host-supplied client seam carries Workspace/path context without a bearer field, but does not by itself prove every consumer or packaged runtime. |
|    7 | `..`, symlinks, and missing descendants cannot escape Workspace Root.                                             | `EVIDENCE`          | W7's real Darwin ownership cross-flow and W5 safe-FS tests cover dirfd-relative traversal, symlink/missing-descendant denial, and the public Session/HTTP path. Packaged-runtime evidence remains a separate release gate.                                                                                                                                                                         |
|    8 | Logout A then login B on one client exposes no A cache, drafts, attachments, or tabs.                             | `EVIDENCE` (closed) | Production HostRuntime lifecycle at `0690348d8` clears layout/tab, draft, pending-submission, and attachment Zustand stores before network/browser teardown, rejects late A file events by generation, then hydrates B without A residue.                                                                                                                                                          |
|    9 | Two Browser Profiles isolate Cookie/LocalStorage and persist independently across restart.                        | `EVIDENCE` (closed) | Real Electron production preload/IPC evidence covers three same-origin Profiles with independent cookie/LocalStorage, dual-process restart, per-Profile partition/registry identity, and exact-generation revoke destroying the old guest.                                                                                                                                                         |
|   10 | Concurrent writers for one Profile yield one lease and visible waiting in the original Session.                   | `EVIDENCE` (closed) | W4 bind/cleanup at `26a175f99`, W3 waiting routing at `73ebdde08`, and real Darwin production WS at `5686ecc8e` prove A/D contention: A holds, D waits in original Session position 1 with A/C at zero, then FIFO acquire/release after A releases; listener-before-release shows no race.                                                                                                         |
|   11 | Different Profiles run concurrently without Browser ID misrouting.                                                | `EVIDENCE` (closed) | The same real Electron production run attaches three Profile guests in one process, verifies registry BrowserId/ProfileAuthorization matching and main-process partition selection by profileId, then re-verifies isolation after a second-process restart.                                                                                                                                        |
|   12 | Browser Host/daemon restart does not revive an old lease.                                                         | `EVIDENCE` (closed) | Real Darwin production lifecycle at `6abb1f911` closes the first bundle/runtime, reopens the same persisted home, rejects the old lease without an authorization resolution or audit side effect, then accepts a new lease with monotonic fencing token/revision.                                                                                                                                  |
|   13 | A page-account/Profile mismatch stops high-risk actions.                                                          | `MISSING_CALL_SITE` | Browser binding/profile contracts exist; no production risk-check call site plus real page-account test is recorded.                                                                                                                                                                                                                                                                               |
|   14 | Employees cannot read daemon config, Grants, plugin/provider credentials, or global Terminal.                     | `EVIDENCE` (closed) | Real default Darwin WS identity success followed by per-surface `access_denied` for daemon config/status, plugin/provider, `list_grants`, and global `list_terminals`; each response omits `paseoHome`.                                                                                                                                                                                            |
|   15 | Company Codex/Claude tokens never enter protocol, snapshots, logs, audit, or client cache.                        | `EVIDENCE` (closed) | Direct WebSocket (`e8de02d5c`), relay (`5c232e848`), and client cache/process lifecycle (`6af714dc9`) production evidence verifies PAT/fingerprint absence across protocol/Admission, snapshots, logs, audit inputs/events, credential persistence, AsyncStorage, localStorage, console, and real HTTP fetch; wrong/revoked/logout-old-generation network attempts are rejected.                   |
|   16 | Boss sees employee metadata but cannot read content without a content Grant.                                      | `EVIDENCE` (closed) | Real Darwin two-Principal workspace/agent content flow at `3598dd23c`: B's metadata-only resources are redacted, B's workspace/agent body reads are denied with no allowed audit, and the foreign Principal remains non-enumerating.                                                                                                                                                               |
|   17 | Boss with a content Grant reads content and creates an audit event.                                               | `EVIDENCE` (closed) | The same production flow authorizes A's workspace timeline and live Agent transcript reads, with two `workspace.content.read` required audit events persisted; the integrated local audit/content evidence is recorded at `3598dd23c`.                                                                                                                                                             |
|   18 | Platform admin manages bindings but cannot read content by default.                                               | `EVIDENCE` (closed) | Real production run `97705f923`: manage-only C lists/binds successfully, A performs `browser.use` content reads, and C's real or guessed Profile receives the same redacted denial; capability state and required audit evidence are recorded.                                                                                                                                                     |
|   19 | Every break-glass Owner use creates a high-priority audit event.                                                  | `EVIDENCE` (closed) | Optional protocol priority, W1 required high-priority break-glass append, W7 redaction/retention, and real Darwin provisioning persistence/secret-token canary are covered by the integrated 46/46 local-audit and provisioning evidence chain at `6fda7b8f3`.                                                                                                                                     |
|   20 | Ten simulated employees chat concurrently for 30 minutes without cross-Principal data or unbounded daemon memory. | `RED`               | Three-Profile Electron capacity subtest is `EVIDENCE`; ADR 0009 still requires the 30-minute real-WebSocket daemon-core run and a 30-minute representative real Codex/Claude run, and neither raw artifact is recorded.                                                                                                                                                                            |

## W7 audit-storage production gate

- `EVIDENCE`: portable sink/storage fault matrix, canonicalization, restart poison, queue/close,
  required durability, and observer transitions in `local-audit-sink.test.ts`.
- `EVIDENCE`: Darwin universal Mach-O N-API build plus real rename/symlink replacement tests in
  `darwin-audit-file-system.test.ts`; all child open/read/write/truncate/rename/unlink/enumeration and
  parent fsync operations remain anchored to the validated directory descriptor.
- `RED`: daemon tracing, npm package inspection, Electron ASAR unpack, macOS CI, and packaged-runtime
  binding-load evidence are not yet connected to a release artifact.
- `EVIDENCE`: enterprise bootstrap and the public download path fail closed when the production
  provider is unavailable or not release-ready; packaged Darwin audit/provider loading still needs
  a release-run artifact.
- `EVIDENCE` + `MISSING_CALL_SITE`: bootstrap assembles the audit-list dispatcher from a current
  injected audit capability, while feature computation omits incomplete families. ADR-0023's
  production admission factory and `daemon-worker.ts` injection are still absent, so this static
  assembly is not a production enterprise call site.
