import { Command } from "commander";

import { describe, expect, test, vi } from "vitest";

import { runEnterpriseEnrollCommand } from "./enroll.js";

describe("enterprise enroll command", () => {
  test("reads a private token file and returns the enrolled node", async () => {
    const enroll = vi.fn(async () => result);
    const readEnrollmentToken = vi.fn(async () => "  one-time-token\n");

    await expect(
      runEnterpriseEnrollCommand(
        {
          management: "https://management.example:17443",
          ca: "/private/management-ca.pem",
          endpoint: "wss://node.example:6767",
          tokenFile: "/private/enrollment-token",
          enroll,
          readEnrollmentToken,
        },
        new Command(),
      ),
    ).resolves.toMatchObject({ type: "single", data: result });
    expect(readEnrollmentToken).toHaveBeenCalledWith("/private/enrollment-token");
    expect(enroll).toHaveBeenCalledWith({
      managementBaseUrl: "https://management.example:17443",
      caCertificatePath: "/private/management-ca.pem",
      endpoint: "wss://node.example:6767",
      enrollmentToken: "one-time-token",
    });
  });

  test("prompts without exposing the token in command options", async () => {
    const enroll = vi.fn(async () => result);
    const promptEnrollmentToken = vi.fn(async () => "prompt-token");

    await runEnterpriseEnrollCommand(
      {
        management: "https://management.example:17443",
        ca: "/private/management-ca.pem",
        endpoint: "wss://node.example:6767",
        enroll,
        promptEnrollmentToken,
      },
      new Command(),
    );

    expect(promptEnrollmentToken).toHaveBeenCalledOnce();
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentToken: "prompt-token" }),
    );
  });

  test("fails closed when a required value or token is missing", async () => {
    const enroll = vi.fn(async () => result);
    await expect(
      runEnterpriseEnrollCommand(
        {
          management: "https://management.example:17443",
          ca: "/private/management-ca.pem",
          endpoint: "",
          enroll,
        },
        new Command(),
      ),
    ).rejects.toMatchObject({ code: "ENTERPRISE_ENROLL_ENDPOINT_REQUIRED" });
    expect(enroll).not.toHaveBeenCalled();
  });
});

const result = Object.freeze({
  organizationId: "org_aaaaaaaaaaaaaaaa",
  nodeId: "nod_aaaaaaaaaaaaaaaa",
  endpoint: "wss://node.example:6767",
  managementBaseUrl: "https://management.example:17443",
  relationshipPath: "/private/managed-node-relationship.json",
});
