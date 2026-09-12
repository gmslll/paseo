import {
  BrowserProfileIdSchema,
  BrowserProfileRecordSchema,
  FencedLeaseSchema,
  EnterpriseResourceOwnerSchema,
  LeaseIdSchema,
  type AuthorizedAgent,
  type AuthorizedBrowserProfile,
  type AuthorizedWorkspace,
  type FencedLease,
  type AuditSink,
  type AuditEventInput,
  type LeaseCoordinator,
  type LeaseReleaseInput,
} from "@getpaseo/protocol/messages";
import type { EnterpriseAgentContextHandle } from "../../session/enterprise-agent-session-context-registry.js";
import { z } from "zod";

const LeaseGenerationSnapshotSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    nextFencingToken: z.number().int().positive(),
  })
  .strict();
const AcquireInputSchema = z
  .object({
    handle: z.custom<EnterpriseAgentContextHandle>(isObject),
    resourceId: BrowserProfileIdSchema,
    mode: z.enum(["read", "write"]),
    ttlMs: z.number().int().positive(),
  })
  .strict();
const LeaseAuthorizationSchema = z
  .object({
    workspace: EnterpriseResourceOwnerSchema.extend({ workspaceId: z.string().min(1) }).strict(),
    agent: EnterpriseResourceOwnerSchema.extend({
      agentId: z.string().min(1),
      workspaceId: z.string().min(1),
    }).strict(),
    profile: BrowserProfileRecordSchema.strict(),
    bindingRevision: z.string().min(1),
  })
  .strict();
const LeaseAccessInputSchema = z
  .object({
    handle: z.custom<EnterpriseAgentContextHandle>(isObject),
    lease: FencedLeaseSchema,
  })
  .strict();
const RenewInputSchema = LeaseAccessInputSchema.extend({
  ttlMs: z.number().int().positive(),
}).strict();
const AttachHostInputSchema = LeaseAccessInputSchema.extend({
  hostClientId: z.string().min(1),
}).strict();
const LeaseRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Invalid lease request ID.");
const CancelInputSchema = z
  .object({
    handle: z.custom<EnterpriseAgentContextHandle>(isObject),
    requestId: LeaseRequestIdSchema,
  })
  .strict();

const MAX_ID_ALLOCATION_ATTEMPTS = 16;
const MAX_WAITING_ERROR_LIMIT = 1_024;
const DEFAULT_WAITING_ERROR_LIMIT = 64;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface BrowserProfileLeaseAcquireInput {
  handle: EnterpriseAgentContextHandle;
  resourceId: string;
  mode: "read" | "write";
  ttlMs: number;
}
export interface BrowserProfileLeaseAuthorization {
  workspace: AuthorizedWorkspace;
  agent: AuthorizedAgent;
  profile: AuthorizedBrowserProfile;
  bindingRevision: string;
}
interface ResolvedAcquireInput {
  handle: EnterpriseAgentContextHandle;
  workspace: AuthorizedWorkspace;
  agent: AuthorizedAgent;
  profile: AuthorizedBrowserProfile;
  bindingRevision: string;
  mode: "read" | "write";
  ttlMs: number;
}
export type BrowserProfileLeaseGenerationSnapshot = z.infer<typeof LeaseGenerationSnapshotSchema>;

export interface BrowserProfileLeaseGenerationStorage {
  read(): Promise<unknown | null>;
  write(snapshot: BrowserProfileLeaseGenerationSnapshot): Promise<void>;
}

export interface BrowserLeaseScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BrowserProfileLeaseWaitingNotice {
  requestId: string;
  agentId: string;
  workspaceId: string;
  resourceId: string;
  mode: "read" | "write";
  position: number;
}

export interface BrowserProfileLeaseContextualWaitingNotice extends BrowserProfileLeaseWaitingNotice {
  /** Existing registry-minted nominal handle; never forwarded to a client or Session sink. */
  readonly context: EnterpriseAgentContextHandle;
}

export interface BrowserProfileLeaseManagerOptions {
  generationStorage: BrowserProfileLeaseGenerationStorage;
  clock?: BrowserLeaseScheduler;
  createLeaseId: () => string;
  createRequestId: () => string;
  auditSink: AuditSink;
  maxLeaseTtlMs: number;
  leaseCoordinator?: LeaseCoordinator;
  isCurrentHandle: (handle: EnterpriseAgentContextHandle) => boolean;
  resolveAuthorization: (
    handle: EnterpriseAgentContextHandle,
    browserProfileId: string,
  ) => BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
  onWaiting?: (notice: BrowserProfileLeaseWaitingNotice) => void | Promise<void>;
  onWaitingWithContext?: (
    notice: BrowserProfileLeaseContextualWaitingNotice,
  ) => void | Promise<void>;
  onError?: (error: Error) => void;
  waitingErrorLimit?: number;
  initialLeaseRevision?: number;
}

export interface BrowserProfileLeaseAccessInput {
  handle: EnterpriseAgentContextHandle;
  lease: FencedLease;
}

export interface BrowserProfileLeaseRenewInput extends BrowserProfileLeaseAccessInput {
  ttlMs: number;
}

export interface BrowserProfileLeaseAttachHostInput extends BrowserProfileLeaseAccessInput {
  hostClientId: string;
}

export interface BrowserProfileLeaseCancelInput {
  handle: EnterpriseAgentContextHandle;
  requestId: string;
}

interface PendingRequest {
  requestId: string;
  resolved: ResolvedAcquireInput;
  resolve: (lease: FencedLease) => void;
  reject: (error: Error) => void;
  waitingReady: boolean;
  notificationTimer?: unknown;
}

interface ActiveLease {
  lease: FencedLease;
  authorization: ResolvedAcquireInput;
  hostClientId?: string;
  timer?: unknown;
}

