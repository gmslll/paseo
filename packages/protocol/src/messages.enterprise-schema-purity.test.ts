import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const BANNED_WIRE_HELPER = /\.(?:transform|catch|preprocess)\s*\(/;

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("enterprise wire schema purity", () => {
  test("enterprise core, RPC, and browser wire schemas use explicit normalization", async () => {
    const [messages, browserRpc, browserCapabilities] = await Promise.all([
      readFile(new URL("./messages.ts", import.meta.url), "utf8"),
      readFile(new URL("./browser-automation/rpc-schemas.ts", import.meta.url), "utf8"),
      readFile(new URL("./browser-automation/capabilities.ts", import.meta.url), "utf8"),
    ]);
    const coreContracts = between(
      messages,
      "export const ENTERPRISE_FEATURE_FLAGS",
      "const MutableDaemonProviderModelSchema",
    );
    const rpcContracts = between(
      messages,
      "const EnterprisePrincipalRecordSharedShape",
      "// These connection event streams",
    );

    expect(coreContracts).not.toMatch(BANNED_WIRE_HELPER);
    expect(rpcContracts).not.toMatch(BANNED_WIRE_HELPER);
    expect(browserRpc).not.toMatch(BANNED_WIRE_HELPER);
    expect(browserCapabilities).not.toMatch(BANNED_WIRE_HELPER);
  });

  test("removable enterprise gates carry the frozen compatibility deadline", async () => {
    const sources = await Promise.all([
      readFile(new URL("./messages.ts", import.meta.url), "utf8"),
      readFile(new URL("./browser-automation/rpc-schemas.ts", import.meta.url), "utf8"),
      readFile(new URL("./browser-automation/capabilities.ts", import.meta.url), "utf8"),
    ]);
    const gateLines = sources
      .flatMap((source) => source.split("\n"))
      .filter((line) => line.includes("COMPAT(enterprise"));

    expect(gateLines.length).toBeGreaterThan(0);
    for (const line of gateLines) {
      expect(line).toContain("added in v0.9.0");
      expect(line).toContain("2027-03-09");
      expect(line).toMatch(/remove (?:gate )?after|remove after/);
    }
  });
});
