import type { Socket } from "node:net";
import {
  CONTROL_PLANE_MAX_LINE_BYTES,
  NdjsonLineDecoder,
  classifyControlPlaneLine,
  encodeControlPlaneBinaryLine,
  encodeControlPlaneCloseLine,
} from "@getpaseo/protocol/local-planes";

import type { WebSocketLike } from "../websocket-server.js";

type SocketEvent = "message" | "close" | "error";
type Listener = (...args: unknown[]) => void;

const CLOSE_NORMAL = 1000;
const CLOSE_ABNORMAL = 1006;
const CLOSE_MESSAGE_TOO_BIG = 1009;

/**
 * Presents a `paseo-ndjson/1` stream as the WebSocket the daemon already serves, so a control plane
 * Session goes through the same attach, admission, and emit path (ADR-0038). Lines that arrive before
 * the daemon binds its message listener are held, the way a paused WebSocket holds frames.
 */
export class NdjsonSocketAdapter implements WebSocketLike {
  readyState = 1;
  private readonly decoder = new NdjsonLineDecoder({ maxLineBytes: CONTROL_PLANE_MAX_LINE_BYTES });
  private readonly listeners: Record<SocketEvent, Set<Listener>> = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  private held: Array<string | Buffer> | null = [];
  private closed = false;

  constructor(
    private readonly socket: Socket,
    head?: Uint8Array,
  ) {
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => this.finish(CLOSE_ABNORMAL, "connection lost"));
    if (head && head.byteLength > 0) this.receive(head);
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) {
      callback?.(new Error("Control plane connection is not open"));
      return;
    }
    const line =
      typeof data === "string"
        ? data
        : encodeControlPlaneBinaryLine(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    this.socket.write(`${line}\n`, (error) => callback?.(error ?? undefined));
  }

  close(code = CLOSE_NORMAL, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 2;
    this.socket.end(`${encodeControlPlaneCloseLine({ code, reason })}\n`, () =>
      this.finish(code, reason),
    );
  }

  terminate(): void {
    this.socket.destroy();
    this.finish(CLOSE_ABNORMAL, "terminated");
  }

  on(event: SocketEvent, listener: Listener): void {
    this.listeners[event].add(listener);
    if (event === "message") this.releaseHeld();
  }

  once(event: "close" | "error", listener: Listener): void {
    const wrapped: Listener = (...args) => {
      this.listeners[event].delete(wrapped);
      listener(...args);
    };
    this.listeners[event].add(wrapped);
  }

  private receive(chunk: Uint8Array): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      this.emit("error", error);
      this.close(CLOSE_MESSAGE_TOO_BIG, "line too large");
      return;
    }
    for (const line of lines) {
      if (line.length > 0) this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let classified: ReturnType<typeof classifyControlPlaneLine>;
    try {
      classified = classifyControlPlaneLine(line);
    } catch (error) {
      this.emit("error", error);
      return;
    }
    if (classified.kind === "close") {
      this.readyState = 2;
      this.socket.end();
      this.finish(classified.code, classified.reason);
      return;
    }
    this.deliver(classified.kind === "text" ? classified.text : Buffer.from(classified.bytes));
  }

  private deliver(message: string | Buffer): void {
    if (this.held) {
      this.held.push(message);
      return;
    }
    this.emit("message", message);
  }

  private releaseHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (const message of held) this.emit("message", message);
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    // A once() listener only deletes itself, which a live Set iteration handles.
    for (const listener of this.listeners[event]) {
      listener(...args);
    }
  }
}
