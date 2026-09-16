import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// The package exports only its root, which resolves to its build output. A stale dist would test
// yesterday's plane, so this test's package is built before it runs.
import {
  createManagementRequestHandler,
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "@getpaseo/enterprise-management";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createManagedNodeRelationship } from "../relationship-store.js";
import { collabPaths, ensureCollabRepoPath } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";
import { CollabStreamUplink, type StreamUplinkTransport } from "./stream-uplink.js";

const ORG = "org_0123456789abcdef";

/**
 * The plane, its routes, the signatures, the segment ACL, the producer fencing and the replica are
 * all real here. Only the socket is not: the relationship schema requires an HTTPS origin and the
 * repository has no certificate fixture, so the transport dials the loopback test server instead of
 * pinning TLS. What that leaves untested is node-request.ts, which the daemon already uses for every
 * other management call.
 */
interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  uplink: CollabStreamUplink;
  store: CollabRepoStore;
  containerId: string;
  nodeId: string;
  reopen(): CollabStreamUplink;
  freshReplica(): { store: CollabRepoStore; uplink: CollabStreamUplink };
}

const cleanups: Array<() => Promise<void> | void> = [];
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "stream-uplink-"));
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  rmSync(directory, { recursive: true, force: true });
});

function loopbackTransport(base: string): StreamUplinkTransport {
  return {
    async sendBytes(input) {
      const response = await fetch(`${base}${input.path}`, {
        method: input.method,
        headers: { ...input.headers, "content-type": "application/octet-stream" },
        body: new Uint8Array(input.body),
      });
      const text = await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text.length === 0 ? null : JSON.parse(text),
      };
    },
    async readJson(input) {
      const response = await fetch(`${base}${input.path}`, {
        method: input.method,
        headers: input.headers,
      });
      const decoded: unknown = await response.json();
      if (!response.ok) throw new Error(`read refused with status ${response.status}`);
      return input.schema.parse(decoded);
    },
  };
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Stream uplink test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-uplink",
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
  const base = `http://127.0.0.1:${address.port}`;

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-stream-uplink",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
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
    localWorkspaceId: "wks_uplink",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  await plane.registerPlacement(enrolled.node.nodeId, {
    organizationId: ORG,
    nodeId: enrolled.node.nodeId,
    resourceKind: "workspace",
    localResourceId: "wks_uplink",
    ownerPrincipalId: owner.principalId,
  });

  const relationship = createManagedNodeRelationship({
    // An HTTPS origin because the relationship schema requires one; the transport dials `base`.
    managementBaseUrl: "https://management.test:17443",
    node: enrolled.node,
    nodePrivateKeyPem: nodeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    // The plane method returns { node, request }; only the HTTP enrollment route adds the ticket
    // key to its response. Take it from the key this test handed the plane.
    ticketPublicKeyPem: ticketKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });

  const repoPath = ensureCollabRepoPath(collabPaths(directory), workspace.workspaceUid);
  const openUplink = (file: string): { store: CollabRepoStore; uplink: CollabStreamUplink } => {
    const store = CollabRepoStore.open({ path: file });
    cleanups.push(() => store.close());
    return {
      store,
      uplink: new CollabStreamUplink({
        relationship,
        caCertificate: "unused-by-the-loopback-transport",
        containerId: workspace.workspaceUid,
        store,
        transport: loopbackTransport(base),
      }),
    };
  };
  const first = openUplink(repoPath);
  let replicas = 0;

  return {
    base,
    plane,
    admin,
    uplink: first.uplink,
    store: first.store,
    containerId: workspace.workspaceUid,
    nodeId: enrolled.node.nodeId,
    reopen: () => openUplink(repoPath).uplink,
    freshReplica: () => {
      replicas += 1;
      return openUplink(path.join(directory, `replica-${replicas}.sqlite3`));
    },
  };
}

function update(key: string, value: string, base?: Uint8Array): Uint8Array {
  const document = new LoroDoc();
  if (base) document.importBatch([base]);
  const from = document.version();
  document.getMap("meta").set(key, value);
  document.commit();
  return document.export({ mode: "update", from });
}

/** Reads back as the node itself, which is the only reader of an Agent-derived segment. */
async function planeMessages(harness: Harness, segment: string): Promise<number> {
  const node = (await harness.plane.listNodes(harness.admin)).find(
    (entry) => entry.nodeId === harness.nodeId,
  )!;
  const read = await harness.plane.readCollabStream(
    { kind: "node", node },
    { containerId: harness.containerId, segment },
  );
  return read.messages.length;
}

