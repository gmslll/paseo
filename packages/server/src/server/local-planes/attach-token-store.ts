import { randomBytes } from "node:crypto";
import {
  LOCAL_PLANE_ATTACH_TOKEN_TTL_MS,
  type LocalPlaneName,
} from "@getpaseo/protocol/local-planes";

// Attach tokens for the terminal and data planes (ADR-0038). A token is single use, expires in a
// minute, and names the Session, Principal, Grant version, and plane it was issued for, so a plane
// connection can never outlive or widen the Session that asked for it.

const ATTACH_TOKEN_BYTES = 32;

export interface AttachTokenClaims {
  readonly sessionId: string;
  readonly plane: LocalPlaneName;
  readonly principalId: string;
  readonly grantVersion: string;
}

export interface IssuedAttachToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface AttachTokenStore {
  issue(claims: AttachTokenClaims): IssuedAttachToken;
  /** Returns the claims and spends the token, or null when it is unknown, spent, expired, or for another plane. */
  consume(input: { token: string; plane: LocalPlaneName }): AttachTokenClaims | null;
  revokeSession(sessionId: string): void;
  readonly outstanding: number;
}

interface StoredToken {
  readonly claims: AttachTokenClaims;
  readonly expiresAt: number;
}

export function createAttachTokenStore(options?: {
  now?: () => number;
  ttlMs?: number;
}): AttachTokenStore {
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? LOCAL_PLANE_ATTACH_TOKEN_TTL_MS;
  const tokens = new Map<string, StoredToken>();

  function dropExpired(): void {
    const currentTime = now();
    for (const [token, stored] of tokens) {
      if (stored.expiresAt <= currentTime) tokens.delete(token);
    }
  }

  return {
    issue(claims) {
      dropExpired();
      const token = randomBytes(ATTACH_TOKEN_BYTES).toString("base64url");
      const expiresAt = now() + ttlMs;
      tokens.set(token, { claims, expiresAt });
      return { token, expiresAt };
    },

    consume(input) {
      dropExpired();
      const stored = tokens.get(input.token);
      if (!stored) return null;
      tokens.delete(input.token);
      return stored.claims.plane === input.plane ? stored.claims : null;
    },

    revokeSession(sessionId) {
      for (const [token, stored] of tokens) {
        if (stored.claims.sessionId === sessionId) tokens.delete(token);
      }
    },

    get outstanding() {
      dropExpired();
      return tokens.size;
    },
  };
}
