import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { constants as fileConstants } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type {
  SafeDirectoryHandle,
  SafeFileHandle,
  SafeWorkspaceFsPort,
  WorkspacePathIdentity,
  WorkspacePathStat,
} from "./workspace-path-policy.js";

const DARWIN_WORKSPACE_BINDING_API_VERSION = 1;
const DARWIN_WORKSPACE_BINDING_ABI_VERSION = 2;
const MAX_IO_BYTES = 8 * 1024 * 1024;
const COPY_BUFFER_BYTES = 256 * 1024;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_FILE_TYPE = 0o100000;
const DIRECTORY_TYPE = 0o040000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_BINDING_PATH = fileURLToPath(
  new URL("./native/darwin-workspace-fs.node", import.meta.url),
);

export const DARWIN_WORKSPACE_FS_UNAVAILABLE_REASON =
  "darwin_workspace_dirfd_binding_unavailable" as const;

interface NativeEntryStat {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DarwinWorkspaceBinding {
  readonly apiVersion: number;
  readonly abiVersion: number;
  readonly platform: "darwin";
  readonly resolution: "dirfd-relative";
  readonly adapter: "workspace-safe-fs";
  openRoot(absolutePath: string): number;
  openAt(dirfd: number, name: string, flags: number, mode: number): number;
  mkdirAt(dirfd: number, name: string, mode: number): void;
  renameAt(
    sourceDirfd: number,
    sourceName: string,
    destinationDirfd: number,
    destinationName: string,
    mode: 0 | 1 | 2,
  ): void;
  unlinkAt(dirfd: number, name: string, directory: boolean): void;
  readDirectory(dirfd: number): unknown;
  duplicateDescriptor(descriptor: number): number;
  fsync(descriptor: number): void;
  writeAt(descriptor: number, bytes: Uint8Array, offset: number): number;
  close(descriptor: number): void;
  statAt(dirfd: number, name: string): unknown;
}

export interface DarwinWorkspaceFileSystemOptions {
  readonly addonPath?: string;
  readonly pollIntervalMs?: number;
}

export class DarwinWorkspaceFileSystem implements SafeWorkspaceFsPort {
  public readonly releaseReady: boolean;
  public readonly supportsDirectoryRelativeOperations: boolean;
  public readonly unsupportedReason?: string;
  private readonly binding: DarwinWorkspaceBinding | null;
  private readonly pollIntervalMs: number;
  private readonly roots = new WeakSet<DarwinWorkspaceDirectoryHandle>();

  public constructor(options: DarwinWorkspaceFileSystemOptions = {}) {
    const addonPath = options.addonPath ?? DEFAULT_BINDING_PATH;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 60_000) {
      throw new Error("Darwin workspace poll interval is invalid");
    }
    this.binding = loadDarwinWorkspaceBinding(addonPath);
    this.releaseReady = this.binding !== null;
    this.supportsDirectoryRelativeOperations = this.releaseReady;
    this.unsupportedReason = this.releaseReady ? undefined : DARWIN_WORKSPACE_FS_UNAVAILABLE_REASON;
    this.pollIntervalMs = pollIntervalMs;
  }

