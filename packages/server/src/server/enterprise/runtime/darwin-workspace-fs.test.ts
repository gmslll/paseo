import { execFile } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DarwinWorkspaceFileSystem, loadDarwinWorkspaceBinding } from "./darwin-workspace-fs.js";

const executeFile = promisify(execFile);
const descriptorSyncTrace = vi.hoisted(() => [] as number[]);
const descriptorIo = vi.hoisted(() => ({
  closeCalls: 0,
  closeFailureAt: 0,
  fstatBlockAt: 0,
  fstatBlocked: null as null | (() => void),
  fstatCalls: 0,
  fstatFailureAt: 0,
  fstatRelease: null as Promise<void> | null,
  fsyncBlockAt: 0,
  fsyncBlocked: null as null | (() => void),
  fsyncCalls: 0,
  fsyncFailureAt: 0,
  fsyncRelease: null as Promise<void> | null,
  maxWriteBytes: 0,
  readBlockAt: 0,
  readBlocked: null as null | (() => void),
  readCalls: 0,
  readRelease: null as Promise<void> | null,
}));
const makeInjectedIoError = vi.hoisted(() => (operation: string): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error(`injected ${operation} failure`);
  error.code = "EIO";
  return error;
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    close: (descriptor: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      descriptorIo.closeCalls += 1;
      const injectFailure = descriptorIo.closeCalls === descriptorIo.closeFailureAt;
      original.close(descriptor, (error) => {
        callback(error ?? (injectFailure ? makeInjectedIoError("close") : null));
      });
    },
    fstat: (
      descriptor: number,
      callback: (error: NodeJS.ErrnoException | null, stat: import("node:fs").Stats) => void,
    ) => {
      descriptorIo.fstatCalls += 1;
      if (descriptorIo.fstatCalls === descriptorIo.fstatBlockAt && descriptorIo.fstatRelease) {
        descriptorIo.fstatBlocked?.();
        void descriptorIo.fstatRelease.then(() => original.fstat(descriptor, callback));
        return;
      }
      if (descriptorIo.fstatCalls === descriptorIo.fstatFailureAt) {
        queueMicrotask(() => callback(makeInjectedIoError("fstat"), undefined as never));
        return;
      }
      original.fstat(descriptor, callback);
    },
    fsync: (descriptor: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      descriptorSyncTrace.push(original.fstatSync(descriptor).ino);
      descriptorIo.fsyncCalls += 1;
      if (descriptorIo.fsyncCalls === descriptorIo.fsyncBlockAt && descriptorIo.fsyncRelease) {
        descriptorIo.fsyncBlocked?.();
        void descriptorIo.fsyncRelease.then(() => original.fsync(descriptor, callback));
        return;
      }
      if (descriptorIo.fsyncCalls === descriptorIo.fsyncFailureAt) {
        queueMicrotask(() => callback(makeInjectedIoError("fsync")));
        return;
      }
      original.fsync(descriptor, callback);
    },
    read: (
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
      callback: (
        error: NodeJS.ErrnoException | null,
        bytesRead: number,
        buffer: Uint8Array,
      ) => void,
    ) => {
      descriptorIo.readCalls += 1;
      if (descriptorIo.readCalls === descriptorIo.readBlockAt && descriptorIo.readRelease) {
        descriptorIo.readBlocked?.();
        void descriptorIo.readRelease.then(() =>
          original.read(descriptor, buffer, offset, length, position, callback),
        );
        return;
      }
      original.read(descriptor, buffer, offset, length, position, callback);
    },
    write: (
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
      callback: (error: NodeJS.ErrnoException | null, written: number, buffer: Uint8Array) => void,
    ) => {
      const boundedLength =
        descriptorIo.maxWriteBytes > 0 ? Math.min(length, descriptorIo.maxWriteBytes) : length;
      original.write(descriptor, buffer, offset, boundedLength, position, callback);
    },
  };
});

afterEach(() => {
  resetDescriptorIo();
});

