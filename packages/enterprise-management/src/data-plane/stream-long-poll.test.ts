import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  member: AuthenticatedManagementPrincipal;
  memberToken: string;
  workspaceUid: string;
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
    organizationName: "Single stream long-poll test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-long-poll",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());
  const server: Server = createServer(
    createManagementRequestHandler(plane, { allowInsecureLoopback: true }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    // A held request keeps the server alive; close() alone would hang the suite.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-stream-long-poll",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const ownerPrincipal = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const memberPrincipal = await plane.createPrincipal(admin, {
    displayName: "Member",
    principalType: "human",
    role: "employee",
  });
  const credential = await plane.issuePersonalAccessToken(admin, memberPrincipal.principalId);
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_stream_long_poll",
    ownerPrincipalId: ownerPrincipal.principalId,
  });
  await plane.setCollabMember(admin, {
    workspaceUid: workspace.workspaceUid,
    principalId: memberPrincipal.principalId,
    role: "editor",
  });
  await plane.setCollabCollaboration(admin, {
    workspaceUid: workspace.workspaceUid,
    enabled: true,
  });
  const member = (await plane.authenticatePersonalAccessToken(credential.token))!;

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    member,
    memberToken: credential.token,
    workspaceUid: workspace.workspaceUid,
  };
}

async function append(harness: Harness, segment: string, seq: number, text: string): Promise<void> {
  const result = await harness.plane.appendCollabStream(harness.member, {
    containerId: harness.workspaceUid,
    segment,
    producerId: `prod-${segment}`,
    producerEpoch: 1,
    producerSeq: seq,
    update: new TextEncoder().encode(text),
  });
  if (result.kind !== "appended") throw new Error(`append failed: ${result.kind}`);
}

function readStream(harness: Harness, segment: string, query: string): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/${segment}${query}`, {
    headers: { authorization: `Bearer ${harness.memberToken}` },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReadBody {
  messages: Array<{ offset: string; update: string }>;
  upToDate: boolean;
}

describe("single stream long-poll", () => {
  test("answers at once when the segment already has something after the offset", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");

    const response = await readStream(harness, "meta", "?live=long-poll");

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadBody;
    expect(body.messages).toHaveLength(1);
    expect(Buffer.from(body.messages[0]!.update, "base64").toString()).toBe("one");
  });

  test("holds an empty segment open until it takes an append", async () => {
    const harness = await start();

    let settled = false;
    const pending = readStream(harness, "meta", "?live=long-poll").then(async (response) => {
      settled = true;
      return (await response.json()) as ReadBody;
    });

    await delay(150);
    expect(settled).toBe(false);

    await append(harness, "meta", 1, "one");
    const body = await pending;
    expect(body.messages).toHaveLength(1);
  });

  test("is not woken by an append to a different segment", async () => {
    const harness = await start();

    let settled = false;
    const pending = readStream(harness, "meta", "?live=long-poll").then(async (response) => {
      settled = true;
      return (await response.json()) as ReadBody;
    });

    // The notifier names the segment, so this must not release a reader waiting on `meta`. Proving
    // it this way costs 150ms rather than the full hold.
    await append(harness, "wf", 1, "elsewhere");
    await delay(150);
    expect(settled).toBe(false);

    await append(harness, "meta", 1, "one");
    const body = await pending;
    expect(body.messages).toHaveLength(1);
    expect(Buffer.from(body.messages[0]!.update, "base64").toString()).toBe("one");
  });

  test("says single-stream sse is missing rather than answering a one-shot body", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");

    const response = await readStream(harness, "meta", "?live=sse");

    expect(response.status).toBe(501);
  });

  test("refuses a live mode it does not have", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");

    const response = await readStream(harness, "meta", "?live=websocket");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("unknown live mode");
  });

  test("a plain read still answers immediately, held by nothing", async () => {
    const harness = await start();

    const response = await readStream(harness, "meta", "");

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadBody;
    expect(body.messages).toHaveLength(0);
    expect(body.upToDate).toBe(true);
  });
});
