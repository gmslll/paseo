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
- [ADR 0026: Provider history and search resource contract](decisions/0026-provider-history-and-search-resource-contract.md)
- [ADR 0027: Single-resource ownership transfer contract](decisions/0027-single-resource-ownership-transfer.md)
