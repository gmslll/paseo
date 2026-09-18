import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { verifyMachineRpcAttestation } from "./rpc-attestation.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const RPC_ID = "rpc_0123abcd-0123-0123-0123-0123456789ab";
const LOCAL_WORKSPACE = "wks_owned_rpc";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  editor: AuthenticatedManagementPrincipal;
  viewer: AuthenticatedManagementPrincipal;
  editorPrincipalId: string;
  viewerPrincipalId: string;
  ticketPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
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
    organizationName: "Owned RPC test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-owned-rpc",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-owned-rpc",
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
    paseoServerId: "server-rpc",
    endpoint: "wss://server-rpc.test:6767",
    bootId: "boot-rpc",
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
  await plane.enableOwnedCollabWorkspace(enrolled.node.nodeId, {
    actorPrincipalId: owner.principalId,
    localWorkspaceId: LOCAL_WORKSPACE,
  });
  const workspace = plane.readNodeWorkspaceMemberships(enrolled.node.nodeId)![0]!;
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
    viewerPrincipalId: viewerPrincipal.principalId,
    ticketPublicKey: ticketKeys.publicKey,
    nodeId: enrolled.node.nodeId,
  };
}

describe("owner-driven machine RPC submit", () => {
  test("an editor's agent.send is attested onto rpc:req for the hosting node", async () => {
    const harness = await start();

    const envelope = await harness.plane.submitOwnedCollabRpc(harness.nodeId, {
      actorPrincipalId: harness.editorPrincipalId,
      credentialId: harness.editor.credentialId,
      clientId: "laptop-1",
      method: "agent.send",
      localWorkspaceId: LOCAL_WORKSPACE,
      rpcId: RPC_ID,
      payload: { type: "send_agent_message_request", requestId: "r1", agentId: "a", text: "hi" },
    });

    expect(envelope.method).toBe("agent.send");
    expect(envelope.nodeId).toBe(harness.nodeId);
    const claims = verifyMachineRpcAttestation(envelope.attestation, harness.ticketPublicKey, {
      nowMs: Date.now(),
      nodeId: harness.nodeId,
      containerId: envelope.containerId,
      rpcId: RPC_ID,
      currentGrantVersion: harness.editor.grantVersion,
    });
    expect(claims.requester.principalId).toBe(harness.editorPrincipalId);
    expect(claims.requester.credentialId).toBe(harness.editor.credentialId);
  });

  test("a viewer cannot submit agent.send", async () => {
    const harness = await start();

    await expect(
      harness.plane.submitOwnedCollabRpc(harness.nodeId, {
        actorPrincipalId: harness.viewerPrincipalId,
        credentialId: harness.viewer.credentialId,
        clientId: "laptop-1",
        method: "agent.send",
        localWorkspaceId: LOCAL_WORKSPACE,
        rpcId: RPC_ID,
        payload: { type: "send_agent_message_request", requestId: "r1", agentId: "a", text: "hi" },
      }),
    ).rejects.toThrow("machine rpc method authorization denied");
  });
});
