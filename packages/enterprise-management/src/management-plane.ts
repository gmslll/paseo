import {
  createHash,
  createPublicKey,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import path from "node:path";

import { canonicalAuditValue } from "@getpaseo/protocol/audit-canonical";

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
  digestPassword,
  digestSecret,
  parseSecretToken,
  signSessionTicket,
  verifyNodeRequestSignature,
  verifyPassword,
  verifySecret,
} from "./security.js";
import {
  type ManagedRuntimeCapabilityStatus,
  type ManagedRuntimePinUpdate,
  type ManagedRuntimePolicy,
  type ManagedRuntimePolicySettingsUpdate,
  parseManagedRuntimeCapabilities,
} from "@getpaseo/protocol/managed-runtimes";
import {
  RUNTIME_DISTRIBUTION_SCHEMA,
  RuntimeDistributionStore,
  type RuntimeArtifactRecord,
  type RuntimeArtifactUpload,
} from "./runtime-distribution.js";
import {
  DATA_PLANE_SCHEMA,
  createStreamStore,
  type StreamAppendInput,
  type StreamAppendResult,
  type StreamReadInput,
  type StreamReadResult,
  type StreamStore,
} from "./data-plane/stream-store.js";
import {
  MEMBERSHIP_SCHEMA,
  projectMembershipGrants,
  type CollabMember,
  type CollabWorkspaceRecord,
} from "./data-plane/membership.js";
import {
  COLLAB_SUBSCRIPTION_TTL_MS,
  parseCollabSegment,
  PRESENCE_TTL_MS,
  STREAM_TOKEN_TTL_MS,
  type CollabSubscriptionCreated,
  type CollabSubscriptionEvent,
  type PresenceEntry,
  MACHINE_RPC_DEFAULT_TTL_MS,
  MachineRpcAttestedRequestSchema,
  MachineRpcClientRequestSchema,
  formatCollabSegment,
  machineRpcMethodPolicy,
  roleAllowsMachineRpcMethod,
  type MachineRpcAttestedRequest,
  type MachineRpcClientRequest,
  type WorkspaceMemberRole,
  type WorkspaceMembershipPolicy,
} from "@getpaseo/protocol/enterprise-collaboration";
import { streamAccess, type StreamAccess } from "./data-plane/stream-access.js";
import { collectSubscriptionEvents } from "./data-plane/subscription.js";
import { signMachineRpcAttestation } from "./data-plane/rpc-attestation.js";
import { signStreamToken, verifyStreamToken } from "./data-plane/stream-token.js";
import { openSqliteDatabase, transaction, type SqliteDatabase } from "./sqlite.js";

/**
 * The plane is not a node, but `audit_events.node_id` and `audit_node_state.node_id` are foreign
 * keys into `nodes`, so plane-origin audit hangs off one reserved row (ADR-0037). The id is a
 * well-formed node id that a generated one would collide with at 2^-64, and every place that
 * enumerates or acts on nodes excludes it: it never heartbeats and is not a machine anyone can
 * place work on.
 */
export const PLANE_AUDIT_NODE_ID = "nod_0000000000000000";

/**
 * Who is asking for a stream. A client arrives with a credential and answers to membership; a node
 * arrives with its request signature and answers to placement (ADR-0032). They are different
 * authorities over the same routes, so the segment matrix is asked which one it is rather than
 * given a principal that a node does not have.
 */
export type CollabStreamActor =
  | { readonly kind: "principal"; readonly principal: AuthenticatedManagementPrincipal }
  | { readonly kind: "node"; readonly node: ManagedNode };

/**
 * What the stream entry points accept. A bare Principal is taken as a client, so the many call
 * sites that had one before nodes existed keep reading as they did. Only the boundary is loose:
 * everything past `toStreamActor` is the explicit union, so no authorization decision is ever made
 * from an actor whose kind was left to be inferred.
 */
export type CollabStreamCallerLike = CollabStreamActor | AuthenticatedManagementPrincipal;

function toStreamActor(actor: CollabStreamCallerLike): CollabStreamActor {
  return "kind" in actor ? actor : { kind: "principal", principal: actor };
}
const PLANE_AUDIT_SERVER_ID = "management-plane";

/**
 * What a plane-origin audit row hashes as. Every field comes from the stored row, which is what
 * makes the chain verifiable after a restart from the table alone.
 *
 * `metadataJson` is the stored string rather than the parsed object on purpose: parsing and
 * re-canonicalizing could reorder keys, and then a row would stop hashing to what was written.
 * `previousHash` is null rather than undefined for the first event, because the canonical form
 * drops undefined keys but serializes null — the two would hash differently.
 */
interface PlaneAuditHashInput {
  readonly eventId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly nodeEventSeq: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
  readonly actorPrincipalId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly metadataJson: string;
  readonly previousHash: string | null;
}

function planeAuditEventHash(input: PlaneAuditHashInput): string {
  return `sha256:${createHash("sha256").update(canonicalAuditValue(input)).digest("hex")}`;
}

/** The one mapping from a stored row to the hashed shape, so writing and verifying cannot drift. */
function planeAuditHashInputFromRow(row: Readonly<Record<string, unknown>>): PlaneAuditHashInput {
  const previous = row.previous_hash;
  return {
    eventId: String(row.event_id),
    organizationId: String(row.organization_id),
    nodeId: String(row.node_id),
    nodeEventSeq: Number(row.node_event_seq),
    occurredAt: String(row.occurred_at),
    action: String(row.action),
    outcome: String(row.outcome),
    actorPrincipalId: String(row.actor_principal_id),
    resourceKind: String(row.resource_kind),
    resourceId: String(row.resource_id),
    metadataJson: String(row.metadata_json),
    previousHash: previous === null || previous === undefined ? null : String(previous),
  };
}

const CREDENTIAL_TOKEN_PREFIX = "pso_m_";
const ENROLLMENT_TOKEN_PREFIX = "pso_enr_";
const CREDENTIAL_ID_PATTERN = /^cred_[0-9a-f]{24}$/;
const ENROLLMENT_ID_PATTERN = /^enr_[0-9a-f]{24}$/;
const NODE_REQUEST_MAX_SKEW_MS = 60_000;
const NODE_DUPLICATE_WINDOW_MS = 90_000;
const MAX_SESSION_TICKET_TTL_MS = 5 * 60_000;
/**
 * A plane session has to outlive the five-minute stream tokens it is used to fetch, or a
 * collaborator retypes their password every five minutes, and ADR-0035 gives no number. Twelve
 * hours is a working day: long enough to be a session, short enough that a leaked one does not
 * outlast it. Ending one early is ordinary credential revocation, which also rolls the Grant
 * version and so invalidates the stream tokens already derived from it.
 */
const PLANE_SESSION_TTL_MS = 12 * 60 * 60_000;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const INVALID_PASSWORD_HASH = "$2b$12$FKn7pcGA7X1tiWS5RHYSKed2ng6VB6U4Yo1CzAJGRF.eYHU9Fy4We";

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
  /** Absent from a node that predates the chain; see ManagedAuditInputSchema. */
  readonly previousHash?: string;
  readonly eventHash?: string;
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

/**
 * A live subscription, held in memory rather than in a table: it is connection state, and a client
 * that loses it re-subscribes with the cursors it already holds. The plan's table list names no
 * subscriptions table for the same reason.
 */
interface CollabSubscriptionRecord {
  readonly containerId: string;
  readonly principalId: string;
  readonly cursors: Record<string, string>;
  expiresAtMs: number;
}

