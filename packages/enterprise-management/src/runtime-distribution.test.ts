import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import {
  type AuthenticatedManagementPrincipal,
  EnterpriseManagementPlane,
} from "./management-plane.js";

const ORG = "org_0123456789abcdef";
const BOOTSTRAP_SECRET = "runtime-distribution-bootstrap-secret";
const ARCHIVE = Buffer.from("#!/bin/sh\necho codex-cli 0.153.4\n");
const ARCHIVE_SHA256 = createHash("sha256").update(ARCHIVE).digest("hex");

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  employee: AuthenticatedManagementPrincipal;
  artifactDirectory: string;
}

async function createHarness(options: { withStorage?: boolean } = {}): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-runtime-distribution-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const artifactDirectory = path.join(directory, "artifacts");
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath: ":memory:",
    organizationId: ORG,
    organizationName: "Runtime distribution",
    issuer: "https://management.test:17443",
    bootstrapSecret: BOOTSTRAP_SECRET,
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
    ...(options.withStorage === false ? {} : { runtimeArtifactDirectory: artifactDirectory }),
  });
  cleanup.push(() => plane.close());
  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: BOOTSTRAP_SECRET,
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const employeePrincipal = await plane.createPrincipal(admin, {
    displayName: "Employee",
    principalType: "human",
    role: "employee",
  });
  const employeeToken = await plane.issuePersonalAccessToken(admin, employeePrincipal.principalId);
  const employee = (await plane.authenticatePersonalAccessToken(employeeToken.token))!;
  return { plane, admin, employee, artifactDirectory };
}

function upload(
  harness: Harness,
  actor: AuthenticatedManagementPrincipal,
  overrides: { sha256?: string; version?: string } = {},
) {
  return harness.plane.uploadRuntimeArtifact(actor, {
    runtimeName: "codex",
    version: overrides.version ?? "0.153.4",
    platformArch: "darwin-arm64",
    fileName: "codex",
    archiveFormat: "raw",
    command: "codex",
    launcher: "exec",
    sha256: overrides.sha256 ?? ARCHIVE_SHA256,
    body: Readable.from([ARCHIVE]),
  });
}

async function enrollNode(
  harness: Harness,
  capabilities: Record<string, string | number | boolean> = {},
) {
  const nodeKeys = generateKeyPairSync("ed25519");
  const enrollment = await harness.plane.createEnrollmentToken(harness.admin, {
    expiresInMs: 60_000,
  });
  const enrolled = await harness.plane.enrollNode({
    token: enrollment.token,
    paseoServerId: "server-runtime",
    endpoint: "wss://node-runtime.test:6767",
    bootId: "boot-runtime",
    version: "0.9.0",
    publicKeyPem: nodeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    capabilities,
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16_000_000_000,
      memoryAvailableBytes: 12_000_000_000,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  });
  return enrolled.node;
}

