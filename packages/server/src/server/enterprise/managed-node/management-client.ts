import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { request as httpsRequest } from "node:https";

import {
  ManagedAuditIngestResponseSchema,
  ManagedAuditStateResponseSchema,
  ManagedGlobalLeaseSchema,
  ManagedNodeEnrollmentResponseSchema,
  ManagedNodeHeartbeatSchema,
  ManagedNodePolicyResponseSchema,
  ManagedNodeSchema,
  ManagedNodeShutdownSchema,
  ManagedPlacementSchema,
  ManagedPlacementSnapshotResponseSchema,
  type ManagedAuditIngestResponse,
  type ManagedAuditStateResponse,
  type ManagedAuditInput,
  type ManagedGlobalLease,
  type ManagedNode,
  type ManagedNodeHeartbeat,
  type ManagedNodePolicyEntry,
  type ManagedPlacement,
  type ManagedPlacementRegistration,
} from "@getpaseo/protocol/enterprise-management";
import type {
  FencedLease,
  LeaseAcquireInput,
  LeaseCoordinator,
  LeaseReleaseInput,
  LeaseRenewInput,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

import {
  createManagedNodeRelationship,
  generateManagedNodeKeyPair,
  normalizeManagementOrigin,
  writeManagedNodeRelationship,
  type ManagedNodeRelationship,
} from "./relationship-store.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SIGNATURE_MAX_SKEW_MS = 60_000;

const ErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string().min(1), message: z.string().min(1).max(512) }).strict(),
  })
  .strict();

const HeartbeatResponseSchema = z.object({ node: ManagedNodeSchema }).strict();
const PlacementResponseSchema = z.object({ placement: ManagedPlacementSchema }).strict();
const LeaseResponseSchema = z.object({ lease: ManagedGlobalLeaseSchema }).strict();
const LeaseReleaseResponseSchema = z.object({ released: z.boolean() }).strict();

export class ManagementPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagementPlaneRequestError";
  }
}

export interface ManagedNodeClientOptions {
  readonly relationship: ManagedNodeRelationship;
  readonly caCertificate: string | Buffer;
  readonly requestTimeoutMs?: number;
  readonly clock?: { readonly nowMs: () => number };
}

export class ManagedNodeControlPlaneClient {
  readonly relationship: ManagedNodeRelationship;
  private readonly caCertificate: string | Buffer;
  private readonly requestTimeoutMs: number;
  private readonly clock: { readonly nowMs: () => number };
  private policy = new Map<string, ManagedNodePolicyEntry>();
  private policyUpdatedAtMs = -Infinity;

