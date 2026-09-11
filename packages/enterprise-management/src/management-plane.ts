import { createPublicKey, randomUUID, timingSafeEqual, type KeyObject } from "node:crypto";

import {
  FencedLeaseSchema,
  GlobalResourceRefSchema,
  LeaseAcquireInputSchema,
  LeaseReleaseInputSchema,
  LeaseRenewInputSchema,
  OrganizationIdSchema,
  ResourceGrantSchema,
  type FencedLease,
  type GlobalResourceRef,
  type LeaseAcquireInput,
  type LeaseReleaseInput,
  type LeaseRenewInput,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";

import {
  ManagedNodeSchema,
  ManagementPrincipalSchema,
  NodeHeartbeatSchema,
  NodeShutdownSchema,
  PlacementSchema,
  type ManagedNode,
  type ManagementPrincipal,
  type ManagementRole,
  type NodeRequestAuthentication,
  type Placement,
  type SessionTicketClaims,
} from "./model.js";
import {
  createOpaqueId,
  createSecretToken,
  digestSecret,
  parseSecretToken,
  signSessionTicket,
  verifyNodeRequestSignature,
  verifySecret,
} from "./security.js";
import { openSqliteDatabase, transaction, type SqliteDatabase } from "./sqlite.js";

const CREDENTIAL_TOKEN_PREFIX = "pso_m_";
const ENROLLMENT_TOKEN_PREFIX = "pso_enr_";
const CREDENTIAL_ID_PATTERN = /^cred_[0-9a-f]{24}$/;
const ENROLLMENT_ID_PATTERN = /^enr_[0-9a-f]{24}$/;
const NODE_REQUEST_MAX_SKEW_MS = 60_000;
const NODE_DUPLICATE_WINDOW_MS = 90_000;
const MAX_SESSION_TICKET_TTL_MS = 5 * 60_000;

interface Clock {
  nowMs(): number;
}

interface DatabaseRow {
  readonly [key: string]: unknown;
}

export type AuthenticatedManagementPrincipal = ManagementPrincipal & {
  readonly credentialId: string;
};

export interface EnrollmentRequest {
  readonly token: string;
  readonly paseoServerId: string;
  readonly publicKeyPem: string;
  readonly endpoint: string;
  readonly bootId: string;
  readonly version: string;
  readonly capabilities: Readonly<Record<string, string | number | boolean>>;
  readonly capacity: {
    readonly cpuLogical: number;
    readonly memoryTotalBytes: number;
    readonly memoryAvailableBytes: number;
    readonly activeAgents: number;
    readonly activeBrowserProfiles: number;
  };
}

export type GlobalLease = FencedLease;

export interface NodePolicyEntry {
  readonly principalId: string;
  readonly principalType: "human" | "service";
  readonly displayName: string;
  readonly grantVersion: string;
  readonly revocationEpoch: number;
  readonly grants: readonly ResourceGrant[];
  readonly status: ManagementPrincipal["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagementAuditInput {
  readonly eventId: string;
  readonly nodeId: string;
  readonly nodeEventSeq: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: "allowed" | "denied" | "failed";
  readonly actorPrincipalId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ManagementAuditRecord extends ManagementAuditInput {
  readonly organizationId: string;
}

export interface ManagementCredentialSummary {
  readonly credentialId: string;
  readonly principalId: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export class EnterpriseManagementPlane {
  private readonly database: SqliteDatabase;
  private readonly clock: Clock;
  private closed = false;

  constructor(
    private readonly options: {
      readonly databasePath: string;
      readonly organizationId: string;
      readonly organizationName: string;
      readonly issuer: string;
      readonly bootstrapSecret: string;
      readonly ticketPrivateKey: KeyObject | string | Buffer;
      readonly ticketPublicKey: KeyObject | string | Buffer;
      readonly clock?: Clock;
    },
  ) {
    const organizationId = OrganizationIdSchema.parse(options.organizationId);
    if (options.bootstrapSecret.length < 24) throw new Error("bootstrap secret is too short");
    this.clock = options.clock ?? { nowMs: () => Date.now() };
    this.database = openSqliteDatabase(options.databasePath);
    this.database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.database.exec(SCHEMA);
    this.database
      .prepare(
        "INSERT INTO organizations (organization_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(organization_id) DO NOTHING",
      )
      .run(organizationId, options.organizationName, this.nowIso());
  }

  async bootstrapAdministrator(input: {
    readonly bootstrapSecret: string;
    readonly displayName: string;
  }): Promise<{ readonly principal: ManagementPrincipal; readonly token: string }> {
    this.assertOpen();
    const supplied = Buffer.from(input.bootstrapSecret);
    const expected = Buffer.from(this.options.bootstrapSecret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error("invalid bootstrap secret");
    }
    if (this.countPrincipals() !== 0) throw new Error("management plane already initialized");
    const principal = this.insertPrincipal({
      displayName: input.displayName,
      principalType: "human",
      role: "platform_admin",
    });
    const credential = await this.issueCredentialUnchecked(principal.principalId);
    return Object.freeze({ principal, token: credential.token });
  }

  async authenticatePersonalAccessToken(
    token: string,
  ): Promise<AuthenticatedManagementPrincipal | null> {
    this.assertOpen();
    const parsed = parseSecretToken(token, CREDENTIAL_TOKEN_PREFIX, CREDENTIAL_ID_PATTERN);
    if (!parsed) return null;
    const row = this.row(
      this.database.prepare("SELECT * FROM credentials WHERE credential_id = ?").get(parsed.id),
    );
    if (!row || row.revoked_at !== null) return null;
    if (typeof row.expires_at === "string" && Date.parse(row.expires_at) <= this.clock.nowMs()) {
      return null;
    }
    if (
      !(await verifySecret(parsed.secret, {
        salt: String(row.secret_salt),
        digest: String(row.secret_digest),
      }))
    ) {
      return null;
    }
    const principal = this.readPrincipal(String(row.principal_id));
    if (!principal || principal.status !== "active") return null;
    this.database
      .prepare("UPDATE credentials SET last_used_at = ? WHERE credential_id = ?")
      .run(this.nowIso(), parsed.id);
    return Object.freeze({ ...principal, credentialId: parsed.id });
  }

  async createPrincipal(
    actor: AuthenticatedManagementPrincipal,
    input: {
      readonly displayName: string;
      readonly principalType: "human" | "service";
      readonly role: ManagementRole;
    },
  ): Promise<ManagementPrincipal> {
    this.assertActor(actor, "identity.manage");
    return this.insertPrincipal(input);
  }

  async issuePersonalAccessToken(
    actor: AuthenticatedManagementPrincipal,
    principalId: string,
  ): Promise<{ readonly token: string; readonly credentialId: string }> {
    this.assertActor(actor, "identity.manage");
    if (!this.readPrincipal(principalId)) throw new Error("principal unavailable");
    return this.issueCredentialUnchecked(principalId);
  }

  async revokePersonalAccessToken(
    actor: AuthenticatedManagementPrincipal,
    credentialId: string,
  ): Promise<boolean> {
    this.assertActor(actor, "identity.manage");
    const result = this.database
      .prepare(
        "UPDATE credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL AND principal_id IN (SELECT principal_id FROM principals WHERE organization_id = ?)",
      )
      .run(this.nowIso(), credentialId, this.options.organizationId);
    if (result.changes === 1) {
      this.database
        .prepare(
          "UPDATE principals SET grant_version = ?, revocation_epoch = revocation_epoch + 1, updated_at = ? WHERE principal_id = (SELECT principal_id FROM credentials WHERE credential_id = ?)",
        )
        .run(createOpaqueId("grv_", 16), this.nowIso(), credentialId);
    }
    return result.changes === 1;
  }

  async listCredentials(
    actor: AuthenticatedManagementPrincipal,
    principalId: string,
  ): Promise<readonly ManagementCredentialSummary[]> {
    this.assertActor(actor, "identity.manage");
    this.requirePrincipal(principalId);
    return Object.freeze(
      this.database
        .prepare(
          "SELECT credential_id, principal_id, created_at, expires_at, last_used_at, revoked_at FROM credentials WHERE principal_id = ? ORDER BY created_at",
        )
        .all(principalId)
        .map((value) => {
          const row = this.row(value)!;
          return Object.freeze({
            credentialId: String(row.credential_id),
            principalId: String(row.principal_id),
            createdAt: String(row.created_at),
            expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
            lastUsedAt: typeof row.last_used_at === "string" ? row.last_used_at : null,
            revokedAt: typeof row.revoked_at === "string" ? row.revoked_at : null,
          });
        }),
    );
  }

  async setPrincipalStatus(
    actor: AuthenticatedManagementPrincipal,
    principalId: string,
    status: "active" | "disabled" | "revoked",
  ): Promise<ManagementPrincipal> {
    this.assertActor(actor, "identity.manage");
    const current = this.requirePrincipal(principalId);
    if (principalId === actor.principalId && status !== "active") {
      throw new Error("administrator cannot disable the active credential owner");
    }
    if (current.status === "revoked" && status !== "revoked") {
      throw new Error("revoked principal cannot be reactivated");
    }
    if (current.status === status) return current;
    this.database
      .prepare(
        "UPDATE principals SET status = ?, grant_version = ?, revocation_epoch = revocation_epoch + 1, updated_at = ? WHERE principal_id = ? AND organization_id = ?",
      )
      .run(
        status,
        createOpaqueId("grv_", 16),
        this.nowIso(),
        principalId,
        this.options.organizationId,
      );
    return this.requirePrincipal(principalId);
  }

  async listPrincipals(
    actor: AuthenticatedManagementPrincipal,
  ): Promise<readonly ManagementPrincipal[]> {
    this.assertActor(actor, "identity.manage");
    return Object.freeze(
      this.database
        .prepare(
          "SELECT principal_id FROM principals WHERE organization_id = ? ORDER BY created_at",
        )
        .all(this.options.organizationId)
        .map((value) => this.requirePrincipal(String(this.row(value)!.principal_id))),
    );
  }

  async replaceGrants(
    actor: AuthenticatedManagementPrincipal,
    principalId: string,
    input: { readonly expectedGrantVersion: string; readonly grants: readonly ResourceGrant[] },
  ): Promise<ManagementPrincipal> {
    this.assertActor(actor, "identity.manage");
    const grants = input.grants.map((grant) => ResourceGrantSchema.parse(structuredClone(grant)));
    const now = this.nowIso();
    transaction(this.database, () => {
      const current = this.readPrincipal(principalId);
      if (!current || current.grantVersion !== input.expectedGrantVersion) {
        throw new Error("grant version conflict");
      }
      this.validateGrantOrganizations(grants);
      this.database
        .prepare(
          "UPDATE principals SET grants_json = ?, grant_version = ?, revocation_epoch = revocation_epoch + 1, updated_at = ? WHERE principal_id = ?",
        )
        .run(JSON.stringify(grants), createOpaqueId("grv_", 16), now, principalId);
    });
    return this.requirePrincipal(principalId);
  }

  async createEnrollmentToken(
    actor: AuthenticatedManagementPrincipal,
    input: { readonly expiresInMs: number },
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    this.assertActor(actor, "identity.manage");
    if (
      !Number.isInteger(input.expiresInMs) ||
      input.expiresInMs < 1_000 ||
      input.expiresInMs > 86_400_000
    ) {
      throw new Error("invalid enrollment lifetime");
    }
    const enrollmentId = createOpaqueId("enr_", 12);
    const secret = createSecretToken(ENROLLMENT_TOKEN_PREFIX, enrollmentId);
    const digest = await digestSecret(secret.secret);
    const expiresAt = new Date(this.clock.nowMs() + input.expiresInMs).toISOString();
    this.database
      .prepare(
        "INSERT INTO enrollment_tokens (enrollment_id, organization_id, secret_salt, secret_digest, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        enrollmentId,
        this.options.organizationId,
        digest.salt,
        digest.digest,
        expiresAt,
        actor.principalId,
        this.nowIso(),
      );
    return Object.freeze({ token: secret.token, expiresAt });
  }

  async enrollNode(
    input: EnrollmentRequest,
  ): Promise<{ readonly node: ManagedNode; readonly request: EnrollmentRequest }> {
    this.assertOpen();
    const parsed = parseSecretToken(input.token, ENROLLMENT_TOKEN_PREFIX, ENROLLMENT_ID_PATTERN);
    if (!parsed) throw new Error("invalid enrollment token");
    const tokenRow = this.row(
      this.database
        .prepare("SELECT * FROM enrollment_tokens WHERE enrollment_id = ?")
        .get(parsed.id),
    );
    if (!tokenRow) throw new Error("invalid enrollment token");
    if (Date.parse(String(tokenRow.expires_at)) <= this.clock.nowMs()) {
      throw new Error("enrollment token expired");
    }
    if (
      !(await verifySecret(parsed.secret, {
        salt: String(tokenRow.secret_salt),
        digest: String(tokenRow.secret_digest),
      }))
    ) {
      throw new Error("invalid enrollment token");
    }
    const heartbeat = NodeHeartbeatSchema.parse({
      bootId: input.bootId,
      paseoServerId: input.paseoServerId,
      endpoint: input.endpoint,
      version: input.version,
      capabilities: input.capabilities,
      capacity: input.capacity,
    });
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(input.publicKeyPem);
    } catch (error) {
      throw new Error("invalid node public key", { cause: error });
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("invalid node public key");
    const canonicalPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
    if (tokenRow.consumed_at !== null) {
      const consumed = this.readNode(String(tokenRow.consumed_node_id ?? ""));
      if (
        !consumed ||
        consumed.paseoServerId !== heartbeat.paseoServerId ||
        consumed.publicKeyPem !== canonicalPublicKey ||
        consumed.endpoint !== heartbeat.endpoint ||
        consumed.bootId !== heartbeat.bootId ||
        consumed.version !== heartbeat.version ||
        JSON.stringify(consumed.capabilities) !== JSON.stringify(heartbeat.capabilities) ||
        JSON.stringify(consumed.capacity) !== JSON.stringify(heartbeat.capacity)
      ) {
        throw new Error("enrollment token already consumed");
      }
      return Object.freeze({ node: consumed, request: Object.freeze({ ...input }) });
    }
    const nodeId = createOpaqueId("nod_", 8);
    const now = this.nowIso();
    transaction(this.database, () => {
      const consume = this.database
        .prepare(
          "UPDATE enrollment_tokens SET consumed_at = ?, consumed_node_id = ? WHERE enrollment_id = ? AND consumed_at IS NULL",
        )
        .run(now, nodeId, parsed.id);
      if (consume.changes !== 1) throw new Error("enrollment token already consumed");
      this.database
        .prepare(
          "INSERT INTO nodes (node_id, organization_id, paseo_server_id, public_key_pem, endpoint, boot_id, status, version, capabilities_json, capacity_json, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, NULL, ?, ?)",
        )
        .run(
          nodeId,
          this.options.organizationId,
          heartbeat.paseoServerId,
          canonicalPublicKey,
          heartbeat.endpoint,
          heartbeat.bootId,
          heartbeat.version,
          JSON.stringify(heartbeat.capabilities),
          JSON.stringify(heartbeat.capacity),
          now,
          now,
        );
    });
    return Object.freeze({ node: this.requireNode(nodeId), request: Object.freeze({ ...input }) });
  }

  async setNodeStatus(
    actor: AuthenticatedManagementPrincipal,
    nodeId: string,
    status: "active" | "draining" | "disabled" | "revoked",
  ): Promise<ManagedNode> {
    this.assertActor(actor, "identity.manage");
    const result = this.database
      .prepare(
        "UPDATE nodes SET status = ?, last_seen_at = CASE WHEN ? = 'active' AND status IN ('offline', 'degraded') THEN NULL ELSE last_seen_at END, updated_at = ? WHERE node_id = ? AND organization_id = ?",
      )
      .run(status, status, this.nowIso(), nodeId, this.options.organizationId);
    if (result.changes !== 1) throw new Error("node unavailable");
    return this.requireNode(nodeId);
  }

  async listNodes(actor: AuthenticatedManagementPrincipal): Promise<readonly ManagedNode[]> {
    this.assertActorAny(actor, ["identity.manage", "workspace.metadata.read"]);
    return Object.freeze(
      this.database
        .prepare("SELECT node_id FROM nodes WHERE organization_id = ? ORDER BY created_at")
        .all(this.options.organizationId)
        .map((value) => this.requireNode(String(this.row(value)!.node_id))),
    );
  }

  getNodePolicy(nodeId: string): readonly NodePolicyEntry[] {
    this.requireNode(nodeId);
    return Object.freeze(
      this.database
        .prepare(
          "SELECT principal_id, principal_type, display_name, grant_version, revocation_epoch, grants_json, status, created_at, updated_at FROM principals WHERE organization_id = ? ORDER BY principal_id",
        )
        .all(this.options.organizationId)
        .map((value) => {
          const row = this.row(value)!;
          return Object.freeze({
            principalId: String(row.principal_id),
            principalType: String(row.principal_type) as "human" | "service",
            displayName: String(row.display_name),
            grantVersion: String(row.grant_version),
            revocationEpoch: Number(row.revocation_epoch),
            grants: Object.freeze(
              ResourceGrantSchema.array().parse(JSON.parse(String(row.grants_json))),
            ),
            status: String(row.status) as ManagementPrincipal["status"],
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
          });
        }),
    );
  }

  async recordHeartbeat(
    authentication: NodeRequestAuthentication,
    body: string,
  ): Promise<ManagedNode> {
    const node = this.authenticateNodeRequest(authentication, {
      method: "POST",
      path: "/v1/node/heartbeat",
      body,
    });
    const heartbeat = NodeHeartbeatSchema.parse(JSON.parse(body));
    if (heartbeat.paseoServerId !== node.paseoServerId) throw new Error("node server mismatch");
    const nowMs = this.clock.nowMs();
    const lastSeenMs = node.lastSeenAt ? Date.parse(node.lastSeenAt) : -Infinity;
    if (
      heartbeat.bootId !== node.bootId &&
      node.status !== "offline" &&
      nowMs - lastSeenMs <= NODE_DUPLICATE_WINDOW_MS
    ) {
      this.database
        .prepare("UPDATE nodes SET status = 'degraded', updated_at = ? WHERE node_id = ?")
        .run(this.nowIso(), node.nodeId);
      throw new Error("duplicate node identity");
    }
    this.database
      .prepare(
        "UPDATE nodes SET endpoint = ?, boot_id = ?, version = ?, capabilities_json = ?, capacity_json = ?, status = CASE WHEN status = 'offline' THEN 'active' ELSE status END, last_seen_at = ?, updated_at = ? WHERE node_id = ?",
      )
      .run(
        heartbeat.endpoint,
        heartbeat.bootId,
        heartbeat.version,
        JSON.stringify(heartbeat.capabilities),
        JSON.stringify(heartbeat.capacity),
        this.nowIso(),
        this.nowIso(),
        node.nodeId,
      );
    return this.requireNode(node.nodeId);
  }

  async recordShutdown(
    authentication: NodeRequestAuthentication,
    body: string,
  ): Promise<ManagedNode> {
    const node = this.authenticateNodeRequest(authentication, {
      method: "POST",
      path: "/v1/node/shutdown",
      body,
    });
    const shutdown = NodeShutdownSchema.parse(JSON.parse(body));
    if (shutdown.paseoServerId !== node.paseoServerId || shutdown.bootId !== node.bootId) {
      throw new Error("node shutdown identity mismatch");
    }
    if (node.status === "active" || node.status === "draining") {
      this.database
        .prepare(
          "UPDATE nodes SET status = 'offline', last_seen_at = ?, updated_at = ? WHERE node_id = ?",
        )
        .run(this.nowIso(), this.nowIso(), node.nodeId);
    }
    return this.requireNode(node.nodeId);
  }

  async registerPlacement(
    nodeId: string,
    input: GlobalResourceRef & { readonly ownerPrincipalId?: string },
  ): Promise<Placement> {
    const resource = structuredClone(input) as GlobalResourceRef & { ownerPrincipalId?: string };
    const ownerPrincipalId = resource.ownerPrincipalId;
    if (!ownerPrincipalId || !this.readPrincipal(ownerPrincipalId)) {
      throw new Error("placement owner unavailable");
    }
    delete resource.ownerPrincipalId;
    const node = this.requireNode(nodeId);
    if (resource.nodeId !== node.nodeId || resource.organizationId !== node.organizationId) {
      throw new Error("placement node mismatch");
    }
    const now = this.nowIso();
    this.database
      .prepare(
        "INSERT INTO placements (organization_id, node_id, resource_kind, local_resource_id, owner_principal_id, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id, node_id, resource_kind, local_resource_id) DO UPDATE SET owner_principal_id = excluded.owner_principal_id, updated_at = excluded.updated_at",
      )
      .run(
        resource.organizationId,
        resource.nodeId,
        resource.resourceKind,
        resource.localResourceId,
        ownerPrincipalId,
        now,
        now,
      );
    return PlacementSchema.parse({ resource, ownerPrincipalId, assignedAt: now, updatedAt: now });
  }

  async replaceNodePlacements(
    nodeId: string,
    inputs: readonly (GlobalResourceRef & { readonly ownerPrincipalId: string })[],
  ): Promise<readonly Placement[]> {
    const node = this.requireNode(nodeId);
    const existing = new Map(
      this.database
        .prepare("SELECT * FROM placements WHERE organization_id = ? AND node_id = ?")
        .all(this.options.organizationId, nodeId)
        .map((value) => this.row(value)!)
        .map((row) => [placementKey(row), row] as const),
    );
    const next = new Map<
      string,
      { readonly resource: GlobalResourceRef; readonly ownerPrincipalId: string }
    >();
    for (const input of inputs) {
      const parsed = GlobalResourceRefSchema.parse(structuredClone(input));
      if (parsed.organizationId !== node.organizationId || parsed.nodeId !== node.nodeId) {
        throw new Error("placement node mismatch");
      }
      if (!this.readPrincipal(input.ownerPrincipalId)) {
        throw new Error("placement owner unavailable");
      }
      const key = globalResourceKey(parsed);
      if (next.has(key)) throw new Error("duplicate placement");
      next.set(key, { resource: parsed, ownerPrincipalId: input.ownerPrincipalId });
    }
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare("DELETE FROM placements WHERE organization_id = ? AND node_id = ?")
        .run(this.options.organizationId, nodeId);
      const insert = this.database.prepare(
        "INSERT INTO placements (organization_id, node_id, resource_kind, local_resource_id, owner_principal_id, assigned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [key, placement] of next) {
        const assignedAt = String(existing.get(key)?.assigned_at ?? now);
        insert.run(
          placement.resource.organizationId,
          placement.resource.nodeId,
          placement.resource.resourceKind,
          placement.resource.localResourceId,
          placement.ownerPrincipalId,
          assignedAt,
          now,
        );
      }
    });
    return Object.freeze(
      this.database
        .prepare(
          "SELECT * FROM placements WHERE organization_id = ? AND node_id = ? ORDER BY resource_kind, local_resource_id",
        )
        .all(this.options.organizationId, nodeId)
        .map((value) => this.placementFromRow(this.row(value)!)),
    );
  }

  async listPlacements(actor: ManagementPrincipal): Promise<readonly Placement[]> {
    this.assertPrincipalCurrent(actor);
    return Object.freeze(
      this.database
        .prepare(
          "SELECT * FROM placements WHERE organization_id = ? ORDER BY node_id, resource_kind, local_resource_id",
        )
        .all(this.options.organizationId)
        .map((value) => this.row(value)!)
        .filter((row) =>
          this.allowsResource(
            actor,
            "workspace.metadata.read",
            String(row.owner_principal_id),
            String(row.resource_kind) === "workspace" ? String(row.local_resource_id) : "",
          ),
        )
        .map((row) => this.placementFromRow(row)),
    );
  }

  async resolveWorkspace(
    actor: ManagementPrincipal,
    workspaceId: string,
  ): Promise<Placement | null> {
    this.assertPrincipalCurrent(actor);
    const rows = this.database
      .prepare(
        "SELECT * FROM placements WHERE organization_id = ? AND resource_kind = 'workspace' AND local_resource_id = ?",
      )
      .all(this.options.organizationId, workspaceId)
      .map((value) => this.row(value)!);
    const allowed = rows.filter((row) =>
      this.allowsResource(
        actor,
        "workspace.metadata.read",
        String(row.owner_principal_id ?? ""),
        workspaceId,
      ),
    );
    if (allowed.length === 0) return null;
    if (allowed.length !== 1) throw new Error("workspace placement is ambiguous");
    return this.placementFromRow(allowed[0]!);
  }

  async issueSessionTicket(
    token: string,
    input: { readonly workspaceId: string; readonly clientId: string; readonly ttlMs: number },
  ): Promise<{ readonly ticket: string; readonly endpoint: string; readonly expiresAt: string }> {
    const principal = await this.authenticatePersonalAccessToken(token);
    if (!principal) throw new Error("invalid credential");
    if (
      !Number.isInteger(input.ttlMs) ||
      input.ttlMs < 1_000 ||
      input.ttlMs > MAX_SESSION_TICKET_TTL_MS
    ) {
      throw new Error("invalid ticket lifetime");
    }
    const placement = await this.resolveWorkspace(principal, input.workspaceId);
    if (!placement) throw new Error("workspace unavailable");
    const node = this.requireNode(placement.resource.nodeId);
    if (node.status !== "active") throw new Error(`node is ${node.status}`);
    const issuedAtMs = this.clock.nowMs();
    const claims: SessionTicketClaims = {
      version: 1,
      kind: "session",
      issuer: this.options.issuer,
      ticketId: createOpaqueId("tkt_", 16),
      organizationId: principal.organizationId,
      principalId: principal.principalId,
      principalType: principal.principalType,
      credentialId: principal.credentialId,
      clientId: input.clientId,
      grantVersion: principal.grantVersion,
      revocationEpoch: principal.revocationEpoch,
      nodeId: node.nodeId,
      paseoServerId: node.paseoServerId,
      grants: structuredClone(principal.grants),
      issuedAtMs,
      notBeforeMs: issuedAtMs,
      expiresAtMs: issuedAtMs + input.ttlMs,
    };
    return Object.freeze({
      ticket: signSessionTicket(claims, this.options.ticketPrivateKey),
      endpoint: node.endpoint,
      expiresAt: new Date(claims.expiresAtMs).toISOString(),
    });
  }

  async issueContentTicket(
    token: string,
    input: {
      readonly resource: GlobalResourceRef;
      readonly action: "workspace.content.read";
      readonly ttlMs: number;
    },
  ): Promise<{ readonly ticket: string; readonly endpoint: string; readonly expiresAt: string }> {
    const principal = await this.authenticatePersonalAccessToken(token);
    if (!principal) throw new Error("invalid credential");
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) {
      throw new Error("invalid content ticket lifetime");
    }
    const node = this.requireNode(input.resource.nodeId);
    if (node.status !== "active" && node.status !== "draining") {
      throw new Error(`node is ${node.status}`);
    }
    const placementRows = this.database
      .prepare(
        "SELECT owner_principal_id FROM placements WHERE organization_id = ? AND node_id = ? AND resource_kind = ? AND local_resource_id = ?",
      )
      .all(
        input.resource.organizationId,
        input.resource.nodeId,
        input.resource.resourceKind,
        input.resource.localResourceId,
      );
    if (placementRows.length !== 1) throw new Error("resource unavailable");
    const ownerPrincipalId = String(this.row(placementRows[0])?.owner_principal_id ?? "");
    if (
      !this.allowsResource(
        principal,
        input.action,
        ownerPrincipalId,
        input.resource.resourceKind === "workspace" ? input.resource.localResourceId : "",
      )
    ) {
      throw new Error("resource unavailable");
    }
    const issuedAtMs = this.clock.nowMs();
    const claims: SessionTicketClaims = {
      version: 1,
      kind: "content",
      issuer: this.options.issuer,
      ticketId: createOpaqueId("tkt_", 16),
      organizationId: principal.organizationId,
      principalId: principal.principalId,
      principalType: principal.principalType,
      credentialId: principal.credentialId,
      grantVersion: principal.grantVersion,
      revocationEpoch: principal.revocationEpoch,
      nodeId: node.nodeId,
      paseoServerId: node.paseoServerId,
      grants: structuredClone(principal.grants),
      resource: structuredClone(input.resource),
      action: input.action,
      issuedAtMs,
      notBeforeMs: issuedAtMs,
      expiresAtMs: issuedAtMs + input.ttlMs,
    };
    return Object.freeze({
      ticket: signSessionTicket(claims, this.options.ticketPrivateKey),
      endpoint: node.endpoint,
      expiresAt: new Date(claims.expiresAtMs).toISOString(),
    });
  }

  async acquireLease(nodeId: string, input: LeaseAcquireInput): Promise<GlobalLease> {
    const canonical = LeaseAcquireInputSchema.parse(structuredClone(input));
    if (
      canonical.organizationId !== this.options.organizationId ||
      canonical.nodeId !== nodeId ||
      !canonical.businessIdentityId
    ) {
      throw new Error("lease node or business identity mismatch");
    }
    if (canonical.ttlMs < 1_000 || canonical.ttlMs > 120_000) {
      throw new Error("invalid lease lifetime");
    }
    const node = this.requireNode(nodeId);
    if (node.status !== "active") throw new Error(`node is ${node.status}`);
    const lease = transaction(this.database, () => {
      const current = this.row(
        this.database
          .prepare("SELECT * FROM leases WHERE organization_id = ? AND business_identity_id = ?")
          .get(this.options.organizationId, canonical.businessIdentityId),
      );
      if (current && Date.parse(String(current.expires_at)) > this.clock.nowMs()) {
        throw new Error("business identity is already leased");
      }
      const fenceRow = this.row(
        this.database
          .prepare(
            "SELECT fencing_token FROM lease_fences WHERE organization_id = ? AND business_identity_id = ?",
          )
          .get(this.options.organizationId, canonical.businessIdentityId),
      );
      const fencingToken = Number(fenceRow?.fencing_token ?? 0) + 1;
      this.database
        .prepare(
          "INSERT INTO lease_fences (organization_id, business_identity_id, fencing_token) VALUES (?, ?, ?) ON CONFLICT(organization_id, business_identity_id) DO UPDATE SET fencing_token = excluded.fencing_token",
        )
        .run(this.options.organizationId, canonical.businessIdentityId, fencingToken);
      const acquiredAt = this.nowIso();
      const expiresAt = new Date(this.clock.nowMs() + canonical.ttlMs).toISOString();
      const next = FencedLeaseSchema.parse({
        leaseId: `lea_${randomUUID()}`,
        organizationId: this.options.organizationId,
        businessIdentityId: canonical.businessIdentityId,
        nodeId,
        holderPrincipalId: canonical.holderPrincipalId,
        holderAgentId: canonical.holderAgentId,
        fencingToken,
        mode: canonical.mode,
        resourceKind: canonical.resourceKind,
        resourceId: canonical.resourceId,
        leaseRevision: createOpaqueId("lrv_", 16),
        acquiredAt,
        expiresAt,
        heartbeatAt: acquiredAt,
      });
      this.database
        .prepare(
          "INSERT INTO leases (organization_id, business_identity_id, lease_id, node_id, holder_principal_id, holder_agent_id, fencing_token, mode, resource_kind, resource_id, lease_revision, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id, business_identity_id) DO UPDATE SET lease_id=excluded.lease_id,node_id=excluded.node_id,holder_principal_id=excluded.holder_principal_id,holder_agent_id=excluded.holder_agent_id,fencing_token=excluded.fencing_token,mode=excluded.mode,resource_kind=excluded.resource_kind,resource_id=excluded.resource_id,lease_revision=excluded.lease_revision,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at,heartbeat_at=excluded.heartbeat_at",
        )
        .run(
          next.organizationId,
          next.businessIdentityId,
          next.leaseId,
          next.nodeId,
          next.holderPrincipalId,
          next.holderAgentId,
          next.fencingToken,
          next.mode,
          next.resourceKind,
          next.resourceId,
          next.leaseRevision,
          next.acquiredAt,
          next.expiresAt,
          next.heartbeatAt,
        );
      return next;
    });
    return Object.freeze(lease);
  }

  async renewLease(nodeId: string, input: LeaseRenewInput): Promise<GlobalLease> {
    const canonical = LeaseRenewInputSchema.parse(structuredClone(input));
    if (canonical.nodeId !== nodeId) throw new Error("lease node mismatch");
    if (canonical.ttlMs < 1_000 || canonical.ttlMs > 120_000) {
      throw new Error("invalid lease lifetime");
    }
    const node = this.requireNode(nodeId);
    if (node.status !== "active" && node.status !== "draining") throw new Error("node unavailable");
    const heartbeatAt = this.nowIso();
    const expiresAt = new Date(this.clock.nowMs() + canonical.ttlMs).toISOString();
    const leaseRevision = createOpaqueId("lrv_", 16);
    const result = this.database
      .prepare(
        "UPDATE leases SET expires_at = ?, heartbeat_at = ?, lease_revision = ? WHERE lease_id = ? AND node_id = ? AND holder_principal_id = ? AND fencing_token = ? AND expires_at > ?",
      )
      .run(
        expiresAt,
        heartbeatAt,
        leaseRevision,
        canonical.leaseId,
        nodeId,
        canonical.holderPrincipalId,
        canonical.fencingToken,
        heartbeatAt,
      );
    if (result.changes !== 1) throw new Error("lease is no longer current");
    return this.requireLease(canonical.leaseId);
  }

  async releaseLease(nodeId: string, input: LeaseReleaseInput): Promise<boolean> {
    const canonical = LeaseReleaseInputSchema.parse(structuredClone(input));
    if (canonical.nodeId !== nodeId) throw new Error("lease node mismatch");
    this.requireNode(nodeId);
    const result = this.database
      .prepare(
        "DELETE FROM leases WHERE lease_id = ? AND node_id = ? AND holder_principal_id = ? AND fencing_token = ?",
      )
      .run(canonical.leaseId, nodeId, canonical.holderPrincipalId, canonical.fencingToken);
    return result.changes === 1;
  }

  validateLease(nodeId: string, input: LeaseReleaseInput): GlobalLease {
    const canonical = LeaseReleaseInputSchema.parse(structuredClone(input));
    if (canonical.nodeId !== nodeId) throw new Error("lease node mismatch");
    const node = this.requireNode(nodeId);
    if (node.status !== "active" && node.status !== "draining") throw new Error("node unavailable");
    const lease = this.requireLease(canonical.leaseId);
    if (
      lease.nodeId !== nodeId ||
      lease.holderPrincipalId !== canonical.holderPrincipalId ||
      lease.fencingToken !== canonical.fencingToken ||
      Date.parse(lease.expiresAt) <= this.clock.nowMs()
    ) {
      throw new Error("lease is no longer current");
    }
    return lease;
  }

  async ingestAuditEvents(
    nodeId: string,
    events: readonly ManagementAuditInput[],
  ): Promise<{
    readonly accepted: number;
    readonly duplicates: number;
    readonly lastSequence: number;
    readonly gaps: readonly { readonly expected: number; readonly received: number }[];
  }> {
    this.requireNode(nodeId);
    let accepted = 0;
    let duplicates = 0;
    const gaps: { expected: number; received: number }[] = [];
    transaction(this.database, () => {
      let lastSequence = Number(
        this.row(
          this.database
            .prepare("SELECT last_sequence FROM audit_node_state WHERE node_id = ?")
            .get(nodeId),
        )?.last_sequence ?? 0,
      );
      for (const event of events) {
        if (
          event.nodeId !== nodeId ||
          !Number.isInteger(event.nodeEventSeq) ||
          event.nodeEventSeq < 1
        ) {
          throw new Error("invalid audit event");
        }
        if (event.nodeEventSeq <= lastSequence) {
          const existing = this.row(
            this.database
              .prepare("SELECT event_id FROM audit_events WHERE node_id = ? AND node_event_seq = ?")
              .get(nodeId, event.nodeEventSeq),
          );
          if (existing?.event_id !== event.eventId) {
            throw new Error("audit sequence identity conflict");
          }
          duplicates += 1;
          continue;
        }
        const expected = lastSequence + 1;
        if (event.nodeEventSeq !== expected) {
          gaps.push({ expected, received: event.nodeEventSeq });
          break;
        }
        const insert = this.database
          .prepare(
            "INSERT OR IGNORE INTO audit_events (event_id, organization_id, node_id, node_event_seq, occurred_at, action, outcome, actor_principal_id, resource_kind, resource_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            event.eventId,
            this.options.organizationId,
            nodeId,
            event.nodeEventSeq,
            event.occurredAt,
            event.action,
            event.outcome,
            event.actorPrincipalId,
            event.resourceKind,
            event.resourceId,
            JSON.stringify(event.metadata),
          );
        if (insert.changes !== 1) throw new Error("audit event identity conflict");
        accepted += 1;
        lastSequence = event.nodeEventSeq;
      }
      this.database
        .prepare(
          "INSERT INTO audit_node_state (node_id, last_sequence) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET last_sequence = excluded.last_sequence",
        )
        .run(nodeId, lastSequence);
    });
    return Object.freeze({
      accepted,
      duplicates,
      lastSequence: this.auditLastSequence(nodeId),
      gaps: Object.freeze(gaps),
    });
  }

  auditLastSequence(nodeId: string): number {
    this.requireNode(nodeId);
    return Number(
      this.row(
        this.database
          .prepare("SELECT last_sequence FROM audit_node_state WHERE node_id = ?")
          .get(nodeId),
      )?.last_sequence ?? 0,
    );
  }

  async listAudit(
    actor: AuthenticatedManagementPrincipal,
    limit = 200,
  ): Promise<readonly ManagementAuditRecord[]> {
    this.assertActor(actor, "audit.read");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("invalid audit limit");
    }
    return Object.freeze(
      this.database
        .prepare(
          "SELECT * FROM audit_events WHERE organization_id = ? ORDER BY occurred_at DESC, event_id DESC LIMIT ?",
        )
        .all(this.options.organizationId, limit)
        .map((value) => {
          const row = this.row(value)!;
          return Object.freeze({
            eventId: String(row.event_id),
            organizationId: String(row.organization_id),
            nodeId: String(row.node_id),
            nodeEventSeq: Number(row.node_event_seq),
            occurredAt: String(row.occurred_at),
            action: String(row.action),
            outcome: String(row.outcome) as ManagementAuditRecord["outcome"],
            actorPrincipalId: String(row.actor_principal_id),
            resourceKind: String(row.resource_kind),
            resourceId: String(row.resource_id),
            metadata: Object.freeze(
              JSON.parse(String(row.metadata_json)) as Record<
                string,
                string | number | boolean | null
              >,
            ),
          });
        }),
    );
  }

  ticketPublicKeyPem(): string {
    const key = this.options.ticketPublicKey;
    if (typeof key === "string") return key;
    if (Buffer.isBuffer(key)) return key.toString("utf8");
    return key.export({ type: "spki", format: "pem" }).toString();
  }

  authenticateSignedNodeRequest(
    authentication: NodeRequestAuthentication,
    input: { readonly method: string; readonly path: string; readonly body: string },
  ): ManagedNode {
    return this.authenticateNodeRequest(authentication, input);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private authenticateNodeRequest(
    authentication: NodeRequestAuthentication,
    input: { readonly method: string; readonly path: string; readonly body: string },
  ): ManagedNode {
    this.assertOpen();
    const node = this.requireNode(authentication.nodeId);
    if (["disabled", "revoked"].includes(node.status)) throw new Error("node unavailable");
    if (Math.abs(this.clock.nowMs() - authentication.timestampMs) > NODE_REQUEST_MAX_SKEW_MS) {
      throw new Error("stale node request");
    }
    if (!verifyNodeRequestSignature(node.publicKeyPem, authentication, input)) {
      throw new Error("invalid node signature");
    }
    try {
      this.database
        .prepare("INSERT INTO node_request_nonces (node_id, nonce, seen_at) VALUES (?, ?, ?)")
        .run(node.nodeId, authentication.nonce, this.nowIso());
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new Error("node request replay", { cause: error });
      throw error;
    }
    return node;
  }

  private insertPrincipal(input: {
    readonly displayName: string;
    readonly principalType: "human" | "service";
    readonly role: ManagementRole;
  }): ManagementPrincipal {
    const principalId = createOpaqueId(input.principalType === "human" ? "usr_" : "svc_", 8);
    const grants = roleGrants(input.role, this.options.organizationId);
    const now = this.nowIso();
    this.database
      .prepare(
        "INSERT INTO principals (principal_id, organization_id, principal_type, display_name, role, status, grant_version, revocation_epoch, grants_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)",
      )
      .run(
        principalId,
        this.options.organizationId,
        input.principalType,
        input.displayName,
        input.role,
        createOpaqueId("grv_", 16),
        JSON.stringify(grants),
        now,
        now,
      );
    return this.requirePrincipal(principalId);
  }

  private async issueCredentialUnchecked(
    principalId: string,
  ): Promise<{ readonly token: string; readonly credentialId: string }> {
    const credentialId = createOpaqueId("cred_", 12);
    const token = createSecretToken(CREDENTIAL_TOKEN_PREFIX, credentialId);
    const digest = await digestSecret(token.secret);
    this.database
      .prepare(
        "INSERT INTO credentials (credential_id, principal_id, secret_salt, secret_digest, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)",
      )
      .run(credentialId, principalId, digest.salt, digest.digest, this.nowIso());
    return Object.freeze({ token: token.token, credentialId });
  }

  private assertActor(actor: AuthenticatedManagementPrincipal, action: string): void {
    this.assertPrincipalCurrent(actor);
    if (
      !actor.grants.some(
        (grant) => grant.action === action && this.selectorCoversOrganization(grant),
      )
    ) {
      throw new Error("management operation denied");
    }
  }

  private assertActorAny(
    actor: AuthenticatedManagementPrincipal,
    actions: readonly string[],
  ): void {
    this.assertPrincipalCurrent(actor);
    if (
      !actor.grants.some(
        (grant) => actions.includes(grant.action) && this.selectorCoversOrganization(grant),
      )
    ) {
      throw new Error("management operation denied");
    }
  }

  private assertPrincipalCurrent(actor: ManagementPrincipal): void {
    const current = this.readPrincipal(actor.principalId);
    if (
      !current ||
      current.status !== "active" ||
      current.organizationId !== this.options.organizationId ||
      current.grantVersion !== actor.grantVersion ||
      current.revocationEpoch !== actor.revocationEpoch
    ) {
      throw new Error("principal authorization is no longer current");
    }
  }

  private allowsResource(
    actor: ManagementPrincipal,
    action: string,
    ownerPrincipalId: string,
    workspaceId: string,
  ): boolean {
    return actor.grants.some((grant) => {
      if (grant.action !== action) return false;
      if (grant.selector.kind === "self") return ownerPrincipalId === actor.principalId;
      if (grant.selector.kind === "organization") {
        return grant.selector.organizationId === actor.organizationId;
      }
      return grant.selector.workspaceIds.includes(workspaceId);
    });
  }

  private selectorCoversOrganization(grant: ResourceGrant): boolean {
    return (
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === this.options.organizationId
    );
  }

  private validateGrantOrganizations(grants: readonly ResourceGrant[]): void {
    for (const grant of grants) {
      if (
        grant.selector.kind === "organization" &&
        grant.selector.organizationId !== this.options.organizationId
      ) {
        throw new Error("foreign organization grant");
      }
    }
  }

  private countPrincipals(): number {
    return Number(
      this.row(
        this.database
          .prepare("SELECT COUNT(*) AS count FROM principals WHERE organization_id = ?")
          .get(this.options.organizationId),
      )?.count ?? 0,
    );
  }

  private readPrincipal(principalId: string): ManagementPrincipal | null {
    const row = this.row(
      this.database
        .prepare("SELECT * FROM principals WHERE principal_id = ? AND organization_id = ?")
        .get(principalId, this.options.organizationId),
    );
    if (!row) return null;
    return ManagementPrincipalSchema.parse({
      principalId: row.principal_id,
      organizationId: row.organization_id,
      principalType: row.principal_type,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      grantVersion: row.grant_version,
      revocationEpoch: row.revocation_epoch,
      grants: JSON.parse(String(row.grants_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private requirePrincipal(principalId: string): ManagementPrincipal {
    const principal = this.readPrincipal(principalId);
    if (!principal) throw new Error("principal unavailable");
    return principal;
  }

  private readNode(nodeId: string): ManagedNode | null {
    const row = this.row(
      this.database
        .prepare("SELECT * FROM nodes WHERE node_id = ? AND organization_id = ?")
        .get(nodeId, this.options.organizationId),
    );
    if (!row) return null;
    return ManagedNodeSchema.parse({
      nodeId: row.node_id,
      paseoServerId: row.paseo_server_id,
      organizationId: row.organization_id,
      publicKeyPem: row.public_key_pem,
      endpoint: row.endpoint,
      bootId: row.boot_id,
      status: row.status,
      version: row.version,
      capabilities: JSON.parse(String(row.capabilities_json)),
      capacity: JSON.parse(String(row.capacity_json)),
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private requireNode(nodeId: string): ManagedNode {
    const node = this.readNode(nodeId);
    if (!node) throw new Error("node unavailable");
    return node;
  }

  private placementFromRow(row: DatabaseRow): Placement {
    return PlacementSchema.parse({
      resource: {
        organizationId: row.organization_id,
        nodeId: row.node_id,
        resourceKind: row.resource_kind,
        localResourceId: row.local_resource_id,
      },
      ownerPrincipalId: row.owner_principal_id,
      assignedAt: row.assigned_at,
      updatedAt: row.updated_at,
    });
  }

  private requireLease(leaseId: string): GlobalLease {
    const row = this.row(
      this.database.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId),
    );
    if (!row) throw new Error("lease unavailable");
    return FencedLeaseSchema.parse({
      leaseId: String(row.lease_id),
      organizationId: String(row.organization_id),
      businessIdentityId: String(row.business_identity_id),
      nodeId: String(row.node_id),
      holderPrincipalId: String(row.holder_principal_id),
      holderAgentId: String(row.holder_agent_id),
      fencingToken: Number(row.fencing_token),
      mode: String(row.mode),
      resourceKind: String(row.resource_kind),
      resourceId: String(row.resource_id),
      leaseRevision: String(row.lease_revision),
      acquiredAt: String(row.acquired_at),
      expiresAt: String(row.expires_at),
      heartbeatAt: String(row.heartbeat_at),
    });
  }

  private row(value: unknown): DatabaseRow | null {
    return value && typeof value === "object" ? (value as DatabaseRow) : null;
  }

  private nowIso(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("management plane is closed");
  }
}

function globalResourceKey(resource: GlobalResourceRef): string {
  return JSON.stringify([
    resource.organizationId,
    resource.nodeId,
    resource.resourceKind,
    resource.localResourceId,
  ]);
}

function placementKey(row: DatabaseRow): string {
  return JSON.stringify([
    row.organization_id,
    row.node_id,
    row.resource_kind,
    row.local_resource_id,
  ]);
}

function roleGrants(role: ManagementRole, organizationId: string): ResourceGrant[] {
  const self = { kind: "self" as const };
  const organization = { kind: "organization" as const, organizationId };
  let actions: readonly ResourceGrant["action"][];
  if (role === "employee") {
    actions = [
      "workspace.metadata.read",
      "workspace.content.read",
      "workspace.write",
      "browser.use",
      "app.use",
    ];
  } else if (role === "boss") {
    actions = ["workspace.metadata.read", "audit.read"];
  } else {
    actions = [
      "workspace.metadata.read",
      "workspace.manage",
      "browser.profile.manage",
      "audit.read",
      "identity.manage",
    ];
  }
  return actions.map((action) =>
    ResourceGrantSchema.parse({
      action,
      selector: role === "employee" ? self : organization,
    }),
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  organization_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principals (
  principal_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  principal_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  grant_version TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL,
  grants_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  secret_salt TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  enrollment_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  secret_salt TEXT NOT NULL,
  secret_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(principal_id),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_node_id TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  paseo_server_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  capacity_json TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, paseo_server_id),
  UNIQUE (public_key_pem)
);
CREATE TABLE IF NOT EXISTS node_request_nonces (
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  nonce TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (node_id, nonce)
);
CREATE TABLE IF NOT EXISTS placements (
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  resource_kind TEXT NOT NULL,
  local_resource_id TEXT NOT NULL,
  owner_principal_id TEXT,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, node_id, resource_kind, local_resource_id)
);
CREATE TABLE IF NOT EXISTS lease_fences (
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  business_identity_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  PRIMARY KEY (organization_id, business_identity_id)
);
CREATE TABLE IF NOT EXISTS leases (
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  business_identity_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  holder_principal_id TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  mode TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  lease_revision TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, business_identity_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  node_id TEXT NOT NULL REFERENCES nodes(node_id),
  node_event_seq INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (node_id, node_event_seq)
);
CREATE TABLE IF NOT EXISTS audit_node_state (
  node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
  last_sequence INTEGER NOT NULL
);
`;
