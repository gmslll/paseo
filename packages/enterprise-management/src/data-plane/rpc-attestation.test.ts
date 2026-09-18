import { generateKeyPairSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { MachineRpcAttestationClaims } from "@getpaseo/protocol/enterprise-collaboration";
import { signMachineRpcAttestation, verifyMachineRpcAttestation } from "./rpc-attestation.js";
import { signStreamToken } from "./stream-token.js";

const NODE_ID = "nod_0123456789abcdef";
const ORGANIZATION_ID = "org_0123456789abcdef";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const WORKSPACE_UID = "cws_0123456789abcdef";
const RPC_ID = "rpc_0123abcd-0123-0123-0123-0123456789ab";
const SENT_AT = "2025-06-01T00:00:00.000Z";
const EXPIRES_AT = "2025-06-01T00:01:00.000Z";
const NOW = Date.parse(SENT_AT);

const keys = generateKeyPairSync("ed25519");

function claims(overrides: Partial<MachineRpcAttestationClaims> = {}): MachineRpcAttestationClaims {
  return {
    rpcId: RPC_ID,
    method: "agent.send",
    nodeId: NODE_ID,
    containerId: WORKSPACE_UID,
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

function expected(overrides: Partial<Parameters<typeof verifyMachineRpcAttestation>[2]> = {}) {
  return {
    nowMs: NOW,
    nodeId: NODE_ID,
    containerId: WORKSPACE_UID,
    rpcId: RPC_ID,
    currentGrantVersion: "g1",
    ...overrides,
  };
}

describe("a machine RPC attestation", () => {
  test("verifies and returns what the plane said", () => {
    const token = signMachineRpcAttestation(claims(), keys.privateKey);

    expect(token.startsWith("pmr_v1.")).toBe(true);
    expect(verifyMachineRpcAttestation(token, keys.publicKey, expected())).toEqual(claims());
  });

  test("refuses a token signed with another key", () => {
    const other = generateKeyPairSync("ed25519");
    const token = signMachineRpcAttestation(claims(), other.privateKey);

    expect(() => verifyMachineRpcAttestation(token, keys.publicKey, expected())).toThrow(
      "invalid machine rpc attestation signature",
    );
  });

  test("refuses a stream token signed with the very same plane key", () => {
    const streamToken = signStreamToken(
      {
        tokenId: "stk_0123456789abcdef",
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
        credentialId: "cred-1",
        clientId: "client-1",
        grantVersion: "g1",
        revocationEpoch: 0,
        containerIds: [WORKSPACE_UID],
        issuedAt: SENT_AT,
        expiresAt: EXPIRES_AT,
      },
      keys.privateKey,
    );

    // The whole reason this artifact has its own domain separator: all three are signed with one
    // key, so a stream token would otherwise carry a valid signature here.
    expect(() => verifyMachineRpcAttestation(streamToken, keys.publicKey, expected())).toThrow(
      "invalid machine rpc attestation",
    );
  });

  test("refuses a payload edited after signing", () => {
    const token = signMachineRpcAttestation(claims(), keys.privateKey);
    const parts = token.split(".");
    const tampered = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    tampered.method = "machine.restart";
    const forged = [
      parts[0],
      Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url"),
      parts[2],
    ].join(".");

    expect(() => verifyMachineRpcAttestation(forged, keys.publicKey, expected())).toThrow(
      "invalid machine rpc attestation signature",
    );
  });

  test("refuses one written for another node, container, or call", () => {
    const token = signMachineRpcAttestation(claims(), keys.privateKey);

    for (const wrong of [
      { nodeId: "nod_fedcba9876543210" },
      { containerId: "cws_fedcba9876543210" },
      { rpcId: "rpc_9999abcd-0123-0123-0123-0123456789ab" },
    ]) {
      expect(() => verifyMachineRpcAttestation(token, keys.publicKey, expected(wrong))).toThrow(
        "machine rpc attestation audience mismatch",
      );
    }
  });

  test("refuses one past its expiry", () => {
    const token = signMachineRpcAttestation(claims(), keys.privateKey);

    expect(() =>
      verifyMachineRpcAttestation(
        token,
        keys.publicKey,
        expected({ nowMs: Date.parse(EXPIRES_AT) }),
      ),
    ).toThrow("machine rpc attestation expired");
  });

  test("refuses a requester whose Grant has moved on", () => {
    const token = signMachineRpcAttestation(claims(), keys.privateKey);

    // Revocation reaches a node as a policy refresh, and that rolls the Grant version. A member
    // removed sixty seconds ago must not still be driving an Agent.
    expect(() =>
      verifyMachineRpcAttestation(token, keys.publicKey, expected({ currentGrantVersion: "g2" })),
    ).toThrow("machine rpc attestation revoked");
  });

  test("refuses anything that is not a three-part pmr_v1 token", () => {
    for (const malformed of ["", "pmr_v1", "pmr_v1.only-two", "nope.eyJ9.c2ln"]) {
      expect(() => verifyMachineRpcAttestation(malformed, keys.publicKey, expected())).toThrow(
        "invalid machine rpc attestation",
      );
    }
  });
});
