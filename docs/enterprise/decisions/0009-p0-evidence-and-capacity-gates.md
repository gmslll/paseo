# ADR 0009: P0 evidence and capacity gates

- Status: Accepted
- Date: 2026-09-09
- Deciders: integration owner

## Context

P0 needs evidence that exercises the contract boundary or the production boundary. Tests
against stubs, private state, fake desktop surfaces, or IndexedDB contents alone can pass while
the typed adapter or runtime integration is broken.

Capacity case 20 also covers two different risks. Daemon-core connection safety does not prove
that real provider processes can sustain the release workload.

## Decision

P0 core evidence must use one of these forms:

- a typed Port with its typed in-memory adapter contract test; or
- a real daemon, network connection, Playwright browser, or Electron runtime.

Stub-only tests, private-state assertions, fake desktop surfaces, and IndexedDB-only assertions
do not count as P0 evidence.

Case 20 has two required parts:

- Part A runs a typed `AgentClient` adapter with 10 personal access tokens over real
  WebSockets for a 30-minute daemon-core safety soak.
- Part B runs representative real Codex and Claude providers, including sandbox and child-process
  behavior, for a 30-minute release-capacity run.

Part A cannot replace Part B. If Part B cannot run, case 20 is `BLOCKED`, not passed by Part A.
Browser capacity uses a separate real-Electron run with at least three Browser Profiles.

Provisional resource thresholds remain in the supervisor decisions and are outside this ADR.

## Consequences

- Workstream evidence must name which accepted evidence form it uses.
- Release reporting presents case 20 Parts A and B separately.
- Missing real-provider or real-Electron capacity evidence is visible as blocked rather than
  inferred from lower-level tests.
