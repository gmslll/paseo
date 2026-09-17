import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";

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
import type { WorkspaceMembershipPolicy } from "@getpaseo/protocol/enterprise-collaboration";
import {
  type ManagedRuntimePolicy,
  ManagedRuntimeNodePolicyResponseSchema,
  Sha256HexSchema,
} from "@getpaseo/protocol/managed-runtimes";
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
import {
  parseRequestTimeout,
  requestJson,
  requestStream,
  signNodeRequest,
} from "./node-request.js";

// Re-exported rather than moved outright: callers outside this directory import it from here, and
// the collaboration uplink needs the same class to mean the same thing.
export { ManagementPlaneRequestError } from "./node-request.js";

const HeartbeatResponseSchema = z.object({ node: ManagedNodeSchema }).strict();
const PlacementResponseSchema = z.object({ placement: ManagedPlacementSchema }).strict();
const LeaseResponseSchema = z.object({ lease: ManagedGlobalLeaseSchema }).strict();
const LeaseReleaseResponseSchema = z.object({ released: z.boolean() }).strict();

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
  private workspaceMemberships: readonly WorkspaceMembershipPolicy[] | null = null;
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
    // Sent only to nodes that declare collaborationV1, and absent rather than empty for the rest
    // (ADR-0033), so null and [] mean different things: not a collaborating node, versus one that
    // hosts no collaborating Workspaces.
    this.workspaceMemberships = result.workspaceMemberships
      ? Object.freeze(result.workspaceMemberships.map((entry) => Object.freeze({ ...entry })))
      : null;
    this.policyUpdatedAtMs = this.clock.nowMs();
    return Object.freeze([...next.values()]);
  }

  /** The Workspaces the plane says this node hosts, as of the last policy refresh. */
  currentWorkspaceMemberships(): readonly WorkspaceMembershipPolicy[] | null {
    return this.workspaceMemberships;
  }

  async applyOwnedCollabMemberChange(input: {
    readonly actorPrincipalId: string;
    readonly workspaceUid: string;
    readonly principalId: string;
    readonly role?: "editor" | "viewer";
  }): Promise<WorkspaceMembershipPolicy["members"]> {
    const result = await this.signedRequest(
      "POST",
      "/v1/node/collab/members",
      input,
      z.object({
        members: z.array(
          z.object({ principalId: z.string(), role: z.enum(["owner", "editor", "viewer"]) }),
        ),
      }),
    );
    return result.members as WorkspaceMembershipPolicy["members"];
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

  async refreshRuntimePolicy(): Promise<ManagedRuntimePolicy | null> {
    return (
      await this.signedRequest(
        "GET",
        "/v1/node/runtime-policy",
        undefined,
        ManagedRuntimeNodePolicyResponseSchema,
      )
    ).policy;
  }

  /** Streams a pinned artifact; the installer verifies its size and digest. */
  async openRuntimeArtifact(sha256: string): Promise<Readable> {
    const path = `/v1/node/runtime-artifacts/${Sha256HexSchema.parse(sha256)}`;
    return requestStream({
      baseUrl: this.relationship.managementBaseUrl,
      path,
      caCertificate: this.caCertificate,
      timeoutMs: this.requestTimeoutMs,
      headers: this.signedHeaders("GET", path, ""),
    });
  }

  private async signedRequest<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    value: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const body = value === undefined ? "" : JSON.stringify(value);
    return requestJson({
      baseUrl: this.relationship.managementBaseUrl,
      method,
      path,
      body,
      caCertificate: this.caCertificate,
      timeoutMs: this.requestTimeoutMs,
      headers: this.signedHeaders(method, path, body),
      schema,
    });
  }

  private signedHeaders(method: string, path: string, body: string): Record<string, string> {
    const timestampMs = this.clock.nowMs();
    const nonce = randomBytes(18).toString("base64url");
    return {
      "x-paseo-node-id": this.relationship.node.nodeId,
      "x-paseo-node-timestamp": String(timestampMs),
      "x-paseo-node-nonce": nonce,
      "x-paseo-node-signature": signNodeRequest(this.relationship.nodePrivateKeyPem, {
        method,
        path,
        timestampMs,
        nonce,
        body,
      }),
    };
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
