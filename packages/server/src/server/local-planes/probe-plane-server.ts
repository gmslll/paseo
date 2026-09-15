import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import { ProbeStateSchema, type ProbeState } from "@getpaseo/protocol/local-planes";

import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";

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

/** A socket file left by a crashed daemon is replaced; any other file at the path is an error. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) {
      throw new Error(`Refusing to replace ${socketPath}: it is not a socket`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export async function startProbePlane(input: StartProbePlaneInput): Promise<ProbePlaneServer> {
  const server = createServer((request, response) => {
    void handleProbeRequest(request, response, input);
  });
  const isUnix = input.endpoint.transport === "unix";
  if (isUnix) await removeStaleSocket(input.endpoint.path);
  await listen(server, input.endpoint.path);
  if (isUnix) await chmod(input.endpoint.path, 0o600);
  return {
    endpoint: input.endpoint,
    async close() {
      await closeServer(server);
      if (isUnix) {
        await unlink(input.endpoint.path).catch(() => undefined);
      }
    },
  };
}
