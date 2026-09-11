import { readFileSync } from "node:fs";
import { createServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  GlobalResourceRefSchema,
  LeaseAcquireInputSchema,
  LeaseReleaseInputSchema,
  LeaseRenewInputSchema,
  ResourceGrantSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

import {
  EnterpriseManagementPlane,
  type AuthenticatedManagementPrincipal,
  type EnrollmentRequest,
  type ManagementAuditInput,
} from "./management-plane.js";
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
}

export function createManagementRequestHandler(
  plane: EnterpriseManagementPlane,
  options: ManagementRequestHandlerOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleRequest(plane, request, response, options).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const message = error instanceof Error ? error.message : "request failed";
      const status = classifyError(message);
      sendJson(response, status, { error: { code: errorCode(status), message } });
    });
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
): Promise<void> {
  enforceTls(request, options);
  const method = request.method?.toUpperCase() ?? "GET";
  const url = new URL(request.url ?? "/", "https://management.invalid");
  const path = url.pathname;
  if (handlePublicGet(plane, response, method, path)) return;

  const body = method === "GET" || method === "HEAD" ? "" : await readBody(request);
  if (await handleUnauthenticatedPost(plane, response, method, path, body)) return;

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
  if (await handlePrincipalRequest(context)) return;
  if (await handleManagementInventoryRequest(context)) return;
  if (await handleTicketRequest(context)) return;
  sendJson(response, 404, { error: { code: "not_found", message: "route not found" } });
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
  response: ServerResponse,
  method: string,
  path: string,
  body: string,
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
  return false;
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
  if (await handleNodePlacementRequest(plane, response, method, path, body, node.nodeId)) return;
  if (await handleNodeLeaseRequest(plane, response, method, path, body, node.nodeId)) return;
  if (await handleNodeAuditRequest(plane, response, method, path, body, node.nodeId)) return;
  sendJson(response, 404, { error: { code: "not_found", message: "route not found" } });
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
  })
  .strict() satisfies z.ZodType<ManagementAuditInput>;

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
  return "invalid_request";
}

