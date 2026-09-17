import { describe, expect, test } from "vitest";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";
import { createCollabMembersControl } from "./members-control.js";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const EDITOR = "usr_bbbbbbbbbbbbbbbb";
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

describe("collab members control", () => {
  test("lists members for the local workspace id and names the viewer's role", () => {
    const control = createCollabMembersControl({
      catalog: { current: () => catalog() },
    });

    expect(control.list("ws-1", OWNER)).toEqual({
      workspaceUid: WORKSPACE_UID,
      viewerRole: "owner",
      revoked: false,
      revokeReason: null,
      members: [
        { principalId: OWNER, role: "owner" },
        { principalId: EDITOR, role: "editor" },
      ],
    });
  });

  test("an unknown workspace is empty rather than thrown", () => {
    const control = createCollabMembersControl({
      catalog: { current: () => catalog() },
    });

    expect(control.list("missing", OWNER)).toEqual({
      workspaceUid: null,
      viewerRole: null,
      revoked: false,
      revokeReason: null,
      members: [],
    });
  });

  test("a Principal no longer in the members list is revoked", () => {
    const snapshot = catalog();
    const workspace = snapshot.workspaces[0]!;
    const control = createCollabMembersControl({
      catalog: {
        current: () => ({
          ...snapshot,
          workspaces: [{ ...workspace, members: [{ principalId: OWNER, role: "owner" }] }],
        }),
      },
    });

    expect(control.list("ws-1", EDITOR)).toMatchObject({
      revoked: true,
      revokeReason: "membership_removed",
      viewerRole: null,
    });
  });

  test("a member on a remote_missing Workspace is revoked, the owner is not", () => {
    const snapshot = catalog();
    const workspace = snapshot.workspaces[0]!;
    const control = createCollabMembersControl({
      catalog: {
        current: () => ({
          ...snapshot,
          workspaces: [{ ...workspace, state: "remote_missing" }],
        }),
      },
    });

    expect(control.list("ws-1", EDITOR)).toMatchObject({
      revoked: true,
      revokeReason: "remote_missing",
    });
    expect(control.list("ws-1", OWNER)).toMatchObject({
      revoked: false,
      revokeReason: null,
    });
  });
});
