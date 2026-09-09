import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  EnterpriseResourceOwnerSchema,
  NodeContextSchema,
  NodeIdSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
  PrincipalIdSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceAuthorization,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { SafeWorkspaceFsPort, WorkspacePathIdentity } from "./workspace-path-policy.js";

const UPLOAD_ID_BYTES = 32;
const UPLOAD_ID_LENGTH = 43;
const UPLOAD_ID_GENERATION_ATTEMPTS = 3;
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UPLOAD_ACCESS_DENIED_MESSAGE = "Upload access denied.";

export const ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX = 10_000;

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();

const WorkspacePathIdentitySchema = z
  .object({
    dev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ino: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const UploadFileIdentitySchema = WorkspacePathIdentitySchema.extend({
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mtimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const EnterpriseUploadCapabilitySchema = z
  .object({
    capabilityId: z.string().min(1),
    organizationId: OrganizationIdSchema,
    nodeId: NodeIdSchema,
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    directoryIdentity: WorkspacePathIdentitySchema,
  })
  .strict();

const EnterpriseUploadFinalizedTargetSchema = EnterpriseUploadCapabilitySchema.extend({
  fileIdentity: UploadFileIdentitySchema,
}).strict();

const EnterpriseUploadIssueInputSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

const EnterpriseUploadUseInputSchema = EnterpriseUploadIssueInputSchema.extend({
  uploadId: z.string().min(1),
}).strict();

const EnterpriseUploadAppendInputSchema = EnterpriseUploadUseInputSchema.extend({
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes: z.instanceof(Uint8Array).refine((value) => value.byteLength <= MAX_UPLOAD_CHUNK_BYTES),
}).strict();

const CleanupNodeShape = {
  organizationId: OrganizationIdSchema,
  node: NodeContextSchema,
  principalId: PrincipalIdSchema,
};

const ExactSessionCleanupShape = {
  ...CleanupNodeShape,
  credentialId: z.string().min(1),
  grantVersion: z.string().min(1),
  sessionBindingGeneration: z.string().min(1),
};

const EnterpriseUploadCleanupInputSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("session-closed"), ...ExactSessionCleanupShape }).strict(),
  z.object({ reason: z.literal("generation-replaced"), ...ExactSessionCleanupShape }).strict(),
  z
    .object({
      reason: z.literal("credential-revoked"),
      ...CleanupNodeShape,
      credentialId: z.string().min(1),
    })
    .strict(),
  z.object({ reason: z.literal("principal-logout"), ...CleanupNodeShape }).strict(),
]);

export interface EnterpriseUploadClock {
  now(): number;
}

export interface EnterpriseUploadRandomSource {
  randomBytes(size: number): Uint8Array;
}

export type EnterpriseUploadDirectoryIdentity = Readonly<WorkspacePathIdentity>;

export type EnterpriseUploadFileIdentity = Readonly<
  WorkspacePathIdentity & {
    size: number;
    mtimeMs: number;
  }
>;

/** Data-only reference held by the trusted safe-FS adapter; it is never public. */
export interface EnterpriseUploadCapability {
  readonly capabilityId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly directoryIdentity: EnterpriseUploadDirectoryIdentity;
}

export interface EnterpriseUploadFinalizedTarget extends EnterpriseUploadCapability {
  readonly fileIdentity: EnterpriseUploadFileIdentity;
}

export interface EnterpriseUploadSafeFsPort extends Pick<
  SafeWorkspaceFsPort,
  "releaseReady" | "supportsDirectoryRelativeOperations"
> {
  prepare(input: {
    readonly workspace: AuthorizedWorkspace;
    readonly relativePath: string;
    readonly signal: AbortSignal;
  }): Promise<EnterpriseUploadCapability>;

  append(
    capability: EnterpriseUploadCapability,
    input: {
      readonly offset: number;
      readonly bytes: Uint8Array;
      readonly signal: AbortSignal;
    },
  ): Promise<void>;

  /**
   * Keep the result reversible through abort(capability) until this promise returns and the policy
   * publishes it. Honor signal when possible. The policy still aborts late results, so abort must
   * be idempotent.
   */
  finalize(
    capability: EnterpriseUploadCapability,
    options: { readonly signal: AbortSignal },
  ): Promise<EnterpriseUploadFinalizedTarget>;

  abort(capability: EnterpriseUploadCapability): Promise<void>;
}

export interface EnterpriseUploadIssueInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
  readonly workspaceId: string;
  readonly relativePath: string;
}

export interface EnterpriseUploadFinalizeInput extends EnterpriseUploadIssueInput {
  readonly uploadId: string;
}

