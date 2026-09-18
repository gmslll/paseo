# 0019: portable audit storage

Status: **Accepted**. The enterprise integration owner accepts this fail-closed
decision: portable Node `JsonlAuditStorage` is a typed/test adapter only and is not
enterprise production release-ready.

Node's portable API has no reviewed `openat`-equivalent for opening dated children
relative to a validated directory handle. An ancestor directory swap can therefore
occur between validation and child open. Enterprise P0 production audit remains
**BLOCKED** on all platforms until a reviewed native/equivalent adapter closes this
boundary.

`NodeAuditDirectoryHandle.readEntries()` is the adapter's one deliberate path reopen:
it calls `readdir(directoryPath)` because portable Node cannot enumerate relative to
the validated directory handle. `PORTABLE_AUDIT_STORAGE_RELEASE_READY` therefore stays
`false`, with `PORTABLE_AUDIT_STORAGE_UNSUPPORTED_REASON` identifying the missing
parent-`openat` boundary. Bootstrap must reject this adapter while that marker is false.

File-level `O_NOFOLLOW`, fstat/chmod, strict parsing, append rollback, and poison
handling remain testable in the portable adapter; they do not remove the ancestor-swap
residual risk.