const LEASE_AUDIT_REASON = {
  acquired: "lease_acquired",
  renewed: "lease_renewed",
  released: "lease_released",
  expired: "lease_expired",
  auditUnavailable: "lease_audit_unavailable",
  publicationFailed: "lease_acquire_publication_failed",
  agentInvalidated: "lease_invalidated_agent",
  sessionInvalidated: "lease_invalidated_session",
  hostInvalidated: "lease_invalidated_host",
} as const;
type LeaseAuditReason = (typeof LEASE_AUDIT_REASON)[keyof typeof LEASE_AUDIT_REASON];

const defaultScheduler: BrowserLeaseScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class BrowserProfileLeaseManager {
  private readonly clock: BrowserLeaseScheduler;
  private readonly active = new Map<string, ActiveLease>();
  private readonly queues = new Map<string, PendingRequest[]>();
  private readonly reservedLeaseIds = new Set<string>();
  private readonly liveRequestIds = new Set<string>();
  private readonly granting = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly drainAgain = new Set<string>();
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private initialization: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private initialized = false;
  private closed = false;
  private corruptError: Error | null = null;
  private clockError: Error | null = null;
  private generation = 0;
  private nextFencingToken = 1;
  private waitingErrors: Array<{ error: Error; recordedAt: number }> = [];
  private leaseRevision: number;
  private readonly waitingErrorLimit: number;
  private lastNow: number | null = null;

  public constructor(private readonly options: BrowserProfileLeaseManagerOptions) {
    this.clock = options.clock ?? defaultScheduler;
    if (!Number.isSafeInteger(options.maxLeaseTtlMs) || options.maxLeaseTtlMs <= 0)
      throw new Error("maxLeaseTtlMs must be a positive safe integer.");
    const waitingErrorLimit = options.waitingErrorLimit ?? DEFAULT_WAITING_ERROR_LIMIT;
    if (
      !Number.isSafeInteger(waitingErrorLimit) ||
      waitingErrorLimit <= 0 ||
      waitingErrorLimit > MAX_WAITING_ERROR_LIMIT
    )
      throw new Error("waitingErrorLimit must be a positive safe integer no greater than 1024.");
    this.waitingErrorLimit = waitingErrorLimit;
    const initialLeaseRevision = options.initialLeaseRevision ?? 0;
    if (!Number.isSafeInteger(initialLeaseRevision) || initialLeaseRevision < 0)
      throw new Error("initialLeaseRevision must be a nonnegative safe integer.");
    this.leaseRevision = initialLeaseRevision;
  }

  public async initialize(): Promise<void> {
    if (this.corruptError) throw this.corruptError;
    if (this.clockError) throw this.clockError;
    if (this.closed) throw new Error("Browser Profile lease manager is closed.");
    if (this.initialized) return;
    this.initialization ??= this.track(this.loadGeneration());
    try {
      await this.initialization;
    } finally {
      if (!this.initialized && !this.corruptError) this.initialization = null;
    }
  }

  public async acquire(input: BrowserProfileLeaseAcquireInput): Promise<FencedLease> {
    const parsed = parseInput(AcquireInputSchema, input, "Browser Profile lease acquisition");
    this.assertCurrentHandle(parsed.handle);
    this.assertTtl(parsed.ttlMs);
    await this.initialize();
    this.assertCurrentHandle(parsed.handle);
    const authorization = await this.resolveAuthorization(parsed.handle, parsed.resourceId);
    this.assertCurrentHandle(parsed.handle);
    const resolved: ResolvedAcquireInput = {
      ...authorization,
      handle: parsed.handle,
      mode: parsed.mode,
      ttlMs: parsed.ttlMs,
    };
    return this.enqueueOrGrantInitialized(resolved);
  }

  private async resolveAuthorization(
    handle: EnterpriseAgentContextHandle,
    browserProfileId: string,
  ): Promise<Omit<ResolvedAcquireInput, "mode" | "ttlMs">> {
    this.assertCurrentHandle(handle);
    const resolved = await this.options.resolveAuthorization(handle, browserProfileId);
    this.assertCurrentHandle(handle);
    const parsed = LeaseAuthorizationSchema.parse(resolved);
    assertResolvedAuthorization(handle, browserProfileId, parsed);
    return { ...parsed, handle };
  }

  private async assertCurrentAuthorization(
    active: ActiveLease,
    handle: EnterpriseAgentContextHandle,
    lease: FencedLease,
  ): Promise<void> {
    this.assertActiveIdentity(active, handle, lease);
    const authorization = await this.resolveAuthorization(handle, active.lease.resourceId);
    this.assertActiveIdentity(active, handle, lease);
    assertAuthorizationSame(active.authorization, authorization);
    assertLeaseAuthorization(active.lease, authorization);
  }

  private async resolveTrustedInput(input: ResolvedAcquireInput): Promise<ResolvedAcquireInput> {
    const authorization = await this.resolveAuthorization(
      input.handle,
      input.profile.browserProfileId,
    );
    this.assertCurrentHandle(input.handle);
    return { ...authorization, mode: input.mode, ttlMs: input.ttlMs };
  }

  public async renew(input: BrowserProfileLeaseRenewInput): Promise<FencedLease> {
    const parsed = parseInput(RenewInputSchema, input, "Browser Profile lease renewal");
    this.assertCurrentHandle(parsed.handle);
    this.assertTtl(parsed.ttlMs);
    await this.initialize();
    this.assertCurrentHandle(parsed.handle);
    const active = this.getActive(parsed.handle, parsed.lease);
    await this.assertCurrentAuthorization(active, parsed.handle, parsed.lease);
    this.assertActiveIdentity(active, parsed.handle, parsed.lease);
    if (this.options.leaseCoordinator) {
      const renewed = FencedLeaseSchema.parse(
        await this.options.leaseCoordinator.renew({
          ...leaseReleaseInput(active.lease),
          ttlMs: parsed.ttlMs,
        }),
      );
      this.assertActiveIdentity(active, parsed.handle, parsed.lease);
      assertCoordinatedLeaseRenewal(renewed, active.lease);
      active.lease = renewed;
      active.authorization = { ...active.authorization, ttlMs: parsed.ttlMs };
      this.arm(active, Math.max(1, Date.parse(renewed.expiresAt) - this.readNow()));
      this.observeLeaseAudit(active, "allowed", LEASE_AUDIT_REASON.renewed);
      return cloneLease(renewed);
    }
    const now = this.readNow(parsed.ttlMs);
    const renewed = FencedLeaseSchema.parse({
      ...active.lease,
      leaseRevision: this.nextRevision(),
      heartbeatAt: isoTimestamp(now),
      expiresAt: isoTimestamp(now + parsed.ttlMs),
    });
    active.lease = renewed;
    active.authorization = { ...active.authorization, ttlMs: parsed.ttlMs };
    this.arm(active, parsed.ttlMs);
    this.observeLeaseAudit(active, "allowed", LEASE_AUDIT_REASON.renewed);
    return cloneLease(renewed);
  }

  public async releaseLease(input: BrowserProfileLeaseAccessInput): Promise<void> {
    const parsed = parseInput(LeaseAccessInputSchema, input, "Browser Profile lease release");
    this.assertCurrentHandle(parsed.handle);
    await this.initialize();
    this.assertCurrentHandle(parsed.handle);
    const active = this.getActive(parsed.handle, parsed.lease);
    this.deactivate(active);
    let releaseFailure: unknown = null;
    try {
      await this.releaseCoordinatedLease(active);
    } catch (error) {
      releaseFailure = error;
    }
    await this.track(this.appendLeaseAudit(active, "allowed", LEASE_AUDIT_REASON.released));
    await this.track(this.drain(leaseKey(parsed.lease)));
    if (releaseFailure) throw releaseFailure;
  }

  public async validateLease(input: BrowserProfileLeaseAccessInput): Promise<FencedLease> {
    const parsed = parseInput(LeaseAccessInputSchema, input, "Browser Profile lease validation");
    this.assertCurrentHandle(parsed.handle);
    await this.initialize();
    this.assertCurrentHandle(parsed.handle);
    const active = this.getActive(parsed.handle, parsed.lease);
    await this.assertCurrentAuthorization(active, parsed.handle, parsed.lease);
    this.assertActiveIdentity(active, parsed.handle, parsed.lease);
    if (this.options.leaseCoordinator) {
      const validateCoordinatedLease = this.options.leaseCoordinator.validate;
      if (!validateCoordinatedLease) {
        throw new Error("Managed lease coordinator validation is unavailable.");
      }
      const validated = FencedLeaseSchema.parse(
        await validateCoordinatedLease.call(
          this.options.leaseCoordinator,
          leaseReleaseInput(active.lease),
        ),
      );
      this.assertActiveIdentity(active, parsed.handle, parsed.lease);
      assertLeaseMatch(validated, active.lease);
    }
    const now = this.readNow();
    if (Date.parse(active.lease.expiresAt) <= now) {
      await this.expireActive(active);
      throw new Error("Lease is expired or inactive.");
    }
    return cloneLease(active.lease);
  }

  public async attachHost(input: BrowserProfileLeaseAttachHostInput): Promise<void> {
    const parsed = parseInput(AttachHostInputSchema, input, "Browser Profile host attachment");
    this.assertCurrentHandle(parsed.handle);
    await this.validateLease({ handle: parsed.handle, lease: parsed.lease });
    const active = this.getActive(parsed.handle, parsed.lease);
    active.hostClientId = parsed.hostClientId;
  }

  public async invalidateAgent(agentId: string): Promise<void> {
    await this.invalidate(
      (item) => item.lease.holderAgentId === agentId,
      (item) => item.resolved.handle.agentId === agentId,
      "Agent ended; lease invalidated.",
      LEASE_AUDIT_REASON.agentInvalidated,
    );
  }

  public async invalidateSession(sessionBindingGeneration: string): Promise<void> {
    await this.invalidate(
      (item) =>
        item.authorization.handle.context.sessionBindingGeneration === sessionBindingGeneration,
      (item) => item.resolved.handle.context.sessionBindingGeneration === sessionBindingGeneration,
      "Session ended; lease invalidated.",
      LEASE_AUDIT_REASON.sessionInvalidated,
    );
  }

  public async invalidateHost(hostClientId: string): Promise<void> {
    await this.invalidate(
      (item) => item.hostClientId === hostClientId,
      () => false,
      "Host ended; lease invalidated.",
      LEASE_AUDIT_REASON.hostInvalidated,
    );
  }

  public cancel(input: BrowserProfileLeaseCancelInput): boolean {
    const parsed = CancelInputSchema.safeParse(input);
    if (!parsed.success || !this.isCurrentHandle(parsed.data.handle)) return false;
    for (const [key, queue] of this.queues) {
      const index = queue.findIndex((request) => request.requestId === parsed.data.requestId);
      if (index < 0) continue;
      const request = queue[index];
      if (!request) return false;
      if (request.resolved.handle !== parsed.data.handle) return false;
      queue.splice(index, 1);
      this.releaseRequest(request);
      request.reject(new Error("Lease wait canceled."));
      if (queue.length === 0) this.queues.delete(key);
      this.observeDrain(key);
      return true;
    }
    return false;
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const coordinated = Array.from(this.active.values());
      for (const active of coordinated) this.deactivate(active);
      this.active.clear();
      for (const queue of this.queues.values()) {
        for (const request of queue) {
          this.releaseRequest(request);
          request.reject(new Error("Daemon ended; lease wait canceled."));
        }
      }
      this.queues.clear();
      for (const active of coordinated) {
        try {
          await this.releaseCoordinatedLease(active);
        } catch (error) {
          this.recordError(error);
        }
      }
      await this.waitForIdle();
      if (
        this.active.size > 0 ||
        this.queues.size > 0 ||
        this.granting.size > 0 ||
        this.reservedLeaseIds.size > 0 ||
        this.liveRequestIds.size > 0
      )
        throw new Error("Browser Profile lease manager close did not drain all leases.");
    })();
    return this.closePromise;
  }

  public getWaitingErrors(): readonly Error[] {
    this.pruneWaitingErrors(this.readNow());
    return this.waitingErrors.map((entry) => entry.error);
  }

  public consumeWaitingErrors(): Error[] {
    this.pruneWaitingErrors(this.readNow());
    return this.waitingErrors.splice(0).map((entry) => entry.error);
  }

  public async waitForIdle(): Promise<void> {
    while (this.pendingOperations.size > 0)
      await Promise.allSettled(Array.from(this.pendingOperations));
    await Promise.resolve();
  }

  private async loadGeneration(): Promise<void> {
    try {
      const raw = await this.options.generationStorage.read();
      const snapshot = LeaseGenerationSnapshotSchema.parse(
        raw ?? { version: 1, generation: 0, nextFencingToken: 1 },
      );
      if (
        snapshot.generation >= Number.MAX_SAFE_INTEGER ||
        snapshot.nextFencingToken >= Number.MAX_SAFE_INTEGER
      )
        throw new Error("Lease generation state exhausted.");
      this.generation = snapshot.generation + 1;
      this.nextFencingToken = snapshot.nextFencingToken;
      await this.options.generationStorage.write({
        version: 1,
        generation: this.generation,
        nextFencingToken: this.nextFencingToken,
      });
      if (this.closed) throw new Error("Daemon ended during lease initialization.");
      this.initialized = true;
    } catch (error) {
      this.corruptError = new Error("Browser Profile lease generation state is corrupt.", {
        cause: error,
      });
      throw this.corruptError;
    }
  }

  private enqueueOrGrantInitialized(input: ResolvedAcquireInput): Promise<FencedLease> {
    if (this.closed) return Promise.reject(new Error("Browser Profile lease manager is closed."));
    if (this.clockError) return Promise.reject(this.clockError);
    const key = resourceKey(input);
    const queue = this.queues.get(key) ?? [];
    if (this.canGrant(input, queue)) {
      this.granting.add(key);
      const grant = this.track(this.grant(input));
      void grant.then(
        () => {
          this.granting.delete(key);
          this.observeDrain(key);
          return undefined;
        },
        () => {
          this.granting.delete(key);
          this.observeDrain(key);
          return undefined;
        },
      );
      return grant;
    }
    const requestId = this.allocateRequestId();
    const position = queue.length + 1;
    return new Promise<FencedLease>((resolve, reject) => {
      const request: PendingRequest = {
        requestId,
        resolved: input,
        resolve,
        reject,
        waitingReady: false,
      };
      queue.push(request);
      this.queues.set(key, queue);
      request.notificationTimer = this.clock.setTimeout(
        () => this.failWaitingRequest(key, request, "Lease wait status timed out."),
        2_000,
      );
      const notice: BrowserProfileLeaseWaitingNotice = {
        requestId,
        agentId: input.agent.agentId,
        workspaceId: input.workspace.workspaceId,
        resourceId: input.profile.browserProfileId,
        mode: input.mode,
        position,
      };
      const notification = Promise.resolve()
        .then(() => {
          if (this.options.onWaitingWithContext) {
            return this.options.onWaitingWithContext(
              Object.freeze({
                ...notice,
                context: input.handle,
              }),
            );
          }
          return this.options.onWaiting?.(notice);
        })
        .then(() => {
          if (this.closed || this.queues.get(key)?.includes(request) !== true) return undefined;
          request.waitingReady = true;
          if (request.notificationTimer !== undefined)
            this.clock.clearTimeout(request.notificationTimer);
          this.observeDrain(key);
          return undefined;
        })
        .catch((error: unknown) => {
          this.recordError(error);
          if (!this.closed && this.queues.get(key)?.includes(request) === true)
            this.failWaitingRequest(key, request, "Lease wait status unavailable.");
        });
      // Waiting notifications are externally owned; a never-resolving callback must not
      // prevent daemon close after the queued request has been rejected.
      void notification;
    });
  }

  private canGrant(input: ResolvedAcquireInput, queue: PendingRequest[]): boolean {
    const active = Array.from(this.active.values()).filter(
      (item) => leaseKey(item.lease) === resourceKey(input),
    );
    if (this.granting.has(resourceKey(input))) return false;
    if (queue.length > 0) return false;
    return input.mode === "read"
      ? active.every((item) => item.lease.mode === "read")
      : active.length === 0;
  }

  private async grant(input: ResolvedAcquireInput): Promise<FencedLease> {
    const grantGeneration = this.generation;
    const leaseId = this.options.leaseCoordinator ? null : this.allocateLeaseId();
    try {
      return await this.grantReserved(input, grantGeneration, leaseId);
    } finally {
      if (leaseId) this.reservedLeaseIds.delete(leaseId);
    }
  }

  private async grantReserved(
    input: ResolvedAcquireInput,
    grantGeneration: number,
    leaseId: string | null,
  ): Promise<FencedLease> {
    const reservation = await this.reserveLeaseIdentity(input);
    this.assertGrantState(input, grantGeneration);
    const currentAuthorization = await this.refreshGrantAuthorization(input, grantGeneration);
    this.assertSharedReadReservation(reservation);
    this.assertGrantState(currentAuthorization, grantGeneration);
    const now = this.readNow(input.ttlMs);
    const lease = await this.createReservedLease(
      currentAuthorization,
      input,
      leaseId,
      reservation.fencingToken,
      now,
    );
    await this.assertAcquiredLeaseOrRelease(lease, currentAuthorization, input, now);
    const active: ActiveLease = { lease, authorization: currentAuthorization };
    this.assertGrantState(currentAuthorization, grantGeneration);
    assertLeaseAuthorization(lease, currentAuthorization);
    await this.requireAcquisitionAudit(active);
    return this.publishReservedLease(active, input, grantGeneration, reservation);
  }

  private async reserveLeaseIdentity(input: ResolvedAcquireInput): Promise<{
    readonly sharedRead?: ActiveLease;
    readonly sharedReadLeaseId?: string;
    readonly fencingToken: number;
  }> {
    const sharedRead =
      !this.options.leaseCoordinator && input.mode === "read"
        ? Array.from(this.active.values()).find(
            (item) => item.lease.mode === "read" && leaseKey(item.lease) === resourceKey(input),
          )
        : undefined;
    const sharedReadLeaseId = sharedRead?.lease.leaseId;
    const fencingToken = this.options.leaseCoordinator
      ? 0
      : (sharedRead?.lease.fencingToken ?? this.nextFencingToken++);
    if (
      !this.options.leaseCoordinator &&
      !sharedRead &&
      this.nextFencingToken > Number.MAX_SAFE_INTEGER
    )
      throw new Error("Lease fencing token exhausted.");
    if (!this.options.leaseCoordinator && !sharedRead) {
      await this.options.generationStorage.write({
        version: 1,
        generation: this.generation,
        nextFencingToken: this.nextFencingToken,
      });
    }
    return { sharedRead, sharedReadLeaseId, fencingToken };
  }

  private assertSharedReadReservation(reservation: {
    readonly sharedRead?: ActiveLease;
    readonly sharedReadLeaseId?: string;
  }): void {
    if (
      reservation.sharedReadLeaseId &&
      this.active.get(reservation.sharedReadLeaseId) !== reservation.sharedRead
    ) {
      throw new Error("Shared read lease became inactive during grant.");
    }
  }

  private async createReservedLease(
    authorization: ResolvedAcquireInput,
    input: ResolvedAcquireInput,
    leaseId: string | null,
    fencingToken: number,
    now: number,
  ): Promise<FencedLease> {
    if (this.options.leaseCoordinator) {
      return FencedLeaseSchema.parse(
        await this.options.leaseCoordinator.acquire({
          organizationId: authorization.handle.context.principal.organizationId,
          nodeId: authorization.handle.context.node.nodeId,
          businessIdentityId: authorization.profile.businessIdentityId,
          resourceKind: "browser_profile",
          resourceId: authorization.profile.browserProfileId,
          holderPrincipalId: authorization.handle.context.principal.principalId,
          holderAgentId: authorization.agent.agentId,
          mode: input.mode,
          ttlMs: input.ttlMs,
        }),
      );
    }
    return FencedLeaseSchema.parse({
      organizationId: authorization.handle.context.principal.organizationId,
      nodeId: authorization.handle.context.node.nodeId,
      businessIdentityId: authorization.profile.businessIdentityId,
      resourceKind: "browser_profile",
      resourceId: authorization.profile.browserProfileId,
      leaseId,
      holderPrincipalId: authorization.handle.context.principal.principalId,
      holderAgentId: authorization.agent.agentId,
      fencingToken,
      mode: input.mode,
      acquiredAt: isoTimestamp(now),
      heartbeatAt: isoTimestamp(now),
      expiresAt: isoTimestamp(now + input.ttlMs),
      leaseRevision: this.nextRevision(),
    });
  }

  private async assertAcquiredLeaseOrRelease(
    lease: FencedLease,
    authorization: ResolvedAcquireInput,
    input: ResolvedAcquireInput,
    now: number,
  ): Promise<void> {
    try {
      assertCoordinatedLeaseAcquisition(lease, authorization, input.mode, now, input.ttlMs);
    } catch (error) {
      if (this.options.leaseCoordinator) {
        try {
          await this.options.leaseCoordinator.release(leaseReleaseInput(lease));
        } catch (releaseError) {
          this.recordError(releaseError);
        }
      }
      throw error;
    }
  }

  private async requireAcquisitionAudit(active: ActiveLease): Promise<void> {
    try {
      await this.appendAudit(
        active.authorization,
        "allowed",
        LEASE_AUDIT_REASON.acquired,
        "required",
      );
    } catch (error) {
      this.recordError(error);
      try {
        await this.releaseCoordinatedLease(active);
      } catch (releaseError) {
        this.recordError(releaseError);
      }
      try {
        await this.appendAudit(
          active.authorization,
          "failed",
          LEASE_AUDIT_REASON.auditUnavailable,
          "buffered",
        );
      } catch (fallbackError) {
        this.recordError(fallbackError);
      }
      throw new Error("Lease audit unavailable.", { cause: error });
    }
  }

  private async publishReservedLease(
    active: ActiveLease,
    input: ResolvedAcquireInput,
    grantGeneration: number,
    reservation: { readonly sharedRead?: ActiveLease; readonly sharedReadLeaseId?: string },
  ): Promise<FencedLease> {
    const { lease } = active;
    const currentAuthorization = active.authorization;
    try {
      this.assertGrantState(currentAuthorization, grantGeneration);
      assertLeaseAuthorization(lease, currentAuthorization);
      const publishAuthorization = await this.refreshGrantAuthorization(
        currentAuthorization,
        grantGeneration,
      );
      this.assertGrantState(publishAuthorization, grantGeneration);
      assertLeaseAuthorization(lease, publishAuthorization);
      this.assertSharedReadReservation(reservation);
      if (this.active.has(lease.leaseId))
        throw new Error("Lease ID became unavailable during grant.");
      active.authorization = publishAuthorization;
      this.active.set(lease.leaseId, active);
      this.arm(
        active,
        this.options.leaseCoordinator
          ? Math.max(1, Date.parse(lease.expiresAt) - this.readNow())
          : input.ttlMs,
      );
      return cloneLease(lease);
    } catch (error) {
      if (this.active.get(lease.leaseId) === active) this.deactivate(active);
      try {
        await this.releaseCoordinatedLease(active);
      } catch (releaseError) {
        this.recordError(releaseError);
      }
      try {
        await this.appendAudit(
          currentAuthorization,
          "failed",
          LEASE_AUDIT_REASON.publicationFailed,
          "buffered",
        );
      } catch (fallbackError) {
        this.recordError(fallbackError);
      }
      throw error;
    }
  }

  private async refreshGrantAuthorization(
    input: ResolvedAcquireInput,
    grantGeneration: number,
  ): Promise<ResolvedAcquireInput> {
    this.assertGrantState(input, grantGeneration);
    const resolved = await this.resolveAuthorization(input.handle, input.profile.browserProfileId);
    this.assertGrantState(input, grantGeneration);
    const authorization = { ...resolved, mode: input.mode, ttlMs: input.ttlMs };
    assertAuthorizationSame(input, authorization);
    return authorization;
  }

  private assertGrantState(input: ResolvedAcquireInput, grantGeneration: number): void {
    if (this.clockError) throw this.clockError;
    if (this.closed || grantGeneration !== this.generation)
      throw new Error("Daemon ended; lease grant canceled.");
    this.assertCurrentHandle(input.handle);
  }

  private arm(active: ActiveLease, ttlMs: number): void {
    if (active.timer !== undefined) this.clock.clearTimeout(active.timer);
    active.timer = this.clock.setTimeout(() => {
      void this.track(this.expire(active.lease.leaseId)).catch((error: unknown) => {
        this.recordError(error);
      });
    }, ttlMs);
  }

  private async expire(leaseId: string): Promise<void> {
    const active = this.active.get(leaseId);
    if (!active) return;
    const now = this.readNow();
    const expiresAt = Date.parse(active.lease.expiresAt);
    if (expiresAt > now) {
      this.arm(active, expiresAt - now);
      return;
    }
    await this.expireActive(active);
  }

  private async expireActive(active: ActiveLease): Promise<void> {
    if (this.active.get(active.lease.leaseId) !== active) return;
    this.deactivate(active);
    try {
      await this.releaseCoordinatedLease(active);
    } catch (error) {
      this.recordError(error);
    }
    await this.track(this.appendLeaseAudit(active, "allowed", LEASE_AUDIT_REASON.expired));
    await this.track(this.drain(leaseKey(active.lease)));
  }

  private deactivate(active: ActiveLease): void {
    if (active.timer !== undefined) this.clock.clearTimeout(active.timer);
    this.active.delete(active.lease.leaseId);
  }

  private async drain(key: string): Promise<void> {
    if (this.draining.has(key)) {
      this.drainAgain.add(key);
      return;
    }
    this.draining.add(key);
    try {
      await this.drainUnlocked(key);
    } finally {
      this.draining.delete(key);
      if (this.drainAgain.delete(key) && !this.closed) this.observeDrain(key);
    }
  }

  private async drainUnlocked(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;
    const first = queue[0];
    if (!first?.waitingReady) return;
    const active = this.activeForKey(key);
    if (this.granting.has(key)) return;
    if (first.resolved.mode === "write") return this.drainWrite(key, queue, active);
    if (active.some((item) => item.lease.mode === "write")) return;
    await this.drainReads(key, queue);
  }

  private activeForKey(key: string): ActiveLease[] {
    return Array.from(this.active.values()).filter((item) => leaseKey(item.lease) === key);
  }

  private async drainWrite(
    key: string,
    queue: PendingRequest[],
    active: ActiveLease[],
  ): Promise<void> {
    if (active.length > 0) return;
    const request = queue.shift();
    if (!request) return;
    if (queue.length === 0) this.queues.delete(key);
    this.granting.add(key);
    await this.grantPendingRequest(request, key);
    if (this.queues.has(key)) await this.drainUnlocked(key);
  }

  private async drainReads(key: string, queue: PendingRequest[]): Promise<void> {
    while (queue[0]?.resolved.mode === "read" && queue[0]?.waitingReady === true) {
      if (this.activeForKey(key).some((item) => item.lease.mode === "write")) return;
      const request = queue.shift();
      if (!request) break;
      this.granting.add(key);
      await this.grantPendingRequest(request, key);
    }
    if (queue.length === 0) this.queues.delete(key);
  }

  private failWaitingRequest(key: string, request: PendingRequest, message: string): void {
    const queue = this.queues.get(key);
    const index = queue?.indexOf(request) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    this.releaseRequest(request);
    request.reject(new Error(message));
    if (queue.length === 0) this.queues.delete(key);
    this.observeDrain(key);
  }

  private async grantPendingRequest(request: PendingRequest, key: string): Promise<void> {
    try {
      const refreshed = await this.resolveTrustedInput(request.resolved);
      assertAuthorizationSame(request.resolved, refreshed);
      request.resolved = refreshed;
      request.resolve(await this.grant(refreshed));
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.releaseRequest(request);
      this.granting.delete(key);
    }
  }

  private async appendAudit(
    input: ResolvedAcquireInput,
    outcome: "allowed" | "failed",
    reasonCode: LeaseAuditReason,
    durability: "required" | "buffered",
  ): Promise<void> {
    const principal = input.handle.context.principal;
    const event: AuditEventInput = {
      organizationId: principal.organizationId,
      actorPrincipalId: principal.principalId,
      actorCredentialId: principal.credentialId,
      action: "enterprise.resource.browser_profile_lease",
      resource: { kind: "browser_profile_lease", id: input.profile.browserProfileId },
      workspaceId: input.workspace.workspaceId,
      agentId: input.agent.agentId,
      outcome,
      reasonCode,
      metadata: { mode: input.mode, ttlMs: input.ttlMs },
    };
    await this.options.auditSink.append(event, { durability });
  }

  private async appendLeaseAudit(
    active: ActiveLease,
    outcome: "allowed" | "failed",
    reasonCode: LeaseAuditReason,
  ): Promise<void> {
    try {
      await this.appendAudit(active.authorization, outcome, reasonCode, "buffered");
    } catch (error) {
      this.recordError(error);
    }
  }

  private observeLeaseAudit(
    active: ActiveLease,
    outcome: "allowed" | "failed",
    reasonCode: LeaseAuditReason,
  ): void {
    void this.track(this.appendLeaseAudit(active, outcome, reasonCode));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pendingOperations.add(promise);
    void promise.then(
      () => this.pendingOperations.delete(promise),
      () => this.pendingOperations.delete(promise),
    );
    return promise;
  }

  private observeDrain(key: string): void {
    void this.track(this.drain(key)).catch((error: unknown) => {
      this.recordError(error);
    });
  }

  private recordError(error: unknown): void {
    const value = error instanceof Error ? error : new Error(String(error));
    const recordedAt = this.lastNow ?? 0;
    this.pruneWaitingErrors(recordedAt);
    if (this.waitingErrors.length >= this.waitingErrorLimit) this.waitingErrors.shift();
    this.waitingErrors.push({ error: value, recordedAt });
    try {
      this.options.onError?.(value);
    } catch (observerError) {
      // Observers are diagnostics only and must never interrupt queue cleanup.
      if (this.waitingErrors.length >= this.waitingErrorLimit) this.waitingErrors.shift();
      this.waitingErrors.push({
        error: observerError instanceof Error ? observerError : new Error(String(observerError)),
        recordedAt,
      });
    }
  }

  private pruneWaitingErrors(now: number): void {
    const cutoff = now - 30 * 60 * 1000;
    while (this.waitingErrors[0] && this.waitingErrors[0].recordedAt <= cutoff)
      this.waitingErrors.shift();
  }

  private async invalidate(
    activePredicate: (item: ActiveLease) => boolean,
    queuedPredicate: (item: PendingRequest) => boolean,
    message: string,
    reasonCode: LeaseAuditReason,
  ): Promise<void> {
    await this.initialize();
    const keys = new Set<string>();
    for (const active of Array.from(this.active.values()))
      if (activePredicate(active)) {
        keys.add(leaseKey(active.lease));
        this.deactivate(active);
        try {
          await this.releaseCoordinatedLease(active);
        } catch (error) {
          this.recordError(error);
        }
        await this.track(this.appendLeaseAudit(active, "allowed", reasonCode));
      }
    for (const [key, queue] of this.queues) {
      const retained = queue.filter((request) => {
        if (!queuedPredicate(request)) return true;
        this.releaseRequest(request);
        request.reject(new Error(message));
        return false;
      });
      if (retained.length === 0) this.queues.delete(key);
      else this.queues.set(key, retained);
      if (retained.length !== queue.length) keys.add(key);
    }
    for (const key of keys) await this.track(this.drain(key));
  }

  private assertTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs > this.options.maxLeaseTtlMs)
      throw new Error("Lease TTL exceeds the configured safe maximum.");
  }

  private async releaseCoordinatedLease(active: ActiveLease): Promise<void> {
    await this.options.leaseCoordinator?.release(leaseReleaseInput(active.lease));
  }

  private allocateLeaseId(): string {
    for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt++) {
      const candidate = LeaseIdSchema.safeParse(this.options.createLeaseId());
      if (!candidate.success) continue;
      if (this.active.has(candidate.data) || this.reservedLeaseIds.has(candidate.data)) continue;
      this.reservedLeaseIds.add(candidate.data);
      return candidate.data;
    }
    throw new Error("Unable to allocate a unique valid lease ID.");
  }

  private allocateRequestId(): string {
    for (let attempt = 0; attempt < MAX_ID_ALLOCATION_ATTEMPTS; attempt++) {
      const candidate = LeaseRequestIdSchema.safeParse(this.options.createRequestId());
      if (!candidate.success || this.liveRequestIds.has(candidate.data)) continue;
      this.liveRequestIds.add(candidate.data);
      return candidate.data;
    }
    throw new Error("Unable to allocate a unique valid lease request ID.");
  }

  private releaseRequest(request: PendingRequest): void {
    if (request.notificationTimer !== undefined) {
      this.clock.clearTimeout(request.notificationTimer);
      request.notificationTimer = undefined;
    }
    this.liveRequestIds.delete(request.requestId);
  }

  private readNow(ttlMs = 0): number {
    if (this.clockError) throw this.clockError;
    let now: number;
    try {
      now = this.clock.now();
    } catch (error) {
      return this.failClock("Browser Profile lease clock is unavailable.", error);
    }
    if (!Number.isSafeInteger(now) || now < 0)
      return this.failClock("Browser Profile lease clock is invalid.");
    if (this.lastNow !== null && now < this.lastNow)
      return this.failClock("Browser Profile lease clock moved backwards.");
    if (now > Math.min(Number.MAX_SAFE_INTEGER - ttlMs, MAX_DATE_MS - ttlMs))
      return this.failClock("Lease clock range exceeded.");
    this.lastNow = now;
    return now;
  }

  private failClock(message: string, cause?: unknown): never {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    this.clockError ??= error;
    for (const active of Array.from(this.active.values())) this.deactivate(active);
    for (const queue of this.queues.values())
      for (const request of queue) {
        this.releaseRequest(request);
        request.reject(this.clockError);
      }
    this.queues.clear();
    throw this.clockError;
  }

  private isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean {
    try {
      return this.options.isCurrentHandle(handle);
    } catch {
      return false;
    }
  }

  private assertCurrentHandle(handle: EnterpriseAgentContextHandle): void {
    if (!this.isCurrentHandle(handle))
      throw new Error("Agent context handle is not current in the canonical registry.");
  }

  private getActive(handle: EnterpriseAgentContextHandle, lease: FencedLease): ActiveLease {
    this.assertCurrentHandle(handle);
    const active = this.active.get(lease.leaseId);
    if (!active) throw new Error("Lease is expired or inactive.");
    this.assertActiveIdentity(active, handle, lease);
    return active;
  }

  private assertActiveIdentity(
    active: ActiveLease,
    handle: EnterpriseAgentContextHandle,
    lease: FencedLease,
  ): void {
    this.assertCurrentHandle(handle);
    if (this.active.get(active.lease.leaseId) !== active || this.closed)
      throw new Error("Lease became inactive while authorization was resolving.");
    if (active.authorization.handle !== handle)
      throw new Error("Lease holder handle does not match.");
    assertLeaseMatch(active.lease, lease);
    assertLeaseAuthorization(active.lease, active.authorization);
  }

  private nextRevision(): string {
    if (this.leaseRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Lease revision exhausted.");
    return `${this.generation}:${++this.leaseRevision}`;
  }
}

