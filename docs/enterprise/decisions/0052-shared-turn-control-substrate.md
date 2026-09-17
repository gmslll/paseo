# ADR-0052: What shared turn control needs before it can be built

- Status: Accepted
- Date: 2026-09-17
- Raised by: Enterprise integration work on M6
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-17): option 1, thread
  the author through the agent core now and implement ADR-0034 as written.

## Context

ADR-0034 is Accepted and says the author of a turn's user message controls that turn: a different
editor who sends while a turn runs is queued, only the Workspace owner may interrupt another
Principal's turn, permission requests are answered by the turn controller or the owner, and every
user message carries `author` with the authenticated Principal ID.

Implementing the daemon half of it turned up three things the decision assumes and the code does not
have. Each was checked in the source rather than inferred:

| What ADR-0034 needs                              | What exists today                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `author` on a user message                       | `AgentTimelineItemPayloadSchema` has `author` (protocol). The daemon's own `AgentTimelineItem` (`agent/agent-sdk-types.ts`) does not. |
| The author stamped when the message is committed | Nothing in `packages/server/src/server/agent` ever writes `author`.                                                                   |
| `queuedTurns` on the Agent snapshot              | The protocol field exists. Nothing in the daemon, client or app populates or reads it.                                                |

The turn's controller is therefore not knowable at runtime. `ManagedAgent` tracks `activeTurnId` and
`activeTurnStartedAt` and nothing else about who opened the turn, and `openActiveTurn` has no
Principal in scope. The timeline row carries `turnId`, so the controller could be resolved by
finding that turn's user message — except that no user message has ever been written with an author,
so the lookup would always come back empty.

## What is implementable without a decision

The part that depends only on the caller: resolving the effective behaviour from the authenticated
role rather than from the client's `sharedTurnPolicy` value. An owner may interrupt; anyone else
queues. `SharedTurnPolicySchema` and the optional `sharedTurnPolicy` field on both send requests are
already in the protocol, and `handleSendAgentMessageRequest` already has the enterprise principal in
scope.

What it cannot do is tell one Principal's turn from another's. Without the controller, "only the
owner may interrupt **another Principal's** turn" collapses to "only the owner may interrupt", which
also refuses an editor interrupting their own turn — a behaviour change for the single-user case,
not just a missing collaboration feature.

## The decision

Which of these:

1. **Thread the author through the agent core now.** Add `author` to the daemon's `AgentTimelineItem`,
   stamp it where the user message is committed, populate `queuedTurns`, and implement ADR-0034 as
   written. The change lands in `agent/agent-sdk-types.ts`, `agent/agent-manager.ts` and the agent
   projections — the files the plan calls out as upstream-churn and merge-conflict risks, and outside
   the enterprise workstream this work has stayed inside.

2. **Ship the role-only half now and defer the rest.** Land the policy that resolves behaviour from
   the role, treat an unknown controller conservatively (queue, never interrupt), and leave
   ADR-0034's author, queue and controller rules to the milestone that owns the agent core. ADR-0034
   would be amended to say which of its rules are in force.

3. **Defer the whole thing.** M6 finishes without shared turn control, and ADR-0034 moves to a later
   milestone in one piece.

Option 2 is the one this work would take by default, because it is the largest piece that stays
inside the boundary. It is recorded here rather than taken, because the choice changes what
ADR-0034 means today and the master spec's §15.1 actor semantics depend on the author rule.

## Still open: the cross-author cancel audit

ADR-0034 says cancelling another Principal's turn writes a `required` audit event. ADR-0037 owns
audit durability and its `required` list is closed — content-Grant reads by a non-member, dispatching
a turn through machine RPC, membership invite/accept/role change/removal, and collaboration
enable/disable — with everything else `buffered`. A cross-author cancel is on neither list, so the
two decisions disagree about what `required` covers.

It is also not reachable yet: the daemon's Session holds no audit capability. The audit runtime is
built in the managed runtime factory and never handed to Session, so writing an event from the
cancel handler means plumbing it in, which is agent-core surface rather than this workstream's.

