import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveRuntimeConfig } from "./cli.js";

describe("management plane runtime config", () => {
  test("uses the fixed TLS deployment contract", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-management-config-"));
    const cert = path.join(directory, "tls.crt");
    const key = path.join(directory, "tls.key");
    writeFileSync(cert, "test");
    writeFileSync(key, "test");
    chmodSync(key, 0o600);
    expect(
      resolveRuntimeConfig({
        PASEO_MANAGEMENT_DATA_DIR: directory,
        PASEO_MANAGEMENT_LISTEN: "0.0.0.0:17443",
        PASEO_MANAGEMENT_TLS_CERT: cert,
        PASEO_MANAGEMENT_TLS_KEY: key,
        PASEO_MANAGEMENT_ORGANIZATION_ID: "org_0123456789abcdef",
        PASEO_MANAGEMENT_ORGANIZATION_NAME: "Paseo Enterprise",
        PASEO_MANAGEMENT_ISSUER: "https://159.75.105.5:17443/",
        PASEO_MANAGEMENT_BOOTSTRAP_SECRET: "bootstrap-secret-with-enough-entropy",
      }),
    ).toMatchObject({
      listenHost: "0.0.0.0",
      listenPort: 17443,
      issuer: "https://159.75.105.5:17443",
      databasePath: path.join(directory, "management.sqlite"),
    });
  });

  test("rejects plaintext issuers and short bootstrap secrets", () => {
    const base = {
      PASEO_MANAGEMENT_DATA_DIR: "/tmp/paseo-management",
      PASEO_MANAGEMENT_TLS_CERT: "/tmp/tls.crt",
      PASEO_MANAGEMENT_TLS_KEY: "/tmp/tls.key",
      PASEO_MANAGEMENT_ORGANIZATION_ID: "org_0123456789abcdef",
      PASEO_MANAGEMENT_ORGANIZATION_NAME: "Paseo Enterprise",
      PASEO_MANAGEMENT_BOOTSTRAP_SECRET: "bootstrap-secret-with-enough-entropy",
    };
    expect(() =>
      resolveRuntimeConfig({ ...base, PASEO_MANAGEMENT_ISSUER: "http://management.test" }),
    ).toThrow("must use https");
    expect(() =>
      resolveRuntimeConfig({
        ...base,
        PASEO_MANAGEMENT_ISSUER: "https://management.test",
        PASEO_MANAGEMENT_BOOTSTRAP_SECRET: "short",
      }),
    ).toThrow("too short");
  });
});
