import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Logger } from "pino";
import {
  LOCAL_PLANE_ATTACH_TOKEN_HEADER,
  LOCAL_PLANE_HIGH_WATER_BYTES,
  LOCAL_PLANE_TOKEN_HEADER,
  LOCAL_PLANE_UPGRADE_PROTOCOLS,
  TERMINAL_PLANE_JSON_OPCODE,
} from "@getpaseo/protocol/local-planes";
import {
  LengthPrefixedFrameDecoder,
  encodeLengthPrefixedFrame,
} from "@getpaseo/protocol/binary-frames/length-prefix";

import { localTokenMatches } from "./local-token.js";
import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";
import type { TerminalPlaneAttachment, TerminalPlaneChannel } from "./terminal-plane-access.js";
import { closePlaneServer, listenOnPlaneEndpoint } from "./unix-socket-listener.js";

// The terminal plane is a second channel of an admitted Session (ADR-0038). It carries the terminal
// opcodes the WebSocket already carries, framed as `[u32 BE length][payload]`, plus opcode 0x40 for
// the JSON terminal messages. The local token proves socket access; the one-use attach token proves
// which Session, Principal, and Grant version the channel belongs to.

const TERMINAL_PROTOCOL = LOCAL_PLANE_UPGRADE_PROTOCOLS.terminal;
const TERMINAL_PATH = "/v1/terminal";

export type { TerminalPlaneAttachment, TerminalPlaneChannel } from "./terminal-plane-access.js";

export interface TerminalPlaneTicket {
  readonly sessionId: string;
}

export interface TerminalPlaneAdmission {
  /** Spends the attach token and returns what it was issued for, or null when it is not usable. */
  verify(token: string): TerminalPlaneTicket | null;
  attach(
    ticket: TerminalPlaneTicket,
    channel: TerminalPlaneChannel,
  ): TerminalPlaneAttachment | null;
}

export interface TerminalPlaneServer {
  readonly endpoint: LocalPlaneSocketEndpoint;
  close(): Promise<void>;
}

export interface StartTerminalPlaneInput {
  endpoint: LocalPlaneSocketEndpoint;
  token: string;
  admission: TerminalPlaneAdmission;
  logger: Logger;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rejectUpgrade(socket: Socket, status: 400 | 401, statusText: string): void {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createChannel(socket: Socket): TerminalPlaneChannel {
  return {
    send: (frame) => {
      if (socket.writable) socket.write(encodeLengthPrefixedFrame(frame));
    },
    bufferedAmount: () => socket.writableLength,
    close: () => socket.end(),
  };
}

function deliver(attachment: TerminalPlaneAttachment, frame: Uint8Array): void {
  if (frame.byteLength === 0) return;
  if (frame[0] === TERMINAL_PLANE_JSON_OPCODE) {
    attachment.handleJsonMessage(new TextDecoder().decode(frame.subarray(1)));
    return;
  }
  attachment.handleTerminalFrame(frame);
}

function handleUpgrade(input: {
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
  plane: StartTerminalPlaneInput;
  attached: Set<Socket>;
}): void {
  const { request, socket, plane } = input;
  const { pathname } = new URL(request.url ?? "/", "http://terminal.local");
  if (
    request.method !== "POST" ||
    pathname !== TERMINAL_PATH ||
    headerValue(request, "upgrade") !== TERMINAL_PROTOCOL
  ) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }
  const attachToken = headerValue(request, LOCAL_PLANE_ATTACH_TOKEN_HEADER);
  if (
    !localTokenMatches(plane.token, headerValue(request, LOCAL_PLANE_TOKEN_HEADER)) ||
    !attachToken
  ) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }
  const ticket = plane.admission.verify(attachToken);
  if (!ticket || socket.destroyed) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${TERMINAL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
  );
  socket.setNoDelay(true);
  input.attached.add(socket);
  socket.once("close", () => input.attached.delete(socket));

  const attachment = plane.admission.attach(ticket, createChannel(socket));
  if (!attachment) {
    plane.logger.warn({ sessionId: ticket.sessionId }, "Terminal plane Session is gone");
    socket.end();
    return;
  }
  const decoder = new LengthPrefixedFrameDecoder({
    maxFrameBytes: LOCAL_PLANE_HIGH_WATER_BYTES.terminal,
  });
  const receive = (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) deliver(attachment, frame);
    } catch (error) {
      plane.logger.warn(
        { err: error, sessionId: ticket.sessionId },
        "Terminal plane frame refused",
      );
      socket.destroy();
    }
  };
  socket.on("data", receive);
  socket.on("error", (error) => {
    plane.logger.debug({ err: error, sessionId: ticket.sessionId }, "Terminal plane socket error");
  });
  // http.Server sockets allow half-open, so a client EOF alone never emits "close" — and a terminal
  // channel with no reader left is finished. End our side so the attachment detaches.
  socket.once("end", () => socket.end());
  socket.once("close", () => attachment.detach());
  if (input.head.byteLength > 0) receive(input.head);
}

export async function startTerminalPlane(
  input: StartTerminalPlaneInput,
): Promise<TerminalPlaneServer> {
  const attached = new Set<Socket>();
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://terminal.local");
    const upgradeRequired = pathname === TERMINAL_PATH;
    response.writeHead(upgradeRequired ? 426 : 404, {
      "content-type": "application/json",
      ...(upgradeRequired ? { upgrade: TERMINAL_PROTOCOL } : {}),
    });
    response.end(JSON.stringify({ error: upgradeRequired ? "upgrade_required" : "not_found" }));
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    handleUpgrade({ request, socket, head, plane: input, attached });
  });
  await listenOnPlaneEndpoint(server, input.endpoint);
  return {
    endpoint: input.endpoint,
    async close() {
      for (const socket of attached) socket.destroy();
      attached.clear();
      await closePlaneServer(server, input.endpoint);
    },
  };
}
