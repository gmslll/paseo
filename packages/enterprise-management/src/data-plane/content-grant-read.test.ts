import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import {
  EnterpriseManagementPlane,
  PLANE_AUDIT_NODE_ID,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  member: AuthenticatedManagementPrincipal;
  boss: AuthenticatedManagementPrincipal;
  bossPrincipalId: string;
  workspaceUid: string;
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
    organizationName: "Content grant read test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-content-grant",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-content-grant",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const memberPrincipal = await plane.createPrincipal(admin, {
    displayName: "Member",
    principalType: "human",
    role: "employee",
  });
  const bossPrincipal = await plane.createPrincipal(admin, {
    displayName: "Boss",
    principalType: "human",
    role: "boss",
  });
  const memberCredential = await plane.issuePersonalAccessToken(admin, memberPrincipal.principalId);
  const bossCredential = await plane.issuePersonalAccessToken(admin, bossPrincipal.principalId);

  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_content_grant",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: memberPrincipal.principalId,
    role: "editor",
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });

  const member = (await plane.authenticatePersonalAccessToken(memberCredential.token))!;
  const boss = (await plane.authenticatePersonalAccessToken(bossCredential.token))!;
  await plane.appendCollabStream(member, {
    containerId: workspace.workspaceUid,
    segment: "meta",
    producerId: "prod-a",
    producerEpoch: 1,
    producerSeq: 1,
    update: new TextEncoder().encode("body"),
  });

  return {
    plane,
    admin,
    member,
    boss,
    bossPrincipalId: bossPrincipal.principalId,
    workspaceUid: workspace.workspaceUid,
  };
}

/** Adds a content Grant scoped to this container, keeping whatever the boss preset already had. */
async function grantContentRead(harness: Harness): Promise<AuthenticatedManagementPrincipal> {
  const current = (await harness.plane.listPrincipals(harness.admin)).find(
    (entry) => entry.principalId === harness.bossPrincipalId,
  )!;
  await harness.plane.replaceGrants(harness.admin, harness.bossPrincipalId, {
    expectedGrantVersion: current.grantVersion,
    grants: [
      ...current.grants,
      {
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [harness.workspaceUid] },
      },
    ],
  });
  const credential = await harness.plane.issuePersonalAccessToken(
    harness.admin,
    harness.bossPrincipalId,
  );
  return (await harness.plane.authenticatePersonalAccessToken(credential.token))!;
}

describe("reading collaborative bodies on a content Grant", () => {
  test("refuses a Boss who holds no content Grant", async () => {
    const harness = await start();

    // The boss preset carries workspace.metadata.read and audit.read, never content.read, and the
    // refusal is worded exactly as a stranger's so the two cannot be told apart.
    await expect(
      harness.plane.readCollabStream(harness.boss, {
        containerId: harness.workspaceUid,
        segment: "meta",
      }),
    ).rejects.toThrow("stream authorization denied");
  });

  test("serves a Boss who holds one, and records it", async () => {
    const harness = await start();
    const boss = await grantContentRead(harness);

    const read = await harness.plane.readCollabStream(boss, {
      containerId: harness.workspaceUid,
      segment: "meta",
    });

    expect(read.messages).toHaveLength(1);
    const events = (await harness.plane.listAudit(harness.admin, 500)).filter(
      (event) => event.action === "collab.content.read",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      nodeId: PLANE_AUDIT_NODE_ID,
      actorPrincipalId: harness.bossPrincipalId,
      resourceId: harness.workspaceUid,
    });
    // ADR-0037: identifiers only. The segment names what was opened, never what it held.
    expect(events[0]!.metadata).toEqual({ segment: "meta" });
  });

  test("never lets a content Grant write", async () => {
    const harness = await start();
    const boss = await grantContentRead(harness);

    // Reading bodies is not permission to change them; appends stay members-only.
    await expect(
      harness.plane.appendCollabStream(boss, {
        containerId: harness.workspaceUid,
        segment: "meta",
        producerId: "prod-boss",
        producerEpoch: 1,
        producerSeq: 1,
        update: new TextEncoder().encode("written by a reader"),
      }),
    ).rejects.toThrow("stream authorization denied");
  });

  test("does not audit a member's ordinary read", async () => {
    const harness = await start();

    await harness.plane.readCollabStream(harness.member, {
      containerId: harness.workspaceUid,
      segment: "meta",
    });

    // ADR-0037 makes the non-member content read `required`, not every read. Auditing members too
    // would bury the events that matter under ordinary traffic.
    const events = (await harness.plane.listAudit(harness.admin, 500)).filter(
      (event) => event.action === "collab.content.read",
    );
    expect(events).toHaveLength(0);
  });

  test("refuses once collaboration is switched off, Grant or not", async () => {
    const harness = await start();
    const boss = await grantContentRead(harness);
    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: harness.workspaceUid,
      enabled: false,
    });

    // ADR-0031 keeps an unenabled Workspace off the plane entirely; a content Grant does not
    // reach past that.
    await expect(
      harness.plane.readCollabStream(boss, {
        containerId: harness.workspaceUid,
        segment: "meta",
      }),
    ).rejects.toThrow("stream authorization denied");
  });
});
