# ADR 0007: W4 browser Profile wiring ownership

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Browser Profile isolation needs a thin trusted path from Agent tool resolution through daemon routing and Electron session ownership. The original W4 list does not name every existing integration file on that path.

## Decision

W4 may modify these browser-specific integration areas:

- `packages/server/src/server/agent/tools/paseo-tools.ts`, only to call the trusted Profile resolver and keep `browserProfileId` out of Agent-visible tool schemas;
- Desktop browser-automation IPC and service modules;
- the browser Profile session, attach, popup, and download regions of `packages/desktop/src/main.ts`;
- the browser bridge in `packages/app/src/desktop/host.ts`;
- `createWorkspaceBrowser` call sites in
  `packages/app/src/screens/workspace/workspace-screen.tsx`, only to pass the hydrated Workspace
  and Profile authorization selected by W3;
- the `enterprise-browser-profiles` Desktop capture-harness group.

W3 retains `host-runtime` ownership. W6 retains enterprise UI ownership. W7 retains enterprise cross-module E2E and CI routing.

## Reason

The security boundary depends on one server-selected Profile context reaching the Electron session that owns the target WebView. Splitting the thin transport path across workstreams would require untyped interim fields or client-selected Profile IDs.

## Boundary

- Agent tool input cannot accept `browserProfileId`, `leaseId`, or `fencingToken`.
- The daemon resolves the authorized Profile and adds the protocol envelope.
- Electron validates the Profile, lease, fencing token, Browser ID, and owning host before each operation.
- Existing Browser IDs cannot be rebound to another Workspace or Profile.
- W4 does not change Session filtering, Principal-scoped client caches, enterprise UI, or W7 test ownership.
