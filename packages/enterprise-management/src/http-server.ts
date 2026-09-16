import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import {
  GlobalResourceRefSchema,
  LeaseAcquireInputSchema,
  LeaseReleaseInputSchema,
  LeaseRenewInputSchema,
  ResourceGrantSchema,
} from "@getpaseo/protocol/messages";
import {
  MANAGED_RUNTIME_ARTIFACT_HEADERS,
  ManagedRuntimePinUpdateSchema,
  ManagedRuntimePolicySettingsUpdateSchema,
} from "@getpaseo/protocol/managed-runtimes";
import { z } from "zod";

import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
  type EnrollmentRequest,
  type ManagementAuditInput,
} from "./management-plane.js";
import {
  appendOutcome,
  parseProducerHeaders,
  parseStreamPath,
  readOutcome,
  readStreamBody,
} from "./data-plane/stream-http.js";
import {
  CollabContainerIdSchema,
  CollabPresenceHeartbeatSchema,
  CollabSubscriptionIdSchema,
  CollabSubscriptionRequestSchema,
} from "@getpaseo/protocol/enterprise-collaboration";
import {
  ManagedPlacementSnapshotSchema,
  NodeCapacitySchema,
  NodeHeartbeatSchema,
  NodeRequestAuthenticationSchema,
  NodeShutdownSchema,
} from "./model.js";

const MAX_BODY_BYTES = 1_048_576;
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
});

export interface ManagementRequestHandlerOptions {
  readonly allowInsecureLoopback?: boolean;
  /**
   * Defaults to STREAM_APPENDS_PER_MINUTE. Configurable because the behaviour cannot otherwise be
   * observed without six hundred round trips, and because a deployment may want its own ceiling.
   */
  readonly streamAppendsPerMinute?: number;
}

export function createManagementRequestHandler(
  plane: EnterpriseManagementPlane,
  options: ManagementRequestHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  const passwordAttempts = new PasswordAttemptLimiter();
  // One per handler, not a module singleton: a shared one would carry state between servers and
  // make tests depend on the order they ran in.
  const streamQuota = new StreamAppendQuota(
    options.streamAppendsPerMinute ?? STREAM_APPENDS_PER_MINUTE,
  );
  return (request, response) => {
    void handleRequest(plane, request, response, options, passwordAttempts, streamQuota).catch(
      (error) => {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
          return;
        }
        const message = error instanceof Error ? error.message : "request failed";
        const status = classifyError(message);
        sendJson(response, status, { error: { code: errorCode(status), message } });
      },
    );
  };
}

export function createManagementHttpsServer(input: {
  readonly plane: EnterpriseManagementPlane;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
}): HttpsServer {
  return createServer(
    {
      cert: readFileSync(input.certificatePath),
      key: readFileSync(input.privateKeyPath),
      minVersion: "TLSv1.2",
    },
    createManagementRequestHandler(input.plane),
  );
}

async function handleRequest(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  options: ManagementRequestHandlerOptions,
  passwordAttempts: PasswordAttemptLimiter,
  streamQuota: StreamAppendQuota,
): Promise<void> {
  enforceTls(request, options);
  applyPaseoAppCors(request, response);
  const method = request.method?.toUpperCase() ?? "GET";
  if (method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "https://management.invalid");
  const path = url.pathname;
  if (handlePublicGet(plane, response, method, path)) return;

  // Artifacts are larger than the JSON body limit, so the upload streams after authentication.
  if (await handleRuntimeArtifactUpload(plane, request, response, method, path)) return;
  // Must precede the stream route: /v1/ds/subscriptions also starts with /v1/ds/, and the stream
  // path pattern needs two segments, so it would answer 400 rather than decline the route.
  if (await handleCollabSubscriptionRequest(plane, request, response, method, path, url)) return;
  // Same collision: /v1/ds/<container>/presence parses as a segment named "presence", which is not
  // one the contract names.
  if (await handleCollabPresenceRequest(plane, request, response, method, path)) return;
  // Stream updates are binary, and the shared readBody would decode them as UTF-8.
  if (await handleCollabStreamRequest(plane, request, response, method, path, url, streamQuota)) {
    return;
  }
  const body = method === "GET" || method === "HEAD" ? "" : await readBody(request);
  if (
    await handleUnauthenticatedPost(plane, request, response, method, path, body, passwordAttempts)
  )
    return;

  if (path.startsWith("/v1/node/")) {
    await handleNodeRequest(plane, request, response, method, path, body);
    return;
  }

  const actor = await authenticateUser(plane, request);
  const context: AuthenticatedRouteContext = {
    plane,
    request,
    response,
    method,
    url,
    path,
    body,
    actor,
  };
  if (await handlePrincipalPasswordRequest(context)) return;
  if (await handlePrincipalRequest(context)) return;
  if (await handleManagementInventoryRequest(context)) return;
  if (await handleRuntimeDistributionRequest(context)) return;
  if (await handleStreamTokenRequest(context)) return;
  if (await handleTicketRequest(context)) return;
  sendJson(response, 404, { error: { code: "not_found", message: "route not found" } });
}

function applyPaseoAppCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (
    origin === "paseo://app" ||
    (typeof origin === "string" && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin))
  ) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type, authorization");
    response.setHeader("vary", "origin");
  }
}

interface AuthenticatedRouteContext {
  readonly plane: EnterpriseManagementPlane;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly body: string;
  readonly actor: AuthenticatedManagementPrincipal;
}

function handlePublicGet(
  plane: EnterpriseManagementPlane,
  response: ServerResponse,
  method: string,
  path: string,
): boolean {
  if (method !== "GET") return false;
  if (path === "/v1/health") {
    sendJson(response, 200, { status: "ok" });
    return true;
  }
  if (path === "/v1/ticket-key") {
    sendJson(response, 200, { algorithm: "Ed25519", publicKeyPem: plane.ticketPublicKeyPem() });
    return true;
  }
  if (path !== "/") return false;
  sendHtml(response, MANAGEMENT_UI);
  return true;
}

