# ADR 0002: Browser Profile node field

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

The Browser Profile example names `homeNodeId`, while the implementation gate requires every new Profile to carry the current `nodeId`. Adding both creates two node authorities without a rule for disagreement.

## Decision

Use `homeNodeId` as the only Browser Profile node field. It is the Profile's required node dimension and names the node that owns its local Chromium data.

`ResourceLease.nodeId` and `GlobalResourceRef.nodeId` continue to name lease execution and resource placement. Placement must agree with `BrowserProfileRecord.homeNodeId` before Profile use. Moving a Profile is an explicit operation that creates or rebinds placement after the source lease is released. Browser storage is not copied automatically.

## Reason

One Profile field prevents authorization, routing, and lease code from choosing between two authorities. `homeNodeId` matches the Profile and placement semantics in the master specification.

## Boundary

- W0 exports `BrowserProfileRecord.homeNodeId` and no `nodeId`.
- W4 stores and routes the Profile with that `homeNodeId` and rejects mismatched placement.
- W8 represents current global placement with `GlobalResourceRef.nodeId`; a second Profile node field requires another ADR and migration plan.
- P0 local adapters supply the current `NodeContext`; callers do not derive a node from the Profile ID, partition key, or filesystem path.
