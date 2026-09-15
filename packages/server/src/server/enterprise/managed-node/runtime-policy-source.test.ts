import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";

import type { ManagedRuntimePolicy } from "@getpaseo/protocol/managed-runtimes";

import { ManagementPlaneRequestError } from "./management-client.js";
import {
  type ManagedNodeRuntimeClient,
  ManagedNodeRuntimeDistributionState,
} from "./runtime-policy-source.js";

const policy: ManagedRuntimePolicy = {
  schemaVersion: 1,
  policyVersion: 4,
  pathFallback: "forbid",
  allowCommandOverride: false,
  autoInstall: true,
  runtimes: [
    {
      runtimeName: "codex",
      version: "0.153.4",
      providerIds: ["codex"],
      artifacts: [
        {
          platformArch: "darwin-arm64",
          fileName: "codex",
          archiveFormat: "raw",
          sha256: "a".repeat(64),
          sizeBytes: 12,
          command: "codex",
          launcher: "exec",
        },
      ],
    },
  ],
};

function client(overrides: Partial<ManagedNodeRuntimeClient> = {}) {
  const opened: string[] = [];
  const runtimeClient: ManagedNodeRuntimeClient = {
    refreshRuntimePolicy: async () => policy,
    openRuntimeArtifact: async (sha256) => {
      opened.push(sha256);
      return Readable.from(["artifact"]);
    },
    ...overrides,
  };
  return { runtimeClient, opened };
}

describe("ManagedNodeRuntimeDistributionState", () => {
  test("exposes the refreshed plane policy as a management plane install source", async () => {
    const { runtimeClient, opened } = client();
    const state = new ManagedNodeRuntimeDistributionState(runtimeClient);
    expect(state.policySource.current()).toBeNull();

    await state.refresh();
    await state.artifactSource.open(policy.runtimes[0]!.artifacts[0]!);

    expect(state.policySource.installSource).toBe("management_plane");
    expect(state.policySource.current()).toEqual(policy);
    expect(opened).toEqual(["a".repeat(64)]);
  });

  test("treats a plane without the runtime policy route as having no policy", async () => {
    const { runtimeClient } = client({
      refreshRuntimePolicy: async () => {
        throw new ManagementPlaneRequestError(404, "not_found", "route not found");
      },
    });
    const state = new ManagedNodeRuntimeDistributionState(runtimeClient);

    await expect(state.refresh()).resolves.toBeUndefined();
    expect(state.policySource.current()).toBeNull();
  });

  test("propagates other plane failures such as an unavailable node", async () => {
    const { runtimeClient } = client({
      refreshRuntimePolicy: async () => {
        throw new ManagementPlaneRequestError(404, "not_found", "node unavailable");
      },
    });

    await expect(new ManagedNodeRuntimeDistributionState(runtimeClient).refresh()).rejects.toThrow(
      "node unavailable",
    );
  });

  test("reports runtime status as heartbeat capabilities once a status provider is set", async () => {
    const state = new ManagedNodeRuntimeDistributionState(client().runtimeClient);
    expect(await state.capabilities()).toEqual({});

    state.reportStatus(async () => [
      {
        runtimeName: "codex",
        pinnedVersion: "0.153.4",
        activeVersion: "0.153.4",
        installedVersions: ["0.153.4"],
        status: "installed",
        commandPath: "/paseo/runtimes/bin/codex",
        error: null,
      },
    ]);

    expect(await state.capabilities()).toEqual({
      "runtime.codex": "0.153.4",
      "runtime.codex.status": "installed",
    });
  });
});