  constructor(options: ManagedNodeClientOptions) {
    this.relationship = createManagedNodeRelationship(options.relationship);
    this.caCertificate = options.caCertificate;
    this.requestTimeoutMs = parseRequestTimeout(options.requestTimeoutMs);
    this.clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async heartbeat(heartbeat: ManagedNodeHeartbeat): Promise<ManagedNode> {
    const canonical = ManagedNodeHeartbeatSchema.parse(structuredClone(heartbeat));
    if (canonical.paseoServerId !== this.relationship.node.paseoServerId) {
      throw new Error("heartbeat server identity mismatch");
    }
    return (
      await this.signedRequest("POST", "/v1/node/heartbeat", canonical, HeartbeatResponseSchema)
    ).node;
  }

  async shutdown(input: {
    readonly bootId: string;
    readonly paseoServerId: string;
  }): Promise<ManagedNode> {
    const shutdown = ManagedNodeShutdownSchema.parse(structuredClone(input));
    if (shutdown.paseoServerId !== this.relationship.node.paseoServerId) {
      throw new Error("shutdown server identity mismatch");
    }
    return (
      await this.signedRequest("POST", "/v1/node/shutdown", shutdown, HeartbeatResponseSchema)
    ).node;
  }

  async refreshPolicy(): Promise<readonly ManagedNodePolicyEntry[]> {
    const result = await this.signedRequest(
      "GET",
      "/v1/node/policy",
      undefined,
      ManagedNodePolicyResponseSchema,
    );
    const next = new Map<string, ManagedNodePolicyEntry>();
    for (const entry of result.principals) {
      if (next.has(entry.principalId)) throw new Error("duplicate principal policy");
      next.set(entry.principalId, Object.freeze({ ...entry }));
    }
    this.policy = next;
    this.policyUpdatedAtMs = this.clock.nowMs();
    return Object.freeze([...next.values()]);
  }

  currentPolicy(principalId: string): ManagedNodePolicyEntry | null {
    const entry = this.policy.get(principalId);
    return entry ? Object.freeze({ ...entry }) : null;
  }

  policyAgeMs(): number {
    return Math.max(0, this.clock.nowMs() - this.policyUpdatedAtMs);
  }

  async registerPlacement(input: ManagedPlacementRegistration): Promise<ManagedPlacement> {
    return (await this.signedRequest("POST", "/v1/node/placements", input, PlacementResponseSchema))
      .placement;
  }

  async synchronizePlacements(
    placements: readonly ManagedPlacementRegistration[],
  ): Promise<readonly ManagedPlacement[]> {
    return (
      await this.signedRequest(
        "PUT",
        "/v1/node/placements",
        { placements: structuredClone(placements) },
        ManagedPlacementSnapshotResponseSchema,
      )
    ).placements;
  }

  async acquireLease(input: LeaseAcquireInput): Promise<ManagedGlobalLease> {
    return (await this.signedRequest("POST", "/v1/node/leases/acquire", input, LeaseResponseSchema))
      .lease;
  }

  async renewLease(input: LeaseRenewInput): Promise<ManagedGlobalLease> {
    return (await this.signedRequest("POST", "/v1/node/leases/renew", input, LeaseResponseSchema))
      .lease;
  }

  async releaseLease(input: LeaseReleaseInput): Promise<boolean> {
    return (
      await this.signedRequest("POST", "/v1/node/leases/release", input, LeaseReleaseResponseSchema)
    ).released;
  }

  async validateLease(input: LeaseReleaseInput): Promise<ManagedGlobalLease> {
    return (
      await this.signedRequest("POST", "/v1/node/leases/validate", input, LeaseResponseSchema)
    ).lease;
  }

  async uploadAudit(events: readonly ManagedAuditInput[]): Promise<ManagedAuditIngestResponse> {
    return this.signedRequest(
      "POST",
      "/v1/node/audit",
      { events: structuredClone(events) },
      ManagedAuditIngestResponseSchema,
    );
  }

  async auditState(): Promise<ManagedAuditStateResponse> {
    return this.signedRequest(
      "GET",
      "/v1/node/audit/state",
      undefined,
      ManagedAuditStateResponseSchema,
    );
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    value: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const body = value === undefined ? "" : JSON.stringify(value);
    const timestampMs = this.clock.nowMs();
    const nonce = randomBytes(18).toString("base64url");
    const signature = signNodeRequest(this.relationship.nodePrivateKeyPem, {
      method,
      path,
      timestampMs,
      nonce,
      body,
    });
    return requestJson({
      baseUrl: this.relationship.managementBaseUrl,
      method,
      path,
      body,
      caCertificate: this.caCertificate,
      timeoutMs: this.requestTimeoutMs,
      headers: {
        "x-paseo-node-id": this.relationship.node.nodeId,
        "x-paseo-node-timestamp": String(timestampMs),
        "x-paseo-node-nonce": nonce,
        "x-paseo-node-signature": signature,
      },
      schema,
    });
  }
}

export interface ManagedLeaseCoordinator extends LeaseCoordinator {
  validate(input: LeaseReleaseInput): Promise<FencedLease>;
}

export function createManagedLeaseCoordinator(
  client: ManagedNodeControlPlaneClient,
): ManagedLeaseCoordinator {
  return Object.freeze({
    acquire(input: LeaseAcquireInput): Promise<FencedLease> {
      return client.acquireLease(input);
    },
    renew(input: LeaseRenewInput): Promise<FencedLease> {
      return client.renewLease(input);
    },
    async release(input: LeaseReleaseInput): Promise<void> {
      if (!(await client.releaseLease(input))) throw new Error("lease is no longer current");
    },
    validate(input: LeaseReleaseInput): Promise<FencedLease> {
      return client.validateLease(input);
    },
  });
}

export async function enrollManagedNode(input: {
  readonly managementBaseUrl: string;
  readonly enrollmentToken: string;
  readonly relationshipPath: string;
  readonly caCertificate: string | Buffer;
  readonly heartbeat: ManagedNodeHeartbeat;
  readonly requestTimeoutMs?: number;
}): Promise<ManagedNodeRelationship> {
  const managementBaseUrl = normalizeManagementOrigin(input.managementBaseUrl);
  const heartbeat = ManagedNodeHeartbeatSchema.parse(structuredClone(input.heartbeat));
  const keyPair = generateManagedNodeKeyPair();
  const enrolled = await requestJson({
    baseUrl: managementBaseUrl,
    method: "POST",
    path: "/v1/nodes/enroll",
    body: JSON.stringify({
      token: input.enrollmentToken,
      ...heartbeat,
      publicKeyPem: keyPair.publicKeyPem,
    }),
    caCertificate: input.caCertificate,
    timeoutMs: parseRequestTimeout(input.requestTimeoutMs),
    headers: {},
    schema: ManagedNodeEnrollmentResponseSchema,
  });
  if (
    enrolled.node.paseoServerId !== heartbeat.paseoServerId ||
    enrolled.node.publicKeyPem !== keyPair.publicKeyPem ||
    enrolled.node.endpoint !== heartbeat.endpoint ||
    enrolled.node.bootId !== heartbeat.bootId
  ) {
    throw new Error("enrollment response identity mismatch");
  }
  const relationship = createManagedNodeRelationship({
    managementBaseUrl,
    node: enrolled.node,
    nodePrivateKeyPem: keyPair.privateKeyPem,
    ticketPublicKeyPem: enrolled.ticketPublicKeyPem,
  });
  writeManagedNodeRelationship(input.relationshipPath, relationship);
  return relationship;
}

interface RequestJsonInput<T> {
  readonly baseUrl: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly body: string;
  readonly caCertificate: string | Buffer;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly schema: z.ZodType<T>;
}

function requestJson<T>(input: RequestJsonInput<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const target = new URL(input.path, `${normalizeManagementOrigin(input.baseUrl)}/`);
    const request = httpsRequest(
      target,
      {
        method: input.method,
        ca: input.caCertificate,
        rejectUnauthorized: true,
        timeout: input.timeoutMs,
        headers: {
          accept: "application/json",
          ...(input.body.length > 0
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(input.body)),
              }
            : {}),
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("management response too large"));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const failure = ErrorResponseSchema.safeParse(decoded);
              throw new ManagementPlaneRequestError(
                status,
                failure.success ? failure.data.error.code : "invalid_response",
                failure.success ? failure.data.error.message : "management request failed",
              );
            }
            resolve(input.schema.parse(decoded));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("management request timed out")));
    request.once("error", reject);
    if (input.body.length > 0) request.write(input.body);
    request.end();
  });
}

function signNodeRequest(
  privateKey: KeyObject | string | Buffer,
  input: {
    readonly method: string;
    readonly path: string;
    readonly timestampMs: number;
    readonly nonce: string;
    readonly body: string;
  },
): string {
  const digest = createHash("sha256").update(input.body).digest("base64url");
  const message = Buffer.from(
    [
      "paseo-node-request-v1",
      input.method.toUpperCase(),
      input.path,
      String(input.timestampMs),
      input.nonce,
      digest,
    ].join("\n"),
  );
  return sign(null, message, privateKey).toString("base64url");
}

function parseRequestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > SIGNATURE_MAX_SKEW_MS) {
    throw new Error("invalid management request timeout");
  }
  return timeout;
}
