import {
  COLLAB_SEGMENT_READERS,
  COLLAB_SEGMENT_WRITERS,
  collabContainerKind,
  collabSegmentContainerKind,
  type CollabSegment,
  type WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";

// What a caller may do with one segment (ADR-0032, ADR-0033).
//
// Two kinds of caller reach the stream routes. A client answers to membership: its role decides,
// and the segments ADR-0032 gives to the node or the plane stay closed to it whatever that role is.
// A node answers to placement instead — it holds no membership and no role — so it opens exactly
// the segments the matrix names `node`. Whether the container is really placed on that node is the
// caller's question, not this one; this file only maps a caller kind onto the matrix.
//
// `plane` writers are still closed to both: nothing authenticates as the plane.

export interface StreamAccess {
  read: boolean;
  write: boolean;
}

/** Which authority the caller arrived with. Membership for a client, placement for a node. */
export type StreamCaller = "principal" | "node";

const CLOSED: StreamAccess = Object.freeze({ read: false, write: false });

/** An owner holds every editor action, so it writes wherever an editor writes. */
function isEditor(role: WorkspaceMemberRole): boolean {
  return role === "owner" || role === "editor";
}

export function streamAccess(input: {
  containerId: string;
  segment: CollabSegment;
  role: WorkspaceMemberRole | null;
  /** Defaults to a client, so a caller that does not say is never treated as a node. */
  caller?: StreamCaller;
}): StreamAccess {
  const containerKind = collabContainerKind(input.containerId);
  // A board segment on a Workspace container is not a permission question, it is a malformed
  // target; answering it like any other refusal keeps the two indistinguishable.
  if (!containerKind || containerKind !== collabSegmentContainerKind(input.segment)) return CLOSED;
  // Board containers answer to board membership (ADR-0046), which does not exist yet. The caller's
  // role here is Workspace membership and says nothing about a board, so boards stay closed
  // explicitly. Without this they would merely happen to be closed because no board row exists,
  // and would open silently the moment boards are stored. Nodes are closed here too: every board
  // segment belongs to the plane or to editors, so placement opens none of them.
  if (containerKind === "board") return CLOSED;

  const writers = COLLAB_SEGMENT_WRITERS[input.segment.kind];
  const readers = COLLAB_SEGMENT_READERS[input.segment.kind];

  if (input.caller === "node") {
    // Role is deliberately not consulted: a node holds no membership, and reading one here would
    // make a node's authority depend on whether someone happened to share the Workspace with it.
    return { read: readers.includes("node"), write: writers.includes("node") };
  }

  if (!input.role) return CLOSED;

  const write = (writers.includes("editor") && isEditor(input.role)) || writers.includes("member");
  // `requester` reads are for the Principal that issued the RPC. The plane does not record rpc
  // requesters yet, so those stay closed rather than opening to every member.
  const read = readers.includes("member");

  return { read, write };
}