function resourceKey(input: ResolvedAcquireInput): string {
  return JSON.stringify([
    input.profile.organizationId,
    input.profile.businessIdentityId,
    input.profile.browserProfileId,
  ]);
}
function leaseKey(
  lease: Pick<FencedLease, "organizationId" | "businessIdentityId" | "resourceId">,
): string {
  return JSON.stringify([lease.organizationId, lease.businessIdentityId, lease.resourceId]);
}
function assertLeaseMatch(actual: FencedLease, expected: FencedLease): void {
  if (
    actual.leaseId !== expected.leaseId ||
    actual.resourceKind !== expected.resourceKind ||
    actual.resourceId !== expected.resourceId ||
    actual.organizationId !== expected.organizationId ||
    actual.businessIdentityId !== expected.businessIdentityId ||
    actual.nodeId !== expected.nodeId ||
    actual.holderPrincipalId !== expected.holderPrincipalId ||
    actual.holderAgentId !== expected.holderAgentId ||
    actual.mode !== expected.mode ||
    actual.acquiredAt !== expected.acquiredAt ||
    actual.heartbeatAt !== expected.heartbeatAt ||
    actual.expiresAt !== expected.expiresAt
  )
    throw new Error("Lease tuple does not match.");
  if (actual.fencingToken !== expected.fencingToken)
    throw new Error("Lease fencing token is stale.");
  if (actual.leaseRevision !== expected.leaseRevision) throw new Error("Lease revision is stale.");
}

