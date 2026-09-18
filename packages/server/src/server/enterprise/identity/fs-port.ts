import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export interface IdentityRegistryFsStat {
  isFile(): boolean;
  isDirectory(): boolean;
  mode: number;
}

export interface IdentityRegistryFsPort {
  readonly noFollowFlag: number;
  mkdir(path: string, mode: number): void;
  open(path: string, flags: number, mode?: number): number;
  close(fd: number): void;
  read(fd: number): string;
  write(fd: number, data: string): void;
  fstat(fd: number): IdentityRegistryFsStat;
  fchmod(fd: number, mode: number): void;
  fsync(fd: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export const nodeIdentityRegistryFs: IdentityRegistryFsPort = {
  noFollowFlag: typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0,
  mkdir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
  open: openSync,
  close: closeSync,
  read: (fd) => readFileSync(fd, "utf8"),
  write: (fd, data) => writeFileSync(fd, data),
  fstat: fstatSync,
  fchmod: fchmodSync,
  fsync: fsyncSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export const IDENTITY_NOFOLLOW = nodeIdentityRegistryFs.noFollowFlag;
