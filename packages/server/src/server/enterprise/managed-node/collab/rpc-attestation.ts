import { verify, type KeyObject } from "node:crypto";

import type { MachineRpcAttestationClaims } from "@getpaseo/protocol/enterprise-collaboration";
import {
  decodeMachineRpcAttestationClaims,
  machineRpcAttestationSigningInput,
  parseMachineRpcAttestation,
} from "@getpaseo/protocol/machine-rpc-attestation";

/**
 * The node's side of the machine RPC attestation (ADR-0035).
 *
 * The node holds no membership table and no Grant store. It acts on an RPC because the plane
 * signed one, and this is where that signature is checked — before anything reaches a Session.
 *
 * The plane's signer lives in the management package, which the daemon depends on only for tests,
 * so the verification is here and the encoding both sides agree on is in the protocol package. What
 * is duplicated is one `verify` call; what would have drifted is not.
 */

export interface MachineRpcAttestationExpectation {
  readonly nowMs: number;
  readonly nodeId: string;
  readonly containerId: string;
  readonly rpcId: string;
  /**
   * The requester's Grant version as this node's policy currently has it. Required: an attestation
   * lives 60 seconds, and revocation reaches a node as a policy refresh that rolls this value, so
   * skipping the comparison would let a removed collaborator keep driving an Agent until it expired.
   */
  readonly currentGrantVersion: string;
}

export class MachineRpcAttestationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "malformed"
      | "bad_signature"
      | "bad_claims"
      | "audience_mismatch"
      | "expired"
      | "revoked",
  ) {
    super(message);
    this.name = "MachineRpcAttestationError";
  }
}

export function verifyMachineRpcAttestation(
  attestation: string,
  planeTicketPublicKeyPem: KeyObject | string | Buffer,
  expected: MachineRpcAttestationExpectation,
): MachineRpcAttestationClaims {
  const parts = parseMachineRpcAttestation(attestation);
  // A token under another prefix is refused before any signature check: the plane signs three
  // artifacts with one key, and only the separator keeps them from standing in for each other.
  if (!parts) throw new MachineRpcAttestationError("malformed attestation", "malformed");

  const valid = verify(
    null,
    Buffer.from(machineRpcAttestationSigningInput(parts.payload), "utf8"),
    planeTicketPublicKeyPem,
    Buffer.from(parts.signature, "base64url"),
  );
  if (!valid) throw new MachineRpcAttestationError("attestation signature", "bad_signature");

  let claims: MachineRpcAttestationClaims;
  try {
    claims = decodeMachineRpcAttestationClaims(parts.payload);
  } catch (error) {
    throw new MachineRpcAttestationError(`attestation claims: ${String(error)}`, "bad_claims");
  }

  // It names the one call it was written for. Replaying it at another node, container or rpcId is a
  // mismatch rather than a missing grant, so the three read alike.
  if (
    claims.nodeId !== expected.nodeId ||
    claims.containerId !== expected.containerId ||
    claims.rpcId !== expected.rpcId
  ) {
    throw new MachineRpcAttestationError("attestation audience", "audience_mismatch");
  }
  if (expected.nowMs >= Date.parse(claims.expiresAt)) {
    throw new MachineRpcAttestationError("attestation expired", "expired");
  }
  if (claims.requester.grantVersion !== expected.currentGrantVersion) {
    throw new MachineRpcAttestationError("attestation grant version", "revoked");
  }
  return claims;
}