async function handleUnauthenticatedPost(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
  passwordAttempts: PasswordAttemptLimiter,
): Promise<boolean> {
  if (method !== "POST") return false;
  if (method === "POST" && path === "/v1/bootstrap") {
    const input = z
      .object({
        bootstrapSecret: z.string().min(24),
        displayName: z.string().trim().min(1).max(120),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, await plane.bootstrapAdministrator(input));
    return true;
  }
  if (path === "/v1/nodes/enroll") {
    const input = z
      .object({
        token: z.string().min(1),
        paseoServerId: z.string().min(1),
        publicKeyPem: z.string().min(1),
        endpoint: z.string().url(),
        bootId: z.string().min(1),
        version: z.string().min(1),
        capabilities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        capacity: NodeCapacitySchema,
      })
      .strict()
      .parse(parseJson(body)) as EnrollmentRequest;
    const enrolled = await plane.enrollNode(input);
    sendJson(response, 201, {
      node: enrolled.node,
      ticketPublicKeyPem: plane.ticketPublicKeyPem(),
    });
    return true;
  }
  if (path === "/v1/auth/password/plane-session") {
    const input = z
      .object({
        username: z.string().trim().min(3).max(64),
        password: z.string().min(12).max(128),
      })
      .strict()
      .parse(parseJson(body));
    // ADR-0030 sets the limit this enforces: five failed attempts per source address and normalized
    // username in sixty seconds. Both password routes share the one ledger, so attempts against a
    // username count together however they arrive.
    const attemptKey = `${request.socket.remoteAddress ?? "unknown"}\n${input.username.toLowerCase()}`;
    if (!passwordAttempts.allows(attemptKey)) throw new Error("invalid credential");
    try {
      const session = await plane.issuePlaneSessionWithPassword(input);
      passwordAttempts.succeeded(attemptKey);
      sendJson(response, 201, session);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid credential") {
        passwordAttempts.failed(attemptKey);
      }
      throw error;
    }
    return true;
  }
  if (path === "/v1/auth/password/session") {
    const input = z
      .object({
        username: z.string().trim().min(3).max(64),
        password: z.string().min(12).max(128),
        nodeId: z.string().min(1),
        clientId: z.string().min(1).max(160),
        ttlMs: z.number().int().positive(),
      })
      .strict()
      .parse(parseJson(body));
    const attemptKey = `${request.socket.remoteAddress ?? "unknown"}\n${input.username.toLowerCase()}`;
    if (!passwordAttempts.allows(attemptKey)) throw new Error("invalid credential");
    try {
      const ticket = await plane.issueNodeSessionTicketWithPassword(input);
      passwordAttempts.succeeded(attemptKey);
      sendJson(response, 201, ticket);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid credential") {
        passwordAttempts.failed(attemptKey);
      }
      throw error;
    }
    return true;
  }
  return false;
}

class PasswordAttemptLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  allows(key: string): boolean {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.delete(key);
      return true;
    }
    return current.count < 5;
  }

  failed(key: string): void {
    const now = Date.now();
    const current = this.attempts.get(key);
    this.attempts.delete(key);
    this.attempts.set(key, {
      count: current && current.resetAt > now ? current.count + 1 : 1,
      resetAt: current && current.resetAt > now ? current.resetAt : now + 60_000,
    });
    while (this.attempts.size > 4_096) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
  }

  succeeded(key: string): void {
    this.attempts.delete(key);
  }
}

/**
 * How many appends one Principal may make to one container per minute.
 *
 * Neither the ADRs nor the master spec give a number — only the plan asks for a 429 alongside the
 * 413 — so this is a proposal, recorded in ADR-0032 rather than left implicit here. Ten a second
 * sustained is far above a person typing and far below what would keep the compaction threshold
 * permanently busy.
 *
 * Appends only. Reads are cheap; an append writes a row and moves a stream toward compaction.
 */
const STREAM_APPENDS_PER_MINUTE = 600;

/**
 * Counts appends per key in a fixed window, with the same shape as the password ledger above: no
 * timer, and a bounded number of keys so a flood of distinct containers cannot grow it without end.
 */
