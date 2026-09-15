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
- Limits: 1 MiB per append, 64 KiB per timeline row, and 8 MiB or 2,000 queued events per
  subscriber. Overflow sends `control` with `overflow` and closes the subscription.
- The plane compacts a stream into a snapshot at 8 MiB or 5,000 updates. A reader below the lower
  bound receives the snapshot first.

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

## Acceptance

Stream-store tests cover offsets, fencing results, TTL, closed streams, compaction lower bounds, and
subscriber overflow. A restart test proves no duplicate rows after producer replay.