function assertResolvedAuthorization(
  handle: EnterpriseAgentContextHandle,
  browserProfileId: string,
  authorization: BrowserProfileLeaseAuthorization,
): void {
  const principal = handle.context.principal;
  const node = handle.context.node;
  const { workspace, agent, profile } = authorization;
  if (
    profile.browserProfileId !== browserProfileId ||
    agent.agentId !== handle.agentId ||
    principal.organizationId !== workspace.organizationId ||
    principal.organizationId !== agent.organizationId ||
    principal.organizationId !== profile.organizationId ||
    node.nodeId !== workspace.nodeId ||
    node.nodeId !== agent.nodeId ||
    node.nodeId !== profile.homeNodeId
  )
    throw new Error("Resolved Browser Profile authorization does not match the Agent context.");
  if (
    agent.workspaceId !== workspace.workspaceId ||
    agent.ownerPrincipalId !== workspace.ownerPrincipalId ||
    agent.createdByPrincipalId !== workspace.createdByPrincipalId
  )
    throw new Error("AuthorizedAgent does not match the authorized Workspace.");
}

function assertAuthorizationSame(
  a: Omit<ResolvedAcquireInput, "mode" | "ttlMs">,
  b: Omit<ResolvedAcquireInput, "mode" | "ttlMs">,
): void {
  if (
    a.handle !== b.handle ||
    a.bindingRevision !== b.bindingRevision ||
    JSON.stringify(a.workspace) !== JSON.stringify(b.workspace) ||
    JSON.stringify(a.agent) !== JSON.stringify(b.agent) ||
    JSON.stringify(a.profile) !== JSON.stringify(b.profile)
  )
    throw new Error("Browser Profile authorization changed while waiting.");
}

