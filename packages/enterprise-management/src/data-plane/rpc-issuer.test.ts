import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import type { MachineRpcClientRequest } from "@getpaseo/protocol/enterprise-collaboration";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";
import { verifyMachineRpcAttestation } from "./rpc-attestation.js";

const ORG = "org_0123456789abcdef";
const RPC_ID = "rpc_0123abcd-0123-0123-0123-0123456789ab";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  editor: AuthenticatedManagementPrincipal;
  viewer: AuthenticatedManagementPrincipal;
  editorPrincipalId: string;
  ticketPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  containerId: string;
  nodeId: string;
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
    organizationName: "Machine RPC issuer test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-rpc-issuer",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-rpc-issuer",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const editorPrincipal = await plane.createPrincipal(admin, {
    displayName: "Editor",
    principalType: "human",
    role: "employee",
  });
  const viewerPrincipal = await plane.createPrincipal(admin, {
    displayName: "Viewer",
    principalType: "human",
    role: "employee",
  });

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
    localWorkspaceId: "wks_rpc",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: editorPrincipal.principalId,
    role: "editor",
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: viewerPrincipal.principalId,
    role: "viewer",
  });

  const editorCredential = await plane.issuePersonalAccessToken(admin, editorPrincipal.principalId);
  const viewerCredential = await plane.issuePersonalAccessToken(admin, viewerPrincipal.principalId);

  return {
    plane,
    admin,
    editor: (await plane.authenticatePersonalAccessToken(editorCredential.token))!,
    viewer: (await plane.authenticatePersonalAccessToken(viewerCredential.token))!,
    editorPrincipalId: editorPrincipal.principalId,
    ticketPublicKey: ticketKeys.publicKey,
    containerId: workspace.workspaceUid,
    nodeId: enrolled.node.nodeId,
  };
}

function envelope(harness: Harness, overrides: Partial<MachineRpcClientRequest> = {}) {
  return {
    kind: "request" as const,
    rpcVersion: 1 as const,
    rpcId: RPC_ID,
    method: "agent.send",
    nodeId: harness.nodeId,
    containerId: harness.containerId,
    clientId: "laptop-1",
    sentAt: "2025-06-01T00:00:00.000Z",
    expiresAt: "2025-06-01T00:01:00.000Z",
    payload: { type: "send_agent_message_request", requestId: "r1", agentId: "a", text: "hi" },
    ...overrides,
  };
}

function append(
  harness: Harness,
  actor: AuthenticatedManagementPrincipal,
  body: unknown,
  segment = `rpc:req:${harness.nodeId}`,
) {
  return harness.plane.appendCollabStream(actor, {
    containerId: harness.containerId,
    segment,
    producerId: "prod-client",
    producerEpoch: 1,
    producerSeq: 1,
    update: new TextEncoder().encode(JSON.stringify(body)),
  });
}

/**
 * Reads back what the plane actually stored, which is what the node will see. Read as a member:
 * the administrator holds no membership in this Workspace and no content Grant, so the plane
 * refuses them here exactly as it refuses a stranger.
 */
async function stored(harness: Harness, segment: string): Promise<Record<string, unknown>> {
  const read = await harness.plane.readCollabStream(harness.editor, {
    containerId: harness.containerId,
    segment,
  });
  const last = read.messages.at(-1)!;
  return JSON.parse(new TextDecoder().decode(last.update)) as Record<string, unknown>;
}

describe("attesting a machine RPC", () => {
  test("stores the envelope with a signature the node can check", async () => {
    const harness = await start();

    expect((await append(harness, harness.editor, envelope(harness))).kind).toBe("appended");

    const attested = await stored(harness, `rpc:req:${harness.nodeId}`);
    const claims = verifyMachineRpcAttestation(
      String(attested.attestation),
      harness.ticketPublicKey,
      {
        nowMs: Date.now(),
        nodeId: harness.nodeId,
        containerId: harness.containerId,
        rpcId: RPC_ID,
        currentGrantVersion: harness.editor.grantVersion,
      },
    );
    expect(claims.method).toBe("agent.send");
  });

  test("names the requester from the credential, not from the envelope", async () => {
    const harness = await start();

    // The envelope cannot be trusted about who is asking; only the credential can.
    await append(
      harness,
      harness.editor,
      envelope(harness, { clientId: "laptop-1" } as Partial<MachineRpcClientRequest>),
    );

    const attested = await stored(harness, `rpc:req:${harness.nodeId}`);
    const claims = verifyMachineRpcAttestation(
      String(attested.attestation),
      harness.ticketPublicKey,
      {
        nowMs: Date.now(),
        nodeId: harness.nodeId,
        containerId: harness.containerId,
        rpcId: RPC_ID,
        currentGrantVersion: harness.editor.grantVersion,
      },
    );
    expect(claims.requester.principalId).toBe(harness.editorPrincipalId);
    expect(claims.requester.credentialId).toBe(harness.editor.credentialId);
    // The client id is the one thing the plane has no other source for.
    expect(claims.requester.clientId).toBe("laptop-1");
  });

  test("refuses a method the table does not list", async () => {
    const harness = await start();

    await expect(
      append(harness, harness.editor, envelope(harness, { method: "agent.delete" })),
    ).rejects.toThrow("machine rpc method not allowed");
  });

  test("refuses a viewer the methods an editor holds", async () => {
    const harness = await start();

    await expect(append(harness, harness.viewer, envelope(harness))).rejects.toThrow(
      "machine rpc method authorization denied",
    );
  });

  test("lets a viewer call a read-shaped method", async () => {
    const harness = await start();

    // checkout.status carries workspace.read, which every member holds.
    expect(
      (await append(harness, harness.viewer, envelope(harness, { method: "checkout.status" })))
        .kind,
    ).toBe("appended");
  });

  test("refuses an envelope addressed to another node", async () => {
    const harness = await start();

    await expect(
      append(harness, harness.editor, envelope(harness, { nodeId: "nod_fedcba9876543210" })),
    ).rejects.toThrow("does not match its segment");
  });

  test("refuses bytes that are not an envelope", async () => {
    const harness = await start();

    await expect(append(harness, harness.editor, { nonsense: true })).rejects.toThrow(
      "invalid machine rpc envelope",
    );
  });

  test("leaves every other segment's bytes exactly as they arrived", async () => {
    const harness = await start();
    const body = { title: "not an rpc" };

    await append(harness, harness.editor, body, "meta");

    // The plane reads and rewrites one segment kind; meta must come back byte for byte.
    expect(await stored(harness, "meta")).toEqual(body);
  });
});