Raised rather than resolved, because picking a durability level here would silently overrule
whichever ADR is not chosen. The permission-response rule from ADR-0034 is implemented; the cancel
audit is not, and ADR-0034 should say so until this is settled.

## Where the resolver lives

The plan puts the shared turn policy in `packages/server/src/server/enterprise/access/shared-turn-policy.ts`,
which assumed the decision would be taken in the Session. It is taken in `AgentManager`, because the
manager is what holds the running turn and what machine RPC and the Agent tools reach too, not only
a client Session.

`packages/server/src/server/agent/agent-manager.ts` imports nothing from `enterprise/` or
`authorization/`: the agent core is deliberately free of that layering, and the plan calls those
files out as upstream-churn and merge-conflict risks. Having the core reach into the enterprise
workstream to ask a policy question would invert that.

So `resolveSharedTurnDisposition` sits in `packages/protocol/src/enterprise-collaboration.ts`,
beside `roleAllowsMachineRpcMethod`, which is the same shape of decision for the same reason: a pure
function over contract types that both sides already depend on.

The distinction it needs is the sender against the turn's controller and the Workspace owner, not
the member's role. Whether a viewer may send at all is a `workspace.write` question, answered before
this one and elsewhere.

## The feature declaration follows the stack, not the config key

This was written while the collaboration stack was built but unwired, and said the flag stays
undeclared until the wiring lands. The wiring landed, so `enterpriseCollaborationV1` is now
declared — from the seam the enterprise runtime actually built, not from the `collaboration.enabled`
key that asks for it.

The difference matters. The runtime holds that seam only when collaboration is enabled on a managed
node and the replicas were constructed; the config key can be true while the factory refused. A
feature flag is a promise that the capability is there, so it follows the thing that serves it.

`enterpriseDistributedNodeV1` is still undeclared. Nothing in this milestone made it true.

## Still open: nothing watches the node's scheduled work

`ManagedNodeLifecycle` catches every scheduled operation and hands the error to an optional
`onError`. No construction site passes one — not the managed runtime factory, not anywhere else —
so a failed heartbeat, policy refresh, audit upload or placement sync is already swallowed in
production today. The collaboration pump joins them on the same terms.

Fixing it means giving the factory somewhere to report, and the factory has no logger. The seam it
arrives through, `createEnterpriseAdmissionRuntime` in `bootstrap.ts`, takes `{ config, audit }`;
widening it reaches `resolveEnterpriseRuntime`, `daemon-worker.ts`, the direct-daemon test helper
and five test files that override the factory.

Left as one deliberate change covering all five operations rather than threaded through here for
the newest one, which would leave the four older ones silent and the seam widened anyway.

## Machine RPC does not get its own entry surface

The plan registers the machine RPC method allowlist as a new `machine_rpc` entry in
`entry-inventory.ts`. It is not registered that way, because there is nothing new to register.

Every method in `MACHINE_RPC_METHODS` names an entry that is already a reviewed inbound entry —
`send_agent_message_request`, `agent_permission_response`, `fs.file.write.request` and the rest are
in `REVIEWED_INBOUND_ENTRIES` today. An attested request reaches them through a real Session
(ADR-0035), so the transport is `session_json` and the authorization, canEmit and audit are the ones
those entries already carry.

`EnterpriseEntrySurface` is a closed union and every item owes twelve fields. A `machine_rpc`
surface would restate eight reviewed rows under a second heading, kept in step with
`MACHINE_RPC_METHODS` by hand — a second source of truth for the same entries, and one that a
future method could drift from silently.

What is worth holding is the property the plan was reaching for: a machine RPC method may not name
an entry the daemon does not accept. That is a cross-check between two tables rather than a third
table, and it already exists — `access/machine-rpc-method-actions.test.ts` pins every
workspace-scoped method to `inboundActionsForRequestType`, which is stronger than checking a review
list: it fails when the entry is unknown, when the restated actions drift from the entry's own, and
when a method resolves to an empty action list that every role would pass vacuously.

So nothing is owed here. The surface is not added, and the property is held.

## Acceptance

Whichever option is taken, the tests ADR-0034 names stay the acceptance bar for the rules that are
in force, and the rules that are not must say so in ADR-0034 rather than silently fail closed.
