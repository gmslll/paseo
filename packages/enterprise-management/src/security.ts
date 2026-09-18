import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

import { compare, hash } from "bcryptjs";

import {
  NodeRequestAuthenticationSchema,
  SessionTicketClaimsSchema,
  type NodeRequestAuthentication,
  type SessionTicketClaims,
} from "./model.js";

const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function deriveSecret(secret: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, length, { N: 16_384, r: 8, p: 1 }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export interface SecretDigest {
  readonly salt: string;
  readonly digest: string;
}

export const PASSWORD_BCRYPT_COST = 12;

export async function digestSecret(secret: string, salt = randomBytes(16)): Promise<SecretDigest> {
  if (!TOKEN_SECRET_PATTERN.test(secret)) throw new Error("invalid secret");
  const derived = await deriveSecret(secret, salt, 64);
  return Object.freeze({ salt: salt.toString("base64url"), digest: derived.toString("base64url") });
}

export async function verifySecret(secret: string, expected: SecretDigest): Promise<boolean> {
  if (!TOKEN_SECRET_PATTERN.test(secret)) return false;
  let salt: Buffer;
  let digest: Buffer;
  try {
    salt = Buffer.from(expected.salt, "base64url");
    digest = Buffer.from(expected.digest, "base64url");
  } catch {
    return false;
  }
  const actual = await deriveSecret(secret, salt, digest.length);
  return actual.length === digest.length && timingSafeEqual(actual, digest);
}

export async function digestPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_BCRYPT_COST);
}

export async function verifyPassword(password: string, expectedHash: string): Promise<boolean> {
  if (!/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/.test(expectedHash)) return false;
  return compare(password, expectedHash);
}

export function createOpaqueId(prefix: string, bytes: number): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

export function createSecretToken(prefix: string, id: string): { token: string; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  return { token: `${prefix}${id}.${secret}`, secret };
}

export function parseSecretToken(
  token: string,
  prefix: string,
  idPattern: RegExp,
): { id: string; secret: string } | null {
  if (!token.startsWith(prefix)) return null;
  const separator = token.indexOf(".", prefix.length);
  if (separator < 0) return null;
  const id = token.slice(prefix.length, separator);
  const secret = token.slice(separator + 1);
  if (!idPattern.test(id) || !TOKEN_SECRET_PATTERN.test(secret)) return null;
  return { id, secret };
}

export function sha256Base64Url(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url");
}

function nodeRequestMessage(input: {
  readonly method: string;
  readonly path: string;
  readonly timestampMs: number;
  readonly nonce: string;
  readonly body: string | Buffer;
}): Buffer {
  return Buffer.from(
    [
      "paseo-node-request-v1",
      input.method.toUpperCase(),
      input.path,
      String(input.timestampMs),
      input.nonce,
      sha256Base64Url(input.body),
    ].join("\n"),
    "utf8",
  );
}

export function signNodeRequest(
  privateKey: KeyObject | string | Buffer,
  input: {
    readonly nodeId: string;
    readonly method: string;
    readonly path: string;
    readonly timestampMs: number;
    readonly nonce: string;
    readonly body: string | Buffer;
  },
): NodeRequestAuthentication {
  const signature = sign(null, nodeRequestMessage(input), privateKey).toString("base64url");
  return NodeRequestAuthenticationSchema.parse({
    nodeId: input.nodeId,
    timestampMs: input.timestampMs,
    nonce: input.nonce,
    signature,
  });
}

export function verifyNodeRequestSignature(
  publicKeyPem: string,
  authentication: NodeRequestAuthentication,
  input: { readonly method: string; readonly path: string; readonly body: string | Buffer },
): boolean {
  const auth = NodeRequestAuthenticationSchema.parse(authentication);
  return verify(
    null,
    nodeRequestMessage({ ...input, timestampMs: auth.timestampMs, nonce: auth.nonce }),
    publicKeyPem,
    Buffer.from(auth.signature, "base64url"),
  );
}

export function signSessionTicket(
  claims: SessionTicketClaims,
  privateKey: KeyObject | string | Buffer,
): string {
  const payload = Buffer.from(
    JSON.stringify(SessionTicketClaimsSchema.parse(structuredClone(claims))),
    "utf8",
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`paseo-management-ticket-v1.${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `pmt_v1.${payload}.${signature}`;
}

export function verifySessionTicket(
  ticket: string,
  publicKey: KeyObject | string | Buffer,
  expected: {
    readonly nowMs: number;
    readonly nodeId: string;
    readonly paseoServerId: string;
    readonly issuer: string;
    readonly currentGrantVersion?: string;
    readonly currentRevocationEpoch?: number;
  },
): SessionTicketClaims {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "pmt_v1") throw new Error("invalid session ticket");
  const payload = parts[1]!;
  const valid = verify(
    null,
    Buffer.from(`paseo-management-ticket-v1.${payload}`, "utf8"),
    publicKey,
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!valid) throw new Error("invalid session ticket signature");
  let claims: SessionTicketClaims;
  try {
    claims = SessionTicketClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
  } catch (error) {
    throw new Error("invalid session ticket claims", { cause: error });
  }
  if (
    claims.issuer !== expected.issuer ||
    claims.nodeId !== expected.nodeId ||
    claims.paseoServerId !== expected.paseoServerId
  ) {
    throw new Error("session ticket audience mismatch");
  }
  if (expected.nowMs < claims.notBeforeMs || expected.nowMs >= claims.expiresAtMs) {
    throw new Error("session ticket expired or not active");
  }
  if (
    (expected.currentGrantVersion !== undefined &&
      claims.grantVersion !== expected.currentGrantVersion) ||
    (expected.currentRevocationEpoch !== undefined &&
      claims.revocationEpoch !== expected.currentRevocationEpoch)
  ) {
    throw new Error("session ticket revoked");
  }
  return Object.freeze(structuredClone(claims));
}
