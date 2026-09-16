import { describe, expect, test } from "vitest";

import { parseCollabSegment } from "@getpaseo/protocol/enterprise-collaboration";
import { streamAccess } from "./stream-access.js";

const WORKSPACE = "cws_0123456789abcdef";
const BOARD = "brd_0123456789abcdef";
const TASK = "tsk_0123456789abcdef";
const NODE = "nod_0123456789abcdef";
const RPC = "rpc_0123abcd-0123-0123-0123-0123456789ab";

function access(input: {
  containerId: string;
  segment: string;
  role: "owner" | "editor" | "viewer" | null;
}) {
  const segment = parseCollabSegment(input.segment);
  if (!segment) throw new Error(`unparsable segment ${input.segment}`);
  return streamAccess({ containerId: input.containerId, segment, role: input.role });
}

/** A node arrives with no role at all: its authority is placement, checked before it gets here. */
function nodeAccess(input: { containerId: string; segment: string }) {
  const segment = parseCollabSegment(input.segment);
  if (!segment) throw new Error(`unparsable segment ${input.segment}`);
  return streamAccess({ containerId: input.containerId, segment, role: null, caller: "node" });
}

describe("collaboration stream access", () => {
  test("lets editors write the client-writable segments and refuses viewers", () => {
    for (const segment of ["meta", "wf", "pc:preview-1"]) {
      expect(access({ containerId: WORKSPACE, segment, role: "editor" }).write).toBe(true);
      // An owner holds every editor action, so owners write wherever editors do.
      expect(access({ containerId: WORKSPACE, segment, role: "owner" }).write).toBe(true);
      // A viewer has no workspace.write, so it never writes a document segment.
      expect(access({ containerId: WORKSPACE, segment, role: "viewer" }).write).toBe(false);
    }
  });

  test("refuses every client write to node-owned and plane-owned segments", () => {
    const nodeOwned = [`s:agent-1`, `fi:agent-1`, `mf:${NODE}`, `ob:${NODE}`];
    for (const segment of nodeOwned) {
      for (const role of ["owner", "editor"] as const) {
        expect(access({ containerId: WORKSPACE, segment, role }).write).toBe(false);
      }
    }
    for (const segment of ["ti", "rp", `tks:${TASK}`]) {
      expect(access({ containerId: BOARD, segment, role: "owner" }).write).toBe(false);
    }
  });

  test("lets any member write an RPC request and no one read it back", () => {
    const segment = `rpc:req:${NODE}`;
    // ADR-0032 names members, not editors: a viewer may still drive an Agent through machine RPC,
    // with the per-method role checked separately (ADR-0035).
    expect(access({ containerId: WORKSPACE, segment, role: "viewer" }).write).toBe(true);
    expect(access({ containerId: WORKSPACE, segment, role: null }).write).toBe(false);
    expect(access({ containerId: WORKSPACE, segment, role: "owner" }).read).toBe(false);
  });

  test("refuses reading an RPC response until the requester is known", () => {
    // Only the requesting Principal may read it, and the plane does not record rpc requesters yet.
    const result = access({ containerId: WORKSPACE, segment: `rpc:res:${RPC}`, role: "owner" });
    expect(result.read).toBe(false);
    expect(result.write).toBe(false);
  });

  test("lets members read document segments and refuses non-members entirely", () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(access({ containerId: WORKSPACE, segment: "meta", role }).read).toBe(true);
    }
    const stranger = access({ containerId: WORKSPACE, segment: "meta", role: null });
    expect(stranger.read).toBe(false);
    expect(stranger.write).toBe(false);
  });

  test("closes board containers until board membership exists", () => {
    // tk: is a board segment on a board container, so the kinds match and only the missing board
    // membership model keeps it shut. A Workspace role must never be read as a board role.
    for (const role of ["owner", "editor", "viewer"] as const) {
      expect(access({ containerId: BOARD, segment: `tk:${TASK}`, role })).toEqual({
        read: false,
        write: false,
      });
    }
  });

  test("opens the node-owned segments to a node and keeps the client-writable ones shut", () => {
    // ADR-0032 makes the node the only writer of the Agent-derived segments. Placement is what
    // gives it that authority, so it writes them holding no membership at all.
    for (const segment of [`s:agent-1`, `fi:agent-1`, `mf:${NODE}`, `ob:${NODE}`]) {
      expect(nodeAccess({ containerId: WORKSPACE, segment }).write).toBe(true);
    }
    // `meta` names both node and editor, so a node writes its derived keys there too.
    expect(nodeAccess({ containerId: WORKSPACE, segment: "meta" }).write).toBe(true);
    // A node is not a member, so the segments that answer to membership stay closed to it.
    expect(nodeAccess({ containerId: WORKSPACE, segment: "pc:preview-1" }).write).toBe(false);
    expect(nodeAccess({ containerId: WORKSPACE, segment: `rpc:req:${NODE}` }).write).toBe(false);
  });

  test("lets a node take RPC requests and answer them, and read back neither", () => {
    // The node reads the request segment it is addressed on and writes the response segment.
    expect(nodeAccess({ containerId: WORKSPACE, segment: `rpc:req:${NODE}` }).read).toBe(true);
    expect(nodeAccess({ containerId: WORKSPACE, segment: `rpc:res:${RPC}` }).write).toBe(true);
    // Only the requesting Principal reads a response back; the node that wrote it does not.
    expect(nodeAccess({ containerId: WORKSPACE, segment: `rpc:res:${RPC}` }).read).toBe(false);
  });

  test("keeps board containers shut to a node as well", () => {
    // Every board segment belongs to the plane or to editors, so placement opens none of them.
    for (const segment of ["ti", "rp", `tks:${TASK}`, `tk:${TASK}`]) {
      expect(nodeAccess({ containerId: BOARD, segment })).toEqual({ read: false, write: false });
    }
  });

  test("treats a caller that does not identify itself as a client, never as a node", () => {
    // The default decides what an un-migrated call site gets, so it has to be the closed one.
    expect(access({ containerId: WORKSPACE, segment: "s:agent-1", role: "owner" }).write).toBe(
      false,
    );
  });

  test("refuses a segment that belongs to the other container kind", () => {
    // A board segment on a Workspace container, and a Workspace segment on a board.
    expect(access({ containerId: WORKSPACE, segment: `tk:${TASK}`, role: "owner" })).toEqual({
      read: false,
      write: false,
    });
    expect(access({ containerId: BOARD, segment: "meta", role: "owner" })).toEqual({
      read: false,
      write: false,
    });
  });
});
