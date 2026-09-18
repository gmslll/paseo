import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  LocalPlaneDirectoryError,
  ensurePrivateDirectory,
  localPlaneHomeDigest,
  resolveLocalPlanePaths,
} from "./plane-paths.js";

describe("resolveLocalPlanePaths", () => {
  test("keeps every file under the run directory when the socket paths fit", () => {
    const paths = resolveLocalPlanePaths({ paseoHome: "/Users/me/.paseo", platform: "darwin" });

    expect(paths).toEqual({
      runDirectory: "/Users/me/.paseo/run",
      manifestPath: "/Users/me/.paseo/run/daemon.json",
      tokenPath: "/Users/me/.paseo/run/local-token",
      socketDirectory: "/Users/me/.paseo/run",
      endpoints: {
        control: { transport: "unix", path: "/Users/me/.paseo/run/control.sock" },
        data: { transport: "unix", path: "/Users/me/.paseo/run/data.sock" },
        terminal: { transport: "unix", path: "/Users/me/.paseo/run/terminal.sock" },
        probe: { transport: "unix", path: "/Users/me/.paseo/run/probe.sock" },
      },
    });
  });

  test("moves only the sockets to a per-home temp directory when a path would exceed 104 bytes", () => {
    const paseoHome = `/Users/me/${"nested-directory/".repeat(5)}.paseo`;
    const paths = resolveLocalPlanePaths({ paseoHome, platform: "linux", tmpdir: "/tmp" });
    const digest = localPlaneHomeDigest(paseoHome);

    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(paths.manifestPath).toBe(path.join(paseoHome, "run", "daemon.json"));
    expect(paths.tokenPath).toBe(path.join(paseoHome, "run", "local-token"));
    expect(paths.socketDirectory).toBe(`/tmp/paseo-${digest}`);
    expect(paths.endpoints.terminal).toEqual({
      transport: "unix",
      path: `/tmp/paseo-${digest}/terminal.sock`,
    });
    expect(
      resolveLocalPlanePaths({ paseoHome: `${paseoHome}-other`, platform: "linux", tmpdir: "/tmp" })
        .socketDirectory,
    ).not.toBe(paths.socketDirectory);
  });

  test("uses per-home named pipes on Windows", () => {
    const paths = resolveLocalPlanePaths({ paseoHome: "/home/me/.paseo", platform: "win32" });
    const digest = localPlaneHomeDigest("/home/me/.paseo");

    expect(paths.socketDirectory).toBeNull();
    expect(paths.endpoints.control).toEqual({
      transport: "pipe",
      path: `\\\\.\\pipe\\paseo-${digest}-control`,
    });
  });
});

describe.skipIf(process.platform === "win32")("ensurePrivateDirectory", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paseo-plane-dir-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("creates the directory with mode 0700 and tightens a directory others can read", async () => {
    const created = path.join(root, "created");
    await ensurePrivateDirectory(created);
    expect((await lstat(created)).mode & 0o777).toBe(0o700);

    const loose = path.join(root, "loose");
    await mkdir(loose, { mode: 0o755 });
    await chmod(loose, 0o755);
    await ensurePrivateDirectory(loose);
    expect((await lstat(loose)).mode & 0o777).toBe(0o700);
  });

  test("refuses a symlink in place of the directory", async () => {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);

    await expect(ensurePrivateDirectory(link)).rejects.toBeInstanceOf(LocalPlaneDirectoryError);
  });
});
