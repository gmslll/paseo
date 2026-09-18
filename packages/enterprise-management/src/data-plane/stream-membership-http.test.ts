import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import { EnterpriseManagementPlane } from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Actor {
  token: string;
  principalId: string;
}

interface Harness {
  base: string;
  disableCollaboration: () => Promise<unknown>;
  admin: Actor;
  owner: Actor;
  editor: Actor;
  viewer: Actor;
  stranger: Actor;
  workspaceUid: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Stream membership test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-membership",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());
  const server = createServer(
    createManagementRequestHandler(plane, { allowInsecureLoopback: true }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => closeServer(server));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-stream-membership",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  async function employee(displayName: string): Promise<Actor> {
    const principal = await plane.createPrincipal(admin, {
      displayName,
      principalType: "human",
      role: "employee",
    });
    const issued = await plane.issuePersonalAccessToken(admin, principal.principalId);
    return { token: issued.token, principalId: principal.principalId };
  }
  const owner = await employee("Owner");
  const editor = await employee("Editor");
  const viewer = await employee("Viewer");
  const stranger = await employee("Stranger");

  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_shared",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: editor.principalId,
    role: "editor",
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: viewer.principalId,
    role: "viewer",
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });

  return {
    base: `http://127.0.0.1:${address.port}`,
    disableCollaboration: () =>
      plane.setCollabCollaboration(admin, {
        workspaceUid: workspace.workspaceUid,
        enabled: false,
      }),
    admin: { token: bootstrap.token, principalId: admin.principalId },
    owner,
    editor,
    viewer,
    stranger,
    workspaceUid: workspace.workspaceUid,
  };
}

function append(harness: Harness, actor: Actor, segment: string, seq = 1): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/${segment}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${actor.token}`,
      "producer-id": `prod-${actor.principalId}`,
      "producer-epoch": "1",
      "producer-seq": String(seq),
    },
    body: new TextEncoder().encode("update"),
  });
}

function read(harness: Harness, actor: Actor, segment: string): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/${segment}`, {
    headers: { authorization: `Bearer ${actor.token}` },
  });
}

describe("collaboration stream membership authorization", () => {
  test("an editor writes a document segment and a viewer is refused", async () => {
    const harness = await start();

    expect((await append(harness, harness.editor, "meta")).status).toBe(201);
    expect((await append(harness, harness.viewer, "meta", 1)).status).toBe(403);
  });

  test("a non-member neither writes nor reads", async () => {
    const harness = await start();
    await append(harness, harness.owner, "meta");

    expect((await append(harness, harness.stranger, "meta")).status).toBe(403);
    expect((await read(harness, harness.stranger, "meta")).status).toBe(403);
  });

  test("every member reads a document segment", async () => {
    const harness = await start();
    await append(harness, harness.owner, "meta");

    for (const actor of [harness.owner, harness.editor, harness.viewer]) {
      expect((await read(harness, actor, "meta")).status).toBe(200);
    }
  });

  test("no client writes a node-owned segment, whatever their role", async () => {
    const harness = await start();

    expect((await append(harness, harness.owner, "s:agent-1")).status).toBe(403);
    expect((await append(harness, harness.editor, "fi:agent-1")).status).toBe(403);
  });

  test("a platform administrator is not a member and gets no implicit access", async () => {
    const harness = await start();

    // The placeholder granted every stream to identity.manage; membership replaces that.
    expect((await append(harness, harness.admin, "meta")).status).toBe(403);
  });

  test("refuses every member while collaboration is off", async () => {
    const harness = await start();
    await append(harness, harness.owner, "meta");

    await harness.disableCollaboration();

    // ADR-0031: without collaboration the Workspace keeps its bodies off the plane, so even the
    // owner is refused rather than merely blocked from writing.
    expect((await append(harness, harness.owner, "meta", 2)).status).toBe(403);
    expect((await read(harness, harness.owner, "meta")).status).toBe(403);
  });

  test("refuses a non-member and an absent Workspace with the same status", async () => {
    const harness = await start();
    const absent = "cws_fedcba9876543210";

    const refusedExisting = await read(harness, harness.stranger, "meta");
    const refusedAbsent = await fetch(`${harness.base}/v1/ds/${absent}/meta`, {
      headers: { authorization: `Bearer ${harness.stranger.token}` },
    });

    // Master spec §22.1 case 2: guessing a real id must not be distinguishable from guessing a
    // fake one, or the route enumerates Workspaces.
    expect(refusedAbsent.status).toBe(refusedExisting.status);
  });
});