class StreamAppendQuota {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number) {}

  allows(key: string): boolean {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.delete(key);
      this.windows.set(key, { count: 1, resetAt: now + 60_000 });
      this.evictOldest();
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  private evictOldest(): void {
    while (this.windows.size > 4_096) {
      const oldest = this.windows.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

async function handlePrincipalRequest(context: AuthenticatedRouteContext): Promise<boolean> {
  const { actor, body, method, path, plane, response } = context;
  if (method === "GET" && path === "/v1/me") {
    sendJson(response, 200, { principal: actor });
    return true;
  }
  if (method === "GET" && path === "/v1/principals") {
    sendJson(response, 200, { principals: await plane.listPrincipals(actor) });
    return true;
  }
  if (method === "POST" && path === "/v1/principals") {
    const input = z
      .object({
        displayName: z.string().trim().min(1).max(120),
        principalType: z.enum(["human", "service"]),
        role: z.enum(["employee", "boss", "platform_admin"]),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, { principal: await plane.createPrincipal(actor, input) });
    return true;
  }
  const credentialMatch = /^\/v1\/principals\/([^/]+)\/credentials$/.exec(path);
  if (method === "GET" && credentialMatch) {
    sendJson(response, 200, {
      credentials: await plane.listCredentials(actor, credentialMatch[1]!),
    });
    return true;
  }
  if (method === "POST" && credentialMatch) {
    sendJson(response, 201, await plane.issuePersonalAccessToken(actor, credentialMatch[1]!));
    return true;
  }
  const grantMatch = /^\/v1\/principals\/([^/]+)\/grants$/.exec(path);
  if (method === "PUT" && grantMatch) {
    const input = z
      .object({
        expectedGrantVersion: z.string().min(1),
        grants: z.array(ResourceGrantSchema),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 200, { principal: await plane.replaceGrants(actor, grantMatch[1]!, input) });
    return true;
  }
  const principalStatusMatch = /^\/v1\/principals\/([^/]+)\/status$/.exec(path);
  if (method === "PUT" && principalStatusMatch) {
    const input = z
      .object({ status: z.enum(["active", "disabled", "revoked"]) })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 200, {
      principal: await plane.setPrincipalStatus(actor, principalStatusMatch[1]!, input.status),
    });
    return true;
  }
  const revokeCredentialMatch = /^\/v1\/credentials\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revokeCredentialMatch) {
    sendJson(response, 200, {
      revoked: await plane.revokePersonalAccessToken(actor, revokeCredentialMatch[1]!),
    });
    return true;
  }
  if (method === "POST" && path === "/v1/enrollment-tokens") {
    const input = z
      .object({ expiresInMs: z.number().int().positive() })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, await plane.createEnrollmentToken(actor, input));
    return true;
  }
  return false;
}

async function handlePrincipalPasswordRequest(
  context: AuthenticatedRouteContext,
): Promise<boolean> {
  const { actor, body, method, path, plane, response } = context;
  const passwordMatch = /^\/v1\/principals\/([^/]+)\/password$/.exec(path);
  if (method !== "PUT" || !passwordMatch) return false;
  const input = z
    .object({
      username: z.string().trim().min(3).max(64),
      password: z.string().min(12).max(128),
    })
    .strict()
    .parse(parseJson(body));
  sendJson(response, 200, {
    passwordLogin: await plane.setPrincipalPassword(actor, passwordMatch[1]!, input),
  });
  return true;
}

async function handleManagementInventoryRequest(
  context: AuthenticatedRouteContext,
): Promise<boolean> {
  const { actor, body, method, path, plane, response, url } = context;
  if (method === "GET" && path === "/v1/nodes") {
    sendJson(response, 200, { nodes: await plane.listNodes(actor) });
    return true;
  }
  if (method === "GET" && path === "/v1/placements") {
    sendJson(response, 200, { placements: await plane.listPlacements(actor) });
    return true;
  }
  if (method === "GET" && path === "/v1/audit") {
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? 200 : Number(limitValue);
    sendJson(response, 200, { events: await plane.listAudit(actor, limit) });
    return true;
  }
  const nodeStatusMatch = /^\/v1\/nodes\/([^/]+)\/status$/.exec(path);
  if (method === "PUT" && nodeStatusMatch) {
    const input = z
      .object({ status: z.enum(["active", "draining", "disabled", "revoked"]) })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 200, {
      node: await plane.setNodeStatus(actor, nodeStatusMatch[1]!, input.status),
    });
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/placements/workspaces/")) {
    const workspaceId = decodeURIComponent(path.slice("/v1/placements/workspaces/".length));
    sendJson(response, 200, { placement: await plane.resolveWorkspace(actor, workspaceId) });
    return true;
  }
  return false;
}

async function handleStreamTokenRequest(context: AuthenticatedRouteContext): Promise<boolean> {
  const { body, method, path, plane, response } = context;
  if (method !== "POST" || path !== "/v1/streams/token") return false;
  const input = z
    .object({ clientId: z.string().min(1).max(160) })
    .strict()
    .parse(parseJson(body));
  sendJson(response, 201, await plane.issueStreamToken(requireBearer(context.request), input));
  return true;
}

async function handleTicketRequest(context: AuthenticatedRouteContext): Promise<boolean> {
  const { body, method, path, plane, request, response } = context;
  if (method !== "POST") return false;
  if (method === "POST" && path === "/v1/tickets/session") {
    const input = z
      .object({
        workspaceId: z.string().min(1),
        clientId: z.string().min(1),
        ttlMs: z.number().int().positive(),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, await plane.issueSessionTicket(requireBearer(request), input));
    return true;
  }
  if (path === "/v1/tickets/node-session") {
    const input = z
      .object({
        nodeId: z.string().min(1),
        clientId: z.string().min(1).max(160),
        ttlMs: z.number().int().positive(),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, await plane.issueNodeSessionTicket(requireBearer(request), input));
    return true;
  }
  if (path === "/v1/tickets/content") {
    const input = z
      .object({
        resource: GlobalResourceRefSchema,
        action: z.literal("workspace.content.read"),
        ttlMs: z.number().int().positive(),
      })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 201, await plane.issueContentTicket(requireBearer(request), input));
    return true;
  }
  return false;
}

async function handleNodeRequest(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
): Promise<void> {
  const authentication = NodeRequestAuthenticationSchema.parse({
    nodeId: request.headers["x-paseo-node-id"],
    timestampMs: Number(request.headers["x-paseo-node-timestamp"]),
    nonce: request.headers["x-paseo-node-nonce"],
    signature: request.headers["x-paseo-node-signature"],
  });
  if (method === "POST" && path === "/v1/node/heartbeat") {
    NodeHeartbeatSchema.parse(parseJson(body));
    sendJson(response, 200, { node: await plane.recordHeartbeat(authentication, body) });
    return;
  }
  if (method === "POST" && path === "/v1/node/shutdown") {
    NodeShutdownSchema.parse(parseJson(body));
    sendJson(response, 200, { node: await plane.recordShutdown(authentication, body) });
    return;
  }
  const node = plane.authenticateSignedNodeRequest(authentication, { method, path, body });
  if (await handleNodeRuntimeRequest(plane, response, method, path, node.nodeId)) return;
  if (await handleNodePlacementRequest(plane, response, method, path, body, node.nodeId)) return;
  if (await handleNodeLeaseRequest(plane, response, method, path, body, node.nodeId)) return;
  if (await handleNodeAuditRequest(plane, response, method, path, body, node.nodeId)) return;
  sendJson(response, 404, { error: { code: "not_found", message: "route not found" } });
}

async function handleRuntimeArtifactUpload(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  const match = /^\/v1\/runtime-artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (method !== "PUT" || !match) return false;
  const actor = await authenticateUser(plane, request);
  const header = (name: string): string => {
    const value = request.headers[name];
    return typeof value === "string" ? value : "";
  };
  const minNodeVersion = header(MANAGED_RUNTIME_ARTIFACT_HEADERS.minNodeVersion);
  const artifact = await plane.uploadRuntimeArtifact(actor, {
    runtimeName: decodeURIComponent(match[1]!),
    version: decodeURIComponent(match[2]!),
    platformArch: decodeURIComponent(match[3]!),
    sha256: header(MANAGED_RUNTIME_ARTIFACT_HEADERS.sha256),
    fileName: header(MANAGED_RUNTIME_ARTIFACT_HEADERS.fileName),
    archiveFormat: header(MANAGED_RUNTIME_ARTIFACT_HEADERS.archiveFormat),
    command: header(MANAGED_RUNTIME_ARTIFACT_HEADERS.command),
    launcher: header(MANAGED_RUNTIME_ARTIFACT_HEADERS.launcher) || "exec",
    ...(minNodeVersion ? { minNodeVersion } : {}),
    body: request,
  });
  sendJson(response, 201, { artifact });
  return true;
}

function sendStreamOutcome(
  response: ServerResponse,
  outcome: { status: number; headers: Record<string, string>; body: unknown },
): void {
  if (outcome.body === null) {
    response.writeHead(outcome.status, outcome.headers);
    response.end();
    return;
  }
  const body = JSON.stringify(outcome.body);
  response.writeHead(outcome.status, {
    ...outcome.headers,
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const STREAM_PATH_PREFIX = "/v1/ds/";
const PRESENCE_PATH_SUFFIX = "/presence";

/**
 * A presence heartbeat (ADR-0032 emits presence to subscribers). It answers 204: the snapshot goes
 * to the event streams watching this container, so the heartbeat itself has nothing to return.
 */
async function handleCollabPresenceRequest(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (method !== "POST") return false;
  if (!path.startsWith(STREAM_PATH_PREFIX) || !path.endsWith(PRESENCE_PATH_SUFFIX)) return false;
  const containerId = decodeURIComponent(
    path.slice(STREAM_PATH_PREFIX.length, path.length - PRESENCE_PATH_SUFFIX.length),
  );
  // Declining rather than answering leaves anything else shaped like this to the stream route,
  // which already has the vocabulary for an unknown container.
  if (!CollabContainerIdSchema.safeParse(containerId).success) return false;

  const parsed = CollabPresenceHeartbeatSchema.safeParse(parseJson(await readBody(request)));
  if (!parsed.success) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "invalid presence heartbeat" },
    });
    return true;
  }
  let actor: AuthenticatedManagementPrincipal;
  try {
    actor = await authenticateStreamCaller(plane, request, containerId);
  } catch {
    return sendCredentialRefusal(response);
  }
  await plane.recordCollabPresence(actor, {
    containerId,
    clientId: parsed.data.clientId,
    focusAgentId: parsed.data.focusAgentId,
  });
  response.writeHead(204);
  response.end();
  return true;
}

const SUBSCRIPTION_PATH = "/v1/ds/subscriptions";

// ADR-0032 splits this in two: POST opens a subscription, and GET reads it by id. Both sit ahead of
// the single-stream route, which would otherwise claim these paths and answer 400.
async function handleCollabSubscriptionRequest(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  if (method === "POST" && path === SUBSCRIPTION_PATH) {
    return openCollabSubscription(plane, request, response);
  }
  if (method === "GET" && path.startsWith(`${SUBSCRIPTION_PATH}/`)) {
    return readCollabSubscription(plane, request, response, path, url);
  }
  return false;
}

function sendCredentialRefusal(response: ServerResponse): true {
  // Only the credential step is answered here, for the same reason as the stream route: an
  // authorization refusal must keep its own status or the route leaks which Workspaces exist.
  sendJson(response, 401, {
    error: { code: "unauthorized", message: "invalid or expired credential" },
  });
  return true;
}

async function openCollabSubscription(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const parsed = CollabSubscriptionRequestSchema.safeParse(parseJson(await readBody(request)));
  if (!parsed.success) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "invalid subscription request" },
    });
    return true;
  }
  // `live` describes the follow-up read, not this call: opening a subscription is always immediate.
  let actor: AuthenticatedManagementPrincipal;
  try {
    actor = await authenticateStreamCaller(plane, request, parsed.data.containerId);
  } catch {
    return sendCredentialRefusal(response);
  }
  sendJson(
    response,
    201,
    await plane.createCollabSubscription(actor, {
      containerId: parsed.data.containerId,
      cursors: parsed.data.cursors,
    }),
  );
  return true;
}