  public async openWorkspaceRoot(root: string): Promise<SafeDirectoryHandle> {
    const binding = this.assertAvailable();
    const descriptor = binding.openRoot(root);
    assertDescriptor(descriptor);
    const handle = new DarwinWorkspaceDirectoryHandle(descriptor);
    this.roots.add(handle);
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory()) throw new Error("Workspace root is not a directory");
      return handle;
    } catch (error) {
      await closeWithPrimary(error, [handle]);
      throw error;
    }
  }

  public async read(root: SafeDirectoryHandle, path: readonly string[]): Promise<SafeFileHandle> {
    const pathSnapshot = snapshotPath(path, false);
    return this.withRoot(root, (rootDescriptor) =>
      this.withParent(rootDescriptor, pathSnapshot, false, async (parentDescriptor, name) => {
        const descriptor = this.bindingRequired().openAt(
          parentDescriptor,
          name,
          fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
          0,
        );
        assertDescriptor(descriptor);
        const handle = new DarwinWorkspaceFileHandle(descriptor);
        try {
          const stat = await handle.statNative();
          assertRegularFile(stat);
          assertEntryIdentity(
            parseNativeStat(this.bindingRequired().statAt(parentDescriptor, name)),
            stat,
          );
          return handle;
        } catch (error) {
          await closeWithPrimary(error, [handle]);
          throw error;
        }
      }),
    );
  }

  public async stat(
    root: SafeDirectoryHandle,
    path: readonly string[],
  ): Promise<WorkspacePathStat> {
    const pathSnapshot = snapshotPath(path, true);
    if (pathSnapshot.length === 0) {
      return this.withRoot(root, async (descriptor) =>
        toWorkspaceStat(await fstatDescriptor(descriptor)),
      );
    }
    return this.withRoot(root, (rootDescriptor) =>
      this.withParent(rootDescriptor, pathSnapshot, false, async (parentDescriptor, name) => {
        const descriptor = this.bindingRequired().openAt(
          parentDescriptor,
          name,
          fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
          0,
        );
        assertDescriptor(descriptor);
        return withRawDescriptor(descriptor, async () => {
          const stat = await fstatDescriptor(descriptor);
          assertEntryIdentity(
            parseNativeStat(this.bindingRequired().statAt(parentDescriptor, name)),
            stat,
          );
          return toWorkspaceStat(stat);
        });
      }),
    );
  }

  public async list(
    root: SafeDirectoryHandle,
    path: readonly string[],
  ): Promise<readonly string[]> {
    const pathSnapshot = snapshotPath(path, true);
    if (pathSnapshot.length === 0) return this.listRoot(root);
    return this.withRoot(root, (rootDescriptor) =>
      this.withDirectory(rootDescriptor, pathSnapshot, false, async (descriptor) =>
        readDirectory(this.bindingRequired(), descriptor),
      ),
    );
  }

  public async listRoot(root: SafeDirectoryHandle): Promise<readonly string[]> {
    return this.withRoot(root, async (descriptor) =>
      readDirectory(this.bindingRequired(), descriptor),
    );
  }

  public async write(
    root: SafeDirectoryHandle,
    path: readonly string[],
    bytes: Uint8Array,
    expected: { readonly modifiedAt: string; readonly revision?: string },
  ): Promise<void> {
    const pathSnapshot = snapshotPath(path, false);
    const bytesSnapshot = snapshotBytes(bytes);
    const expectedSnapshot = snapshotExpected(expected);
    await this.withRoot(root, (rootDescriptor) =>
      this.withParent(rootDescriptor, pathSnapshot, false, async (parentDescriptor, name) => {
        await this.replaceFile(parentDescriptor, name, bytesSnapshot, expectedSnapshot);
      }),
    );
  }

  public async create(
    root: SafeDirectoryHandle,
    path: readonly string[],
    kind: "file" | "directory",
  ): Promise<void> {
    const pathSnapshot = snapshotPath(path, false);
    if (kind !== "file" && kind !== "directory") throw new Error("Invalid workspace entry kind");
    await this.withRoot(root, (rootDescriptor) =>
      this.withParent(rootDescriptor, pathSnapshot, true, async (parentDescriptor, name) => {
        if (kind === "directory") {
          this.bindingRequired().mkdirAt(parentDescriptor, name, 0o700);
          await commitCreatedDirectory(this.bindingRequired(), parentDescriptor, name);
          return;
        }
        const descriptor = this.bindingRequired().openAt(
          parentDescriptor,
          name,
          fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR,
          0o600,
        );
        assertDescriptor(descriptor);
        await commitCreatedFile(this.bindingRequired(), parentDescriptor, name, descriptor);
      }),
    );
  }

  public async rename(
    root: SafeDirectoryHandle,
    from: readonly string[],
    to: readonly string[],
  ): Promise<void> {
    const sourceSnapshot = snapshotPath(from, false);
    const destinationSnapshot = snapshotPath(to, false);
    await this.withRoot(root, (rootDescriptor) =>
      this.withTwoParents(
        rootDescriptor,
        sourceSnapshot,
        destinationSnapshot,
        true,
        async (source, destination) => {
          const sourceDescriptor = this.bindingRequired().openAt(
            source.descriptor,
            source.name,
            fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
            0,
          );
          assertDescriptor(sourceDescriptor);
          await withRawDescriptor(sourceDescriptor, async () => {
            const sourceStat = await fstatDescriptor(sourceDescriptor);
            let moved = false;
            let primary: unknown;
            const cleanup: unknown[] = [];
            try {
              assertEntryIdentity(
                parseNativeStat(this.bindingRequired().statAt(source.descriptor, source.name)),
                sourceStat,
              );
              this.bindingRequired().renameAt(
                source.descriptor,
                source.name,
                destination.descriptor,
                destination.name,
                1,
              );
              moved = true;
              assertEntryIdentity(
                parseNativeStat(
                  this.bindingRequired().statAt(destination.descriptor, destination.name),
                ),
                sourceStat,
              );
              await syncDescriptor(source.descriptor);
              if (destination.descriptor !== source.descriptor) {
                await syncDescriptor(destination.descriptor);
              }
            } catch (error) {
              primary = error;
              if (moved) {
                cleanup.push(
                  ...(await settleRenameRollback(
                    this.bindingRequired(),
                    destination,
                    source,
                    sourceStat,
                  )),
                );
              }
            }
            throwAggregate(primary, cleanup, "Workspace rename failed");
          });
        },
      ),
    );
  }

  public async copy(
    root: SafeDirectoryHandle,
    from: readonly string[],
    to: readonly string[],
  ): Promise<void> {
    const sourceSnapshot = snapshotPath(from, false);
    const destinationSnapshot = snapshotPath(to, false);
    await this.withRoot(root, (rootDescriptor) =>
      this.withTwoParents(
        rootDescriptor,
        sourceSnapshot,
        destinationSnapshot,
        true,
        async (source, destination) => {
          const sourceDescriptor = this.bindingRequired().openAt(
            source.descriptor,
            source.name,
            fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
            0,
          );
          assertDescriptor(sourceDescriptor);
          await withRawDescriptor(sourceDescriptor, async () => {
            const before = await fstatDescriptor(sourceDescriptor);
            assertRegularFile(before);
            const temporary = await this.createTemporaryFile(destination.descriptor);
            let committed = false;
            let primary: unknown;
            const cleanup: unknown[] = [];
            try {
              await copyDescriptor(sourceDescriptor, temporary.descriptor, before.size);
              const after = await fstatDescriptor(sourceDescriptor);
              assertUnchanged(before, after);
              assertEntryIdentity(
                parseNativeStat(this.bindingRequired().statAt(source.descriptor, source.name)),
                before,
              );
              await syncDescriptor(temporary.descriptor);
              this.bindingRequired().renameAt(
                destination.descriptor,
                temporary.name,
                destination.descriptor,
                destination.name,
                1,
              );
              committed = true;
              const created = parseNativeStat(
                this.bindingRequired().statAt(destination.descriptor, destination.name),
              );
              assertEntryIdentity(created, temporary.identity);
              await syncDescriptor(destination.descriptor);
            } catch (error) {
              primary = error;
              cleanup.push(
                ...(await settleCreatedEntryRollback(
                  this.bindingRequired(),
                  destination.descriptor,
                  committed ? destination.name : temporary.name,
                  false,
                  temporary.identity,
                )),
              );
            }
            const closeError = await captureHandleClose(temporary.handle);
            if (closeError !== undefined) cleanup.push(closeError);
            throwAggregate(primary, cleanup, "Workspace copy failed");
          });
        },
      ),
    );
  }

  public async delete(root: SafeDirectoryHandle, path: readonly string[]): Promise<void> {
    const pathSnapshot = snapshotPath(path, false);
    await this.withRoot(root, (rootDescriptor) =>
      this.withParent(rootDescriptor, pathSnapshot, false, async (parentDescriptor, name) => {
        await deleteEntry(this.bindingRequired(), parentDescriptor, name);
      }),
    );
  }

  public async watch(
    root: SafeDirectoryHandle,
    path: readonly string[],
    onChange: () => void = () => undefined,
  ): Promise<AsyncDisposable> {
    const pathSnapshot = snapshotPath(path, true);
    if (typeof onChange !== "function") throw new Error("Invalid workspace watch callback");
    const descriptor = await this.withRoot(root, async (rootDescriptor) => {
      if (pathSnapshot.length === 0) {
        return duplicateDirectory(this.bindingRequired(), rootDescriptor);
      }
      return this.withParent(
        rootDescriptor,
        pathSnapshot,
        false,
        async (parentDescriptor, name) => {
          const opened = this.bindingRequired().openAt(
            parentDescriptor,
            name,
            fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
            0,
          );
          assertDescriptor(opened);
          const handle = new InternalDescriptorHandle(opened);
          try {
            const stat = await fstatDescriptor(opened);
            if (!stat.isDirectory()) assertRegularFile(stat);
            assertEntryIdentity(
              parseNativeStat(this.bindingRequired().statAt(parentDescriptor, name)),
              stat,
            );
            return opened;
          } catch (error) {
            await closeWithPrimary(error, [handle]);
            throw error;
          }
        },
      );
    });
    return DarwinWorkspaceWatch.create(
      descriptor,
      this.bindingRequired(),
      onChange,
      this.pollIntervalMs,
    );
  }

  private assertAvailable(): DarwinWorkspaceBinding {
    if (!this.releaseReady || !this.binding) {
      throw new Error(DARWIN_WORKSPACE_FS_UNAVAILABLE_REASON);
    }
    return this.binding;
  }

  private bindingRequired(): DarwinWorkspaceBinding {
    if (!this.binding) throw new Error(DARWIN_WORKSPACE_FS_UNAVAILABLE_REASON);
    return this.binding;
  }

  private async withRoot<T>(
    root: SafeDirectoryHandle,
    operation: (descriptor: number) => Promise<T>,
  ): Promise<T> {
    this.assertAvailable();
    if (!(root instanceof DarwinWorkspaceDirectoryHandle) || !this.roots.has(root)) {
      throw new Error("Invalid Darwin workspace root capability");
    }
    return root.withDescriptor(operation);
  }

  private async withParent<T>(
    rootDescriptor: number,
    path: readonly string[],
    createMissing: boolean,
    operation: (parentDescriptor: number, name: string) => Promise<T>,
  ): Promise<T> {
    const parentPath = path.slice(0, -1);
    const name = path.at(-1);
    if (name === undefined) throw new Error("Workspace root mutation is forbidden");
    const chain = await openDirectoryChain(
      this.bindingRequired(),
      rootDescriptor,
      parentPath,
      createMissing,
    );
    let outcome: OperationOutcome<T>;
    try {
      outcome = { ok: true, value: await operation(chain.descriptor, name) };
      verifyDirectoryChain(this.bindingRequired(), chain);
    } catch (error) {
      outcome = { ok: false, error };
    }
    const primary = outcome.ok ? undefined : outcome.error;
    const failures = await settleDirectoryChain(
      this.bindingRequired(),
      chain,
      primary !== undefined,
    );
    throwAggregate(primary, failures, "Workspace parent cleanup failed");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async withDirectory<T>(
    rootDescriptor: number,
    path: readonly string[],
    createMissing: boolean,
    operation: (descriptor: number) => Promise<T>,
  ): Promise<T> {
    const chain = await openDirectoryChain(
      this.bindingRequired(),
      rootDescriptor,
      path,
      createMissing,
    );
    let outcome: OperationOutcome<T>;
    try {
      outcome = { ok: true, value: await operation(chain.descriptor) };
      verifyDirectoryChain(this.bindingRequired(), chain);
    } catch (error) {
      outcome = { ok: false, error };
    }
    const primary = outcome.ok ? undefined : outcome.error;
    const failures = await settleDirectoryChain(
      this.bindingRequired(),
      chain,
      primary !== undefined,
    );
    throwAggregate(primary, failures, "Workspace directory cleanup failed");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async withTwoParents<T>(
    rootDescriptor: number,
    sourcePath: readonly string[],
    destinationPath: readonly string[],
    createDestination: boolean,
    operation: (source: ParentEntry, destination: ParentEntry) => Promise<T>,
  ): Promise<T> {
    const sourceName = sourcePath.at(-1);
    const destinationName = destinationPath.at(-1);
    if (sourceName === undefined || destinationName === undefined) {
      throw new Error("Workspace root mutation is forbidden");
    }
    const sourceChain = await openDirectoryChain(
      this.bindingRequired(),
      rootDescriptor,
      sourcePath.slice(0, -1),
      false,
    );
    const sharedParent = pathsEqual(sourcePath.slice(0, -1), destinationPath.slice(0, -1));
    let destinationChain: DirectoryChain;
    if (sharedParent) {
      destinationChain = sourceChain;
    } else {
      try {
        destinationChain = await openDirectoryChain(
          this.bindingRequired(),
          rootDescriptor,
          destinationPath.slice(0, -1),
          createDestination,
        );
      } catch (error) {
        const failures = await settleDirectoryChain(this.bindingRequired(), sourceChain, false);
        throwAggregate(error, failures, "Workspace source parent cleanup failed");
        throw error;
      }
    }
    let outcome: OperationOutcome<T>;
    try {
      outcome = {
        ok: true,
        value: await operation(
          { descriptor: sourceChain.descriptor, name: sourceName },
          { descriptor: destinationChain.descriptor, name: destinationName },
        ),
      };
      verifyDirectoryChain(this.bindingRequired(), sourceChain);
      if (!sharedParent) verifyDirectoryChain(this.bindingRequired(), destinationChain);
    } catch (error) {
      outcome = { ok: false, error };
    }
    const primary = outcome.ok ? undefined : outcome.error;
    const destinationFailures = sharedParent
      ? []
      : await settleDirectoryChain(this.bindingRequired(), destinationChain, primary !== undefined);
    const sourceFailures = await settleDirectoryChain(
      this.bindingRequired(),
      sourceChain,
      sharedParent && primary !== undefined,
    );
    throwAggregate(
      primary,
      [...destinationFailures, ...sourceFailures],
      "Workspace parent cleanup failed",
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async createTemporaryFile(parentDescriptor: number): Promise<TemporaryFile> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = `.paseo-${randomBytes(16).toString("hex")}.tmp`;
      try {
        const descriptor = this.bindingRequired().openAt(
          parentDescriptor,
          name,
          fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_RDWR,
          0o600,
        );
        assertDescriptor(descriptor);
        const handle = new InternalDescriptorHandle(descriptor);
        try {
          const identity = await fstatDescriptor(descriptor);
          assertRegularFile(identity);
          assertEntryIdentity(
            parseNativeStat(this.bindingRequired().statAt(parentDescriptor, name)),
            identity,
          );
          return { name, descriptor, handle, identity };
        } catch (error) {
          await closeWithPrimary(error, [handle]);
          throw error;
        }
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    throw new Error("Workspace temporary file name collision");
  }

  private async replaceFile(
    parentDescriptor: number,
    name: string,
    bytes: Uint8Array,
    expected: { readonly modifiedAt: string; readonly revision?: string },
  ): Promise<void> {
    const originalDescriptor = this.bindingRequired().openAt(
      parentDescriptor,
      name,
      fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
      0,
    );
    assertDescriptor(originalDescriptor);
    await withRawDescriptor(originalDescriptor, async () => {
      const original = await fstatDescriptor(originalDescriptor);
      assertRegularFile(original);
      assertExpected(original, expected);
      const temporary = await this.createTemporaryFile(parentDescriptor);
      let exchanged = false;
      let oldRemoved = false;
      let primary: unknown;
      const cleanup: unknown[] = [];
      try {
        await writeDescriptorCompletely(temporary.descriptor, bytes, 0);
        await truncateDescriptor(temporary.descriptor, bytes.byteLength);
        await syncDescriptor(temporary.descriptor);
        assertUnchanged(original, await fstatDescriptor(originalDescriptor));
        assertEntryIdentity(
          parseNativeStat(this.bindingRequired().statAt(parentDescriptor, name)),
          original,
        );
        this.bindingRequired().renameAt(
          parentDescriptor,
          temporary.name,
          parentDescriptor,
          name,
          2,
        );
        exchanged = true;
        const displaced = parseNativeStat(
          this.bindingRequired().statAt(parentDescriptor, temporary.name),
        );
        assertEntryIdentity(displaced, original);
        await syncDescriptor(parentDescriptor);
        this.bindingRequired().unlinkAt(parentDescriptor, temporary.name, false);
        oldRemoved = true;
        await syncDescriptor(parentDescriptor);
      } catch (error) {
        primary = error;
        if (exchanged && !oldRemoved) {
          cleanup.push(
            ...(await settleExchangeRollback(
              this.bindingRequired(),
              parentDescriptor,
              temporary.name,
              name,
              original,
              temporary.identity,
            )),
          );
        } else if (!exchanged) {
          cleanup.push(
            ...(await settleCreatedEntryRollback(
              this.bindingRequired(),
              parentDescriptor,
              temporary.name,
              false,
              temporary.identity,
            )),
          );
        }
      }
      const closeError = await captureHandleClose(temporary.handle);
      if (closeError !== undefined) cleanup.push(closeError);
      throwAggregate(primary, cleanup, "Workspace write failed");
    });
  }
}

class DescriptorLease {
  private inFlight = 0;
  private closePromise: Promise<void> | null = null;
  private drain: (() => void) | null = null;

  public constructor(public readonly descriptor: number) {
    assertDescriptor(descriptor);
  }

  public async run<T>(operation: (descriptor: number) => Promise<T>): Promise<T> {
    if (this.closePromise) throw new Error("Darwin workspace descriptor is closed");
    this.inFlight += 1;
    try {
      return await operation(this.descriptor);
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.drain?.();
    }
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = (async () => {
        if (this.inFlight > 0) {
          await new Promise<void>((resolve) => {
            this.drain = resolve;
          });
        }
        await closeDescriptor(this.descriptor);
      })();
    }
    return this.closePromise;
  }
}

class DarwinWorkspaceDirectoryHandle implements SafeDirectoryHandle {
  private readonly lease: DescriptorLease;

  public constructor(descriptor: number) {
    this.lease = new DescriptorLease(descriptor);
  }

  public stat(): Promise<WorkspacePathIdentity & { isDirectory(): boolean }> {
    return this.lease.run(async (descriptor) => {
      const stat = await fstatDescriptor(descriptor);
      return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        isDirectory: () => stat.isDirectory(),
      });
    });
  }

  public withDescriptor<T>(operation: (descriptor: number) => Promise<T>): Promise<T> {
    return this.lease.run(operation);
  }

  public close(): Promise<void> {
    return this.lease.close();
  }
}

