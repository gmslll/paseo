# ADR-0032: Durable-Streams-compatible transport and document authority

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The plane exposes append-only streams over its existing HTTPS listener. Each stream belongs to one
container and one segment and carries Loro updates or JSON log entries.

- Containers: a collaborative Workspace `cws_<16 hex>` or a task board `brd_<16 hex>`.
- Single stream: `PUT|POST|GET|HEAD /v1/ds/<containerId>/<segment>`. Reads accept `offset` and
  `live=long-poll|sse` and return `Stream-Next-Offset`.
- Producer fencing uses `Producer-Id`, `Producer-Epoch`, and `Producer-Seq`: a stale epoch returns
  403, a duplicate sequence returns 204, and a sequence gap returns 409.
- Multiplexed subscribe: `POST /v1/ds/subscriptions` followed by `GET /v1/ds/subscriptions/<id>`
  with `live=sse` emits `data`, `control`, `presence`, and `revoked` events. Browsers need this
  because of the per-origin connection limit.
- Presence: `POST /v1/ds/<containerId>/presence` takes one client's heartbeat, and the plane sends
  that container's subscribers a `presence` event carrying the whole roster. The caller supplies
  only its client id and current focus; the principal comes from the credential and the timestamp
  from the plane, so a member can neither forge another's presence nor hold an entry past its TTL.
  Heartbeats are every 30 seconds and an entry expires after 90. Presence is never an authorization
  input. Added 2026-09-16 by the integration owner.
- Limits: 1 MiB per append, 64 KiB per timeline row, and 8 MiB or 2,000 queued events per
  subscriber. Overflow sends `control` with `overflow` and closes the subscription.
- Quota: 600 appends per Principal per container per minute, answered with 429. Counted after
  authentication so an unauthenticated flood cannot spend a member's allowance, and before the body
  is read so a refused caller cannot stream a megabyte first. Reads are not counted: a read is
  cheap, while an append writes a row and moves the stream toward compaction. The number is a
  proposal added 2026-09-16 — nothing in these decisions or the master spec set one — chosen as far
  above a person working and far below what would keep compaction permanently busy.
- The plane compacts a stream into a snapshot at 8 MiB or 5,000 updates. A reader below the lower
  bound receives the snapshot first. Only the segments marked as documents below are compacted.

Segment encodings (added 2026-09-16 by the integration owner). A stream carries either Loro updates
or JSON log entries, and only a document can be compacted: replacing log entries with a snapshot
would advance the lower bound past messages that cannot be reconstructed.

| Segment                                        | Encoding      | Compacted | Basis                                                               |
| ---------------------------------------------- | ------------- | --------- | ------------------------------------------------------------------- |
| `meta`, `wf`                                   | Loro document | yes       | ADR-0031 names workspace-configuration documents                    |
| `s:<agentId>`                                  | Loro document | yes       | ADR-0031 session documents; the epoch rows under Authority below    |
| `mf:<nodeId>`                                  | Loro document | yes       | ADR-0031 names machine-state documents                              |
| `ti`, `tk:<taskId>`, `tks:<taskId>`, `rp`      | Loro document | yes       | ADR-0046 gives each one's fields, all of them rewritten in place    |
| `rpc:req:<nodeId>`, `rpc:res:<rpcId>`          | JSON log      | no        | ADR-0035 appends discrete envelopes; a response segment is one call |
| `fi:<agentId>`, `ob:<nodeId>`, `pc:<resource>` | undefined     | no        | no ADR, master spec, plan, or protocol text says what they carry    |

A segment this table does not mark as a document is never compacted, and that applies to any
segment kind added later as well. Leaving a log uncompacted costs disk; compacting one loses
history, so the default falls on the side that can be corrected.

Segments:

| Segment                       | Writer                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `meta`, `wf`                  | node for derived keys; editors for client-writable keys       |
| `s:<agentId>`, `fi:<agentId>` | node                                                          |
| `mf:<nodeId>`, `ob:<nodeId>`  | node                                                          |
| `pc:<id>`                     | editors                                                       |
| `tk:<taskId>`                 | board editors (ADR-0046)                                      |
| `ti`, `tks:<taskId>`, `rp`    | plane only                                                    |
| `rpc:req:<nodeId>`            | members, per-method role checked by plane and node (ADR-0035) |
| `rpc:res:<rpcId>`             | node; readable only by the requesting Principal and client    |

## Authority

The node is the only writer of Agent-derived containers. Clients change Agents only through machine
RPC. Existing `agent_stream` and `fetch_agent_timeline` stay authoritative for direct connections.

A session document keeps rows grouped by timeline epoch. On daemon restart the node seeds its
timeline store from the document epoch. It reconciles against Provider history by message identity;
on mismatch it starts a new epoch and publishes a timeline replacement instead of editing old rows.

## Node replica

A node keeps one SQLite database per container at
`$PASEO_HOME/enterprise/collab/<containerId>/repo.sqlite3`, in a 0700 directory because it holds the
plaintext content ADR-0031 accepts only on an encrypted volume.

Columns added 2026-09-17 by the integration owner. The plan named `producer_state`, `rpc_inbox`, and
`remote_cursors` without defining them and otherwise said only that the tables match Lody's, so this
schema is a proposal derived from the decisions above rather than a ported one.

| Table             | Holds                                                    | Keyed by              |
| ----------------- | -------------------------------------------------------- | --------------------- |
| `documents`       | the replica's Loro snapshot per segment                  | segment               |
| `pending_updates` | local updates produced but not yet accepted by the plane | segment, producer seq |
| `producer_state`  | producer id, epoch, and last sequence for fencing        | segment               |
| `remote_cursors`  | the next offset to read, for resuming after a restart    | segment               |
| `rpc_inbox`       | machine RPC ids already handled (ADR-0035)               | rpc id                |

Two different numbers are called an epoch. `producer_state.epoch` is the producer epoch of the
fencing rules above: it rises once per boot, so an append still in flight from a previous boot
carries the older one and is refused with 403 instead of interleaving. The timeline epoch that
groups rows inside a session document is unrelated, lives in the document, and is not stored here.

Raising the producer epoch re-stamps the updates still queued under the old one and renumbers them
from 1. Dropping them would lose work that survived the crash; leaving their old sequences would
open the new epoch on a gap, which the fencing rules answer with 409.

## Acceptance

Stream-store tests cover offsets, fencing results, TTL, closed streams, compaction lower bounds, and
subscriber overflow. A restart test proves no duplicate rows after producer replay.

Subscription tests cover multiplexed cursors, the all-or-nothing segment check, re-authorization on
every read, and overflow closing the subscription. Live tests cover sse and long-poll on both
routes, a hold that only its own segment releases, and revocation arriving as a status while the
headers are still unsent and as a `revoked` event once they are gone. Presence tests cover the
heartbeat, expiry on an injected clock, a non-member's refusal, a heartbeat that tries to name its
own principal or timestamp, and the roster reaching subscribers both on connect and on change.

Node replica tests cover the producer epoch rising across a restart, unsent work carried into a new
epoch without a sequence gap, the outbound queue and the replica both surviving a restart, cursors
resuming rather than replaying, a batch whose dependencies are missing leaving the cursor untouched,
and a container id that cannot escape the collab root.
