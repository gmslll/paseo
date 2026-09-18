import { sign, verify, type KeyObject } from "node:crypto";

import {
  StreamTokenClaimsSchema,
  type StreamTokenClaims,
} from "@getpaseo/protocol/enterprise-collaboration";

// Short-lived tokens that let a client read and append collaboration streams without presenting its
// personal access token on every request (ADR-0032). They are Ed25519 over a base64url payload, the
// same construction the Session ticket uses.
//
// The domain separator and the prefix are deliberately different from the Session ticket's. Both are
// signed with the plane's one ticket key, so without a distinct separator a Session ticket would
// verify as a stream token and vice versa.

const STREAM_TOKEN_PREFIX = "pst_v1";
const STREAM_TOKEN_DOMAIN = "paseo-stream-token-v1";

export type { StreamTokenClaims };

export function signStreamToken(
  claims: StreamTokenClaims,
  privateKey: KeyObject | string | Buffer,
): string {
  const payload = Buffer.from(
    JSON.stringify(StreamTokenClaimsSchema.parse(structuredClone(claims))),
    "utf8",
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${STREAM_TOKEN_DOMAIN}.${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${STREAM_TOKEN_PREFIX}.${payload}.${signature}`;
}

export function verifyStreamToken(
  token: string,
  publicKey: KeyObject | string | Buffer,
  expected: {
    readonly nowMs: number;
    readonly containerId: string;
    readonly organizationId: string;
    /**
     * The holder's authority as it stands right now. These are required, not optional: a token
     * lives for five minutes, and a membership change rolls both values, so skipping the comparison
     * would let a removed member keep reading and writing until the token expired. The Session
     * ticket makes the same inputs optional and only its tests pass them; that is not a pattern to
     * copy for a credential this short-lived and this widely presented.
     */
    readonly currentGrantVersion: string;
    readonly currentRevocationEpoch: number;
  },
): StreamTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== STREAM_TOKEN_PREFIX) {
    throw new Error("invalid stream token");
  }
  const payload = parts[1]!;
  const valid = verify(
    null,
    Buffer.from(`${STREAM_TOKEN_DOMAIN}.${payload}`, "utf8"),
    publicKey,
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!valid) throw new Error("invalid stream token signature");

  let claims: StreamTokenClaims;
  try {
    claims = StreamTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
  } catch (error) {
    throw new Error("invalid stream token claims", { cause: error });
  }

  // A token names the containers it was issued for; presenting it elsewhere is a mismatch rather
  // than a missing grant, so it reads the same as an unknown container.
  if (
    claims.organizationId !== expected.organizationId ||
    !claims.containerIds.includes(expected.containerId)
  ) {
    throw new Error("stream token audience mismatch");
  }
  if (expected.nowMs >= Date.parse(claims.expiresAt)) throw new Error("stream token expired");
  if (
    claims.grantVersion !== expected.currentGrantVersion ||
    claims.revocationEpoch !== expected.currentRevocationEpoch
  ) {
    throw new Error("stream token revoked");
  }
  return claims;
}
