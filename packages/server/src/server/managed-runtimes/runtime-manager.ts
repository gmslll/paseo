import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import {
  type ManagedRuntimeArtifact,
  type ManagedRuntimeInstallMetadata,
  type ManagedRuntimePin,
  type ManagedRuntimePolicy,
  ManagedRuntimePolicySchema,
  type ManagedRuntimeStatus,
  selectManagedRuntimeArtifact,
} from "@getpaseo/protocol/managed-runtimes";

import type {
  ManagedBinaryResolution,
  ManagedProviderBinary,
  ManagedRuntimeBindings,
} from "./managed-provider-binary.js";
import {
  type ManagedRuntimeArtifactSource,
  installManagedRuntime,
  listInstalledRuntimeVersions,
  readInstalledRuntime,
} from "./runtime-installer.js";
import {
  type ManagedRuntimePaths,
  currentPlatformArch,
  isReservedManagedRuntimeName,
} from "./runtime-paths.js";

export interface ManagedRuntimePolicySource {
  readonly installSource: ManagedRuntimeInstallMetadata["source"];
  current(): ManagedRuntimePolicy | null;
}

export class ManagedRuntimeNotPinnedError extends Error {
  constructor(public readonly runtimeName: string) {
    super(`Managed runtime '${runtimeName}' is not pinned by the current policy`);
    this.name = "ManagedRuntimeNotPinnedError";
  }
}

export class ManagedRuntimeUnsupportedPlatformError extends Error {
  constructor(
    public readonly runtimeName: string,
    public readonly platformArch: string | null,
  ) {
    super(
      `Managed runtime '${runtimeName}' has no artifact for ${platformArch ?? "this platform"}`,
    );
    this.name = "ManagedRuntimeUnsupportedPlatformError";
  }
}

/** Returns null when the file is absent. An invalid policy file throws instead of being ignored. */
export async function loadLocalManagedRuntimePolicy(
  filePath: string,
): Promise<ManagedRuntimePolicy | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return ManagedRuntimePolicySchema.parse(JSON.parse(raw));
}

export function staticManagedRuntimePolicySource(
  policy: ManagedRuntimePolicy | null,
  installSource: ManagedRuntimeInstallMetadata["source"],
): ManagedRuntimePolicySource {
  return { installSource, current: () => policy };
}

/** Standalone artifacts are placed by an administrator as files named by their SHA-256. */
export function createDirectoryArtifactSource(directory: string): ManagedRuntimeArtifactSource {
  return {
    open: async (artifact) => createReadStream(path.join(directory, artifact.sha256)),
  };
}

export interface ManagedRuntimeManagerOptions {
  paths: ManagedRuntimePaths;
  policySource: ManagedRuntimePolicySource;
  artifactSource: ManagedRuntimeArtifactSource;
  logger: Logger;
  platformArch?: string | null;
  now?: () => Date;
}