export class EnterpriseManagementPlane {
  private readonly database: SqliteDatabase;
  private readonly clock: Clock;
  private readonly runtimes: RuntimeDistributionStore;
  private readonly streams: StreamStore;
  private readonly subscriptions = new Map<string, CollabSubscriptionRecord>();
  private readonly streamListeners = new Set<(containerId: string, segment: string) => void>();
  // Container id to "<principalId>:<clientId>" to entry. Keyed by client as well as principal
  // because one person on a laptop and a phone is two places, which is what clientId is for.
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  private readonly presenceListeners = new Set<(containerId: string) => void>();
  private readonly membershipListeners = new Set<(containerId: string) => void>();
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
      /** Defaults to runtime-artifacts beside a file database; in-memory planes have none. */
      readonly runtimeArtifactDirectory?: string;
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
    this.ensureAuditHashColumns();
    this.database.exec(RUNTIME_DISTRIBUTION_SCHEMA);
    this.runtimes = new RuntimeDistributionStore({
      database: this.database,
      organizationId,
      artifactDirectory:
        options.runtimeArtifactDirectory ??
        (options.databasePath === ":memory:"
          ? null
          : path.join(path.dirname(options.databasePath), "runtime-artifacts")),
      nowIso: () => this.nowIso(),
    });
    this.database.exec(DATA_PLANE_SCHEMA);
    this.database.exec(MEMBERSHIP_SCHEMA);
    this.streams = createStreamStore({ database: this.database, clock: this.clock });
    this.database
      .prepare(
        "INSERT INTO organizations (organization_id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(organization_id) DO NOTHING",
      )
      .run(organizationId, options.organizationName, this.nowIso());
    // Created here rather than at administrator bootstrap so that a plane can audit before anyone
    // has bootstrapped. The endpoint is a reserved-TLD URL because ManagedNodeSchema requires a
    // real one, and `disabled` is the closest the status enum comes to "not a machine": it keeps
    // the row out of every `active`/`draining` path without claiming it was ever trusted and cut
    // off, which `revoked` would.
    const reservedAt = this.nowIso();
    this.database
      .prepare(
        "INSERT INTO nodes (node_id, organization_id, paseo_server_id, public_key_pem, endpoint, boot_id, status, version, capabilities_json, capacity_json, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'disabled', ?, ?, ?, NULL, ?, ?) ON CONFLICT(node_id) DO NOTHING",
      )
      .run(
        PLANE_AUDIT_NODE_ID,
        organizationId,
        PLANE_AUDIT_SERVER_ID,
        `reserved-${PLANE_AUDIT_NODE_ID}`,
        "https://management.invalid/",
        "reserved",
        "0",
        "{}",
        JSON.stringify({
          cpuLogical: 1,
          memoryTotalBytes: 0,
          memoryAvailableBytes: 0,
          activeAgents: 0,
          activeBrowserProfiles: 0,
        }),
        reservedAt,
        reservedAt,
      );
  }

  /**
   * Appends one plane-origin audit event inside the caller's transaction (ADR-0037).
   *
   * Deliberately not shared with ingestAuditEvents. That path is the node ingest: a batch, with gap
   * and duplicate-identity semantics and a transaction of its own, and existing evidence rests on
   * it. This is a single event that has to live or die with the change it records, which is what
   * `required` durability means — the caller's transaction rolls back when this append fails, so
   * the operation is denied rather than performed unrecorded.
   *
   * The insert is a plain INSERT, so a sequence collision raises instead of being ignored.
   */
  private appendPlaneAudit(input: {
    readonly action: string;
    readonly outcome: "allowed" | "denied" | "failed";
    readonly actorPrincipalId: string;
    readonly resourceKind: string;
    readonly resourceId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  }): void {
    const lastSequence = Number(
      this.row(
        this.database
          .prepare("SELECT last_sequence FROM audit_node_state WHERE node_id = ?")
          .get(PLANE_AUDIT_NODE_ID),
      )?.last_sequence ?? 0,
    );
    const nextSequence = lastSequence + 1;
    const eventId = createOpaqueId("evt_", 12);
    const occurredAt = this.nowIso();
    const previousHash = this.auditTailHash(PLANE_AUDIT_NODE_ID, lastSequence);
    const eventHash = planeAuditEventHash({
      eventId,
      organizationId: this.options.organizationId,
      nodeId: PLANE_AUDIT_NODE_ID,
      nodeEventSeq: nextSequence,
      occurredAt,
      action: input.action,
      outcome: input.outcome,
      actorPrincipalId: input.actorPrincipalId,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      // ADR-0037: never prompt bodies, document bytes, file contents, tokens, or cookies. These
      // are identifiers and roles only.
      metadataJson: JSON.stringify(input.metadata),
      previousHash,
    });
    const result = this.database
      .prepare(
        "INSERT INTO audit_events (event_id, organization_id, node_id, node_event_seq, occurred_at, action, outcome, actor_principal_id, resource_kind, resource_id, metadata_json, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        eventId,
        this.options.organizationId,
        PLANE_AUDIT_NODE_ID,
        nextSequence,
        occurredAt,
        input.action,
        input.outcome,
        input.actorPrincipalId,
        input.resourceKind,
        input.resourceId,
        JSON.stringify(input.metadata),
        previousHash,
        eventHash,
      );
    if (result.changes !== 1) throw new Error("audit append failed");
    this.database
      .prepare(
        "INSERT INTO audit_node_state (node_id, last_sequence) VALUES (?, ?) ON CONFLICT(node_id) DO UPDATE SET last_sequence = excluded.last_sequence",
      )
      .run(PLANE_AUDIT_NODE_ID, nextSequence);
  }

  /**
   * Adds the hash columns to a database that predates them. This package has no schema versioning,
   * so the columns are inspected rather than added inside a try/catch: swallowing an exception here
   * would also swallow a real failure. Both statements are additive, which is the only kind of
   * change safe to make this way.
   */
  private ensureAuditHashColumns(): void {
    const existing = new Set(
      (
        this.database.prepare("PRAGMA table_info(audit_events)").all() as Array<{
          readonly name?: unknown;
        }>
      ).map((column) => String(column.name)),
    );
    if (!existing.has("previous_hash")) {
      this.database.exec("ALTER TABLE audit_events ADD COLUMN previous_hash TEXT");
    }
    if (!existing.has("event_hash")) {
      this.database.exec("ALTER TABLE audit_events ADD COLUMN event_hash TEXT");
    }
  }

  /** One reader for both chains, so the plane's own tail and a node's cannot drift apart. */
  private auditTailHash(nodeId: string, lastSequence: number): string | null {
    if (lastSequence < 1) return null;
    const row = this.row(
      this.database
        .prepare("SELECT event_hash FROM audit_events WHERE node_id = ? AND node_event_seq = ?")
        .get(nodeId, lastSequence),
    );
    const value = row?.event_hash;
    return value === null || value === undefined ? null : String(value);
  }

  /**
   * Walks the plane's own chain and reports the first sequence that does not hold (ADR-0037 asks
   * that the chain verify after a restart). Non-throwing, so a caller can assert an intact chain
   * and a tampered one the same way.
   *
   * Only plane-origin rows are checked. Node-ingested rows carry no hash yet.
   */
  verifyPlaneAuditChain(): {
    readonly checked: number;
    readonly brokenAtSequence: number | null;
  } {
    this.assertOpen();
    const rows = this.database
      .prepare("SELECT * FROM audit_events WHERE node_id = ? ORDER BY node_event_seq ASC")
      .all(PLANE_AUDIT_NODE_ID);
    let previousHash: string | null = null;
    let checked = 0;
    for (const value of rows) {
      const row = this.row(value)!;
      const input = planeAuditHashInputFromRow(row);
      const stored = row.event_hash;
      if (input.previousHash !== previousHash || stored === null || stored === undefined) {
        return { checked, brokenAtSequence: input.nodeEventSeq };
      }
      if (planeAuditEventHash(input) !== String(stored)) {
        return { checked, brokenAtSequence: input.nodeEventSeq };
      }
      previousHash = String(stored);
      checked += 1;
    }
    return { checked, brokenAtSequence: null };
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

  async setPrincipalPassword(
    actor: AuthenticatedManagementPrincipal,
    principalId: string,
    input: { readonly username: string; readonly password: string },
  ): Promise<{ readonly principalId: string; readonly username: string }> {
    this.assertActor(actor, "identity.manage");
    const principal = this.requirePrincipal(principalId);
    if (principal.principalType !== "human")
      throw new Error("password login requires a human principal");
    const username = normalizeUsername(input.username);
    assertPassword(input.password);
    const digest = await digestPassword(input.password);
    const credentialId = createOpaqueId("cred_", 12);
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare(
          "INSERT INTO password_credentials (principal_id, credential_id, username, password_hash, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(principal_id) DO UPDATE SET credential_id = excluded.credential_id, username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at, last_used_at = NULL",
        )
        .run(principalId, credentialId, username, digest, now, now);
      this.database
        .prepare(
          "UPDATE principals SET grant_version = ?, revocation_epoch = revocation_epoch + 1, updated_at = ? WHERE principal_id = ?",
        )
        .run(createOpaqueId("grv_", 16), now, principalId);
    });
    return Object.freeze({ principalId, username });
  }

  async authenticatePassword(
    usernameInput: string,
    password: string,
  ): Promise<AuthenticatedManagementPrincipal | null> {
    this.assertOpen();
    let username: string;
    try {
      username = normalizeUsername(usernameInput);
      assertPassword(password);
    } catch {
      return null;
    }
    const row = this.row(
      this.database
        .prepare("SELECT * FROM password_credentials WHERE username = ? COLLATE NOCASE")
        .get(username),
    );
    const passwordMatches = await verifyPassword(
      password,
      row ? String(row.password_hash) : INVALID_PASSWORD_HASH,
    );
    if (!row || !passwordMatches) {
      return null;
    }
    const principal = this.readPrincipal(String(row.principal_id));
    if (!principal || principal.status !== "active") return null;
    this.database
      .prepare("UPDATE password_credentials SET last_used_at = ? WHERE principal_id = ?")
      .run(this.nowIso(), principal.principalId);
    return Object.freeze({ ...principal, credentialId: String(row.credential_id) });
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
    // The audit anchor is not a machine. Refused with the same words as a missing node, so the
    // reserved row is not something an administrator can discover by probing ids.
    if (nodeId === PLANE_AUDIT_NODE_ID) throw new Error("node unavailable");
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
        .prepare(
          "SELECT node_id FROM nodes WHERE organization_id = ? AND node_id != ? ORDER BY created_at",
        )
        .all(this.options.organizationId, PLANE_AUDIT_NODE_ID)
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

  /**
   * The collaborative Workspaces placed on one node, with their members (ADR-0033).
   *
   * Returns null — not an empty array — for a node that does not declare `collaborationV1`. The
   * policy response is strict, so the caller has to leave the key out entirely for those nodes; an
   * empty array would still be an unknown key to an older node and would still be rejected.
   *
   * Placement decides the list: a node learns about the Workspaces it hosts and no others, so one
   * node's policy never discloses another's tenants.
   *
   * `membershipVersion` is derived from the members rather than stored. Nothing in the plane keeps
   * such a counter today — a membership change rolls the Principal's grantVersion instead — so this
   * gives a node something stable to compare without inventing a column that would then need to be
   * kept correct on every write.
   */
  readNodeWorkspaceMemberships(nodeId: string): readonly WorkspaceMembershipPolicy[] | null {
    this.assertOpen();
    const node = this.requireNode(nodeId);
    if (node.capabilities.collaborationV1 !== true) return null;

    const rows = this.database
      .prepare(
        `SELECT w.workspace_uid, w.local_workspace_id, w.owner_principal_id
         FROM collab_workspaces w
         JOIN placements p
           ON p.organization_id = w.organization_id
          AND p.local_resource_id = w.local_workspace_id
          AND p.resource_kind = 'workspace'
         WHERE w.organization_id = ? AND p.node_id = ? AND w.collaboration_enabled = 1
         ORDER BY w.workspace_uid`,
      )
      .all(this.options.organizationId, nodeId);

    return Object.freeze(
      rows.map((value) => {
        const row = this.row(value)!;
        const workspaceUid = String(row.workspace_uid);
        const members = this.listCollabMembersUnchecked(workspaceUid);
        return {
          workspaceUid,
          localWorkspaceId: String(row.local_workspace_id),
          ownerPrincipalId: String(row.owner_principal_id),
          membershipVersion: members.length,
          // Not frozen: WorkspaceMembershipPolicy is inferred from a plain zod object, so its
          // members array is mutable. Freezing it produced a readonly type the contract will not
          // accept, and casting that away would have left the declared type saying something
          // untrue. The outer list is still frozen.
          members: members.map((member) => ({
            principalId: member.principalId,
            role: member.role,
          })),
        };
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
    this.assertSessionTicketLifetime(input.ttlMs);
    const placement = await this.resolveWorkspace(principal, input.workspaceId);
    if (!placement) throw new Error("workspace unavailable");
    const node = this.requireNode(placement.resource.nodeId);
    if (node.status !== "active") throw new Error(`node is ${node.status}`);
    return this.signNodeSessionTicket(principal, node, input.clientId, input.ttlMs);
  }

  async issueNodeSessionTicket(
    token: string,
    input: { readonly nodeId: string; readonly clientId: string; readonly ttlMs: number },
  ): Promise<{ readonly ticket: string; readonly endpoint: string; readonly expiresAt: string }> {
    const principal = await this.authenticatePersonalAccessToken(token);
    if (!principal) throw new Error("invalid credential");
    return this.issueNodeSessionTicketForPrincipal(principal, input);
  }

  async issueNodeSessionTicketWithPassword(input: {
    readonly username: string;
    readonly password: string;
    readonly nodeId: string;
    readonly clientId: string;
    readonly ttlMs: number;
  }): Promise<{ readonly ticket: string; readonly endpoint: string; readonly expiresAt: string }> {
    const principal = await this.authenticatePassword(input.username, input.password);
    if (!principal) throw new Error("invalid credential");
    return this.issueNodeSessionTicketForPrincipal(principal, input);
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
    // The reserved id is well known, and this is the node-facing ingest. A node cannot reach the
    // plane's own audit sequence: refused with the same words as a missing node, as everywhere else
    // that names it. Signature verification would already stop it — the reserved row's key is a
    // sentinel, not a real one — but the sequence is not something a node should be able to touch
    // even in principle.
    if (nodeId === PLANE_AUDIT_NODE_ID) throw new Error("node unavailable");
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
        // The plane cannot recompute a node's hash — what arrives is a flattened projection, not
        // the AuditEvent the node hashed — so what it can check is the linkage: each event must
        // name the hash of the one before it. A node that sends no hashes is left alone.
        const expectedPrevious = this.auditTailHash(nodeId, event.nodeEventSeq - 1);
        if (
          event.eventHash !== undefined &&
          expectedPrevious !== null &&
          event.previousHash !== expectedPrevious
        ) {
          throw new Error("audit chain mismatch");
        }
        const insert = this.database
          .prepare(
            "INSERT OR IGNORE INTO audit_events (event_id, organization_id, node_id, node_event_seq, occurred_at, action, outcome, actor_principal_id, resource_kind, resource_id, metadata_json, previous_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
            event.previousHash ?? null,
            event.eventHash ?? null,
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

  async registerCollabWorkspace(
    actor: AuthenticatedManagementPrincipal,
    input: { readonly localWorkspaceId: string; readonly ownerPrincipalId: string },
  ): Promise<CollabWorkspaceRecord> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    const owner = this.requirePrincipal(input.ownerPrincipalId);
    const workspaceUid = createOpaqueId("cws_", 8);
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare(
          "INSERT INTO collab_workspaces (workspace_uid, organization_id, local_workspace_id, owner_principal_id, collaboration_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
        )
        .run(
          workspaceUid,
          this.options.organizationId,
          input.localWorkspaceId,
          owner.principalId,
          now,
          now,
        );
      // The owner is a member row too, so listing members needs no special case for it.
      this.database
        .prepare(
          "INSERT INTO collab_members (workspace_uid, principal_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)",
        )
        .run(workspaceUid, owner.principalId, now, now);
      this.reprojectMembership(owner.principalId, workspaceUid, "owner", now);
    });
    return this.requireCollabWorkspace(workspaceUid);
  }

  async setCollabMember(
    actor: AuthenticatedManagementPrincipal,
    input: {
      readonly workspaceUid: string;
      readonly principalId: string;
      readonly role: WorkspaceMemberRole;
    },
  ): Promise<readonly CollabMember[]> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    const member = this.requirePrincipal(input.principalId);
    // ADR-0033 keeps exactly one owner; promotion happens through ownership transfer, not here.
    if (input.role === "owner" && member.principalId !== workspace.ownerPrincipalId) {
      throw new Error("workspace already has an owner");
    }
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO collab_members (workspace_uid, principal_id, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_uid, principal_id)
           DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
        )
        .run(input.workspaceUid, member.principalId, input.role, now, now);
      this.reprojectMembership(member.principalId, input.workspaceUid, input.role, now);
      // ADR-0037 makes a role change `required`: inside this transaction, so a failed append denies
      // the change rather than leaving it unrecorded.
      this.appendPlaneAudit({
        action: "collab.member.set",
        outcome: "allowed",
        actorPrincipalId: actor.principalId,
        resourceKind: "workspace",
        resourceId: input.workspaceUid,
        metadata: { principalId: member.principalId, role: input.role },
      });
    });
    this.notifyCollabMembershipChange(input.workspaceUid);
    return this.listCollabMembersUnchecked(input.workspaceUid);
  }

  async removeCollabMember(
    actor: AuthenticatedManagementPrincipal,
    input: { readonly workspaceUid: string; readonly principalId: string },
  ): Promise<readonly CollabMember[]> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    if (input.principalId === workspace.ownerPrincipalId) {
      throw new Error("cannot remove the workspace owner");
    }
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare("DELETE FROM collab_members WHERE workspace_uid = ? AND principal_id = ?")
        .run(input.workspaceUid, input.principalId);
      this.reprojectMembership(input.principalId, input.workspaceUid, null, now);
      this.appendPlaneAudit({
        action: "collab.member.remove",
        outcome: "allowed",
        actorPrincipalId: actor.principalId,
        resourceKind: "workspace",
        resourceId: input.workspaceUid,
        metadata: { principalId: input.principalId },
      });
    });
    this.notifyCollabMembershipChange(input.workspaceUid);
    return this.listCollabMembersUnchecked(input.workspaceUid);
  }

  /**
   * Owner-driven membership from a collaborating node (ADR-0033). The node is signed; the actor
   * must be the Workspace owner. Platform `identity.manage` still uses `setCollabMember`.
   */
  async applyOwnedCollabMemberChange(
    nodeId: string,
    input: {
      readonly actorPrincipalId: string;
      readonly workspaceUid: string;
      readonly principalId: string;
      readonly role?: Exclude<WorkspaceMemberRole, "owner">;
    },
  ): Promise<readonly CollabMember[]> {
    this.assertOpen();
    const hosted = this.readNodeWorkspaceMemberships(nodeId);
    const onNode = hosted?.some((entry) => entry.workspaceUid === input.workspaceUid) === true;
    if (!onNode) throw new Error("workspace is not placed on this node");
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    if (input.actorPrincipalId !== workspace.ownerPrincipalId) {
      throw new Error("only the workspace owner can change members");
    }
    if (input.role) {
      return await this.setCollabMemberAsOwner(input.actorPrincipalId, {
        workspaceUid: input.workspaceUid,
        principalId: input.principalId,
        role: input.role,
      });
    }
    return await this.removeCollabMemberAsOwner(input.actorPrincipalId, {
      workspaceUid: input.workspaceUid,
      principalId: input.principalId,
    });
  }

  /**
   * Owner-driven enable from a collaborating node (ADR-0031). The node is signed and must have
   * already checked that the actor owns the local Workspace; the plane has no local registry.
   * Platform `identity.manage` still uses `registerCollabWorkspace` / `setCollabCollaboration`.
   */
  async enableOwnedCollabWorkspace(
    nodeId: string,
    input: { readonly actorPrincipalId: string; readonly localWorkspaceId: string },
  ): Promise<{
    readonly workspace: CollabWorkspaceRecord;
    readonly members: readonly CollabMember[];
  }> {
    this.assertOpen();
    if (input.localWorkspaceId.length === 0) throw new Error("invalid workspace");
    const node = this.requireNode(nodeId);
    if (node.capabilities.collaborationV1 !== true) {
      throw new Error("collaboration is not available on this node");
    }
    const actor = this.requirePrincipal(input.actorPrincipalId);
    const existing = this.readCollabWorkspaceByLocalId(input.localWorkspaceId);
    const placementOwner = this.readWorkspacePlacementOwner(nodeId, input.localWorkspaceId);
    const actorOwnsExisting = !existing || existing.ownerPrincipalId === actor.principalId;
    const actorOwnsPlacement = !placementOwner || placementOwner === actor.principalId;
    if (!actorOwnsExisting || !actorOwnsPlacement) {
      throw new Error("only the workspace owner can enable collaboration");
    }

    const workspaceUid =
      existing && existing.collaborationEnabled && placementOwner === actor.principalId
        ? existing.workspaceUid
        : this.persistOwnedCollabEnable({
            nodeId,
            actorPrincipalId: actor.principalId,
            localWorkspaceId: input.localWorkspaceId,
            existing,
            placementOwner,
          });
    const workspace = this.requireCollabWorkspace(workspaceUid);
    return { workspace, members: this.listCollabMembersUnchecked(workspace.workspaceUid) };
  }

  /**
   * Mints a stream token for a member the node has already authenticated (ADR-0032). Clients hold
   * a node ticket, not a PAT, so the node asks for the token they present to the plane.
   */
  async issueOwnedCollabStreamToken(
    nodeId: string,
    input: {
      readonly actorPrincipalId: string;
      readonly clientId: string;
      readonly workspaceUid: string;
    },
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    this.assertOpen();
    const node = this.requireNode(nodeId);
    if (node.capabilities.collaborationV1 !== true) {
      throw new Error("collaboration is not available on this node");
    }
    if (input.clientId.length === 0 || input.clientId.length > 160) {
      throw new Error("invalid client ID");
    }
    const actor = this.requirePrincipal(input.actorPrincipalId);
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    if (!workspace.collaborationEnabled) throw new Error("collaboration is not enabled");
    if (!this.isContainerPlacedOnNode(workspace.workspaceUid, nodeId)) {
      throw new Error("workspace is not placed on this node");
    }
    const members = this.listCollabMembersUnchecked(workspace.workspaceUid);
    if (!members.some((member) => member.principalId === actor.principalId)) {
      throw new Error("stream authorization denied");
    }
    const containerIds = this.listCollabContainersForPrincipal(actor.principalId);
    if (containerIds.length === 0) throw new Error("no collaborative workspaces");
    const issuedAtMs = this.clock.nowMs();
    const expiresAtMs = issuedAtMs + STREAM_TOKEN_TTL_MS;
    return Object.freeze({
      token: signStreamToken(
        {
          tokenId: createOpaqueId("stk_", 16),
          organizationId: actor.organizationId,
          principalId: actor.principalId,
          credentialId: createOpaqueId("cred_", 12),
          clientId: input.clientId,
          grantVersion: actor.grantVersion,
          revocationEpoch: actor.revocationEpoch,
          containerIds,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
        this.options.ticketPrivateKey,
      ),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  private persistOwnedCollabEnable(input: {
    readonly nodeId: string;
    readonly actorPrincipalId: string;
    readonly localWorkspaceId: string;
    readonly existing: CollabWorkspaceRecord | null;
    readonly placementOwner: string | null;
  }): string {
    const now = this.nowIso();
    const workspaceUid = input.existing?.workspaceUid ?? createOpaqueId("cws_", 8);
    transaction(this.database, () => {
      if (!input.existing) {
        this.database
          .prepare(
            "INSERT INTO collab_workspaces (workspace_uid, organization_id, local_workspace_id, owner_principal_id, collaboration_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
          )
          .run(
            workspaceUid,
            this.options.organizationId,
            input.localWorkspaceId,
            input.actorPrincipalId,
            now,
            now,
          );
        this.database
          .prepare(
            "INSERT INTO collab_members (workspace_uid, principal_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)",
          )
          .run(workspaceUid, input.actorPrincipalId, now, now);
        this.reprojectMembership(input.actorPrincipalId, workspaceUid, "owner", now);
      } else {
        this.database
          .prepare(
            "UPDATE collab_workspaces SET collaboration_enabled = 1, updated_at = ? WHERE workspace_uid = ? AND organization_id = ?",
          )
          .run(now, workspaceUid, this.options.organizationId);
      }
      if (!input.placementOwner) {
        this.database
          .prepare(
            "INSERT INTO placements (organization_id, node_id, resource_kind, local_resource_id, owner_principal_id, assigned_at, updated_at) VALUES (?, ?, 'workspace', ?, ?, ?, ?)",
          )
          .run(
            this.options.organizationId,
            input.nodeId,
            input.localWorkspaceId,
            input.actorPrincipalId,
            now,
            now,
          );
      }
      if (!input.existing || input.existing.collaborationEnabled !== true) {
        this.appendPlaneAudit({
          action: "collab.workspace.enable",
          outcome: "allowed",
          actorPrincipalId: input.actorPrincipalId,
          resourceKind: "workspace",
          resourceId: workspaceUid,
          metadata: { enabled: true, localWorkspaceId: input.localWorkspaceId },
        });
      }
    });
    return workspaceUid;
  }

  /**
   * A Session on this node submits a machine RPC as the signed-in member (ADR-0035). The plane
   * attests and appends to `rpc:req`; the node is not a writer of that segment.
   */
  async submitOwnedCollabRpc(
    nodeId: string,
    input: {
      readonly actorPrincipalId: string;
      readonly credentialId: string;
      readonly clientId: string;
      readonly method: string;
      readonly localWorkspaceId: string;
      readonly rpcId: string;
      readonly payload: unknown;
    },
  ): Promise<MachineRpcAttestedRequest> {
    this.assertOpen();
    const node = this.requireNode(nodeId);
    if (node.capabilities.collaborationV1 !== true) {
      throw new Error("collaboration is not available on this node");
    }
    const actorPrincipal = this.requirePrincipal(input.actorPrincipalId);
    this.requirePrincipalCredential(actorPrincipal.principalId, input.credentialId);
    const workspace = this.readCollabWorkspaceByLocalId(input.localWorkspaceId);
    if (!workspace || !workspace.collaborationEnabled) {
      throw new Error("collaborative workspace unavailable");
    }
    if (!this.isContainerPlacedOnNode(workspace.workspaceUid, nodeId)) {
      throw new Error("workspace is not placed on this node");
    }
    const actor: AuthenticatedManagementPrincipal = {
      ...actorPrincipal,
      credentialId: input.credentialId,
    };
    const nowMs = this.clock.nowMs();
    const envelope = MachineRpcClientRequestSchema.parse({
      kind: "request",
      rpcVersion: 1,
      rpcId: input.rpcId,
      method: input.method,
      nodeId,
      containerId: workspace.workspaceUid,
      clientId: input.clientId,
      sentAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + MACHINE_RPC_DEFAULT_TTL_MS).toISOString(),
      payload: input.payload,
    });
    const segment = formatCollabSegment({ kind: "rpc_request", nodeId });
    const caller = toStreamActor(actor);
    this.assertStreamAccess(caller, workspace.workspaceUid, segment, "write");
    const attested = this.attestRpcRequest(caller, {
      containerId: workspace.workspaceUid,
      segment,
      producerId: `prod-${input.rpcId}`,
      producerEpoch: 1,
      producerSeq: 1,
      update: new TextEncoder().encode(JSON.stringify(envelope)),
    });
    const result = this.streams.append(attested);
    if (result.kind !== "appended") throw new Error("machine rpc append refused");
    for (const listener of this.streamListeners) {
      try {
        listener(workspace.workspaceUid, segment);
      } catch {
        // The listener owns its own recovery.
      }
    }
    return MachineRpcAttestedRequestSchema.parse(
      JSON.parse(Buffer.from(attested.update).toString("utf8")),
    );
  }

  private async setCollabMemberAsOwner(
    actorPrincipalId: string,
    input: {
      readonly workspaceUid: string;
      readonly principalId: string;
      readonly role: Exclude<WorkspaceMemberRole, "owner">;
    },
  ): Promise<readonly CollabMember[]> {
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    if (input.principalId === workspace.ownerPrincipalId) {
      throw new Error("cannot change the workspace owner");
    }
    const member = this.requirePrincipal(input.principalId);
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO collab_members (workspace_uid, principal_id, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_uid, principal_id)
           DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
        )
        .run(input.workspaceUid, member.principalId, input.role, now, now);
      this.reprojectMembership(member.principalId, input.workspaceUid, input.role, now);
      this.appendPlaneAudit({
        action: "collab.member.set",
        outcome: "allowed",
        actorPrincipalId,
        resourceKind: "workspace",
        resourceId: input.workspaceUid,
        metadata: { principalId: member.principalId, role: input.role },
      });
    });
    this.notifyCollabMembershipChange(input.workspaceUid);
    return this.listCollabMembersUnchecked(input.workspaceUid);
  }

  private async removeCollabMemberAsOwner(
    actorPrincipalId: string,
    input: { readonly workspaceUid: string; readonly principalId: string },
  ): Promise<readonly CollabMember[]> {
    const workspace = this.requireCollabWorkspace(input.workspaceUid);
    if (input.principalId === workspace.ownerPrincipalId) {
      throw new Error("cannot remove the workspace owner");
    }
    const now = this.nowIso();
    transaction(this.database, () => {
      this.database
        .prepare("DELETE FROM collab_members WHERE workspace_uid = ? AND principal_id = ?")
        .run(input.workspaceUid, input.principalId);
      this.reprojectMembership(input.principalId, input.workspaceUid, null, now);
      this.appendPlaneAudit({
        action: "collab.member.remove",
        outcome: "allowed",
        actorPrincipalId,
        resourceKind: "workspace",
        resourceId: input.workspaceUid,
        metadata: { principalId: input.principalId },
      });
    });
    this.notifyCollabMembershipChange(input.workspaceUid);
    return this.listCollabMembersUnchecked(input.workspaceUid);
  }

  async setCollabCollaboration(
    actor: AuthenticatedManagementPrincipal,
    input: { readonly workspaceUid: string; readonly enabled: boolean },
  ): Promise<CollabWorkspaceRecord> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    this.requireCollabWorkspace(input.workspaceUid);
    // Wrapped in a transaction it did not previously need, so the switch and its `required` audit
    // commit together (ADR-0037).
    transaction(this.database, () => {
      this.database
        .prepare(
          "UPDATE collab_workspaces SET collaboration_enabled = ?, updated_at = ? WHERE workspace_uid = ? AND organization_id = ?",
        )
        .run(input.enabled ? 1 : 0, this.nowIso(), input.workspaceUid, this.options.organizationId);
      this.appendPlaneAudit({
        action: input.enabled ? "collab.workspace.enable" : "collab.workspace.disable",
        outcome: "allowed",
        actorPrincipalId: actor.principalId,
        resourceKind: "workspace",
        resourceId: input.workspaceUid,
        metadata: { enabled: input.enabled },
      });
    });
    return this.requireCollabWorkspace(input.workspaceUid);
  }

  /**
   * Mints a short-lived token for the collaborative Workspaces this caller currently belongs to
   * (ADR-0032). The container list comes from membership, never from the caller: a client that
   * could name its own containers would hold a token for Workspaces it was never added to.
   */
  async issueStreamToken(
    token: string,
    input: { readonly clientId: string },
  ): Promise<{ readonly token: string; readonly expiresAt: string }> {
    this.assertOpen();
    const principal = await this.authenticatePersonalAccessToken(token);
    if (!principal) throw new Error("invalid credential");
    if (input.clientId.length === 0 || input.clientId.length > 160) {
      throw new Error("invalid client ID");
    }
    const containerIds = this.listCollabContainersForPrincipal(principal.principalId);
    // The claims require at least one container, and a token naming none would authorize nothing.
    if (containerIds.length === 0) throw new Error("no collaborative workspaces");
    const issuedAtMs = this.clock.nowMs();
    const expiresAtMs = issuedAtMs + STREAM_TOKEN_TTL_MS;
    return Object.freeze({
      token: signStreamToken(
        {
          tokenId: createOpaqueId("stk_", 16),
          organizationId: principal.organizationId,
          principalId: principal.principalId,
          credentialId: principal.credentialId,
          clientId: input.clientId,
          grantVersion: principal.grantVersion,
          revocationEpoch: principal.revocationEpoch,
          containerIds,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
        this.options.ticketPrivateKey,
      ),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  /**
   * Resolves a stream token into the Principal that holds it, refusing one whose authority has
   * moved since it was minted. The comparison happens here rather than at the call site so a route
   * cannot forget it: the token outlives a membership change by up to its full lifetime otherwise.
   */
  authenticateStreamToken(token: string, containerId: string): AuthenticatedManagementPrincipal {
    this.assertOpen();
    const probe = this.readStreamTokenPrincipal(token);
    const claims = verifyStreamToken(token, this.options.ticketPublicKey, {
      nowMs: this.clock.nowMs(),
      containerId,
      organizationId: this.options.organizationId,
      currentGrantVersion: probe.grantVersion,
      currentRevocationEpoch: probe.revocationEpoch,
    });
    const principal = this.readPrincipal(claims.principalId);
    if (!principal || principal.status !== "active") throw new Error("invalid credential");
    return Object.freeze({ ...principal, credentialId: claims.credentialId });
  }

  /**
   * Reads the claimed holder's current authority so verification has something to compare against.
   * The claims are not trusted yet, so an unknown holder yields values that cannot match a real
   * token and the verifier refuses it like any other stale one.
   */
  private readStreamTokenPrincipal(token: string): {
    grantVersion: string;
    revocationEpoch: number;
  } {
    const payload = token.split(".")[1];
    if (!payload) return { grantVersion: "", revocationEpoch: -1 };
    try {
      const claimed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        principalId?: unknown;
      };
      const principal =
        typeof claimed.principalId === "string" ? this.readPrincipal(claimed.principalId) : null;
      if (!principal) return { grantVersion: "", revocationEpoch: -1 };
      return {
        grantVersion: principal.grantVersion,
        revocationEpoch: principal.revocationEpoch,
      };
    } catch {
      return { grantVersion: "", revocationEpoch: -1 };
    }
  }

  /** Enabled containers only: an unenabled Workspace keeps its bodies off the plane (ADR-0031). */
  private listCollabContainersForPrincipal(principalId: string): string[] {
    return this.database
      .prepare(
        `SELECT m.workspace_uid FROM collab_members m
         JOIN collab_workspaces w ON w.workspace_uid = m.workspace_uid
         WHERE m.principal_id = ? AND w.organization_id = ? AND w.collaboration_enabled = 1
         ORDER BY m.workspace_uid`,
      )
      .all(principalId, this.options.organizationId)
      .map((value) => String(this.row(value)!.workspace_uid));
  }

  async listCollabMembers(
    actor: AuthenticatedManagementPrincipal,
    workspaceUid: string,
  ): Promise<readonly CollabMember[]> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    this.requireCollabWorkspace(workspaceUid);
    return this.listCollabMembersUnchecked(workspaceUid);
  }

  private listCollabMembersUnchecked(workspaceUid: string): readonly CollabMember[] {
    return Object.freeze(
      this.database
        .prepare(
          "SELECT principal_id, role FROM collab_members WHERE workspace_uid = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at",
        )
        .all(workspaceUid)
        .map((value) => {
          const row = this.row(value)!;
          return {
            principalId: String(row.principal_id),
            role: String(row.role) as WorkspaceMemberRole,
          };
        }),
    );
  }

  private requireCollabWorkspace(workspaceUid: string): CollabWorkspaceRecord {
    const row = this.row(
      this.database
        .prepare("SELECT * FROM collab_workspaces WHERE workspace_uid = ? AND organization_id = ?")
        .get(workspaceUid, this.options.organizationId),
    );
    if (!row) throw new Error("collaborative workspace unavailable");
    return this.collabWorkspaceFromRow(row);
  }

  private readCollabWorkspaceByLocalId(localWorkspaceId: string): CollabWorkspaceRecord | null {
    const row = this.row(
      this.database
        .prepare(
          "SELECT * FROM collab_workspaces WHERE organization_id = ? AND local_workspace_id = ?",
        )
        .get(this.options.organizationId, localWorkspaceId),
    );
    return row ? this.collabWorkspaceFromRow(row) : null;
  }

  private readWorkspacePlacementOwner(nodeId: string, localWorkspaceId: string): string | null {
    const row = this.row(
      this.database
        .prepare(
          "SELECT owner_principal_id FROM placements WHERE organization_id = ? AND node_id = ? AND resource_kind = 'workspace' AND local_resource_id = ?",
        )
        .get(this.options.organizationId, nodeId, localWorkspaceId),
    );
    return row ? String(row.owner_principal_id) : null;
  }

  private collabWorkspaceFromRow(row: DatabaseRow): CollabWorkspaceRecord {
    return {
      workspaceUid: String(row.workspace_uid),
      localWorkspaceId: String(row.local_workspace_id),
      ownerPrincipalId: String(row.owner_principal_id),
      collaborationEnabled: Number(row.collaboration_enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Rewrites the member's grants for one Workspace and rolls their Grant version, which is the
   * existing Session invalidation path (ADR-0033). Every membership change rolls it, including a
   * re-set to the same role: the contract is stated over changes, not over effective permissions.
   */
  private reprojectMembership(
    principalId: string,
    workspaceUid: string,
    role: WorkspaceMemberRole | null,
    now: string,
  ): void {
    const current = this.readPrincipal(principalId);
    if (!current) throw new Error("principal unavailable");
    const grants = projectMembershipGrants({ grants: current.grants, workspaceUid, role });
    this.validateGrantOrganizations(grants);
    this.database
      .prepare(
        "UPDATE principals SET grants_json = ?, grant_version = ?, revocation_epoch = revocation_epoch + 1, updated_at = ? WHERE principal_id = ?",
      )
      .run(JSON.stringify(grants), createOpaqueId("grv_", 16), now, principalId);
  }

  async appendCollabStream(
    actor: CollabStreamCallerLike,
    input: StreamAppendInput,
  ): Promise<StreamAppendResult> {
    this.assertOpen();
    const caller = toStreamActor(actor);
    this.assertStreamAccess(caller, input.containerId, input.segment, "write");
    const result = this.streams.append(this.attestRpcRequest(caller, input));
    // Only a real append wakes readers. A duplicate or a refused write changes nothing to deliver.
    if (result.kind === "appended") {
      for (const listener of this.streamListeners) {
        // One reader's failure must not fail the write that woke it, nor rob the other readers of
        // their notification.
        try {
          listener(input.containerId, input.segment);
        } catch {
          // The listener owns its own recovery; a live reader closes its stream.
        }
      }
    }
    return result;
  }

  /**
   * Notifies a listener whenever a container takes an append, naming the segment so a reader
   * waiting on one of them is not woken by its siblings. Returns the unsubscribe. A listener that
   * throws would otherwise take down the append that woke it, so the plane isolates each call.
   */
  onCollabStreamAppend(listener: (containerId: string, segment: string) => void): () => void {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }

  /**
   * Records that one of a principal's clients is still here, for the presence events ADR-0032 sends
   * to subscribers.
   *
   * The caller supplies only which client it is and what it is looking at. Who they are comes from
   * the credential and when it happened from the plane's clock: a caller that could name the
   * principal would be able to forge another member's presence, and one that could name the time
   * could keep an entry alive past its TTL.
   *
   * Presence is never an authorization input. It says who is here, never what they may do.
   */
  async recordCollabPresence(
    actor: AuthenticatedManagementPrincipal,
    input: { containerId: string; clientId: string; focusAgentId: string | null },
  ): Promise<void> {
    this.assertOpen();
    this.assertContainerMembership(actor, input.containerId);
    const entries = this.presence.get(input.containerId) ?? new Map<string, PresenceEntry>();
    entries.set(`${actor.principalId}:${input.clientId}`, {
      kind: "principal",
      principalId: actor.principalId,
      displayName: actor.displayName,
      clientId: input.clientId,
      focusAgentId: input.focusAgentId,
      heartbeatAt: this.nowIso(),
    });
    this.presence.set(input.containerId, entries);
    for (const listener of this.presenceListeners) {
      // One subscriber's failure must not fail the heartbeat that woke it.
      try {
        listener(input.containerId);
      } catch {
        // The listener owns its own recovery; a live reader closes its stream.
      }
    }
  }

  /** The entries still within their TTL. Everyone who can read the container sees the same list. */
  readCollabPresence(containerId: string): PresenceEntry[] {
    this.assertOpen();
    this.sweepPresence(containerId);
    return [...(this.presence.get(containerId)?.values() ?? [])];
  }

  onCollabPresenceChange(listener: (containerId: string) => void): () => void {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  }

  /**
   * Wakes live readers when membership for a container changes. Long-poll and SSE otherwise wait
   * for an append, so a revoke would sit until the next write or the hold expired.
   */
  onCollabMembershipChange(listener: (containerId: string) => void): () => void {
    this.membershipListeners.add(listener);
    return () => {
      this.membershipListeners.delete(listener);
    };
  }

  private notifyCollabMembershipChange(containerId: string): void {
    for (const listener of this.membershipListeners) {
      try {
        listener(containerId);
      } catch {
        // The listener owns its own recovery; a live reader closes its stream.
      }
    }
  }

  /** Lazy, like the subscription sweep: a timer would outlive a plane that a test never closes. */
  private sweepPresence(containerId: string): void {
    const entries = this.presence.get(containerId);
    if (!entries) return;
    const cutoff = this.clock.nowMs() - PRESENCE_TTL_MS;
    for (const [key, entry] of entries) {
      if (Date.parse(entry.heartbeatAt) <= cutoff) entries.delete(key);
    }
    if (entries.size === 0) this.presence.delete(containerId);
  }

  /**
   * Presence is not a segment, so it cannot go through the segment matrix. Check membership itself
   * rather than borrow some segment's answer and call it the same question. The refusal is worded
   * like every other one here, so a non-member still cannot tell a container they are outside from
   * one that does not exist.
   */
  private assertContainerMembership(
    actor: AuthenticatedManagementPrincipal,
    containerId: string,
  ): void {
    this.assertPrincipalCurrent(actor);
    // ADR-0031: a Workspace without collaboration keeps its bodies off the plane entirely, so an
    // unenabled container refuses every member exactly as a non-member is refused.
    const role = this.readCollabCollaborationEnabled(containerId)
      ? this.readCollabRole(containerId, actor.principalId)
      : null;
    if (!role) throw new Error("stream authorization denied");
  }

  /**
   * A member reads on membership. Anyone else reads only on a content Grant, and only with a
   * `required` audit event written first (ADR-0031, ADR-0037).
   *
   * The audit and the read share one transaction, which is what "before the first byte" means here:
   * if the append fails, nothing is returned. A read performs no writes of its own, so wrapping it
   * costs nothing and buys the all-or-nothing property the ADR asks for.
   */
  async readCollabStream(
    actor: CollabStreamCallerLike,
    input: StreamReadInput,
  ): Promise<StreamReadResult> {
    this.assertOpen();
    const caller = toStreamActor(actor);
    if (this.hasStreamAccess(caller, input.containerId, input.segment, "read")) {
      return this.streams.read(input);
    }
    // Content Grants belong to Principals. A node holds none, so a refused node is simply refused
    // rather than falling through to a path that would audit it as a Grant holder.
    if (caller.kind === "node") throw new Error("stream authorization denied");
    if (!this.allowsContentGrantRead(caller.principal, input.containerId)) {
      // Worded exactly as a member's refusal, so a Grant holder and a stranger cannot be told apart.
      throw new Error("stream authorization denied");
    }
    return transaction(this.database, () => {
      this.appendPlaneAudit({
        action: "collab.content.read",
        outcome: "allowed",
        actorPrincipalId: caller.principal.principalId,
        resourceKind: "workspace",
        resourceId: input.containerId,
        // ADR-0037: identifiers only. The segment names what was opened, never what it held.
        metadata: { segment: input.segment },
      });
      return this.streams.read(input);
    });
  }

  /**
   * Opens a multiplexed subscription (ADR-0032), which the caller then reads by id.
   *
   * Every segment is authorized before the subscription exists, and one refusal fails the whole
   * thing. Accepting just the segments the caller may read would tell them which of the rest they
   * were refused, and would leave them believing they are subscribed to a segment that never
   * delivers.
   *
   * A subscription naming no segments is refused rather than accepted empty: no segments would mean
   * no authorization check ran at all.
   */
  async createCollabSubscription(
    actor: AuthenticatedManagementPrincipal,
    input: { containerId: string; cursors: Readonly<Record<string, string>> },
  ): Promise<CollabSubscriptionCreated> {
    this.assertOpen();
    const segments = Object.keys(input.cursors);
    if (segments.length === 0) throw new Error("subscription names no segments");
    for (const segment of segments) {
      // Subscriptions stay client-only: they are stored against a principalId, and a node resumes
      // from its own cursors on the single-stream route instead.
      this.assertStreamAccess(toStreamActor(actor), input.containerId, segment, "read");
    }
    this.sweepSubscriptions();
    const subscriptionId = createOpaqueId("sub_", 8);
    const expiresAtMs = this.clock.nowMs() + COLLAB_SUBSCRIPTION_TTL_MS;
    this.subscriptions.set(subscriptionId, {
      containerId: input.containerId,
      principalId: actor.principalId,
      cursors: { ...input.cursors },
      expiresAtMs,
    });
    return {
      subscriptionId,
      containerId: input.containerId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Reads one poll of an open subscription and advances its cursors.
   *
   * Authorization runs again on every read rather than only at creation: membership can be revoked
   * while a subscription is open, and the stored cursors must not outlive the grant that justified
   * them. An unknown, expired, or someone else's id all raise the same refusal, so an id cannot be
   * used to learn that a subscription exists.
   */
  async readCollabSubscriptionById(
    actor: AuthenticatedManagementPrincipal,
    subscriptionId: string,
  ): Promise<CollabSubscriptionEvent[]> {
    this.assertOpen();
    this.sweepSubscriptions();
    const record = this.subscriptions.get(subscriptionId);
    if (!record || record.principalId !== actor.principalId) {
      throw new Error("stream authorization denied");
    }
    for (const segment of Object.keys(record.cursors)) {
      this.assertStreamAccess(toStreamActor(actor), record.containerId, segment, "read");
    }
    const events = collectSubscriptionEvents({
      store: this.streams,
      containerId: record.containerId,
      cursors: record.cursors,
    });
    let overflowed = false;
    for (const event of events) {
      if (event.type !== "control") continue;
      record.cursors[event.segment] = event.nextOffset;
      if (event.overflow === true) overflowed = true;
    }
    // ADR-0032: overflow closes the subscription. The cursors were advanced first, so the control
    // event the caller just received tells them where to resume when they open a new one.
    if (overflowed) this.subscriptions.delete(subscriptionId);
    else record.expiresAtMs = this.clock.nowMs() + COLLAB_SUBSCRIPTION_TTL_MS;
    return events;
  }

  /**
   * The container an open subscription belongs to, for picking the audience a stream token must
   * have been minted for. This is not an authorization step and answers before any credential is
   * checked: the caller still has to get past readCollabSubscriptionById.
   */
  readCollabSubscriptionContainer(subscriptionId: string): string | null {
    this.assertOpen();
    this.sweepSubscriptions();
    return this.subscriptions.get(subscriptionId)?.containerId ?? null;
  }

  /** Expiry is lazy: a timer would outlive the tests that create a plane and never close it. */
  private sweepSubscriptions(): void {
    const now = this.clock.nowMs();
    for (const [id, record] of this.subscriptions) {
      if (record.expiresAtMs <= now) this.subscriptions.delete(id);
    }
  }

  /**
   * Authorizes one stream operation by membership and the segment matrix (ADR-0032, ADR-0033).
   *
   * Every refusal raises the same error, so a caller cannot tell a Workspace they are not a member
   * of from one that does not exist, or a closed segment from a mistyped one (master spec §22.1).
   * Platform administration is not membership: identity.manage grants no stream access.
   */
  /**
   * Whether membership alone allows this operation. Non-throwing, because the Boss read path needs
   * to ask the question without treating a refusal as an error — and catching the throw instead
   * would have swallowed an expired or revoked Principal along with it.
   */
  private hasStreamAccess(
    actor: CollabStreamActor,
    containerId: string,
    segment: string,
    operation: "read" | "write",
  ): boolean {
    if (actor.kind === "node") {
      return this.hasNodeStreamAccess(actor.node, containerId, segment)[operation];
    }
    this.assertPrincipalCurrent(actor.principal);
    const parsed = parseCollabSegment(segment);
    // ADR-0031: a Workspace without collaboration keeps its bodies off the plane entirely, so an
    // unenabled container refuses every member exactly as a non-member is refused.
    const role =
      parsed && this.readCollabCollaborationEnabled(containerId)
        ? this.readCollabRole(containerId, actor.principal.principalId)
        : null;
    const access = parsed
      ? streamAccess({ containerId, segment: parsed, role })
      : { read: false, write: false };
    return access[operation];
  }

  /**
   * A node's authority over a container is placement, not membership (ADR-0032). Re-checked on
   * every call rather than only at the signature step, so a node that is disabled or whose
   * Workspace moves away loses access to an open stream immediately.
   */
  private hasNodeStreamAccess(
    node: ManagedNode,
    containerId: string,
    segment: string,
  ): StreamAccess {
    const current = this.readNode(node.nodeId);
    if (!current || ["disabled", "revoked"].includes(current.status)) {
      return { read: false, write: false };
    }
    const parsed = parseCollabSegment(segment);
    if (!parsed || !this.isContainerPlacedOnNode(containerId, node.nodeId)) {
      return { read: false, write: false };
    }
    return streamAccess({ containerId, segment: parsed, role: null, caller: "node" });
  }

  /**
   * Whether this container is a collaborating Workspace hosted by this node. Same join the node
   * policy uses, so a node reaches exactly the Workspaces its policy already told it about.
   */
  private isContainerPlacedOnNode(containerId: string, nodeId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM collab_workspaces w
           JOIN placements p
             ON p.organization_id = w.organization_id
            AND p.local_resource_id = w.local_workspace_id
            AND p.resource_kind = 'workspace'
           WHERE w.organization_id = ? AND w.workspace_uid = ? AND p.node_id = ?
             AND w.collaboration_enabled = 1`,
        )
        .get(this.options.organizationId, containerId, nodeId) !== undefined
    );
  }

  private assertStreamAccess(
    actor: CollabStreamActor,
    containerId: string,
    segment: string,
    operation: "read" | "write",
  ): void {
    if (!this.hasStreamAccess(actor, containerId, segment, operation)) {
      throw new Error("stream authorization denied");
    }
  }

  /**
   * Whether a non-member may read this container's bodies on a content Grant (ADR-0031). Reads
   * only: a Grant of this kind never writes, so appendCollabStream stays members-only.
   *
   * Checked against the container uid, because that is what the plane's own membership projection
   * writes into a workspace selector. A Grant an administrator wrote against the *local* workspace
   * id will not match here — both identifier spaces occur in workspaceIds today, since
   * resolveWorkspace checks the local one — and that inconsistency predates this path.
   */
  private allowsContentGrantRead(
    actor: AuthenticatedManagementPrincipal,
    containerId: string,
  ): boolean {
    if (!this.readCollabCollaborationEnabled(containerId)) return false;
    const row = this.row(
      this.database
        .prepare(
          "SELECT owner_principal_id FROM collab_workspaces WHERE workspace_uid = ? AND organization_id = ?",
        )
        .get(containerId, this.options.organizationId),
    );
    if (!row) return false;
    return this.allowsResource(
      actor,
      "workspace.content.read",
      String(row.owner_principal_id),
      containerId,
    );
  }

  private readCollabCollaborationEnabled(containerId: string): boolean {
    const row = this.row(
      this.database
        .prepare(
          "SELECT collaboration_enabled FROM collab_workspaces WHERE workspace_uid = ? AND organization_id = ?",
        )
        .get(containerId, this.options.organizationId),
    );
    return row ? Number(row.collaboration_enabled) === 1 : false;
  }

  /**
   * Attaches the plane's attestation to a machine RPC request, and leaves every other append
   * exactly as it arrived (ADR-0035).
   *
   * This is the one segment whose bytes the plane rewrites. Everywhere else it stores what it was
   * given without reading it; here it has to, because the node acts on an RPC only on the strength
   * of a signature it can check, and a member appending the envelope cannot produce one.
   *
   * The requester's identity comes from the credential, never from the envelope. The client id does
   * come from the envelope — the plane has no other source for it, and it names which of one
   * person's devices asked rather than who they are, so a caller naming another device still only
   * ever reaches their own.
   */
  private attestRpcRequest(actor: CollabStreamActor, input: StreamAppendInput): StreamAppendInput {
    const segment = parseCollabSegment(input.segment);
    if (!segment || segment.kind !== "rpc_request") return input;
    // Only members write this segment, which assertStreamAccess has already enforced.
    if (actor.kind !== "principal") throw new Error("stream authorization denied");

    let envelope: MachineRpcClientRequest;
    try {
      envelope = MachineRpcClientRequestSchema.parse(
        JSON.parse(Buffer.from(input.update).toString("utf8")),
      );
    } catch (error) {
      throw new Error("invalid machine rpc envelope", { cause: error });
    }
    if (envelope.nodeId !== segment.nodeId || envelope.containerId !== input.containerId) {
      throw new Error("machine rpc envelope does not match its segment");
    }

    const policy = machineRpcMethodPolicy(envelope.method);
    // An unlisted method is refused here rather than at the node: the allowlist is the plane's to
    // apply before it signs anything, and an attested request is one the node will act on.
    if (!policy) throw new Error("machine rpc method not allowed");
    const role = this.readCollabCollaborationEnabled(input.containerId)
      ? this.readCollabRole(input.containerId, actor.principal.principalId)
      : null;
    if (!role || !roleAllowsMachineRpcMethod(role, policy)) {
      throw new Error("machine rpc method authorization denied");
    }

    const issuedAtMs = this.clock.nowMs();
    const attestation = signMachineRpcAttestation(
      {
        rpcId: envelope.rpcId,
        method: envelope.method,
        nodeId: envelope.nodeId,
        containerId: envelope.containerId,
        requester: {
          principalId: actor.principal.principalId,
          credentialId: actor.principal.credentialId,
          grantVersion: actor.principal.grantVersion,
          clientId: envelope.clientId,
        },
        sentAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(issuedAtMs + MACHINE_RPC_DEFAULT_TTL_MS).toISOString(),
      },
      this.options.ticketPrivateKey,
    );
    return {
      ...input,
      update: new TextEncoder().encode(JSON.stringify({ ...envelope, attestation })),
    };
  }

  private readCollabRole(containerId: string, principalId: string): WorkspaceMemberRole | null {
    const row = this.row(
      this.database
        .prepare(
          `SELECT m.role FROM collab_members m
           JOIN collab_workspaces w ON w.workspace_uid = m.workspace_uid
           WHERE m.workspace_uid = ? AND m.principal_id = ? AND w.organization_id = ?`,
        )
        .get(containerId, principalId, this.options.organizationId),
    );
    return row ? (String(row.role) as WorkspaceMemberRole) : null;
  }

  async uploadRuntimeArtifact(
    actor: AuthenticatedManagementPrincipal,
    input: RuntimeArtifactUpload,
  ): Promise<RuntimeArtifactRecord> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    return this.runtimes.storeArtifact({ ...input, uploadedBy: actor.principalId });
  }

  async listRuntimeArtifacts(
    actor: AuthenticatedManagementPrincipal,
  ): Promise<readonly RuntimeArtifactRecord[]> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    return this.runtimes.listArtifacts();
  }

  async getRuntimePolicy(
    actor: AuthenticatedManagementPrincipal,
  ): Promise<ManagedRuntimePolicy | null> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    return this.runtimes.currentPolicy();
  }

  async setRuntimePin(
    actor: AuthenticatedManagementPrincipal,
    runtimeName: string,
    input: ManagedRuntimePinUpdate,
  ): Promise<ManagedRuntimePolicy> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    return this.runtimes.setPin(runtimeName, { ...input, updatedBy: actor.principalId });
  }

  async updateRuntimePolicySettings(
    actor: AuthenticatedManagementPrincipal,
    input: ManagedRuntimePolicySettingsUpdate,
  ): Promise<ManagedRuntimePolicy> {
    this.assertOpen();
    this.assertActor(actor, "identity.manage");
    return this.runtimes.updateSettings({ ...input, updatedBy: actor.principalId });
  }

  async listNodeRuntimeStatus(actor: AuthenticatedManagementPrincipal): Promise<
    readonly {
      readonly nodeId: string;
      readonly status: ManagedNode["status"];
      readonly runtimes: readonly ManagedRuntimeCapabilityStatus[];
    }[]
  > {
    return (await this.listNodes(actor)).map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      runtimes: parseManagedRuntimeCapabilities(node.capabilities),
    }));
  }

  getNodeRuntimePolicy(nodeId: string): ManagedRuntimePolicy | null {
    this.assertOpen();
    this.requireNode(nodeId);
    return this.runtimes.currentPolicy();
  }

  nodeRuntimeArtifactPath(nodeId: string, sha256: string): string {
    this.assertOpen();
    this.requireNode(nodeId);
    const filePath = this.runtimes.artifactFilePath(sha256);
    if (!filePath) throw new Error("runtime artifact not found");
    return filePath;
  }

  authenticateSignedNodeRequest(
    authentication: NodeRequestAuthentication,
    // Buffer as well as string: a data-plane append is a Loro update, and decoding it as UTF-8 to
    // sign it would not round-trip. The digest underneath already takes either.
    input: { readonly method: string; readonly path: string; readonly body: string | Buffer },
  ): ManagedNode {
    return this.authenticateNodeRequest(authentication, input);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.clear();
    this.streamListeners.clear();
    this.presence.clear();
    this.presenceListeners.clear();
    this.membershipListeners.clear();
    this.database.close();
  }

  private authenticateNodeRequest(
    authentication: NodeRequestAuthentication,
    input: { readonly method: string; readonly path: string; readonly body: string | Buffer },
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

  /** `expiresAt` null keeps the personal-access-token behaviour: a credential that does not lapse. */
  private async issueCredentialUnchecked(
    principalId: string,
    expiresAt: string | null = null,
  ): Promise<{ readonly token: string; readonly credentialId: string }> {
    const credentialId = createOpaqueId("cred_", 12);
    const token = createSecretToken(CREDENTIAL_TOKEN_PREFIX, credentialId);
    const digest = await digestSecret(token.secret);
    this.database
      .prepare(
        "INSERT INTO credentials (credential_id, principal_id, secret_salt, secret_digest, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      )
      .run(credentialId, principalId, digest.salt, digest.digest, this.nowIso(), expiresAt);
    return Object.freeze({ token: token.token, credentialId });
  }

  /**
   * Signs a human in against the plane itself (ADR-0035, which amends ADR-0030's "password login is
   * available only for direct node connections").
   *
   * A session is an ordinary credential with an expiry, not a new token type with its own table and
   * signing domain. `credentials` already carries expiry, revocation and a hashed secret, and
   * authenticatePersonalAccessToken already honours all three, so a session reaches every
   * authenticated route — POST /v1/streams/token among them — with no second code path to keep
   * right. A third signed token would also need its own domain separator to avoid verifying as a
   * Session ticket or a stream token.
   *
   * The lifetime is the plane's, not the caller's. The node ticket route lets a client name one
   * because that ticket is handed to a node and capped at five minutes; a session a client could
   * size itself would only ever be requested at the maximum.
   */
  async issuePlaneSessionWithPassword(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<{
    readonly token: string;
    readonly credentialId: string;
    readonly expiresAt: string;
  }> {
    this.assertOpen();
    const principal = await this.authenticatePassword(input.username, input.password);
    if (!principal) throw new Error("invalid credential");
    const expiresAt = new Date(this.clock.nowMs() + PLANE_SESSION_TTL_MS).toISOString();
    const credential = await this.issueCredentialUnchecked(principal.principalId, expiresAt);
    return Object.freeze({ ...credential, expiresAt });
  }

  private issueNodeSessionTicketForPrincipal(
    principal: AuthenticatedManagementPrincipal,
    input: { readonly nodeId: string; readonly clientId: string; readonly ttlMs: number },
  ): { readonly ticket: string; readonly endpoint: string; readonly expiresAt: string } {
    this.assertPrincipalCurrent(principal);
    this.assertSessionTicketLifetime(input.ttlMs);
    const node = this.requireNode(input.nodeId);
    if (node.status !== "active") throw new Error(`node is ${node.status}`);
    return this.signNodeSessionTicket(principal, node, input.clientId, input.ttlMs);
  }

  private signNodeSessionTicket(
    principal: AuthenticatedManagementPrincipal,
    node: ManagedNode,
    clientId: string,
    ttlMs: number,
  ): { readonly ticket: string; readonly endpoint: string; readonly expiresAt: string } {
    if (clientId.length === 0 || clientId.length > 160) throw new Error("invalid client ID");
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
      clientId,
      grantVersion: principal.grantVersion,
      revocationEpoch: principal.revocationEpoch,
      nodeId: node.nodeId,
      paseoServerId: node.paseoServerId,
      grants: structuredClone(principal.grants),
      issuedAtMs,
      notBeforeMs: issuedAtMs,
      expiresAtMs: issuedAtMs + ttlMs,
    };
    return Object.freeze({
      ticket: signSessionTicket(claims, this.options.ticketPrivateKey),
      endpoint: node.endpoint,
      expiresAt: new Date(claims.expiresAtMs).toISOString(),
    });
  }

  private assertSessionTicketLifetime(ttlMs: number): void {
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_SESSION_TICKET_TTL_MS) {
      throw new Error("invalid ticket lifetime");
    }
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

  private requirePrincipalCredential(principalId: string, credentialId: string): void {
    const row = this.row(
      this.database
        .prepare(
          "SELECT credential_id FROM credentials WHERE credential_id = ? AND principal_id = ? AND revoked_at IS NULL",
        )
        .get(credentialId, principalId),
    );
    if (!row) throw new Error("principal unavailable");
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

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new Error("invalid username");
  return username;
}

function assertPassword(value: string): void {
  if (value.length < 12 || value.length > 128) throw new Error("invalid password");
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
CREATE TABLE IF NOT EXISTS password_credentials (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
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
  -- Nullable because node-ingested rows carry no hash yet; making them NOT NULL would break node
  -- audit the moment this lands.
  previous_hash TEXT,
  event_hash TEXT,
  UNIQUE (node_id, node_event_seq)
);
CREATE TABLE IF NOT EXISTS audit_node_state (
  node_id TEXT PRIMARY KEY REFERENCES nodes(node_id),
  last_sequence INTEGER NOT NULL
);
`;
