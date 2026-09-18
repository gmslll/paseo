import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const LIMIT = 3;

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  memberToken: string;
  first: string;
  second: string;
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
    organizationName: "Stream quota test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-quota",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());
  const server: Server = createServer(
    // Three, so the ceiling is reachable without six hundred round trips.
    createManagementRequestHandler(plane, {
      allowInsecureLoopback: true,
      streamAppendsPerMinute: LIMIT,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-stream-quota",
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

  const containers: string[] = [];
  for (const localWorkspaceId of ["wks_quota_a", "wks_quota_b"]) {
    const workspace = await plane.registerCollabWorkspace(admin, {
      localWorkspaceId,
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
    containers.push(workspace.workspaceUid);
  }

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    memberToken: credential.token,
    first: containers[0]!,
    second: containers[1]!,
  };
}

function append(harness: Harness, container: string, seq: number): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${container}/meta`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${harness.memberToken}`,
      "producer-id": "prod-a",
      "producer-epoch": "1",
      "producer-seq": String(seq),
    },
    body: new TextEncoder().encode("update"),
  });
}

function read(harness: Harness, container: string): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${container}/meta`, {
    headers: { authorization: `Bearer ${harness.memberToken}` },
  });
}

describe("stream append quota", () => {
  test("refuses with 429 once the ceiling is reached", async () => {
    const harness = await start();
    for (let seq = 1; seq <= LIMIT; seq += 1) {
      expect((await append(harness, harness.first, seq)).status).toBe(201);
    }

    const refused = await append(harness, harness.first, LIMIT + 1);

    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("too_many_requests");
    expect(body.error.message).toBe("append quota exceeded");
  });

  test("counts per container, so one busy Workspace does not silence the others", async () => {
    const harness = await start();
    for (let seq = 1; seq <= LIMIT; seq += 1) await append(harness, harness.first, seq);
    expect((await append(harness, harness.first, LIMIT + 1)).status).toBe(429);

    // Same Principal, different container: its own allowance is untouched.
    expect((await append(harness, harness.second, 1)).status).toBe(201);
  });

  test("does not count reads, which cost nothing to serve", async () => {
    const harness = await start();
    for (let seq = 1; seq <= LIMIT; seq += 1) await append(harness, harness.first, seq);
    expect((await append(harness, harness.first, LIMIT + 1)).status).toBe(429);

    // An exhausted writer can still read; only appends write a row and move the stream toward
    // compaction, which is what the quota exists to bound.
    expect((await read(harness, harness.first)).status).toBe(200);
    expect((await read(harness, harness.first)).status).toBe(200);
    expect((await read(harness, harness.first)).status).toBe(200);
    expect((await read(harness, harness.first)).status).toBe(200);
  });
});
