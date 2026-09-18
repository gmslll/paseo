import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  MANAGED_RUNTIME_MAX_ARTIFACT_BYTES,
  type ManagedRuntimeArtifact,
  ManagedRuntimeArtifactSchema,
  ManagedRuntimeNameSchema,
  type ManagedRuntimePinUpdate,
  type ManagedRuntimePolicy,
  ManagedRuntimePolicySchema,
  type ManagedRuntimePolicySettingsUpdate,
  ManagedRuntimeVersionSchema,
  Sha256HexSchema,
} from "@getpaseo/protocol/managed-runtimes";

import { transaction, type SqliteDatabase } from "./sqlite.js";

// Company-pinned Agent runtimes (ADR-0039): uploaded artifacts, pins, and the policy nodes install.

export const RUNTIME_DISTRIBUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_artifacts (
  sha256 TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  runtime_name TEXT NOT NULL,
  version TEXT NOT NULL,
  platform_arch TEXT NOT NULL,
  file_name TEXT NOT NULL,
  archive_format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  command TEXT NOT NULL,
  launcher TEXT NOT NULL,
  min_node_version TEXT,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  UNIQUE (organization_id, runtime_name, version, platform_arch)
);
CREATE TABLE IF NOT EXISTS runtime_pins (
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  runtime_name TEXT NOT NULL,
  version TEXT NOT NULL,
  provider_ids_json TEXT NOT NULL,
  compatible_sdk_range TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, runtime_name)
);
CREATE TABLE IF NOT EXISTS runtime_policy_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(organization_id),
  policy_version INTEGER NOT NULL,
  path_fallback TEXT NOT NULL,
  allow_command_override INTEGER NOT NULL,
  auto_install INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

interface Row {
  readonly [key: string]: unknown;
}

interface PolicySettings {
  policyVersion: number;
  pathFallback: "allow" | "forbid";
  allowCommandOverride: boolean;
  autoInstall: boolean;
}

// A pin with no explicit settings still lets unmanaged binaries run until an administrator
// tightens the fallback rule.
const DEFAULT_SETTINGS: PolicySettings = {
  policyVersion: 0,
  pathFallback: "allow",
  allowCommandOverride: false,
  autoInstall: true,
};

const ArtifactMetadataSchema = ManagedRuntimeArtifactSchema.omit({ sizeBytes: true });

export interface RuntimeArtifactUpload {
  runtimeName: string;
  version: string;
  platformArch: string;
  fileName: string;
  archiveFormat: string;
  command: string;
  launcher: string;
  minNodeVersion?: string;
  sha256: string;
  body: Readable;
}

export interface RuntimeArtifactRecord extends ManagedRuntimeArtifact {
  runtimeName: string;
  version: string;
  uploadedAt: string;
}

export interface RuntimeDistributionStoreOptions {
  database: SqliteDatabase;
  organizationId: string;
  /** Null when the plane has no persistent storage, such as an in-memory database. */
  artifactDirectory: string | null;
  nowIso: () => string;
  maxArtifactBytes?: number;
}

export class RuntimeDistributionStore {
  constructor(private readonly options: RuntimeDistributionStoreOptions) {}

