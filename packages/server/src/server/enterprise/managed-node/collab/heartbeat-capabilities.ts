/**
 * Enrollment never sets this flag (the CLI heartbeat is platform, arch, managed, and browser).
 * The plane refuses owner enable and omits workspaceMemberships unless the live heartbeat declares
 * it (ADR-0033), so the flag follows the collab runtime, not the enrollment snapshot.
 */
export function collaborationHeartbeatCapabilities(input: {
  capabilities: Readonly<Record<string, string | number | boolean>>;
  collaborationOn: boolean;
}): Record<string, string | number | boolean> {
  const next: Record<string, string | number | boolean> = { ...input.capabilities };
  if (input.collaborationOn) {
    next.collaborationV1 = true;
    return next;
  }
  delete next.collaborationV1;
  return next;
}
