import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AuthorizedWorkspace } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DarwinEnterpriseUploadFileSystem } from "./darwin-upload-fs.js";

const executeFile = promisify(execFile);
let nativeAddonPath = "";
const workspace: AuthorizedWorkspace = Object.freeze({
  workspaceId: "wks_upload",
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  ownerPrincipalId: "usr_0123456789abcdef",
  createdByPrincipalId: "usr_0123456789abcdef",
});

describe.runIf(process.platform === "darwin")("DarwinEnterpriseUploadFileSystem", () => {
  let buildDirectory = "";

  beforeAll(async () => {
    buildDirectory = await mkdtemp(path.join(tmpdir(), "paseo-upload-native-build-"));
    nativeAddonPath = path.join(buildDirectory, "darwin-workspace-fs.node");
    await executeFile(process.execPath, [
      fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
      "--output",
      nativeAddonPath,
    ]);
  });

  afterAll(async () => {
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
  });

  it("appends by exact offset and publishes only after file and parent durability", async () => {
    const root = await createRoot("success");
    const uploads = createUploads(root);
    const signal = new AbortController().signal;
    try {
      const capability = await uploads.prepare({
        workspace,
        relativePath: "attachments/upload.bin",
        signal,
      });
      await uploads.append(capability, {
        offset: 0,
        bytes: new TextEncoder().encode("durable "),
        signal,
      });
      await uploads.append(capability, {
        offset: 8,
        bytes: new TextEncoder().encode("upload"),
        signal,
      });

      const finalized = await uploads.finalize(capability, { signal });
      expect(finalized).toMatchObject({
        capabilityId: capability.capabilityId,
        workspaceId: workspace.workspaceId,
        relativePath: "attachments/upload.bin",
        fileIdentity: { size: 14 },
      });
      expect(await readdir(path.join(root, "attachments"))).toEqual([
        expect.stringMatching(/^\.paseo-upload-[a-f0-9]{32}\.part$/),
      ]);
      expect(uploads.commit(capability)).toBe(true);
      expect(await readFile(path.join(root, "attachments", "upload.bin"), "utf8")).toBe(
        "durable upload",
      );
      expect(await readdir(path.join(root, "attachments"))).toEqual(["upload.bin"]);
      await expect(uploads.abort(capability)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never replaces an existing destination, including one created after prepare", async () => {
    const root = await createRoot("existing");
    const uploads = createUploads(root);
    const signal = new AbortController().signal;
    try {
      await mkdir(path.join(root, "attachments"));
      await writeFile(path.join(root, "attachments", "existing.bin"), "original");
      await expect(
        uploads.prepare({ workspace, relativePath: "attachments/existing.bin", signal }),
      ).rejects.toThrow();
      expect(await readFile(path.join(root, "attachments", "existing.bin"), "utf8")).toBe(
        "original",
      );

      const capability = await uploads.prepare({
        workspace,
        relativePath: "attachments/raced.bin",
        signal,
      });
      await uploads.append(capability, {
        offset: 0,
        bytes: new TextEncoder().encode("upload"),
        signal,
      });
      await writeFile(path.join(root, "attachments", "raced.bin"), "attacker");
      await expect(uploads.finalize(capability, { signal })).resolves.toMatchObject({
        relativePath: "attachments/raced.bin",
      });
      expect(() => uploads.commit(capability)).toThrow();
      await uploads.abort(capability);
      expect(await readFile(path.join(root, "attachments", "raced.bin"), "utf8")).toBe("attacker");
      expect((await readdir(path.join(root, "attachments"))).sort()).toEqual([
        "existing.bin",
        "raced.bin",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlink destinations without touching attacker files", async () => {
    const root = await createRoot("symlink-root");
    const attacker = await createRoot("symlink-attacker");
    let resolveCalls = 0;
    const uploads = createUploads(root, () => {
      resolveCalls += 1;
      return root;
    });
    const signal = new AbortController().signal;
    try {
      await writeFile(path.join(attacker, "sentinel"), "unchanged");
      await symlink(attacker, path.join(root, "linked"));
      await expect(
        uploads.prepare({ workspace, relativePath: "../escape.bin", signal }),
      ).rejects.toThrow();
      expect(resolveCalls).toBe(0);
      await expect(
        uploads.prepare({ workspace, relativePath: "linked/escape.bin", signal }),
      ).rejects.toThrow();
      expect(await readdir(attacker)).toEqual(["sentinel"]);
      expect(await readFile(path.join(attacker, "sentinel"), "utf8")).toBe("unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(attacker, { recursive: true, force: true });
    }
  });

  it("freezes workspace and path input before a blocked root lookup", async () => {
    const root = await createRoot("snapshot");
    let releaseRoot!: () => void;
    let markRootStarted!: () => void;
    const rootStarted = new Promise<void>((resolve) => {
      markRootStarted = resolve;
    });
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const seenWorkspaces: AuthorizedWorkspace[] = [];
    const uploads = createUploads(root, async (value) => {
      seenWorkspaces.push(value);
      markRootStarted();
      await rootGate;
      return root;
    });
    const request = {
      workspace: { ...workspace },
      relativePath: "attachments/original.bin",
      signal: new AbortController().signal,
    };
    try {
      const pending = uploads.prepare(request);
      await rootStarted;
      request.workspace.workspaceId = "wks_mutated";
      request.relativePath = "../escape.bin";
      releaseRoot();

      const capability = await pending;
      expect(seenWorkspaces).toEqual([workspace]);
      expect(capability).toMatchObject({
        workspaceId: workspace.workspaceId,
        relativePath: "attachments/original.bin",
      });
      await uploads.abort(capability);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects ancestor replacement before publish and aborts the held staging inode", async () => {
    const root = await createRoot("ancestor-root");
    const attacker = await createRoot("ancestor-attacker");
    const moved = `${root}-moved-parent`;
    const uploads = createUploads(root);
    const signal = new AbortController().signal;
    try {
      await mkdir(path.join(root, "folder"));
      const capability = await uploads.prepare({
        workspace,
        relativePath: "folder/upload.bin",
        signal,
      });
      await uploads.append(capability, {
        offset: 0,
        bytes: new TextEncoder().encode("safe"),
        signal,
      });
      await rename(path.join(root, "folder"), moved);
      await symlink(attacker, path.join(root, "folder"));

      await expect(uploads.finalize(capability, { signal })).rejects.toThrow();
      await uploads.abort(capability);
      expect(await readdir(attacker)).toEqual([]);
      expect(await readdir(moved)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(attacker, { recursive: true, force: true });
      await rm(moved, { recursive: true, force: true });
    }
  });

  it("fails stale signals closed and aborts capabilities exactly once without fd growth", async () => {
    const root = await createRoot("abort");
    const uploads = createUploads(root);
    try {
      await mkdir(path.join(root, "attachments"));
      const baseline = (await readdir("/dev/fd")).length;
      for (let index = 0; index < 24; index += 1) {
        const controller = new AbortController();
        const capability = await uploads.prepare({
          workspace,
          relativePath: `attachments/upload-${index}.bin`,
          signal: controller.signal,
        });
        controller.abort();
        await expect(
          uploads.append(capability, {
            offset: 0,
            bytes: new Uint8Array([index]),
            signal: controller.signal,
          }),
        ).rejects.toThrow("aborted");
        await uploads.abort(capability);
        await uploads.abort(capability);
      }
      expect(await readdir(path.join(root, "attachments"))).toEqual([]);
      expect((await readdir("/dev/fd")).length).toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createRoot(name: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), `paseo-upload-${name}-`)));
}

function createUploads(
  root: string,
  resolveCanonicalRoot: (workspace: AuthorizedWorkspace) => string | Promise<string> = () => root,
): DarwinEnterpriseUploadFileSystem {
  return new DarwinEnterpriseUploadFileSystem({
    addonPath: nativeAddonPath,
    capacity: 64,
    resolveCanonicalRoot,
  });
}