class DarwinWorkspaceFileHandle implements SafeFileHandle {
  private readonly lease: DescriptorLease;

  public constructor(descriptor: number) {
    this.lease = new DescriptorLease(descriptor);
  }

  public stat(): Promise<WorkspacePathIdentity & { size: number; mtimeMs: number }> {
    return this.lease.run(async (descriptor) => {
      const stat = await fstatDescriptor(descriptor);
      assertRegularFile(stat);
      return Object.freeze({
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    });
  }

  public statNative(): Promise<nodeFs.Stats> {
    return this.lease.run(fstatDescriptor);
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    validateReadRange(offset, length);
    return this.lease.run((descriptor) => readDescriptor(descriptor, offset, length));
  }

  public close(): Promise<void> {
    return this.lease.close();
  }
}

class InternalDescriptorHandle {
  private closePromise: Promise<void> | null = null;

  public constructor(private readonly descriptor: number) {}

  public close(): Promise<void> {
    this.closePromise ??= closeDescriptor(this.descriptor);
    return this.closePromise;
  }
}

class DarwinWorkspaceWatch implements AsyncDisposable {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private callbackFailure: unknown;
  private pollFailure: unknown;
  private snapshot: string;

  private constructor(
    private readonly descriptor: number,
    private readonly binding: DarwinWorkspaceBinding,
    initialSnapshot: string,
    private readonly onChange: () => void,
    private readonly pollIntervalMs: number,
  ) {
    this.snapshot = initialSnapshot;
    this.schedule();
  }

  public static async create(
    descriptor: number,
    binding: DarwinWorkspaceBinding,
    onChange: () => void,
    pollIntervalMs: number,
  ): Promise<DarwinWorkspaceWatch> {
    try {
      const snapshot = await descriptorSnapshot(binding, descriptor);
      return new DarwinWorkspaceWatch(descriptor, binding, snapshot, onChange, pollIntervalMs);
    } catch (error) {
      await closeWithPrimary(error, [new InternalDescriptorHandle(descriptor)]);
      throw error;
    }
  }

  public [Symbol.asyncDispose](): Promise<void> {
    if (!this.disposePromise) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.disposePromise = (async () => {
        const errors: unknown[] = [];
        const polling = this.polling;
        if (polling) {
          const pollError = await captureError(() => polling);
          if (pollError !== undefined) errors.push(pollError);
        }
        if (this.pollFailure !== undefined) errors.push(this.pollFailure);
        if (this.callbackFailure !== undefined) errors.push(this.callbackFailure);
        const closeError = await captureError(() => closeDescriptor(this.descriptor));
        if (closeError !== undefined) errors.push(closeError);
        throwAggregate(undefined, errors, "Darwin workspace watch disposal failed");
      })();
    }
    return this.disposePromise;
  }

  private schedule(): void {
    if (
      this.disposePromise ||
      this.callbackFailure !== undefined ||
      this.pollFailure !== undefined
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.polling = this.poll()
        .catch((error: unknown) => {
          this.pollFailure = error;
        })
        .finally(() => {
          this.polling = null;
          this.schedule();
        });
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (this.disposePromise) return;
    const next = await descriptorSnapshot(this.binding, this.descriptor);
    if (this.disposePromise || next === this.snapshot) return;
    this.snapshot = next;
    try {
      this.onChange();
    } catch (error) {
      this.callbackFailure = error;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

interface DirectoryStep {
  readonly descriptor: number;
  readonly parentDescriptor: number;
  readonly name: string;
  readonly created: boolean;
  readonly identity?: nodeFs.Stats;
}

interface DirectoryChain {
  readonly descriptor: number;
  readonly steps: readonly DirectoryStep[];
  readonly rollbackCreated: boolean;
}

interface ParentEntry {
  readonly descriptor: number;
  readonly name: string;
}

interface TemporaryFile {
  readonly name: string;
  readonly descriptor: number;
  readonly handle: InternalDescriptorHandle;
  readonly identity: nodeFs.Stats;
}

type OperationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export function loadDarwinWorkspaceBinding(addonPath: string): DarwinWorkspaceBinding | null {
  if (process.platform !== "darwin" || !addonPath.endsWith(".node")) return null;
  const napiVersion = Number(process.versions.napi);
  if (!Number.isSafeInteger(napiVersion) || napiVersion < 10) return null;
  try {
    const loaded: unknown = createRequire(import.meta.url)(addonPath);
    return captureBinding(loaded);
  } catch {
    return null;
  }
}

function captureBinding(value: unknown): DarwinWorkspaceBinding | null {
  try {
    if (!value || typeof value !== "object") return null;
    const source = value as Partial<DarwinWorkspaceBinding>;
    const apiVersion = source.apiVersion;
    const abiVersion = source.abiVersion;
    const platform = source.platform;
    const resolution = source.resolution;
    const adapter = source.adapter;
    const openRoot = source.openRoot;
    const openAt = source.openAt;
    const mkdirAt = source.mkdirAt;
    const renameAt = source.renameAt;
    const unlinkAt = source.unlinkAt;
    const nativeReadDirectory = source.readDirectory;
    const duplicateDescriptor = source.duplicateDescriptor;
    const statAt = source.statAt;
    const fsync = source.fsync;
    const writeAt = source.writeAt;
    const close = source.close;
    const validMetadata =
      apiVersion === DARWIN_WORKSPACE_BINDING_API_VERSION &&
      abiVersion === DARWIN_WORKSPACE_BINDING_ABI_VERSION &&
      platform === "darwin" &&
      resolution === "dirfd-relative" &&
      adapter === "workspace-safe-fs";
    const validSymbols =
      typeof openRoot === "function" &&
      typeof openAt === "function" &&
      typeof mkdirAt === "function" &&
      typeof renameAt === "function" &&
      typeof unlinkAt === "function" &&
      typeof nativeReadDirectory === "function" &&
      typeof duplicateDescriptor === "function" &&
      typeof statAt === "function" &&
      typeof fsync === "function" &&
      typeof writeAt === "function" &&
      typeof close === "function";
    if (!validMetadata || !validSymbols) return null;
    return Object.freeze({
      apiVersion,
      abiVersion,
      platform,
      resolution,
      adapter,
      openRoot: openRoot.bind(source),
      openAt: openAt.bind(source),
      mkdirAt: mkdirAt.bind(source),
      renameAt: renameAt.bind(source),
      unlinkAt: unlinkAt.bind(source),
      readDirectory: nativeReadDirectory.bind(source),
      duplicateDescriptor: duplicateDescriptor.bind(source),
      statAt: statAt.bind(source),
      fsync: fsync.bind(source),
      writeAt: writeAt.bind(source),
      close: close.bind(source),
    });
  } catch {
    return null;
  }
}

async function openDirectoryChain(
  binding: DarwinWorkspaceBinding,
  rootDescriptor: number,
  path: readonly string[],
  createMissing: boolean,
): Promise<DirectoryChain> {
  const steps: DirectoryStep[] = [];
  let current = rootDescriptor;
  try {
    for (const name of path) {
      const { descriptor, created } = openDirectoryComponent(binding, current, name, createMissing);
      assertDescriptor(descriptor);
      steps.push({ descriptor, parentDescriptor: current, name, created });
      const identity = await fstatDescriptor(descriptor);
      if (!identity.isDirectory()) throw new Error("Workspace path component is not a directory");
      steps[steps.length - 1] = {
        descriptor,
        parentDescriptor: current,
        name,
        created,
        identity,
      };
      assertEntryIdentity(parseNativeStat(binding.statAt(current, name)), identity);
      if (created) {
        await syncDescriptor(descriptor);
        assertEntryIdentity(parseNativeStat(binding.statAt(current, name)), identity);
        await syncDescriptor(current);
        assertEntryIdentity(parseNativeStat(binding.statAt(current, name)), identity);
      }
      current = descriptor;
    }
    return { descriptor: current, steps, rollbackCreated: createMissing };
  } catch (error) {
    const failures = await settleDirectoryChain(
      binding,
      { descriptor: current, steps, rollbackCreated: true },
      true,
    );
    throwAggregate(error, failures, "Workspace directory traversal failed");
    throw error;
  }
}

function openDirectoryComponent(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  name: string,
  createMissing: boolean,
): { descriptor: number; created: boolean } {
  try {
    return {
      descriptor: binding.openAt(
        parentDescriptor,
        name,
        fileConstants.O_RDONLY | fileConstants.O_DIRECTORY,
        0,
      ),
      created: false,
    };
  } catch (error) {
    if (!createMissing || !hasCode(error, "ENOENT")) throw error;
  }
  let created = false;
  try {
    binding.mkdirAt(parentDescriptor, name, 0o700);
    created = true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return {
    descriptor: binding.openAt(
      parentDescriptor,
      name,
      fileConstants.O_RDONLY | fileConstants.O_DIRECTORY,
      0,
    ),
    created,
  };
}

async function settleDirectoryChain(
  binding: DarwinWorkspaceBinding,
  chain: DirectoryChain,
  rollbackCreated: boolean,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let index = chain.steps.length - 1; index >= 0; index -= 1) {
    const step = chain.steps[index];
    if (!step) continue;
    const closeError = await captureError(() => closeDescriptor(step.descriptor));
    if (closeError !== undefined) failures.push(closeError);
    if (rollbackCreated && chain.rollbackCreated && step.created) {
      if (!step.identity) {
        failures.push(new Error("Workspace directory rollback identity is unavailable"));
        continue;
      }
      let current: NativeEntryStat;
      try {
        current = parseNativeStat(binding.statAt(step.parentDescriptor, step.name));
      } catch (error) {
        if (!hasCode(error, "ENOENT")) failures.push(error);
        continue;
      }
      if (!entryIdentityMatches(current, step.identity)) {
        failures.push(new Error("Workspace directory rollback identity changed"));
        continue;
      }
      const rollbackError = captureSyncError(() =>
        binding.unlinkAt(step.parentDescriptor, step.name, true),
      );
      if (rollbackError !== undefined) {
        failures.push(rollbackError);
      } else {
        const syncError = await captureError(() => syncDescriptor(step.parentDescriptor));
        if (syncError !== undefined) failures.push(syncError);
      }
    }
  }
  return failures;
}

function verifyDirectoryChain(binding: DarwinWorkspaceBinding, chain: DirectoryChain): void {
  for (const step of chain.steps) {
    if (!step.identity) throw new Error("Workspace directory identity is unavailable");
    assertEntryIdentity(
      parseNativeStat(binding.statAt(step.parentDescriptor, step.name)),
      step.identity,
    );
  }
}

async function commitCreatedFile(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  name: string,
  descriptor: number,
): Promise<void> {
  const handle = new InternalDescriptorHandle(descriptor);
  let created: nodeFs.Stats | undefined;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    created = await fstatDescriptor(descriptor);
    assertRegularFile(created);
    assertEntryIdentity(parseNativeStat(binding.statAt(parentDescriptor, name)), created);
    await syncDescriptor(descriptor);
    await syncDescriptor(parentDescriptor);
  } catch (error) {
    primary = error;
    if (created) {
      cleanup.push(
        ...(await settleCreatedEntryRollback(binding, parentDescriptor, name, false, created)),
      );
    }
  }
  const closeError = await captureHandleClose(handle);
  if (closeError !== undefined) cleanup.push(closeError);
  throwAggregate(primary, cleanup, "Workspace file creation failed");
}

async function commitCreatedDirectory(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  name: string,
): Promise<void> {
  const descriptor = binding.openAt(
    parentDescriptor,
    name,
    fileConstants.O_RDONLY | fileConstants.O_DIRECTORY,
    0,
  );
  assertDescriptor(descriptor);
  const handle = new InternalDescriptorHandle(descriptor);
  let created: nodeFs.Stats | undefined;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    created = await fstatDescriptor(descriptor);
    if (!created.isDirectory()) throw new Error("Workspace entry is not a directory");
    assertEntryIdentity(parseNativeStat(binding.statAt(parentDescriptor, name)), created);
    await syncDescriptor(descriptor);
    await syncDescriptor(parentDescriptor);
  } catch (error) {
    primary = error;
  }
  const closeError = await captureHandleClose(handle);
  if (closeError !== undefined) cleanup.push(closeError);
  if (primary !== undefined && created) {
    cleanup.push(
      ...(await settleCreatedEntryRollback(binding, parentDescriptor, name, true, created)),
    );
  }
  throwAggregate(primary, cleanup, "Workspace directory creation failed");
}

async function settleCreatedEntryRollback(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  name: string,
  directory: boolean,
  expected?: nodeFs.Stats,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (expected) {
    let current: NativeEntryStat;
    try {
      current = parseNativeStat(binding.statAt(parentDescriptor, name));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return failures;
      failures.push(error);
      return failures;
    }
    if (!entryIdentityMatches(current, expected)) {
      failures.push(new Error("Workspace rollback entry identity changed"));
      return failures;
    }
  }
  const unlinkError = captureSyncError(() => binding.unlinkAt(parentDescriptor, name, directory));
  if (unlinkError !== undefined && !hasCode(unlinkError, "ENOENT")) failures.push(unlinkError);
  const syncError = await captureError(() => syncDescriptor(parentDescriptor));
  if (syncError !== undefined) failures.push(syncError);
  return failures;
}

async function settleExchangeRollback(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  temporaryName: string,
  destinationName: string,
  original: nodeFs.Stats,
  temporary: nodeFs.Stats,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    const displaced = parseNativeStat(binding.statAt(parentDescriptor, temporaryName));
    const destination = parseNativeStat(binding.statAt(parentDescriptor, destinationName));
    if (
      !entryIdentityMatches(displaced, original) ||
      !entryIdentityMatches(destination, temporary)
    ) {
      return [new Error("Workspace write rollback identity changed")];
    }
  } catch (error) {
    return [error];
  }
  const swapError = captureSyncError(() =>
    binding.renameAt(parentDescriptor, temporaryName, parentDescriptor, destinationName, 2),
  );
  if (swapError !== undefined) failures.push(swapError);
  const createdCleanup = await settleCreatedEntryRollback(
    binding,
    parentDescriptor,
    temporaryName,
    false,
    temporary,
  );
  failures.push(...createdCleanup);
  return failures;
}

async function settleRenameRollback(
  binding: DarwinWorkspaceBinding,
  from: ParentEntry,
  to: ParentEntry,
  expected: nodeFs.Stats,
): Promise<unknown[]> {
  try {
    const current = parseNativeStat(binding.statAt(from.descriptor, from.name));
    if (!entryIdentityMatches(current, expected)) {
      return [new Error("Workspace rename rollback identity changed")];
    }
  } catch (error) {
    return [error];
  }
  const renameError = captureSyncError(() =>
    binding.renameAt(from.descriptor, from.name, to.descriptor, to.name, 1),
  );
  if (renameError !== undefined) return [renameError];
  const failures: unknown[] = [];
  const sourceSyncError = await captureError(() => syncDescriptor(to.descriptor));
  if (sourceSyncError !== undefined) failures.push(sourceSyncError);
  if (from.descriptor !== to.descriptor) {
    const destinationSyncError = await captureError(() => syncDescriptor(from.descriptor));
    if (destinationSyncError !== undefined) failures.push(destinationSyncError);
  }
  return failures;
}

async function deleteEntry(
  binding: DarwinWorkspaceBinding,
  parentDescriptor: number,
  name: string,
): Promise<void> {
  const descriptor = binding.openAt(
    parentDescriptor,
    name,
    fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
    0,
  );
  assertDescriptor(descriptor);
  await withRawDescriptor(descriptor, async () => {
    const stat = await fstatDescriptor(descriptor);
    if (stat.isDirectory()) {
      const names = await readDirectory(binding, descriptor);
      for (const child of names) await deleteEntry(binding, descriptor, child);
      await syncDescriptor(descriptor);
    } else {
      assertRegularFile(stat);
    }
    const current = parseNativeStat(binding.statAt(parentDescriptor, name));
    assertEntryIdentity(current, stat);
    binding.unlinkAt(parentDescriptor, name, stat.isDirectory());
    await syncDescriptor(parentDescriptor);
  });
}

function duplicateDirectory(binding: DarwinWorkspaceBinding, descriptor: number): number {
  const duplicated = binding.duplicateDescriptor(descriptor);
  assertDescriptor(duplicated);
  return duplicated;
}

async function descriptorSnapshot(
  binding: DarwinWorkspaceBinding,
  descriptor: number,
): Promise<string> {
  const stat = await fstatDescriptor(descriptor);
  if (stat.isDirectory()) {
    return JSON.stringify([
      stat.dev,
      stat.ino,
      stat.mtimeMs,
      await directorySnapshot(binding, descriptor),
    ]);
  }
  assertRegularFile(stat);
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs]);
}

