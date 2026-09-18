import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import type { ManagedNode } from "../model.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
  type CollabStreamActor,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
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
    organizationName: "Node stream access test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-node-streams",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-node-streams",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  return { plane, admin, ownerPrincipalId: owner.principalId };
}

async function enroll(harness: Harness, paseoServerId: string): Promise<ManagedNode> {
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
    capabilities: { collaborationV1: true },
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 12_000_000_000,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  });
  return enrolled.node;
}

/** Registers a collaborating Workspace and places it on `node`, which is what grants node access. */
async function placeWorkspace(
  harness: Harness,
  node: ManagedNode,
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
  await harness.plane.registerPlacement(node.nodeId, {
    organizationId: ORG,
    nodeId: node.nodeId,
    resourceKind: "workspace",
    localResourceId: localWorkspaceId,
    ownerPrincipalId: harness.ownerPrincipalId,
  });
  return workspace.workspaceUid;
}

function nodeActor(node: ManagedNode): CollabStreamActor {
  return { kind: "node", node };
}

function append(
  harness: Harness,
  actor: CollabStreamActor,
  containerId: string,
  segment: string,
  producerSeq = 1,
) {
  return harness.plane.appendCollabStream(actor, {
    containerId,
    segment,
    producerId: "prod-node",
    producerEpoch: 1,
    producerSeq,
    update: new TextEncoder().encode("update"),
  });
}

describe("a node writing its own segments", () => {
  test("writes the Agent-derived segments of a Workspace placed on it", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const containerId = await placeWorkspace(harness, node, "wks_a");

    // ADR-0032 makes the node the only writer of these, and placement is the authority that lets
    // it through: it holds no membership in this Workspace at all. Each segment is its own producer
    // stream, so every one of them starts at sequence 1 rather than continuing the last.
    for (const segment of ["s:agent-1", "fi:agent-1", `mf:${node.nodeId}`]) {
      const result = await append(harness, nodeActor(node), containerId, segment, 1);
      expect(result.kind).toBe("appended");
    }
  });

  test("refuses a Workspace placed on a different node", async () => {
    const harness = await start();
    const mine = await enroll(harness, "server-mine");
    const theirs = await enroll(harness, "server-theirs");
    const containerId = await placeWorkspace(harness, mine, "wks_mine");

    // Enrollment is not authority over every tenant; one node must not write another's Workspace.
    await expect(append(harness, nodeActor(theirs), containerId, "s:agent-1")).rejects.toThrow(
      "stream authorization denied",
    );
  });

  test("refuses a Workspace that is not placed anywhere", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const workspace = await harness.plane.registerCollabWorkspace(harness.admin, {
      localWorkspaceId: "wks_unplaced",
      ownerPrincipalId: harness.ownerPrincipalId,
    });
    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: workspace.workspaceUid,
      enabled: true,
    });

    await expect(
      append(harness, nodeActor(node), workspace.workspaceUid, "s:agent-1"),
    ).rejects.toThrow("stream authorization denied");
  });

  test("refuses once collaboration is switched off", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const containerId = await placeWorkspace(harness, node, "wks_a");
    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: containerId,
      enabled: false,
    });

    // ADR-0031 keeps an unenabled Workspace off the plane entirely; hosting it is not an exception.
    await expect(append(harness, nodeActor(node), containerId, "s:agent-1")).rejects.toThrow(
      "stream authorization denied",
    );
  });

  test("refuses the segments that answer to membership", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const containerId = await placeWorkspace(harness, node, "wks_a");

    // Hosting a Workspace is not editorship: preview comments and RPC requests come from people.
    for (const segment of ["pc:preview-1", `rpc:req:${node.nodeId}`]) {
      await expect(append(harness, nodeActor(node), containerId, segment)).rejects.toThrow(
        "stream authorization denied",
      );
    }
  });
});

describe("a node reading", () => {
  test("reads the RPC requests addressed to it and never the responses it wrote", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const containerId = await placeWorkspace(harness, node, "wks_a");
    const rpcId = "rpc_0123abcd-0123-0123-0123-0123456789ab";

    await expect(
      harness.plane.readCollabStream(nodeActor(node), {
        containerId,
        segment: `rpc:req:${node.nodeId}`,
      }),
    ).resolves.toMatchObject({ messages: [] });
    // A response belongs to the Principal that asked; the node answers there but cannot read back.
    expect((await append(harness, nodeActor(node), containerId, `rpc:res:${rpcId}`)).kind).toBe(
      "appended",
    );
    await expect(
      harness.plane.readCollabStream(nodeActor(node), {
        containerId,
        segment: `rpc:res:${rpcId}`,
      }),
    ).rejects.toThrow("stream authorization denied");
  });

  test("is refused rather than audited as a content Grant holder", async () => {
    const harness = await start();
    const node = await enroll(harness, "server-a");
    const theirs = await enroll(harness, "server-theirs");
    const containerId = await placeWorkspace(harness, node, "wks_a");

    await expect(
      harness.plane.readCollabStream(nodeActor(theirs), { containerId, segment: "meta" }),
    ).rejects.toThrow("stream authorization denied");
    // Content Grants belong to Principals, so a refused node must leave no `collab.content.read`
    // behind: auditing it would record a Grant that cannot exist.
    const events = (await harness.plane.listAudit(harness.admin, 500)).filter(
      (event) => event.action === "collab.content.read",
    );
    expect(events).toHaveLength(0);
  });
});
