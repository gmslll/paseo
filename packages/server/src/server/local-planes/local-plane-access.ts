import type { AttachTokenClaims, IssuedAttachToken } from "./attach-token-store.js";

// What a Session needs to hand a caller a channel on an attachable plane (ADR-0038). The shape is
// the same for every plane: where to dial, a one-use token naming this Session, and a way to drop
// the Session's outstanding tokens when it goes away.

export interface LocalPlaneAttachEndpoint {
  readonly transport: "unix" | "pipe";
  readonly path: string;
  readonly protocolVersion: number;
}

export interface LocalPlaneAccess {
  /** Where channels attach while the plane accepts them, else null. */
  endpoint(): LocalPlaneAttachEndpoint | null;
  issue(claims: AttachTokenClaims): IssuedAttachToken;
  revokeSession(sessionId: string): void;
}
