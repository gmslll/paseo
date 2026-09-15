import path from "node:path";

import {
  MANAGED_RUNTIME_BIN_DIRECTORY,
  MANAGED_RUNTIME_DIRECTORY,
  MANAGED_RUNTIME_DOWNLOADS_DIRECTORY,
  MANAGED_RUNTIME_LOCAL_POLICY_FILE,
} from "@getpaseo/protocol/managed-runtimes";

// Layout from ADR-0039. Runtime names share the root with the bin and artifacts directories, so
// those names are reserved.
const ARTIFACTS_DIRECTORY = "artifacts";
const RESERVED_RUNTIME_NAMES: ReadonlySet<string> = new Set([
  MANAGED_RUNTIME_BIN_DIRECTORY,
  ARTIFACTS_DIRECTORY,
]);

export interface ManagedRuntimePaths {
  readonly root: string;
  readonly downloads: string;
  readonly bin: string;
  readonly artifacts: string;
  readonly localPolicy: string;
}

export function managedRuntimePaths(paseoHome: string): ManagedRuntimePaths {
  const root = path.join(paseoHome, MANAGED_RUNTIME_DIRECTORY);
  return Object.freeze({
    root,
    downloads: path.join(root, MANAGED_RUNTIME_DOWNLOADS_DIRECTORY),
    bin: path.join(root, MANAGED_RUNTIME_BIN_DIRECTORY),
    artifacts: path.join(root, ARTIFACTS_DIRECTORY),
    localPolicy: path.join(paseoHome, MANAGED_RUNTIME_LOCAL_POLICY_FILE),
  });
}

export function isReservedManagedRuntimeName(runtimeName: string): boolean {
  return RESERVED_RUNTIME_NAMES.has(runtimeName);
}

export function runtimeVersionsDirectory(paths: ManagedRuntimePaths, runtimeName: string): string {
  if (isReservedManagedRuntimeName(runtimeName)) {
    throw new Error(`Managed runtime name '${runtimeName}' is reserved`);
  }
  return path.join(paths.root, runtimeName);
}

export function runtimeInstallDirectory(
  paths: ManagedRuntimePaths,
  input: { runtimeName: string; version: string; platformArch: string },
): string {
  return path.join(
    runtimeVersionsDirectory(paths, input.runtimeName),
    input.version,
    input.platformArch,
  );
}

export function runtimeCommandLinkPath(paths: ManagedRuntimePaths, runtimeName: string): string {
  return path.join(paths.bin, runtimeName);
}

export function currentPlatformArch(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    return null;
  }
  if (arch !== "arm64" && arch !== "x64") {
    return null;
  }
  return `${platform}-${arch}`;
}