async function directorySnapshot(
  binding: DarwinWorkspaceBinding,
  descriptor: number,
): Promise<readonly unknown[]> {
  const snapshot: unknown[] = [];
  for (const name of readDirectory(binding, descriptor)) {
    const entry = parseNativeStat(binding.statAt(descriptor, name));
    const type = entry.mode & FILE_TYPE_MASK;
    if (type === DIRECTORY_TYPE) {
      const childDescriptor = binding.openAt(
        descriptor,
        name,
        fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NONBLOCK,
        0,
      );
      assertDescriptor(childDescriptor);
      snapshot.push(
        await withRawDescriptor(childDescriptor, async () => {
          const child = await fstatDescriptor(childDescriptor);
          if (!child.isDirectory()) throw new Error("Workspace watch entry type changed");
          assertEntryIdentity(entry, child);
          const nested = await directorySnapshot(binding, childDescriptor);
          assertEntryIdentity(parseNativeStat(binding.statAt(descriptor, name)), child);
          return [name, "directory", child.dev, child.ino, child.mtimeMs, nested];
        }),
      );
      continue;
    }
    if (type === REGULAR_FILE_TYPE) {
      const childDescriptor = binding.openAt(
        descriptor,
        name,
        fileConstants.O_RDONLY | fileConstants.O_NONBLOCK,
        0,
      );
      assertDescriptor(childDescriptor);
      snapshot.push(
        await withRawDescriptor(childDescriptor, async () => {
          const child = await fstatDescriptor(childDescriptor);
          assertRegularFile(child);
          assertEntryIdentity(entry, child);
          return [name, "file", child.dev, child.ino, child.size, child.mtimeMs];
        }),
      );
      continue;
    }
    snapshot.push([name, "other", entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs]);
  }
  return snapshot;
}

