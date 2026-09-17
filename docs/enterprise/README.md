# Enterprise implementation contracts

Start with [contracts.md](contracts.md). Accepted cross-workstream decisions live in
[decisions/](decisions/).

The implementation baseline is commit `4879265f8`. W2 owns the machine-readable resource-entry
inventory and its exhaustiveness checks.

Track release evidence and unresolved production boundaries in the
[P0 security gate checklist](p0-gate-checklist.md).

## Decision index

- [ADR 0001: W0 contract test ownership](decisions/0001-w0-contract-test-ownership.md)
- [ADR 0002: Browser Profile node field](decisions/0002-browser-profile-node-field.md)
- [ADR 0003: W1 config ownership and Session authorization generation](decisions/0003-w1-config-and-session-generation.md)
- [ADR 0004: Agent ownership envelope handoff](decisions/0004-agent-ownership-envelope-handoff.md)
- [ADR 0005: Grant version in Session binding](decisions/0005-grant-version-session-binding.md)
- [ADR 0006: W3 Principal-scoped cache ownership](decisions/0006-w3-principal-cache-ownership.md)
- [ADR 0007: W4 browser Profile wiring ownership](decisions/0007-w4-browser-profile-wiring.md)
- [ADR 0008: Enterprise V1 enum freeze](decisions/0008-enterprise-v1-enum-freeze.md)
- [ADR 0009: P0 evidence and capacity gates](decisions/0009-p0-evidence-and-capacity-gates.md)
- [ADR 0010: Execution actions, AppSlot authorization, and Service Proxy admission](decisions/0010-execution-actions-app-slot-and-service-proxy.md)
- [ADR 0011: Enterprise UI projections and credential memory](decisions/0011-enterprise-ui-projections-and-credential-memory.md)
- [ADR 0012: Workspace wire context and entry inventory ownership](decisions/0012-workspace-wire-context-and-entry-inventory.md)
- [ADR 0013: Relay encrypted authentication preface](decisions/0013-relay-encrypted-auth-preface.md)
- [ADR 0014: Persisted owner filtering and outbound authorization context](decisions/0014-outbound-authorization-context.md)
- [ADR 0015: Register enterprise RPCs in the operation permission gate](decisions/0015-enterprise-operation-permission-registration.md)
- [ADR 0016: Audit Sink authority and durability](decisions/0016-audit-sink-authority-and-durability.md)
- [ADR 0017: Browser Profile runtime authorization](decisions/0017-browser-profile-runtime-authorization.md)
- [ADR 0018: Workspace path operations require a safe directory-handle port](decisions/0018-workspace-safe-fs-openat-platform.md)
- [ADR 0019: Portable audit storage](decisions/0019-portable-audit-storage.md)
- [ADR 0020: Preconstruct session authorization before enterprise runtime](decisions/0020-w1-w2-w3-runtime-construction-order.md)
- [ADR 0021: Reconnect must replace the session authorization runtime](decisions/0021-reconnect-runtime-generation.md)
- [ADR 0022: Register enterprise RPC dispatch and feature gates](decisions/0022-enterprise-rpc-dispatch-and-feature-gating.md)
- [ADR 0023: Production enterprise runtime factory ownership](decisions/0023-production-enterprise-runtime-factory.md)
- [ADR 0024: Enterprise resource-specific content-read contract](decisions/0024-enterprise-content-read-contract.md)
- [ADR 0025: Browser Profile runtime authorization lifecycle](decisions/0025-browser-profile-runtime-authorization-lifecycle.md)
- [ADR 0026: Provider history and search resource contract](decisions/0026-provider-history-and-search-resource-contract.md)
- [ADR 0027: Single-resource ownership transfer contract](decisions/0027-single-resource-ownership-transfer.md)
- [ADR 0028: Browser page identity observation ownership](decisions/0028-browser-page-identity-observation.md)
- [ADR 0029: Distributed management plane v1](decisions/0029-distributed-management-plane-v1.md)
- [ADR 0030: Enterprise password ticket exchange](decisions/0030-enterprise-password-ticket-exchange.md)
- [ADR 0031: Collaborative content data plane](decisions/0031-collaborative-content-data-plane.md)
- [ADR 0032: Durable-Streams-compatible transport and document authority](decisions/0032-durable-streams-transport-and-document-authority.md)
- [ADR 0033: Workspace membership roles](decisions/0033-workspace-membership-roles.md)
- [ADR 0034: Shared Agent turn control](decisions/0034-shared-agent-turn-control.md)
- [ADR 0035: Outbound-only machine RPC](decisions/0035-outbound-only-machine-rpc.md)
- [ADR 0036: Collaboration revocation, tombstones, and workspace catalog](decisions/0036-collaboration-revocation-and-catalog.md)
- [ADR 0037: Data plane audit](decisions/0037-data-plane-audit.md)
- [ADR 0038: Local transport planes](decisions/0038-local-transport-planes.md)
- [ADR 0039: Managed Agent runtimes](decisions/0039-managed-agent-runtimes.md)
- [ADR 0040: Team task board scope](decisions/0040-team-task-board-scope.md)
- [ADR 0041: Daemon SQLite storage](decisions/0041-daemon-sqlite-storage.md)
- [ADR 0042: Durable delegation outbox](decisions/0042-durable-delegation-outbox.md)
- [ADR 0043: Delegation authority and MCP caller capability](decisions/0043-delegation-authority-and-mcp-caller-capability.md)
- [ADR 0044: Per-turn diff store](decisions/0044-per-turn-diff-store.md)
- [ADR 0045: Turn diff and task content read views](decisions/0045-turn-diff-and-task-content-views.md)
- [ADR 0046: Task documents and state machine](decisions/0046-task-documents-and-state-machine.md)
- [ADR 0047: Task grants field](decisions/0047-task-grants-field.md)
- [ADR 0048: Review policy](decisions/0048-review-policy.md)
- [ADR 0049: Pull request poller state and task links](decisions/0049-pr-poller-state-and-task-links.md)
- [ADR 0050: Local plane break-glass admission](decisions/0050-local-plane-break-glass-admission.md)
- [ADR 0051: Workspace membership invitations](decisions/0051-workspace-membership-invitations.md)
- [ADR 0052: What shared turn control needs before it can be built](decisions/0052-shared-turn-control-substrate.md)
- [ADR 0053: What a machine RPC needs before a node can answer one](decisions/0053-headless-sessions-for-machine-rpc.md)
- [ADR 0054: Who implements the ADR-0045 Agent `turn_diff` content-read view](decisions/0054-turn-diff-content-read-workstream.md) (`DECISION_REQUIRED`)
