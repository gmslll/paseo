import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
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
import { ManagedNodeRuntimeDistributionState } from "../../server/src/server/enterprise/managed-node/runtime-policy-source.js";
import { ManagedRuntimeManager } from "../../server/src/server/managed-runtimes/runtime-manager.js";
import {
  currentPlatformArch,
  managedRuntimePaths,
} from "../../server/src/server/managed-runtimes/runtime-paths.js";
import {
  createTestTarGz,
  sha256Hex,
  versionScript,
} from "../../server/src/server/managed-runtimes/test-archive.js";
import { MANAGED_RUNTIME_ARTIFACT_HEADERS } from "@getpaseo/protocol/managed-runtimes";
import pino from "pino";
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
    let managementClockOffsetMs = 0;
    const plane = createPlane(managementBaseUrl, {
      nowMs: () => Date.now() + managementClockOffsetMs,
    });
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
    managementClockOffsetMs = 5_000;
    const issued = await plane.issueSessionTicket(employeeCredential.token, {
      workspaceId: "workspace-a",
      clientId: "client-a",
      ttlMs: 60_000,
    });
    managementClockOffsetMs = 0;
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

    managementClockOffsetMs = 120_000;
    const notYetValid = await plane.issueSessionTicket(employeeCredential.token, {
      workspaceId: "workspace-a",
      clientId: "client-future",
      ttlMs: 60_000,
    });
    managementClockOffsetMs = 0;
    expect(
      await authenticator.authenticateSessionTicket(notYetValid.ticket, connection),
    ).toBeNull();

    const expiredAuthenticator = new ManagedTicketAuthenticator({
      client,
      clock: { nowMs: () => Date.now() + 130_000 },
    });
    expect(
      await expiredAuthenticator.authenticateSessionTicket(issued.ticket, connection),
    ).toBeNull();

    await plane.revokePersonalAccessToken(administrator, employeeCredential.credentialId);
    await client.refreshPolicy();
    expect(await authenticator.isCurrentPrincipalContext(authenticated!.principal)).toBe(false);
    expect(await authenticator.authenticateBearer(issued.ticket, connection)).toBeNull();
  });

  test("distributes a pinned runtime that a managed node installs and reports", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-managed-runtime-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const { certificatePath, privateKeyPath } = createLocalhostCertificate(directory);
    const port = await reservePort();
    const managementBaseUrl = `https://localhost:${port}`;
    const plane = createPlane(managementBaseUrl, undefined, path.join(directory, "artifacts"));
    cleanup.push(() => plane.close());
    const server = createManagementHttpsServer({ plane, certificatePath, privateKeyPath });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    cleanup.push(() => closeServer(server));
    const caCertificate = readFileSync(certificatePath);
    const bootstrap = await plane.bootstrapAdministrator({
      bootstrapSecret: BOOTSTRAP_SECRET,
      displayName: "Platform Admin",
    });
    const administrator = await plane.authenticatePersonalAccessToken(bootstrap.token);
    if (!administrator) throw new Error("missing administrator");
    const platformArch = currentPlatformArch();
    if (!platformArch) throw new Error("unsupported test platform");

    const archive = createTestTarGz([
      { name: "bin/codex", content: versionScript("codex-cli 0.153.4"), mode: 0o755 },
    ]);
    const admin = { port, caCertificate, token: bootstrap.token };
    const uploaded = await managementRequest({
      ...admin,
      method: "PUT",
      path: `/v1/runtime-artifacts/codex/0.153.4/${platformArch}`,
      headers: {
        [MANAGED_RUNTIME_ARTIFACT_HEADERS.sha256]: sha256Hex(archive),
        [MANAGED_RUNTIME_ARTIFACT_HEADERS.fileName]: "codex.tar.gz",
        [MANAGED_RUNTIME_ARTIFACT_HEADERS.archiveFormat]: "tar.gz",
        [MANAGED_RUNTIME_ARTIFACT_HEADERS.command]: "bin/codex",
      },
      body: archive,
    });
    expect(uploaded.status).toBe(201);
    const pinned = await managementRequest({
      ...admin,
      method: "PUT",
      path: "/v1/runtime-pins/codex",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "0.153.4",
        providerIds: ["codex"],
        expectedPolicyVersion: 0,
      }),
    });
    expect(pinned.status).toBe(200);

    const enrollment = await plane.createEnrollmentToken(administrator, { expiresInMs: 60_000 });
    const heartbeat = {
      bootId: "boot-runtime-a",
      paseoServerId: "server-runtime-a",
      endpoint: "wss://node-runtime-a.internal:6767",
      version: "0.9.0",
      capabilities: { platform: process.platform },
      capacity: {
        cpuLogical: 8,
        memoryTotalBytes: 16_000_000_000,
        memoryAvailableBytes: 12_000_000_000,
        activeAgents: 0,
        activeBrowserProfiles: 0,
      },
    };
    const relationship = await enrollManagedNode({
      managementBaseUrl,
      enrollmentToken: enrollment.token,
      relationshipPath: path.join(directory, "relationship.json"),
      caCertificate,
      heartbeat,
    });
    await plane.setNodeStatus(administrator, relationship.node.nodeId, "active");

    const client = new ManagedNodeControlPlaneClient({ relationship, caCertificate });
    const distribution = new ManagedNodeRuntimeDistributionState(client);
    await distribution.refresh();
    const runtimes = new ManagedRuntimeManager({
      paths: managedRuntimePaths(path.join(directory, "paseo-home")),
      policySource: distribution.policySource,
      artifactSource: distribution.artifactSource,
      logger: pino({ level: "silent" }),
      platformArch,
    });
    distribution.reportStatus(() => runtimes.status());

    expect(await runtimes.resolveProvider("codex")).toMatchObject({
      kind: "unavailable",
      reason: "installing",
    });
    await runtimes.whenIdle();
    const resolution = await runtimes.resolveProvider("codex");
    if (resolution.kind !== "installed") throw new Error(`codex not installed: ${resolution.kind}`);
    expect(execFileSync(resolution.commandPath, ["--version"]).toString()).toContain("0.153.4");

    await client.heartbeat({
      ...heartbeat,
      capabilities: { ...heartbeat.capabilities, ...(await distribution.capabilities()) },
    });
    const status = await managementRequest({ ...admin, method: "GET", path: "/v1/runtime-status" });
    expect(JSON.parse(status.body)).toEqual({
      nodes: [
        {
          nodeId: relationship.node.nodeId,
          status: "active",
          runtimes: [{ runtimeName: "codex", activeVersion: "0.153.4", status: "installed" }],
        },
      ],
    });
  });
});

function managementRequest(input: {
  readonly port: number;
  readonly caCertificate: Buffer;
  readonly token: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: Buffer | string;
}): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        servername: "localhost",
        port: input.port,
        method: input.method,
        path: input.path,
        ca: input.caCertificate,
        headers: { authorization: `Bearer ${input.token}`, ...input.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(input.body);
  });
}

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

function createPlane(
  issuer: string,
  clock?: { readonly nowMs: () => number },
  runtimeArtifactDirectory?: string,
): EnterpriseManagementPlane {
  const ticketKeys = generateKeyPairSync("ed25519");
  return new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORGANIZATION_ID,
    organizationName: "Managed node integration",
    issuer,
    bootstrapSecret: BOOTSTRAP_SECRET,
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
    ...(clock ? { clock } : {}),
    ...(runtimeArtifactDirectory ? { runtimeArtifactDirectory } : {}),
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
