import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import { STREAM_TOKEN_TTL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { EnterpriseManagementPlane } from "../management-plane.js";
import { verifyStreamToken } from "./stream-token.js";

const ORG = "org_0123456789abcdef";
const START = Date.parse("2026-09-16T00:00:00.000Z");

async function createPlane() {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Stream token test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-token",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
    clock: { nowMs: () => START },
  });
  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-stream-token",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  async function employee(displayName: string) {
    const principal = await plane.createPrincipal(admin, {
      displayName,
      principalType: "human",
      role: "employee",
    });
    const credential = await plane.issuePersonalAccessToken(admin, principal.principalId);
    return { principalId: principal.principalId, token: credential.token };
  }
  return { plane, admin, ticketKeys, employee };
}

describe("issuing collaboration stream tokens", () => {
  test("names every enabled container the caller belongs to, and no others", async () => {
    const { plane, admin, ticketKeys, employee } = await createPlane();
    const owner = await employee("Owner");
    const member = await employee("Member");

    const joined = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: "wks_joined",
      ownerPrincipalId: owner.principalId,
    });
    const other = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: "wks_other",
      ownerPrincipalId: owner.principalId,
    });
    for (const workspace of [joined, other]) {
      await plane.setCollabCollaboration(admin, {
        workspaceUid: workspace.workspaceUid,
        enabled: true,
      });
    }
    await plane.setCollabMember(admin, {
      workspaceUid: joined.workspaceUid,
      principalId: member.principalId,
      role: "editor",
    });

    const issued = await plane.issueStreamToken(member.token, { clientId: "desktop-1" });

    const claims = verifyStreamToken(issued.token, ticketKeys.publicKey, {
      nowMs: START,
      containerId: joined.workspaceUid,
      organizationId: ORG,
    });
    expect(claims.containerIds).toEqual([joined.workspaceUid]);
    expect(claims.principalId).toBe(member.principalId);
    // The Workspace the caller is not a member of must not appear, even though it is enabled.
    expect(() =>
      verifyStreamToken(issued.token, ticketKeys.publicKey, {
        nowMs: START,
        containerId: other.workspaceUid,
        organizationId: ORG,
      }),
    ).toThrow("stream token audience mismatch");
  });

  test("omits a Workspace whose collaboration is off", async () => {
    const { plane, admin, employee } = await createPlane();
    const owner = await employee("Owner");
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: "wks_disabled",
      ownerPrincipalId: owner.principalId,
    });

    // Registered and owned, but collaboration was never switched on (ADR-0031).
    await expect(plane.issueStreamToken(owner.token, { clientId: "desktop-1" })).rejects.toThrow(
      "no collaborative workspaces",
    );

    await plane.setCollabCollaboration(admin, {
      workspaceUid: workspace.workspaceUid,
      enabled: true,
    });
    const issued = await plane.issueStreamToken(owner.token, { clientId: "desktop-1" });
    expect(issued.expiresAt).toBe(new Date(START + STREAM_TOKEN_TTL_MS).toISOString());
  });

  test("refuses a caller with no membership at all and an invalid credential", async () => {
    const { plane, employee } = await createPlane();
    const stranger = await employee("Stranger");

    await expect(plane.issueStreamToken(stranger.token, { clientId: "desktop-1" })).rejects.toThrow(
      "no collaborative workspaces",
    );
    await expect(
      plane.issueStreamToken("pat_not_a_token", { clientId: "desktop-1" }),
    ).rejects.toThrow("invalid credential");
  });

  test("carries the caller's current grant version and revocation epoch", async () => {
    const { plane, admin, ticketKeys, employee } = await createPlane();
    const owner = await employee("Owner");
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId: "wks_versioned",
      ownerPrincipalId: owner.principalId,
    });
    await plane.setCollabCollaboration(admin, {
      workspaceUid: workspace.workspaceUid,
      enabled: true,
    });

    const issued = await plane.issueStreamToken(owner.token, { clientId: "desktop-1" });
    const claims = verifyStreamToken(issued.token, ticketKeys.publicKey, {
      nowMs: START,
      containerId: workspace.workspaceUid,
      organizationId: ORG,
    });

    const principals = await plane.listPrincipals(admin);
    const current = principals.find((entry) => entry.principalId === owner.principalId)!;
    // A stream token pins the authority it was minted under, so a membership change invalidates it
    // through the same version the Session path already checks.
    expect(claims.grantVersion).toBe(current.grantVersion);
    expect(claims.revocationEpoch).toBe(current.revocationEpoch);
  });
});
