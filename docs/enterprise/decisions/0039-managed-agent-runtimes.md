# ADR-0039: Managed Agent runtimes

- Status: Accepted
- Date: 2026-09-16
- Decision owner: Enterprise integration owner (decided by the user on 2026-09-15)

## Decision

The company pins Provider runtime versions. The plane stores content-addressed artifacts and a
monotonic runtime policy. Nodes install pinned artifacts and resolve Provider binaries from them.

- Policy: `policyVersion`, runtime pins, `pathFallback: "allow" | "forbid"`,
  `allowCommandOverride`, and `autoInstall`.
- A pin names a runtime, a version, the Provider IDs it serves, an optional compatible Agent SDK
  range, and one artifact per `platformArch` with SHA-256, size, archive format, and relative
  command.
- Install layout: `$PASEO_HOME/runtimes/<name>/<version>/<platformArch>/` with `metadata.json` and a
  `.paseo-complete` marker, staging in `$PASEO_HOME/runtimes/.downloads/`, and command links in
  `$PASEO_HOME/runtimes/bin/`.
- Install: lock, stream download with incremental SHA-256, reject absolute, `..`, and escaping
  symlink entries before extraction, probe `--version`, write metadata atomically, write the marker,
  rename into place, swap the link. Garbage collection keeps the previous version and any version in
  use.
- Resolution order: pinned and installed runtime, configured command, PATH. When the policy forbids
  PATH fallback, a pinned runtime that is not installed makes the Provider unavailable.
- Plane routes: administrator artifact upload, pin, policy, and status routes require
  `identity.manage` and write audit. Nodes use new signed routes `GET /v1/node/runtime-policy` and
  `GET /v1/node/runtime-artifacts/<sha256>`, and report status through heartbeat `capabilities`.
  The existing strict policy response is not extended.
- Standalone daemons read an optional `$PASEO_HOME/runtime-policy.json`. Without it, behavior is
  unchanged.

Feature flag: `managedRuntimes`. Runtime schemas consumed by nodes are non-strict so a newer plane
does not break an older node.

## Amends

- Master spec §11.3: company Provider execution also pins runtime versions.
- W5 Provider launch policy.

## Acceptance

Tests use real archives and cover SHA mismatch, oversize, traversal entries, crash resume, metadata
mismatch, forbidden PATH fallback, resolution order, and a plane-to-node install.
