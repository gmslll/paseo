import {
  COLLAB_SEGMENT_READERS,
  COLLAB_SEGMENT_WRITERS,
  collabContainerKind,
  collabSegmentContainerKind,
  type CollabSegment,
  type WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";

// What a member of a container may do with one segment (ADR-0032, ADR-0033). This is the plane
// side only: `node` and `plane` writers never arrive through the authenticated HTTP route, so a
// segment they own is closed to every client regardless of role.

export interface StreamAccess {
  read: boolean;
  write: boolean;
}

const CLOSED: StreamAccess = Object.freeze({ read: false, write: false });

/** An owner holds every editor action, so it writes wherever an editor writes. */
function isEditor(role: WorkspaceMemberRole): boolean {
  return role === "owner" || role === "editor";
}

export function streamAccess(input: {
  containerId: string;
  segment: CollabSegment;
  role: WorkspaceMemberRole | null;
}): StreamAccess {
  const containerKind = collabContainerKind(input.containerId);
  // A board segment on a Workspace container is not a permission question, it is a malformed
  // target; answering it like any other refusal keeps the two indistinguishable.
  if (!containerKind || containerKind !== collabSegmentContainerKind(input.segment)) return CLOSED;
  if (!input.role) return CLOSED;

  const writers = COLLAB_SEGMENT_WRITERS[input.segment.kind];
  const readers = COLLAB_SEGMENT_READERS[input.segment.kind];

  const write = (writers.includes("editor") && isEditor(input.role)) || writers.includes("member");
  // `requester` reads are for the Principal that issued the RPC. The plane does not record rpc
  // requesters yet, so those stay closed rather than opening to every member.
  const read = readers.includes("member");

  return { read, write };
}
