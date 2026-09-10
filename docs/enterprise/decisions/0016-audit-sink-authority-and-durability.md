# ADR 0016: Audit Sink authority and durability

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

The original `AuditSink.append(event): Promise<void>` contract makes callers construct finalized
events. A caller can choose the event identity, time, node, ordering, or hash-chain fields. The
return value also cannot distinguish durable acceptance from a best-effort memory buffer.

## Decision

`AuditEvent` remains the finalized wire and audit-query shape. Add a strict, non-wire
`AuditEventInput` for caller-owned business facts. It excludes `eventId`, `occurredAt`, `nodeId`,
`nodeEventSeq`, `previousHash`, and `eventHash`; unknown fields are rejected instead of stripped.

`AuditSink` has this contract:

```ts
append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent>;
```

`AuditAppendOptions.durability` has two values:

- `required`: resolve only after durable storage succeeds. Reject storage failure so Boss content
  reads and high-risk operations fail closed.
- `buffered`: finalize the event, then resolve only after it enters a bounded, ordered memory
  queue. Reject when the queue is full or the Sink cannot preserve order.

The Sink finalizes an accepted input once. Queue retries and storage replay use the same
`eventId`, `occurredAt`, `nodeId`, `nodeEventSeq`, `previousHash`, and `eventHash`; they do not call
the authority sources again. `previousHash` is absent only for the chain genesis event.

The local Sink is constructed with `NodeContext`, `AuditClock`, `AuditIdSource`, `AuditHash`,
`AuditSequence`, and `AuditStorage`. These dependencies are injected so W7 can prove time, ID,
sequence, hashing, persistence, failure, and replay behavior deterministically.

`AuditStorage.readAll()` returns persisted events in chain order across file boundaries. At
startup, the Sink verifies the stored node, sequence, previous hash, and event hash before deriving
the tail. Invalid history rejects initialization. `AuditSequence.next(lastSequence)` receives the
verified tail sequence, or `null` for an empty chain. `AuditStorage.append(event)` accepts the
already-finalized event so restart recovery and buffered replay cannot regenerate it.

## Ownership

- W0 owns the input, options, dependency, Sink, and Local Sink contracts plus colocated contract
  tests.
- W7 implements the Sink, hash chain, durable storage, bounded queue, replay, and failure tests.
- W1, W2, W4, and W5 submit only business input and the required durability. They do not generate
  or override Sink-owned fields.

## Boundary

- `AuditEventSchema` and `enterprise.audit.list_events.response` keep their current wire shape,
  with the backward-compatible optional `priority: "normal" | "high"` field.
- This decision adds no Session RPC and no UI receipt field.
- The returned `AuditEvent` is the finalized record. For `buffered`, it does not claim that durable
  storage has completed.