describe("uploading the replica's queue", () => {
  test("says idle when the node has produced nothing", async () => {
    const harness = await start();
    harness.uplink.beginEpoch("s:agent-1");

    expect(await harness.uplink.flushSegment("s:agent-1")).toEqual({ kind: "idle" });
  });

  test("opens the epoch under the node's own producer identity", async () => {
    const harness = await start();

    const first = harness.uplink.beginEpoch("s:agent-1");
    const second = harness.uplink.beginEpoch("s:agent-1");

    // The identity the plane fences on belongs to the uplink. A caller that spelled it out itself
    // would be a second copy of the convention, and a divergence would surface only as a refused
    // append.
    expect(first.producerId).toBe(`nod:${harness.nodeId}`);
    expect(second.epoch).toBeGreaterThan(first.epoch);
  });

  test("sends what is queued and stops tracking it", async () => {
    const harness = await start();
    harness.uplink.beginEpoch("s:agent-1");
    harness.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    harness.store.enqueueLocalUpdate(
      "s:agent-1",
      update("subtitle", "two", harness.store.documentSnapshot("s:agent-1")!),
    );

    const outcome = await harness.uplink.flushSegment("s:agent-1");

    expect(outcome).toEqual({ kind: "uploaded", count: 2, throughSeq: 2 });
    expect(harness.store.listPendingUpdates("s:agent-1")).toHaveLength(0);
    expect(await planeMessages(harness, "s:agent-1")).toBe(2);
  });

  test("treats an append the plane already holds as delivered", async () => {
    const harness = await start();
    const producerId = `nod:${harness.nodeId}`;
    harness.store.beginProducerEpoch("s:agent-1", producerId);
    harness.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    await harness.uplink.flushSegment("s:agent-1");

    // A rebuilt replica starts this producer at epoch 1, sequence 1 again — the sequence the plane
    // already stored. It answers 204, which has to count as delivered: anything else resends it
    // forever, and the plane will never accept it.
    const rebuilt = harness.freshReplica();
    rebuilt.store.beginProducerEpoch("s:agent-1", producerId);
    rebuilt.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    const outcome = await rebuilt.uplink.flushSegment("s:agent-1");

    expect(outcome).toEqual({ kind: "uploaded", count: 1, throughSeq: 1 });
    expect(rebuilt.store.listPendingUpdates("s:agent-1")).toHaveLength(0);
    // Still one message: the plane deduplicated rather than storing it twice.
    expect(await planeMessages(harness, "s:agent-1")).toBe(1);
  });

  test("raises the epoch past the plane's when it is fenced", async () => {
    const harness = await start();
    const producerId = `nod:${harness.nodeId}`;
    harness.store.beginProducerEpoch("s:agent-1", producerId);
    harness.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    await harness.uplink.flushSegment("s:agent-1");

    // The plane is now at epoch 1. A replica that came back at epoch 1 with new work is stale.
    await harness.plane.appendCollabStream(
      { kind: "node", node: (await harness.plane.listNodes(harness.admin))[0]! },
      {
        containerId: harness.containerId,
        segment: "s:agent-1",
        producerId,
        producerEpoch: 5,
        producerSeq: 1,
        update: new TextEncoder().encode("from a later boot"),
      },
    );
    harness.store.enqueueLocalUpdate("s:agent-1", update("late", "work"));
    const outcome = await harness.uplink.flushSegment("s:agent-1");

    expect(outcome.kind).toBe("refenced");
    expect(outcome.kind === "refenced" && outcome.epoch).toBeGreaterThan(5);
    // The work is not lost, only renumbered under the epoch the plane will now accept.
    expect(harness.store.listPendingUpdates("s:agent-1")).toHaveLength(1);
  });
});

describe("pulling from the plane", () => {
  test("applies what arrived and resumes past it", async () => {
    const harness = await start();
    harness.uplink.beginEpoch("s:agent-1");
    harness.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    await harness.uplink.flushSegment("s:agent-1");

    const first = await harness.uplink.pullSegment("s:agent-1");
    const second = await harness.uplink.pullSegment("s:agent-1");

    expect(first.applied).toBe(1);
    // A read's fromOffset is inclusive, so a cursor holding the last applied offset would hand the
    // same message back on every poll.
    expect(second.applied).toBe(0);
    expect(second.upToDate).toBe(true);
  });

  test("resumes from the stored cursor after a restart", async () => {
    const harness = await start();
    harness.uplink.beginEpoch("s:agent-1");
    harness.store.enqueueLocalUpdate("s:agent-1", update("title", "one"));
    await harness.uplink.flushSegment("s:agent-1");
    await harness.uplink.pullSegment("s:agent-1");

    // A new uplink over the same replica file, as a restarted daemon would open.
    expect((await harness.reopen().pullSegment("s:agent-1")).applied).toBe(0);
  });
});