// Long enough to be cheap, short enough that an idle stream keeps proving itself through whatever
// sits in front of this server. Deliberately not the presence heartbeat: transport keepalive and
// participant liveness are separate concerns that should not move together.
const SSE_KEEPALIVE_MS = 30_000;

async function readCollabSubscription(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  url: URL,
): Promise<boolean> {
  const subscriptionId = decodeURIComponent(path.slice(SUBSCRIPTION_PATH.length + 1));
  if (!CollabSubscriptionIdSchema.safeParse(subscriptionId).success) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "invalid subscription id" },
    });
    return true;
  }

  // Not an authorization step: this only names the audience a stream token must have been minted
  // for. An unknown id and someone else's id are both refused below, identically.
  const containerId = plane.readCollabSubscriptionContainer(subscriptionId);
  if (!containerId) {
    sendJson(response, 403, {
      error: { code: "forbidden", message: "stream authorization denied" },
    });
    return true;
  }
  // Authentication happens before the response commits to a status, so a bad credential still gets
  // a 401 rather than a 200 event stream whose first event is an error.
  let actor: AuthenticatedManagementPrincipal;
  try {
    actor = await authenticateStreamCaller(plane, request, containerId);
  } catch {
    return sendCredentialRefusal(response);
  }

  const live = url.searchParams.get("live");
  if (live === "sse") {
    return streamCollabSubscription(plane, request, response, actor, subscriptionId, containerId);
  }
  if (live === "long-poll") {
    return longPollCollabSubscription(plane, request, response, actor, subscriptionId, containerId);
  }
  if (live) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "unknown live mode" },
    });
    return true;
  }
  sendJson(response, 200, {
    events: await plane.readCollabSubscriptionById(actor, subscriptionId),
  });
  return true;
}

// ADR-0032 names long-poll but not how long to hold. Twenty-five seconds sits under the thirty a
// proxy or load balancer typically allows an idle response, so the hold ends on our terms with a
// usable body rather than as somebody else's timeout.
const LONG_POLL_TIMEOUT_MS = 25_000;

/**
 * Resolves on the first of three things: the container takes an append, the client hangs up, or the
 * hold expires. Waking more than once is harmless — resolving a settled promise does nothing — so
 * there is no flag to keep, and teardown lives in one place that runs however the wait ends.
 *
 * Pass a segment to wait on just that one; a multiplexed reader omits it and takes the container.
 */
async function waitForContainerAppend(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  containerId: string,
  segment?: string,
): Promise<void> {
  let release: (() => void) | null = null;
  const woken = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wake = (): void => release?.();

  const unsubscribe = plane.onCollabStreamAppend((changed, changedSegment) => {
    if (changed !== containerId) return;
    // Waking a single-stream reader for a sibling segment would answer its poll with nothing new.
    if (segment !== undefined && changedSegment !== segment) return;
    wake();
  });
  const timer = setTimeout(wake, LONG_POLL_TIMEOUT_MS);
  // A stray timer must never be the reason a process or a test run refuses to exit.
  timer.unref?.();
  request.on("close", wake);

  try {
    await woken;
  } finally {
    unsubscribe();
    clearTimeout(timer);
    request.off("close", wake);
  }
}

/**
 * The multiplexed read for clients that cannot hold an event stream open (ADR-0032 gives native
 * clients long-poll). Answers at once if anything is already waiting, otherwise holds until an
 * append lands, the client leaves, or the hold expires.
 */
async function longPollCollabSubscription(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  actor: AuthenticatedManagementPrincipal,
  subscriptionId: string,
  containerId: string,
): Promise<boolean> {
  const waiting = await plane.readCollabSubscriptionById(actor, subscriptionId);
  if (waiting.some((event) => event.type === "data")) {
    sendJson(response, 200, { events: waiting });
    return true;
  }

  await waitForContainerAppend(plane, request, containerId);

  // The client may have hung up during the hold; writing to a gone response would only throw.
  if (request.destroyed || response.writableEnded) return true;
  // No headers have been sent yet, which is what lets a refusal here still be a status. The event
  // stream had to invent a `revoked` event precisely because it no longer has that option.
  sendJson(response, 200, {
    events: await plane.readCollabSubscriptionById(actor, subscriptionId),
  });
  return true;
}

