import { describe, expect, test } from "vitest";
import { parseEnterprisePasswordSessionRequest } from "./enterprise-password-session.js";

describe("parseEnterprisePasswordSessionRequest", () => {
  test("accepts a password exchange body without a node id", () => {
    expect(
      parseEnterprisePasswordSessionRequest({
        username: "admin",
        password: "employee-password-2026",
        clientId: "cid_test:enterprise:1",
        ttlMs: 300_000,
      }),
    ).toEqual({
      username: "admin",
      password: "employee-password-2026",
      clientId: "cid_test:enterprise:1",
      ttlMs: 300_000,
    });
  });

  test("rejects a short password and extra fields", () => {
    expect(
      parseEnterprisePasswordSessionRequest({
        username: "admin",
        password: "short",
        clientId: "cid_test:enterprise:1",
        ttlMs: 300_000,
      }),
    ).toBeNull();
    expect(
      parseEnterprisePasswordSessionRequest({
        username: "admin",
        password: "employee-password-2026",
        clientId: "cid_test:enterprise:1",
        ttlMs: 300_000,
        nodeId: "nod_aaaaaaaaaaaaaaaa",
      }),
    ).toBeNull();
  });
});