export class ManagedRuntimeManager implements ManagedRuntimeBindings {
  private readonly platformArch: string | null;
  private readonly installs = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly options: ManagedRuntimeManagerOptions) {
    this.platformArch =
      options.platformArch === undefined ? currentPlatformArch() : options.platformArch;
  }

  bindingFor(providerId: string): ManagedProviderBinary {
    return { resolve: () => this.resolveProvider(providerId) };
  }

  async resolveProvider(providerId: string): Promise<ManagedBinaryResolution> {
    const policy = this.options.policySource.current();
    const pin = policy?.runtimes.find((candidate) => candidate.providerIds.includes(providerId));
    if (!policy || !pin) {
      return { kind: "unmanaged" };
    }
    const unavailable = {
      kind: "unavailable" as const,
      runtimeName: pin.runtimeName,
      pathFallback: policy.pathFallback,
      allowCommandOverride: policy.allowCommandOverride,
    };
    const artifact = this.artifactFor(pin);
    if (!artifact) {
      return { ...unavailable, reason: "unsupported_platform" };
    }
    const installed = await readInstalledRuntime({ paths: this.options.paths, pin, artifact });
    if (installed.state === "installed") {
      return {
        kind: "installed",
        runtimeName: pin.runtimeName,
        version: pin.version,
        commandPath: installed.commandPath,
        allowCommandOverride: policy.allowCommandOverride,
      };
    }
    if (installed.state === "mismatch") {
      return { ...unavailable, reason: "mismatch" };
    }
    if (policy.autoInstall) {
      this.startInstall(policy, pin, artifact).catch(() => undefined);
    }
    return {
      ...unavailable,
      reason: this.installs.has(pin.runtimeName) ? "installing" : "not_installed",
    };
  }

  async install(runtimeName: string): Promise<ManagedRuntimeStatus> {
    const policy = this.options.policySource.current();
    const pin = policy?.runtimes.find((candidate) => candidate.runtimeName === runtimeName);
    if (!policy || !pin) {
      throw new ManagedRuntimeNotPinnedError(runtimeName);
    }
    const artifact = this.artifactFor(pin);
    if (!artifact) {
      throw new ManagedRuntimeUnsupportedPlatformError(runtimeName, this.platformArch);
    }
    await this.startInstall(policy, pin, artifact);
    return this.statusFor(pin);
  }

  async status(): Promise<ManagedRuntimeStatus[]> {
    const policy = this.options.policySource.current();
    if (!policy) return [];
    return Promise.all(policy.runtimes.map((pin) => this.statusFor(pin)));
  }

  /** Resolves once every install started so far has settled. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled(this.installs.values());
  }

  private artifactFor(pin: ManagedRuntimePin): ManagedRuntimeArtifact | null {
    if (!this.platformArch || isReservedManagedRuntimeName(pin.runtimeName)) return null;
    return selectManagedRuntimeArtifact(pin, this.platformArch);
  }

  private async statusFor(pin: ManagedRuntimePin): Promise<ManagedRuntimeStatus> {
    const base = {
      runtimeName: pin.runtimeName,
      pinnedVersion: pin.version,
      installedVersions: isReservedManagedRuntimeName(pin.runtimeName)
        ? []
        : await listInstalledRuntimeVersions(this.options.paths, pin.runtimeName),
    };
    if (this.installs.has(pin.runtimeName)) {
      return { ...base, activeVersion: null, status: "installing", commandPath: null, error: null };
    }
    const artifact = this.artifactFor(pin);
    if (!artifact) {
      return {
        ...base,
        activeVersion: null,
        status: "failed",
        commandPath: null,
        error: new ManagedRuntimeUnsupportedPlatformError(pin.runtimeName, this.platformArch)
          .message,
      };
    }
    const installed = await readInstalledRuntime({ paths: this.options.paths, pin, artifact });
    if (installed.state === "installed") {
      return {
        ...base,
        activeVersion: pin.version,
        status: "installed",
        commandPath: installed.commandPath,
        error: null,
      };
    }
    const failure = this.failures.get(pin.runtimeName) ?? null;
    return {
      ...base,
      activeVersion: null,
      status: failure ? "failed" : uninstalledStatus(installed.state),
      commandPath: null,
      error: failure,
    };
  }

  private startInstall(
    policy: ManagedRuntimePolicy,
    pin: ManagedRuntimePin,
    artifact: ManagedRuntimeArtifact,
  ): Promise<void> {
    const inFlight = this.installs.get(pin.runtimeName);
    if (inFlight) return inFlight;
    const task = this.runInstall(policy, pin, artifact).finally(() => {
      this.installs.delete(pin.runtimeName);
    });
    this.installs.set(pin.runtimeName, task);
    return task;
  }

  private async runInstall(
    policy: ManagedRuntimePolicy,
    pin: ManagedRuntimePin,
    artifact: ManagedRuntimeArtifact,
  ): Promise<void> {
    try {
      await installManagedRuntime({
        paths: this.options.paths,
        pin,
        artifact,
        source: this.options.artifactSource,
        installSource: this.options.policySource.installSource,
        policyVersion: policy.policyVersion,
        now: this.options.now,
      });
      this.failures.delete(pin.runtimeName);
    } catch (error) {
      this.failures.set(pin.runtimeName, error instanceof Error ? error.message : String(error));
      this.options.logger.warn(
        { err: error, runtimeName: pin.runtimeName, version: pin.version },
        "Managed runtime install failed",
      );
      throw error;
    }
  }
}

function uninstalledStatus(state: "mismatch" | "missing"): "mismatch" | "not_installed" {
  return state === "mismatch" ? "mismatch" : "not_installed";
}
