#!/usr/bin/env node

import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { app, BrowserWindow, ipcMain, session, webContents } from "electron";
import { WebSocket } from "ws";

import { parseBrowserProfileRuntimeAuthorization } from "../dist/features/browser-profile.js";
import {
  createBrowserPageIdentityPublisherRegistry,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWebviewRegistry,
  installBrowserPageIdentityTransportRoutes,
  installPaseoBrowserPageIdentityPublisher,
  preparePaseoBrowserWebContents,
  registerAttachedPaseoBrowserAfterPageIdentityBarrier,
  unregisterPaseoBrowserFromHost,
  unregisterPaseoBrowserHost,
} from "../dist/features/browser-webviews/index.js";

const OUTPUT_PREFIX = "CASE13 ";
const REQUEST_TIMEOUT_MS = 10_000;
const requiredEnvironment = [
  "PASEO_CASE13_AGENT_ID",
  "PASEO_CASE13_BROWSER_ID",
  "PASEO_CASE13_BROWSER_PROFILE_ID",
  "PASEO_CASE13_CLIENT_ID",
  "PASEO_CASE13_FINGERPRINT",
  "PASEO_CASE13_NODE_ID",
  "PASEO_CASE13_ORGANIZATION_ID",
  "PASEO_CASE13_PARTITION",
  "PASEO_CASE13_PATH_CANARY",
  "PASEO_CASE13_TOKEN",
  "PASEO_CASE13_USER_DATA",
  "PASEO_CASE13_WORKSPACE_ID",
  "PASEO_CASE13_WS_URL",
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing Case13 environment value ${name}.`);
  return value;
}

for (const name of requiredEnvironment) required(name);

const config = Object.freeze({
  agentId: required("PASEO_CASE13_AGENT_ID"),
  browserId: required("PASEO_CASE13_BROWSER_ID"),
  browserProfileId: required("PASEO_CASE13_BROWSER_PROFILE_ID"),
  clientId: required("PASEO_CASE13_CLIENT_ID"),
  fingerprint: required("PASEO_CASE13_FINGERPRINT"),
  nodeId: required("PASEO_CASE13_NODE_ID"),
  organizationId: required("PASEO_CASE13_ORGANIZATION_ID"),
  partition: required("PASEO_CASE13_PARTITION"),
  pathCanary: required("PASEO_CASE13_PATH_CANARY"),
  token: required("PASEO_CASE13_TOKEN"),
  userData: required("PASEO_CASE13_USER_DATA"),
  workspaceId: required("PASEO_CASE13_WORKSPACE_ID"),
  wsUrl: required("PASEO_CASE13_WS_URL"),
});

app.disableHardwareAcceleration();
app.setPath("userData", path.resolve(config.userData));

let socket;
let hostWindow;
let guestContents;
let targetServer;
let targetPort;
let publisherRegistry;
let publisherDisposer;
let transportController;
let transportPump;
let transportPumpActive = false;
let registry;
let authorization;
let storedGuardedContents;
let heldLease;
let requestSequence = 0;
let serverInfo;
let resolveServerInfo;
const serverInfoReady = new Promise((resolve) => {
  resolveServerInfo = resolve;
});
let closed = false;
let automationRequestCount = 0;
let contentResponseCount = 0;
let protectedOutboundCount = 0;
let rpcErrorCount = 0;
let authorityTeardownCount = 0;
const publisherErrors = [];
const outboundFrames = [];
const pendingRequests = new Map();

function sanitize(value) {
  return String(value)
    .split(config.token)
    .join("[redacted-token]")
    .split(config.fingerprint)
    .join("[redacted-fingerprint]")
    .split(config.pathCanary)
    .join("[redacted-path]");
}

function emit(value) {
  process.stdout.write(`${OUTPUT_PREFIX}${JSON.stringify(value)}\n`);
}

function nextRequestId(prefix) {
  requestSequence += 1;
  return `${prefix}-${requestSequence}`;
}

function messageRequestId(message) {
  return typeof message?.payload?.requestId === "string" ? message.payload.requestId : null;
}

function settlePending(message) {
  const requestId = messageRequestId(message);
  if (!requestId) return;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pendingRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(message);
}

function sendSessionRequest(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Case13 WebSocket is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(message.requestId);
      reject(new Error("Case13 WebSocket request timed out."));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(message.requestId, { resolve, reject, timeout });
    socket.send(JSON.stringify({ type: "session", message }));
  });
}

async function handleBrowserAutomationRequest(message) {
  automationRequestCount += 1;
  const request = message;
  let result;
  if (request.command.command === "list_tabs") {
    result = {
      command: "list_tabs",
      tabs: [
        {
          browserId: config.browserId,
          workspaceId: config.workspaceId,
          enterpriseContext: request.enterpriseContext,
          url: "https://redacted.invalid",
          title: "Case13 Electron page",
        },
      ],
    };
  } else if (request.command.command === "click") {
    if (!guestContents || guestContents.isDestroyed()) {
      throw new Error("Case13 guest WebContents is unavailable.");
    }
    const guardedContents = getPaseoBrowserWebContentsForHostWindow(
      config.browserId,
      hostWindow.webContents.id,
    );
    if (!guardedContents) {
      throw new Error("Case13 guarded guest WebContents is unavailable.");
    }
    const clicked = await guardedContents.executeJavaScript(
      "document.querySelector('#case13-target')?.click(); document.querySelector('#case13-target')?.textContent",
      true,
    );
    if (clicked !== "clicked") throw new Error("Case13 target click did not execute.");
    result = {
      command: "click",
      browserId: config.browserId,
      ref: request.command.args.ref,
    };
  } else {
    socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "browser.automation.execute.response",
          payload: {
            requestId: request.requestId,
            ok: false,
            enterpriseContext: request.enterpriseContext,
            error: {
              code: "browser_command_unsupported",
              message: "Unsupported Case13 command.",
              retryable: false,
            },
          },
        },
      }),
    );
    return;
  }
  socket.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "browser.automation.execute.response",
        payload: {
          requestId: request.requestId,
          ok: true,
          enterpriseContext: request.enterpriseContext,
          result,
        },
      },
    }),
  );
}

function captureOutbound(frame) {
  const text = frame.toString();
  outboundFrames.push(text);
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return;
  }
  if (envelope?.type !== "session") return;
  const message = envelope.message;
  if (message?.payload?.status === "server_info") {
    serverInfo = envelope;
    resolveServerInfo(envelope);
  }
  if (message?.type === "enterprise.browser_profile.content.read.response") {
    contentResponseCount += 1;
    protectedOutboundCount += 1;
  }
  if (message?.type === "browser.automation.execute.request") {
    protectedOutboundCount += 1;
    void handleBrowserAutomationRequest(message).catch((error) => {
      publisherErrors.push(sanitize(error));
    });
  }
  if (message?.type === "rpc_error") rpcErrorCount += 1;
  settlePending(message);
}

async function connect() {
  socket = new WebSocket(config.wsUrl, [`paseo.bearer.${config.token}`]);
  socket.on("message", captureOutbound);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: config.clientId,
      clientType: "browser",
      protocolVersion: 1,
      capabilities: {
        browser_host: {
          hostKind: "desktop app",
          supportedCommands: ["list_tabs", "click"],
        },
      },
    }),
  );
  serverInfo = await Promise.race([
    serverInfoReady,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Case13 server_info timed out.")), REQUEST_TIMEOUT_MS),
    ),
  ]);
  const features = serverInfo.message?.payload?.features ?? {};
  emit({
    kind: "event",
    event: "ready",
    flags: {
      observation: features.enterpriseBrowserPageIdentityObservationV1 === true,
      invalidation: features.enterpriseBrowserPageIdentityInvalidationV1 === true,
    },
  });
}

async function startTargetServer() {
  targetServer = createServer((_request, response) => {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(
      '<!doctype html><html><body><button id="case13-target" onclick="this.textContent=\'clicked\'">ready</button></body></html>',
    );
  });
  await new Promise((resolve, reject) => {
    targetServer.once("error", reject);
    targetServer.listen(0, "127.0.0.1", resolve);
  });
  const address = targetServer.address();
  if (!address || typeof address === "string") throw new Error("Case13 target did not bind TCP.");
  targetPort = address.port;
}

function targetUrl(hostname) {
  return `http://${hostname}:${targetPort}/${config.pathCanary}`;
}