async function streamCollabSubscription(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  actor: AuthenticatedManagementPrincipal,
  subscriptionId: string,
  containerId: string,
): Promise<boolean> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
  // This server configures no request or socket timeout, so nothing currently cuts a long-lived
  // response. Say so here rather than depend on the default staying at zero.
  response.setTimeout(0);

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribePresence: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribePresence?.();
    if (keepalive) clearInterval(keepalive);
    response.end();
  };

  const send = (event: unknown): void => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // An append resolves synchronously into a poll, but `await` still yields, so two appends in quick
  // succession could otherwise have the later poll consume the newer events and the earlier poll
  // deliver its older batch afterwards. Serialize instead, and collapse anything that arrives while
  // a poll is in flight into a single follow-up.
  let polling = false;
  let pending = false;
  const poll = async (): Promise<void> => {
    if (closed) return;
    if (polling) {
      pending = true;
      return;
    }
    polling = true;
    try {
      const events = await plane.readCollabSubscriptionById(actor, subscriptionId);
      for (const event of events) send(event);
      // ADR-0032: overflow closes the subscription, and the plane has already dropped it.
      if (events.some((event) => event.type === "control" && event.overflow === true)) finish();
    } catch {
      // The headers went out long ago, so a refusal can no longer change the status. ADR-0032 gives
      // it an event of its own precisely for this case.
      send({ type: "revoked", containerId, reason: "stream authorization denied" });
      finish();
    } finally {
      polling = false;
    }
    if (pending && !closed) {
      pending = false;
      await poll();
    }
  };

  // A full snapshot rather than a delta, which is what the event's `entries` field asks for and
  // what lets a subscriber that just connected see who is already here.
  const sendPresence = (): void => {
    if (closed) return;
    send({ type: "presence", containerId, entries: plane.readCollabPresence(containerId) });
  };

  unsubscribe = plane.onCollabStreamAppend((changed) => {
    // poll() is async, so a failure here would surface as an unhandled rejection rather than reach
    // the notifier. Close the stream instead: a reader that cannot be polled is finished.
    if (changed === containerId) void poll().catch(finish);
  });
  unsubscribePresence = plane.onCollabPresenceChange((changed) => {
    if (changed === containerId) sendPresence();
  });
  keepalive = setInterval(() => {
    if (!closed) response.write(": keepalive\n\n");
  }, SSE_KEEPALIVE_MS);
  // A stray interval must never be the reason a process or a test run refuses to exit.
  keepalive.unref?.();
  request.on("close", finish);

  // Send the roster once up front: without this a subscriber sees nobody until someone happens to
  // heartbeat, which for a quiet container could be the whole session.
  sendPresence();
  await poll();
  return true;
}

/**
 * The read half of the single-stream route, split from the append half: one function doing path
 * parsing, authentication, live reads, and producer-header appends is over the complexity limit,
 * and the multiplexed route already separates opening from reading the same way.
 */
async function readCollabStreamSegment(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  actor: AuthenticatedManagementPrincipal,
  target: { containerId: string; segment: string },
  method: string,
  url: URL,
): Promise<boolean> {
  const offset = url.searchParams.get("offset");
  // A HEAD asks for the headers as they stand; holding one open would answer a different question.
  const live = method === "GET" ? url.searchParams.get("live") : null;
  if (live === "sse") {
    // ADR-0032 names live=sse for single-stream reads but never says how a single stream frames its
    // events — the multiplexed route is the one with a stated event contract. Say plainly that it
    // is missing rather than invent a framing, and rather than ignore the parameter and let a
    // one-shot body pass for a live one.
    sendJson(response, 501, {
      error: { code: "not_implemented", message: "single-stream sse is not available yet" },
    });
    return true;
  }
  if (live !== null && live !== "long-poll") {
    sendJson(response, 400, { error: { code: "invalid_request", message: "unknown live mode" } });
    return true;
  }

  const read = () =>
    plane.readCollabStream(actor, {
      containerId: target.containerId,
      segment: target.segment,
      ...(offset ? { fromOffset: offset } : {}),
    });
  let result = await read();
  if (live === "long-poll" && result.messages.length === 0) {
    await waitForContainerAppend(plane, request, target.containerId, target.segment);
    // The client may have hung up during the hold; writing to a gone response would only throw.
    if (request.destroyed || response.writableEnded) return true;
    result = await read();
  }

  const outcome = readOutcome(result);
  if (method === "HEAD") {
    response.writeHead(outcome.status, outcome.headers);
    response.end();
    return true;
  }
  sendStreamOutcome(response, outcome);
  return true;
}

async function handleCollabStreamRequest(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  url: URL,
  streamQuota: StreamAppendQuota,
): Promise<boolean> {
  if (!path.startsWith("/v1/ds/")) return false;
  if (method !== "PUT" && method !== "POST" && method !== "GET" && method !== "HEAD") return false;
  const target = parseStreamPath(path);
  if (!target) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "unknown container or segment" },
    });
    return true;
  }
  // Only the credential step is caught here. A refusal from authorization must keep its own status,
  // or a non-member would be answered differently from a bad token and the route would leak which
  // Workspaces exist.
  let actor: AuthenticatedManagementPrincipal;
  try {
    actor = await authenticateStreamCaller(plane, request, target.containerId);
  } catch {
    // Expired, revoked, wrong container, bad signature: all mean "this credential is not usable,
    // get another one", which is 401 rather than a malformed request.
    sendJson(response, 401, {
      error: { code: "unauthorized", message: "invalid or expired credential" },
    });
    return true;
  }

  if (method === "GET" || method === "HEAD") {
    return readCollabStreamSegment(plane, request, response, actor, target, method, url);
  }

  // Counted after authentication, so an unauthenticated flood cannot spend a member's allowance,
  // and before the body is read, so a refused caller does not get to stream a megabyte first.
  if (!streamQuota.allows(`${actor.principalId}\n${target.containerId}`)) {
    sendJson(response, 429, {
      error: { code: "too_many_requests", message: "append quota exceeded" },
    });
    return true;
  }
  const producer = parseProducerHeaders(request.headers);
  if (!producer) {
    sendJson(response, 400, {
      error: { code: "invalid_request", message: "missing or invalid producer headers" },
    });
    return true;
  }
  const update = await readStreamBody(request);
  if (!update) {
    sendJson(response, 413, {
      error: { code: "append_too_large", message: "append exceeds the stream limit" },
    });
    return true;
  }
  sendStreamOutcome(
    response,
    appendOutcome(
      await plane.appendCollabStream(actor, {
        containerId: target.containerId,
        segment: target.segment,
        producerId: producer.producerId,
        producerEpoch: producer.producerEpoch,
        producerSeq: producer.producerSeq,
        update: new Uint8Array(update),
      }),
    ),
  );
  return true;
}

async function handleRuntimeDistributionRequest(
  context: AuthenticatedRouteContext,
): Promise<boolean> {
  const { actor, body, method, path, plane, response } = context;
  if (method === "GET" && path === "/v1/runtime-artifacts") {
    sendJson(response, 200, { artifacts: await plane.listRuntimeArtifacts(actor) });
    return true;
  }
  if (method === "GET" && path === "/v1/runtime-policy") {
    sendJson(response, 200, { policy: await plane.getRuntimePolicy(actor) });
    return true;
  }
  if (method === "PUT" && path === "/v1/runtime-policy") {
    const input = ManagedRuntimePolicySettingsUpdateSchema.parse(parseJson(body));
    sendJson(response, 200, { policy: await plane.updateRuntimePolicySettings(actor, input) });
    return true;
  }
  if (method === "GET" && path === "/v1/runtime-status") {
    sendJson(response, 200, { nodes: await plane.listNodeRuntimeStatus(actor) });
    return true;
  }
  const pinMatch = /^\/v1\/runtime-pins\/([^/]+)$/.exec(path);
  if (method === "PUT" && pinMatch) {
    const input = ManagedRuntimePinUpdateSchema.parse(parseJson(body));
    sendJson(response, 200, {
      policy: await plane.setRuntimePin(actor, decodeURIComponent(pinMatch[1]!), input),
    });
    return true;
  }
  return false;
}