export interface EnterpriseUploadAppendInput extends EnterpriseUploadFinalizeInput {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface EnterpriseUploadAbortInput extends EnterpriseUploadFinalizeInput {}

export interface EnterpriseUploadIssue {
  readonly uploadId: string;
  readonly expiresAt: number;
}

export interface EnterpriseUploadFinalizeResult {
  readonly uploadId: string;
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly fileIdentity: EnterpriseUploadFileIdentity;
}

export type EnterpriseUploadCleanupInput = z.infer<typeof EnterpriseUploadCleanupInputSchema>;

export interface EnterpriseUploadCleanupResult {
  readonly cleaned: number;
}

export type EnterpriseUploadPolicyErrorCode =
  | "invalid_configuration"
  | "invalid_clock"
  | "clock_rollback"
  | "expiry_overflow"
  | "capacity_exceeded"
  | "invalid_random_bytes"
  | "upload_id_collision"
  | "upload_access_denied"
  | "invalid_cleanup_scope"
  | "cleanup_failed"
  | "store_quarantined";

export class EnterpriseUploadPolicyError extends Error {
  public constructor(
    public readonly code: EnterpriseUploadPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnterpriseUploadPolicyError";
  }
}

export interface EnterpriseUploadPolicyOptions {
  readonly ttlMs: number;
  readonly capacity: number;
  readonly authorization: Pick<ResourceAuthorization, "assertWorkspace">;
  readonly safeFs: EnterpriseUploadSafeFsPort;
  readonly clock?: EnterpriseUploadClock;
  readonly randomSource?: EnterpriseUploadRandomSource;
}

interface ParsedUploadRequest {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
  readonly workspaceId: string;
  readonly relativePath: string;
}

interface ParsedUploadUseRequest extends ParsedUploadRequest {
  readonly uploadId: string;
}

interface ParsedUploadAppendRequest extends ParsedUploadUseRequest {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

interface OwnedUploadCapability {
  readonly organizationId: string;
  readonly node: NodeContext;
  readonly principalId: string;
  readonly credentialId: string;
  readonly grantVersion: string;
  readonly sessionBindingGeneration: string;
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly capability: EnterpriseUploadCapability;
}

interface EnterpriseUploadRecord extends OwnedUploadCapability {
  readonly expiresAt: number;
}

interface DeferredOperation {
  readonly settled: Promise<void>;
  settle(): void;
}

interface IssueOperation extends DeferredOperation {
  readonly request: ParsedUploadRequest;
  readonly controller: AbortController;
  invalidated: boolean;
}

interface InFlightOperation extends DeferredOperation {
  readonly uploadId: string;
  readonly record: EnterpriseUploadRecord;
  readonly controller: AbortController;
  invalidated: boolean;
}

type AssertWorkspace = ResourceAuthorization["assertWorkspace"];
type PrepareCapability = EnterpriseUploadSafeFsPort["prepare"];
type AppendCapability = EnterpriseUploadSafeFsPort["append"];
type FinalizeCapability = EnterpriseUploadSafeFsPort["finalize"];
type AbortCapability = EnterpriseUploadSafeFsPort["abort"];

const SYSTEM_CLOCK: EnterpriseUploadClock = Object.freeze({
  now(): number {
    return Date.now();
  },
});

const SECURE_RANDOM_SOURCE: EnterpriseUploadRandomSource = Object.freeze({
  randomBytes(size: number): Uint8Array {
    return randomBytes(size);
  },
});

export class EnterpriseUploadPolicy {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly releaseReady: boolean;
  private readonly supportsDirectoryRelativeOperations: boolean;
  private readonly assertWorkspace: AssertWorkspace;
  private readonly prepareCapability: PrepareCapability;
  private readonly appendCapability: AppendCapability;
  private readonly finalizeCapability: FinalizeCapability;
  private readonly abortCapability: AbortCapability;
  private readonly now: EnterpriseUploadClock["now"];
  private readonly randomBytes: EnterpriseUploadRandomSource["randomBytes"];
  private readonly records = new Map<string, EnterpriseUploadRecord>();
  private readonly issuing = new Set<IssueOperation>();
  private readonly inFlight = new Map<string, InFlightOperation>();
  private readonly orphans = new Map<bigint, OwnedUploadCapability>();
  private nextOrphanId = 1n;
  private lastObservedNow: number | null = null;
  private unrecoverablePoison = false;
  private closed = false;
  private activeCleanups = 0;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<EnterpriseUploadCleanupResult> | null = null;

  public constructor(options: EnterpriseUploadPolicyOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new EnterpriseUploadPolicyError(
        "invalid_configuration",
        "Upload TTL must be a positive safe integer.",
      );
    }
    if (
      !Number.isSafeInteger(options.capacity) ||
      options.capacity <= 0 ||
      options.capacity > ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX
    ) {
      throw new EnterpriseUploadPolicyError(
        "invalid_configuration",
        `Upload capacity must be a positive safe integer no greater than ${ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX}.`,
      );
    }
    const clock = options.clock ?? SYSTEM_CLOCK;
    const randomSource = options.randomSource ?? SECURE_RANDOM_SOURCE;
    this.ttlMs = options.ttlMs;
    this.capacity = options.capacity;
    this.releaseReady = options.safeFs.releaseReady === true;
    this.supportsDirectoryRelativeOperations =
      options.safeFs.supportsDirectoryRelativeOperations === true;
    this.assertWorkspace = options.authorization.assertWorkspace.bind(options.authorization);
    this.prepareCapability = options.safeFs.prepare.bind(options.safeFs);
    this.appendCapability = options.safeFs.append.bind(options.safeFs);
    this.finalizeCapability = options.safeFs.finalize.bind(options.safeFs);
    this.abortCapability = options.safeFs.abort.bind(options.safeFs);
    this.now = clock.now.bind(clock);
    this.randomBytes = randomSource.randomBytes.bind(randomSource);
  }

  public async issue(input: EnterpriseUploadIssueInput): Promise<EnterpriseUploadIssue> {
    let request: ParsedUploadRequest;
    try {
      request = parseIssueInput(input);
    } catch {
      throw accessDenied();
    }
    this.assertCanStartIssue();
    if (!this.releaseReady || !this.supportsDirectoryRelativeOperations) throw accessDenied();

    const operation = createIssueOperation(request);
    this.issuing.add(operation);
    let ownedCapability: OwnedUploadCapability | null = null;
    try {
      const pruneNow = this.readClock();
      await this.pruneExpired(pruneNow);
      this.assertIssueCurrent(operation);
      if (
        this.records.size + this.inFlight.size + this.reservationsThrough(operation) >
        this.capacity
      ) {
        throw new EnterpriseUploadPolicyError("capacity_exceeded", "Upload capacity is exhausted.");
      }

      const firstWorkspaceValue = await this.assertWorkspace(
        request.principal,
        "workspace.write",
        request.workspaceId,
      );
      this.assertIssueCurrent(operation);
      const firstWorkspace = parseWorkspace(firstWorkspaceValue);
      if (!workspaceMatchesRequest(request, firstWorkspace)) throw accessDenied();

      const capabilityValue = await this.prepareCapability(
        Object.freeze({
          workspace: freezeWorkspace(firstWorkspace),
          relativePath: request.relativePath,
          signal: operation.controller.signal,
        }),
      );
      const currentAfterPrepare = this.issueIsCurrent(operation);
      const parsedCapability = EnterpriseUploadCapabilitySchema.safeParse(capabilityValue);
      if (!parsedCapability.success) {
        this.unrecoverablePoison = true;
        throw storeQuarantined();
      }
      const capability = cloneCapability(parsedCapability.data);
      ownedCapability = freezeOwnedCapability({
        organizationId: request.principal.organizationId,
        node: request.node,
        principalId: request.principal.principalId,
        credentialId: request.principal.credentialId,
        grantVersion: request.principal.grantVersion,
        sessionBindingGeneration: request.sessionBindingGeneration,
        workspace: firstWorkspace,
        relativePath: request.relativePath,
        capability,
      });
      if (!currentAfterPrepare) throw accessDenied();
      if (!capabilityMatchesWorkspace(capability, firstWorkspace, request.relativePath)) {
        throw accessDenied();
      }

      const currentWorkspaceValue = await this.assertWorkspace(
        request.principal,
        "workspace.write",
        request.workspaceId,
      );
      this.assertIssueCurrent(operation);
      const currentWorkspace = parseWorkspace(currentWorkspaceValue);
      if (
        !workspaceMatchesRequest(request, currentWorkspace) ||
        !workspaceIdentityMatches(firstWorkspace, currentWorkspace)
      ) {
        throw accessDenied();
      }

      const now = this.readClock();
      const expiresAt = now + this.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new EnterpriseUploadPolicyError(
          "expiry_overflow",
          "Upload expiry exceeds the safe clock range.",
        );
      }
      const uploadId = this.createUniqueUploadId();
      this.assertIssueCurrent(operation);
      this.records.set(uploadId, freezeRecord({ ...ownedCapability, expiresAt }));
      ownedCapability = null;
      return Object.freeze({ uploadId, expiresAt });
    } catch (error) {
      if (ownedCapability !== null) await this.releaseOrQuarantine(ownedCapability);
      if (error instanceof EnterpriseUploadPolicyError) throw error;
      throw accessDenied();
    } finally {
      this.issuing.delete(operation);
      operation.settle();
    }
  }

