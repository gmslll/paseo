import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";
import { signNodeRequest } from "../security.js";

const ORG = "org_0123456789abcdef";
const LOCAL_WORKSPACE = "wks_enable_one";

interface EnrolledNode {
  nodeId: string;
  privateKey: KeyObject;
}

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  ownerPrincipalId: string;
  memberPrincipalId: string;
  node: EnrolledNode;
  base: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
let nonceCounter = 0;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function nextNonce(): string {
  nonceCounter += 1;
  return `node_nonce_${String(nonceCounter).padStart(16, "0")}`;
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Owned enable test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-owned-enable",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
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
    bootstrapSecret: "bootstrap-secret-for-owned-enable",
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
  const node = await enroll(plane, admin, "server-enable", { collaborationV1: true });

  return {
    plane,
    admin,
    ownerPrincipalId: owner.principalId,
    memberPrincipalId: member.principalId,
    node,
    base: `http://127.0.0.1:${address.port}`,
  };
}

async function enroll(
  plane: EnterpriseManagementPlane,
  admin: AuthenticatedManagementPrincipal,
  paseoServerId: string,
  capabilities: Record<string, string | number | boolean>,
): Promise<EnrolledNode> {
  const enrollment = await plane.createEnrollmentToken(admin, { expiresInMs: 60_000 });
  const keys = generateKeyPairSync("ed25519");
  const enrolled = await plane.enrollNode({
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
  return { nodeId: enrolled.node.nodeId, privateKey: keys.privateKey };
}

function nodePost(
  harness: Harness,
  path: string,
  body: unknown,
  node: EnrolledNode = harness.node,
): Promise<Response> {
  const payload = JSON.stringify(body);
  const authentication = signNodeRequest(node.privateKey, {
    nodeId: node.nodeId,
    method: "POST",
    path,
    timestampMs: Date.now(),
    nonce: nextNonce(),
    body: payload,
  });
  return fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paseo-node-id": authentication.nodeId,
      "x-paseo-node-timestamp": String(authentication.timestampMs),
      "x-paseo-node-nonce": authentication.nonce,
      "x-paseo-node-signature": authentication.signature,
    },
    body: payload,
  });
}

describe("owner-driven collaboration enable", () => {
  test("the owner registers, enables, and places a Workspace that was never collaborative", async () => {
    const harness = await start();

    const result = await harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });

    expect(result.workspace.workspaceUid).toMatch(/^cws_[0-9a-f]{16}$/);
    expect(result.workspace.localWorkspaceId).toBe(LOCAL_WORKSPACE);
    expect(result.workspace.ownerPrincipalId).toBe(harness.ownerPrincipalId);
    expect(result.workspace.collaborationEnabled).toBe(true);
    expect(result.members).toEqual([{ principalId: harness.ownerPrincipalId, role: "owner" }]);
    expect(harness.plane.readNodeWorkspaceMemberships(harness.node.nodeId)).toEqual([
      {
        workspaceUid: result.workspace.workspaceUid,
        localWorkspaceId: LOCAL_WORKSPACE,
        ownerPrincipalId: harness.ownerPrincipalId,
        membershipVersion: 1,
        members: [{ principalId: harness.ownerPrincipalId, role: "owner" }],
      },
    ]);
  });

  test("enabling an already-enabled Workspace is idempotent", async () => {
    const harness = await start();
    const first = await harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });

    const second = await harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });

    expect(second.workspace.workspaceUid).toBe(first.workspace.workspaceUid);
    expect(second.workspace.collaborationEnabled).toBe(true);
    expect(second.members).toEqual(first.members);
  });

  test("a registered Workspace with collaboration off is turned on by its owner", async () => {
    const harness = await start();
    const registered = await harness.plane.registerCollabWorkspace(harness.admin, {
      localWorkspaceId: LOCAL_WORKSPACE,
      ownerPrincipalId: harness.ownerPrincipalId,
    });
    expect(registered.collaborationEnabled).toBe(false);

    const enabled = await harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });

    expect(enabled.workspace.workspaceUid).toBe(registered.workspaceUid);
    expect(enabled.workspace.collaborationEnabled).toBe(true);
  });

  test("a non-owner cannot enable collaboration", async () => {
    const harness = await start();
    await harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });

    await expect(
      harness.plane.enableOwnedCollabWorkspace(harness.node.nodeId, {
        actorPrincipalId: harness.memberPrincipalId,
        localWorkspaceId: LOCAL_WORKSPACE,
      }),
    ).rejects.toThrow("only the workspace owner can enable collaboration");
  });

  test("a node without collaborationV1 cannot enable a Workspace", async () => {
    const harness = await start();
    const oldNode = await enroll(harness.plane, harness.admin, "server-old", {});

    await expect(
      harness.plane.enableOwnedCollabWorkspace(oldNode.nodeId, {
        actorPrincipalId: harness.ownerPrincipalId,
        localWorkspaceId: LOCAL_WORKSPACE,
      }),
    ).rejects.toThrow("collaboration is not available on this node");
  });

  test("POST /v1/node/collab/enable is the node-signed owner path", async () => {
    const harness = await start();

    const response = await nodePost(harness, "/v1/node/collab/enable", {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workspaceUid: string;
      collaborationEnabled: boolean;
      members: { principalId: string; role: string }[];
    };
    expect(body.workspaceUid).toMatch(/^cws_[0-9a-f]{16}$/);
    expect(body.collaborationEnabled).toBe(true);
    expect(body.members).toEqual([{ principalId: harness.ownerPrincipalId, role: "owner" }]);

    const denied = await nodePost(harness, "/v1/node/collab/enable", {
      actorPrincipalId: harness.memberPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });
    expect(denied.status).toBe(400);
  });

  test("POST /v1/node/collab/stream-token mints a token for a member on this node", async () => {
    const harness = await start();
    const enabled = await nodePost(harness, "/v1/node/collab/enable", {
      actorPrincipalId: harness.ownerPrincipalId,
      localWorkspaceId: LOCAL_WORKSPACE,
    });
    expect(enabled.status).toBe(200);
    const { workspaceUid } = (await enabled.json()) as { workspaceUid: string };

    const issued = await nodePost(harness, "/v1/node/collab/stream-token", {
      actorPrincipalId: harness.ownerPrincipalId,
      clientId: "client-1",
      workspaceUid,
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { token: string; expiresAt: string };
    expect(body.token.startsWith("pst_v1.")).toBe(true);

    const refused = await nodePost(harness, "/v1/node/collab/stream-token", {
      actorPrincipalId: harness.memberPrincipalId,
      clientId: "client-1",
      workspaceUid,
    });
    expect(refused.status).toBe(403);
  });
});