function readDirectory(binding: DarwinWorkspaceBinding, descriptor: number): readonly string[] {
  const output = binding.readDirectory(descriptor);
  let entries: readonly string[];
  try {
    entries = snapshotStringArray(output, true);
  } catch {
    throw new Error("Darwin workspace binding returned invalid directory entries");
  }
  return Object.freeze([...entries].sort());
}

function parseNativeStat(value: unknown): NativeEntryStat {
  if (!value || typeof value !== "object") throw new Error("Invalid native workspace stat");
  const source = value as Partial<NativeEntryStat>;
  const stat = {
    dev: source.dev,
    ino: source.ino,
    mode: source.mode,
    size: source.size,
    mtimeMs: source.mtimeMs,
  };
  if (
    !Number.isSafeInteger(stat.dev) ||
    !Number.isSafeInteger(stat.ino) ||
    !Number.isSafeInteger(stat.mode) ||
    !Number.isSafeInteger(stat.size) ||
    !Number.isFinite(stat.mtimeMs)
  ) {
    throw new Error("Invalid native workspace stat");
  }
  return stat as NativeEntryStat;
}

function toWorkspaceStat(stat: nodeFs.Stats): WorkspacePathStat {
  let kind: WorkspacePathStat["kind"];
  if (stat.isFile()) kind = "file";
  else if (stat.isDirectory()) kind = "directory";
  else throw new Error("Unsupported workspace entry type");
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

function assertRegularFile(stat: nodeFs.Stats): void {
  if (!stat.isFile()) throw new Error("Workspace entry is not a regular file");
}

function assertEntryIdentity(actual: NativeEntryStat, expected: nodeFs.Stats): void {
  if (!entryIdentityMatches(actual, expected)) {
    throw new Error("Workspace entry identity changed during operation");
  }
}

function entryIdentityMatches(actual: NativeEntryStat, expected: nodeFs.Stats): boolean {
  const actualType = actual.mode & FILE_TYPE_MASK;
  const expectedType = expected.isDirectory() ? DIRECTORY_TYPE : REGULAR_FILE_TYPE;
  return actual.dev === expected.dev && actual.ino === expected.ino && actualType === expectedType;
}

function assertUnchanged(before: nodeFs.Stats, after: nodeFs.Stats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("Workspace source changed during copy");
  }
}

