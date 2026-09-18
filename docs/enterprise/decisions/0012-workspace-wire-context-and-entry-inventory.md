# ADR 0012: Workspace wire context and entry inventory ownership

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Several existing cwd-based requests do not carry a stable Workspace identifier. Enterprise audit
and authorization cannot trust cwd or a client-supplied owner, organization, or node. File uploads
also need a server-issued handle so later attachment use does not trust a legacy path.

## Decision

Existing Workspace-scoped request schemas add optional `workspaceId` for file explorer,
subscription, mutation, download, upload, cwd-based project icon, project config, directory
suggestions, Provider models/modes/features/snapshots/history, schedule new-Agent targets, loop
runs, and chat creation. Legacy single-user payloads may omit it.

In enterprise mode the server requires `workspaceId`, resolves it through the registry, and checks
it against the authenticated Principal and canonical resource. A client cannot supply trusted
owner, organization, node, actor, holder, or credential context.

The upload service issues an opaque `uploadId`. `FileUploadResponse` and
`UploadedFileAttachment` carry optional `uploadId` and `workspaceId`. Enterprise mode resolves
attachments by `uploadId`; legacy paths are accepted only in legacy single-user mode.

Requests already keyed by Agent, Terminal, Project, Schedule, Loop, or Browser ID resolve the
Workspace through server-side binding. Responses, status events, and errors inherit the
server-side request or emit context; they do not add a client-authoritative resource reference.
`rpc_error` requires the request's resource context and is not transport-control allowlisted.

W2 owns the machine-readable complete entry inventory and its mechanical exhaustiveness checks.
W0 owns only the optional protocol fields and their compatibility tests.

## Consequences

- Missing `workspaceId` is a protocol-compatible legacy shape, not an enterprise authorization
  fallback.
- Failed resource correlation produces a fixed redacted protocol error.
- New entry points must be added to W2's inventory before P0 evidence is complete.