async function publishPayload(payload, operation) {
  const requestId = nextRequestId(operation);
  const response = await sendSessionRequest({
    type: `enterprise.browser.page_identity.${operation}.request`,
    requestId,
    ...payload,
  });
  const expected = `enterprise.browser.page_identity.${operation}.response`;
  if (
    response.type !== expected ||
    response.payload?.acceptedRevision !== payload.observationRevision
  ) {
    throw new Error("Case13 page identity request was rejected.");
  }
}

async function respondToRenderer(response) {
  if (!hostWindow || hostWindow.isDestroyed()) {
    throw new Error("Case13 host renderer is unavailable.");
  }
  await hostWindow.webContents.executeJavaScript(
    `window.paseoDesktop.browser.pageIdentityTransport.respond(${JSON.stringify(response)})`,
    true,
  );
}

async function pumpTransportRequests() {
  if (transportPumpActive || !hostWindow || hostWindow.isDestroyed()) return;
  transportPumpActive = true;
  try {
    const requests = await hostWindow.webContents.executeJavaScript(
      "window.__case13PageIdentityRequests?.splice(0) ?? []",
      true,
    );
    for (const request of requests) {
      if (request.operation === "fatal_teardown") {
        authorityTeardownCount += 1;
        await respondToRenderer({
          requestId: request.requestId,
          operation: request.operation,
          result: { ok: true },
        });
        continue;
      }
      try {
        await publishPayload(request.payload, request.operation);
        await respondToRenderer({
          requestId: request.requestId,
          operation: request.operation,
          result: { ok: true, acceptedRevision: request.payload.observationRevision },
        });
      } catch (error) {
        publisherErrors.push(sanitize(error));
        await respondToRenderer({
          requestId: request.requestId,
          operation: request.operation,
          result: { ok: false, code: "daemon_request_failed" },
        });
      }
    }
  } finally {
    transportPumpActive = false;
  }
}

