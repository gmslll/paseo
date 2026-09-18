/**
 * The canonical string form an audit event is hashed as.
 *
 * Shared rather than duplicated: the node computes a hash chain over its own events and the
 * management plane verifies and continues that chain, so two implementations of this would drift
 * and turn every verification into a false mismatch — the kind that only shows up across versions,
 * because a test where both sides run the new code still passes.
 *
 * Deliberately free of `node:crypto`. This module is in the protocol package, which the Expo client
 * also consumes, and Hermes has no node built-ins. The digest itself is a single line each side;
 * the part that has to agree byte for byte is the canonical form, and that lives here.
 */

function compareCanonicalEntries(left: [string, unknown], right: [string, unknown]): number {
  if (left[0] < right[0]) return -1;
  if (left[0] > right[0]) return 1;
  return 0;
}

/**
 * Object keys sort by plain code-unit order, `undefined` entries drop out, and everything else goes
 * through JSON.stringify, so the result does not depend on key insertion order or on the engine.
 */
export function canonicalAuditValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAuditValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(compareCanonicalEntries)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalAuditValue(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("unsupported canonical audit value");
  return serialized;
}
