import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

export interface GrantFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  mode: number;
  size: number;
}

export interface GrantFileHandle {
  readonly fd: number;
  stat(): Promise<GrantFileStat>;
  chmod(mode: number): Promise<void>;
  readFile(): Promise<string>;
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface GrantDirectoryCreateOptions {
  recursive: true;
  mode: number;
}

export interface GrantTempSuffixSource {
  next(): string;
}

export interface GrantFileSystem {
  mkdir(path: string, options: GrantDirectoryCreateOptions): Promise<void>;
  open(path: string, flags: number, mode?: number): Promise<GrantFileHandle>;
  rename(source: string, target: string): Promise<void>;
  unlink(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  writeAtomic(path: string, data: string): Promise<void>;
}

export type GrantFsPhase =
  | "temp_open"
  | "temp_stat"
  | "chmod"
  | "write"
  | "file_sync"
  | "temp_close"
  | "rename"
  | "parent_sync";

export type GrantFsCommitState = "uncommitted" | "commit_unknown";

export class GrantFsError extends Error {
  constructor(
    public readonly phase: GrantFsPhase,
    public readonly commitState: GrantFsCommitState,
    cause: unknown,
  ) {
    super(`Grant filesystem ${phase} failed`, { cause });
    this.name = "GrantFsError";
  }
}

export class GrantNoFollowUnavailableError extends Error {
  constructor() {
    super("Secure grant storage requires a non-zero O_NOFOLLOW flag");
    this.name = "GrantNoFollowUnavailableError";
  }
}

export class RandomGrantTempSuffixSource implements GrantTempSuffixSource {
  next(): string {
    return randomBytes(16).toString("hex");
  }
}

export class NodeGrantFileSystem implements GrantFileSystem {
  constructor(
    private readonly suffixSource: GrantTempSuffixSource = new RandomGrantTempSuffixSource(),
  ) {}

  async mkdir(directory: string, options: GrantDirectoryCreateOptions): Promise<void> {
    await fs.mkdir(directory, options);
  }

  async open(filePath: string, flags: number, mode?: number): Promise<GrantFileHandle> {
    const handle = await fs.open(filePath, flags, mode);
    return {
      fd: handle.fd,
      stat: async () => {
        const stat = await handle.stat();
        return {
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
          mode: stat.mode & 0o777,
          size: stat.size,
        };
      },
      chmod: (value) => handle.chmod(value),
      readFile: () => handle.readFile("utf8"),
      writeFile: (data) => handle.writeFile(data, "utf8"),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  }

  rename(source: string, target: string): Promise<void> {
    return fs.rename(source, target);
  }

  unlink(filePath: string): Promise<void> {
    return fs.unlink(filePath);
  }

  async syncDirectory(directory: string): Promise<void> {
    let handle: GrantFileHandle | null = null;
    let failure: unknown = null;
    try {
      handle = await this.open(directory, grantDirectoryOpenFlags());
      const stat = await handle.stat();
      if (!stat.isDirectory()) throw new Error("Grant parent path is not a directory");
      await handle.sync();
    } catch (error) {
      failure = error;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          failure = appendFailure(failure, error, "Grant parent directory close failed");
        }
      }
    }
    if (failure) throw failure;
  }

  async writeAtomic(filePath: string, data: string): Promise<void> {
    const tempPath = grantTemporaryPath(filePath, this.suffixSource.next());
    let handle: GrantFileHandle | null = null;
    let tempOpened = false;
    let preparationFailure: unknown = null;
    try {
      try {
        handle = await this.open(tempPath, grantTemporaryOpenFlags(), 0o600);
        tempOpened = true;
      } catch (error) {
        throw new GrantFsError("temp_open", "uncommitted", error);
      }

      let stat: GrantFileStat;
      try {
        stat = await handle.stat();
      } catch (error) {
        throw new GrantFsError("temp_stat", "uncommitted", error);
      }
      if (!stat.isFile()) {
        throw new GrantFsError(
          "temp_stat",
          "uncommitted",
          new Error("Grant temporary path is not a regular file"),
        );
      }

      try {
        await handle.chmod(0o600);
        stat = await handle.stat();
        if (!stat.isFile() || stat.mode !== 0o600) {
          throw new Error("Grant temporary file must be a regular file with mode 0600");
        }
      } catch (error) {
        throw new GrantFsError("chmod", "uncommitted", error);
      }

      try {
        await handle.writeFile(data);
      } catch (error) {
        throw new GrantFsError("write", "uncommitted", error);
      }
      try {
        await handle.sync();
      } catch (error) {
        throw new GrantFsError("file_sync", "uncommitted", error);
      }
    } catch (error) {
      preparationFailure = error;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch (error) {
          const closeFailure = new GrantFsError("temp_close", "uncommitted", error);
          preparationFailure = combineUncommittedFailures(
            preparationFailure,
            closeFailure,
            "Grant temporary file preparation and close failed",
          );
        }
      }
    }

    if (preparationFailure) {
      if (tempOpened) await this.cleanupTemporaryPath(tempPath, preparationFailure);
      throw preparationFailure;
    }

    try {
      await this.rename(tempPath, filePath);
    } catch (error) {
      const failure = new GrantFsError("rename", "uncommitted", error);
      await this.cleanupTemporaryPath(tempPath, failure);
      throw failure;
    }

    try {
      await this.syncDirectory(path.dirname(filePath));
    } catch (error) {
      throw new GrantFsError("parent_sync", "commit_unknown", error);
    }
  }

  private async cleanupTemporaryPath(tempPath: string, primary: unknown): Promise<void> {
    try {
      await this.unlink(tempPath);
    } catch (error) {
      if (isFileNotFound(error)) return;
      const combined = new AggregateError([primary, error], "Grant temporary file cleanup failed", {
        cause: primary,
      });
      if (primary instanceof GrantFsError)
        throw new GrantFsError(primary.phase, "uncommitted", combined);
      throw new GrantFsError("temp_close", "uncommitted", combined);
    }
  }
}

export function grantNoFollowFlag(): number {
  const flag = constants.O_NOFOLLOW;
  if (typeof flag !== "number" || flag === 0) throw new GrantNoFollowUnavailableError();
  return flag;
}

export function grantReadOpenFlags(): number {
  return constants.O_RDONLY | grantNoFollowFlag();
}

export function grantTemporaryOpenFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | grantNoFollowFlag();
}

export function grantDirectoryOpenFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | grantNoFollowFlag();
}

export function grantTemporaryPath(filePath: string, suffix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) throw new Error("Invalid grant temporary suffix");
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
}

function appendFailure(primary: unknown, secondary: unknown, message: string): unknown {
  if (!primary) return secondary;
  return new AggregateError([primary, secondary], message, { cause: primary });
}

function combineUncommittedFailures(
  primary: unknown,
  secondary: GrantFsError,
  message: string,
): GrantFsError {
  if (!primary) return secondary;
  const phase = primary instanceof GrantFsError ? primary.phase : secondary.phase;
  return new GrantFsError(
    phase,
    "uncommitted",
    new AggregateError([primary, secondary], message, { cause: primary }),
  );
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
