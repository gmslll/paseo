import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { Script } from "node:vm";

import { afterEach, describe, expect, test } from "vitest";

import { createManagementRequestHandler } from "./http-server.js";
import { EnterpriseManagementPlane } from "./management-plane.js";
import { signNodeRequest } from "./security.js";

const ORG = "org_abcdef0123456789";

describe("management HTTP API", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  test("serves the administrator and signed node flows without persisting bearer secrets", async () => {
    const ticketKeys = generateKeyPairSync("ed25519");
    const nodeKeys = generateKeyPairSync("ed25519");
    const plane = new EnterpriseManagementPlane({
      databasePath: ":memory:",
      organizationId: ORG,
      organizationName: "HTTP test",
      issuer: "https://management.test:17443",
      bootstrapSecret: "bootstrap-secret-for-http-test",
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
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/v1/health`);
    expect(await health.json()).toEqual({ status: "ok" });
    const managementUi = await fetch(`${base}/`);
    expect(managementUi.headers.get("content-security-policy")).toContain("frame-ancestors");
    const managementUiHtml = await managementUi.text();
    expect(managementUiHtml).toContain("保存 Grant");
    expect(managementUiHtml).toContain("员工、Boss 或管理员 PAT");
    expect(managementUiHtml).toContain("生成 5 分钟连接票据");
    expect(managementUiHtml).toContain("tcp://");
    expect(managementUiHtml).toContain("/v1/tickets/session");
    const managementScript = managementUiHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(managementScript).toBeDefined();
    expect(() => new Script(managementScript!, { filename: "management-ui.js" })).not.toThrow();

    const bootstrap = await jsonRequest(base, "/v1/bootstrap", {
      method: "POST",
      body: { bootstrapSecret: "bootstrap-secret-for-http-test", displayName: "Admin" },
    });
    const adminToken = String(bootstrap.token);
    expect(adminToken).toMatch(/^pso_m_cred_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/);

    const employeeResponse = await jsonRequest(base, "/v1/principals", {
      method: "POST",
      token: adminToken,
      body: { displayName: "Employee", principalType: "human", role: "employee" },
    });
    const employee = employeeResponse.principal as { principalId: string };
    const employeeTokenResponse = await jsonRequest(
      base,
      `/v1/principals/${employee.principalId}/credentials`,
      { method: "POST", token: adminToken, body: {} },
    );
    const employeeToken = String(employeeTokenResponse.token);
    expect(
      JSON.stringify(await jsonRequest(base, "/v1/principals", { token: adminToken })),
    ).not.toContain(employeeToken);

    const enrollment = await jsonRequest(base, "/v1/enrollment-tokens", {
      method: "POST",
      token: adminToken,
      body: { expiresInMs: 60_000 },
    });
    const enrollmentBody = {
      token: enrollment.token,
      paseoServerId: "server-http",
      publicKeyPem: nodeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      endpoint: "wss://node-http.test:6767",
      bootId: "boot-http",
      version: "0.8.0",
      capabilities: { platform: "darwin" },
      capacity: {
        cpuLogical: 8,
        memoryTotalBytes: 16_000_000_000,
        memoryAvailableBytes: 12_000_000_000,
        activeAgents: 0,
        activeBrowserProfiles: 0,
      },
    };
    const enrolled = await jsonRequest(base, "/v1/nodes/enroll", {
      method: "POST",
      body: enrollmentBody,
    });
    const nodeId = String((enrolled.node as { nodeId: string }).nodeId);
    await jsonRequest(base, `/v1/nodes/${nodeId}/status`, {
      method: "PUT",
      token: adminToken,
      body: { status: "active" },
    });

    const heartbeatBody = JSON.stringify({
      bootId: enrollmentBody.bootId,
      paseoServerId: enrollmentBody.paseoServerId,
      endpoint: enrollmentBody.endpoint,
      version: enrollmentBody.version,
      capabilities: enrollmentBody.capabilities,
      capacity: enrollmentBody.capacity,
    });
    const timestampMs = Date.now();
    const authentication = signNodeRequest(nodeKeys.privateKey, {
      nodeId,
      method: "POST",
      path: "/v1/node/heartbeat",
      timestampMs,
      nonce: "http_nonce_0123456789012345",
      body: heartbeatBody,
    });
    const heartbeat = await fetch(`${base}/v1/node/heartbeat`, {
      method: "POST",
      headers: nodeHeaders(authentication),
      body: heartbeatBody,
    });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ node: { nodeId, status: "active" } });
    const replay = await fetch(`${base}/v1/node/heartbeat`, {
      method: "POST",
      headers: nodeHeaders(authentication),
      body: heartbeatBody,
    });
    expect(replay.status).toBe(409);

    const credentials = await jsonRequest(
      base,
      `/v1/principals/${employee.principalId}/credentials`,
      { token: adminToken },
    );
    expect(credentials.credentials).toEqual([
      expect.objectContaining({
        principalId: employee.principalId,
        revokedAt: null,
      }),
    ]);
    await jsonRequest(base, `/v1/principals/${employee.principalId}/status`, {
      method: "PUT",
      token: adminToken,
      body: { status: "disabled" },
    });
    const denied = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${employeeToken}` },
    });
    expect(denied.status).toBe(401);
  });

  test("rejects plaintext non-loopback requests by default", async () => {
    const ticketKeys = generateKeyPairSync("ed25519");
    const plane = new EnterpriseManagementPlane({
      databasePath: ":memory:",
      organizationId: ORG,
      organizationName: "TLS test",
      issuer: "https://management.test:17443",
      bootstrapSecret: "bootstrap-secret-for-tls-test",
      ticketPrivateKey: ticketKeys.privateKey,
      ticketPublicKey: ticketKeys.publicKey,
    });
    cleanups.push(() => plane.close());
    const server = createServer(createManagementRequestHandler(plane));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => closeServer(server));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "TLS is required" },
    });
  });
});

function nodeHeaders(authentication: {
  readonly nodeId: string;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly signature: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-paseo-node-id": authentication.nodeId,
    "x-paseo-node-timestamp": String(authentication.timestampMs),
    "x-paseo-node-nonce": authentication.nonce,
    "x-paseo-node-signature": authentication.signature,
  };
}

function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function jsonRequest(
  base: string,
  path: string,
  options: { readonly method?: string; readonly token?: string; readonly body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: options.method,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}
