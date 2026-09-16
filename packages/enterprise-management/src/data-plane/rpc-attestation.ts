import { sign, verify, type KeyObject } from "node:crypto";

import type { MachineRpcAttestationClaims } from "@getpaseo/protocol/enterprise-collaboration";
import {
  decodeMachineRpcAttestationClaims,
  encodeMachineRpcAttestationClaims,
  formatMachineRpcAttestation,
  machineRpcAttestationSigningInput,
  parseMachineRpcAttestation,
} from "@getpaseo/protocol/machine-rpc-attestation";

// What the plane puts on a machine RPC so the node will act on it (ADR-0035). The node holds no
// membership table and no Grant store, so the attestation is how it learns that the plane checked
// both — and the signature is what stops a member from writing one itself.
//
// The encoding lives in the protocol package because the node verifies what the plane signs; only
// the one crypto call is on this side.

export type { MachineRpcAttestationClaims };

export function signMachineRpcAttestation(
  claims: MachineRpcAttestationClaims,
  privateKey: KeyObject | string | Buffer,
): string {
  const payload = encodeMachineRpcAttestationClaims(claims);
  const signature = sign(
    null,
    Buffer.from(machineRpcAttestationSigningInput(payload), "utf8"),
    privateKey,
  ).toString("base64url");
  return formatMachineRpcAttestation(payload, signature);
}

export function verifyMachineRpcAttestation(
  attestation: string,
  publicKey: KeyObject | string | Buffer,
  expected: {
    readonly nowMs: number;
    readonly nodeId: string;
    readonly containerId: string;
    readonly rpcId: string;
    /**
     * The requester's Grant version as the node's policy currently has it. Required rather than
     * optional, for the reason the stream token gives: an attestation lives 60 seconds, and
     * skipping the comparison would let a removed collaborator keep driving an Agent until it
     * expired.
     *
     * There is no revocation epoch here because the claims carry none: revocation reaches a node as
     * a policy refresh, and that rolls the Grant version this compares against. Taking an epoch and
     * not comparing it would read as a check that is not one.
     */
    readonly currentGrantVersion: string;
  },
): MachineRpcAttestationClaims {
  const parts = parseMachineRpcAttestation(attestation);
  if (!parts) throw new Error("invalid machine rpc attestation");
  const valid = verify(
    null,
    Buffer.from(machineRpcAttestationSigningInput(parts.payload), "utf8"),
    publicKey,
    Buffer.from(parts.signature, "base64url"),
  );
  if (!valid) throw new Error("invalid machine rpc attestation signature");

  let claims: MachineRpcAttestationClaims;
  try {
    claims = decodeMachineRpcAttestationClaims(parts.payload);
  } catch (error) {
    throw new Error("invalid machine rpc attestation claims", { cause: error });
  }

  // An attestation names the one call it was written for. Presenting it on another node, another
  // container, or another rpcId is a mismatch rather than a missing grant, so all three read alike.
  if (
    claims.nodeId !== expected.nodeId ||
    claims.containerId !== expected.containerId ||
    claims.rpcId !== expected.rpcId
  ) {
    throw new Error("machine rpc attestation audience mismatch");
  }
  if (expected.nowMs >= Date.parse(claims.expiresAt)) {
    throw new Error("machine rpc attestation expired");
  }
  if (claims.requester.grantVersion !== expected.currentGrantVersion) {
    throw new Error("machine rpc attestation revoked");
  }
  return claims;
}
