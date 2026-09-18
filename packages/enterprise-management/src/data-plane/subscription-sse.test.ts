import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { COLLAB_STREAM_LIMITS } from "@getpaseo/protocol/enterprise-collaboration";
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

// Hoisted out of the tests so the waitFor predicates stay within the nested-callback limit.
function countType(events: StreamEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function hasType(events: StreamEvent[], type: string): boolean {
  return countType(events, type) > 0;
}

function hasOverflowControl(events: StreamEvent[]): boolean {
  return events.some((event) => event.type === "control" && event.overflow === true);
}

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Subscription SSE test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-subscription-sse",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());
  const server: Server = createServer(
    createManagementRequestHandler(plane, { allowInsecureLoopback: true }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    // An open event stream keeps the server alive; close() alone would hang the suite.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-subscription-sse",
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
    localWorkspaceId: "wks_subscription_sse",
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

async function openSubscription(
  harness: Harness,
  cursors: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${harness.base}/v1/ds/subscriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${harness.memberToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ containerId: harness.workspaceUid, cursors }),
  });
  expect(response.status).toBe(201);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };
  return subscriptionId;
}

interface EventStream {
  events: StreamEvent[];
  ended: () => boolean;
}

/**
 * Reads an SSE body in the background. There is no SSE parser in this repo to borrow, and the
 * framing needed here is small: records are separated by a blank line, and every record this route
 * sends is one `data:` line. Keepalive comments start with ":" and are skipped.
 */
async function openEventStream(harness: Harness, subscriptionId: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(`${harness.base}/v1/ds/subscriptions/${subscriptionId}?live=sse`, {
    headers: { authorization: `Bearer ${harness.memberToken}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const events: StreamEvent[] = [];
  let done = false;
  const pump = (async () => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const record = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const line = record.split("\n").find((entry) => entry.startsWith("data:"));
        if (line) events.push(JSON.parse(line.slice(5).trim()) as StreamEvent);
        split = buffer.indexOf("\n\n");
      }
    }
    done = true;
  })().catch(() => {
    done = true;
  });

  cleanups.push(async () => {
    controller.abort();
    await pump;
  });
  return { events, ended: () => done };
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("collaboration subscriptions over SSE", () => {
  test("delivers the first poll at once and a data event when an append lands", async () => {
    const harness = await start();
    await append(harness, 1, "one");
    const subscriptionId = await openSubscription(harness, { meta: FIRST });

    const stream = await openEventStream(harness, subscriptionId);
    // The first poll carries what the subscription already had.
    await waitFor(() => hasType(stream.events, "data"), "the first data event");
    await waitFor(() => hasType(stream.events, "control"), "the first control event");

    await append(harness, 2, "two");
    await waitFor(() => countType(stream.events, "data") === 2, "the appended data event");
    const data = stream.events.filter((event) => event.type === "data");
    expect(Buffer.from(String(data[1]!.update), "base64").toString()).toBe("two");
  });

  test("sends revoked and closes when membership goes away mid-stream", async () => {
    const harness = await start();
    await append(harness, 1, "one");
    const subscriptionId = await openSubscription(harness, { meta: FIRST });
    const stream = await openEventStream(harness, subscriptionId);
    await waitFor(() => hasType(stream.events, "control"), "the first poll");

    await harness.plane.removeCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
    });

    await waitFor(() => hasType(stream.events, "revoked"), "the revoked event");
    await waitFor(stream.ended, "the stream to close");
  });

  test("closes the stream when the first poll overflows", async () => {
    const harness = await start();
    for (let seq = 1; seq <= COLLAB_STREAM_LIMITS.maxSubscriberQueueEvents + 1; seq += 1) {
      await append(harness, seq, "x");
    }
    const subscriptionId = await openSubscription(harness, { meta: FIRST });

    const stream = await openEventStream(harness, subscriptionId);

    await waitFor(() => hasOverflowControl(stream.events), "the overflow control event");
    // ADR-0032: overflow closes the subscription, so the stream ends rather than idling.
    await waitFor(stream.ended, "the stream to close");
  });

  test("sends the presence roster on connect and again when a heartbeat lands", async () => {
    const harness = await start();
    await append(harness, 1, "one");
    const subscriptionId = await openSubscription(harness, { meta: FIRST });

    const stream = await openEventStream(harness, subscriptionId);

    // A subscriber that has just connected is told who is already here, rather than seeing nobody
    // until somebody happens to heartbeat.
    await waitFor(() => hasType(stream.events, "presence"), "the roster on connect");
    const onConnect = stream.events.find((event) => event.type === "presence")!;
    expect((onConnect.entries ?? []) as unknown[]).toHaveLength(0);

    await fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/presence`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.memberToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "desktop-1", focusAgentId: null }),
    });

    await waitFor(() => countType(stream.events, "presence") === 2, "the roster after a heartbeat");
    const latest = stream.events.findLast((event) => event.type === "presence")!;
    const roster = (latest.entries ?? []) as Array<{ clientId?: string; principalId?: string }>;
    expect(roster).toHaveLength(1);
    expect(roster[0]?.clientId).toBe("desktop-1");
    expect(roster[0]?.principalId).toBe(harness.memberPrincipalId);
  });
});
