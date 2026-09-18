import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";
import { loadPersistedConfig } from "@getpaseo/server";
import { resolveLocalDaemonState } from "../daemon/local-daemon.js";
import { createProductionEnterpriseInitDependencies } from "./index.js";
import { createProductionEnterpriseEnrollDependencies } from "./index.js";

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

describe("production enterprise enroll CLI adapter", () => {
  test("rejects enrollment while the daemon is running", async () => {
    const home = await createHome();
    const state = resolveLocalDaemonState({ home });
    const enrollNode = vi.fn();
    const dependencies = createProductionEnterpriseEnrollDependencies({
      resolveState: () => ({ ...state, running: true }),
      enrollNode,
    });

    await expect(
      dependencies.enroll({
        home,
        managementBaseUrl: "https://management.example:17443",
        caCertificatePath: "/private/ca.pem",
        endpoint: "wss://node.example:6767",
        enrollmentToken: "one-time-token",
      }),
    ).rejects.toMatchObject({ code: "ENTERPRISE_ENROLL_DAEMON_RUNNING" });
    expect(enrollNode).not.toHaveBeenCalled();
  });

  test("enrolls the local identity and atomically selects managed mode", async () => {
    const home = await createHome();
    const caCertificatePath = path.join(home, "management-ca.pem");
    await writeFile(caCertificatePath, "test-ca", { mode: 0o600 });
    const relationshipPath = path.join(home, "managed-relationship.json");
    const enrollNode = vi.fn(async (input) => ({
      version: 1 as const,
      managementBaseUrl: "https://management.example:17443",
      node: {
        nodeId,
        organizationId,
        bootId: input.heartbeat.bootId,
        paseoServerId: input.heartbeat.paseoServerId,
        endpoint: input.heartbeat.endpoint,
        version: input.heartbeat.version,
        capabilities: input.heartbeat.capabilities,
        capacity: input.heartbeat.capacity,
        publicKeyPem: "public-key",
        status: "registered" as const,
        lastSeenAt: null,
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
      nodePrivateKeyPem: "private-key",
      ticketPublicKeyPem: "ticket-public-key",
    }));
    const dependencies = createProductionEnterpriseEnrollDependencies({
      enrollNode,
      resolveVersion: () => "8.1.0-enterprise",
    });

    await expect(
      dependencies.enroll({
        home,
        managementBaseUrl: "https://management.example:17443",
        caCertificatePath,
        endpoint: "wss://node.example:6767",
        relationshipPath,
        enrollmentToken: "one-time-token",
      }),
    ).resolves.toMatchObject({ nodeId, organizationId, relationshipPath });
    expect(enrollNode).toHaveBeenCalledWith(
      expect.objectContaining({
        managementBaseUrl: "https://management.example:17443",
        enrollmentToken: "one-time-token",
        relationshipPath,
        caCertificate: Buffer.from("test-ca"),
        heartbeat: expect.objectContaining({
          bootId: expect.stringMatching(/^boot_[0-9a-f]{32}$/),
          paseoServerId: expect.stringMatching(/^srv_/),
          endpoint: "wss://node.example:6767",
          version: "8.1.0-enterprise",
          capabilities: expect.objectContaining({ enterpriseManagedV1: true }),
        }),
      }),
    );
    expect(loadPersistedConfig(home).features?.enterpriseMultiUser).toEqual({
      enabled: true,
      organizationId,
      nodeId,
      managementMode: "managed",
      legacyRecords: "owner_only",
      management: {
        baseUrl: "https://management.example:17443",
        caCertificatePath,
        relationshipPath,
      },
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
