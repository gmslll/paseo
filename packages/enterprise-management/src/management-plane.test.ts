import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import { EnterpriseManagementPlane } from "./management-plane.js";
import { signNodeRequest, verifySessionTicket } from "./security.js";

const ORG = "org_0123456789abcdef";
const START = Date.parse("2026-09-12T00:00:00.000Z");

describe("EnterpriseManagementPlane", () => {
  test("runs the employee, node, placement, ticket, lease, and audit authority lifecycle", async () => {
    let nowMs = START;
    const ticketKeys = generateKeyPairSync("ed25519");
    const nodeAKeys = generateKeyPairSync("ed25519");
    const nodeBKeys = generateKeyPairSync("ed25519");
    const plane = new EnterpriseManagementPlane({
      databasePath: ":memory:",
      organizationId: ORG,
      organizationName: "Paseo Test",
      issuer: "https://management.test:17443",
      bootstrapSecret: "bootstrap-secret-with-enough-entropy",
      ticketPrivateKey: ticketKeys.privateKey,
      ticketPublicKey: ticketKeys.publicKey,
      clock: { nowMs: () => nowMs },
    });

    const bootstrap = await plane.bootstrapAdministrator({
      bootstrapSecret: "bootstrap-secret-with-enough-entropy",
      displayName: "Platform Admin",
    });
    await expect(
      plane.bootstrapAdministrator({
        bootstrapSecret: "bootstrap-secret-with-enough-entropy",
        displayName: "Second Admin",
      }),
    ).rejects.toThrow("already initialized");
    const admin = await plane.authenticatePersonalAccessToken(bootstrap.token);
    expect(admin?.role).toBe("platform_admin");

    const employee = await plane.createPrincipal(admin!, {
      displayName: "Employee A",
      principalType: "human",
      role: "employee",
    });
    const employeeCredential = await plane.issuePersonalAccessToken(admin!, employee.principalId);
    expect(
      (await plane.authenticatePersonalAccessToken(employeeCredential.token))?.principalId,
    ).toBe(employee.principalId);

    const enrollmentA = await plane.createEnrollmentToken(admin!, { expiresInMs: 60_000 });
    const nodeA = await plane.enrollNode({
      token: enrollmentA.token,
      paseoServerId: "server-a",
      endpoint: "wss://node-a.test:6767",
      bootId: "boot-a",
      version: "0.8.0",
      publicKeyPem: nodeAKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      capabilities: { browserProfiles: true, platform: "darwin" },
      capacity: {
        cpuLogical: 12,
        memoryTotalBytes: 32_000_000_000,
        memoryAvailableBytes: 24_000_000_000,
        activeAgents: 0,
        activeBrowserProfiles: 0,
      },
    });
    await expect(
      plane.enrollNode({ ...nodeA.request, token: enrollmentA.token }),
    ).resolves.toMatchObject({ node: { nodeId: nodeA.node.nodeId } });
    await expect(
      plane.enrollNode({
        ...nodeA.request,
        token: enrollmentA.token,
        paseoServerId: "server-other",
      }),
    ).rejects.toThrow("already consumed");
    await plane.setNodeStatus(admin!, nodeA.node.nodeId, "active");

    const enrollmentB = await plane.createEnrollmentToken(admin!, { expiresInMs: 60_000 });
    const nodeB = await plane.enrollNode({
      ...nodeA.request,
      token: enrollmentB.token,
      paseoServerId: "server-b",
      endpoint: "wss://node-b.test:6767",
      bootId: "boot-b",
      publicKeyPem: nodeBKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    await plane.setNodeStatus(admin!, nodeB.node.nodeId, "active");

    const heartbeatBody = JSON.stringify({
      ...nodeA.request,
      token: undefined,
      publicKeyPem: undefined,
    });
    const heartbeatAuth = signNodeRequest(nodeAKeys.privateKey, {
      nodeId: nodeA.node.nodeId,
      method: "POST",
      path: "/v1/node/heartbeat",
      timestampMs: nowMs,
      nonce: "nonce_0123456789abcdef012345",
      body: heartbeatBody,
    });
    await plane.recordHeartbeat(heartbeatAuth, heartbeatBody);
    await expect(plane.recordHeartbeat(heartbeatAuth, heartbeatBody)).rejects.toThrow("replay");

    const shutdownBody = JSON.stringify({ bootId: "boot-a", paseoServerId: "server-a" });
    const shutdownAuth = signNodeRequest(nodeAKeys.privateKey, {
      nodeId: nodeA.node.nodeId,
      method: "POST",
      path: "/v1/node/shutdown",
      timestampMs: nowMs,
      nonce: "nonce_shutdown_01234567890123",
      body: shutdownBody,
    });
    await expect(plane.recordShutdown(shutdownAuth, shutdownBody)).resolves.toMatchObject({
      status: "offline",
    });
    const restartedHeartbeatBody = JSON.stringify({
      ...nodeA.request,
      token: undefined,
      publicKeyPem: undefined,
      bootId: "boot-a-restarted",
    });
    const restartedHeartbeatAuth = signNodeRequest(nodeAKeys.privateKey, {
      nodeId: nodeA.node.nodeId,
      method: "POST",
      path: "/v1/node/heartbeat",
      timestampMs: nowMs,
      nonce: "nonce_restart_012345678901234",
      body: restartedHeartbeatBody,
    });
    await expect(
      plane.recordHeartbeat(restartedHeartbeatAuth, restartedHeartbeatBody),
    ).resolves.toMatchObject({ status: "active", bootId: "boot-a-restarted" });

    const clonedHeartbeatBody = JSON.stringify({
      ...nodeA.request,
      token: undefined,
      publicKeyPem: undefined,
      bootId: "boot-a-cloned",
    });
    const clonedHeartbeatAuth = signNodeRequest(nodeAKeys.privateKey, {
      nodeId: nodeA.node.nodeId,
      method: "POST",
      path: "/v1/node/heartbeat",
      timestampMs: nowMs,
      nonce: "nonce_clone_01234567890123456",
      body: clonedHeartbeatBody,
    });
    await expect(plane.recordHeartbeat(clonedHeartbeatAuth, clonedHeartbeatBody)).rejects.toThrow(
      "duplicate node identity",
    );
    expect(
      (await plane.listNodes(admin!)).find((node) => node.nodeId === nodeA.node.nodeId)?.status,
    ).toBe("degraded");
    await plane.setNodeStatus(admin!, nodeA.node.nodeId, "active");

    const placement = await plane.registerPlacement(nodeA.node.nodeId, {
      organizationId: ORG,
      nodeId: nodeA.node.nodeId,
      resourceKind: "workspace",
      localResourceId: "workspace-a",
      ownerPrincipalId: employee.principalId,
    });
    expect((await plane.resolveWorkspace(employee, "workspace-a"))?.resource).toEqual(
      placement.resource,
    );
    nowMs += 1;
    const synchronizedPlacements = await plane.replaceNodePlacements(nodeA.node.nodeId, [
      {
        ...placement.resource,
        ownerPrincipalId: employee.principalId,
      },
      {
        organizationId: ORG,
        nodeId: nodeA.node.nodeId,
        resourceKind: "agent",
        localResourceId: "agent-a",
        ownerPrincipalId: employee.principalId,
      },
    ]);
    expect(synchronizedPlacements).toHaveLength(2);
    expect(
      synchronizedPlacements.find((item) => item.resource.resourceKind === "workspace"),
    ).toMatchObject({ assignedAt: placement.assignedAt, ownerPrincipalId: employee.principalId });
    await plane.replaceNodePlacements(nodeA.node.nodeId, [
      { ...placement.resource, ownerPrincipalId: employee.principalId },
    ]);
    expect(await plane.listPlacements(employee)).toEqual([
      expect.objectContaining({ resource: placement.resource }),
    ]);

    const issued = await plane.issueSessionTicket(employeeCredential.token, {
      workspaceId: "workspace-a",
      clientId: "client-a",
      ttlMs: 60_000,
    });
    const verified = verifySessionTicket(issued.ticket, ticketKeys.publicKey, {
      nowMs,
      nodeId: nodeA.node.nodeId,
      paseoServerId: "server-a",
      issuer: "https://management.test:17443",
    });
    expect(verified.principalId).toBe(employee.principalId);
    expect(() =>
      verifySessionTicket(issued.ticket, ticketKeys.publicKey, {
        nowMs,
        nodeId: nodeB.node.nodeId,
        paseoServerId: "server-b",
        issuer: "https://management.test:17443",
      }),
    ).toThrow("audience");

    const firstLease = await plane.acquireLease(nodeA.node.nodeId, {
      organizationId: ORG,
      nodeId: nodeA.node.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      holderPrincipalId: employee.principalId,
      holderAgentId: "agent-a",
      mode: "write",
      resourceKind: "browser_profile",
      resourceId: "brp_0123456789abcdef",
      ttlMs: 5_000,
    });
    expect(
      plane.validateLease(nodeA.node.nodeId, {
        leaseId: firstLease.leaseId,
        nodeId: firstLease.nodeId,
        holderPrincipalId: firstLease.holderPrincipalId,
        fencingToken: firstLease.fencingToken,
      }),
    ).toEqual(firstLease);
    await expect(
      plane.acquireLease(nodeB.node.nodeId, {
        organizationId: ORG,
        nodeId: nodeB.node.nodeId,
        businessIdentityId: "bid_0123456789abcdef",
        holderPrincipalId: employee.principalId,
        holderAgentId: "agent-b",
        mode: "write",
        resourceKind: "browser_profile",
        resourceId: "brp_abcdef0123456789",
        ttlMs: 5_000,
      }),
    ).rejects.toThrow("already leased");
    nowMs += 5_001;
    const secondLease = await plane.acquireLease(nodeB.node.nodeId, {
      organizationId: ORG,
      nodeId: nodeB.node.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      holderPrincipalId: employee.principalId,
      holderAgentId: "agent-b",
      mode: "write",
      resourceKind: "browser_profile",
      resourceId: "brp_abcdef0123456789",
      ttlMs: 5_000,
    });
    expect(secondLease.fencingToken).toBe(firstLease.fencingToken + 1);
    expect(() =>
      plane.validateLease(nodeA.node.nodeId, {
        leaseId: firstLease.leaseId,
        nodeId: firstLease.nodeId,
        holderPrincipalId: firstLease.holderPrincipalId,
        fencingToken: firstLease.fencingToken,
      }),
    ).toThrow(/current|unavailable/);

    const audit = {
      eventId: "evt_node_a_1",
      nodeId: nodeA.node.nodeId,
      nodeEventSeq: 1,
      occurredAt: new Date(nowMs).toISOString(),
      action: "workspace.read",
      outcome: "allowed" as const,
      actorPrincipalId: employee.principalId,
      resourceKind: "workspace",
      resourceId: "workspace-a",
      metadata: {},
    };
    expect(await plane.ingestAuditEvents(nodeA.node.nodeId, [audit, audit])).toMatchObject({
      accepted: 1,
      duplicates: 1,
      lastSequence: 1,
      gaps: [],
    });
    expect(
      await plane.ingestAuditEvents(nodeA.node.nodeId, [
        { ...audit, eventId: "evt_node_a_3", nodeEventSeq: 3 },
      ]),
    ).toMatchObject({ accepted: 0, lastSequence: 1, gaps: [{ expected: 2, received: 3 }] });
    expect(plane.auditLastSequence(nodeA.node.nodeId)).toBe(1);
    expect(await plane.listAudit(admin!, 10)).toEqual([
      expect.objectContaining({
        eventId: audit.eventId,
        nodeId: nodeA.node.nodeId,
        metadata: {},
      }),
    ]);
    await expect(
      plane.ingestAuditEvents(nodeA.node.nodeId, [
        { ...audit, eventId: "evt_node_a_conflict", nodeEventSeq: 1 },
      ]),
    ).rejects.toThrow("identity conflict");

    const previousGrantVersion = employee.grantVersion;
    const updated = await plane.replaceGrants(admin!, employee.principalId, {
      expectedGrantVersion: previousGrantVersion,
      grants: [],
    });
    expect(updated.revocationEpoch).toBe(employee.revocationEpoch + 1);
    expect(await plane.authenticatePersonalAccessToken(employeeCredential.token)).toMatchObject({
      grantVersion: updated.grantVersion,
    });
    expect(() =>
      verifySessionTicket(issued.ticket, ticketKeys.publicKey, {
        nowMs,
        nodeId: nodeA.node.nodeId,
        paseoServerId: "server-a",
        issuer: "https://management.test:17443",
        currentGrantVersion: updated.grantVersion,
        currentRevocationEpoch: updated.revocationEpoch,
      }),
    ).toThrow("revoked");

    await plane.setNodeStatus(admin!, nodeA.node.nodeId, "draining");
    await expect(
      plane.issueSessionTicket(bootstrap.token, {
        workspaceId: "workspace-a",
        clientId: "client-admin",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("draining");
    plane.close();
  });
});
