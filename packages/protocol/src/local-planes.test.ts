import { describe, expect, test } from "vitest";

import {
  DaemonManifestSchema,
  LOCAL_PLANE_NAMES,
  LOCAL_PLANE_UPGRADE_PROTOCOLS,
  ProbeStateSchema,
  localPlanePipePath,
  localPlaneSocketFileName,
} from "./local-planes.js";

const AT = "2026-09-16T00:00:00.000Z";

describe("daemon manifest", () => {
  const manifest = {
    schemaVersion: 1,
    pid: 4242,
    supervisorPid: null,
    serverId: "server-1",
    version: "0.9.0",
    startedAt: AT,
    listen: "127.0.0.1:6767",
    planes: {
      control: { transport: "unix", path: "/home/u/.paseo/run/control.sock", protocolVersion: 1 },
      probe: { transport: "unix", path: "/home/u/.paseo/run/probe.sock", protocolVersion: 1 },
    },
  };

  test("parses a manifest that lists only some planes", () => {
    expect(DaemonManifestSchema.parse(manifest)).toEqual(manifest);
  });

  test("an older reader ignores fields a newer daemon adds", () => {
    expect(
      DaemonManifestSchema.parse({
        ...manifest,
        worker: { pid: 1 },
        planes: {
          ...manifest.planes,
          metrics: { transport: "unix", path: "/x", protocolVersion: 1 },
        },
      }),
    ).toEqual(manifest);
  });

  test("rejects a different manifest schema version", () => {
    expect(DaemonManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(false);
  });
});

describe("probe state", () => {
  const state = {
    pid: 4242,
    serverId: "server-1",
    version: "0.9.0",
    startedAt: AT,
    uptimeMs: 1000,
    lifecycle: "running",
    desktopManaged: true,
    planes: { control: { status: "listening", path: "/run/control.sock" } },
    websocket: { listen: "127.0.0.1:6767" },
    relay: { enabled: false, connected: false },
    eventLoopDelayMs: { p50: 1, p99: 4.5, max: 12 },
    counts: { sessions: 2, agents: 3, terminals: 0 },
    managedRuntimes: [
      {
        runtimeName: "codex",
        pinnedVersion: "0.153.4",
        activeVersion: "0.153.4",
        installedVersions: ["0.153.4"],
        status: "installed",
        commandPath: "/home/u/.paseo/runtimes/bin/codex",
        error: null,
      },
    ],
    enterprise: {
      enabled: true,
      managementMode: "managed",
      nodeId: "nod_0123456789abcdef",
      nodeStatus: "active",
      policyAgeMs: 2000,
      lastHeartbeatAt: AT,
    },
  };

  test("parses standalone and managed probe states", () => {
    expect(ProbeStateSchema.parse(state)).toEqual(state);
    expect(ProbeStateSchema.parse({ ...state, enterprise: null }).enterprise).toBeNull();
  });

  test("declares no Principal, Grant, or credential field", () => {
    const keys = [
      ...Object.keys(ProbeStateSchema.shape),
      ...Object.keys(ProbeStateSchema.shape.enterprise.unwrap().shape),
    ];
    expect(keys.filter((key) => /principal|grant|credential|token/i.test(key))).toEqual([]);
  });
});

describe("plane names", () => {
  test("every streaming plane has one upgrade protocol and the probe plane uses plain HTTP", () => {
    expect(LOCAL_PLANE_NAMES).toEqual(["control", "data", "terminal", "probe"]);
    expect(LOCAL_PLANE_UPGRADE_PROTOCOLS).toEqual({
      control: "paseo-ndjson/1",
      terminal: "paseo-terminal/1",
      data: "paseo-data/1",
    });
  });

  test("formats socket file names and Windows pipe paths", () => {
    expect(localPlaneSocketFileName("terminal")).toBe("terminal.sock");
    expect(localPlanePipePath({ homeDigest: "0123456789ab", plane: "control" })).toBe(
      "\\\\.\\pipe\\paseo-0123456789ab-control",
    );
  });
});