describe.runIf(process.platform === "darwin")(
  "DarwinWorkspaceFileSystem production binding",
  () => {
    let buildDirectory = "";
    let addonPath = "";
    let wrongAbiAddonPath = "";
    let missingSymbolAddonPath = "";
    let missingUploadSymbolsAddonPath = "";
    let sparseDirectoryAddonPath = "";

    beforeAll(async () => {
      buildDirectory = await mkdtemp(path.join(tmpdir(), "paseo-workspace-native-build-"));
      addonPath = path.join(buildDirectory, "darwin-workspace-fs.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
      wrongAbiAddonPath = path.join(buildDirectory, "darwin-workspace-fs-wrong-abi.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        wrongAbiAddonPath,
        "--test-variant",
        "wrong-abi",
      ]);
      missingSymbolAddonPath = path.join(buildDirectory, "darwin-workspace-fs-missing-symbol.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        missingSymbolAddonPath,
        "--test-variant",
        "missing-symbol",
      ]);
      missingUploadSymbolsAddonPath = path.join(
        buildDirectory,
        "darwin-workspace-fs-missing-upload-symbols.node",
      );
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        missingUploadSymbolsAddonPath,
        "--test-variant",
        "missing-upload-symbols",
      ]);
      sparseDirectoryAddonPath = path.join(
        buildDirectory,
        "darwin-workspace-fs-sparse-directory.node",
      );
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        sparseDirectoryAddonPath,
        "--test-variant",
        "sparse-directory",
      ]);
    });

    afterAll(async () => {
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
    });

    it("becomes release-ready only with the validated native binding and opens one root dirfd", async () => {
      const rootPath = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-workspace-root-")));
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      try {
        expect(files.releaseReady).toBe(true);
        expect(files.supportsDirectoryRelativeOperations).toBe(true);
        const root = await files.openWorkspaceRoot(rootPath);
        expect(await root.stat()).toMatchObject({ isDirectory: expect.any(Function) });
        expect((await root.stat()).isDirectory()).toBe(true);
        await root.close();
        await expect(root.close()).resolves.toBeUndefined();
      } finally {
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("writes and closes opened descriptors and commits with no-replace rename plus parent fsync", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-native-upload-")),
      );
      const binding = loadDarwinWorkspaceBinding(addonPath);
      if (!binding) throw new Error("expected native upload binding");
      const parentDescriptor = binding.openRoot(rootPath);
      const sourceDescriptor = binding.openAt(
        parentDescriptor,
        "staging.part",
        fileConstants.O_RDWR | fileConstants.O_CREAT | fileConstants.O_EXCL,
        0o600,
      );
      let sourceOpen = true;
      try {
        const bytes = new TextEncoder().encode("opened-descriptor-upload");
        expect(binding.writeAt(sourceDescriptor, bytes, 0)).toBe(bytes.byteLength);
        binding.fsync(sourceDescriptor);
        binding.close(sourceDescriptor);
        sourceOpen = false;
        expect(() => binding.close(sourceDescriptor)).toThrow();

        binding.renameAt(parentDescriptor, "staging.part", parentDescriptor, "upload.bin", 1);
        binding.fsync(parentDescriptor);
        expect(await readFile(path.join(rootPath, "upload.bin"), "utf8")).toBe(
          "opened-descriptor-upload",
        );

        await writeFile(path.join(rootPath, "second.part"), "second");
        expect(() =>
          binding.renameAt(parentDescriptor, "second.part", parentDescriptor, "upload.bin", 1),
        ).toThrow();
        expect(await readFile(path.join(rootPath, "upload.bin"), "utf8")).toBe(
          "opened-descriptor-upload",
        );
        expect(await readFile(path.join(rootPath, "second.part"), "utf8")).toBe("second");
      } finally {
        if (sourceOpen) binding.close(sourceDescriptor);
        binding.close(parentDescriptor);
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("fails closed before workspace access when the binding is missing", async () => {
      const files = new DarwinWorkspaceFileSystem({
        addonPath: path.join(buildDirectory, "missing-workspace-fs.node"),
      });
      expect(files.releaseReady).toBe(false);
      expect(files.supportsDirectoryRelativeOperations).toBe(false);
      await expect(files.openWorkspaceRoot("/path-that-must-not-be-opened")).rejects.toThrow(
        "darwin_workspace_dirfd_binding_unavailable",
      );
    });

    it.each([
      ["ABI", () => wrongAbiAddonPath],
      ["symbol", () => missingSymbolAddonPath],
      ["upload symbols", () => missingUploadSymbolsAddonPath],
    ])("fails closed when the native %s contract is wrong", async (_label, selectAddon) => {
      const files = new DarwinWorkspaceFileSystem({ addonPath: selectAddon() });
      expect(files.releaseReady).toBe(false);
      expect(files.supportsDirectoryRelativeOperations).toBe(false);
      await expect(files.openWorkspaceRoot("/path-that-must-not-be-opened")).rejects.toThrow(
        "darwin_workspace_dirfd_binding_unavailable",
      );
    });

    it("rejects sparse native directory results instead of copying holes", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-sparse-native-")),
      );
      const files = new DarwinWorkspaceFileSystem({ addonPath: sparseDirectoryAddonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        await expect(files.listRoot(root)).rejects.toThrow(
          "Darwin workspace binding returned invalid directory entries",
        );
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("performs create, stat, list, read, write, cross-directory rename, copy, and delete through dirfds", async () => {
      const rootPath = await realpath(await mkdtemp(path.join(tmpdir(), "paseo-workspace-ops-")));
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        await files.create(root, ["source", "nested", "empty"], "directory");
        await files.create(root, ["source", "nested", "draft.txt"], "file");
        const empty = await files.stat(root, ["source", "nested", "draft.txt"]);
        await files.write(
          root,
          ["source", "nested", "draft.txt"],
          new TextEncoder().encode("safe"),
          {
            modifiedAt: new Date(empty.mtimeMs).toISOString(),
            revision: `${empty.dev}:${empty.ino}:${empty.size}:${empty.mtimeMs}`,
          },
        );
        expect(await files.list(root, ["source", "nested"])).toEqual(["draft.txt", "empty"]);
        const reader = await files.read(root, ["source", "nested", "draft.txt"]);
        expect(new TextDecoder().decode(await reader.read(0, 4))).toBe("safe");
        await reader.close();

        await files.rename(root, ["source", "nested", "draft.txt"], ["destination", "renamed.txt"]);
        await files.copy(root, ["destination", "renamed.txt"], ["copies", "deep", "copied.txt"]);
        const copy = await files.read(root, ["copies", "deep", "copied.txt"]);
        expect(new TextDecoder().decode(await copy.read(0, 32))).toBe("safe");
        await copy.close();

        await files.delete(root, ["destination"]);
        await files.delete(root, ["copies"]);
        await files.delete(root, ["source"]);
        expect(await files.listRoot(root)).toEqual([]);
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("fsyncs the source parent once and a distinct destination parent once after rename", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-rename-sync-")),
      );
      const sameParent = path.join(rootPath, "same");
      const sourceParent = path.join(rootPath, "source");
      const destinationParent = path.join(rootPath, "destination");
      await mkdir(sameParent);
      await mkdir(sourceParent);
      await mkdir(destinationParent);
      await writeFile(path.join(sameParent, "before.txt"), "same");
      await writeFile(path.join(sourceParent, "before.txt"), "cross");
      const sameIdentity = await stat(sameParent);
      const sourceIdentity = await stat(sourceParent);
      const destinationIdentity = await stat(destinationParent);
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        descriptorSyncTrace.length = 0;
        await files.rename(root, ["same", "before.txt"], ["same", "after.txt"]);
        expect(descriptorSyncTrace).toEqual([sameIdentity.ino]);

        descriptorSyncTrace.length = 0;
        await files.rename(root, ["source", "before.txt"], ["destination", "after.txt"]);
        expect(descriptorSyncTrace).toEqual([sourceIdentity.ino, destinationIdentity.ino]);
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("rolls a cross-parent rename back and fsyncs both parents when destination fsync fails", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-rename-rollback-")),
      );
      const sourceParent = path.join(rootPath, "source");
      const destinationParent = path.join(rootPath, "destination");
      await mkdir(sourceParent);
      await mkdir(destinationParent);
      await writeFile(path.join(sourceParent, "before.txt"), "rollback");
      const sourceIdentity = await stat(sourceParent);
      const destinationIdentity = await stat(destinationParent);
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        resetDescriptorIo();
        descriptorIo.fsyncFailureAt = 2;
        await expect(
          files.rename(root, ["source", "before.txt"], ["destination", "after.txt"]),
        ).rejects.toThrow("injected fsync failure");
        expect(descriptorSyncTrace).toEqual([
          sourceIdentity.ino,
          destinationIdentity.ino,
          sourceIdentity.ino,
          destinationIdentity.ino,
        ]);
        resetDescriptorIo();
        expect(await readFile(path.join(sourceParent, "before.txt"), "utf8")).toBe("rollback");
        await expect(
          readFile(path.join(destinationParent, "after.txt"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        resetDescriptorIo();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("snapshots paths, bytes, and expected identity before the first await", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-input-snapshot-")),
      );
      await writeFile(path.join(rootPath, "document.txt"), "before");
      await writeFile(path.join(rootPath, "other.txt"), "other");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        const createPath = ["created", "nested", "file.txt"];
        const createPending = files.create(root, createPath, "file");
        createPath.splice(0, createPath.length, "mutated", "escape.txt");
        await createPending;
        expect(await readdir(path.join(rootPath, "created", "nested"))).toEqual(["file.txt"]);
        await expect(readdir(path.join(rootPath, "mutated"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        const document = await files.stat(root, ["document.txt"]);
        const writePath = ["document.txt"];
        const bytes = new TextEncoder().encode("snapshot");
        const expected = {
          modifiedAt: new Date(document.mtimeMs).toISOString(),
          revision: `${document.dev}:${document.ino}:${document.size}:${document.mtimeMs}`,
        };
        const writePending = files.write(root, writePath, bytes, expected);
        writePath[0] = "other.txt";
        bytes.fill("x".charCodeAt(0));
        expected.modifiedAt = "2026-09-10T00:00:00.000Z";
        expected.revision = "mutated";
        await writePending;
        expect(await readFile(path.join(rootPath, "document.txt"), "utf8")).toBe("snapshot");
        expect(await readFile(path.join(rootPath, "other.txt"), "utf8")).toBe("other");

        await writeFile(path.join(rootPath, "rename-source.txt"), "source");
        await writeFile(path.join(rootPath, "rename-attacker.txt"), "attacker");
        const source = ["rename-source.txt"];
        const destinationTarget = ["renamed.txt"];
        const destination = new Proxy(destinationTarget, {
          get(target, key, receiver) {
            if (key === "some") source[0] = "rename-attacker.txt";
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            source[0] = "rename-attacker.txt";
            return Reflect.ownKeys(target);
          },
        });
        await files.rename(root, source, destination);
        expect(await readFile(path.join(rootPath, "renamed.txt"), "utf8")).toBe("source");
        expect(await readFile(path.join(rootPath, "rename-attacker.txt"), "utf8")).toBe("attacker");
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("keeps the path snapshot when the caller mutates its array during blocked traversal", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-path-traversal-snapshot-")),
      );
      await mkdir(path.join(rootPath, "parent", "original"), { recursive: true });
      await mkdir(path.join(rootPath, "parent", "mutated"));
      await writeFile(path.join(rootPath, "parent", "original", "safe.txt"), "safe");
      await writeFile(path.join(rootPath, "parent", "mutated", "attacker.txt"), "attacker");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      let releaseFstat = () => undefined;
      try {
        let reportBlocked = () => undefined;
        const blocked = new Promise<void>((resolve) => {
          reportBlocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseFstat = resolve;
        });
        resetDescriptorIo();
        descriptorIo.fstatBlockAt = 1;
        descriptorIo.fstatBlocked = reportBlocked;
        descriptorIo.fstatRelease = release;
        const callerPath = ["parent", "original"];
        const listPending = files.list(root, callerPath);
        await blocked;
        callerPath[1] = "mutated";
        releaseFstat();
        await expect(listPending).resolves.toEqual(["safe.txt"]);
      } finally {
        releaseFstat();
        resetDescriptorIo();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("rejects accessor, sparse, symbol, and throwing Proxy inputs before filesystem access", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-input-reject-")),
      );
      await writeFile(path.join(rootPath, "document.txt"), "unchanged");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        const baselineDescriptors = (await readdir("/dev/fd")).length;
        const initialEntries = await readdir(rootPath);
        let accessorReads = 0;
        const accessorPath = ["document.txt"];
        Object.defineProperty(accessorPath, "0", {
          configurable: true,
          enumerable: true,
          get() {
            accessorReads += 1;
            return "document.txt";
          },
        });
        await expect(files.stat(root, accessorPath)).rejects.toThrow(
          "Unsafe workspace path components",
        );
        expect(accessorReads).toBe(0);

        const sparsePath: string[] = [];
        sparsePath.length = 1;
        await expect(files.list(root, sparsePath)).rejects.toThrow(
          "Unsafe workspace path components",
        );
        const symbolPath = ["document.txt"];
        Object.defineProperty(symbolPath, Symbol("extra"), { value: "rejected" });
        await expect(files.read(root, symbolPath)).rejects.toThrow(
          "Unsafe workspace path components",
        );

        const throwingPath = new Proxy(["document.txt"], {
          ownKeys() {
            throw new Error("path proxy trap");
          },
        });
        await expect(files.delete(root, throwingPath)).rejects.toThrow(
          "Unsafe workspace path components",
        );

        let expectedReads = 0;
        const accessorExpected = Object.defineProperty({}, "modifiedAt", {
          enumerable: true,
          get() {
            expectedReads += 1;
            return "2026-09-10T00:00:00.000Z";
          },
        }) as { modifiedAt: string };
        await expect(
          files.write(
            root,
            ["document.txt"],
            new TextEncoder().encode("rejected"),
            accessorExpected,
          ),
        ).rejects.toThrow("Invalid workspace file version");
        expect(expectedReads).toBe(0);

        const throwingBytes = new Proxy(new Uint8Array([1]), {
          getPrototypeOf() {
            throw new Error("bytes proxy trap");
          },
        });
        await expect(
          files.write(root, ["document.txt"], throwingBytes, {
            modifiedAt: "2026-09-10T00:00:00.000Z",
          }),
        ).rejects.toThrow("Invalid workspace write size");

        expect(await readdir(rootPath)).toEqual(initialEntries);
        expect(await readFile(path.join(rootPath, "document.txt"), "utf8")).toBe("unchanged");
        expect((await readdir("/dev/fd")).length).toBe(baselineDescriptors);
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("keeps all operations on the opened root after its pathname is replaced by an attacker symlink", async () => {
      const sandbox = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-root-swap-")),
      );
      const rootPath = path.join(sandbox, "workspace");
      const movedRootPath = path.join(sandbox, "workspace-original");
      const attackerPath = path.join(sandbox, "attacker");
      await mkdir(rootPath);
      await mkdir(attackerPath);
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        await rename(rootPath, movedRootPath);
        await symlink(attackerPath, rootPath);
        await files.create(root, ["anchored.txt"], "file");
        const created = await files.stat(root, ["anchored.txt"]);
        await files.write(root, ["anchored.txt"], new TextEncoder().encode("original"), {
          modifiedAt: new Date(created.mtimeMs).toISOString(),
          revision: `${created.dev}:${created.ino}:${created.size}:${created.mtimeMs}`,
        });
        expect(await readFile(path.join(movedRootPath, "anchored.txt"), "utf8")).toBe("original");
        expect(await readdir(attackerPath)).toEqual([]);
      } finally {
        await root.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    it.each(["first", "second"] as const)(
      "rejects a symlink replacement at the %s ancestor without changing the attacker target",
      async (level) => {
        const sandbox = await realpath(
          await mkdtemp(path.join(tmpdir(), `paseo-workspace-${level}-ancestor-`)),
        );
        const rootPath = path.join(sandbox, "workspace");
        const firstPath = path.join(rootPath, "first");
        const secondPath = path.join(firstPath, "second");
        const attackerPath = path.join(sandbox, "attacker");
        await mkdir(secondPath, { recursive: true });
        await mkdir(attackerPath);
        await writeFile(path.join(attackerPath, "sentinel.txt"), "untouched");
        const files = new DarwinWorkspaceFileSystem({ addonPath });
        const root = await files.openWorkspaceRoot(rootPath);
        try {
          const replacedPath = level === "first" ? firstPath : secondPath;
          await rename(replacedPath, `${replacedPath}-original`);
          await symlink(attackerPath, replacedPath);

          await expect(
            files.create(root, ["first", "second", "escaped.txt"], "file"),
          ).rejects.toThrow();
          expect(await readdir(attackerPath)).toEqual(["sentinel.txt"]);
          expect(await readFile(path.join(attackerPath, "sentinel.txt"), "utf8")).toBe("untouched");
        } finally {
          await root.close();
          await rm(sandbox, { recursive: true, force: true });
        }
      },
    );

    it("fails closed when a created ancestor is replaced while traversal is blocked", async () => {
      const sandbox = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-blocked-ancestor-")),
      );
      const rootPath = path.join(sandbox, "workspace");
      const firstPath = path.join(rootPath, "first");
      const movedFirstPath = path.join(rootPath, "first-original");
      const attackerPath = path.join(sandbox, "attacker");
      await mkdir(rootPath);
      await mkdir(attackerPath);
      await writeFile(path.join(attackerPath, "sentinel.txt"), "untouched");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      let releaseFsync = () => undefined;
      try {
        let reportBlocked = () => undefined;
        const blocked = new Promise<void>((resolve) => {
          reportBlocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseFsync = resolve;
        });
        resetDescriptorIo();
        descriptorIo.fsyncBlockAt = 1;
        descriptorIo.fsyncBlocked = reportBlocked;
        descriptorIo.fsyncRelease = release;
        const createPending = files.create(root, ["first", "second", "file.txt"], "file");
        await blocked;
        await rename(firstPath, movedFirstPath);
        await symlink(attackerPath, firstPath);
        releaseFsync();
        const failure = await createPending.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toMatchObject({
          message: "Workspace entry identity changed during operation",
        });
        expect(failure.errors[1]).toMatchObject({
          message: "Workspace directory rollback identity changed",
        });
        expect(failure.cause).toBe(failure.errors[0]);
        resetDescriptorIo();
        expect(await readdir(attackerPath)).toEqual(["sentinel.txt"]);
        expect(await readFile(path.join(attackerPath, "sentinel.txt"), "utf8")).toBe("untouched");
        expect(await readdir(movedFirstPath)).toEqual([]);
      } finally {
        releaseFsync();
        resetDescriptorIo();
        await root.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    it("rejects leaf symlinks for read, write, rename, copy, and delete without touching the target", async () => {
      const sandbox = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-leaf-link-")),
      );
      const rootPath = path.join(sandbox, "workspace");
      const attackerPath = path.join(sandbox, "attacker.txt");
      await mkdir(rootPath);
      await writeFile(attackerPath, "untouched");
      await symlink(attackerPath, path.join(rootPath, "link.txt"));
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        const unsafe = ["link.txt"];
        await expect(files.read(root, unsafe)).rejects.toThrow();
        await expect(
          files.write(root, unsafe, new TextEncoder().encode("changed"), {
            modifiedAt: "2026-09-10T00:00:00.000Z",
          }),
        ).rejects.toThrow();
        await expect(files.rename(root, unsafe, ["renamed.txt"])).rejects.toThrow();
        await expect(files.copy(root, unsafe, ["copied.txt"])).rejects.toThrow();
        await expect(files.delete(root, unsafe)).rejects.toThrow();
        expect(await readFile(attackerPath, "utf8")).toBe("untouched");
        expect(await readdir(rootPath)).toEqual(["link.txt"]);
      } finally {
        await root.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    it("rejects a symlinked destination ancestor before rename or copy changes either side", async () => {
      const sandbox = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-destination-link-")),
      );
      const rootPath = path.join(sandbox, "workspace");
      const sourcePath = path.join(rootPath, "source");
      const attackerPath = path.join(sandbox, "attacker");
      await mkdir(sourcePath, { recursive: true });
      await mkdir(attackerPath);
      await writeFile(path.join(sourcePath, "rename.txt"), "rename-source");
      await writeFile(path.join(sourcePath, "copy.txt"), "copy-source");
      await writeFile(path.join(attackerPath, "sentinel.txt"), "untouched");
      await symlink(attackerPath, path.join(rootPath, "destination"));
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        await expect(
          files.rename(root, ["source", "rename.txt"], ["destination", "renamed.txt"]),
        ).rejects.toThrow();
        await expect(
          files.copy(root, ["source", "copy.txt"], ["destination", "copied.txt"]),
        ).rejects.toThrow();
        expect(await readFile(path.join(sourcePath, "rename.txt"), "utf8")).toBe("rename-source");
        expect(await readFile(path.join(sourcePath, "copy.txt"), "utf8")).toBe("copy-source");
        expect(await readdir(attackerPath)).toEqual(["sentinel.txt"]);
        expect(await readFile(path.join(attackerPath, "sentinel.txt"), "utf8")).toBe("untouched");
      } finally {
        await root.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    it("does not move a replacement source installed while rename identity checking is blocked", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-rename-source-race-")),
      );
      const sourcePath = path.join(rootPath, "source.txt");
      const movedSourcePath = path.join(rootPath, "source-original.txt");
      const destinationPath = path.join(rootPath, "destination.txt");
      await writeFile(sourcePath, "original");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      let releaseFstat = () => undefined;
      try {
        let reportBlocked = () => undefined;
        const blocked = new Promise<void>((resolve) => {
          reportBlocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseFstat = resolve;
        });
        resetDescriptorIo();
        descriptorIo.fstatBlockAt = 1;
        descriptorIo.fstatBlocked = reportBlocked;
        descriptorIo.fstatRelease = release;
        const renamePending = files.rename(root, ["source.txt"], ["destination.txt"]);
        await blocked;
        await rename(sourcePath, movedSourcePath);
        await writeFile(sourcePath, "attacker");
        releaseFstat();
        await expect(renamePending).rejects.toThrow("identity changed");
        resetDescriptorIo();
        expect(await readFile(sourcePath, "utf8")).toBe("attacker");
        expect(await readFile(movedSourcePath, "utf8")).toBe("original");
        await expect(readFile(destinationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releaseFstat();
        resetDescriptorIo();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("polls only the opened directory fd after its pathname becomes an attacker symlink", async () => {
      const sandbox = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-watch-swap-")),
      );
      const rootPath = path.join(sandbox, "workspace");
      const watchedPath = path.join(rootPath, "watched");
      const movedWatchedPath = path.join(rootPath, "watched-original");
      const attackerPath = path.join(sandbox, "attacker");
      await mkdir(watchedPath, { recursive: true });
      await mkdir(path.join(watchedPath, "nested"));
      await mkdir(attackerPath);
      const files = new DarwinWorkspaceFileSystem({ addonPath, pollIntervalMs: 10 });
      const root = await files.openWorkspaceRoot(rootPath);
      let changes = 0;
      const watch = await files.watch(root, ["watched"], () => {
        changes += 1;
      });
      try {
        await rename(watchedPath, movedWatchedPath);
        await symlink(attackerPath, watchedPath);
        await writeFile(path.join(movedWatchedPath, "nested", "original.txt"), "safe");
        await waitUntil(() => changes === 1);

        const firstDispose = watch[Symbol.asyncDispose]();
        const secondDispose = watch[Symbol.asyncDispose]();
        expect(secondDispose).toBe(firstDispose);
        await firstDispose;
        await writeFile(path.join(attackerPath, "attacker.txt"), "ignored");
        await waitForPolls(4);
        expect(changes).toBe(1);
      } finally {
        await watch[Symbol.asyncDispose]();
        await root.close();
        await rm(sandbox, { recursive: true, force: true });
      }
    });

    it("surfaces callback failure through shared watch disposal and closes once", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-watch-error-")),
      );
      await mkdir(path.join(rootPath, "watched"));
      const files = new DarwinWorkspaceFileSystem({ addonPath, pollIntervalMs: 10 });
      const root = await files.openWorkspaceRoot(rootPath);
      const callbackError = new Error("watch callback failed");
      let callbacks = 0;
      const watch = await files.watch(root, ["watched"], () => {
        callbacks += 1;
        throw callbackError;
      });
      try {
        await writeFile(path.join(rootPath, "watched", "changed.txt"), "changed");
        await waitUntil(() => callbacks === 1);
        const firstDispose = watch[Symbol.asyncDispose]();
        const secondDispose = watch[Symbol.asyncDispose]();
        expect(secondDispose).toBe(firstDispose);
        await expect(firstDispose).rejects.toBe(callbackError);
        await expect(secondDispose).rejects.toBe(callbackError);
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("waits for a blocked watch poll before closing exactly once without a late callback", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-watch-blocked-")),
      );
      await mkdir(path.join(rootPath, "watched"));
      const files = new DarwinWorkspaceFileSystem({ addonPath, pollIntervalMs: 10 });
      const root = await files.openWorkspaceRoot(rootPath);
      let callbacks = 0;
      const watch = await files.watch(root, ["watched"], () => {
        callbacks += 1;
      });
      let releaseFstat = () => undefined;
      try {
        let reportBlocked = () => undefined;
        const blocked = new Promise<void>((resolve) => {
          reportBlocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseFstat = resolve;
        });
        resetDescriptorIo();
        descriptorIo.fstatBlockAt = 1;
        descriptorIo.fstatBlocked = reportBlocked;
        descriptorIo.fstatRelease = release;
        await blocked;
        let disposed = false;
        const firstDispose = watch[Symbol.asyncDispose]();
        const secondDispose = watch[Symbol.asyncDispose]();
        const observedDispose = firstDispose.then(() => {
          disposed = true;
          return undefined;
        });
        expect(secondDispose).toBe(firstDispose);
        await Promise.resolve();
        expect(disposed).toBe(false);
        releaseFstat();
        await observedDispose;
        await secondDispose;
        expect(descriptorIo.closeCalls).toBe(1);
        expect(callbacks).toBe(0);
      } finally {
        releaseFstat();
        resetDescriptorIo();
        await watch[Symbol.asyncDispose]();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("completes short writes and rolls back an exchanged file when parent fsync fails", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-write-fault-")),
      );
      await writeFile(path.join(rootPath, "document.txt"), "before");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        const initial = await files.stat(root, ["document.txt"]);
        resetDescriptorIo();
        descriptorIo.maxWriteBytes = 1;
        await files.write(
          root,
          ["document.txt"],
          new TextEncoder().encode("short-write-completed"),
          {
            modifiedAt: new Date(initial.mtimeMs).toISOString(),
            revision: `${initial.dev}:${initial.ino}:${initial.size}:${initial.mtimeMs}`,
          },
        );
        expect(await readFile(path.join(rootPath, "document.txt"), "utf8")).toBe(
          "short-write-completed",
        );

        const replacement = await files.stat(root, ["document.txt"]);
        resetDescriptorIo();
        descriptorIo.fsyncFailureAt = 2;
        await expect(
          files.write(root, ["document.txt"], new TextEncoder().encode("must-roll-back"), {
            modifiedAt: new Date(replacement.mtimeMs).toISOString(),
            revision: `${replacement.dev}:${replacement.ino}:${replacement.size}:${replacement.mtimeMs}`,
          }),
        ).rejects.toThrow("injected fsync failure");
        resetDescriptorIo();
        expect(await readFile(path.join(rootPath, "document.txt"), "utf8")).toBe(
          "short-write-completed",
        );
        expect(await readdir(rootPath)).toEqual(["document.txt"]);
      } finally {
        resetDescriptorIo();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("preserves primary fstat then close failure order and shares a failing close", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-close-fault-")),
      );
      await writeFile(path.join(rootPath, "document.txt"), "contents");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        resetDescriptorIo();
        descriptorIo.fstatFailureAt = 1;
        descriptorIo.closeFailureAt = 1;
        const openFailure = await files
          .read(root, ["document.txt"])
          .catch((error: unknown) => error);
        expect(openFailure).toBeInstanceOf(AggregateError);
        if (!(openFailure instanceof AggregateError)) throw new Error("Expected aggregate failure");
        expect(openFailure.errors).toHaveLength(2);
        expect(openFailure.errors[0]).toMatchObject({ message: "injected fstat failure" });
        expect(openFailure.errors[1]).toMatchObject({ message: "injected close failure" });
        expect(openFailure.cause).toBe(openFailure.errors[0]);

        resetDescriptorIo();
        const reader = await files.read(root, ["document.txt"]);
        resetDescriptorIo();
        descriptorIo.closeFailureAt = 1;
        const firstClose = reader.close();
        const secondClose = reader.close();
        expect(secondClose).toBe(firstClose);
        await expect(firstClose).rejects.toThrow("injected close failure");
        await expect(secondClose).rejects.toThrow("injected close failure");
        expect(descriptorIo.closeCalls).toBe(1);
      } finally {
        resetDescriptorIo();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("waits for an in-flight read before the shared handle close settles", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-read-close-race-")),
      );
      await writeFile(path.join(rootPath, "document.txt"), "contents");
      const files = new DarwinWorkspaceFileSystem({ addonPath });
      const root = await files.openWorkspaceRoot(rootPath);
      const reader = await files.read(root, ["document.txt"]);
      let releaseRead = () => undefined;
      try {
        let reportBlocked = () => undefined;
        const blocked = new Promise<void>((resolve) => {
          reportBlocked = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        resetDescriptorIo();
        descriptorIo.readBlockAt = 1;
        descriptorIo.readBlocked = reportBlocked;
        descriptorIo.readRelease = release;
        const readPending = reader.read(0, 8);
        await blocked;
        let closed = false;
        const firstClose = reader.close();
        const secondClose = reader.close();
        const observedClose = firstClose.then(() => {
          closed = true;
          return undefined;
        });
        expect(secondClose).toBe(firstClose);
        await Promise.resolve();
        expect(closed).toBe(false);
        releaseRead();
        expect(new TextDecoder().decode(await readPending)).toBe("contents");
        await observedClose;
        await secondClose;
        expect(descriptorIo.closeCalls).toBe(1);
      } finally {
        releaseRead();
        resetDescriptorIo();
        await reader.close();
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });

    it("bounds read ranges, shares exactly-once closes, and does not leak descriptors in a loop", async () => {
      const rootPath = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-workspace-fd-loop-")),
      );
      await writeFile(path.join(rootPath, "data.txt"), "descriptor-data");
      const files = new DarwinWorkspaceFileSystem({ addonPath, pollIntervalMs: 10 });
      const root = await files.openWorkspaceRoot(rootPath);
      try {
        const baseline = (await readdir("/dev/fd")).length;
        for (let index = 0; index < 32; index += 1) {
          const reader = await files.read(root, ["data.txt"]);
          expect(new TextDecoder().decode(await reader.read(0, 10))).toBe("descriptor");
          await expect(reader.read(-1, 1)).rejects.toThrow("Invalid workspace read range");
          await expect(reader.read(Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow(
            "Invalid workspace read range",
          );
          const firstClose = reader.close();
          const secondClose = reader.close();
          expect(secondClose).toBe(firstClose);
          await firstClose;
          await expect(reader.read(0, 1)).rejects.toThrow("descriptor is closed");
          expect(await files.listRoot(root)).toEqual(["data.txt"]);
          expect(await files.stat(root, ["data.txt"])).toMatchObject({ kind: "file", size: 15 });
          const watch = await files.watch(root, []);
          await watch[Symbol.asyncDispose]();
        }
        expect((await readdir("/dev/fd")).length).toBe(baseline);
      } finally {
        await root.close();
        await rm(rootPath, { recursive: true, force: true });
      }
    });
  },
);

describe.runIf(process.platform !== "darwin")("DarwinWorkspaceFileSystem platform gate", () => {
  it("fails closed before workspace access on a non-Darwin host", async () => {
    const files = new DarwinWorkspaceFileSystem({ addonPath: "/not-loaded.node" });
    expect(files.releaseReady).toBe(false);
    expect(files.supportsDirectoryRelativeOperations).toBe(false);
    await expect(files.openWorkspaceRoot("/path-that-must-not-be-opened")).rejects.toThrow(
      "darwin_workspace_dirfd_binding_unavailable",
    );
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Darwin workspace event");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForPolls(count: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, count * 10));
}

function resetDescriptorIo(): void {
  descriptorSyncTrace.length = 0;
  descriptorIo.closeCalls = 0;
  descriptorIo.closeFailureAt = 0;
  descriptorIo.fstatBlockAt = 0;
  descriptorIo.fstatBlocked = null;
  descriptorIo.fstatCalls = 0;
  descriptorIo.fstatFailureAt = 0;
  descriptorIo.fstatRelease = null;
  descriptorIo.fsyncBlockAt = 0;
  descriptorIo.fsyncBlocked = null;
  descriptorIo.fsyncCalls = 0;
  descriptorIo.fsyncFailureAt = 0;
  descriptorIo.fsyncRelease = null;
  descriptorIo.maxWriteBytes = 0;
  descriptorIo.readBlockAt = 0;
  descriptorIo.readBlocked = null;
  descriptorIo.readCalls = 0;
  descriptorIo.readRelease = null;
}
