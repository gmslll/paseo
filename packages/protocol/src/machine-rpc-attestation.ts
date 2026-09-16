import {
  MachineRpcAttestationClaimsSchema,
  type MachineRpcAttestationClaims,
} from "./enterprise-collaboration.js";

/**
 * The canonical form of a machine RPC attestation (ADR-0035).
 *
 * Shared rather than duplicated: the plane signs one and the node verifies it, and two
 * implementations of the encoding would drift and turn every verification into a false mismatch —
 * the kind that only shows up across versions, because a test where both sides run the new code
 * still passes.
 *
 * Deliberately free of `node:crypto`, like `audit-canonical.ts` and for the same reason: this
 * package is also consumed by the Expo client, and Hermes has no node built-ins. Signing and
 * verifying are a single line each side; what has to agree byte for byte is the string that gets
 * signed, and that lives here.
 *
 * The prefix and separator differ from the Session ticket's and the stream token's because all
 * three are signed with the plane's one ticket key. Without distinct separators a stream token
 * would verify as an attestation: same key, same construction, different authority.
 */

export const MACHINE_RPC_ATTESTATION_PREFIX = "pmr_v1";
export const MACHINE_RPC_ATTESTATION_DOMAIN = "paseo-machine-rpc-v1";

export interface MachineRpcAttestationParts {
  readonly payload: string;
  readonly signature: string;
}

/** Claims as the bytes that get signed, with the schema fixing the key set so the form is stable. */
export function encodeMachineRpcAttestationClaims(claims: MachineRpcAttestationClaims): string {
  return Buffer.from(
    JSON.stringify(MachineRpcAttestationClaimsSchema.parse(structuredClone(claims))),
    "utf8",
  ).toString("base64url");
}

/** What both sides run their one crypto call over. */
export function machineRpcAttestationSigningInput(payload: string): string {
  return `${MACHINE_RPC_ATTESTATION_DOMAIN}.${payload}`;
}

export function formatMachineRpcAttestation(payload: string, signature: string): string {
  return `${MACHINE_RPC_ATTESTATION_PREFIX}.${payload}.${signature}`;
}

/**
 * Splits a token without verifying it. Returns null for anything that is not three parts under this
 * prefix, so a token belonging to one of the other two artifacts never reaches a signature check
 * that might otherwise pass.
 */
export function parseMachineRpcAttestation(attestation: string): MachineRpcAttestationParts | null {
  const parts = attestation.split(".");
  if (parts.length !== 3 || parts[0] !== MACHINE_RPC_ATTESTATION_PREFIX) return null;
  const [, payload, signature] = parts;
  return payload && signature ? { payload, signature } : null;
}

/** Decodes the payload a verified token carried. Throws if it is not well-formed claims. */
export function decodeMachineRpcAttestationClaims(payload: string): MachineRpcAttestationClaims {
  return MachineRpcAttestationClaimsSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString()),
  );
}