const MANAGEMENT_UI = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paseo Enterprise</title><style>
:root{color-scheme:dark;background:#091018;color:#edf4fa;font:14px Inter,ui-sans-serif,system-ui}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,#173b53 0,transparent 34%),#091018}main{width:min(1280px,calc(100% - 32px));margin:auto;padding:38px 0 80px}header{display:flex;align-items:end;justify-content:space-between;gap:18px}h1{font-size:34px;letter-spacing:-.03em;margin:0 0 6px}h2{font-size:17px;margin:0 0 14px}h3{font-size:15px;margin:0}.muted{color:#8fa3b5}.login,.card,.item{background:#101a24;border:1px solid #263848;border-radius:14px}.login{display:flex;gap:10px;padding:14px;margin:24px 0}.card{padding:18px;margin:16px 0}.item{padding:14px;margin:10px 0;background:#0c151e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{padding:14px;border-radius:12px;background:#0b141c;border:1px solid #203443}.stat b{display:block;font-size:25px;margin-top:4px}.row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.between{justify-content:space-between}.stack{display:grid;gap:9px}input,select,textarea,button{font:inherit;background:#081018;color:#edf4fa;border:1px solid #365064;border-radius:9px;padding:9px 11px}input{min-width:160px;flex:1}textarea{width:100%;min-height:112px;resize:vertical;font:12px ui-monospace,SFMono-Regular,monospace}button{background:#2d9d78;border-color:#2d9d78;font-weight:650;cursor:pointer}button.secondary{background:#142432;border-color:#365064}button.danger{background:#8a3340;border-color:#a94452}button:disabled{opacity:.45;cursor:not-allowed}.pill{display:inline-block;border:1px solid #395267;border-radius:999px;padding:3px 8px;color:#b7c7d5;font-size:12px}.token{white-space:pre-wrap;overflow-wrap:anywhere;background:#071019;border:1px solid #31516a;border-radius:9px;padding:12px;color:#aee8cf}.hidden{display:none}.error{color:#ff9b9b}.success{color:#8fe0b7}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #21313f;padding:8px;vertical-align:top}@media(max-width:820px){header{align-items:start;flex-direction:column}.grid,.stats{grid-template-columns:1fr}.login{flex-direction:column}}</style></head>
<body><main><header><div><h1>Paseo Enterprise</h1><div class="muted">员工权限、Mac 节点、资源位置与审计</div></div><span id="identity" class="pill">未登录</span></header>
<div class="login"><input id="token" type="password" autocomplete="off" placeholder="员工、Boss 或管理员 PAT（只保存在此页面内存）"><button id="login">登录 / 刷新</button><button id="logout" class="secondary">清除</button></div>
<div id="notice" class="card hidden"></div><section id="stats" class="stats hidden"></section>
<div class="grid"><section class="card"><h2>创建人员</h2><div class="row"><input id="name" placeholder="姓名"><select id="role"><option value="employee">员工</option><option value="boss">Boss</option><option value="platform_admin">平台管理员</option></select><button id="create-person">创建并签发 PAT</button></div></section>
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
async function loadAll(){try{const me=await api('/v1/me');q('#identity').textContent=me.principal.displayName+' · '+me.principal.role;const admin=me.principal.grants.some((g)=>g.action==='identity.manage');const auditAllowed=me.principal.grants.some((g)=>g.action==='audit.read');q('#create-person').disabled=!admin;q('#create-enrollment').disabled=!admin;const [principals,nodes,placements,audits]=await Promise.all([admin?api('/v1/principals'):Promise.resolve({principals:[]}),api('/v1/nodes'),api('/v1/placements'),auditAllowed?api('/v1/audit?limit=200'):Promise.resolve({events:[]})]);renderStats(principals.principals,nodes.nodes,placements.placements,audits.events);renderPeople(principals.principals,admin);renderNodes(nodes.nodes,admin);renderPlacements(placements.placements);renderAudit(audits.events);q('#stats').classList.remove('hidden')}catch(error){show(error.message,'error')}}
function renderStats(people,nodes,placements,events){const values=[['人员',people.length],['在线节点',nodes.filter((n)=>n.status==='active').length],['资源',placements.length],['审计',events.length]];q('#stats').replaceChildren(...values.map(([label,value])=>element('div',{class:'stat'},[element('span',{class:'muted',text:label}),element('b',{text:String(value)})])))}
function renderPeople(people,admin){const root=q('#people');if(!admin){root.textContent='当前账号不读取身份与 Grant 明细。';return}root.replaceChildren(...people.map((person)=>{const grants=element('textarea');grants.value=JSON.stringify(person.grants,null,2);const save=element('button',{text:'保存 Grant',onclick:async()=>{try{await api('/v1/principals/'+person.principalId+'/grants',{method:'PUT',body:JSON.stringify({expectedGrantVersion:person.grantVersion,grants:JSON.parse(grants.value)})});show('权限已更新，各节点将在策略刷新周期内撤销旧代授权。');await loadAll()}catch(error){show(error.message,'error')}}});const issue=element('button',{class:'secondary',text:'签发 PAT',onclick:async()=>{try{const value=await api('/v1/principals/'+person.principalId+'/credentials',{method:'POST',body:'{}'});showSecret(person.displayName+' 的 PAT',value.token)}catch(error){show(error.message,'error')}}});const toggle=element('button',{class:'secondary',text:person.status==='active'?'停用':'启用',disabled:person.status==='revoked'?'disabled':null,onclick:async()=>{try{await api('/v1/principals/'+person.principalId+'/status',{method:'PUT',body:JSON.stringify({status:person.status==='active'?'disabled':'active'})});await loadAll()}catch(error){show(error.message,'error')}}});const revoke=element('button',{class:'danger',text:'永久吊销',disabled:person.status==='revoked'?'disabled':null,onclick:async()=>{if(!confirm('永久吊销 '+person.displayName+'？'))return;try{await api('/v1/principals/'+person.principalId+'/status',{method:'PUT',body:JSON.stringify({status:'revoked'})});await loadAll()}catch(error){show(error.message,'error')}}});return element('article',{class:'item stack'},[element('div',{class:'row between'},[element('h3',{text:person.displayName}),element('span',{class:'pill',text:person.role+' · '+person.status})]),element('div',{class:'muted',text:person.principalId+' · grant '+person.grantVersion}),grants,element('div',{class:'row'},[save,issue,toggle,revoke])])}));if(!people.length)root.textContent='暂无人员'}
function renderNodes(nodes,admin){const root=q('#nodes');root.replaceChildren(...nodes.map((node)=>{const buttons=admin?['active','draining','disabled','revoked'].map((status)=>element('button',{class:status==='revoked'?'danger':'secondary',text:status,disabled:node.status===status?'disabled':null,onclick:async()=>{try{await api('/v1/nodes/'+node.nodeId+'/status',{method:'PUT',body:JSON.stringify({status})});await loadAll()}catch(error){show(error.message,'error')}}})):[];return element('article',{class:'item stack'},[element('div',{class:'row between'},[element('h3',{text:node.nodeId}),element('span',{class:'pill',text:node.status})]),element('div',{text:node.endpoint}),element('div',{class:'muted',text:'Paseo '+node.version+' · CPU '+node.capacity.cpuLogical+' · Agent '+node.capacity.activeAgents+' · Browser '+node.capacity.activeBrowserProfiles+' · last '+(node.lastSeenAt||'never')}),element('div',{class:'row'},buttons)])}));if(!nodes.length)root.textContent='暂无节点'}
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
q('#login').addEventListener('click',loadAll);q('#logout').addEventListener('click',()=>{q('#token').value='';q('#identity').textContent='未登录';q('#stats').classList.add('hidden');q('#people').textContent=q('#nodes').textContent=q('#placements').textContent=q('#audit').textContent='尚未登录';q('#notice').classList.add('hidden')});q('#create-person').addEventListener('click',async()=>{try{const created=await api('/v1/principals',{method:'POST',body:JSON.stringify({displayName:q('#name').value,principalType:'human',role:q('#role').value})});const issued=await api('/v1/principals/'+created.principal.principalId+'/credentials',{method:'POST',body:'{}'});showSecret(created.principal.displayName+' 的 PAT',issued.token);q('#name').value='';await loadAll()}catch(error){show(error.message,'error')}});q('#create-enrollment').addEventListener('click',async()=>{try{const value=await api('/v1/enrollment-tokens',{method:'POST',body:JSON.stringify({expiresInMs:600000})});showSecret('节点单次注册码（有效至 '+value.expiresAt+'）',value.token)}catch(error){show(error.message,'error')}});
</script></main></body></html>`;
