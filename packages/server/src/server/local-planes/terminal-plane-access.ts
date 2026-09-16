import type { AttachTokenClaims, IssuedAttachToken } from "./attach-token-store.js";

// The seam between a Session and the terminal plane (ADR-0038). It lives here, apart from the plane
// server, so session.ts can hold a plane channel without importing an HTTP listener.

export interface LocalPlaneAttachEndpoint {
  readonly transport: "unix" | "pipe";
  readonly path: string;
  readonly protocolVersion: number;
}

export interface TerminalPlaneChannel {
  send(frame: Uint8Array): void;
  /** Bytes waiting on the socket, for the terminal controller's backpressure decisions. */
  bufferedAmount(): number | null;
  close(): void;
}

export interface TerminalPlaneAttachment {
  handleTerminalFrame(frame: Uint8Array): void;
  handleJsonMessage(text: string): void;
  detach(): void;
}

export interface TerminalPlaneAccess {
  /** Where clients dial the plane, or null while it is not listening. */
  endpoint(): LocalPlaneAttachEndpoint | null;
  issue(claims: AttachTokenClaims): IssuedAttachToken;
  revokeSession(sessionId: string): void;
}
