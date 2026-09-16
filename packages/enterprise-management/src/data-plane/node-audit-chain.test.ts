import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
  type ManagementAuditInput,
} from "../management-plane.js";
import { openSqliteDatabase } from "../sqlite.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  nodeId: string;
  databasePath: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A file database, because listAudit does not surface the hash columns and the point is storage. */
async function start(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-node-chain-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "plane.sqlite3");
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath,
    organizationId: ORG,
    organizationName: "Node audit chain test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-node-audit-chain",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-node-audit-chain",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const enrollment = await plane.createEnrollmentToken(admin, { expiresInMs: 60_000 });
  const nodeKeys = generateKeyPairSync("ed25519");
  const enrolled = await plane.enrollNode({
    token: enrollment.token,
    paseoServerId: "server-chain",
    endpoint: "wss://node-chain.test:6767",
    bootId: "boot-chain",
    version: "0.8.0",
    publicKeyPem: nodeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    capabilities: {},
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 12_000_000_000,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  });

  return { plane, admin, nodeId: enrolled.node.nodeId, databasePath };
}

function auditEvent(
  harness: Harness,
  seq: number,
  hashes: { previousHash?: string; eventHash?: string } = {},
): ManagementAuditInput {
  return {
    eventId: `evt_node_${seq}`,
    nodeId: harness.nodeId,
    nodeEventSeq: seq,
    occurredAt: new Date(Date.parse("2026-09-16T00:00:00.000Z") + seq * 1_000).toISOString(),
    action: "agent.create",
    outcome: "allowed",
    actorPrincipalId: harness.admin.principalId,
    resourceKind: "agent",
    resourceId: `agt_${seq}`,
    metadata: {},
    ...hashes,
  };
}

function storedHashes(
  harness: Harness,
): Array<{ node_event_seq: number; previous_hash: string | null; event_hash: string | null }> {
  const raw = openSqliteDatabase(harness.databasePath);
  const rows = raw
    .prepare(
      "SELECT node_event_seq, previous_hash, event_hash FROM audit_events WHERE node_id = ? ORDER BY node_event_seq ASC",
    )
    .all(harness.nodeId) as Array<{
    node_event_seq: number;
    previous_hash: string | null;
    event_hash: string | null;
  }>;
  raw.close();
  return rows;
}

describe("node audit chain", () => {
  test("keeps the hashes a node sends", async () => {
    const harness = await start();

    await harness.plane.ingestAuditEvents(harness.nodeId, [
      auditEvent(harness, 1, { eventHash: "sha256:aaa" }),
    ]);

    // The node computed these; the plane used to drop them at the door.
    expect(storedHashes(harness)).toEqual([
      { node_event_seq: 1, previous_hash: null, event_hash: "sha256:aaa" },
    ]);
  });

  test("links a batch where each event names the one before it", async () => {
    const harness = await start();

    await harness.plane.ingestAuditEvents(harness.nodeId, [
      auditEvent(harness, 1, { eventHash: "sha256:aaa" }),
      auditEvent(harness, 2, { previousHash: "sha256:aaa", eventHash: "sha256:bbb" }),
      auditEvent(harness, 3, { previousHash: "sha256:bbb", eventHash: "sha256:ccc" }),
    ]);

    expect(storedHashes(harness).map((row) => row.previous_hash)).toEqual([
      null,
      "sha256:aaa",
      "sha256:bbb",
    ]);
  });

  test("refuses an event that names the wrong hash before it", async () => {
    const harness = await start();
    await harness.plane.ingestAuditEvents(harness.nodeId, [
      auditEvent(harness, 1, { eventHash: "sha256:aaa" }),
    ]);

    await expect(
      harness.plane.ingestAuditEvents(harness.nodeId, [
        auditEvent(harness, 2, { previousHash: "sha256:forged", eventHash: "sha256:bbb" }),
      ]),
    ).rejects.toThrow("audit chain mismatch");

    // The whole ingest rolls back, so a broken link leaves nothing behind.
    expect(storedHashes(harness)).toHaveLength(1);
  });

  test("still accepts a node that sends no hashes at all", async () => {
    const harness = await start();

    // The fields are optional precisely so a node from before the chain keeps working; without
    // this the strict schema would refuse it and node audit would stop the day this shipped.
    await harness.plane.ingestAuditEvents(harness.nodeId, [
      auditEvent(harness, 1),
      auditEvent(harness, 2),
    ]);

    expect(storedHashes(harness)).toEqual([
      { node_event_seq: 1, previous_hash: null, event_hash: null },
      { node_event_seq: 2, previous_hash: null, event_hash: null },
    ]);
  });

  test("leaves a hashless node alone even after a hashed run", async () => {
    const harness = await start();
    await harness.plane.ingestAuditEvents(harness.nodeId, [
      auditEvent(harness, 1, { eventHash: "sha256:aaa" }),
    ]);

    // A node that stops sending hashes is not held to the chain it was keeping; the check only
    // applies to events that carry one.
    await harness.plane.ingestAuditEvents(harness.nodeId, [auditEvent(harness, 2)]);

    expect(storedHashes(harness).at(-1)).toEqual({
      node_event_seq: 2,
      previous_hash: null,
      event_hash: null,
    });
  });
});
