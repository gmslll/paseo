import { z } from "zod";

import { ManagedRuntimeStatusSchema } from "./managed-runtimes.js";
import { NodeIdSchema } from "./messages.js";

// Local transport plane contracts from ADR-0038. The existing WebSocket stays the compatibility
// transport; these planes are additive and gated by server_info features.

export const LOCAL_PLANE_NAMES = ["control", "data", "terminal", "probe"] as const;
export const LocalPlaneNameSchema = z.enum(LOCAL_PLANE_NAMES);
export type LocalPlaneName = z.infer<typeof LocalPlaneNameSchema>;

export const LOCAL_PLANE_UPGRADE_PROTOCOLS = {
  control: "paseo-ndjson/1",
  terminal: "paseo-terminal/1",
  data: "paseo-data/1",
} as const;

export const LOCAL_PLANE_RUN_DIRECTORY = "run";
export const LOCAL_PLANE_MANIFEST_FILE = "daemon.json";
export const LOCAL_PLANE_TOKEN_FILE = "local-token";
export const LOCAL_PLANE_TOKEN_HEADER = "x-paseo-local-token";
export const LOCAL_PLANE_ATTACH_TOKEN_HEADER = "x-paseo-attach-token";
export const LOCAL_PLANE_ATTACH_TOKEN_TTL_MS = 60_000;
// sockaddr_un.sun_path on macOS holds 104 bytes including the terminator.
export const DARWIN_UNIX_SOCKET_PATH_MAX_BYTES = 104;
// Terminal plane frames reuse terminal opcodes; this opcode carries a JSON terminal message.
export const TERMINAL_PLANE_JSON_OPCODE = 0x40;

export const LOCAL_PLANE_HIGH_WATER_BYTES = {
  control: 8 * 1_048_576,
  terminal: 8 * 1_048_576,
  data: 16 * 1_048_576,
} as const;

export const LOCAL_PLANE_CONNECTION_LIMITS = {
  terminalChannelsPerSession: 1,
  dataChannelsPerSession: 4,
  totalConnections: 64,
} as const;

export function localPlaneSocketFileName(plane: LocalPlaneName): string {
  return `${plane}.sock`;
}

export function localPlanePipePath(input: { homeDigest: string; plane: LocalPlaneName }): string {
  return `\\\\.\\pipe\\paseo-${input.homeDigest}-${input.plane}`;
}

export const LocalPlaneEndpointSchema = z.object({
  transport: z.enum(["unix", "pipe"]),
  path: z.string().min(1),
  protocolVersion: z.number().int().positive(),
});

export const DaemonManifestSchema = z.object({
  schemaVersion: z.literal(1),
  pid: z.number().int().positive(),
  supervisorPid: z.number().int().positive().nullable(),
  serverId: z.string().min(1),
  version: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  listen: z.string().min(1).nullable(),
  desktopManaged: z.boolean().optional(),
  planes: z.object({
    control: LocalPlaneEndpointSchema.optional(),
    data: LocalPlaneEndpointSchema.optional(),
    terminal: LocalPlaneEndpointSchema.optional(),
    probe: LocalPlaneEndpointSchema.optional(),
  }),
});

export const ProbeHealthSchema = z.object({
  status: z.string().min(1),
});

// The probe plane is reachable by any process with socket access, so it carries no Principal,
// Grant, credential, or path-under-home data beyond plane sockets.
export const ProbeStateSchema = z.object({
  pid: z.number().int().positive(),
  serverId: z.string().min(1),
  version: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  uptimeMs: z.number().int().nonnegative(),
  lifecycle: z.string().min(1),
  desktopManaged: z.boolean(),
  planes: z.record(
    z.string(),
    z.object({
      status: z.string().min(1),
      path: z.string().min(1).nullable(),
    }),
  ),
  websocket: z.object({ listen: z.string().min(1).nullable() }),
  relay: z.object({ enabled: z.boolean(), connected: z.boolean() }),
  eventLoopDelayMs: z.object({
    p50: z.number().nonnegative(),
    p99: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  counts: z.object({
    sessions: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
    terminals: z.number().int().nonnegative(),
  }),
  managedRuntimes: z.array(ManagedRuntimeStatusSchema),
  enterprise: z
    .object({
      enabled: z.boolean(),
      managementMode: z.string().min(1),
      nodeId: NodeIdSchema.nullable(),
      nodeStatus: z.string().min(1).nullable(),
      policyAgeMs: z.number().int().nonnegative().nullable(),
      lastHeartbeatAt: z.string().datetime({ offset: true }).nullable(),
    })
    .nullable(),
});

export type LocalPlaneEndpoint = z.infer<typeof LocalPlaneEndpointSchema>;
export type DaemonManifest = z.infer<typeof DaemonManifestSchema>;
export type ProbeState = z.infer<typeof ProbeStateSchema>;
