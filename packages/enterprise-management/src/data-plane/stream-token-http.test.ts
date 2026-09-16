import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import { EnterpriseManagementPlane } from "../management-plane.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: Awaited<ReturnType<EnterpriseManagementPlane["authenticatePersonalAccessToken"]>>;
  memberToken: string;
  memberPrincipalId: string;
  workspaceUid: string;
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
    organizationName: "Stream token HTTP test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-stream-token-http",
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
    bootstrapSecret: "bootstrap-secret-for-stream-token-http",
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
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_token_http",
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

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    memberToken: credential.token,
    memberPrincipalId: member.principalId,
    workspaceUid: workspace.workspaceUid,
    stream: `/v1/ds/${workspace.workspaceUid}/meta`,
  };
}

function mintToken(harness: Harness, bearer: string): Promise<Response> {
  return fetch(`${harness.base}/v1/streams/token`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: "desktop-1" }),
  });
}

function append(harness: Harness, bearer: string, seq: number): Promise<Response> {
  return fetch(`${harness.base}${harness.stream}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${bearer}`,
      "producer-id": "prod-a",
      "producer-epoch": "1",
      "producer-seq": String(seq),
    },
    body: new TextEncoder().encode("update"),
  });
}

describe("collaboration stream token over HTTP", () => {
  test("mints a token for the caller and accepts it on the stream routes", async () => {
    const harness = await start();

    const minted = await mintToken(harness, harness.memberToken);
    expect(minted.status).toBe(201);
    const { token, expiresAt } = (await minted.json()) as { token: string; expiresAt: string };
    expect(token.startsWith("pst_v1.")).toBe(true);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    expect((await append(harness, token, 1)).status).toBe(201);
    const read = await fetch(`${harness.base}${harness.stream}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
  });

  test("stops accepting a token once the member is removed", async () => {
    const harness = await start();
    const minted = await mintToken(harness, harness.memberToken);
    const { token } = (await minted.json()) as { token: string };
    expect((await append(harness, token, 1)).status).toBe(201);

    await harness.plane.removeCollabMember(harness.admin!, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
    });

    // The token is still inside its five minute window. Removing the member rolled the grant
    // version, and the token pins the version it was minted under, so it must stop working at once
    // rather than outliving the membership that justified it. A dead credential reads as 401: the
    // holder should fetch a new one, which is a different instruction from "you may not do this".
    expect((await append(harness, token, 2)).status).toBe(401);
  });

  test("refuses a token on a container it does not name", async () => {
    const harness = await start();
    const minted = await mintToken(harness, harness.memberToken);
    const { token } = (await minted.json()) as { token: string };

    const elsewhere = await fetch(`${harness.base}/v1/ds/cws_fedcba9876543210/meta`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(elsewhere.status).toBe(401);
  });

  test("a token does not widen what its holder may write", async () => {
    const harness = await start();
    const minted = await mintToken(harness, harness.memberToken);
    const { token } = (await minted.json()) as { token: string };

    // The holder is an editor, and node-owned segments are closed to every client. The token is a
    // credential, not an authorization, so the segment matrix still applies.
    const nodeOwned = await fetch(`${harness.base}/v1/ds/${harness.workspaceUid}/s:agent-1`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "producer-id": "prod-a",
        "producer-epoch": "1",
        "producer-seq": "1",
      },
      body: new TextEncoder().encode("update"),
    });

    expect(nodeOwned.status).toBe(403);
  });

  test("refuses a token whose payload was rewritten to name another principal", async () => {
    const harness = await start();
    const minted = await mintToken(harness, harness.memberToken);
    const { token } = (await minted.json()) as { token: string };

    // Verification reads the claimed principal before checking the signature, only to know whose
    // authority to compare against. Rewriting that claim must not get past the signature.
    const [prefix, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      principalId: string;
    };
    claims.principalId = "usr_fedcba9876543210";
    const forged = [
      prefix,
      Buffer.from(JSON.stringify(claims), "utf8").toString("base64url"),
      signature,
    ].join(".");

    expect((await append(harness, forged, 1)).status).toBe(401);
  });

  test("stops accepting a token once the PAT behind it is revoked", async () => {
    const harness = await start();
    const minted = await mintToken(harness, harness.memberToken);
    const { token } = (await minted.json()) as { token: string };
    expect((await append(harness, token, 1)).status).toBe(201);

    const credentials = await harness.plane.listCredentials(
      harness.admin!,
      harness.memberPrincipalId,
    );
    await harness.plane.revokePersonalAccessToken(harness.admin!, credentials[0]!.credentialId);

    // Revoking a credential rolls the holder's grant version, and the stream token pins the version
    // it was minted under. Nothing checks the credential itself, so this test is what keeps that
    // coupling honest: if revocation ever stops rolling the version, the token would outlive it.
    expect((await append(harness, token, 2)).status).toBe(401);
  });

  test("refuses to mint for a caller with no collaborative membership", async () => {
    const harness = await start();
    const stranger = await harness.plane.createPrincipal(harness.admin!, {
      displayName: "Stranger",
      principalType: "human",
      role: "employee",
    });
    const credential = await harness.plane.issuePersonalAccessToken(
      harness.admin!,
      stranger.principalId,
    );

    // "no collaborative workspaces" is the request being unsatisfiable in the caller's current
    // state, not a missing route or resource, so it classifies as 400 rather than 404.
    expect((await mintToken(harness, credential.token)).status).toBe(400);
  });
});