async function attachGuest(hostname) {
  const attached = new Promise((resolve) => {
    hostWindow.webContents.once("did-attach-webview", (_event, contents) => {
      preparePaseoBrowserWebContents(contents);
      resolve(contents);
    });
  });
  const descriptor = JSON.stringify({
    partition: config.partition,
    src: targetUrl(hostname),
  });
  await hostWindow.webContents.executeJavaScript(
    `(() => {
      const descriptor = ${descriptor};
      const prior = document.querySelector('webview');
      prior?.remove();
      const view = document.createElement('webview');
      view.setAttribute('partition', descriptor.partition);
      view.setAttribute('src', descriptor.src);
      document.body.append(view);
    })()`,
    true,
  );
  const contents = await attached;
  if (contents.isLoading()) {
    await new Promise((resolve) => contents.once("did-finish-load", resolve));
  }
  return contents;
}

async function configure(input) {
  if (publisherRegistry) throw new Error("Case13 publisher is already configured.");
  authorization = parseBrowserProfileRuntimeAuthorization({
    organizationId: config.organizationId,
    homeNodeId: config.nodeId,
    workspaceId: config.workspaceId,
    browserProfileId: config.browserProfileId,
    bindingRevision: input.bindingRevision,
    lifecycleGeneration: input.lifecycleGeneration,
  });
  registry = getPaseoBrowserWebviewRegistry();
  publisherRegistry = createBrowserPageIdentityPublisherRegistry({
    registry,
    onError: (error) => publisherErrors.push(sanitize(error)),
  });
  publisherDisposer = await installPaseoBrowserPageIdentityPublisher(publisherRegistry);
  transportController = installBrowserPageIdentityTransportRoutes({
    ipcMain,
    routeLifecycle: publisherRegistry.routeLifecycle,
  });
  hostWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.resolve(process.cwd(), "packages/desktop/dist/preload.js"),
      sandbox: false,
      webviewTag: true,
    },
  });
  await hostWindow.loadURL("data:text/html,<html><body></body></html>");
  await hostWindow.webContents.executeJavaScript(
    `(() => {
      window.__case13PageIdentityRequests = [];
      return window.paseoDesktop.browser.pageIdentityTransport.mount((request) => {
        window.__case13PageIdentityRequests.push(request);
      });
    })()`,
    true,
  );
  transportPump = setInterval(() => void pumpTransportRequests(), 5);
  guestContents = await attachGuest(input.initialHostname ?? "127.0.0.1");
  const profileSession = session.fromPartition(config.partition);
  const registered = await registerAttachedPaseoBrowserAfterPageIdentityBarrier({
    webContentsId: guestContents.id,
    browserId: config.browserId,
    workspaceId: config.workspaceId,
    profileAuthorization: authorization,
    sender: hostWindow.webContents,
    profileSession,
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) throw new Error("Case13 production guest registration was rejected.");
  return {
    executionAllowed: publisherRegistry.isExecutionAllowed(guestContents.id),
    actualGuestHost: guestContents.hostWebContents === hostWindow.webContents,
    actualProfileSession: guestContents.session === profileSession,
    actualWebContents: guestContents.id > 0,
  };
}