function assertLeaseAuthorization(
  lease: FencedLease,
  authorization: Omit<ResolvedAcquireInput, "mode" | "ttlMs">,
): void {
  const principal = authorization.handle.context.principal;
  const node = authorization.handle.context.node;
  if (
    lease.organizationId !== principal.organizationId ||
    lease.nodeId !== node.nodeId ||
    lease.businessIdentityId !== authorization.profile.businessIdentityId ||
    lease.resourceKind !== "browser_profile" ||
    lease.resourceId !== authorization.profile.browserProfileId ||
    lease.holderPrincipalId !== principal.principalId ||
    lease.holderAgentId !== authorization.agent.agentId
  )
    throw new Error("Resolved Browser Profile authorization does not match the lease.");
}

function assertCoordinatedLeaseAcquisition(
  lease: FencedLease,
  authorization: ResolvedAcquireInput,
  mode: "read" | "write",
  now: number,
  ttlMs: number,
): void {
  assertLeaseAuthorization(lease, authorization);
  if (
    lease.mode !== mode ||
    lease.fencingToken < 1 ||
    !Number.isFinite(Date.parse(lease.acquiredAt)) ||
    !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
    Date.parse(lease.expiresAt) <= now ||
    Date.parse(lease.expiresAt) > now + ttlMs
  ) {
    throw new Error("Managed lease acquisition returned an invalid lease.");
  }
}

