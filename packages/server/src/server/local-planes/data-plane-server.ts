import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Logger } from "pino";
import {
  LOCAL_PLANE_ATTACH_TOKEN_HEADER,
  LOCAL_PLANE_HIGH_WATER_BYTES,
  LOCAL_PLANE_TOKEN_HEADER,
  LOCAL_PLANE_UPGRADE_PROTOCOLS,
} from "@getpaseo/protocol/local-planes";
import {
  LengthPrefixedFrameDecoder,
  encodeLengthPrefixedFrame,
} from "@getpaseo/protocol/binary-frames/length-prefix";
import { decodeDataPlaneFrame } from "@getpaseo/protocol/binary-frames/data-plane";

import type { DataPlaneAttachment, DataPlaneChannel } from "./data-plane-access.js";
import { localTokenMatches } from "./local-token.js";
import type { LocalPlaneSocketEndpoint } from "./plane-paths.js";
import { closePlaneServer, listenOnPlaneEndpoint } from "./unix-socket-listener.js";

// The data plane is a second channel of an admitted Session (ADR-0038). It carries
// `[u32 BE length][data frame]`, where the data frame is `[u8 kind][u16 BE docId length][docId][payload]`.
// The local token proves socket access; the one-use attach token proves which Session, Principal,
// and Grant version the channel belongs to.

const DATA_PROTOCOL = LOCAL_PLANE_UPGRADE_PROTOCOLS.data;
const DATA_PATH = "/v1/data";

export interface DataPlaneTicket {
  readonly sessionId: string;
}

export interface DataPlaneAdmission {
  /** Spends the attach token and returns what it was issued for, or null when it is not usable. */
  verify(token: string): DataPlaneTicket | null;
  attach(ticket: DataPlaneTicket, channel: DataPlaneChannel): DataPlaneAttachment | null;
}

export interface DataPlaneServer {
  readonly endpoint: LocalPlaneSocketEndpoint;
  close(): Promise<void>;
}

export interface StartDataPlaneInput {
  endpoint: LocalPlaneSocketEndpoint;
  token: string;
  admission: DataPlaneAdmission;
  logger: Logger;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rejectUpgrade(socket: Socket, status: 400 | 401, statusText: string): void {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createChannel(socket: Socket): DataPlaneChannel {
  return {
    send: (frame) => {
      if (socket.writable) socket.write(encodeLengthPrefixedFrame(frame));
    },
    bufferedAmount: () => socket.writableLength,
    close: () => socket.end(),
  };
}

function handleUpgrade(input: {
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
  plane: StartDataPlaneInput;
  attached: Set<Socket>;
}): void {
  const { request, socket, plane } = input;
  const { pathname } = new URL(request.url ?? "/", "http://data.local");
  if (
    request.method !== "POST" ||
    pathname !== DATA_PATH ||
    headerValue(request, "upgrade") !== DATA_PROTOCOL
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
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${DATA_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`,
  );
  socket.setNoDelay(true);
  input.attached.add(socket);
  socket.once("close", () => input.attached.delete(socket));

  const attachment = plane.admission.attach(ticket, createChannel(socket));
  if (!attachment) {
    plane.logger.warn(
      { sessionId: ticket.sessionId },
      "Data plane Session will not serve documents",
    );
    socket.end();
    return;
  }
  const decoder = new LengthPrefixedFrameDecoder({
    maxFrameBytes: LOCAL_PLANE_HIGH_WATER_BYTES.data,
  });
  const receive = (chunk: Buffer) => {
    try {
      for (const bytes of decoder.push(chunk)) {
        const frame = decodeDataPlaneFrame(bytes);
        // A frame this plane cannot read is a protocol error, not something to skip past.
        if (!frame) throw new Error("undecodable data plane frame");
        attachment.handleFrame(frame);
      }
    } catch (error) {
      plane.logger.warn({ err: error, sessionId: ticket.sessionId }, "Data plane frame refused");
      socket.destroy();
    }
  };
  socket.on("data", receive);
  socket.on("error", (error) => {
    plane.logger.debug({ err: error, sessionId: ticket.sessionId }, "Data plane socket error");
  });
  // http.Server sockets allow half-open, so a client EOF alone never emits "close".
  socket.once("end", () => socket.end());
  socket.once("close", () => attachment.detach());
  if (input.head.byteLength > 0) receive(input.head);
}

export async function startDataPlane(input: StartDataPlaneInput): Promise<DataPlaneServer> {
  const attached = new Set<Socket>();
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://data.local");
    const upgradeRequired = pathname === DATA_PATH;
    response.writeHead(upgradeRequired ? 426 : 404, {
      "content-type": "application/json",
      ...(upgradeRequired ? { upgrade: DATA_PROTOCOL } : {}),
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
