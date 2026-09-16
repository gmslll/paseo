import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

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
  const owner = await plane.createPrincipal(admin, {
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
    localWorkspaceId: "wks_subscription_http",
    ownerPrincipalId: owner.principalId,
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
    containerId: workspace.workspaceUid,
  };
}

function subscribe(harness: Harness, bearer: string, body: unknown): Promise<Response> {
  return fetch(`${harness.base}/v1/ds/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

interface SubscriptionBody {
  events: Array<Record<string, unknown>>;
}

describe("collaboration subscriptions over HTTP", () => {
  test("answers every named segment with its data and a control", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");
    await append(harness, "meta", 2, "two");
    await append(harness, "wf", 1, "three");

    const response = await subscribe(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST, wf: FIRST },
    });

    expect(response.status).toBe(200);
    const { events } = (await response.json()) as SubscriptionBody;
    const data = events.filter((event) => event.type === "data");
    expect(data.map((event) => event.segment)).toEqual(["meta", "meta", "wf"]);
    expect(Buffer.from(String(data[0]!.update), "base64").toString()).toBe("one");
    const control = events.filter((event) => event.type === "control");
    expect(control.map((event) => event.segment)).toEqual(["meta", "wf"]);
    expect(control.every((event) => event.upToDate === true)).toBe(true);
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

    const response = await subscribe(harness, token, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
    });

    expect(response.status).toBe(200);
    const { events } = (await response.json()) as SubscriptionBody;
    expect(events.filter((event) => event.type === "data")).toHaveLength(1);
  });

  test("refuses the whole subscription when one named segment is closed to the caller", async () => {
    const harness = await start();
    await append(harness, "meta", 1, "one");

    // rpc:req is readable by the node alone (ADR-0032 segment matrix), so an editor is refused it
    // even though the same subscription's meta cursor is perfectly legitimate.
    const mixed = await subscribe(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST, [`rpc:req:${NODE}`]: FIRST },
    });
    expect(mixed.status).toBe(403);

    // The same request without the closed segment succeeds, which is what makes the refusal above
    // attributable to the matrix rather than to anything incidental about the request.
    const allowed = await subscribe(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
    });
    expect(allowed.status).toBe(200);
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

    const response = await subscribe(harness, credential.token, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
    });

    expect(response.status).toBe(403);
  });

  test("refuses a subscription that names no segments", async () => {
    const harness = await start();

    // An empty cursor set would run no authorization check at all, so it is refused rather than
    // answered with an empty event list.
    const response = await subscribe(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: {},
    });

    expect(response.status).toBe(400);

    // Pinned at the plane too. The route would answer 400 either way — from the schema or from the
    // guard — so only this says the guard itself exists, and it holds for a caller that reaches the
    // plane directly rather than over HTTP.
    await expect(
      harness.plane.readCollabSubscription(harness.member, {
        containerId: harness.containerId,
        cursors: {},
      }),
    ).rejects.toThrow("subscription names no segments");
  });

  test("says the live half is not available yet instead of answering a one-shot body", async () => {
    const harness = await start();

    const response = await subscribe(harness, harness.memberToken, {
      containerId: harness.containerId,
      cursors: { meta: FIRST },
      live: "sse",
    });

    // 501 also proves the route is reached at all: /v1/ds/subscriptions shares the /v1/ds/ prefix
    // with the single-stream route, which would have answered 400 for an unknown container.
    expect(response.status).toBe(501);
  });
});