  async storeArtifact(
    input: RuntimeArtifactUpload & { uploadedBy: string },
  ): Promise<RuntimeArtifactRecord> {
    const directory = this.options.artifactDirectory;
    if (!directory) throw new Error("runtime artifact storage unavailable");
    const runtimeName = ManagedRuntimeNameSchema.parse(input.runtimeName);
    const version = ManagedRuntimeVersionSchema.parse(input.version);
    const metadata = ArtifactMetadataSchema.parse({
      platformArch: input.platformArch,
      fileName: input.fileName,
      archiveFormat: input.archiveFormat,
      sha256: input.sha256,
      command: input.command,
      launcher: input.launcher,
      ...(input.minNodeVersion ? { minNodeVersion: input.minNodeVersion } : {}),
    });
    if (
      this.readArtifactRow(runtimeName, version, metadata.platformArch) ||
      this.readArtifactBySha(metadata.sha256)
    ) {
      throw new Error("runtime artifact already uploaded");
    }

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const partialPath = path.join(
      directory,
      `${metadata.sha256}.${randomBytes(6).toString("hex")}.partial`,
    );
    const finalPath = path.join(directory, metadata.sha256);
    const maxBytes = this.options.maxArtifactBytes ?? MANAGED_RUNTIME_MAX_ARTIFACT_BYTES;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          callback(new Error("runtime artifact exceeds the size limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input.body, meter, createWriteStream(partialPath, { mode: 0o600 }));
      if (hash.digest("hex") !== metadata.sha256) {
        throw new Error("runtime artifact sha256 does not match the declared digest");
      }
      const artifact = ManagedRuntimeArtifactSchema.parse({ ...metadata, sizeBytes });
      await rename(partialPath, finalPath);
      const uploadedAt = this.options.nowIso();
      try {
        this.options.database
          .prepare(
            "INSERT INTO runtime_artifacts (sha256, organization_id, runtime_name, version, platform_arch, file_name, archive_format, size_bytes, command, launcher, min_node_version, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            artifact.sha256,
            this.options.organizationId,
            runtimeName,
            version,
            artifact.platformArch,
            artifact.fileName,
            artifact.archiveFormat,
            artifact.sizeBytes,
            artifact.command,
            artifact.launcher,
            artifact.minNodeVersion ?? null,
            input.uploadedBy,
            uploadedAt,
          );
      } catch {
        await rm(finalPath, { force: true });
        throw new Error("runtime artifact already uploaded");
      }
      return { ...artifact, runtimeName, version, uploadedAt };
    } finally {
      await rm(partialPath, { force: true });
    }
  }

  listArtifacts(): RuntimeArtifactRecord[] {
    return this.options.database
      .prepare(
        "SELECT * FROM runtime_artifacts WHERE organization_id = ? ORDER BY runtime_name, version, platform_arch",
      )
      .all(this.options.organizationId)
      .map((value) => {
        const row = value as Row;
        return Object.assign(artifactFromRow(row), {
          runtimeName: String(row.runtime_name),
          version: String(row.version),
          uploadedAt: String(row.uploaded_at),
        });
      });
  }

  currentPolicy(): ManagedRuntimePolicy | null {
    const settings = this.readSettings();
    const pins = this.options.database
      .prepare("SELECT * FROM runtime_pins WHERE organization_id = ? ORDER BY runtime_name")
      .all(this.options.organizationId) as Row[];
    if (!settings && pins.length === 0) return null;
    const effective = settings ?? DEFAULT_SETTINGS;
    return ManagedRuntimePolicySchema.parse({
      schemaVersion: 1,
      policyVersion: effective.policyVersion,
      pathFallback: effective.pathFallback,
      allowCommandOverride: effective.allowCommandOverride,
      autoInstall: effective.autoInstall,
      runtimes: pins.map((pin) => ({
        runtimeName: String(pin.runtime_name),
        version: String(pin.version),
        providerIds: JSON.parse(String(pin.provider_ids_json)),
        compatibleSdkRange:
          typeof pin.compatible_sdk_range === "string" ? pin.compatible_sdk_range : undefined,
        artifacts: this.artifactsFor(String(pin.runtime_name), String(pin.version)),
      })),
    });
  }

  setPin(
    runtimeName: string,
    input: ManagedRuntimePinUpdate & { updatedBy: string },
  ): ManagedRuntimePolicy {
    const name = ManagedRuntimeNameSchema.parse(runtimeName);
    transaction(this.options.database, () => {
      const settings = this.readSettings() ?? DEFAULT_SETTINGS;
      assertPolicyVersion(settings.policyVersion, input.expectedPolicyVersion);
      if (this.artifactsFor(name, input.version).length === 0) {
        throw new Error("runtime artifact unavailable for the pinned version");
      }
      const updatedAt = this.options.nowIso();
      this.options.database
        .prepare(
          "INSERT INTO runtime_pins (organization_id, runtime_name, version, provider_ids_json, compatible_sdk_range, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id, runtime_name) DO UPDATE SET version = excluded.version, provider_ids_json = excluded.provider_ids_json, compatible_sdk_range = excluded.compatible_sdk_range, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
        )
        .run(
          this.options.organizationId,
          name,
          input.version,
          JSON.stringify(input.providerIds),
          input.compatibleSdkRange ?? null,
          input.updatedBy,
          updatedAt,
        );
      this.writeSettings(
        { ...settings, policyVersion: settings.policyVersion + 1 },
        input.updatedBy,
        updatedAt,
      );
    });
    return this.currentPolicy()!;
  }

  updateSettings(
    input: ManagedRuntimePolicySettingsUpdate & { updatedBy: string },
  ): ManagedRuntimePolicy {
    transaction(this.options.database, () => {
      const settings = this.readSettings() ?? DEFAULT_SETTINGS;
      assertPolicyVersion(settings.policyVersion, input.expectedPolicyVersion);
      this.writeSettings(
        {
          policyVersion: settings.policyVersion + 1,
          pathFallback: input.pathFallback,
          allowCommandOverride: input.allowCommandOverride,
          autoInstall: input.autoInstall,
        },
        input.updatedBy,
        this.options.nowIso(),
      );
    });
    return this.currentPolicy()!;
  }

  /** The stored file for an artifact this organization uploaded, or null. */
  artifactFilePath(sha256: string): string | null {
    const directory = this.options.artifactDirectory;
    if (!directory || !Sha256HexSchema.safeParse(sha256).success) return null;
    if (!this.readArtifactBySha(sha256)) return null;
    const filePath = path.join(directory, sha256);
    return existsSync(filePath) ? filePath : null;
  }

  private artifactsFor(runtimeName: string, version: string): ManagedRuntimeArtifact[] {
    return this.options.database
      .prepare(
        "SELECT * FROM runtime_artifacts WHERE organization_id = ? AND runtime_name = ? AND version = ? ORDER BY platform_arch",
      )
      .all(this.options.organizationId, runtimeName, version)
      .map((value) => artifactFromRow(value as Row));
  }

  private readArtifactRow(runtimeName: string, version: string, platformArch: string) {
    return this.options.database
      .prepare(
        "SELECT sha256 FROM runtime_artifacts WHERE organization_id = ? AND runtime_name = ? AND version = ? AND platform_arch = ?",
      )
      .get(this.options.organizationId, runtimeName, version, platformArch);
  }

  private readArtifactBySha(sha256: string) {
    return this.options.database
      .prepare("SELECT sha256 FROM runtime_artifacts WHERE organization_id = ? AND sha256 = ?")
      .get(this.options.organizationId, sha256);
  }

  private readSettings(): PolicySettings | null {
    const row = this.options.database
      .prepare("SELECT * FROM runtime_policy_settings WHERE organization_id = ?")
      .get(this.options.organizationId) as Row | undefined;
    if (!row) return null;
    return {
      policyVersion: Number(row.policy_version),
      pathFallback: row.path_fallback === "forbid" ? "forbid" : "allow",
      allowCommandOverride: Number(row.allow_command_override) === 1,
      autoInstall: Number(row.auto_install) === 1,
    };
  }

  private writeSettings(settings: PolicySettings, updatedBy: string, updatedAt: string): void {
    this.options.database
      .prepare(
        "INSERT INTO runtime_policy_settings (organization_id, policy_version, path_fallback, allow_command_override, auto_install, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id) DO UPDATE SET policy_version = excluded.policy_version, path_fallback = excluded.path_fallback, allow_command_override = excluded.allow_command_override, auto_install = excluded.auto_install, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .run(
        this.options.organizationId,
        settings.policyVersion,
        settings.pathFallback,
        settings.allowCommandOverride ? 1 : 0,
        settings.autoInstall ? 1 : 0,
        updatedBy,
        updatedAt,
      );
  }
}

function assertPolicyVersion(current: number, expected: number): void {
  if (current !== expected) {
    throw new Error(`runtime policy version conflict: current ${current}, expected ${expected}`);
  }
}

function artifactFromRow(row: Row): ManagedRuntimeArtifact {
  return ManagedRuntimeArtifactSchema.parse({
    platformArch: row.platform_arch,
    fileName: row.file_name,
    archiveFormat: row.archive_format,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    command: row.command,
    launcher: row.launcher,
    ...(typeof row.min_node_version === "string" ? { minNodeVersion: row.min_node_version } : {}),
  });
}