function assertExpected(
  stat: nodeFs.Stats,
  expected: { readonly modifiedAt: string; readonly revision?: string },
): void {
  const modifiedAt = new Date(stat.mtimeMs).toISOString();
  const revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (modifiedAt !== expected.modifiedAt || (expected.revision && expected.revision !== revision)) {
    throw new Error("Workspace file changed before write");
  }
}

function snapshotExpected(expected: {
  readonly modifiedAt: string;
  readonly revision?: string;
}): Readonly<{ modifiedAt: string; revision?: string }> {
  try {
    if (!expected || typeof expected !== "object") {
      throw new Error("Invalid workspace file version");
    }
    const keys = Reflect.ownKeys(expected);
    if (!hasExpectedVersionKeys(keys)) {
      throw new Error("Invalid workspace file version");
    }
    const modifiedAt = readEnumerableDataProperty(expected, "modifiedAt");
    const revision = keys.includes("revision")
      ? readEnumerableDataProperty(expected, "revision")
      : undefined;
    if (typeof modifiedAt !== "string") throw new Error("Invalid workspace file version");
    if (revision !== undefined && (typeof revision !== "string" || revision.length === 0)) {
      throw new Error("Invalid workspace file version");
    }
    const parsed = Date.parse(modifiedAt);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== modifiedAt) {
      throw new Error("Invalid workspace file version");
    }
    return revision === undefined
      ? Object.freeze({ modifiedAt })
      : Object.freeze({ modifiedAt, revision });
  } catch {
    throw new Error("Invalid workspace file version");
  }
}

