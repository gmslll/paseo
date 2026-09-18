# ADR-0031: Collaborative content data plane

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

A Workspace with collaboration enabled synchronizes its session, task, workspace-configuration, and
machine-state documents through the management plane as CRDT documents. The plane persists those
documents and their attachment blobs. This supersedes the rule that raw chat never passes through
the plane for that Workspace. A Workspace without collaboration keeps the ADR-0029 data flow.

The plane never receives Provider credentials, Browser cookies, `persistence.nativeHandle`,
`runtimeInfo.extra`, system prompts, MCP server definitions, or daemon configuration. Nodes project
Agent state through an allowlist before writing it to a document.

Plane content is stored in plaintext inside SQLite and the blob directory. The deployment must put
the plane data volume on encrypted storage. A plane compromise exposes every collaborative
Workspace body; this risk is accepted for the collaboration release.

## Amends

- Master spec §5.1.4 item 6 and the paragraph limiting the plane to metadata.
- Master spec §5.1.7 central and node-local storage lists.
- Master spec §5.1.10: the plane compromise boundary no longer protects collaborative bodies.
- ADR-0029 "Data flow".

## Boundaries

- Collaboration is enabled per Workspace by its owner and is off by default. Standalone daemons are
  unchanged.
- Nodes remain the authority for files, Provider sessions, Browser Profiles, and AppSlots.
- Boss content access to a collaborative document still requires `workspace.content.read` and a
  `required` audit event (ADR-0037).
- The document encoding is Loro (`loro-crdt`). Hermes clients read plane-materialized JSON pages
  until a native Loro binding is verified.

## Acceptance

Tests prove that denied fields never appear in a stored document, that a Workspace without
collaboration produces no plane stream writes, and that Boss reads without a content Grant are
denied before any document bytes are returned.
