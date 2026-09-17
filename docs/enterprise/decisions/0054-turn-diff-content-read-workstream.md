# ADR-0054: Who implements the ADR-0045 Agent `turn_diff` content-read view

- Status: DECISION_REQUIRED
- Date: 2026-09-17
- Raised by: Enterprise W9 work on M7
- Decision owner: Enterprise integration owner

## Context

ADR-0045 is Accepted. It adds Agent view `turn_diff` to the ADR-0024 content-read family: a
Principal without membership or ownership reads it only with `workspace.content.read`, and that read
appends a `required` audit event `code_collab.turn_diff.viewed` before content is returned. Owner
and member reads of the view are not audited. Acceptance names owner reads without audit, Boss
reads with a Grant and audit, Boss denial without a Grant, and denial when the audit append fails.

W9 just shipped the member RPCs (`code_collab.turn_diff.get_files` and the two siblings) and the
capture stack. The next planned slice is this Boss view. Before touching it, the W9 exclusive list
and the hot-file opening were checked against the files the view actually lives in.

## What the code says

| What ADR-0045 needs                         | Where it is today                                                                                                                            | Owner                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Agent selector `view: "turn_diff"`          | `EnterpriseAgentContentSelectorSchema` is `transcript` \| `artifacts` (`messages.ts`)                                                        | W0; W9 may edit `messages.ts` only as an ADR-named call site                     |
| Domain read of one turn's files             | `AgentContentSource.read` switches on `transcript` and otherwise returns an empty page (`enterprise/runtime/enterprise-content-read.ts:450`) | W5 exclusive: `packages/server/src/server/enterprise/runtime/**`                 |
| Authorize, `canEmit`, then audit, then emit | `createEnterpriseContentReadDispatcherRegistration` (`enterprise/access/enterprise-content-read-dispatcher.ts:239`)                          | W2 exclusive: `packages/server/src/server/enterprise/access/**`                  |
| `required` append                           | same dispatcher, `currentAudit.append(..., { durability: "required" })` with `action: "workspace.content.read"`                              | W7 owns the Sink under `enterprise/audit/**`; the call site is the W2 dispatcher |
| Item projection                             | Agent items are `message` (text) or `artifact` (reference, label, optional mime/size). No hunks.                                             | W0 schema; W5 adapter fills it                                                   |

W9 exclusive paths are `code-collab/**`, `tasks/**`, protocol collaboration/local-planes/managed-runtimes, and `docs/enterprise/decisions/` 0031–0049. They do not include `enterprise/runtime/**`, `enterprise/access/**`, or `enterprise/audit/**`.

The W9 hot-file opening names `websocket-server.ts`, `session.ts`, `bootstrap.ts`, `messages.ts`.
The three RPCs used that opening. ADR-0045 names the view and the audit event; it does not name
those four files' call sites, and it does not name the content-read adapter or dispatcher.

Reading "等热点文件" as covering W5/W2 exclusive modules would let this workstream edit files the
master spec already assigned. That is the interpretation this ADR is not allowed to take.

## What ADR-0045 also changes besides the view name

The existing dispatcher audits every authorized Agent content read, including the owner. That
matches ADR-0024 ("every authorized content read"). ADR-0045 says owner and member reads of
`turn_diff` are not audited. Wiring the new view through the current dispatcher without changing
that policy would fail the ADR-0045 owner-read acceptance test; changing it is a W2 dispatcher
edit.

ADR-0045 amends ADR-0024's view vocabulary only. Returning `ParsedDiffFile[]` hunks as content-read
items would also amend the item projection, which ADR-0024 keeps metadata-only for `artifact`.

The member RPC `code_collab.turn_diff.get_files` already requires `workspace.content.read` in
enterprise (derived from `workspace.read`). It does not write `code_collab.turn_diff.viewed`, and it
does not skip owner/member audit, because it has no audit call. Boss-with-Grant can already fetch
hunks that way. That is not the ADR-0045 view.

ADR-0037's `required` list already includes a non-member content-Grant read. `code_collab.turn_diff.viewed`
is a new action string on `AuditEventInput.action` (`z.string()`), not a new Enterprise Action
(ADR-0008 freeze). Durability is not the conflict here. File ownership is.

Task views `body` and `review` from the same ADR have the same shape: W9 owns `tasks/**`, W5 owns
the content-read adapter.

## Options

1. **Treat the adapter and dispatcher as ADR-0045 call sites, and let W9 edit them.** Same
   reasoning used for `messages.ts` on the three RPCs. Write that into the W9 paragraph so the next
   slice does not re-litigate it.

2. **Keep the files with W5/W2.** W9 exposes a port on the turn-diff runtime (workspaceId, turnId →
   page of Agent content items). W5 implements the `turn_diff` branch; W2 adds the owner/member
   audit skip and the `code_collab.turn_diff.viewed` action. W9 does not edit those directories.

3. **Defer the content-read view.** Members keep the three RPCs. Boss-with-Grant on `get_files`
   stays unaudited until a later slice owns the ADR-0045 acceptance tests.

## What this workstream will not do until you pick

- Widen `EnterpriseAgentContentSelectorSchema`.
- Add a `turn_diff` branch to `enterprise-content-read.ts`.
- Change the content-read dispatcher's audit policy.
- Advertise a view nothing serves.
