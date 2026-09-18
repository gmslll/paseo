import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { ManagedNodePolicyResponseSchema } from "@getpaseo/protocol/enterprise-management";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  memberPrincipalId: string;
  ownerPrincipalId: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Node membership policy test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-node-membership",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-node-membership",
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

  return {
    plane,
    admin,
    memberPrincipalId: member.principalId,
    ownerPrincipalId: owner.principalId,
  };
}

async function enroll(
  harness: Harness,
  paseoServerId: string,
  capabilities: Record<string, string | number | boolean>,
): Promise<string> {
  const enrollment = await harness.plane.createEnrollmentToken(harness.admin, {
    expiresInMs: 60_000,
  });
  const keys = generateKeyPairSync("ed25519");
  const enrolled = await harness.plane.enrollNode({
    token: enrollment.token,
    paseoServerId,
    endpoint: `wss://${paseoServerId}.test:6767`,
    bootId: `boot-${paseoServerId}`,
    version: "0.8.0",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    capabilities,
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 12_000_000_000,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  });
  return enrolled.node.nodeId;
}

async function placeWorkspace(
  harness: Harness,
  nodeId: string,
  localWorkspaceId: string,
): Promise<string> {
  const workspace = await harness.plane.registerCollabWorkspace(harness.admin, {
    localWorkspaceId,
    ownerPrincipalId: harness.ownerPrincipalId,
  });
  await harness.plane.setCollabCollaboration(harness.admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  await harness.plane.registerPlacement(nodeId, {
    organizationId: ORG,
    nodeId,
    resourceKind: "workspace",
    localResourceId: localWorkspaceId,
    ownerPrincipalId: harness.ownerPrincipalId,
  });
  return workspace.workspaceUid;
}

describe("workspace memberships in the node policy", () => {
  test("sends nothing at all to a node that does not declare collaborationV1", async () => {
    const harness = await start();
    const nodeId = await enroll(harness, "server-old", {});
    await placeWorkspace(harness, nodeId, "wks_old");

    expect(harness.plane.readNodeWorkspaceMemberships(nodeId)).toBeNull();
  });

  test("a policy for an older node still parses against the strict schema", async () => {
    const harness = await start();
    const nodeId = await enroll(harness, "server-old", {});
    await placeWorkspace(harness, nodeId, "wks_old");

    const memberships = harness.plane.readNodeWorkspaceMemberships(nodeId);
    const payload = {
      principals: harness.plane.getNodePolicy(nodeId),
      ...(memberships ? { workspaceMemberships: memberships } : {}),
    };

    // The key has to be absent rather than empty: the response object is strict, so an older node
    // would reject `workspaceMemberships: []` exactly as it rejects a populated one.
    expect("workspaceMemberships" in payload).toBe(false);
    expect(() => ManagedNodePolicyResponseSchema.parse(payload)).not.toThrow();
  });

  test("carries the placed Workspaces and their members to a collaborating node", async () => {
    const harness = await start();
    const nodeId = await enroll(harness, "server-new", { collaborationV1: true });
    const workspaceUid = await placeWorkspace(harness, nodeId, "wks_new");
    await harness.plane.setCollabMember(harness.admin, {
      workspaceUid,
      principalId: harness.memberPrincipalId,
      role: "editor",
    });

    const memberships = harness.plane.readNodeWorkspaceMemberships(nodeId);

    expect(memberships).toHaveLength(1);
    expect(memberships![0]).toMatchObject({
      workspaceUid,
      localWorkspaceId: "wks_new",
      ownerPrincipalId: harness.ownerPrincipalId,
    });
    const roles = memberships![0]!.members.map((entry) => entry.role).sort();
    expect(roles).toEqual(["editor", "owner"]);
  });

  test("tells a node only about the Workspaces placed on it", async () => {
    const harness = await start();
    const mine = await enroll(harness, "server-mine", { collaborationV1: true });
    const theirs = await enroll(harness, "server-theirs", { collaborationV1: true });
    await placeWorkspace(harness, mine, "wks_mine");
    await placeWorkspace(harness, theirs, "wks_theirs");

    // One node's policy must never disclose another's tenants.
    expect(
      harness.plane.readNodeWorkspaceMemberships(mine)!.map((entry) => entry.localWorkspaceId),
    ).toEqual(["wks_mine"]);
    expect(
      harness.plane.readNodeWorkspaceMemberships(theirs)!.map((entry) => entry.localWorkspaceId),
    ).toEqual(["wks_theirs"]);
  });

  test("omits a Workspace whose collaboration is switched off", async () => {
    const harness = await start();
    const nodeId = await enroll(harness, "server-new", { collaborationV1: true });
    const workspaceUid = await placeWorkspace(harness, nodeId, "wks_new");
    await harness.plane.setCollabCollaboration(harness.admin, { workspaceUid, enabled: false });

    // ADR-0031 keeps a Workspace without collaboration off the plane entirely, so a node has no
    // reason to hear about its membership.
    expect(harness.plane.readNodeWorkspaceMemberships(nodeId)).toEqual([]);
  });
});
