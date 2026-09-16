import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "../http-server.js";
import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
} from "../management-plane.js";

const ORG = "org_0123456789abcdef";
const START = Date.parse("2026-09-16T00:00:00.000Z");
// Must satisfy USERNAME_PATTERN and the twelve-character password floor.
const USERNAME = "collaborator";
const PASSWORD = "correct-horse-battery";

interface Harness {
  base: string;
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  principalId: string;
  advance: (ms: number) => void;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function start(): Promise<Harness> {
  const ticketKeys = generateKeyPairSync("ed25519");
  let now = START;
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Plane session test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-plane-session",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
    clock: { nowMs: () => now },
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

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-plane-session",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const principal = await plane.createPrincipal(admin, {
    displayName: "Collaborator",
    principalType: "human",
    role: "employee",
  });
  await plane.setPrincipalPassword(admin, principal.principalId, {
    username: USERNAME,
    password: PASSWORD,
  });

  return {
    base: `http://127.0.0.1:${address.port}`,
    plane,
    admin,
    principalId: principal.principalId,
    advance: (ms) => {
      now += ms;
    },
  };
}

function signIn(harness: Harness, password: string): Promise<Response> {
  return fetch(`${harness.base}/v1/auth/password/plane-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password }),
  });
}

interface SessionBody {
  token: string;
  credentialId: string;
  expiresAt: string;
}

describe("plane session sign-in", () => {
  test("exchanges a password for a session the authenticated routes accept", async () => {
    const harness = await start();

    const response = await signIn(harness, PASSWORD);

    expect(response.status).toBe(201);
    const session = (await response.json()) as SessionBody;
    expect(session.token.startsWith("pso_m_")).toBe(true);
    // The session reaches the authenticated routes through the same check they already make, which
    // is what lets it be used to fetch a stream token (ADR-0035).
    const principal = await harness.plane.authenticatePersonalAccessToken(session.token);
    expect(principal?.principalId).toBe(harness.principalId);
    expect(principal?.credentialId).toBe(session.credentialId);
  });

  test("lapses, unlike a personal access token", async () => {
    const harness = await start();
    const session = (await (await signIn(harness, PASSWORD)).json()) as SessionBody;
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(START);

    harness.advance(Date.parse(session.expiresAt) - START);

    // ADR-0030 keeps an employee password from becoming a management API credential. An expiry is
    // what makes that true here: a password buys a session, not a token that never lapses.
    expect(await harness.plane.authenticatePersonalAccessToken(session.token)).toBeNull();
  });

  test("still works just before it lapses", async () => {
    const harness = await start();
    const session = (await (await signIn(harness, PASSWORD)).json()) as SessionBody;

    harness.advance(Date.parse(session.expiresAt) - START - 1_000);

    expect(await harness.plane.authenticatePersonalAccessToken(session.token)).not.toBeNull();
  });

  test("refuses a wrong password without saying which half was wrong", async () => {
    const harness = await start();

    const response = await signIn(harness, "wrong-horse-battery");

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe("invalid credential");
  });

  test("stops after five failures in a minute, per ADR-0030", async () => {
    const harness = await start();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn(harness, "wrong-horse-battery")).status).toBe(401);
    }

    // The sixth is refused for the rate limit rather than the password, and the right password is
    // refused too — otherwise the limit would only slow down a guesser who never gets lucky.
    expect((await signIn(harness, "wrong-horse-battery")).status).toBe(401);
    expect((await signIn(harness, PASSWORD)).status).toBe(401);
  });

  test("dies when the session credential is revoked", async () => {
    const harness = await start();
    const session = (await (await signIn(harness, PASSWORD)).json()) as SessionBody;

    await harness.plane.revokePersonalAccessToken(harness.admin, session.credentialId);

    // Revocation also rolls the Grant version, which is what invalidates the stream tokens already
    // minted from this session rather than leaving them alive until they expire.
    expect(await harness.plane.authenticatePersonalAccessToken(session.token)).toBeNull();
  });
});
