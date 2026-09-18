import { describe, expect, test } from "vitest";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";
import { COLLAB_TIMELINE_UNAVAILABLE, createCollabTimelineControl } from "./timeline-control.js";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const WORKSPACE_UID = "cws_0123456789abcdef";

function catalog(): WorkspaceCatalog {
  return {
    version: 1,
    nodeId: "nod_0123456789abcdef",
    organizationId: "org_1111111111111111",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    workspaces: [
      {
        workspaceUid: WORKSPACE_UID,
        localWorkspaceId: "ws-1",
        ownerPrincipalId: OWNER,
        members: [{ principalId: OWNER, role: "owner" }],
        state: "active",
        cachedAt: "2026-09-17T00:00:00.000Z",
        remoteMissingAt: null,
      },
    ],
  };
}

describe("collab timeline control", () => {
  test("returns the session document for a collaborating Workspace", () => {
    const document = {
      epoch: "ep1",
      rows: {
        "ep1/000000000001": {
          seq: 1,
          timestamp: "2026-09-18T00:00:00.000Z",
          item: { type: "user_message", text: "hi" },
        },
      },
      stream: { turnId: null, text: "" },
    };
    const control = createCollabTimelineControl({
      catalog: { current: () => catalog() },
      read: (workspaceUid, localWorkspaceId, agentId) => {
        expect(workspaceUid).toBe(WORKSPACE_UID);
        expect(localWorkspaceId).toBe("ws-1");
        expect(agentId).toBe("agent-1");
        return document;
      },
    });

    expect(control.get("ws-1", "agent-1")).toEqual(document);
  });

  test("an unknown Workspace has no collaborative timeline", () => {
    const control = createCollabTimelineControl({
      catalog: { current: () => catalog() },
      read: () => null,
    });

    expect(() => control.get("missing", "agent-1")).toThrow(COLLAB_TIMELINE_UNAVAILABLE);
  });
});