  /** Writes one ordered binary frame without exposing the underlying safe-FS capability. */
  public async append(input: EnterpriseUploadAppendInput): Promise<boolean> {
    const operation = this.beginInFlight(input);
    if (operation === null) return false;

    let preserve = false;
    try {
      let request: ParsedUploadAppendRequest;
      try {
        request = parseAppendInput(snapshotAppendInput(input, operation.uploadId));
      } catch {
        return false;
      }
      if (!this.inFlightIsCurrent(operation) || !recordMatchesRequest(operation.record, request)) {
        return false;
      }

      let currentWorkspace: AuthorizedWorkspace;
      try {
        currentWorkspace = parseWorkspace(
          await this.assertWorkspace(request.principal, "workspace.write", request.workspaceId),
        );
      } catch {
        return false;
      }
      if (
        !this.inFlightIsCurrent(operation) ||
        !workspaceMatchesRequest(request, currentWorkspace) ||
        !workspaceIdentityMatches(operation.record.workspace, currentWorkspace) ||
        operation.record.expiresAt <= this.readClock()
      ) {
        return false;
      }

      try {
        await this.appendCapability(cloneCapability(operation.record.capability), {
          offset: request.offset,
          bytes: new Uint8Array(request.bytes),
          signal: operation.controller.signal,
        });
      } catch {
        return false;
      }
      if (!this.inFlightIsCurrent(operation)) return false;

      let postAppendWorkspace: AuthorizedWorkspace;
      try {
        postAppendWorkspace = parseWorkspace(
          await this.assertWorkspace(request.principal, "workspace.write", request.workspaceId),
        );
      } catch {
        return false;
      }
      if (
        !this.inFlightIsCurrent(operation) ||
        !workspaceMatchesRequest(request, postAppendWorkspace) ||
        !workspaceIdentityMatches(operation.record.workspace, postAppendWorkspace) ||
        operation.record.expiresAt <= this.readClock()
      ) {
        return false;
      }

      this.records.set(operation.uploadId, operation.record);
      preserve = true;
      return true;
    } finally {
      try {
        if (!preserve) await this.releaseOrQuarantine(operation.record);
      } finally {
        this.finishInFlight(operation);
      }
    }
  }

