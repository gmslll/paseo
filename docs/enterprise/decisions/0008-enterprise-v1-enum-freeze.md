# ADR 0008: Enterprise V1 enum freeze

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Adding a literal to a wire enum can make a new daemon emit a value that an old client rejects. Enterprise V1 introduces several closed vocabularies used by independently updated clients, daemons, and browser hosts.

## Decision

The following V1 vocabularies are frozen at the values in `packages/protocol/src/messages.ts` and `packages/protocol/src/browser-automation/rpc-schemas.ts`:

- enterprise Feature Flags;
- Principal types and Principal ID prefixes;
- Enterprise Actions and Resource Selector kinds;
- node modes and statuses;
- global and leasable resource kinds;
- lease modes;
- Browser Profile platforms and statuses;
- AppSlot statuses;
- enterprise resource display statuses;
- audit outcomes;
- browser enterprise-envelope version.

Future values require a V2 schema and a distinct V2 Feature Flag or RPC. Do not append a V1 enum and rely on peers ignoring the value.

## Reason

Feature gating controls whether a feature runs. It does not make an unknown enum value parseable after the message is sent.

## Boundary

- Optional object fields may still be added under the protocol compatibility rules.
- A V2 consumer normalizes at one capability gate and does not scatter V1 fallbacks.
- Old V1 message types remain accepted through their compatibility window.
