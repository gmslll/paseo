import { describe, expect, test } from "vitest";

import type { MachineRpcAttestationClaims } from "./enterprise-collaboration.js";
import {
  MACHINE_RPC_ATTESTATION_DOMAIN,
  MACHINE_RPC_ATTESTATION_PREFIX,
  decodeMachineRpcAttestationClaims,
  encodeMachineRpcAttestationClaims,
  formatMachineRpcAttestation,
  machineRpcAttestationSigningInput,
  parseMachineRpcAttestation,
} from "./machine-rpc-attestation.js";

const CLAIMS: MachineRpcAttestationClaims = {
  rpcId: "rpc_0123abcd-0123-0123-0123-0123456789ab",
  method: "agent.send",
  nodeId: "nod_0123456789abcdef",
  containerId: "cws_0123456789abcdef",
  requester: {
    principalId: "usr_0123456789abcdef",
    credentialId: "cred-1",
    grantVersion: "g1",
    clientId: "client-1",
  },
  sentAt: "2025-06-01T00:00:00.000Z",
  expiresAt: "2025-06-01T00:01:00.000Z",
};

describe("the canonical form both sides sign", () => {
  test("round-trips the claims through the payload", () => {
    const payload = encodeMachineRpcAttestationClaims(CLAIMS);

    expect(decodeMachineRpcAttestationClaims(payload)).toEqual(CLAIMS);
  });

  test("encodes the same bytes for the same claims", () => {
    // Two implementations of this would drift and turn every verification into a false mismatch,
    // which is why it is here rather than on each side.
    expect(encodeMachineRpcAttestationClaims(CLAIMS)).toBe(
      encodeMachineRpcAttestationClaims({ ...CLAIMS, requester: { ...CLAIMS.requester } }),
    );
  });

  test("signs over the domain and the payload, not the payload alone", () => {
    const payload = encodeMachineRpcAttestationClaims(CLAIMS);

    expect(machineRpcAttestationSigningInput(payload)).toBe(
      `${MACHINE_RPC_ATTESTATION_DOMAIN}.${payload}`,
    );
    // The separator is what keeps the plane's other two artifacts from verifying here: all three
    // are signed with its one ticket key.
    expect(MACHINE_RPC_ATTESTATION_DOMAIN).not.toBe("paseo-stream-token-v1");
    expect(MACHINE_RPC_ATTESTATION_DOMAIN).not.toBe("paseo-management-ticket-v1");
  });

  test("refuses to parse anything that is not a token of this prefix", () => {
    for (const wrong of [
      "",
      MACHINE_RPC_ATTESTATION_PREFIX,
      "pmr_v1.only-two",
      "pst_v1.eyJ9.c2ln",
      "pmt_v1.eyJ9.c2ln",
      "pmr_v1..c2ln",
      "pmr_v1.eyJ9.",
    ]) {
      expect(parseMachineRpcAttestation(wrong), wrong).toBeNull();
    }
  });

  test("splits a well-formed token into the two halves a verifier needs", () => {
    const token = formatMachineRpcAttestation("cGF5bG9hZA", "c2lnbmF0dXJl");

    expect(token).toBe(`${MACHINE_RPC_ATTESTATION_PREFIX}.cGF5bG9hZA.c2lnbmF0dXJl`);
    expect(parseMachineRpcAttestation(token)).toEqual({
      payload: "cGF5bG9hZA",
      signature: "c2lnbmF0dXJl",
    });
  });

  test("refuses a payload that is not well-formed claims", () => {
    const payload = Buffer.from(JSON.stringify({ rpcId: "nope" }), "utf8").toString("base64url");

    expect(() => decodeMachineRpcAttestationClaims(payload)).toThrow();
  });
});
