import { describe, expect, test } from "vitest";
import { createCollabMembersControl } from "./members-control.js";
import { handleCollabMembersRequest } from "./members-session.js";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const EDITOR = "usr_bbbbbbbbbbbbbbbb";

function catalog(): WorkspaceCatalog {
  return {
    version: 1,
    nodeId: "nod_0123456789abcdef",
    organizationId: "org_1111111111111111",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    workspaces: [
      {
        workspaceUid: "cws_0123456789abcdef",
        localWorkspaceId: "ws-1",
        ownerPrincipalId: OWNER,
        members: [
          { principalId: OWNER, role: "owner" },
          { principalId: EDITOR, role: "editor" },
        ],
        state: "active",
        cachedAt: "2026-09-17T00:00:00.000Z",
        remoteMissingAt: null,
      },
    ],
  };
}

describe("collab members session", () => {
  test("list returns the catalog members for that workspace", async () => {
    const response = await handleCollabMembersRequest(
      createCollabMembersControl({ catalog: { current: () => catalog() } }),
      { type: "collab.members.list.request", requestId: "r1", workspaceId: "ws-1" },
      OWNER,
    );

    expect(response).toMatchObject({
      type: "collab.members.list.response",
      payload: {
        requestId: "r1",
        workspaceId: "ws-1",
        workspaceUid: "cws_0123456789abcdef",
        viewerRole: "owner",
        revoked: false,
        collaborationEnabled: true,
        canEnable: false,
      },
    });
  });

  test("enable returns the owner membership for a local Workspace", async () => {
    const response = await handleCollabMembersRequest(
      createCollabMembersControl({
        catalog: { current: () => catalog() },
        mutator: {
          async setMember() {
            throw new Error("unused");
          },
          async removeMember() {
            throw new Error("unused");
          },
          async enableWorkspace() {
            return {
              workspaceUid: "cws_0123456789abcdef",
              members: [{ principalId: OWNER, role: "owner" }],
            };
          },
        },
      }),
      { type: "collab.workspace.enable.request", requestId: "r2", workspaceId: "ws-local" },
      OWNER,
      OWNER,
    );

    expect(response).toEqual({
      type: "collab.workspace.enable.response",
      payload: {
        requestId: "r2",
        workspaceId: "ws-local",
        workspaceUid: "cws_0123456789abcdef",
        viewerRole: "owner",
        members: [{ principalId: OWNER, role: "owner" }],
      },
    });
  });
});
