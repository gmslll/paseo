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
// A well-formed node id, so the rpc:req segment below is refused by the readers matrix rather than
// rejected as an unparseable segment name — both answer 403, and only one proves the rule.
const NODE = "nod_0123456789abcdef";
const FIRST = "00000000000000000001";

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  member: AuthenticatedManagementPrincipal;
  memberToken: string;
  ownerToken: string;
  containerId: string;
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
    organizationName: "Subscription HTTP test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-subscription-http",
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
    bootstrapSecret: "bootstrap-secret-for-subscription-http",
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
    localWorkspaceId: "wks_subscription_http",
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
    admin,
    member,
    memberToken: credential.token,
    ownerToken: ownerCredential.token,
    containerId: workspace.workspaceUid,
  };
}

function open(harness: Harness, bearer: string, body: unknown): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function read(harness: Harness, bearer: string, id: string, query = ""): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/subscriptions/${id}${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

async function openId(harness: Harness, bearer: string, cursors: Record<string, string>) {
  const response = await open(harness, bearer, { containerId: harness.containerId, cursors });
  expect(response.status).toBe(201);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };
  return subscriptionId;
}

async function append(harness: Harness, segment: string, seq: number, text: string): Promise<void> {
  const result = await harness.plane.appendCollabStream(harness.member, {
    containerId: harness.containerId,
    segment,
    producerId: `prod-${segment}`,
    producerEpoch: 1,
    producerSeq: seq,
    update: new TextEncoder().encode(text),
  });
  if (result.kind !== "appended") throw new Error(`append failed: ${result.kind}`);
}

interface EventsBody {
  events: Array<Record<string, unknown>>;
}

async function eventsOf(response: Response): Promise<Array<Record<string, unknown>>> {
  expect(response.status).toBe(200);
  return ((await response.json()) as EventsBody).events;
}

describe("collaboration subscriptions over HTTP", () => {
  test("opens a subscription and reads every named segment by its id", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    await append(harness, "meta", 2, "two");
    await append(harness, "wf", 1, "three");

    const opened = await open(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST, wf: FIRST },
    });
    expect(opened.status).toBe(201);
    const created = (await opened.json()) as { subscriptionId: string; expiresAt: string };
    expect(created.subscriptionId).toMatch(/^sub_[0-9a-f]{16}$/);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());

    const events = await eventsOf(await read(harness, harness.memberToken, created.subscriptionId));
    const data = events.filter((event) => event.type === "data");
    expect(data.map((event) => event.segment)).toEqual(["meta", "meta", "wf"]);
    expect(Buffer.from(String(data[0]!.update), "base64").toString()).toBe("one");
    const control = events.filter((event) => event.type === "control");
    expect(control.map((event) => event.segment)).toEqual(["meta", "wf"]);
  });

  test("advances its cursors, so a second read returns only what arrived since", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    const id = await openId(harness, harness.memberToken, { meta: FIRST });

    expect(
      (await eventsOf(await read(harness, harness.memberToken, id))).filter(
        (event) => event.type === "data",
      ),
    ).toHaveLength(1);

    const second = await eventsOf(await read(harness, harness.memberToken, id));
    expect(second.filter((event) => event.type === "data")).toHaveLength(0);
    expect(second.every((event) => event.upToDate === true)).toBe(true);

    await append(harness, "meta", 2, "two");
    const third = await eventsOf(await read(harness, harness.memberToken, id));
    const data = third.filter((event) => event.type === "data");
    expect(data).toHaveLength(1);
    expect(Buffer.from(String(data[0]!.update), "base64").toString()).toBe("two");
  });

  test("accepts a stream token, not only a personal access token", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    const minted = await fetch(`${harness.base}/v1/streams/token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.memberToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clientId: "desktop-1" }),
    });
    const { token } = (await minted.json()) as { token: string };

    const id = await openId(harness, token, { meta: FIRST });
    expect(
      (await eventsOf(await read(harness, token, id))).filter((event) => event.type === "data"),
    ).toHaveLength(1);
  });

  test("refuses to open when one named segment is closed to the caller", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");

    // rpc:req is readable by the node alone (ADR-0032 segment matrix), so an editor is refused it
    // even though the same subscription's meta cursor is perfectly legitimate.
    const mixed = await open(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST, [`rpc:req:${NODE}`]: FIRST },
    });
    expect(mixed.status).toBe(403);

    // The same request without the closed segment succeeds, which is what makes the refusal above
    // attributable to the matrix rather than to anything incidental about the request.
    const allowed = await open(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
    });
    expect(allowed.status).toBe(201);
  });

  test("refuses a caller who is not a member of the container", async () => {
    const harness = await start();
    const stranger = await harness.plane.createPrincipal(harness.admin, {
      displayName: "Stranger",
      principalType: "human",
      role: "employee",
    });
    const credential = await harness.plane.issuePersonalAccessToken(
      harness.admin,
      stranger.principalId,
    );

    const response = await open(harness, credential.token, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
    });

    expect(response.status).toBe(403);
  });

  test("refuses one member the subscription another member opened", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    // The owner is a member in good standing, so the refusal is about whose subscription it is
    // rather than about access to the container.
    const ownersId = await openId(harness, harness.ownerToken, { meta: FIRST });

    expect((await read(harness, harness.memberToken, ownersId)).status).toBe(403);
    expect((await read(harness, harness.ownerToken, ownersId)).status).toBe(200);
  });

  test("refuses an unknown id exactly as it refuses someone else's", async () => {
    const harness = await start();
    expect((await read(harness, harness.memberToken, "sub_00000000000000ff")).status).toBe(403);
  });

  test("refuses a subscription that names no segments", async () => {
    const harness = await start();

    // An empty cursor set would run no authorization check at all, so it is refused rather than
    // accepted as a subscription to nothing.
    const response = await open(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: {},
    });
    expect(response.status).toBe(400);

    // Pinned at the plane too. The route would answer 400 either way — from the schema or from the
    // guard — so only this says the guard itself exists, and it holds for a caller that reaches the
    // plane directly rather than over HTTP.
    await expect(
      harness.plane.createCollabSubscription(harness.member, {
        containerId: harness.containerId,
        cursors: {},
      }),
    ).rejects.toThrow("subscription names no segments");
  });

  test("closes the subscription when a read overflows", async () => {
    const harness = await start();
    for (let seq = 1; seq <= COLLAB_STREAM_LIMITS.maxSubscriberQueueEvents + 1; seq += 1) {
      await append(harness, "meta", seq, "x");
    }
    const id = await openId(harness, harness.memberToken, { meta: FIRST });

    const events = await eventsOf(await read(harness, harness.memberToken, id));
    const last = events.at(-1);
    expect(last?.type).toBe("control");
    expect(last?.overflow).toBe(true);

    // ADR-0032: overflow closes the subscription. The client resumes by opening a new one from the
    // offset the control event just handed it.
    expect((await read(harness, harness.memberToken, id)).status).toBe(403);
  });

  test("refuses a live mode it does not have", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    const id = await openId(harness, harness.memberToken, { meta: FIRST });

    // sse and long-poll both work now, in subscription-sse.test.ts and
    // subscription-long-poll.test.ts. Anything else is a request for a transport that does not
    // exist, and answering the one-shot body would look like it did.
    const response = await read(harness, harness.memberToken, id, "?live=websocket");

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    // The message is what distinguishes this from the single-stream route, which answers 400 for an
    // unknown container and shares the /v1/ds/ prefix.
    expect(body.error.message).toBe("unknown live mode");
  });
});
