import { generateKeyPairSync } from "node:crypto";

// The package exports only its root, which resolves to its build output; this test's package is
// built before it runs.
import { signMachineRpcAttestation, signStreamToken } from "@getpaseo/enterprise-management";
import type { MachineRpcAttestationClaims } from "@getpaseo/protocol/enterprise-collaboration";
import { describe, expect, test } from "vitest";

import { MachineRpcAttestationError, verifyMachineRpcAttestation } from "./rpc-attestation.js";

const NODE_ID = "nod_0123456789abcdef";
const ORGANIZATION_ID = "org_0123456789abcdef";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const CONTAINER_ID = "cws_0123456789abcdef";
const RPC_ID = "rpc_0123abcd-0123-0123-0123-0123456789ab";
const SENT_AT = "2025-06-01T00:00:00.000Z";
const EXPIRES_AT = "2025-06-01T00:01:00.000Z";

const planeKeys = generateKeyPairSync("ed25519");

function claims(overrides: Partial<MachineRpcAttestationClaims> = {}): MachineRpcAttestationClaims {
  return {
    rpcId: RPC_ID,
    method: "agent.send",
    nodeId: NODE_ID,
    containerId: CONTAINER_ID,
    requester: {
      principalId: PRINCIPAL_ID,
      credentialId: "cred-1",
      grantVersion: "g1",
      clientId: "client-1",
    },
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function expectation(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: Date.parse(SENT_AT),
    nodeId: NODE_ID,
    containerId: CONTAINER_ID,
    rpcId: RPC_ID,
    currentGrantVersion: "g1",
    ...overrides,
  };
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof MachineRpcAttestationError ? error.code : `unexpected:${String(error)}`;
  }
  return "no_error";
}

/**
 * The plane signs with its own module and the node verifies with its own. Running both halves here
 * is the point: the two are in packages that cannot import each other's implementation, and only
 * the encoding they share keeps them agreeing. A test where one side did both would prove nothing.
 */
describe("what the plane signs, this node accepts", () => {
  test("verifies a real attestation and returns its claims", () => {
    const token = signMachineRpcAttestation(claims(), planeKeys.privateKey);

    expect(verifyMachineRpcAttestation(token, planeKeys.publicKey, expectation())).toEqual(
      claims(),
    );
  });

  test("refuses one signed by a key that is not the plane's", () => {
    const impostor = generateKeyPairSync("ed25519");
    const token = signMachineRpcAttestation(claims(), impostor.privateKey);

    expect(
      codeOf(() => verifyMachineRpcAttestation(token, planeKeys.publicKey, expectation())),
    ).toBe("bad_signature");
  });

  test("refuses a stream token the plane signed with the same key", () => {
    const streamToken = signStreamToken(
      {
        tokenId: "stk_0123456789abcdef",
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
        credentialId: "cred-1",
        clientId: "client-1",
        grantVersion: "g1",
        revocationEpoch: 0,
        containerIds: [CONTAINER_ID],
        issuedAt: SENT_AT,
        expiresAt: EXPIRES_AT,
      },
      planeKeys.privateKey,
    );

    // One key signs all three artifacts, so only the prefix and separator stop this from carrying a
    // valid signature into a check that would otherwise pass.
    expect(
      codeOf(() => verifyMachineRpcAttestation(streamToken, planeKeys.publicKey, expectation())),
    ).toBe("malformed");
  });

  test("refuses a payload edited after the plane signed it", () => {
    const token = signMachineRpcAttestation(claims(), planeKeys.privateKey);
    const [prefix, payload, signature] = token.split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    tampered.method = "machine.restart";
    const forged = [
      prefix,
      Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url"),
      signature,
    ].join(".");

    expect(
      codeOf(() => verifyMachineRpcAttestation(forged, planeKeys.publicKey, expectation())),
    ).toBe("bad_signature");
  });

  test("refuses one written for another node, container or call", () => {
    const token = signMachineRpcAttestation(claims(), planeKeys.privateKey);

    for (const wrong of [
      { nodeId: "nod_fedcba9876543210" },
      { containerId: "cws_fedcba9876543210" },
      { rpcId: "rpc_9999abcd-0123-0123-0123-0123456789ab" },
    ]) {
      expect(
        codeOf(() => verifyMachineRpcAttestation(token, planeKeys.publicKey, expectation(wrong))),
        JSON.stringify(wrong),
      ).toBe("audience_mismatch");
    }
  });

  test("refuses one past its expiry", () => {
    const token = signMachineRpcAttestation(claims(), planeKeys.privateKey);

    expect(
      codeOf(() =>
        verifyMachineRpcAttestation(
          token,
          planeKeys.publicKey,
          expectation({ nowMs: Date.parse(EXPIRES_AT) }),
        ),
      ),
    ).toBe("expired");
  });

  test("refuses a requester whose Grant has moved on", () => {
    const token = signMachineRpcAttestation(claims(), planeKeys.privateKey);

    // Revocation arrives as a policy refresh, and that rolls the Grant version.
    expect(
      codeOf(() =>
        verifyMachineRpcAttestation(
          token,
          planeKeys.publicKey,
          expectation({ currentGrantVersion: "g2" }),
        ),
      ),
    ).toBe("revoked");
  });

  test("refuses anything that is not a three-part token of this prefix", () => {
    for (const malformed of ["", "pmr_v1", "pmr_v1.only-two", "nope.eyJ9.c2ln"]) {
      expect(
        codeOf(() => verifyMachineRpcAttestation(malformed, planeKeys.publicKey, expectation())),
        malformed,
      ).toBe("malformed");
    }
  });
});