  // oxlint-disable-next-line complexity -- staged auth, cancellation, target and publication gates.
  public async finalize(
    input: EnterpriseUploadFinalizeInput,
  ): Promise<EnterpriseUploadFinalizeResult | null> {
    const operation = this.beginInFlight(input);
    if (operation === null) return null;

    try {
      let request: ParsedUploadUseRequest;
      try {
        request = parseUseInput(snapshotUseInput(input, operation.uploadId));
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (!this.inFlightIsCurrent(operation) || !recordMatchesRequest(operation.record, request)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }

      let currentWorkspaceValue: AuthorizedWorkspace;
      try {
        currentWorkspaceValue = await this.assertWorkspace(
          request.principal,
          "workspace.write",
          request.workspaceId,
        );
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (!this.inFlightIsCurrent(operation)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }

      let currentWorkspace: AuthorizedWorkspace;
      try {
        currentWorkspace = parseWorkspace(currentWorkspaceValue);
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (
        !workspaceMatchesRequest(request, currentWorkspace) ||
        !workspaceIdentityMatches(operation.record.workspace, currentWorkspace)
      ) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      let now: number;
      try {
        now = this.readClock();
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (operation.record.expiresAt <= now || !this.inFlightIsCurrent(operation)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }

      let target: EnterpriseUploadFinalizedTarget;
      try {
        const targetValue = await this.finalizeCapability(
          cloneCapability(operation.record.capability),
          Object.freeze({ signal: operation.controller.signal }),
        );
        target = parseFinalizedTarget(targetValue);
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (!this.inFlightIsCurrent(operation)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }

      let postFinalizeWorkspaceValue: AuthorizedWorkspace;
      try {
        postFinalizeWorkspaceValue = await this.assertWorkspace(
          request.principal,
          "workspace.write",
          request.workspaceId,
        );
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (!this.inFlightIsCurrent(operation)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      let postFinalizeWorkspace: AuthorizedWorkspace;
      try {
        postFinalizeWorkspace = parseWorkspace(postFinalizeWorkspaceValue);
      } catch {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (
        !workspaceMatchesRequest(request, postFinalizeWorkspace) ||
        !workspaceIdentityMatches(operation.record.workspace, postFinalizeWorkspace)
      ) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }

      if (!finalizedTargetMatchesCapability(target, operation.record.capability)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      if (!this.inFlightIsCurrent(operation)) {
        await this.releaseOrQuarantine(operation.record);
        return null;
      }
      return freezeFinalizeResult(request.uploadId, operation.record, target.fileIdentity);
    } finally {
      this.finishInFlight(operation);
    }
  }

  public async abort(input: EnterpriseUploadAbortInput): Promise<boolean> {
    const operation = this.beginInFlight(input);
    if (operation === null) return false;
    try {
      let authorized = false;
      try {
        const request = parseUseInput(snapshotUseInput(input, operation.uploadId));
        authorized =
          this.inFlightIsCurrent(operation) &&
          operation.record.expiresAt > this.readClock() &&
          recordMatchesRequest(operation.record, request);
      } catch {
        authorized = false;
      }
      await this.releaseOrQuarantine(operation.record);
      return authorized && this.inFlightIsCurrent(operation);
    } finally {
      this.finishInFlight(operation);
    }
  }

  /** W1/W3 call this after changing authority state and before releasing Session bindings. */
  public async cleanup(
    input: EnterpriseUploadCleanupInput,
  ): Promise<EnterpriseUploadCleanupResult> {
    let scope: EnterpriseUploadCleanupInput;
    try {
      scope = freezeCleanupScope(EnterpriseUploadCleanupInputSchema.parse(input));
    } catch {
      throw new EnterpriseUploadPolicyError(
        "invalid_cleanup_scope",
        "Upload cleanup scope is invalid.",
      );
    }
    this.activeCleanups += 1;
    const issuing = [...this.issuing].filter((operation) =>
      cleanupScopeMatchesRequest(scope, operation.request),
    );
    const inFlight = [...this.inFlight.values()].filter((operation) =>
      cleanupScopeMatchesOwned(scope, operation.record),
    );
    invalidateOperations(issuing, inFlight);
    return this.enqueueMaintenance(async () => {
      const records = takeMatchingMapValues(this.records, (record) =>
        cleanupScopeMatchesOwned(scope, record),
      );
      const orphans = takeMatchingMapValues(this.orphans, (orphan) =>
        cleanupScopeMatchesOwned(scope, orphan),
      );
      const releases = Promise.allSettled(
        [...records, ...orphans].map((owned) => this.releaseOrQuarantine(owned)),
      );
      const settlements = Promise.all([
        ...issuing.map((operation) => operation.settled),
        ...inFlight.map((operation) => operation.settled),
      ]);
      const [releaseResults] = await Promise.all([releases, settlements]);
      if (
        releaseResults.some((result) => result.status === "rejected") ||
        [...this.orphans.values()].some((orphan) => cleanupScopeMatchesOwned(scope, orphan))
      ) {
        throw cleanupFailed();
      }
      return Object.freeze({
        cleaned: records.length + orphans.length + issuing.length + inFlight.length,
      });
    }).finally(() => {
      this.activeCleanups -= 1;
    });
  }

  /** Instance shutdown seam. A failed close can be retried to drain quarantined capabilities. */
  public close(): Promise<EnterpriseUploadCleanupResult> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    const issuing = [...this.issuing];
    const inFlight = [...this.inFlight.values()];
    invalidateOperations(issuing, inFlight);
    const run = this.enqueueMaintenance(() => this.performClose(issuing, inFlight));
    let settled: Promise<EnterpriseUploadCleanupResult>;
    settled = run.then(
      (result) => result,
      (error: unknown) => {
        if (this.closePromise === settled) this.closePromise = null;
        throw error;
      },
    );
    this.closePromise = settled;
    return settled;
  }

  private async performClose(
    issuing: readonly IssueOperation[],
    inFlight: readonly InFlightOperation[],
  ): Promise<EnterpriseUploadCleanupResult> {
    const records = takeAllMapValues(this.records);
    const orphans = takeAllMapValues(this.orphans);
    const releases = Promise.allSettled(
      [...records, ...orphans].map((owned) => this.releaseOrQuarantine(owned)),
    );
    const settlements = Promise.all([
      ...issuing.map((operation) => operation.settled),
      ...inFlight.map((operation) => operation.settled),
    ]);
    const [releaseResults] = await Promise.all([releases, settlements]);
    if (
      this.unrecoverablePoison ||
      this.orphans.size > 0 ||
      releaseResults.some((result) => result.status === "rejected")
    ) {
      throw cleanupFailed();
    }
    return Object.freeze({
      cleaned: records.length + orphans.length + issuing.length + inFlight.length,
    });
  }

  private enqueueMaintenance<T>(task: () => Promise<T>): Promise<T> {
    const run = this.maintenanceTail.then(task, task);
    this.maintenanceTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertCanStartIssue(): void {
    if (this.isQuarantined()) throw storeQuarantined();
    if (this.closed) throw accessDenied();
    if (this.activeCleanups > 0) throw accessDenied();
  }

  private reservationsThrough(operation: IssueOperation): number {
    let reservations = 0;
    for (const candidate of this.issuing) {
      reservations += 1;
      if (candidate === operation) break;
    }
    return reservations;
  }

  private assertIssueCurrent(operation: IssueOperation): void {
    if (!this.issueIsCurrent(operation)) {
      if (this.isQuarantined()) throw storeQuarantined();
      throw accessDenied();
    }
  }

  private issueIsCurrent(operation: IssueOperation): boolean {
    return (
      !this.closed &&
      !this.isQuarantined() &&
      !operation.invalidated &&
      !operation.controller.signal.aborted
    );
  }

  private inFlightIsCurrent(operation: InFlightOperation): boolean {
    return !operation.invalidated && !operation.controller.signal.aborted;
  }

  private beginInFlight(input: EnterpriseUploadFinalizeInput): InFlightOperation | null {
    if (this.closed || this.activeCleanups > 0) return null;
    const uploadId = readUploadId(input);
    if (uploadId === null) return null;
    const record = this.records.get(uploadId);
    if (record === undefined) return null;
    this.records.delete(uploadId);
    const operation = createInFlightOperation(uploadId, record);
    this.inFlight.set(uploadId, operation);
    return operation;
  }

  private finishInFlight(operation: InFlightOperation): void {
    if (this.inFlight.get(operation.uploadId) === operation)
      this.inFlight.delete(operation.uploadId);
    operation.settle();
  }

  private readClock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new EnterpriseUploadPolicyError(
        "invalid_clock",
        "Upload clock must return a nonnegative safe integer.",
      );
    }
    if (this.lastObservedNow !== null && now < this.lastObservedNow) {
      throw new EnterpriseUploadPolicyError("clock_rollback", "Upload clock moved backwards.");
    }
    this.lastObservedNow = now;
    return now;
  }

  private async pruneExpired(now: number): Promise<void> {
    const expired = takeMatchingMapValues(this.records, (record) => record.expiresAt <= now);
    const results = await Promise.allSettled(
      expired.map((record) => this.releaseOrQuarantine(record)),
    );
    if (results.some((result) => result.status === "rejected")) throw cleanupFailed();
  }

  private async releaseOrQuarantine(owned: OwnedUploadCapability): Promise<void> {
    try {
      await this.abortCapability(cloneCapability(owned.capability));
    } catch {
      this.orphans.set(this.nextOrphanId, freezeOwnedCapability(owned));
      this.nextOrphanId += 1n;
      throw cleanupFailed();
    }
  }

  private isQuarantined(): boolean {
    return this.unrecoverablePoison || this.orphans.size > 0;
  }

  private createUniqueUploadId(): string {
    for (let attempt = 0; attempt < UPLOAD_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const bytes = this.randomBytes(UPLOAD_ID_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== UPLOAD_ID_BYTES) {
        throw new EnterpriseUploadPolicyError(
          "invalid_random_bytes",
          `Upload ID random source must return exactly ${UPLOAD_ID_BYTES} bytes.`,
        );
      }
      const uploadId = Buffer.from(bytes).toString("base64url");
      const canonical =
        uploadId.length === UPLOAD_ID_LENGTH &&
        CANONICAL_BASE64URL_PATTERN.test(uploadId) &&
        Buffer.from(uploadId, "base64url").toString("base64url") === uploadId;
      if (!canonical) {
        throw new EnterpriseUploadPolicyError(
          "invalid_random_bytes",
          "Upload ID random source did not produce a canonical base64url value.",
        );
      }
      if (!this.records.has(uploadId) && !this.inFlight.has(uploadId)) return uploadId;
    }
    throw new EnterpriseUploadPolicyError(
      "upload_id_collision",
      `Upload ID generation collided ${UPLOAD_ID_GENERATION_ATTEMPTS} times.`,
    );
  }
}

function accessDenied(): EnterpriseUploadPolicyError {
  return new EnterpriseUploadPolicyError("upload_access_denied", UPLOAD_ACCESS_DENIED_MESSAGE);
}

function cleanupFailed(): EnterpriseUploadPolicyError {
  return new EnterpriseUploadPolicyError(
    "cleanup_failed",
    "One or more upload capabilities could not be released.",
  );
}

function storeQuarantined(): EnterpriseUploadPolicyError {
  return new EnterpriseUploadPolicyError(
    "store_quarantined",
    "Upload issuance is quarantined until capability cleanup succeeds.",
  );
}

function parseIssueInput(input: EnterpriseUploadIssueInput): ParsedUploadRequest {
  const parsed = EnterpriseUploadIssueInputSchema.parse(input);
  return Object.freeze({
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    sessionBindingGeneration: parsed.sessionBindingGeneration,
    workspaceId: parsed.workspaceId,
    relativePath: parseRelativePath(parsed.relativePath),
  });
}

function parseUseInput(input: EnterpriseUploadFinalizeInput): ParsedUploadUseRequest {
  const parsed = EnterpriseUploadUseInputSchema.parse(input);
  return Object.freeze({
    uploadId: parsed.uploadId,
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    sessionBindingGeneration: parsed.sessionBindingGeneration,
    workspaceId: parsed.workspaceId,
    relativePath: parseRelativePath(parsed.relativePath),
  });
}

function parseAppendInput(input: EnterpriseUploadAppendInput): ParsedUploadAppendRequest {
  const parsed = EnterpriseUploadAppendInputSchema.parse(input);
  return Object.freeze({
    uploadId: parsed.uploadId,
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    sessionBindingGeneration: parsed.sessionBindingGeneration,
    workspaceId: parsed.workspaceId,
    relativePath: parseRelativePath(parsed.relativePath),
    offset: parsed.offset,
    bytes: new Uint8Array(parsed.bytes),
  });
}

function snapshotUseInput(
  input: EnterpriseUploadFinalizeInput,
  uploadId: string,
): EnterpriseUploadFinalizeInput {
  return new Proxy(input, {
    get(target, property, receiver) {
      return property === "uploadId" ? uploadId : Reflect.get(target, property, receiver);
    },
  });
}

function snapshotAppendInput(
  input: EnterpriseUploadAppendInput,
  uploadId: string,
): EnterpriseUploadAppendInput {
  return {
    principal: input.principal,
    node: input.node,
    sessionBindingGeneration: input.sessionBindingGeneration,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    uploadId,
    offset: input.offset,
    bytes: input.bytes,
  };
}

function parseRelativePath(input: string): string {
  if (
    input.startsWith("/") ||
    /^[A-Za-z]:/.test(input) ||
    input.includes("\\") ||
    input.includes("\0")
  ) {
    throw accessDenied();
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw accessDenied();
  }
  return input;
}

function readUploadId(input: EnterpriseUploadFinalizeInput): string | null {
  if (typeof input !== "object" || input === null) return null;
  try {
    const rawUploadId = (input as { readonly uploadId?: unknown }).uploadId;
    return typeof rawUploadId === "string" ? rawUploadId : null;
  } catch {
    return null;
  }
}

function parseWorkspace(input: AuthorizedWorkspace): AuthorizedWorkspace {
  return freezeWorkspace(AuthorizedWorkspaceSchema.parse(input));
}

function parseFinalizedTarget(
  input: EnterpriseUploadFinalizedTarget,
): EnterpriseUploadFinalizedTarget {
  const parsed = EnterpriseUploadFinalizedTargetSchema.parse(input);
  return Object.freeze({
    ...cloneCapability(parsed),
    fileIdentity: freezeFileIdentity(parsed.fileIdentity),
  });
}

function cloneCapability(input: EnterpriseUploadCapability): EnterpriseUploadCapability {
  return Object.freeze({
    capabilityId: input.capabilityId,
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    directoryIdentity: freezeDirectoryIdentity(input.directoryIdentity),
  });
}

function freezeDirectoryIdentity(
  input: EnterpriseUploadDirectoryIdentity,
): EnterpriseUploadDirectoryIdentity {
  return Object.freeze({ dev: input.dev, ino: input.ino });
}

function freezeFileIdentity(input: EnterpriseUploadFileIdentity): EnterpriseUploadFileIdentity {
  return Object.freeze({
    dev: input.dev,
    ino: input.ino,
    size: input.size,
    mtimeMs: input.mtimeMs,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    grants,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
  }) as PrincipalContext;
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  return Object.freeze({ action: input.action, selector: cloneSelector(input.selector) });
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") return Object.freeze({ kind: input.kind });
  if (input.kind === "organization") {
    return Object.freeze({ kind: input.kind, organizationId: input.organizationId });
  }
  const workspaceIds = [...input.workspaceIds];
  Object.freeze(workspaceIds);
  return Object.freeze({ kind: input.kind, workspaceIds });
}

function freezeNode(input: NodeContext): NodeContext {
  return Object.freeze({
    nodeId: input.nodeId,
    paseoServerId: input.paseoServerId,
    mode: input.mode,
  });
}

function freezeWorkspace(input: AuthorizedWorkspace): AuthorizedWorkspace {
  return Object.freeze({
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    workspaceId: input.workspaceId,
  });
}

function freezeOwnedCapability(input: OwnedUploadCapability): OwnedUploadCapability {
  return Object.freeze({
    organizationId: input.organizationId,
    node: freezeNode(input.node),
    principalId: input.principalId,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
    sessionBindingGeneration: input.sessionBindingGeneration,
    workspace: freezeWorkspace(input.workspace),
    relativePath: input.relativePath,
    capability: cloneCapability(input.capability),
  });
}

function freezeRecord(input: EnterpriseUploadRecord): EnterpriseUploadRecord {
  return Object.freeze({ ...freezeOwnedCapability(input), expiresAt: input.expiresAt });
}

function freezeFinalizeResult(
  uploadId: string,
  record: EnterpriseUploadRecord,
  fileIdentity: EnterpriseUploadFileIdentity,
): EnterpriseUploadFinalizeResult {
  return Object.freeze({
    uploadId,
    workspace: freezeWorkspace(record.workspace),
    relativePath: record.relativePath,
    fileIdentity: freezeFileIdentity(fileIdentity),
  });
}

function freezeCleanupScope(input: EnterpriseUploadCleanupInput): EnterpriseUploadCleanupInput {
  return Object.freeze({ ...input, node: freezeNode(input.node) });
}

function workspaceMatchesRequest(
  request: ParsedUploadRequest,
  workspace: AuthorizedWorkspace,
): boolean {
  return (
    workspace.organizationId === request.principal.organizationId &&
    workspace.nodeId === request.node.nodeId &&
    workspace.workspaceId === request.workspaceId
  );
}

function workspaceIdentityMatches(left: AuthorizedWorkspace, right: AuthorizedWorkspace): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId &&
    left.workspaceId === right.workspaceId
  );
}

function capabilityMatchesWorkspace(
  capability: EnterpriseUploadCapability,
  workspace: AuthorizedWorkspace,
  relativePath: string,
): boolean {
  return (
    capability.organizationId === workspace.organizationId &&
    capability.nodeId === workspace.nodeId &&
    capability.workspaceId === workspace.workspaceId &&
    capability.relativePath === relativePath
  );
}

function recordMatchesRequest(
  record: EnterpriseUploadRecord,
  request: ParsedUploadUseRequest,
): boolean {
  return (
    record.organizationId === request.principal.organizationId &&
    nodeMatches(record.node, request.node) &&
    record.principalId === request.principal.principalId &&
    record.credentialId === request.principal.credentialId &&
    record.grantVersion === request.principal.grantVersion &&
    record.sessionBindingGeneration === request.sessionBindingGeneration &&
    record.workspace.workspaceId === request.workspaceId &&
    record.relativePath === request.relativePath
  );
}

function finalizedTargetMatchesCapability(
  target: EnterpriseUploadFinalizedTarget,
  capability: EnterpriseUploadCapability,
): boolean {
  return (
    target.capabilityId === capability.capabilityId &&
    target.organizationId === capability.organizationId &&
    target.nodeId === capability.nodeId &&
    target.workspaceId === capability.workspaceId &&
    target.relativePath === capability.relativePath &&
    target.directoryIdentity.dev === capability.directoryIdentity.dev &&
    target.directoryIdentity.ino === capability.directoryIdentity.ino
  );
}

function cleanupScopeMatchesRequest(
  scope: EnterpriseUploadCleanupInput,
  request: ParsedUploadRequest,
): boolean {
  return cleanupScopeMatchesIdentity(scope, {
    organizationId: request.principal.organizationId,
    node: request.node,
    principalId: request.principal.principalId,
    credentialId: request.principal.credentialId,
    grantVersion: request.principal.grantVersion,
    sessionBindingGeneration: request.sessionBindingGeneration,
  });
}

function cleanupScopeMatchesOwned(
  scope: EnterpriseUploadCleanupInput,
  owned: OwnedUploadCapability,
): boolean {
  return cleanupScopeMatchesIdentity(scope, owned);
}

function cleanupScopeMatchesIdentity(
  scope: EnterpriseUploadCleanupInput,
  identity: {
    readonly organizationId: string;
    readonly node: NodeContext;
    readonly principalId: string;
    readonly credentialId: string;
    readonly grantVersion: string;
    readonly sessionBindingGeneration: string;
  },
): boolean {
  if (
    scope.organizationId !== identity.organizationId ||
    !nodeMatches(scope.node, identity.node) ||
    scope.principalId !== identity.principalId
  ) {
    return false;
  }
  if (scope.reason === "principal-logout") return true;
  if (scope.credentialId !== identity.credentialId) return false;
  if (scope.reason === "credential-revoked") return true;
  return (
    scope.grantVersion === identity.grantVersion &&
    scope.sessionBindingGeneration === identity.sessionBindingGeneration
  );
}

function nodeMatches(left: NodeContext, right: NodeContext): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.paseoServerId === right.paseoServerId &&
    left.mode === right.mode
  );
}

function createDeferredOperation(): DeferredOperation {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}

function createIssueOperation(request: ParsedUploadRequest): IssueOperation {
  return {
    request,
    controller: new AbortController(),
    invalidated: false,
    ...createDeferredOperation(),
  };
}

function createInFlightOperation(
  uploadId: string,
  record: EnterpriseUploadRecord,
): InFlightOperation {
  return {
    uploadId,
    record,
    controller: new AbortController(),
    invalidated: false,
    ...createDeferredOperation(),
  };
}

function invalidateOperations(
  issuing: readonly IssueOperation[],
  inFlight: readonly InFlightOperation[],
): void {
  for (const operation of [...issuing, ...inFlight]) {
    operation.invalidated = true;
    operation.controller.abort();
  }
}

function takeMatchingMapValues<K, V>(map: Map<K, V>, matches: (value: V) => boolean): V[] {
  const values: V[] = [];
  for (const [key, value] of map) {
    if (matches(value)) {
      map.delete(key);
      values.push(value);
    }
  }
  return values;
}

function takeAllMapValues<K, V>(map: Map<K, V>): V[] {
  const values = [...map.values()];
  map.clear();
  return values;
}
