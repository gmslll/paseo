import { describe, expect, test } from "vitest";
import type { WorkspaceMembershipPolicy } from "@getpaseo/protocol/enterprise-collaboration";
import { normalizeResourceGrants, type ResourceGrant } from "@getpaseo/protocol/messages";
import { bindCollabGrantsToLocalWorkspaces } from "./local-workspace-grants.js";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const EDITOR = "usr_bbbbbbbbbbbbbbbb";
const WORKSPACE_UID = "cws_0123456789abcdef";
const OTHER_UID = "cws_fedcba9876543210";
const LOCAL_WORKSPACE = "ws-1";

function memberships(): WorkspaceMembershipPolicy[] {
  return [
    {
      workspaceUid: WORKSPACE_UID,
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: OWNER,
      membershipVersion: 2,
      members: [
        { principalId: OWNER, role: "owner" },
        { principalId: EDITOR, role: "editor" },
      ],
    },
  ];
}

function workspaceGrant(workspaceIds: string[]): ResourceGrant {
  return {
    action: "workspace.metadata.read",
    selector: { kind: "workspace", workspaceIds },
  };
}

describe("collab grants on a hosting node", () => {
  test("a member grant for the collab uid authorizes the local Workspace this node hosts", () => {
    const grants = [workspaceGrant([WORKSPACE_UID])];

    expect(bindCollabGrantsToLocalWorkspaces(grants, memberships())).toEqual(
      normalizeResourceGrants([workspaceGrant([WORKSPACE_UID, LOCAL_WORKSPACE])]),
    );
  });

  test("an editor's write grant is bound the same way as metadata.read", () => {
    const grants: ResourceGrant[] = [
      {
        action: "workspace.metadata.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_UID] },
      },
      {
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_UID] },
      },
      { action: "workspace.write", selector: { kind: "workspace", workspaceIds: [WORKSPACE_UID] } },
    ];
    const localIds = [WORKSPACE_UID, LOCAL_WORKSPACE];

    expect(bindCollabGrantsToLocalWorkspaces(grants, memberships())).toEqual(
      normalizeResourceGrants([
        {
          action: "workspace.metadata.read",
          selector: { kind: "workspace", workspaceIds: localIds },
        },
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: localIds },
        },
        { action: "workspace.write", selector: { kind: "workspace", workspaceIds: localIds } },
      ]),
    );
  });

  test("a collab uid this node does not host stays as the plane sent it", () => {
    const grants = [workspaceGrant([OTHER_UID])];

    expect(bindCollabGrantsToLocalWorkspaces(grants, memberships())).toBe(grants);
  });

  test("a node without collaboration leaves grants untouched", () => {
    const grants = [workspaceGrant([WORKSPACE_UID])];

    expect(bindCollabGrantsToLocalWorkspaces(grants, null)).toBe(grants);
  });
});
