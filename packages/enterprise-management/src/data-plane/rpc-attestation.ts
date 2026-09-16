import { sign, verify, type KeyObject } from "node:crypto";

import {
  MachineRpcAttestationClaimsSchema,
  type MachineRpcAttestationClaims,
} from "@getpaseo/protocol/enterprise-collaboration";

// What the plane puts on a machine RPC so the node will act on it (ADR-0035). The node holds no
// membership table and no Grant store, so the attestation is how it learns that the plane checked
// both — and the signature is what stops a member from writing one itself.
//
// Third artifact signed with the plane's one ticket key, so it gets its own separator and prefix.
// Without them a Session ticket or a stream token would verify here, and this one would verify
// there: same key, same construction, different authority.

const MACHINE_RPC_PREFIX = "pmr_v1";
const MACHINE_RPC_DOMAIN = "paseo-machine-rpc-v1";

export type { MachineRpcAttestationClaims };

export function signMachineRpcAttestation(
  claims: MachineRpcAttestationClaims,
  privateKey: KeyObject | string | Buffer,
): string {
  const payload = Buffer.from(
    JSON.stringify(MachineRpcAttestationClaimsSchema.parse(structuredClone(claims))),
    "utf8",
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`${MACHINE_RPC_DOMAIN}.${payload}`, "utf8"),
    privateKey,
  ).toString("base64url");
  return `${MACHINE_RPC_PREFIX}.${payload}.${signature}`;
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
  const parts = attestation.split(".");
  if (parts.length !== 3 || parts[0] !== MACHINE_RPC_PREFIX) {
    throw new Error("invalid machine rpc attestation");
  }
  const payload = parts[1]!;
  const valid = verify(
    null,
    Buffer.from(`${MACHINE_RPC_DOMAIN}.${payload}`, "utf8"),
    publicKey,
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!valid) throw new Error("invalid machine rpc attestation signature");

  let claims: MachineRpcAttestationClaims;
  try {
    claims = MachineRpcAttestationClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
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