async function navigate(hostname) {
  if (!publisherRegistry || !guestContents || guestContents.isDestroyed()) {
    throw new Error("Case13 publisher is unavailable.");
  }
  let executionAllowedAtStart = null;
  const started = new Promise((resolve) => {
    guestContents.once("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame !== true) return;
      executionAllowedAtStart = publisherRegistry.isExecutionAllowed(guestContents.id);
      resolve();
    });
  });
  const loaded = guestContents.loadURL(targetUrl(hostname));
  await started;
  await loaded;
  await publisherRegistry.publishCurrent(guestContents);
  return {
    executionAllowedAtStart,
    executionAllowedAfterCommit: publisherRegistry.isExecutionAllowed(guestContents.id),
  };
}

async function rebind() {
  if (
    !publisherRegistry ||
    !registry ||
    !guestContents ||
    guestContents.isDestroyed() ||
    !authorization
  ) {
    throw new Error("Case13 rebind state is unavailable.");
  }
  storedGuardedContents = getPaseoBrowserWebContentsForHostWindow(
    config.browserId,
    hostWindow.webContents.id,
  );
  if (!storedGuardedContents) throw new Error("Case13 guarded guest is unavailable.");
  await unregisterPaseoBrowserFromHost(hostWindow.webContents.id, config.browserId);
  guestContents = await attachGuest("localhost");
  const profileSession = session.fromPartition(config.partition);
  const registered = await registerAttachedPaseoBrowserAfterPageIdentityBarrier({
    webContentsId: guestContents.id,
    browserId: config.browserId,
    workspaceId: config.workspaceId,
    profileAuthorization: authorization,
    sender: hostWindow.webContents,
    profileSession,
    findWebContents: (webContentsId) => webContents.fromId(webContentsId) ?? null,
  });
  if (!registered) throw new Error("Case13 rebound guest registration was rejected.");
  let oldExecutionCurrent = true;
  try {
    await storedGuardedContents.executeJavaScript("true", true);
  } catch {
    oldExecutionCurrent = false;
  }
  return {
    oldExecutionCurrent,
    executionAllowed: publisherRegistry.isExecutionAllowed(guestContents.id),
    actualGuestHost: guestContents.hostWebContents === hostWindow.webContents,
    actualProfileSession: guestContents.session === profileSession,
  };
}

async function acquireLease() {
  if (heldLease) throw new Error("Case13 setup lease is already held.");
  const requestId = nextRequestId("acquire-lease");
  const response = await sendSessionRequest({
    type: "enterprise.resource.acquire_lease.request",
    requestId,
    workspaceId: config.workspaceId,
    agentId: config.agentId,
    resourceKind: "browser_profile",
    mode: "read",
  });
  const lease = response.payload?.lease;
  if (
    response.type !== "enterprise.resource.acquire_lease.response" ||
    !lease ||
    lease.resourceKind !== "browser_profile" ||
    lease.mode !== "read"
  ) {
    throw new Error("Case13 production setup lease acquisition failed.");
  }
  heldLease = lease;
  return {
    acquired: true,
    resourceKind: lease.resourceKind,
    mode: lease.mode,
  };
}

