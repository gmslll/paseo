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

interface EnrolledNode {
  nodeId: string;
  privateKey: KeyObject;
}

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  memberToken: string;
  node: EnrolledNode;
  containerId: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
let nonceCounter = 0;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Matches the protocol's nonce pattern and is unique per call: the plane stores each one once. */
function nextNonce(): string {
  nonceCounter += 1;
  return `node_nonce_${String(nonceCounter).padStart(16, "0")}`;
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Node stream HTTP test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-node-stream-http",
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
    bootstrapSecret: "bootstrap-secret-for-node-stream-http",
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
  const credential = await plane.issuePersonalAccessToken(admin, member.principalId);

  const enrollment = await plane.createEnrollmentToken(admin, { expiresInMs: 60_000 });
  const nodeKeys = generateKeyPairSync("ed25519");
  const enrolled = await plane.enrollNode({
    token: enrollment.token,
    paseoServerId: "server-a",
    endpoint: "wss://server-a.test:6767",
    bootId: "boot-a",
    version: "0.8.0",
    publicKeyPem: nodeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    capabilities: { collaborationV1: true },
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 12_000_000_000,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  });

  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_http",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: member.principalId,
    role: "editor",
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  await plane.registerPlacement(enrolled.node.nodeId, {
    organizationId: ORG,
    nodeId: enrolled.node.nodeId,
    resourceKind: "workspace",
    localResourceId: "wks_http",
    ownerPrincipalId: owner.principalId,
  });

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    memberToken: credential.token,
    node: { nodeId: enrolled.node.nodeId, privateKey: nodeKeys.privateKey },
    containerId: workspace.workspaceUid,
  };
}

/**
 * Appends as a node. `signedBody` defaults to the bytes actually sent; a test that passes something
 * else is asking whether the signature really covers the payload.
 */
function nodeAppend(
  harness: Harness,
  input: {
    containerId?: string;
    segment: string;
    body: Uint8Array;
    signedBody?: Uint8Array;
    nonce?: string;
    seq?: number;
    node?: EnrolledNode;
  },
): Promise<Response> {
  const node = input.node ?? harness.node;
  const containerId = input.containerId ?? harness.containerId;
  const path = `/v1/ds/${containerId}/${input.segment}`;
  const authentication = signNodeRequest(node.privateKey, {
    nodeId: node.nodeId,
    method: "PUT",
    path,
    timestampMs: Date.now(),
    nonce: input.nonce ?? nextNonce(),
    body: Buffer.from(input.signedBody ?? input.body),
  });
  return fetch(`${harness.base}${path}`, {
    method: "PUT",
    headers: {
      "x-paseo-node-id": authentication.nodeId,
      "x-paseo-node-timestamp": String(authentication.timestampMs),
      "x-paseo-node-nonce": authentication.nonce,
      "x-paseo-node-signature": authentication.signature,
      "producer-id": `prod-${node.nodeId}`,
      "producer-epoch": "1",
      "producer-seq": String(input.seq ?? 1),
    },
    body: input.body,
  });
}

async function enrollSecondNode(harness: Harness): Promise<EnrolledNode> {
  const enrollment = await harness.plane.createEnrollmentToken(harness.admin, {
    expiresInMs: 60_000,
  });
  const keys = generateKeyPairSync("ed25519");
  const enrolled = await harness.plane.enrollNode({
    token: enrollment.token,
    paseoServerId: "server-b",
    endpoint: "wss://server-b.test:6767",
    bootId: "boot-b",
    version: "0.8.0",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    capabilities: { collaborationV1: true },
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

describe("a node on the stream routes", () => {
  test("writes a session segment with nothing but its request signature", async () => {
    const harness = await start();

    const response = await nodeAppend(harness, {
      segment: "s:agent-1",
      body: new TextEncoder().encode("timeline update"),
    });

    // No bearer token anywhere: the node authenticates the way it does on /v1/node/*, and its
    // authority over this container is that the Workspace is placed on it.
    expect(response.status).toBe(201);
    const stored = await harness.plane.readCollabStream(
      { kind: "node", node: (await harness.plane.listNodes(harness.admin))[0]! },
      { containerId: harness.containerId, segment: "s:agent-1" },
    );
    expect(stored.messages).toHaveLength(1);
  });

  test("refuses an append whose bytes are not the bytes it signed", async () => {
    const harness = await start();

    const response = await nodeAppend(harness, {
      segment: "s:agent-1",
      body: new TextEncoder().encode("what was sent"),
      signedBody: new TextEncoder().encode("what was signed"),
    });

    // The whole reason the body is read before the signature is checked: a signature that did not
    // cover the payload would let anything be substituted for it in transit.
    expect(response.status).toBe(401);
  });

  test("refuses a second use of the same nonce", async () => {
    const harness = await start();
    const nonce = nextNonce();
    const body = new TextEncoder().encode("first");

    expect((await nodeAppend(harness, { segment: "s:agent-1", body, nonce })).status).toBe(201);
    const replay = await nodeAppend(harness, { segment: "s:agent-1", body, nonce, seq: 2 });

    expect(replay.status).toBe(401);
  });

  test("refuses a node that does not host the Workspace", async () => {
    const harness = await start();
    const other = await enrollSecondNode(harness);

    const response = await nodeAppend(harness, {
      segment: "s:agent-1",
      body: new TextEncoder().encode("not mine"),
      node: other,
    });

    // Enrolled and correctly signed, so this is an authorization refusal rather than a credential
    // one: the Workspace is placed on the first node.
    expect(response.status).toBe(403);
  });

  test("refuses a node the segments that answer to membership", async () => {
    const harness = await start();

    const response = await nodeAppend(harness, {
      segment: "pc:preview-1",
      body: new TextEncoder().encode("comment"),
    });

    expect(response.status).toBe(403);
  });

  test("refuses a node on the presence route, which is for people", async () => {
    const harness = await start();
    const path = `/v1/ds/${harness.containerId}/presence`;
    const body = JSON.stringify({ clientId: "cli-1", focusAgentId: null });
    const authentication = signNodeRequest(harness.node.privateKey, {
      nodeId: harness.node.nodeId,
      method: "POST",
      path,
      timestampMs: Date.now(),
      nonce: nextNonce(),
      body,
    });

    const response = await fetch(`${harness.base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paseo-node-id": authentication.nodeId,
        "x-paseo-node-timestamp": String(authentication.timestampMs),
        "x-paseo-node-nonce": authentication.nonce,
        "x-paseo-node-signature": authentication.signature,
      },
      body,
    });

    // Presence says which people are here. A node arriving with no principal id must be turned
    // away, not recorded as an entry whose id is absent.
    expect(response.status).toBe(401);
  });

  test("leaves the bearer path working", async () => {
    const harness = await start();

    const response = await fetch(`${harness.base}/v1/ds/${harness.containerId}/meta`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${harness.memberToken}`,
        "producer-id": "prod-member",
        "producer-epoch": "1",
        "producer-seq": "1",
      },
      body: new TextEncoder().encode("from a person"),
    });

    // The node branch is additive: an editor with a token still appends exactly as before.
    expect(response.status).toBe(201);
  });
});
