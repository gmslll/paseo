import { z } from "zod";

// Managed Agent runtime contracts from ADR-0039. Schemas read by nodes are non-strict so a newer
// management plane never breaks an older node.

const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const RUNTIME_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PLATFORM_ARCH_PATTERN = /^(?:darwin|linux|win32)-(?:arm64|x64)$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_FILE_NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._@+-]{1,255}$/;
// Relative, slash-separated, with no empty or ".." segment.
const RUNTIME_COMMAND_PATTERN =
  /^(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

export const KNOWN_MANAGED_RUNTIMES = ["claude-code", "codex"] as const;

export const MANAGED_RUNTIME_DIRECTORY = "runtimes";
export const MANAGED_RUNTIME_DOWNLOADS_DIRECTORY = ".downloads";
export const MANAGED_RUNTIME_BIN_DIRECTORY = "bin";
export const MANAGED_RUNTIME_METADATA_FILE = "metadata.json";
export const MANAGED_RUNTIME_COMPLETE_MARKER = ".paseo-complete";
export const MANAGED_RUNTIME_LOCAL_POLICY_FILE = "runtime-policy.json";
export const MANAGED_RUNTIME_MAX_ARTIFACT_BYTES = 512 * 1_048_576;

export const ManagedRuntimeNameSchema = z.string().regex(RUNTIME_NAME_PATTERN);
export const ManagedRuntimeVersionSchema = z.string().regex(RUNTIME_VERSION_PATTERN);
export const PlatformArchSchema = z.string().regex(PLATFORM_ARCH_PATTERN);
export const Sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);
export const ManagedRuntimeCommandSchema = z.string().max(256).regex(RUNTIME_COMMAND_PATTERN);

export const ManagedRuntimeArtifactSchema = z.object({
  platformArch: PlatformArchSchema,
  fileName: z.string().regex(ARTIFACT_FILE_NAME_PATTERN),
  archiveFormat: z.enum(["tar.gz", "zip", "raw"]),
  sha256: Sha256HexSchema,
  sizeBytes: z.number().int().positive().max(MANAGED_RUNTIME_MAX_ARTIFACT_BYTES),
  command: ManagedRuntimeCommandSchema,
  launcher: z.enum(["exec", "node"]),
  minNodeVersion: z.string().min(1).optional(),
});

export const ManagedRuntimePinSchema = z.object({
  runtimeName: ManagedRuntimeNameSchema,
  version: ManagedRuntimeVersionSchema,
  providerIds: z.array(z.string().min(1)).min(1),
  compatibleSdkRange: z.string().min(1).optional(),
  artifacts: z.array(ManagedRuntimeArtifactSchema).min(1),
});

export const ManagedRuntimePolicySchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.number().int().nonnegative(),
  runtimes: z.array(ManagedRuntimePinSchema),
  pathFallback: z.enum(["allow", "forbid"]),
  allowCommandOverride: z.boolean(),
  autoInstall: z.boolean(),
});

export const ManagedRuntimeInstallMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeName: ManagedRuntimeNameSchema,
  runtimeVersion: ManagedRuntimeVersionSchema,
  platformArch: PlatformArchSchema,
  command: ManagedRuntimeCommandSchema,
  archiveSha256: Sha256HexSchema,
  archiveSize: z.number().int().positive(),
  minNodeVersion: z.string().min(1).optional(),
  installedAt: z.string().datetime({ offset: true }),
  source: z.enum(["management_plane", "local_policy"]),
  policyVersion: z.number().int().nonnegative(),
});

export const ManagedRuntimeStatusSchema = z.object({
  runtimeName: ManagedRuntimeNameSchema,
  pinnedVersion: ManagedRuntimeVersionSchema.nullable(),
  activeVersion: ManagedRuntimeVersionSchema.nullable(),
  installedVersions: z.array(ManagedRuntimeVersionSchema),
  status: z.enum(["not_pinned", "not_installed", "installing", "installed", "mismatch", "failed"]),
  commandPath: z.string().min(1).nullable(),
  error: z.string().min(1).nullable(),
});

export type ManagedRuntimeArtifact = z.infer<typeof ManagedRuntimeArtifactSchema>;
export type ManagedRuntimePin = z.infer<typeof ManagedRuntimePinSchema>;
export type ManagedRuntimePolicy = z.infer<typeof ManagedRuntimePolicySchema>;
export type ManagedRuntimeInstallMetadata = z.infer<typeof ManagedRuntimeInstallMetadataSchema>;
export type ManagedRuntimeStatus = z.infer<typeof ManagedRuntimeStatusSchema>;

export function selectManagedRuntimeArtifact(
  pin: ManagedRuntimePin,
  platformArch: string,
): ManagedRuntimeArtifact | null {
  return pin.artifacts.find((artifact) => artifact.platformArch === platformArch) ?? null;
}

export function managedRuntimeMetadataMatchesPin(input: {
  metadata: ManagedRuntimeInstallMetadata;
  pin: ManagedRuntimePin;
  artifact: ManagedRuntimeArtifact;
}): boolean {
  const { metadata, pin, artifact } = input;
  return (
    metadata.runtimeName === pin.runtimeName &&
    metadata.runtimeVersion === pin.version &&
    metadata.platformArch === artifact.platformArch &&
    metadata.archiveSha256 === artifact.sha256 &&
    metadata.archiveSize === artifact.sizeBytes &&
    metadata.command === artifact.command
  );
}
