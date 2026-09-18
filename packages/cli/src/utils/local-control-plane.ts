import { readFileSync } from "node:fs";
import { request } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";
import { readLiveDaemonManifest } from "@getpaseo/server";
import {
  LOCAL_PLANE_RUN_DIRECTORY,
  LOCAL_PLANE_TOKEN_FILE,
  LOCAL_PLANE_TOKEN_HEADER,
  LOCAL_PLANE_UPGRADE_PROTOCOLS,
  CONTROL_PLANE_MAX_LINE_BYTES,
  NdjsonLineDecoder,
  classifyControlPlaneLine,
  encodeControlPlaneBinaryLine,
  encodeControlPlaneCloseLine,
} from "@getpaseo/protocol/local-planes";

// The readers live in the server package so the desktop app shares them; the control plane
// transport stays here because only a CLI-shaped caller needs the local token (ADR-0038).
export { describeLocalPlanes, readLiveDaemonManifest, readLocalProbeState } from "@getpaseo/server";

// Local control plane access for the CLI (ADR-0038). Only same-user tools can read run/local-token,
// so a live manifest plus the token is enough to reach the daemon without its WebSocket listener.

export interface LocalControlPlane {
  readonly socketPath: string;
  readonly token: string;
}

type Handler<T extends unknown[]> = (...args: T) => void;

export function findLocalControlPlane(paseoHome: string): LocalControlPlane | null {
  const control = readLiveDaemonManifest(paseoHome)?.planes.control;
  if (control?.transport !== "unix") return null;
  try {
    const token = readFileSync(
      path.join(paseoHome, LOCAL_PLANE_RUN_DIRECTORY, LOCAL_PLANE_TOKEN_FILE),
      "utf8",
    ).trim();
    return token ? { socketPath: control.path, token } : null;
  } catch {
    return null;
  }
}

class Listeners<T extends unknown[]> {
  private readonly handlers = new Set<Handler<T>>();

  add(handler: Handler<T>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(...args: T): void {
    for (const handler of this.handlers) handler(...args);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A DaemonTransport over `paseo-ndjson/1`; the WebSocket URL the client passes is ignored. */
export function createControlPlaneTransportFactory(
  plane: LocalControlPlane,
): DaemonTransportFactory {
  return ({ headers }) => {
    const open = new Listeners<[]>();
    const message = new Listeners<[unknown, boolean]>();
    const closed = new Listeners<[unknown]>();
    const failed = new Listeners<[unknown]>();
    const decoder = new NdjsonLineDecoder({ maxLineBytes: CONTROL_PLANE_MAX_LINE_BYTES });
    let socket: Socket | null = null;
    let finished = false;

    const finish = (event: { code: number; reason: string }) => {
      if (finished) return;
      finished = true;
      socket?.destroy();
      closed.emit(event);
    };

    const receive = (chunk: Buffer) => {
      try {
        for (const line of decoder.push(chunk)) {
          if (line.length === 0) continue;
          const classified = classifyControlPlaneLine(line);
          if (classified.kind === "close") {
            finish({ code: classified.code, reason: classified.reason });
            return;
          }
          if (classified.kind === "binary") message.emit(toArrayBuffer(classified.bytes), true);
          else message.emit(classified.text, false);
        }
      } catch (error) {
        failed.emit(error);
        finish({ code: 1009, reason: "Control plane stream error" });
      }
    };

    const authorization = headers?.Authorization ?? headers?.authorization;
    const outgoing = request({
      socketPath: plane.socketPath,
      method: "POST",
      path: "/v1/session",
      headers: {
        connection: "Upgrade",
        upgrade: LOCAL_PLANE_UPGRADE_PROTOCOLS.control,
        [LOCAL_PLANE_TOKEN_HEADER]: plane.token,
        ...(authorization ? { authorization } : {}),
      },
    });
    outgoing.on("upgrade", (_response, upgraded: Socket, head: Buffer) => {
      socket = upgraded;
      upgraded.on("data", receive);
      upgraded.on("error", (error) => failed.emit(error));
      upgraded.on("close", () => finish({ code: 1006, reason: "Control plane connection closed" }));
      open.emit();
      if (head.byteLength > 0) receive(head);
    });
    outgoing.on("response", (response) => {
      response.resume();
      const reason = `Control plane refused the connection (${response.statusCode ?? 0})`;
      failed.emit(new Error(reason));
      finish({ code: 4001, reason });
    });
    outgoing.on("error", (error) => {
      failed.emit(error);
      finish({ code: 1006, reason: error.message });
    });
    outgoing.end();

    const transport: DaemonTransport = {
      send: (data) => {
        if (!socket || finished) throw new Error("Control plane connection is not open");
        const line =
          typeof data === "string"
            ? data
            : encodeControlPlaneBinaryLine(
                data instanceof ArrayBuffer ? new Uint8Array(data) : data,
              );
        socket.write(`${line}\n`);
      },
      close: (code = 1000, reason = "") => {
        if (socket && !finished) {
          socket.end(`${encodeControlPlaneCloseLine({ code, reason })}\n`);
        }
        outgoing.destroy();
        finish({ code, reason });
      },
      onOpen: (handler) => open.add(handler),
      onMessage: (handler) => message.add(handler),
      onClose: (handler) => closed.add(handler),
      onError: (handler) => failed.add(handler),
    };
    return transport;
  };
}
