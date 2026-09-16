// The seam between a Session and the terminal plane (ADR-0038). It lives here, apart from the plane
// server, so session.ts can hold a plane channel without importing an HTTP listener.

export type { LocalPlaneAccess, LocalPlaneAttachEndpoint } from "./local-plane-access.js";

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
