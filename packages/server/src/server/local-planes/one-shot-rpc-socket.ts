import { randomUUID } from "node:crypto";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { WebSocketLike } from "../websocket-server.js";

// `POST /v1/rpc` runs one request through an ordinary Session and returns its correlated response
// (ADR-0038). The Session is real: admission, authorization, and emit behave exactly as they do for
// a `paseo-ndjson/1` Session, so a one-shot caller gains nothing a streaming one lacks.

type SocketEvent = "message" | "close" | "error";
type Listener = (...args: unknown[]) => void;

const CLOSE_NORMAL = 1000;

/** A Session transport that lives for one request and keeps the response it was opened for. */
export class OneShotRpcSocket implements WebSocketLike {
  readyState = 1;
  readonly answered: Promise<SessionOutboundMessage>;
  private settle!: (message: SessionOutboundMessage) => void;
  private readonly listeners: Record<SocketEvent, Set<Listener>> = {
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  private held: string[] | null = [];
  private finished = false;

  constructor(private readonly requestId: string) {
    this.answered = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  get bufferedAmount(): number {
    return 0;
  }

  /** Queues a frame for the daemon, holding it until the Session binds its message listener. */
  deliver(value: unknown): void {
    const line = JSON.stringify(value);
    if (this.held) {
      this.held.push(line);
      return;
    }
    this.emit("message", line);
  }

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    callback?.();
    // Binary frames belong to the terminal and file transfer channels; they answer no RPC.
    if (typeof data !== "string" || this.finished) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const envelope = parsed as { type?: unknown; message?: SessionOutboundMessage };
    if (envelope.type !== "session" || !envelope.message) return;
    const payload = (envelope.message as { payload?: { requestId?: unknown } }).payload;
    if (payload?.requestId !== this.requestId) return;
    this.finished = true;
    this.settle(envelope.message);
  }

  close(code = CLOSE_NORMAL, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  terminate(): void {
    this.close(1006, "terminated");
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

  private releaseHeld(): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    for (const line of held) this.emit("message", line);
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    // A once() listener only deletes itself, which a live Set iteration handles.
    for (const listener of this.listeners[event]) listener(...args);
  }
}

export type OneShotRpcOutcome =
  | { kind: "answered"; message: SessionOutboundMessage }
  | { kind: "timeout" };

/**
 * Attaches a Session, sends `message` as its only request, and resolves with the response carrying
 * the same requestId. The Session is closed either way.
 */
export async function runOneShotRpc(input: {
  message: SessionInboundMessage & { requestId: string };
  attach: (socket: WebSocketLike) => Promise<void>;
  timeoutMs: number;
}): Promise<OneShotRpcOutcome> {
  const socket = new OneShotRpcSocket(input.message.requestId);
  await input.attach(socket);
  socket.deliver({
    type: "hello",
    clientId: `local-rpc-${randomUUID()}`,
    clientType: "cli",
    protocolVersion: 1,
  });
  socket.deliver({ type: "session", message: input.message });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      socket.answered.then((message) => ({ kind: "answered", message }) as const),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs);
      }),
    ]);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    socket.close();
  }
}
