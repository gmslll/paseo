import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Logger } from "pino";
import {
  LOCAL_PLANE_TOKEN_HEADER,
  LOCAL_PLANE_UPGRADE_PROTOCOLS,
} from "@getpaseo/protocol/local-planes";

import type { EnterpriseAdmissionAuthenticationEvidence } from "../enterprise/identity/admission-authorization.js";
import type { WebSocketLike } from "../websocket-server.js";
import { localTokenMatches } from "./local-token.js";
import { NdjsonSocketAdapter } from "./ndjson-socket.js";
import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";
import { closePlaneServer, listenOnPlaneEndpoint } from "./unix-socket-listener.js";

// The control plane carries an ordinary daemon Session over `paseo-ndjson/1` (ADR-0038). The local
// token proves the caller can read $PASEO_HOME/run; an enterprise daemon also requires a PAT or
// Session Ticket, so holding the socket never grants Owner authority there.

const CONTROL_PROTOCOL = LOCAL_PLANE_UPGRADE_PROTOCOLS.control;
const SESSION_PATH = "/v1/session";
const CLOSE_INTERNAL_ERROR = 1011;

export type ControlPlaneAuthentication =
  | { kind: "allowed"; evidence?: EnterpriseAdmissionAuthenticationEvidence }
  | { kind: "denied" };

export interface ControlPlaneAdmission {
  /** Receives the bearer credential from the Authorization header, or null when there is none. */
  authenticate(bearer: string | null): Promise<ControlPlaneAuthentication>;
  attach(
    socket: WebSocketLike,
    evidence?: EnterpriseAdmissionAuthenticationEvidence,
  ): Promise<void>;
}

export interface ControlPlaneServer {
  readonly endpoint: LocalPlaneSocketEndpoint;
  close(): Promise<void>;
}

export interface StartControlPlaneInput {
  endpoint: LocalPlaneSocketEndpoint;
  token: string;
  admission: ControlPlaneAdmission;
  logger: Logger;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerFrom(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue(request, "authorization")?.trim() ?? "");
  return match?.[1] ?? null;
}

function rejectUpgrade(socket: Socket, status: 400 | 401, statusText: string): void {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function authenticateUpgrade(
  request: IncomingMessage,
  input: StartControlPlaneInput,
): Promise<ControlPlaneAuthentication> {
  if (!localTokenMatches(input.token, headerValue(request, LOCAL_PLANE_TOKEN_HEADER))) {
    return { kind: "denied" };
  }
  try {
    return await input.admission.authenticate(bearerFrom(request));
  } catch (error) {
    input.logger.warn({ err: error }, "Control plane authentication failed");
    return { kind: "denied" };
  }
}

async function handleUpgrade(input: {
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
  plane: StartControlPlaneInput;
  upgraded: Set<Socket>;
}): Promise<void> {
  const { request, socket, plane } = input;
  const { pathname } = new URL(request.url ?? "/", "http://control.local");
  if (
    request.method !== "POST" ||
    pathname !== SESSION_PATH ||
    headerValue(request, "upgrade") !== CONTROL_PROTOCOL
  ) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }
  const authentication = await authenticateUpgrade(request, plane);
  if (authentication.kind === "denied" || socket.destroyed) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${CONTROL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
  );
  input.upgraded.add(socket);
  socket.once("close", () => input.upgraded.delete(socket));
  const adapter = new NdjsonSocketAdapter(socket, input.head);
  try {
    await plane.admission.attach(adapter, authentication.evidence);
  } catch (error) {
    plane.logger.warn({ err: error }, "Control plane Session attach failed");
    adapter.close(CLOSE_INTERNAL_ERROR, "Session attach failed");
  }
}

export async function startControlPlane(
  input: StartControlPlaneInput,
): Promise<ControlPlaneServer> {
  const upgraded = new Set<Socket>();
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://control.local");
    const upgradeRequired = pathname === SESSION_PATH;
    response.writeHead(upgradeRequired ? 426 : 404, {
      "content-type": "application/json",
      ...(upgradeRequired ? { upgrade: CONTROL_PROTOCOL } : {}),
    });
    response.end(JSON.stringify({ error: upgradeRequired ? "upgrade_required" : "not_found" }));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleUpgrade({ request, socket, head, plane: input, upgraded });
  });
  await listenOnPlaneEndpoint(server, input.endpoint);
  return {
    endpoint: input.endpoint,
    async close() {
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      await closePlaneServer(server, input.endpoint);
    },
  };
}
