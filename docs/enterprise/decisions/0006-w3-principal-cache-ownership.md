# ADR 0006: W3 Principal-scoped cache ownership

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Enterprise logout and identity switching must clear or partition every client cache that can reveal another Principal's data. The original workstream list names the broad Session and timeline areas but does not enumerate each Store or the reconnect subscription seam.

## Decision

W3 owns the enterprise Principal-scoping changes in:

- host runtime;
- replica cache;
- Session Store;
- draft Store;
- Workspace layout and tabs;
- review state;
- attachments;
- last Workspace selection;
- download Store.

W3 may modify `packages/client/src/connection/index.ts` only for Principal-scope subscription restore and cleanup.

W6 must not modify these security keys. W6 consumes the already-scoped state to render enterprise UI.

## Reason

One workstream must own the identity transition from transport through durable client state. Splitting those keys between Session and UI workstreams would allow partial cleanup and stale repaint.

## Boundary

- Cache keys include the identity and node dimensions required by the master specification.
- W3 stops network delivery before releasing or changing the active Principal Store.
- W6 owns presentation only and cannot add fallback keys that omit Principal scope.
- Cross-principal cache, logout, and offline-reopen adversarial E2E evidence remains W7-owned.
