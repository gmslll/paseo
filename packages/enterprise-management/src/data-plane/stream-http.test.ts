import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { COLLAB_STREAM_LIMITS } from "@getpaseo/protocol/enterprise-collaboration";
import { createManagementRequestHandler } from "../http-server.js";
import { EnterpriseManagementPlane } from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  base: string;
  token: string;
  stream: string;
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
    organizationName: "Data plane test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-data-plane",
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
    bootstrapSecret: "bootstrap-secret-for-data-plane",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const owner = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const credential = await plane.issuePersonalAccessToken(admin, owner.principalId);
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_stream_http",
    ownerPrincipalId: owner.principalId,
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  return {
    base: `http://127.0.0.1:${address.port}`,
    token: credential.token,
    stream: `/v1/ds/${workspace.workspaceUid}/meta`,
  };
}

function appendRequest(
  harness: Harness,
  input: { seq: number; epoch?: number; body?: Uint8Array; producerId?: string; path?: string },
): Promise<Response> {
  return fetch(`${harness.base}${input.path ?? harness.stream}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${harness.token}`,
      "content-type": "application/octet-stream",
      "producer-id": input.producerId ?? "prod-a",
      "producer-epoch": String(input.epoch ?? 1),
      "producer-seq": String(input.seq),
    },
    body: input.body ?? new TextEncoder().encode(`update-${input.seq}`),
  });
}

describe("collaboration stream HTTP", () => {
  test("appends a binary update and reports the next offset", async () => {
    const harness = await start();

    const appended = await appendRequest(harness, { seq: 1 });

    expect(appended.status).toBe(201);
    expect(appended.headers.get("stream-next-offset")).toMatch(/^\d{20}$/);
  });

  test("answers a replayed sequence with 204, a stale epoch with 403, and a gap with 409", async () => {
    const harness = await start();
    await appendRequest(harness, { seq: 1 });
    await appendRequest(harness, { seq: 2 });

    expect((await appendRequest(harness, { seq: 2 })).status).toBe(204);
    expect((await appendRequest(harness, { seq: 3, epoch: 0 })).status).toBe(403);
    expect((await appendRequest(harness, { seq: 9 })).status).toBe(409);
  });

  test("refuses an append over the contract limit", async () => {
    const harness = await start();

    const oversized = await appendRequest(harness, {
      seq: 1,
      body: new Uint8Array(COLLAB_STREAM_LIMITS.maxAppendBytes + 1),
    });

    expect(oversized.status).toBe(413);
  });

  test("reads the stream back from an offset", async () => {
    const harness = await start();
    await appendRequest(harness, { seq: 1, body: new TextEncoder().encode("one") });
    await appendRequest(harness, { seq: 2, body: new TextEncoder().encode("two") });

    const all = await fetch(`${harness.base}${harness.stream}`, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    expect(all.status).toBe(200);
    const payload = (await all.json()) as {
      messages: Array<{ offset: string; update: string }>;
      nextOffset: string;
      lowerBoundOffset: string;
      upToDate: boolean;
    };
    expect(payload.messages.map((message) => atob(message.update))).toEqual(["one", "two"]);
    expect(payload.upToDate).toBe(true);

    const tail = await fetch(
      `${harness.base}${harness.stream}?offset=${payload.messages[1]!.offset}`,
      {
        headers: { authorization: `Bearer ${harness.token}` },
      },
    );
    const tailPayload = (await tail.json()) as { messages: Array<{ update: string }> };
    expect(tailPayload.messages.map((message) => atob(message.update))).toEqual(["two"]);
  });

  test("reports the next offset for HEAD without a body", async () => {
    const harness = await start();
    await appendRequest(harness, { seq: 1 });

    const head = await fetch(`${harness.base}${harness.stream}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${harness.token}` },
    });

    expect(head.status).toBe(200);
    expect(head.headers.get("stream-next-offset")).toMatch(/^\d{20}$/);
    expect(await head.text()).toBe("");
  });

  test("refuses an unauthenticated caller and an unparsable container", async () => {
    const harness = await start();

    const anonymous = await fetch(`${harness.base}${harness.stream}`, { method: "PUT", body: "x" });
    expect(anonymous.status).toBe(401);

    const badContainer = await appendRequest(harness, {
      seq: 1,
      path: "/v1/ds/not-a-container/meta",
    });
    expect(badContainer.status).toBe(400);
  });
});