function hasExpectedVersionKeys(keys: readonly PropertyKey[]): boolean {
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.includes("modifiedAt") &&
    keys.every((key) => key === "modifiedAt" || key === "revision")
  );
}

function readEnumerableDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("Invalid workspace file version");
  }
  return descriptor.value;
}

function snapshotBytes(bytes: Uint8Array): Uint8Array {
  try {
    if (!(bytes instanceof Uint8Array)) throw new Error("Invalid workspace write size");
    const snapshot = Uint8Array.prototype.slice.call(bytes) as Uint8Array;
    if (snapshot.byteLength > MAX_IO_BYTES) throw new Error("Invalid workspace write size");
    return snapshot;
  } catch {
    throw new Error("Invalid workspace write size");
  }
}

function validateReadRange(offset: number, length: number): void {
  const valid =
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_IO_BYTES &&
    Number.isSafeInteger(offset + length);
  if (!valid) throw new Error("Invalid workspace read range");
}

function snapshotPath(path: readonly string[], allowRoot: boolean): readonly string[] {
  try {
    const snapshot = snapshotStringArray(path, allowRoot);
    if (snapshot.some((name) => !isEntryName(name))) {
      throw new Error("Unsafe workspace path components");
    }
    return snapshot;
  } catch {
    throw new Error("Unsafe workspace path components");
  }
}

