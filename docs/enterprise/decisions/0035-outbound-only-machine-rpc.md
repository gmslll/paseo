# ADR-0035: Outbound-only machine RPC

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A collaborator can operate an Agent on a node without connecting to that node. The client appends a
`MachineRpcEnvelope` request to `rpc:req:<nodeId>`. The plane checks membership and the per-method
role, then attaches a plane-signed attestation. The node reads the stream over its outbound
connection and answers on `rpc:res:<rpcId>`.

The attestation is an Ed25519 signature by the existing plane ticket key over:
`rpcId`, `method`, `nodeId`, `containerId`, requester `principalId`, `credentialId`, `grantVersion`,
`clientId`, `sentAt`, and `expiresAt`.

It travels as `pmr_v1.<base64url claims>.<base64url signature>` — the same three-part token the
Session ticket and the stream token use — rather than as a claims object beside a signature. The
node must verify over exactly the bytes the plane signed, and re-serializing a parsed object to
recover them would make the signature depend on key order and number formatting. Its domain
separator, `paseo-machine-rpc-v1`, differs from the other two because all three are signed with the
plane's one ticket key: without distinct separators a stream token would verify as an attestation.
Added 2026-09-17 by the integration owner.

The node:

1. verifies the signature and expiry (default 60 seconds);
2. rejects a Grant version older than its current policy;
3. deduplicates by `rpcId` in its local inbox;
4. dispatches the payload through a headless enterprise Session for that Principal and client, so
   authorization, outbound filtering, and audit match a direct connection.

The inbox of step 3 is the `rpc_inbox` table of the node replica (ADR-0032), keyed by `rpc_id` and
carrying the method, the arrival time, and an expiry it is swept by. It is on disk rather than in
memory so that a crash does not reopen the replay window, and the expiry stored is the attestation's
rather than a local default, so a replay can never outlive the window the plane signed. Added
2026-09-17 by the integration owner.

The accepted methods, and the role each one answers to, are `MACHINE_RPC_METHODS` in the protocol
(added 2026-09-17 by the integration owner; this decision named the list in prose and never wrote
it down). Both sides read the same table: the plane before it attests, the node before it
dispatches.

A workspace-scoped method names the Session inbound request it becomes, and its role is whatever
that entry's enterprise actions already imply — `create_agent_request` and
`send_agent_message_request` carry `workspace.write`, so an editor may drive an Agent, while
`file_explorer_request` and `checkout_status_request` carry `workspace.read`, so a viewer may look.
Deriving it this way means collaboration cannot widen what a role may do: the answer is the one a
direct connection already gives.

The actions are restated in the table rather than resolved from the daemon's entry mapping, because
the plane cannot reach it: `packages/enterprise-management` depends on the protocol package and not
on the daemon, while `inboundActionsForRequestType` lives in the daemon. This decision has the plane
check the method before it attests, so the plane needs the answer in a package it can import. A
daemon-side test pins every row of the table to that mapping, so the restatement cannot drift into a
second answer — which is the only thing that makes duplicating it safe.

Two corrections fell out of writing it down. Steering is not a method — it is the
`activeTurnBehavior` of a send, so a table listing `agent.steer` would name something that does not
exist. And the machine-scoped methods cannot be derived at all: `restart_server_request` carries the
daemon's `daemon.manage` permission, which maps to no enterprise action, so the derivation returns
an empty action list — and an empty list is satisfied by every role, viewer included. Deriving them
would fail open on the one case this decision most wanted closed, so `machine.restart` and
`machine.upgrade` are answered explicitly as owner-only, and `machine.get_status` as member.
`machine.restart` and `machine.upgrade` still require a receipt within 5 seconds.

Clients obtain a plane session with `POST /v1/auth/password/plane-session` and a 5-minute stream
token with `POST /v1/streams/token`. Direct node connection stays available and is no longer
required for collaborators.

## Amends

- Master spec §5.1.4: direct node connection becomes optional for collaborative Workspaces.
- Master spec §16 node channel paragraph.
- ADR-0030 "Password login is available only for direct node connections".

## Acceptance

Tests cover forged, expired, replayed, and stale-Grant attestations; methods outside the allowlist;
parity between machine RPC and direct Session denials; and restart receipt timing. Inbox tests prove
the replay refusal survives a restart and that a sweep removes only entries past their signed
expiry.
