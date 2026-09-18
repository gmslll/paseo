# ADR 0018: Workspace path operations require a safe directory-handle port

- Status: Accepted
- Date: 2026-09-09
- Decision owner: Enterprise integration owner

## Problem

Workspace file operations cannot treat a canonical path string as a capability. Between
resolution and the caller's open, an ancestor can be replaced by a symlink or a different
directory. A caller can also omit a promised revalidation step. A parent path and an inode
snapshot do not close that race.

## Proposal

W5 will expose one policy facade for read, preview, download, list, write, create, rename, copy,
delete, and watch. Callers receive typed results only after the facade has completed the operation;
they do not receive a root path to rejoin or a callback they must remember to invoke. Read-like
operations open the file with `O_NOFOLLOW`, fstat it, and keep the handle until the caller closes
the returned stream/handle. Directory operations open the parent with `O_DIRECTORY|O_NOFOLLOW` and
perform child lookup and mutation relative to that handle.

The facade depends on a typed safe-FS port. The port must provide directory-handle-relative lookup
and mutation (openat/openat2 semantics, or an equivalent native implementation), explicit identity
checks, and an error-safe close contract. Missing multi-component suffixes are created one component
at a time through the verified directory handle; no operation reconstructs a path from
`canonicalParent`.

## Platform gate

Node's portable `fs.open` API does not provide a reliable cross-platform `openat`/`openat2`
primitive. `O_NOFOLLOW` and `O_DIRECTORY` are not sufficient when the operation still resolves a
child from a path string. Until a platform-specific safe-FS port is available, enterprise path
operations fail closed on that platform. There is no silent flag downgrade and no fallback to the
legacy file service for an enterprise-authorized workspace.

## Decision

Enterprise files must use a reviewed directory-handle-relative adapter. The macOS adapter is not
complete, so enterprise file operations remain blocked on macOS. Platforms without an equivalent
adapter fail closed and never fall back to the legacy file service. A future macOS native package
or build integration requires a separate narrow ADR.