describe("runtime distribution", () => {
  test("stores an uploaded artifact under its digest and lists it", async () => {
    const harness = await createHarness();

    const artifact = await upload(harness, harness.admin);

    expect(artifact).toMatchObject({
      runtimeName: "codex",
      version: "0.153.4",
      sha256: ARCHIVE_SHA256,
      sizeBytes: ARCHIVE.length,
    });
    expect(readFileSync(path.join(harness.artifactDirectory, ARCHIVE_SHA256))).toEqual(ARCHIVE);
    expect(await harness.plane.listRuntimeArtifacts(harness.admin)).toEqual([artifact]);
    await expect(upload(harness, harness.admin)).rejects.toThrow("already uploaded");
  });

  test("rejects a digest mismatch without keeping any part of the upload", async () => {
    const harness = await createHarness();

    await expect(upload(harness, harness.admin, { sha256: "0".repeat(64) })).rejects.toThrow(
      "sha256 does not match",
    );

    expect(readdirSync(harness.artifactDirectory)).toEqual([]);
    expect(await harness.plane.listRuntimeArtifacts(harness.admin)).toEqual([]);
  });

  test("only identity managers upload artifacts or change the runtime policy", async () => {
    const harness = await createHarness();
    await upload(harness, harness.admin);

    await expect(upload(harness, harness.employee, { version: "0.153.5" })).rejects.toThrow(
      "denied",
    );
    await expect(
      harness.plane.setRuntimePin(harness.employee, "codex", {
        version: "0.153.4",
        providerIds: ["codex"],
        expectedPolicyVersion: 0,
      }),
    ).rejects.toThrow("denied");
    await expect(harness.plane.getRuntimePolicy(harness.employee)).rejects.toThrow("denied");
  });

  test("pins require an uploaded artifact and the current policy version", async () => {
    const harness = await createHarness();
    const pin = { version: "0.153.4", providerIds: ["codex"], expectedPolicyVersion: 0 };

    await expect(harness.plane.setRuntimePin(harness.admin, "codex", pin)).rejects.toThrow(
      "unavailable",
    );
    await upload(harness, harness.admin);
    await expect(
      harness.plane.setRuntimePin(harness.admin, "codex", { ...pin, expectedPolicyVersion: 1 }),
    ).rejects.toThrow("version conflict");

    const pinned = await harness.plane.setRuntimePin(harness.admin, "codex", pin);
    expect(pinned).toMatchObject({
      policyVersion: 1,
      pathFallback: "allow",
      allowCommandOverride: false,
      autoInstall: true,
      runtimes: [
        {
          runtimeName: "codex",
          version: "0.153.4",
          providerIds: ["codex"],
          artifacts: [{ sha256: ARCHIVE_SHA256, platformArch: "darwin-arm64" }],
        },
      ],
    });

    const tightened = await harness.plane.updateRuntimePolicySettings(harness.admin, {
      pathFallback: "forbid",
      allowCommandOverride: false,
      autoInstall: false,
      expectedPolicyVersion: 1,
    });
    expect(tightened).toMatchObject({ policyVersion: 2, pathFallback: "forbid" });
    await expect(
      harness.plane.updateRuntimePolicySettings(harness.admin, {
        pathFallback: "allow",
        allowCommandOverride: true,
        autoInstall: true,
        expectedPolicyVersion: 1,
      }),
    ).rejects.toThrow("version conflict");
  });

  test("an enrolled node reads the policy and resolves only known artifacts", async () => {
    const harness = await createHarness();
    expect(harness.plane.getNodeRuntimePolicy((await enrollNode(harness)).nodeId)).toBeNull();
    await upload(harness, harness.admin);
    const policy = await harness.plane.setRuntimePin(harness.admin, "codex", {
      version: "0.153.4",
      providerIds: ["codex"],
      expectedPolicyVersion: 0,
    });
    const [node] = await harness.plane.listNodes(harness.admin);

    expect(harness.plane.getNodeRuntimePolicy(node!.nodeId)).toEqual(policy);
    expect(
      readFileSync(harness.plane.nodeRuntimeArtifactPath(node!.nodeId, ARCHIVE_SHA256)),
    ).toEqual(ARCHIVE);
    expect(() => harness.plane.nodeRuntimeArtifactPath(node!.nodeId, "f".repeat(64))).toThrow(
      "not found",
    );
    expect(() => harness.plane.getNodeRuntimePolicy("nod_0123456789abcdef")).toThrow("unavailable");
  });

  test("lists runtime status that nodes report through heartbeat capabilities", async () => {
    const harness = await createHarness();
    const node = await enrollNode(harness, {
      platform: "darwin",
      "runtime.claude-code": "2.1.258",
      "runtime.claude-code.status": "installed",
    });

    expect(await harness.plane.listNodeRuntimeStatus(harness.admin)).toEqual([
      {
        nodeId: node.nodeId,
        status: node.status,
        runtimes: [{ runtimeName: "claude-code", activeVersion: "2.1.258", status: "installed" }],
      },
    ]);
  });

  test("a plane without persistent storage refuses artifact uploads", async () => {
    const harness = await createHarness({ withStorage: false });

    await expect(upload(harness, harness.admin)).rejects.toThrow("storage unavailable");
    expect(existsSync(harness.artifactDirectory)).toBe(false);
  });
});
