import type { DataPlaneFrame } from "@getpaseo/protocol/binary-frames/data-plane";

// The seam between a Session and the data plane (ADR-0038). The plane frames, admits, and routes;
// the documents behind DataPlaneDocHandler arrive with the collaboration data plane (ADR-0032).

export interface DataPlaneChannel {
  send(frame: Uint8Array): void;
  /** Bytes waiting on the socket, for the document writer's backpressure decisions. */
  bufferedAmount(): number | null;
  close(): void;
}

export interface DataPlaneAttachment {
  handleFrame(frame: DataPlaneFrame): void;
  detach(): void;
}

/** What a handler writes back to the one channel it was opened for. */
export interface DataPlaneDocChannel {
  send(frame: DataPlaneFrame): void;
  bufferedAmount(): number | null;
  close(): void;
}

export interface DataPlaneDocSession {
  handleFrame(frame: DataPlaneFrame): void;
  detach(): void;
}

export interface DataPlaneDocHandler {
  /**
   * Opens documents for one admitted channel, or returns null to refuse it. The Principal and Grant
   * version are the ones the attach token was issued against, already checked by the plane.
   */
  open(input: {
    sessionId: string;
    principalId: string;
    grantVersion: string;
    channel: DataPlaneDocChannel;
  }): DataPlaneDocSession | null;
}
