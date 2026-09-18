# ADR 0001: W0 contract test ownership

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

The workstream ownership list gives W0 exclusive ownership of protocol implementation files but does not name colocated protocol test files. The same specification requires W0 to build protocol behavior and compatibility through vertical TDD. Treating every test file as W7-owned would prevent W0 from meeting its completion gate.

## Decision

W0 owns `packages/protocol/src/messages.enterprise*.test.ts` and browser-automation tests that are colocated with the W0 protocol module and verify only W0 contracts.

W7 retains ownership of cross-module security tests, adversarial tests, pressure tests, and real end-to-end tests.

## Reason

Protocol compatibility tests must change with the schemas they protect. Colocation lets W0 demonstrate each red-to-green slice without granting access to another workstream's implementation.

## Boundary

W0 tests may cover:

- optional enterprise feature flags and old/new peer parsing;
- enterprise schema and RPC shape;
- explicit post-validation normalization;
- browser-automation protocol fields owned by W0.

W0 tests may not implement or simulate Session authorization, cross-principal isolation, audit storage, pressure, browser partition behavior, or real Electron/daemon flows. Those remain with W1-W7 according to the master specification.
W2 owns the machine-readable resource-entry inventory and its mechanical exhaustiveness tests under
[ADR 0012](0012-workspace-wire-context-and-entry-inventory.md).