async function handleNodeRuntimeRequest(
  plane: EnterpriseManagementPlane,
  response: ServerResponse,
  method: string,
  path: string,
  nodeId: string,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (path === "/v1/node/runtime-policy") {
    sendJson(response, 200, { policy: plane.getNodeRuntimePolicy(nodeId) });
    return true;
  }
  const match = /^\/v1\/node\/runtime-artifacts\/([0-9a-f]{64})$/.exec(path);
  if (!match) return false;
  const filePath = plane.nodeRuntimeArtifactPath(nodeId, match[1]!);
  const { size } = await stat(filePath);
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    [MANAGED_RUNTIME_ARTIFACT_HEADERS.sha256]: match[1]!,
  });
  await pipeline(createReadStream(filePath), response);
  return true;
}

async function handleNodePlacementRequest(
  plane: EnterpriseManagementPlane,
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
  nodeId: string,
): Promise<boolean> {
  if (method === "GET" && path === "/v1/node/policy") {
    sendJson(response, 200, { principals: plane.getNodePolicy(nodeId) });
    return true;
  }
  if (method === "POST" && path === "/v1/node/placements") {
    const input = z
      .object({ resource: GlobalResourceRefSchema, ownerPrincipalId: z.string().min(1) })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 200, {
      placement: await plane.registerPlacement(nodeId, {
        ...input.resource,
        ownerPrincipalId: input.ownerPrincipalId,
      }),
    });
    return true;
  }
  if (method === "PUT" && path === "/v1/node/placements") {
    const input = ManagedPlacementSnapshotSchema.parse(parseJson(body));
    sendJson(response, 200, {
      placements: await plane.replaceNodePlacements(
        nodeId,
        input.placements.map(toPlacementRegistration),
      ),
    });
    return true;
  }
  return false;
}

function toPlacementRegistration(
  placement: z.infer<typeof ManagedPlacementSnapshotSchema>["placements"][number],
) {
  return {
    organizationId: placement.resource.organizationId,
    nodeId: placement.resource.nodeId,
    resourceKind: placement.resource.resourceKind,
    localResourceId: placement.resource.localResourceId,
    ownerPrincipalId: placement.ownerPrincipalId,
  };
}

async function handleNodeLeaseRequest(
  plane: EnterpriseManagementPlane,
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
  nodeId: string,
): Promise<boolean> {
  if (method !== "POST") return false;
  if (method === "POST" && path === "/v1/node/leases/acquire") {
    const input = LeaseAcquireInputSchema.parse(parseJson(body));
    sendJson(response, 201, { lease: await plane.acquireLease(nodeId, input) });
    return true;
  }
  if (path === "/v1/node/leases/renew") {
    const input = LeaseRenewInputSchema.parse(parseJson(body));
    sendJson(response, 200, { lease: await plane.renewLease(nodeId, input) });
    return true;
  }
  if (path === "/v1/node/leases/release") {
    const input = LeaseReleaseInputSchema.parse(parseJson(body));
    sendJson(response, 200, { released: await plane.releaseLease(nodeId, input) });
    return true;
  }
  if (path === "/v1/node/leases/validate") {
    const input = LeaseReleaseInputSchema.parse(parseJson(body));
    sendJson(response, 200, { lease: plane.validateLease(nodeId, input) });
    return true;
  }
  return false;
}

async function handleNodeAuditRequest(
  plane: EnterpriseManagementPlane,
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
  nodeId: string,
): Promise<boolean> {
  if (method === "POST" && path === "/v1/node/audit") {
    const input = z
      .object({ events: z.array(auditInputSchema).max(1_000) })
      .strict()
      .parse(parseJson(body));
    sendJson(response, 200, await plane.ingestAuditEvents(nodeId, input.events));
    return true;
  }
  if (method === "GET" && path === "/v1/node/audit/state") {
    sendJson(response, 200, { lastSequence: plane.auditLastSequence(nodeId) });
    return true;
  }
  return false;
}

const auditInputSchema = z
  .object({
    eventId: z.string().min(1),
    nodeId: z.string().min(1),
    nodeEventSeq: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    action: z.string().min(1),
    outcome: z.enum(["allowed", "denied", "failed"]),
    actorPrincipalId: z.string().min(1),
    resourceKind: z.string().min(1),
    resourceId: z.string().min(1),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    // Strict, so these have to be named here or a node carrying its chain is refused at the door.
    previousHash: z.string().min(1).optional(),
    eventHash: z.string().min(1).optional(),
  })
  .strict() satisfies z.ZodType<ManagementAuditInput>;

/**
 * The stream routes take either a personal access token or a stream token. The stream token only
 * identifies its holder; membership and the segment matrix still decide what that holder may do.
 */
async function authenticateStreamCaller(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
  containerId: string,
): Promise<AuthenticatedManagementPrincipal> {
  const bearer = requireBearer(request);
  if (bearer.startsWith("pst_v1.")) return plane.authenticateStreamToken(bearer, containerId);
  const principal = await plane.authenticatePersonalAccessToken(bearer);
  if (!principal) throw new Error("invalid credential");
  return principal;
}

async function authenticateUser(
  plane: EnterpriseManagementPlane,
  request: IncomingMessage,
): Promise<AuthenticatedManagementPrincipal> {
  const principal = await plane.authenticatePersonalAccessToken(requireBearer(request));
  if (!principal) throw new Error("invalid credential");
  return principal;
}

function requireBearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length <= 7) throw new Error("invalid credential");
  return value.slice(7);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("invalid JSON body", { cause: error });
  }
}

function enforceTls(request: IncomingMessage, options: ManagementRequestHandlerOptions): void {
  if ((request.socket as { encrypted?: boolean }).encrypted === true) return;
  if (
    options.allowInsecureLoopback === true &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")
  ) {
    return;
  }
  throw new Error("TLS is required");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function classifyError(message: string): number {
  if (message.includes("credential")) return 401;
  if (message.includes("denied") || message.includes("authorization")) return 403;
  if (
    message.includes("conflict") ||
    message.includes("already") ||
    message.includes("replay") ||
    message.includes("ambiguous")
  ) {
    return 409;
  }
  if (message.includes("unavailable") || message.includes("not found")) return 404;
  return 400;
}

function errorCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "too_many_requests";
  return "invalid_request";
}

