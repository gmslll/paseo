import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ManagedNodeControlPlaneClient,
  ManagedTicketAuthenticator,
  enrollManagedNode,
  readManagedNodeRelationship,
} from "../../server/src/server/enterprise/managed-node/index.js";
import { createManagementHttpsServer } from "./http-server.js";
import { EnterpriseManagementPlane } from "./management-plane.js";

const ORGANIZATION_ID = "org_abcdef0123456789";
const BOOTSTRAP_SECRET = "managed-node-integration-bootstrap-secret";

describe("managed node production channel", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()!();
  });

  test("enrolls a node, authenticates a node-bound ticket, and applies revocation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-managed-node-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const { certificatePath, privateKeyPath } = createLocalhostCertificate(directory);
    const port = await reservePort();
    const managementBaseUrl = `https://localhost:${port}`;
    const plane = createPlane(managementBaseUrl);
    cleanup.push(() => plane.close());
    const server = createManagementHttpsServer({
      plane,
      certificatePath,
      privateKeyPath,
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    cleanup.push(() => closeServer(server));
    const caCertificate = readFileSync(certificatePath);

    const bootstrap = await plane.bootstrapAdministrator({
      bootstrapSecret: BOOTSTRAP_SECRET,
      displayName: "Platform Admin",
    });
    const administrator = await plane.authenticatePersonalAccessToken(bootstrap.token);
    if (!administrator) throw new Error("missing administrator");
    const employee = await plane.createPrincipal(administrator, {
      displayName: "Employee A",
      principalType: "human",
      role: "employee",
    });
    const employeeCredential = await plane.issuePersonalAccessToken(
      administrator,
      employee.principalId,
    );
    const enrollment = await plane.createEnrollmentToken(administrator, { expiresInMs: 60_000 });
    const relationshipPath = path.join(directory, "relationship.json");
    const heartbeat = {
      bootId: "boot-managed-a",
      paseoServerId: "server-managed-a",
      endpoint: "wss://node-a.internal:6767",
      version: "0.8.0",
      capabilities: { platform: "darwin", browserProfiles: true },
      capacity: {
        cpuLogical: 12,
        memoryTotalBytes: 32_000_000_000,
        memoryAvailableBytes: 24_000_000_000,
        activeAgents: 0,
        activeBrowserProfiles: 0,
      },
    } as const;

    const relationship = await enrollManagedNode({
      managementBaseUrl,
      enrollmentToken: enrollment.token,
      relationshipPath,
      caCertificate,
      heartbeat,
    });
    expect(statSync(relationshipPath).mode & 0o777).toBe(0o600);
    expect(readManagedNodeRelationship(relationshipPath)).toEqual(relationship);
    await plane.setNodeStatus(administrator, relationship.node.nodeId, "active");

    const client = new ManagedNodeControlPlaneClient({ relationship, caCertificate });
    await expect(client.heartbeat(heartbeat)).resolves.toMatchObject({
      nodeId: relationship.node.nodeId,
      status: "active",
    });
    await expect(
      client.shutdown({ bootId: heartbeat.bootId, paseoServerId: heartbeat.paseoServerId }),
    ).resolves.toMatchObject({ status: "offline" });
    await expect(
      client.heartbeat({ ...heartbeat, bootId: "boot-managed-a-restarted" }),
    ).resolves.toMatchObject({ status: "active", bootId: "boot-managed-a-restarted" });
    await expect(client.refreshPolicy()).resolves.toContainEqual(
      expect.objectContaining({
        principalId: employee.principalId,
        grantVersion: employee.grantVersion,
      }),
    );
    await expect(client.auditState()).resolves.toEqual({ lastSequence: 0 });
    await expect(
      client.uploadAudit([
        {
          eventId: "evt_managed_node_1",
          nodeId: relationship.node.nodeId,
          nodeEventSeq: 1,
          occurredAt: new Date().toISOString(),
          action: "workspace.metadata.read",
          outcome: "allowed",
          actorPrincipalId: employee.principalId,
          resourceKind: "workspace",
          resourceId: "workspace-a",
          metadata: {},
        },
      ]),
    ).resolves.toMatchObject({ accepted: 1, lastSequence: 1, gaps: [] });
    await expect(client.auditState()).resolves.toEqual({ lastSequence: 1 });
    await expect(
      client.synchronizePlacements([
        {
          resource: {
            organizationId: ORGANIZATION_ID,
            nodeId: relationship.node.nodeId,
            resourceKind: "workspace",
            localResourceId: "workspace-a",
          },
          ownerPrincipalId: employee.principalId,
        },
      ]),
    ).resolves.toHaveLength(1);
    const issued = await plane.issueSessionTicket(employeeCredential.token, {
      workspaceId: "workspace-a",
      clientId: "client-a",
      ttlMs: 60_000,
    });
    const authenticator = new ManagedTicketAuthenticator({ client });
    const connection = {
      node: {
        nodeId: relationship.node.nodeId,
        paseoServerId: relationship.node.paseoServerId,
        mode: "managed" as const,
      },
      transport: "direct" as const,
      peer: "external" as const,
    };
    const authenticated = await authenticator.authenticateSessionTicket(issued.ticket, connection);
    expect(authenticated).toMatchObject({
      principal: {
        principalId: employee.principalId,
        credentialId: employeeCredential.credentialId,
      },
      claims: { clientId: "client-a", nodeId: relationship.node.nodeId },
    });
    expect(
      await authenticator.authenticateBearer(issued.ticket, {
        ...connection,
        node: { ...connection.node, nodeId: "nod_0123456789abcdef" },
      }),
    ).toBeNull();

    await plane.revokePersonalAccessToken(administrator, employeeCredential.credentialId);
    await client.refreshPolicy();
    expect(await authenticator.isCurrentPrincipalContext(authenticated!.principal)).toBe(false);
    expect(await authenticator.authenticateBearer(issued.ticket, connection)).toBeNull();
  });
});

function createLocalhostCertificate(directory: string): {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
} {
  const certificatePath = path.join(directory, "localhost-cert.pem");
  const privateKeyPath = path.join(directory, "localhost-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  return { certificatePath, privateKeyPath };
}

function createPlane(issuer: string): EnterpriseManagementPlane {
  const ticketKeys = generateKeyPairSync("ed25519");
  return new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORGANIZATION_ID,
    organizationName: "Managed node integration",
    issuer,
    bootstrapSecret: BOOTSTRAP_SECRET,
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
}

async function reservePort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("missing reserved address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

function closeServer(server: { close(callback: () => void): void }): Promise<void> {
  return new Promise((resolve) => server.close(resolve));
}
