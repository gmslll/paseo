import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import { STREAM_TOKEN_TTL_MS } from "@getpaseo/protocol/enterprise-collaboration";
import { signStreamToken, verifyStreamToken, type StreamTokenClaims } from "./stream-token.js";

const ORG = "org_0123456789abcdef";
const CONTAINER = "cws_0123456789abcdef";
const OTHER = "cws_fedcba9876543210";
const ISSUED = Date.parse("2026-09-16T00:00:00.000Z");

function claims(overrides: Partial<StreamTokenClaims> = {}): StreamTokenClaims {
  return {
    tokenId: "stk_0123456789abcdef0123456789abcdef",
    organizationId: ORG,
    principalId: "usr_0123456789abcdef",
    credentialId: "cred_0123456789abcdef0123456789ab",
    clientId: "desktop-1",
    grantVersion: "grv_0123456789abcdef",
    revocationEpoch: 3,
    containerIds: [CONTAINER],
    issuedAt: new Date(ISSUED).toISOString(),
    expiresAt: new Date(ISSUED + STREAM_TOKEN_TTL_MS).toISOString(),
    ...overrides,
  };
}

describe("collaboration stream tokens", () => {
  test("round-trips claims and binds them to the container they were issued for", () => {
    const keys = generateKeyPairSync("ed25519");

    const token = signStreamToken(claims(), keys.privateKey);

    expect(token.startsWith("pst_v1.")).toBe(true);
    expect(
      verifyStreamToken(token, keys.publicKey, {
        nowMs: ISSUED,
        containerId: CONTAINER,
        organizationId: ORG,
      }),
    ).toEqual(claims());
  });

  test("refuses a container the token does not name", () => {
    const keys = generateKeyPairSync("ed25519");
    const token = signStreamToken(claims(), keys.privateKey);

    expect(() =>
      verifyStreamToken(token, keys.publicKey, {
        nowMs: ISSUED,
        containerId: OTHER,
        organizationId: ORG,
      }),
    ).toThrow("stream token audience mismatch");
  });

  test("refuses another organization and an expired token", () => {
    const keys = generateKeyPairSync("ed25519");
    const token = signStreamToken(claims(), keys.privateKey);

    expect(() =>
      verifyStreamToken(token, keys.publicKey, {
        nowMs: ISSUED,
        containerId: CONTAINER,
        organizationId: "org_fedcba9876543210",
      }),
    ).toThrow("stream token audience mismatch");
    expect(() =>
      verifyStreamToken(token, keys.publicKey, {
        nowMs: ISSUED + STREAM_TOKEN_TTL_MS,
        containerId: CONTAINER,
        organizationId: ORG,
      }),
    ).toThrow("stream token expired");
  });

  test("refuses a foreign signature and a tampered payload", () => {
    const keys = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const token = signStreamToken(claims(), keys.privateKey);

    expect(() =>
      verifyStreamToken(token, attacker.publicKey, {
        nowMs: ISSUED,
        containerId: CONTAINER,
        organizationId: ORG,
      }),
    ).toThrow("invalid stream token signature");

    const forged = signStreamToken(claims({ containerIds: [OTHER] }), attacker.privateKey);
    const spliced = `${forged.split(".")[0]}.${forged.split(".")[1]}.${token.split(".")[2]}`;
    expect(() =>
      verifyStreamToken(spliced, keys.publicKey, {
        nowMs: ISSUED,
        containerId: OTHER,
        organizationId: ORG,
      }),
    ).toThrow("invalid stream token signature");
  });

  test("refuses a Session ticket's prefix, and refuses claims it cannot sign", () => {
    const keys = generateKeyPairSync("ed25519");

    // Both token kinds are Ed25519 over a base64url payload signed with the plane's one ticket key.
    // The prefix and the domain separator are what keep a Session ticket from being presented here;
    // a real ticket is exercised where the plane issues one, so this case does not hand-build claims.
    expect(() =>
      verifyStreamToken("pmt_v1.payload.signature", keys.publicKey, {
        nowMs: ISSUED,
        containerId: CONTAINER,
        organizationId: ORG,
      }),
    ).toThrow("invalid stream token");

    // Signing validates too, so a malformed claim cannot be minted into a well-formed token.
    expect(() => signStreamToken(claims({ containerIds: [] }), keys.privateKey)).toThrow();
    expect(() => signStreamToken(claims({ principalId: "usr_nothex" }), keys.privateKey)).toThrow();
  });
});
