# ADR-0053: What a machine RPC needs before a node can answer one

- Status: Accepted
- Date: 2026-09-17
- Raised by: Enterprise integration work on M6
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-17): option 1, a
  headless factory on the WebSocket server.

## Context

ADR-0035 routes a member's Session messages to the node over the plane, and the node answers them
"through the normal `handleMessage`, so authorization, canEmit and audit are identical to a direct
connection". The node half is built and green: `machine-rpc-server.ts` verifies the plane's
attestation, checks the method against the caller's role, deduplicates through `rpc_inbox`, and
writes the result to `rpc:res:<rpcId>` (7 tests). It reaches the daemon through one port:

```ts
export interface HeadlessSessionFactory {
  open(input: { principal: PrincipalContext; clientId: string; onMessage: ... }): HeadlessSession;
}
export interface HeadlessSession {
  handleMessage(message: SessionInboundMessage): Promise<void>;
  close(): void;
}
```

Nothing implements that port, and the three things it needs are all outside this workstream.

## What the code says

| What a headless Session needs | Where it is today                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Its collaborators             | `createSocketSession` (`websocket-server.ts:2113`) passes ~50 fields, most read off the server instance: `agentRequests`, `scheduleService`, `pluginRuntime`, `terminalManager`, `speech`, `voiceBridge`, `github`, `serviceProxy` and the rest. bootstrap holds none of them.                               |
| Admission                     | `SessionAdmission`'s enterprise arm wants `{ principal, node, runtime, grantVersionGuard }`, and the release path wants the authorization handle admission issued.                                                                                                                                           |
| Teardown                      | `Session.cleanup()` exists and is public, and is what every connection path awaits. What surrounds it does not: `releaseEnterpriseAuthorization(connection)` hands the admission handle back, and the `sessions` / `externalSessionsByKey` bookkeeping is keyed on the `ws` a headless caller does not have. |

Corrected after this was first written: an earlier draft of this table said `Session` has no
teardown at all. It has `cleanup()`. The part with no entry point is the admission handle around it,
not the Session — and `bindSession` takes authentication evidence, which a machine RPC caller does
not hold, so a headless Session runs without a handle and its close is `cleanup()` alone.

One thing is already true: `createSocketSession` takes no socket. `SocketSessionOptions` is
callbacks only, and `sockets` lives on the connection record rather than the Session. A Session
without a transport is constructible; what is missing is who constructs it and who takes it apart.

Ordering rules out the seam this milestone already added. `collaboration.install(...)` runs at
`bootstrap.ts:1574`, and the WebSocket server is constructed at `bootstrap.ts:2493` — the factory
does not exist yet when the replicas are installed, so machine RPC needs a second, later injection
whatever else is decided.

## The decision

Which of these:

1. **A headless factory on the WebSocket server.** It already owns every collaborator and the
   teardown sequence, so `openHeadlessSession({ principal, clientId, onMessage })` is a small method
   there and nowhere else. It adds public surface to `websocket-server.ts`, which the plan names as
   an upstream-churn and merge-conflict risk, and puts a machine-RPC-shaped hole in a file that is
   otherwise about sockets.

2. **Extract session construction first.** M1 planned `transport/session-host.ts` and it was never
   done. Moving session construction and teardown there gives both the socket path and the machine
   RPC path one owner. It is the larger change, and it moves code P0 evidence depends on.

3. **Defer machine RPC to the milestone that owns the daemon's session layer.** M6 ships the
   replicas, the projectors and the attestation; the node answers no RPCs until then, and ADR-0035
   says so until it does.

Option 1 was taken. It is the smallest change that works, and the WebSocket server is the only
holder of both the collaborators and the teardown sequence, so anywhere else would be a second copy
of one or the other.

What that obliges: the factory opens a Session with no transport and takes it apart the same way a
closed connection does, and the headless Session stays out of the map keyed by socket so that
`listSessions()` keeps meaning what it means today. If the transport extraction M1 planned is still
wanted, this method is what moves into it — one caller rather than a new seam to unpick.

## Acceptance

Whichever option is taken, the acceptance bar is ADR-0035's: a member's request arrives over the
plane, the node answers it through the same authorization, canEmit and audit path as a direct
connection, and the session it opened is released afterwards — proved by a test that asserts the
release, not only the reply.
