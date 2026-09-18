import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DaemonManifest } from "@getpaseo/protocol/local-planes";

import {
  readDaemonManifest,
  removeDaemonManifest,
  writeDaemonManifest,
} from "./daemon-manifest.js";

let directory: string;

function manifest(pid: number): DaemonManifest {
  return {
    schemaVersion: 1,
    pid,
    supervisorPid: null,
    serverId: "srv_manifest",
    version: "0.9.0",
    startedAt: "2026-09-16T08:00:00.000Z",
    listen: "127.0.0.1:6767",
    desktopManaged: false,
    planes: { probe: { transport: "unix", path: "/tmp/paseo/probe.sock", protocolVersion: 1 } },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "paseo-manifest-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("daemon manifest", () => {
  test("round-trips the validated manifest and reports a missing one as null", async () => {
    const manifestPath = path.join(directory, "daemon.json");
    expect(await readDaemonManifest(manifestPath)).toBeNull();

    await writeDaemonManifest(manifestPath, manifest(4242));

    expect(await readDaemonManifest(manifestPath)).toEqual(manifest(4242));
  });

  test("removes the manifest only for the daemon it describes", async () => {
    const manifestPath = path.join(directory, "daemon.json");
    await writeDaemonManifest(manifestPath, manifest(5151));

    await removeDaemonManifest(manifestPath, 4242);
    expect(await readDaemonManifest(manifestPath)).toEqual(manifest(5151));

    await removeDaemonManifest(manifestPath, 5151);
    expect(await readDaemonManifest(manifestPath)).toBeNull();
  });
});