const MANAGEMENT_UI = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paseo Enterprise</title><style>
:root{color-scheme:dark;background:#091018;color:#edf4fa;font:14px Inter,ui-sans-serif,system-ui}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,#173b53 0,transparent 34%),#091018}main{width:min(1280px,calc(100% - 32px));margin:auto;padding:38px 0 80px}header{display:flex;align-items:end;justify-content:space-between;gap:18px}h1{font-size:34px;letter-spacing:-.03em;margin:0 0 6px}h2{font-size:17px;margin:0 0 14px}h3{font-size:15px;margin:0}.muted{color:#8fa3b5}.login,.card,.item{background:#101a24;border:1px solid #263848;border-radius:14px}.login{display:flex;gap:10px;padding:14px;margin:24px 0}.card{padding:18px;margin:16px 0}.item{padding:14px;margin:10px 0;background:#0c151e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{padding:14px;border-radius:12px;background:#0b141c;border:1px solid #203443}.stat b{display:block;font-size:25px;margin-top:4px}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.between{justify-content:space-between}.stack{display:grid;gap:9px}input,select,textarea,button{font:inherit;background:#081018;color:#edf4fa;border:1px solid #365064;border-radius:9px;padding:9px 11px}input{min-width:160px;flex:1}textarea{width:100%;min-height:112px;resize:vertical;font:12px ui-monospace,SFMono-Regular,monospace}button{background:#2d9d78;border-color:#2d9d78;font-weight:650;cursor:pointer}button.secondary{background:#142432;border-color:#365064}button.danger{background:#8a3340;border-color:#a94452}button:disabled{opacity:.45;cursor:not-allowed}.pill{display:inline-block;border:1px solid #395267;border-radius:999px;padding:3px 8px;color:#b7c7d5;font-size:12px}.token{white-space:pre-wrap;overflow-wrap:anywhere;background:#071019;border:1px solid #31516a;border-radius:9px;padding:12px;color:#aee8cf}.hidden{display:none}.error{color:#ff9b9b}.success{color:#8fe0b7}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #21313f;padding:8px;vertical-align:top}@media(max-width:820px){header{align-items:start;flex-direction:column}.grid,.stats{grid-template-columns:1fr}.login{flex-direction:column}}</style></head>
<body><main><header><div><h1>Paseo Enterprise</h1><div class="muted">员工权限、Mac 节点、资源位置与审计</div></div><span id="identity" class="pill">未登录</span></header>
<div class="login"><input id="token" type="password" autocomplete="off" placeholder="员工、Boss 或管理员 PAT（只保存在此页面内存）"><button id="login">登录 / 刷新</button><button id="logout" class="secondary">清除</button></div>
<div id="notice" class="card hidden"></div><section id="stats" class="stats hidden"></section>
<div class="grid"><section class="card"><h2>创建人员</h2><div class="stack"><div class="row"><input id="name" placeholder="姓名"><input id="username" autocomplete="off" placeholder="登录账号（至少 3 位）"><select id="role"><option value="employee">员工</option><option value="boss">Boss</option><option value="platform_admin">平台管理员</option></select></div><div class="row"><input id="initial-password" type="password" autocomplete="new-password" placeholder="初始密码（至少 12 位）"><button id="create-person">创建账号</button></div></div></section>
<section class="card"><h2>节点注册码</h2><div class="row"><button id="create-enrollment">生成 10 分钟单次注册码</button><span class="muted">在新 Mac 的 enrollment 命令中使用</span></div></section></div>
<section class="card"><h2>人员与 Grant</h2><div id="people" class="muted">尚未登录</div></section>
<section class="card"><h2>节点</h2><div id="nodes" class="muted">尚未登录</div></section>
<section class="card"><h2>全局资源位置</h2><div id="placements" class="muted">尚未登录</div></section>
<section class="card"><h2>最近审计</h2><div id="audit" class="muted">尚未登录</div></section>
<script>
const q=(s)=>document.querySelector(s);const token=()=>q('#token').value.trim();
function element(tag,attrs={},children=[]){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs)){if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on'))node.addEventListener(key.slice(2),value);else if(value!==null&&value!==false)node.setAttribute(key,value)}for(const child of children)node.append(child);return node}
async function api(path,init={}){const response=await fetch(path,{...init,headers:{'content-type':'application/json','authorization':'Bearer '+token(),...(init.headers||{})}});const body=await response.json();if(!response.ok)throw Error(body.error&&body.error.message||response.statusText);return body}
function show(value,kind='success'){const notice=q('#notice');notice.className='card '+kind;notice.textContent=value;notice.classList.remove('hidden')}
function showSecret(label,value){const notice=q('#notice');notice.className='card';notice.replaceChildren(element('strong',{text:label}),element('div',{class:'muted',text:'该值只显示一次，请立即复制并安全保存。'}),element('div',{class:'token',text:value}),element('button',{class:'secondary',text:'复制',onclick:()=>navigator.clipboard.writeText(value)}));notice.classList.remove('hidden')}
function buildPaseoConnectionUri(endpoint,ticket){const url=new URL(endpoint);if(url.protocol!=='ws:'&&url.protocol!=='wss:')throw Error('节点返回了不支持的连接地址');const port=url.port||(url.protocol==='wss:'?'443':'80');const target=new URL('tcp://'+url.hostname+':'+port);if(url.protocol==='wss:')target.searchParams.set('ssl','true');target.searchParams.set('password',ticket);return target.toString()}
async function issueWorkspaceConnection(workspaceId){try{const value=await api('/v1/tickets/session',{method:'POST',body:JSON.stringify({workspaceId,clientId:'web_'+crypto.randomUUID(),ttlMs:300000})});showSecret('Paseo 连接地址（有效至 '+value.expiresAt+'）',buildPaseoConnectionUri(value.endpoint,value.ticket))}catch(error){show(error.message,'error')}}
async function issueNodeConnection(nodeId){try{const value=await api('/v1/tickets/node-session',{method:'POST',body:JSON.stringify({nodeId,clientId:'web_'+crypto.randomUUID(),ttlMs:300000})});showSecret('Paseo 节点连接地址（有效至 '+value.expiresAt+'）',buildPaseoConnectionUri(value.endpoint,value.ticket))}catch(error){show(error.message,'error')}}
async function loadAll(){try{const me=await api('/v1/me');q('#identity').textContent=me.principal.displayName+' · '+me.principal.role;const admin=me.principal.grants.some((g)=>g.action==='identity.manage');const auditAllowed=me.principal.grants.some((g)=>g.action==='audit.read');q('#create-person').disabled=!admin;q('#create-enrollment').disabled=!admin;const [principals,nodes,placements,audits]=await Promise.all([admin?api('/v1/principals'):Promise.resolve({principals:[]}),api('/v1/nodes'),api('/v1/placements'),auditAllowed?api('/v1/audit?limit=200'):Promise.resolve({events:[]})]);renderStats(principals.principals,nodes.nodes,placements.placements,audits.events);renderPeople(principals.principals,admin);renderNodes(nodes.nodes,admin);renderPlacements(placements.placements);renderAudit(audits.events);q('#stats').classList.remove('hidden')}catch(error){show(error.message,'error')}}
function renderStats(people,nodes,placements,events){const values=[['人员',people.length],['在线节点',nodes.filter((n)=>n.status==='active').length],['资源',placements.length],['审计',events.length]];q('#stats').replaceChildren(...values.map(([label,value])=>element('div',{class:'stat'},[element('span',{class:'muted',text:label}),element('b',{text:String(value)})])))}
function renderPeople(people,admin){const root=q('#people');if(!admin){root.textContent='当前账号不读取身份与 Grant 明细。';return}root.replaceChildren(...people.map((person)=>{const grants=element('textarea');grants.value=JSON.stringify(person.grants,null,2);const loginUsername=element('input',{autocomplete:'off',placeholder:'登录账号'});loginUsername.value=person.displayName.toLowerCase().replace(/[^a-z0-9._-]+/g,'.');const loginPassword=element('input',{type:'password',autocomplete:'new-password',placeholder:'新密码（至少 12 位）'});const save=element('button',{text:'保存 Grant',onclick:async()=>{try{await api('/v1/principals/'+person.principalId+'/grants',{method:'PUT',body:JSON.stringify({expectedGrantVersion:person.grantVersion,grants:JSON.parse(grants.value)})});show('权限已更新，各节点将在策略刷新周期内撤销旧代授权。');await loadAll()}catch(error){show(error.message,'error')}}});const setPassword=element('button',{class:'secondary',text:'设置账号密码',onclick:async()=>{const username=loginUsername.value.trim();const password=loginPassword.value;if(username.length<3||password.length<12){show('登录账号至少 3 位，密码至少 12 位。','error');return}try{await api('/v1/principals/'+person.principalId+'/password',{method:'PUT',body:JSON.stringify({username,password})});show(person.displayName+' 的账号密码已更新，旧会话票据已撤销。');await loadAll()}catch(error){show(error.message,'error')}finally{loginPassword.value=''}}});const issue=element('button',{class:'secondary',text:'签发 PAT',onclick:async()=>{try{const value=await api('/v1/principals/'+person.principalId+'/credentials',{method:'POST',body:'{}'});showSecret(person.displayName+' 的 PAT',value.token)}catch(error){show(error.message,'error')}}});const toggle=element('button',{class:'secondary',text:person.status==='active'?'停用':'启用',disabled:person.status==='revoked'?'disabled':null,onclick:async()=>{try{await api('/v1/principals/'+person.principalId+'/status',{method:'PUT',body:JSON.stringify({status:person.status==='active'?'disabled':'active'})});await loadAll()}catch(error){show(error.message,'error')}}});const revoke=element('button',{class:'danger',text:'永久吊销',disabled:person.status==='revoked'?'disabled':null,onclick:async()=>{if(!confirm('永久吊销 '+person.displayName+'？'))return;try{await api('/v1/principals/'+person.principalId+'/status',{method:'PUT',body:JSON.stringify({status:'revoked'})});await loadAll()}catch(error){show(error.message,'error')}}});return element('article',{class:'item stack'},[element('div',{class:'row between'},[element('h3',{text:person.displayName}),element('span',{class:'pill',text:person.role+' · '+person.status})]),element('div',{class:'muted',text:person.principalId+' · grant '+person.grantVersion}),grants,element('div',{class:'row'},[loginUsername,loginPassword,setPassword]),element('div',{class:'row'},[save,issue,toggle,revoke])])}));if(!people.length)root.textContent='暂无人员'}
function renderNodes(nodes,admin){const root=q('#nodes');root.replaceChildren(...nodes.map((node)=>{const buttons=[element('button',{class:'secondary',text:'生成节点连接地址',disabled:node.status!=='active'?'disabled':null,onclick:()=>issueNodeConnection(node.nodeId)}),...(admin?['active','draining','disabled','revoked'].map((status)=>element('button',{class:status==='revoked'?'danger':'secondary',text:status,disabled:node.status===status?'disabled':null,onclick:async()=>{try{await api('/v1/nodes/'+node.nodeId+'/status',{method:'PUT',body:JSON.stringify({status})});await loadAll()}catch(error){show(error.message,'error')}}})):[])];return element('article',{class:'item stack'},[element('div',{class:'row between'},[element('h3',{text:node.nodeId}),element('span',{class:'pill',text:node.status})]),element('div',{text:node.endpoint}),element('div',{class:'muted',text:'Paseo '+node.version+' · CPU '+node.capacity.cpuLogical+' · Agent '+node.capacity.activeAgents+' · Browser '+node.capacity.activeBrowserProfiles+' · last '+(node.lastSeenAt||'never')}),element('div',{class:'row'},buttons)])}));if(!nodes.length)root.textContent='暂无节点'}
function renderPlacements(placements){const root=q('#placements');root.replaceChildren(...placements.map((item)=>{const actions=[element('span',{class:'pill',text:item.resource.nodeId})];if(item.resource.resourceKind==='workspace')actions.push(element('button',{class:'secondary',text:'生成 5 分钟连接票据',onclick:()=>issueWorkspaceConnection(item.resource.localResourceId)}));return element('article',{class:'item row between'},[element('div',{},[element('strong',{text:item.resource.resourceKind+' · '+item.resource.localResourceId}),element('div',{class:'muted',text:'owner '+item.ownerPrincipalId})]),element('div',{class:'row'},actions)])}));if(!placements.length)root.textContent='节点尚未上报 Workspace / Agent / Browser Profile / App Slot。'}
function renderAudit(events){
  const root=q('#audit');
  if(!events.length){root.textContent='暂无可见审计事件。';return}
  const table=element('table');
  table.append(element('thead',{},[
    element('tr',{},['时间','节点','动作','结果','资源','员工'].map((value)=>element('th',{text:value})))
  ]));
  table.append(element('tbody',{},events.map((event)=>
    element('tr',{},[event.occurredAt,event.nodeId,event.action,event.outcome,event.resourceKind+':'+event.resourceId,event.actorPrincipalId].map((value)=>element('td',{text:String(value)})))
  )));
  root.replaceChildren(table)
}
q('#login').addEventListener('click',loadAll);q('#logout').addEventListener('click',()=>{q('#token').value='';q('#identity').textContent='未登录';q('#stats').classList.add('hidden');q('#people').textContent=q('#nodes').textContent=q('#placements').textContent=q('#audit').textContent='尚未登录';q('#notice').classList.add('hidden')});q('#create-person').addEventListener('click',async()=>{try{const created=await api('/v1/principals',{method:'POST',body:JSON.stringify({displayName:q('#name').value,principalType:'human',role:q('#role').value})});await api('/v1/principals/'+created.principal.principalId+'/password',{method:'PUT',body:JSON.stringify({username:q('#username').value,password:q('#initial-password').value})});show(created.principal.displayName+' 的账号已创建。');q('#name').value='';q('#username').value='';q('#initial-password').value='';await loadAll()}catch(error){q('#initial-password').value='';show(error.message,'error')}});q('#create-enrollment').addEventListener('click',async()=>{try{const value=await api('/v1/enrollment-tokens',{method:'POST',body:JSON.stringify({expiresInMs:600000})});showSecret('节点单次注册码（有效至 '+value.expiresAt+'）',value.token)}catch(error){show(error.message,'error')}});
</script></main></body></html>`;
