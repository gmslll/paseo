import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const FIRST = "00000000000000000001";

type StreamEvent = Record<string, unknown>;

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  member: AuthenticatedManagementPrincipal;
  owner: AuthenticatedManagementPrincipal;
  memberToken: string;
  memberPrincipalId: string;
  workspaceUid: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function countType(events: StreamEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Subscription long-poll test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-subscription-poll",
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
    bootstrapSecret: "bootstrap-secret-for-subscription-poll",
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
  const ownerCredential = await plane.issuePersonalAccessToken(admin, ownerPrincipal.principalId);
  const credential = await plane.issuePersonalAccessToken(admin, memberPrincipal.principalId);
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_subscription_poll",
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
  const owner = (await plane.authenticatePersonalAccessToken(ownerCredential.token))!;

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    member,
    owner,
    memberToken: credential.token,
    memberPrincipalId: memberPrincipal.principalId,
    workspaceUid: workspace.workspaceUid,
  };
}

async function appendAs(
  harness: Harness,
  actor: AuthenticatedManagementPrincipal,
  producerId: string,
  seq: number,
  text: string,
): Promise<void> {
  const result = await harness.plane.appendCollabStream(actor, {
    containerId: harness.workspaceUid,
    segment: "meta",
    producerId,
    producerEpoch: 1,
    producerSeq: seq,
    update: new TextEncoder().encode(text),
  });
  if (result.kind !== "appended") throw new Error(`append failed: ${result.kind}`);
}

function append(harness: Harness, seq: number, text: string): Promise<void> {
  return appendAs(harness, harness.member, "prod-member", seq, text);
}

async function openSubscription(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.base}/v1/ds/subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${harness.memberToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ containerId: harness.workspaceUid, cursors: { meta: FIRST } }),
  });
  expect(response.status).toBe(201);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };
  return subscriptionId;
}

function longPoll(harness: Harness, subscriptionId: string, signal?: AbortSignal) {
  return fetch(`${harness.base}/v1/ds/subscriptions/${subscriptionId}?live=long-poll`, {
    headers: { authorization: `Bearer ${harness.memberToken}` },
    ...(signal ? { signal } : {}),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("collaboration subscriptions over long-poll", () => {
  test("answers at once when something is already waiting", async () => {
    const harness = await start();
    await append(harness, 1, "one");
    const subscriptionId = await openSubscription(harness);

    const response = await longPoll(harness, subscriptionId);

    expect(response.status).toBe(200);
    const { events } = (await response.json()) as { events: StreamEvent[] };
    expect(countType(events, "data")).toBe(1);
  });

  test("holds until an append lands rather than answering empty", async () => {
    const harness = await start();
    const subscriptionId = await openSubscription(harness);

    let settled = false;
    const pending = longPoll(harness, subscriptionId).then(async (response) => {
      settled = true;
      return (await response.json()) as { events: StreamEvent[] };
    });

    // Nothing has been appended, so the request must still be open.
    await delay(150);
    expect(settled).toBe(false);

    await append(harness, 1, "one");
    const { events } = await pending;
    expect(countType(events, "data")).toBe(1);
    expect(
      Buffer.from(
        String(events.find((event) => event.type === "data")!.update),
        "base64",
      ).toString(),
    ).toBe("one");
  });

  test("still refuses with a status when membership goes away during the hold", async () => {
    const harness = await start();
    const subscriptionId = await openSubscription(harness);

    const pending = longPoll(harness, subscriptionId);
    await delay(100);

    await harness.plane.removeCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
    });
    // An append by someone still entitled to write is what releases the hold.
    await appendAs(harness, harness.owner, "prod-owner", 1, "after");

    // No headers have gone out yet, so unlike the event stream this can still be a status rather
    // than a `revoked` event.
    expect((await pending).status).toBe(403);
  });

  test("lets go when the client hangs up mid-hold", async () => {
    const harness = await start();
    const subscriptionId = await openSubscription(harness);
    const controller = new AbortController();

    const pending = longPoll(harness, subscriptionId, controller.signal).catch(
      () => "aborted" as const,
    );
    await delay(100);
    controller.abort();

    expect(await pending).toBe("aborted");
    // The listener and timer are released on close; a leak would keep the server from closing and
    // hang this suite's teardown.
  });
});
