import { createRequire } from "node:module";
import * as nodeFs from "node:fs";
import { constants as fileConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertAuditEntryName,
  type AuditDirectoryHandle,
  type AuditFileHandle,
  type AuditFileStat,
  type AuditFileSystem,
} from "./local-audit-sink.js";

const DARWIN_AUDIT_BINDING_API_VERSION = 1;
const DEFAULT_BINDING_PATH = fileURLToPath(
  new URL("./native/darwin-audit-fs.node", import.meta.url),
);

export const DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON = "darwin_dirfd_binding_unavailable" as const;

interface DarwinAuditBinding {
  readonly apiVersion: number;
  readonly platform: "darwin";
  readonly resolution: "dirfd-relative";
  openAt(dirfd: number, name: string, flags: number, mode: number): number;
  readDirectory(dirfd: number): unknown;
  renameAt(dirfd: number, sourceName: string, destinationName: string): void;
  unlinkAt(dirfd: number, name: string): void;
}

function isDarwinAuditBinding(value: unknown): value is DarwinAuditBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<DarwinAuditBinding>;
  return (
    binding.apiVersion === DARWIN_AUDIT_BINDING_API_VERSION &&
    binding.platform === "darwin" &&
    binding.resolution === "dirfd-relative" &&
    typeof binding.openAt === "function" &&
    typeof binding.readDirectory === "function" &&
    typeof binding.renameAt === "function" &&
    typeof binding.unlinkAt === "function"
  );
}

function loadDarwinAuditBinding(addonPath: string): DarwinAuditBinding | null {
  if (process.platform !== "darwin") return null;
  try {
    const loaded: unknown = createRequire(import.meta.url)(addonPath);
    if (!isDarwinAuditBinding(loaded)) return null;
    return Object.freeze({
      apiVersion: loaded.apiVersion,
      platform: loaded.platform,
      resolution: loaded.resolution,
      openAt: loaded.openAt.bind(loaded),
      readDirectory: loaded.readDirectory.bind(loaded),
      renameAt: loaded.renameAt.bind(loaded),
      unlinkAt: loaded.unlinkAt.bind(loaded),
    });
  } catch {
    return null;
  }
}

function assertDescriptor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Darwin audit binding returned an invalid file descriptor");
  }
}

function fstatDescriptor(descriptor: number): Promise<AuditFileStat> {
  return new Promise((resolve, reject) => {
    nodeFs.fstat(descriptor, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function fchmodDescriptor(descriptor: number, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeFs.fchmod(descriptor, mode, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readDescriptor(descriptor: number): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeFs.readFile(descriptor, { encoding: "utf8" }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function writeDescriptor(descriptor: number, data: string): Promise<{ bytesWritten: number }> {
  return new Promise((resolve, reject) => {
    nodeFs.write(descriptor, data, (error, bytesWritten) => {
      if (error) reject(error);
      else resolve({ bytesWritten });
    });
  });
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

class DarwinAuditFileHandle implements AuditFileHandle {
  private closed = false;

  constructor(private readonly descriptor: number) {
    assertDescriptor(descriptor);
  }

  stat(): Promise<AuditFileStat> {
    this.assertOpen();
    return fstatDescriptor(this.descriptor);
  }

  chmod(mode: number): Promise<void> {
    this.assertOpen();
    return fchmodDescriptor(this.descriptor, mode);
  }

  readFile(encoding: "utf8"): Promise<string> {
    this.assertOpen();
    if (encoding !== "utf8") throw new Error("unsupported audit file encoding");
    return readDescriptor(this.descriptor);
  }

  write(data: string): Promise<{ bytesWritten: number }> {
    this.assertOpen();
    return writeDescriptor(this.descriptor, data);
  }

  truncate(size: number): Promise<void> {
    this.assertOpen();
    return truncateDescriptor(this.descriptor, size);
  }

  sync(): Promise<void> {
    this.assertOpen();
    return syncDescriptor(this.descriptor);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("audit file handle already closed"));
    this.closed = true;
    return closeDescriptor(this.descriptor);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("audit file handle already closed");
  }
}

class DarwinAuditDirectoryHandle implements AuditDirectoryHandle {
  private closed = false;

  constructor(
    private readonly handle: FileHandle,
    private readonly binding: DarwinAuditBinding,
  ) {}

  stat(): Promise<AuditFileStat> {
    this.assertOpen();
    return this.handle.stat();
  }

  chmod(mode: number): Promise<void> {
    this.assertOpen();
    return this.handle.chmod(mode);
  }

  async openFile(name: string, flags: number, mode = 0): Promise<AuditFileHandle> {
    this.assertOpen();
    assertAuditEntryName(name);
    const descriptor = this.binding.openAt(this.handle.fd, name, flags, mode);
    assertDescriptor(descriptor);
    return new DarwinAuditFileHandle(descriptor);
  }

  async readEntries(): Promise<readonly string[]> {
    this.assertOpen();
    const output = this.binding.readDirectory(this.handle.fd);
    if (!Array.isArray(output) || output.some((name) => typeof name !== "string")) {
      throw new Error("Darwin audit binding returned invalid directory entries");
    }
    const names = output.map((name) => {
      assertAuditEntryName(name);
      return name;
    });
    return Object.freeze(names);
  }

  async rename(sourceName: string, destinationName: string): Promise<void> {
    this.assertOpen();
    assertAuditEntryName(sourceName);
    assertAuditEntryName(destinationName);
    this.binding.renameAt(this.handle.fd, sourceName, destinationName);
  }

  async unlink(name: string): Promise<void> {
    this.assertOpen();
    assertAuditEntryName(name);
    this.binding.unlinkAt(this.handle.fd, name);
  }

  sync(): Promise<void> {
    this.assertOpen();
    return this.handle.sync();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("audit directory handle already closed"));
    this.closed = true;
    return this.handle.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("audit directory handle already closed");
  }
}

export interface DarwinAuditFileSystemOptions {
  readonly addonPath?: string;
}

export class DarwinAuditFileSystem implements AuditFileSystem {
  readonly noFollowFlag = fileConstants.O_NOFOLLOW;
  readonly releaseReady: boolean;
  readonly unsupportedReason?: string;
  private readonly binding: DarwinAuditBinding | null;

  constructor(options: DarwinAuditFileSystemOptions = {}) {
    this.binding = loadDarwinAuditBinding(options.addonPath ?? DEFAULT_BINDING_PATH);
    this.releaseReady = this.binding !== null && this.noFollowFlag !== 0;
    this.unsupportedReason = this.releaseReady
      ? undefined
      : DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON;
  }

  async ensureDirectory(directory: string, mode: number): Promise<void> {
    this.assertAvailable();
    await fs.mkdir(directory, { recursive: true, mode });
  }

  async openDirectory(directory: string, flags: number): Promise<AuditDirectoryHandle> {
    const binding = this.assertAvailable();
    const handle = await fs.open(directory, flags | fileConstants.O_DIRECTORY | this.noFollowFlag);
    return new DarwinAuditDirectoryHandle(handle, binding);
  }

  private assertAvailable(): DarwinAuditBinding {
    if (!this.releaseReady || !this.binding) {
      throw new Error(DARWIN_AUDIT_STORAGE_UNAVAILABLE_REASON);
    }
    return this.binding;
  }
}
