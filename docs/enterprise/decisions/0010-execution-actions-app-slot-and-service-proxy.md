# ADR 0010: Execution actions, AppSlot authorization, and Service Proxy admission

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

`workspace.write` is too broad to authorize terminals, Provider history, Workspace scripts, or
editor launches. Those operations cross different execution and disclosure boundaries. The
resource authorization contract also lacks an AppSlot assertion even though AppSlot use requires
the same resource-level check as Browser Profile use.

The existing public Workspace Service Proxy has no authenticated Principal. Leaving it enabled in
enterprise multi-user mode would bypass Principal-scoped resource authorization and audit.

## Decision

Enterprise Action V1 adds these distinct actions:

- `terminal.use`;
- `provider.history.read`;
- `provider.history.import`;
- `workspace.script.execute`;
- `workspace.script.configure`;
- `workspace.editor.open`.

`workspace.write` does not imply any of them. The employee preset grants none of these actions by
default. They are part of the V1 enum freeze in [ADR 0008](0008-enterprise-v1-enum-freeze.md).

`ResourceAuthorization` adds
`assertAppSlot(ctx, action, appSlotId): Promise<AuthorizedAppSlot>` to its minimum typed contract.

When `enterpriseMultiUser` is enabled, a public Workspace Service Proxy request without a
Principal is disabled and fails closed. Existing single-user behavior stays unchanged. Opening
the proxy in enterprise mode requires a separate ADR covering HTTP identity, resource
authorization, and audit.

## Boundary

- W0 owns the action, authorization, and admission-policy contracts.
- W1 owns enterprise authentication assembly at the public entry point.
- W5 owns execution-side Service Proxy wiring and the new action checks.
- This ADR does not authorize W0 to change Service Proxy implementation files.