function assertCoordinatedLeaseRenewal(renewed: FencedLease, previous: FencedLease): void {
  if (
    renewed.leaseId !== previous.leaseId ||
    renewed.organizationId !== previous.organizationId ||
    renewed.nodeId !== previous.nodeId ||
    renewed.businessIdentityId !== previous.businessIdentityId ||
    renewed.resourceKind !== previous.resourceKind ||
    renewed.resourceId !== previous.resourceId ||
    renewed.holderPrincipalId !== previous.holderPrincipalId ||
    renewed.holderAgentId !== previous.holderAgentId ||
    renewed.fencingToken !== previous.fencingToken ||
    renewed.mode !== previous.mode ||
    renewed.acquiredAt !== previous.acquiredAt ||
    renewed.leaseRevision === previous.leaseRevision ||
    Date.parse(renewed.heartbeatAt) < Date.parse(previous.heartbeatAt) ||
    Date.parse(renewed.expiresAt) <= Date.parse(renewed.heartbeatAt)
  ) {
    throw new Error("Managed lease renewal returned a different lease identity.");
  }
}

function leaseReleaseInput(lease: FencedLease): LeaseReleaseInput {
  return {
    leaseId: lease.leaseId,
    nodeId: lease.nodeId,
    holderPrincipalId: lease.holderPrincipalId,
    fencingToken: lease.fencingToken,
  };
}

function cloneLease(lease: FencedLease): FencedLease {
  return FencedLeaseSchema.parse(lease);
}

function isoTimestamp(now: number): string {
  return new Date(now).toISOString();
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid ${label}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}
