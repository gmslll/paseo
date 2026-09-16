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
