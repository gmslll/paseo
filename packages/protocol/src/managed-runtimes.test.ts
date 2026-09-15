import { describe, expect, test } from "vitest";

import {
  type ManagedRuntimeInstallMetadata,
  type ManagedRuntimePin,
  ManagedRuntimeArtifactSchema,
  ManagedRuntimeCommandSchema,
  ManagedRuntimePolicySchema,
  PlatformArchSchema,
  Sha256HexSchema,
  managedRuntimeMetadataMatchesPin,
  selectManagedRuntimeArtifact,
  ManagedRuntimeNodePolicyResponseSchema,
  ManagedRuntimePinUpdateSchema,
  managedRuntimeCapabilities,
  parseManagedRuntimeCapabilities,
} from "./managed-runtimes.js";

const SHA = "a".repeat(64);

const artifact = {
  platformArch: "darwin-arm64",
  fileName: "claude-2.1.258-darwin-arm64.tar.gz",
  archiveFormat: "tar.gz",
  sha256: SHA,
  sizeBytes: 1024,
  command: "bin/claude",
  launcher: "exec",
} as const;

const pin: ManagedRuntimePin = {
  runtimeName: "claude-code",
  version: "2.1.258",
  providerIds: ["claude"],
  artifacts: [artifact, { ...artifact, platformArch: "linux-x64", sha256: "b".repeat(64) }],
};

describe("managed runtime identifiers", () => {
  test.each(["bin/claude", "codex", "./node_modules/.bin/kimi", "lib/@scope/pkg/cli.js"])(
    "accepts relative command %j",
    (command) => {
      expect(ManagedRuntimeCommandSchema.safeParse(command).success).toBe(true);
    },
  );

  test.each([
    "",
    "/usr/bin/claude",
    "../claude",
    "bin/../../claude",
    "bin/..",
    "bin//claude",
    "bin\\claude",
  ])("rejects command %j", (command) => {
    expect(ManagedRuntimeCommandSchema.safeParse(command).success).toBe(false);
  });

  test("artifact file names cannot name a directory or traverse", () => {
    expect(ManagedRuntimeArtifactSchema.safeParse({ ...artifact, fileName: ".." }).success).toBe(
      false,
    );
    expect(ManagedRuntimeArtifactSchema.safeParse({ ...artifact, fileName: "a/b" }).success).toBe(
      false,
    );
  });

  test("platform and digest formats are exact", () => {
    expect(PlatformArchSchema.safeParse("darwin-arm64").success).toBe(true);
    expect(PlatformArchSchema.safeParse("win32-x64").success).toBe(true);
    expect(PlatformArchSchema.safeParse("darwin-ppc").success).toBe(false);
    expect(Sha256HexSchema.safeParse(SHA).success).toBe(true);
    expect(Sha256HexSchema.safeParse("A".repeat(64)).success).toBe(false);
    expect(Sha256HexSchema.safeParse("a".repeat(63)).success).toBe(false);
  });
});

describe("managed runtime policy", () => {
  const policy = {
    schemaVersion: 1,
    policyVersion: 3,
    runtimes: [pin],
    pathFallback: "forbid",
    allowCommandOverride: false,
    autoInstall: true,
  };

  test("an older node ignores policy fields added by a newer plane", () => {
    const parsed = ManagedRuntimePolicySchema.parse({
      ...policy,
      rolloutPercent: 50,
      runtimes: [{ ...pin, releaseNotesUrl: "https://example.test" }],
    });

    expect(parsed).toEqual(policy);
  });

  test("selects the artifact for the node platform", () => {
    expect(selectManagedRuntimeArtifact(pin, "linux-x64")?.sha256).toBe("b".repeat(64));
    expect(selectManagedRuntimeArtifact(pin, "win32-arm64")).toBeNull();
  });

  test("install metadata matches only the exact pinned artifact", () => {
    const metadata: ManagedRuntimeInstallMetadata = {
      schemaVersion: 1,
      runtimeName: "claude-code",
      runtimeVersion: "2.1.258",
      platformArch: "darwin-arm64",
      command: "bin/claude",
      archiveSha256: SHA,
      archiveSize: 1024,
      installedAt: "2026-09-16T00:00:00.000Z",
      source: "management_plane",
      policyVersion: 3,
    };

    expect(managedRuntimeMetadataMatchesPin({ metadata, pin, artifact })).toBe(true);
    expect(
      managedRuntimeMetadataMatchesPin({
        metadata: { ...metadata, archiveSha256: "c".repeat(64) },
        pin,
        artifact,
      }),
    ).toBe(false);
    expect(
      managedRuntimeMetadataMatchesPin({
        metadata: { ...metadata, runtimeVersion: "2.1.257" },
        pin,
        artifact,
      }),
    ).toBe(false);
  });
});

describe("node runtime distribution contracts", () => {
  test("runtime status round-trips through heartbeat capabilities", () => {
    const capabilities = managedRuntimeCapabilities([
      {
        runtimeName: "claude-code",
        pinnedVersion: "2.1.258",
        activeVersion: "2.1.258",
        installedVersions: ["2.1.258"],
        status: "installed",
        commandPath: "/paseo/runtimes/bin/claude-code",
        error: null,
      },
      {
        runtimeName: "codex",
        pinnedVersion: "0.153.4",
        activeVersion: null,
        installedVersions: [],
        status: "not_installed",
        commandPath: null,
        error: null,
      },
    ]);

    expect(capabilities).toEqual({
      "runtime.claude-code": "2.1.258",
      "runtime.claude-code.status": "installed",
      "runtime.codex": "",
      "runtime.codex.status": "not_installed",
    });
    expect(
      parseManagedRuntimeCapabilities({
        ...capabilities,
        platform: "darwin",
        browserProfiles: true,
      }),
    ).toEqual([
      { runtimeName: "claude-code", activeVersion: "2.1.258", status: "installed" },
      { runtimeName: "codex", activeVersion: null, status: "not_installed" },
    ]);
  });

  test("node policy responses may carry no policy and pin updates reject unknown fields", () => {
    expect(ManagedRuntimeNodePolicyResponseSchema.parse({ policy: null })).toEqual({
      policy: null,
    });
    expect(
      ManagedRuntimePinUpdateSchema.safeParse({
        version: "1.0.0",
        providerIds: ["claude"],
        expectedPolicyVersion: 0,
        artifacts: [],
      }).success,
    ).toBe(false);
  });
});