function snapshotStringArray(value: unknown, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Unsafe workspace path components");
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    (!allowEmpty && length === 0) ||
    keys.length !== length + 1 ||
    !keys.includes("length")
  ) {
    throw new Error("Unsafe workspace path components");
  }
  const snapshot: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new Error("Unsafe workspace path components");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    ) {
      throw new Error("Unsafe workspace path components");
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

function isEntryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function assertDescriptor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Darwin workspace binding returned an invalid descriptor");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function fstatDescriptor(descriptor: number): Promise<nodeFs.Stats> {
  return new Promise((resolve, reject) => {
    nodeFs.fstat(descriptor, (error, stat) => {
      if (error) reject(error);
      else resolve(stat);
    });
  });
}

function readDescriptor(descriptor: number, offset: number, length: number): Promise<Uint8Array> {
  if (length === 0) return Promise.resolve(new Uint8Array());
  const buffer = Buffer.allocUnsafe(length);
  return new Promise((resolve, reject) => {
    nodeFs.read(descriptor, buffer, 0, length, offset, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
    });
  });
}

function writeDescriptor(
  descriptor: number,
  bytes: Uint8Array,
  bufferOffset: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    nodeFs.write(
      descriptor,
      bytes,
      bufferOffset,
      bytes.byteLength - bufferOffset,
      position,
      (error, bytesWritten) => {
        if (error) reject(error);
        else resolve(bytesWritten);
      },
    );
  });
}

async function writeDescriptorCompletely(
  descriptor: number,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesWritten = await writeDescriptor(descriptor, bytes, offset, position + offset);
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw new Error("Workspace write made no forward progress");
    }
    offset += bytesWritten;
  }
}

async function copyDescriptor(source: number, destination: number, size: number): Promise<void> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid workspace source size");
  let offset = 0;
  while (offset < size) {
    const length = Math.min(COPY_BUFFER_BYTES, size - offset);
    const chunk = await readDescriptor(source, offset, length);
    if (chunk.byteLength === 0) throw new Error("Workspace source ended during copy");
    await writeDescriptorCompletely(destination, chunk, offset);
    offset += chunk.byteLength;
  }
  await truncateDescriptor(destination, size);
}

function truncateDescriptor(descriptor: number, size: number): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeFs.ftruncate(descriptor, size, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function syncDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeFs.fsync(descriptor, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeDescriptor(descriptor: number): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeFs.close(descriptor, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function withRawDescriptor<T>(descriptor: number, operation: () => Promise<T>): Promise<T> {
  let outcome: OperationOutcome<T>;
  try {
    outcome = { ok: true, value: await operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const primary = outcome.ok ? undefined : outcome.error;
  const closeError = await captureError(() => closeDescriptor(descriptor));
  throwAggregate(
    primary,
    closeError === undefined ? [] : [closeError],
    "Workspace descriptor close failed",
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function closeWithPrimary(
  primary: unknown,
  handles: readonly { close(): Promise<void> }[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const handle of handles) {
    const failure = await captureHandleClose(handle);
    if (failure !== undefined) failures.push(failure);
  }
  throwAggregate(primary, failures, "Darwin workspace handle cleanup failed");
}

function captureHandleClose(handle: { close(): Promise<void> }): Promise<unknown> {
  return captureError(handle.close.bind(handle));
}

function throwAggregate(primary: unknown, cleanup: readonly unknown[], message: string): void {
  if (primary !== undefined && cleanup.length === 0) throw primary;
  if (primary !== undefined)
    throw new AggregateError([primary, ...cleanup], message, { cause: primary });
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length > 1) {
    throw new AggregateError(cleanup, message, { cause: cleanup[0] });
  }
}

async function captureError(operation: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function captureSyncError(operation: () => void): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
