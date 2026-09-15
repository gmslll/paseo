import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { ProbeStateSchema, type ProbeState } from "@getpaseo/protocol/local-planes";

import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";
import { closePlaneServer, listenOnPlaneEndpoint } from "./unix-socket-listener.js";

// The probe plane answers health and state for local tooling (ADR-0038). Anyone who can reach the
// socket can read it, so the state carries no Principal, Grant, or credential data.

export interface ProbePlaneServer {
  readonly endpoint: LocalPlaneSocketEndpoint;
  close(): Promise<void>;
}

export interface StartProbePlaneInput {
  endpoint: LocalPlaneSocketEndpoint;
  readState: () => Promise<ProbeState>;
  logger: Logger;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function handleProbeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  input: StartProbePlaneInput,
): Promise<void> {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  const { pathname } = new URL(request.url ?? "/", "http://probe.local");
  if (pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (pathname !== "/state") {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  try {
    sendJson(response, 200, ProbeStateSchema.parse(await input.readState()));
  } catch (error) {
    input.logger.error({ err: error }, "Local probe state is unavailable");
    sendJson(response, 500, { error: "state_unavailable" });
  }
}

export async function startProbePlane(input: StartProbePlaneInput): Promise<ProbePlaneServer> {
  const server = createServer((request, response) => {
    void handleProbeRequest(request, response, input);
  });
  await listenOnPlaneEndpoint(server, input.endpoint);
  return {
    endpoint: input.endpoint,
    close: () => closePlaneServer(server, input.endpoint),
  };
}
