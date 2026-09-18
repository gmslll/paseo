import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { PRESENCE_TTL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const START = Date.parse("2026-09-16T00:00:00.000Z");

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  memberToken: string;
  memberPrincipalId: string;
  ownerToken: string;
  workspaceUid: string;
  advance: (ms: number) => void;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  let now = START;
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Presence test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-presence-tests",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
    clock: { nowMs: () => now },
  });
  cleanups.push(() => plane.close());
  const server: Server = createServer(
    createManagementRequestHandler(plane, { allowInsecureLoopback: true }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-presence-tests",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const ownerPrincipal = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const memberPrincipal = await plane.createPrincipal(admin, {
    displayName: "Member",
    principalType: "human",
    role: "employee",
  });
  const ownerCredential = await plane.issuePersonalAccessToken(admin, ownerPrincipal.principalId);
  const credential = await plane.issuePersonalAccessToken(admin, memberPrincipal.principalId);
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_presence",
    ownerPrincipalId: ownerPrincipal.principalId,
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

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    memberToken: credential.token,
    memberPrincipalId: memberPrincipal.principalId,
    ownerToken: ownerCredential.token,
    workspaceUid: workspace.workspaceUid,
    advance: (ms) => {
      now += ms;
    },
  };
}

function heartbeat(harness: Harness, bearer: string, body: unknown): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/presence`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("collaboration presence", () => {
  test("records a heartbeat and answers 204", async () => {
    const harness = await start();

    const response = await heartbeat(harness, harness.memberToken, {
      clientId: "desktop-1",
      focusAgentId: null,
    });

    expect(response.status).toBe(204);
    const entries = harness.plane.readCollabPresence(harness.workspaceUid);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "principal",
      principalId: harness.memberPrincipalId,
      clientId: "desktop-1",
      focusAgentId: null,
    });
  });

  test("counts one principal's two clients separately", async () => {
    const harness = await start();

    await heartbeat(harness, harness.memberToken, { clientId: "laptop", focusAgentId: null });
    await heartbeat(harness, harness.memberToken, { clientId: "phone", focusAgentId: "agent-1" });

    const entries = harness.plane.readCollabPresence(harness.workspaceUid);
    expect(entries).toHaveLength(2);
    expect(
      entries.map((entry) => (entry.kind === "principal" ? entry.clientId : "")).sort(),
    ).toEqual(["laptop", "phone"]);
  });

  test("a later heartbeat replaces the same client rather than adding one", async () => {
    const harness = await start();
    await heartbeat(harness, harness.memberToken, { clientId: "desktop-1", focusAgentId: null });
    harness.advance(1_000);
    await heartbeat(harness, harness.memberToken, {
      clientId: "desktop-1",
      focusAgentId: "agent-7",
    });

    const entries = harness.plane.readCollabPresence(harness.workspaceUid);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ focusAgentId: "agent-7" });
  });

  test("drops an entry once its TTL passes", async () => {
    const harness = await start();
    await heartbeat(harness, harness.memberToken, { clientId: "desktop-1", focusAgentId: null });
    expect(harness.plane.readCollabPresence(harness.workspaceUid)).toHaveLength(1);

    harness.advance(PRESENCE_TTL_MS + 1);

    // Expiry is lazy, so the read is what collects it. Nothing here waits ninety seconds: the plane
    // takes its clock from the caller.
    expect(harness.plane.readCollabPresence(harness.workspaceUid)).toHaveLength(0);
  });

  test("refuses a heartbeat from someone who is not a member", async () => {
    const harness = await start();
    const stranger = await harness.plane.createPrincipal(harness.admin, {
      displayName: "Stranger",
      principalType: "human",
      role: "employee",
    });
    const credential = await harness.plane.issuePersonalAccessToken(
      harness.admin,
      stranger.principalId,
    );

    const response = await heartbeat(harness, credential.token, {
      clientId: "desktop-1",
      focusAgentId: null,
    });

    expect(response.status).toBe(403);
    expect(harness.plane.readCollabPresence(harness.workspaceUid)).toHaveLength(0);
  });

  test("refuses a heartbeat that tries to name its own principal or timestamp", async () => {
    const harness = await start();

    // The schema is strict precisely so these cannot be supplied: one would forge another member's
    // presence, the other would let a client outlive its TTL.
    const forged = await heartbeat(harness, harness.memberToken, {
      clientId: "desktop-1",
      focusAgentId: null,
      principalId: "usr_fedcba9876543210",
      heartbeatAt: "2030-01-01T00:00:00.000Z",
    });

    expect(forged.status).toBe(400);
    expect(harness.plane.readCollabPresence(harness.workspaceUid)).toHaveLength(0);
  });

  test("shows the same list to every member of the container", async () => {
    const harness = await start();
    await heartbeat(harness, harness.memberToken, { clientId: "desktop-1", focusAgentId: null });
    await heartbeat(harness, harness.ownerToken, { clientId: "desktop-2", focusAgentId: null });

    // Presence says who is here; it is not an authorization input and does not vary by reader.
    const entries = harness.plane.readCollabPresence(harness.workspaceUid);
    expect(entries).toHaveLength(2);
  });
});
