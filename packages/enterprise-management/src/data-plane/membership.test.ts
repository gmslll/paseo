import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import { WORKSPACE_MEMBER_ROLE_ACTIONS } from "@getpaseo/protocol/enterprise-collaboration";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const LOCAL_WORKSPACE = "wks_local_one";

interface Fixture {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  ownerId: string;
  memberId: string;
}

async function createFixture(): Promise<Fixture> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Membership test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-membership",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-membership",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const member = await plane.createPrincipal(admin, {
    displayName: "Member",
    principalType: "human",
    role: "employee",
  });
  return { plane, admin, ownerId: owner.principalId, memberId: member.principalId };
}

async function readPrincipal(
  plane: EnterpriseManagementPlane,
  actor: AuthenticatedManagementPrincipal,
  principalId: string,
) {
  const principals = await plane.listPrincipals(actor);
  const principal = principals.find((candidate) => candidate.principalId === principalId);
  if (!principal) throw new Error(`principal ${principalId} is missing`);
  return principal;
}

function workspaceActions(grants: readonly { action: string; selector: unknown }[], uid: string) {
  return grants
    .filter((grant) => {
      const selector = grant.selector as { kind: string; workspaceIds?: string[] };
      return selector.kind === "workspace" && selector.workspaceIds?.includes(uid) === true;
    })
    .map((grant) => grant.action)
    .sort();
}

describe("collaboration membership", () => {
  test("registers a collaborative Workspace with one owner and collaboration off", async () => {
    const { plane, admin, ownerId } = await createFixture();

    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: ownerId,
    });

    expect(workspace.workspaceUid).toMatch(/^cws_[0-9a-f]{16}$/);
    expect(workspace.ownerPrincipalId).toBe(ownerId);
    // ADR-0031: collaboration is enabled per Workspace by its owner and is off by default.
    expect(workspace.collaborationEnabled).toBe(false);
  });

  test("projects each role onto the frozen actions with a workspace selector", async () => {
    const { plane, admin, ownerId, memberId } = await createFixture();
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: ownerId,
    });

    // A member moves between the non-owner roles; the owner role belongs to the registering owner.
    for (const role of ["viewer", "editor"] as const) {
      await plane.setCollabMember(admin, {
        workspaceUid: workspace.workspaceUid,
        principalId: memberId,
        role,
      });
      const principal = await readPrincipal(plane, admin, memberId);
      expect(workspaceActions(principal.grants, workspace.workspaceUid)).toEqual(
        [...WORKSPACE_MEMBER_ROLE_ACTIONS[role]].sort(),
      );
    }

    const owner = await readPrincipal(plane, admin, ownerId);
    expect(workspaceActions(owner.grants, workspace.workspaceUid)).toEqual(
      [...WORKSPACE_MEMBER_ROLE_ACTIONS.owner].sort(),
    );
  });

  test("increments the member's Grant version so existing sessions stop being current", async () => {
    const { plane, admin, ownerId, memberId } = await createFixture();
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: ownerId,
    });
    const before = await readPrincipal(plane, admin, memberId);

    await plane.setCollabMember(admin, {
      workspaceUid: workspace.workspaceUid,
      principalId: memberId,
      role: "editor",
    });

    const after = await readPrincipal(plane, admin, memberId);
    // ADR-0033 reuses the existing Session invalidation path rather than adding one.
    expect(after.grantVersion).not.toBe(before.grantVersion);
    expect(after.revocationEpoch).toBe(before.revocationEpoch + 1);
  });

  test("removing a member withdraws only that Workspace's grants", async () => {
    const { plane, admin, ownerId, memberId } = await createFixture();
    const first = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: ownerId,
    });
    const second = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: "wks_local_two",
      ownerPrincipalId: ownerId,
    });
    await plane.setCollabMember(admin, {
      workspaceUid: first.workspaceUid,
      principalId: memberId,
      role: "editor",
    });
    await plane.setCollabMember(admin, {
      workspaceUid: second.workspaceUid,
      principalId: memberId,
      role: "viewer",
    });

    await plane.removeCollabMember(admin, {
      workspaceUid: first.workspaceUid,
      principalId: memberId,
    });

    const principal = await readPrincipal(plane, admin, memberId);
    expect(workspaceActions(principal.grants, first.workspaceUid)).toEqual([]);
    expect(workspaceActions(principal.grants, second.workspaceUid)).toEqual(
      [...WORKSPACE_MEMBER_ROLE_ACTIONS.viewer].sort(),
    );
  });

  test("lists members with the owner included and refuses a second owner row", async () => {
    const { plane, admin, ownerId, memberId } = await createFixture();
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: ownerId,
    });
    await plane.setCollabMember(admin, {
      workspaceUid: workspace.workspaceUid,
      principalId: memberId,
      role: "editor",
    });

    const members = await plane.listCollabMembers(admin, workspace.workspaceUid);

    expect(members).toEqual([
      { principalId: ownerId, role: "owner" },
      { principalId: memberId, role: "editor" },
    ]);
    // ADR-0033 keeps exactly one owner, so a second owner row is refused outright.
    await expect(
      plane.setCollabMember(admin, {
        workspaceUid: workspace.workspaceUid,
        principalId: memberId,
        role: "owner",
      }),
    ).rejects.toThrow("workspace already has an owner");
  });
});
