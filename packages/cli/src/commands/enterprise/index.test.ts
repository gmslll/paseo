import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveLocalDaemonState } from "../daemon/local-daemon.js";
import { createProductionEnterpriseInitDependencies } from "./index.js";

const organizationId = "org_aaaaaaaaaaaaaaaa" as const;
const nodeId = "nod_aaaaaaaaaaaaaaaa" as const;
const principalId = "usr_aaaaaaaaaaaaaaaa" as const;
const passwordHash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("production enterprise init CLI adapter", () => {
  test("rejects a running daemon before opening the provisioning authority", async () => {
    const home = await createHome();
    const state = resolveLocalDaemonState({ home });
    const provisionFromHome = vi.fn();
    const dependencies = createProductionEnterpriseInitDependencies({
      resolveState: () => ({ ...state, running: true }),
      provisionFromHome,
    });

    await expect(
      dependencies.provision({ principalId, bootstrapPassword: "password", home }),
    ).rejects.toMatchObject({ code: "ENTERPRISE_INIT_DAEMON_RUNNING" });
    expect(provisionFromHome).not.toHaveBeenCalled();
  });

  test("maps persisted enterprise authority into the one-shot production adapter", async () => {
    const home = await createHome();
    const provisionFromHome = vi.fn(async () => ({
      principalId,
      credentialId: "cred_aaaaaaaaaaaaaaaaaaaaaaaa",
      token: "one-time-token",
      alreadyProvisioned: false,
    }));
    const dependencies = createProductionEnterpriseInitDependencies({ provisionFromHome });

    await expect(
      dependencies.provision({
        principalId,
        displayName: "Initial administrator",
        bootstrapPassword: "password",
        home,
      }),
    ).resolves.toMatchObject({ token: "one-time-token", alreadyProvisioned: false });
    expect(provisionFromHome).toHaveBeenCalledOnce();
    expect(provisionFromHome).toHaveBeenCalledWith({
      paseoHome: home,
      enterpriseConfig: {
        enabled: true,
        organizationId,
        nodeId,
        managementMode: "standalone",
        legacyRecords: "owner_only",
      },
      paseoServerId: expect.stringMatching(/^srv_/),
      daemonPasswordHash: passwordHash,
      bootstrapPassword: "password",
      principalId,
      displayName: "Initial administrator",
    });
  });
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-enterprise-cli-init-"));
  homes.push(home);
  await chmod(home, 0o700);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({
      daemon: { auth: { password: passwordHash } },
      features: {
        enterpriseMultiUser: {
          enabled: true,
          organizationId,
          nodeId,
          managementMode: "standalone",
          legacyRecords: "owner_only",
        },
      },
    }),
    { mode: 0o600 },
  );
  return home;
}
