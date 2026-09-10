import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { provisionProductionEnterpriseInitialAdmin } from "./production-provisioning.js";

const principal = "usr_aaaaaaaaaaaaaaaa";
const organization = "org_aaaaaaaaaaaaaaaa";

describe("production enterprise initial provisioning orchestration", () => {
  test("provisions once and does not print a second token on rerun", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-enterprise-init-"));
    await mkdir(path.join(home, "enterprise"));
    let provisioned = false;
    const issue = vi.fn(async () => {
      if (provisioned)
        return {
          status: "already_provisioned",
          credentialIds: ["cred_aaaaaaaaaaaaaaaaaaaaaaaa"],
        };
      provisioned = true;
      return {
        status: "issued",
        credentialId: "cred_aaaaaaaaaaaaaaaaaaaaaaaa",
        token: "pso_u_cred_aaaaaaaaaaaaaaaaaaaaaaaa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      };
    });
    const ports = {
      current: () => true,
      authenticateBreakGlass: vi.fn(
        async () =>
          ({
            principalType: "break_glass_owner",
            principalId: "owner",
            organizationId: organization,
            credentialId: "local",
            grantVersion: "g",
            grants: [],
          }) as never,
      ),
      ensurePrincipalIntent: vi.fn(async (record) => ({
        ...record,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      provisionInitialGrant: vi.fn(async () => ({ grantVersion: "grv_1" })),
      issueInitialCredential: issue,
    };
    try {
      const input = {
        paseoHome: home,
        organizationId: organization,
        principalId: principal,
        grants: [],
      };
      await expect(
        provisionProductionEnterpriseInitialAdmin(input, ports, "password"),
      ).resolves.toMatchObject({ token: expect.any(String), alreadyProvisioned: false });
      await expect(
        provisionProductionEnterpriseInitialAdmin(input, ports, "password"),
      ).resolves.toMatchObject({ credentialId: expect.any(String), alreadyProvisioned: true });
      expect(issue).toHaveBeenCalledTimes(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("fails before persistence when audit/current authority is unavailable", async () => {
    const ports = {
      current: () => false,
      authenticateBreakGlass: vi.fn(),
      ensurePrincipalIntent: vi.fn(),
      provisionInitialGrant: vi.fn(),
      issueInitialCredential: vi.fn(),
    };
    await expect(
      provisionProductionEnterpriseInitialAdmin(
        {
          paseoHome: "/tmp/paseo",
          organizationId: organization,
          principalId: principal,
          grants: [],
        },
        ports,
        "password",
      ),
    ).rejects.toThrow(/unavailable/);
    expect(ports.authenticateBreakGlass).not.toHaveBeenCalled();
  });
});