async function releaseLease() {
  if (!heldLease) return { released: false };
  const lease = heldLease;
  const response = await sendSessionRequest({
    type: "enterprise.resource.release_lease.request",
    requestId: nextRequestId("release-lease"),
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
  });
  if (
    response.type !== "enterprise.resource.release_lease.response" ||
    response.payload?.released !== true
  ) {
    throw new Error("Case13 production setup lease release failed.");
  }
  heldLease = undefined;
  return { released: true };
}

function stats() {
  const serialized = outboundFrames.join("\n");
  const leakCount = [config.token, config.fingerprint, config.pathCanary].filter((canary) =>
    serialized.includes(canary),
  ).length;
  return {
    outboundFrameCount: outboundFrames.length,
    outboundByteLength: Buffer.byteLength(serialized),
    automationRequestCount,
    contentResponseCount,
    protectedOutboundCount,
    rpcErrorCount,
    leakCount,
    publisherErrorCount: publisherErrors.length,
    authorityTeardownCount,
  };
}

async function shutdown() {
  if (closed) return;
  closed = true;
  if (transportPump) clearInterval(transportPump);
  await releaseLease().catch(() => undefined);
  if (hostWindow && !hostWindow.isDestroyed()) {
    await unregisterPaseoBrowserHost(hostWindow.webContents.id).catch(() => undefined);
    await hostWindow.webContents
      .executeJavaScript("window.paseoDesktop.browser.pageIdentityTransport.dispose()", true)
      .catch(() => undefined);
    await transportController?.retireRoute(hostWindow.webContents).catch(() => undefined);
  }
  await transportController?.close().catch(() => undefined);
  await publisherDisposer?.().catch(() => undefined);
  if (hostWindow && !hostWindow.isDestroyed()) hostWindow.destroy();
  if (socket) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Case13 driver is closing."));
    }
    pendingRequests.clear();
    socket.close();
  }
  if (targetServer) {
    await new Promise((resolve) => targetServer.close(resolve));
  }
}

async function handleCommand(command) {
  switch (command.command) {
    case "configure":
      return configure(command);
    case "acquire_lease":
      return acquireLease();
    case "navigate_match":
      return navigate("localhost");
    case "navigate_mismatch":
      return navigate("127.0.0.1");
    case "rebind":
      return rebind();
    case "invalidate":
      await unregisterPaseoBrowserFromHost(hostWindow.webContents.id, config.browserId);
      return { executionAllowed: publisherRegistry.isExecutionAllowed(guestContents.id) };
    case "stats":
      return stats();
    case "shutdown":
      await shutdown();
      return { closed: true };
    default:
      throw new Error("Unknown Case13 driver command.");
  }
}

async function main() {
  await app.whenReady();
  await startTargetServer();
  if (process.env.PASEO_CASE13_SMOKE === "1") {
    const smokeWindow = new BrowserWindow({
      show: false,
      webPreferences: { webviewTag: true },
    });
    const attached = new Promise((resolve) => {
      smokeWindow.webContents.once("did-attach-webview", (_event, guest) => resolve(guest));
    });
    const document = `<!doctype html><html><body><webview partition="${config.partition}" src="${targetUrl("127.0.0.1")}"></webview></body></html>`;
    await smokeWindow.loadURL(`data:text/html,${encodeURIComponent(document)}`);
    const guest = await attached;
    if (guest.isLoading()) {
      await new Promise((resolve) => guest.once("did-finish-load", resolve));
    }
    emit({
      kind: "smoke",
      hostname: new URL(guest.getURL()).hostname,
      actualWebContents: guest.id > 0,
      actualGuestHost: guest.hostWebContents === smokeWindow.webContents,
      actualProfileSession: guest.session === session.fromPartition(config.partition),
    });
    smokeWindow.destroy();
    await new Promise((resolve) => targetServer.close(resolve));
    app.quit();
    return;
  }
  await connect();
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      let command;
      try {
        command = JSON.parse(line);
        const result = await handleCommand(command);
        emit({ kind: "response", id: command.id, ok: true, result });
        if (command.command === "shutdown") app.quit();
      } catch (error) {
        emit({
          kind: "response",
          id: command?.id ?? "invalid",
          ok: false,
          error: sanitize(error instanceof Error ? error.message : error),
        });
      }
    })();
  });
}

main().catch((error) => {
  emit({ kind: "fatal", error: sanitize(error instanceof Error ? error.stack : error) });
  app.exit(1);
});
