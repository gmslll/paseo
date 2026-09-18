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

// Control plane framing, `paseo-ndjson/1`: one UTF-8 JSON value per line. A text WebSocket frame is
// its existing JSON unchanged; binary frames and closes use the reserved line types below, which no
// WebSocket message type can collide with.

export const CONTROL_PLANE_BINARY_LINE_TYPE = "paseo.binary";
export const CONTROL_PLANE_CLOSE_LINE_TYPE = "paseo.close";
export const CONTROL_PLANE_MAX_LINE_BYTES = LOCAL_PLANE_HIGH_WATER_BYTES.control;

export const ControlPlaneBinaryLineSchema = z.object({
  type: z.literal(CONTROL_PLANE_BINARY_LINE_TYPE),
  data: z.string(),
});

export const ControlPlaneCloseLineSchema = z.object({
  type: z.literal(CONTROL_PLANE_CLOSE_LINE_TYPE),
  code: z.number().int().min(1000).max(4999),
  reason: z.string(),
});

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map([...BASE64_ALPHABET].map((character, index) => [character, index]));

export function encodeBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.byteLength ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.byteLength ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return output;
}

function base64Padding(text: string): number {
  if (text.endsWith("==")) return 2;
  return text.endsWith("=") ? 1 : 0;
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error("base64 length must be a multiple of 4");
  const padding = base64Padding(text);
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let index = 0; index < text.length; index += 4) {
    let triple = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      const character = text[index + offset] ?? "";
      const value = character === "=" ? 0 : BASE64_VALUES.get(character);
      if (value === undefined) throw new Error("invalid base64 character");
      triple = (triple << 6) | value;
    }
    for (let shift = 16; shift >= 0 && written < bytes.byteLength; shift -= 8) {
      bytes[written] = (triple >> shift) & 255;
      written += 1;
    }
  }
  return bytes;
}

export function encodeControlPlaneBinaryLine(bytes: Uint8Array): string {
  return JSON.stringify({ type: CONTROL_PLANE_BINARY_LINE_TYPE, data: encodeBase64(bytes) });
}

export function encodeControlPlaneCloseLine(input: { code: number; reason: string }): string {
  return JSON.stringify({
    type: CONTROL_PLANE_CLOSE_LINE_TYPE,
    code: input.code,
    reason: input.reason,
  });
}

export type ControlPlaneLine =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array }
  | { kind: "close"; code: number; reason: string };

// Reserved lines are produced by the encoders above, so their key order is fixed and a prefix check
// keeps ordinary messages from being parsed twice.
const BINARY_LINE_PREFIX = `{"type":"${CONTROL_PLANE_BINARY_LINE_TYPE}"`;
const CLOSE_LINE_PREFIX = `{"type":"${CONTROL_PLANE_CLOSE_LINE_TYPE}"`;

export function classifyControlPlaneLine(line: string): ControlPlaneLine {
  if (line.startsWith(BINARY_LINE_PREFIX)) {
    const parsed = ControlPlaneBinaryLineSchema.parse(JSON.parse(line));
    return { kind: "binary", bytes: decodeBase64(parsed.data) };
  }
  if (line.startsWith(CLOSE_LINE_PREFIX)) {
    const parsed = ControlPlaneCloseLineSchema.parse(JSON.parse(line));
    return { kind: "close", code: parsed.code, reason: parsed.reason };
  }
  return { kind: "text", text: line };
}

export class NdjsonLineTooLargeError extends Error {
  constructor(public readonly maxLineBytes: number) {
    super(`control plane line exceeds ${maxLineBytes} bytes`);
    this.name = "NdjsonLineTooLargeError";
  }
}

/**
 * Splits a byte stream into lines. A line longer than the limit throws and clears the buffer; the
 * stream cannot resynchronize and the connection must close. A trailing carriage return is dropped.
 */
export class NdjsonLineDecoder {
  private readonly maxLineBytes: number;
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(options: { maxLineBytes: number }) {
    this.maxLineBytes = options.maxLineBytes;
  }

  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
      this.append(chunk.subarray(start, index));
      lines.push(this.takeLine());
      start = index + 1;
    }
    this.append(chunk.subarray(start));
    return lines;
  }

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.pendingBytes + bytes.byteLength > this.maxLineBytes) {
      this.pending = [];
      this.pendingBytes = 0;
      throw new NdjsonLineTooLargeError(this.maxLineBytes);
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
  }

  private takeLine(): string {
    const bytes = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    const end =
      bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0d
        ? bytes.byteLength - 1
        : bytes.byteLength;
    return this.textDecoder.decode(bytes.subarray(0, end));
  }
}
