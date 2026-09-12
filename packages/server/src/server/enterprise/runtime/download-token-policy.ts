import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  EnterpriseResourceOwnerSchema,
  NodeContextSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
  PrincipalIdSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

const MAX_DOWNLOAD_TOKEN_TTL_MS = 60_000;
export const DOWNLOAD_TOKEN_CAPACITY_HARD_MAX = 10_000;
const DOWNLOAD_TOKEN_BYTES = 32;
const DOWNLOAD_TOKEN_LENGTH = 43;
const TOKEN_GENERATION_ATTEMPTS = 3;
const CANONICAL_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();

const DownloadFileIdentitySchema = z
  .object({
    dev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ino: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mtimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const DownloadTokenResolveInputSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

const DownloadTokenConsumeInputSchema = DownloadTokenResolveInputSchema.extend({
  token: z.string().min(1),
}).strict();

const DownloadTokenCleanupNodeShape = {
  organizationId: OrganizationIdSchema,
  node: NodeContextSchema,
  principalType: z.enum(["human", "service", "break_glass_owner"]),
  principalId: PrincipalIdSchema,
};

const DownloadTokenCleanupScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("session"),
      ...DownloadTokenCleanupNodeShape,
      credentialId: z.string().min(1),
      grantVersion: z.string().min(1),
      sessionBindingGeneration: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("credential"),
      ...DownloadTokenCleanupNodeShape,
      credentialId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("principal"), ...DownloadTokenCleanupNodeShape }).strict(),
  z
    .object({
      kind: z.literal("grant"),
      ...DownloadTokenCleanupNodeShape,
      grantVersion: z.string().min(1),
    })
    .strict(),
]);

const DownloadTokenResolvedTargetSchema = z
  .object({
    workspace: AuthorizedWorkspaceSchema,
    fileIdentity: DownloadFileIdentitySchema,
  })
  .strict();

export interface DownloadFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DownloadTokenResolveInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly sessionBindingGeneration: string;
  readonly workspaceId: string;
  readonly relativePath: string;
}

export interface DownloadTokenConsumeInput extends DownloadTokenResolveInput {
  readonly token: string;
}

export type DownloadTokenCleanupScope = z.infer<typeof DownloadTokenCleanupScopeSchema>;

export interface DownloadTokenResolvedTarget {
  readonly workspace: AuthorizedWorkspace;
  readonly fileIdentity: DownloadFileIdentity;
}

export interface DownloadTokenResolver {
  resolve(input: DownloadTokenResolveInput): Promise<DownloadTokenResolvedTarget>;
}

export interface DownloadTokenClock {
  now(): number;
}

export interface DownloadTokenRandomSource {
  randomBytes(size: number): Uint8Array;
}

export interface DownloadTokenIssue {
  readonly token: string;
  readonly expiresAt: number;
}

export interface DownloadTokenBinding {
  readonly organizationId: string;
  readonly node: NodeContext;
  readonly principalType: PrincipalContext["principalType"];
  readonly principalId: string;
  readonly credentialId: string;
  readonly grantVersion: string;
  readonly sessionBindingGeneration: string;
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly fileIdentity: DownloadFileIdentity;
  readonly expiresAt: number;
}

export type DownloadTokenPolicyErrorCode =
  | "invalid_configuration"
  | "invalid_clock"
  | "clock_rollback"
  | "expiry_overflow"
  | "capacity_exceeded"
  | "invalid_random_bytes"
  | "token_collision"
  | "issue_invalidated"
  | "resolved_target_mismatch";

export class DownloadTokenPolicyError extends Error {
  public constructor(
    public readonly code: DownloadTokenPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DownloadTokenPolicyError";
  }
}

export interface DownloadTokenPolicyOptions {
  readonly ttlMs: number;
  readonly capacity: number;
  readonly resolver: DownloadTokenResolver;
  readonly clock?: DownloadTokenClock;
  readonly randomSource?: DownloadTokenRandomSource;
}

interface DownloadTokenRecord {
  readonly organizationId: string;
  readonly node: NodeContext;
  readonly principalType: PrincipalContext["principalType"];
  readonly principalId: string;
  readonly credentialId: string;
  readonly grantVersion: string;
  readonly sessionBindingGeneration: string;
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly fileIdentity: DownloadFileIdentity;
  readonly expiresAt: number;
}

interface DownloadTokenIssueOperation {
  readonly request: DownloadTokenResolveInput;
  active: boolean;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

const SYSTEM_CLOCK: DownloadTokenClock = Object.freeze({
  now(): number {
    return Date.now();
  },
});

const SECURE_RANDOM_SOURCE: DownloadTokenRandomSource = Object.freeze({
  randomBytes(size: number): Uint8Array {
    return randomBytes(size);
  },
});

export class DownloadTokenPolicy {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly resolve: DownloadTokenResolver["resolve"];
  private readonly now: DownloadTokenClock["now"];
  private readonly randomBytes: DownloadTokenRandomSource["randomBytes"];
  private readonly records = new Map<string, DownloadTokenRecord>();
  private readonly issuing = new Set<DownloadTokenIssueOperation>();
  private lastObservedNow: number | null = null;

  public constructor(options: DownloadTokenPolicyOptions) {
    const ttlMs = options.ttlMs;
    const capacity = options.capacity;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_DOWNLOAD_TOKEN_TTL_MS) {
      throw new DownloadTokenPolicyError(
        "invalid_configuration",
        `Download token TTL must be a positive safe integer no greater than ${MAX_DOWNLOAD_TOKEN_TTL_MS}.`,
      );
    }
    if (
      !Number.isSafeInteger(capacity) ||
      capacity <= 0 ||
      capacity > DOWNLOAD_TOKEN_CAPACITY_HARD_MAX
    ) {
      throw new DownloadTokenPolicyError(
        "invalid_configuration",
        `Download token capacity must be a positive safe integer no greater than ${DOWNLOAD_TOKEN_CAPACITY_HARD_MAX}.`,
      );
    }
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    const resolver = options.resolver;
    this.resolve = resolver.resolve.bind(resolver);
    const clock = options.clock ?? SYSTEM_CLOCK;
    const randomSource = options.randomSource ?? SECURE_RANDOM_SOURCE;
    this.now = clock.now.bind(clock);
    this.randomBytes = randomSource.randomBytes.bind(randomSource);
  }

  public async issue(input: DownloadTokenResolveInput): Promise<DownloadTokenIssue> {
    const request = parseResolveInput(input);
    const reservationNow = this.readClock();
    this.pruneExpired(reservationNow);
    if (this.records.size + this.issuing.size >= this.capacity) {
      throw new DownloadTokenPolicyError(
        "capacity_exceeded",
        "Download token capacity is exhausted.",
      );
    }
    const operation = createIssueOperation(request);
    this.issuing.add(operation);
    try {
      const target = parseResolvedTarget(await this.resolve(cloneResolveInput(request)));
      this.assertIssueCurrent(operation);
      if (!resolvedWorkspaceMatchesRequest(request, target.workspace)) {
        throw new DownloadTokenPolicyError(
          "resolved_target_mismatch",
          "Resolved download target does not match the authenticated request.",
        );
      }

      const now = this.readClock();
      const expiresAt = now + this.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new DownloadTokenPolicyError(
          "expiry_overflow",
          "Download token expiry exceeds the safe clock range.",
        );
      }
      this.pruneExpired(now);
      this.assertIssueCurrent(operation);
      const token = this.createUniqueToken();
      const record = freezeRecord({
        organizationId: request.principal.organizationId,
        node: request.node,
        principalType: request.principal.principalType,
        principalId: request.principal.principalId,
        credentialId: request.principal.credentialId,
        grantVersion: request.principal.grantVersion,
        sessionBindingGeneration: request.sessionBindingGeneration,
        workspace: target.workspace,
        relativePath: request.relativePath,
        fileIdentity: target.fileIdentity,
        expiresAt,
      });
      this.assertIssueCurrent(operation);
      this.records.set(token, record);
      return Object.freeze({ token, expiresAt });
    } finally {
      this.issuing.delete(operation);
      operation.active = false;
      operation.settle();
    }
  }

  public async consume(input: DownloadTokenConsumeInput): Promise<DownloadTokenBinding | null> {
    let token: string;
    try {
      token = input.token;
    } catch {
      return null;
    }
    const record = this.records.get(token);
    if (!record) {
      return null;
    }
    this.remove(token);

    let parsed: z.infer<typeof DownloadTokenConsumeInputSchema>;
    try {
      parsed = DownloadTokenConsumeInputSchema.parse(snapshotConsumeInput(input, token));
    } catch {
      return null;
    }
    const request = cloneResolveInput(parsed);
    const now = this.readClock();
    if (record.expiresAt <= now || !recordMatchesRequest(record, request)) {
      return null;
    }

    const target = parseResolvedTarget(await this.resolve(cloneResolveInput(request)));
    if (
      !resolvedWorkspaceMatchesRequest(request, target.workspace) ||
      !workspaceMatches(record.workspace, target.workspace)
    ) {
      return null;
    }
    if (!fileIdentityMatches(record.fileIdentity, target.fileIdentity)) {
      return null;
    }
    return freezeBinding(record, target);
  }

  /** Burns an opaque token when the outer HTTP envelope cannot be parsed safely. */
  public burn(token: string): boolean {
    if (typeof token !== "string" || token.length === 0) return false;
    return this.remove(token);
  }

  /** Synchronously burns active tokens matching one parsed lifecycle scope. */
  public burnScope(input: DownloadTokenCleanupScope): number {
    return this.startScopeCleanup(input).affected;
  }

  /** Invalidates synchronously, then waits for matching issue reservations to settle. */
  public cleanupScope(input: DownloadTokenCleanupScope): Promise<number> {
    const cleanup = this.startScopeCleanup(input);
    return Promise.all(cleanup.issues.map((operation) => operation.settled)).then(
      () => cleanup.affected,
    );
  }

  private startScopeCleanup(input: DownloadTokenCleanupScope): {
    readonly affected: number;
    readonly issues: readonly DownloadTokenIssueOperation[];
  } {
    let scope: DownloadTokenCleanupScope;
    try {
      scope = DownloadTokenCleanupScopeSchema.parse(input);
    } catch {
      return { affected: 0, issues: [] };
    }
    let affected = 0;
    for (const [token, record] of this.records) {
      if (recordMatchesCleanupScope(record, scope) && this.remove(token)) affected += 1;
    }
    const issues: DownloadTokenIssueOperation[] = [];
    for (const operation of this.issuing) {
      if (!requestMatchesCleanupScope(operation.request, scope)) continue;
      issues.push(operation);
      if (operation.active) {
        operation.active = false;
        affected += 1;
      }
    }
    return { affected, issues };
  }

  private assertIssueCurrent(operation: DownloadTokenIssueOperation): void {
    if (!operation.active) {
      throw new DownloadTokenPolicyError(
        "issue_invalidated",
        "Download token issue is no longer current.",
      );
    }
  }

  private readClock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DownloadTokenPolicyError(
        "invalid_clock",
        "Download token clock must return a nonnegative safe integer.",
      );
    }
    if (this.lastObservedNow !== null && now < this.lastObservedNow) {
      throw new DownloadTokenPolicyError("clock_rollback", "Download token clock moved backwards.");
    }
    this.lastObservedNow = now;
    return now;
  }

  private pruneExpired(now: number): void {
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.remove(token);
      }
    }
  }

  private remove(token: string): boolean {
    return this.records.delete(token);
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const bytes = this.randomBytes(DOWNLOAD_TOKEN_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DOWNLOAD_TOKEN_BYTES) {
        throw new DownloadTokenPolicyError(
          "invalid_random_bytes",
          `Download token random source must return exactly ${DOWNLOAD_TOKEN_BYTES} bytes.`,
        );
      }
      const token = Buffer.from(bytes).toString("base64url");
      const isCanonical =
        token.length === DOWNLOAD_TOKEN_LENGTH &&
        CANONICAL_BASE64URL_PATTERN.test(token) &&
        Buffer.from(token, "base64url").toString("base64url") === token;
      if (!isCanonical) {
        throw new DownloadTokenPolicyError(
          "invalid_random_bytes",
          "Download token random source did not produce a canonical base64url token.",
        );
      }
      if (!this.records.has(token)) {
        return token;
      }
    }
    throw new DownloadTokenPolicyError(
      "token_collision",
      `Download token generation collided ${TOKEN_GENERATION_ATTEMPTS} times.`,
    );
  }
}

function parseResolveInput(input: DownloadTokenResolveInput): DownloadTokenResolveInput {
  return cloneResolveInput(DownloadTokenResolveInputSchema.parse(input));
}

function snapshotConsumeInput(
  input: DownloadTokenConsumeInput,
  token: string,
): DownloadTokenConsumeInput {
  return {
    principal: input.principal,
    node: input.node,
    sessionBindingGeneration: input.sessionBindingGeneration,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
    token,
  };
}

function parseResolvedTarget(input: DownloadTokenResolvedTarget): DownloadTokenResolvedTarget {
  const parsed = DownloadTokenResolvedTargetSchema.parse(input);
  const frozenWorkspace = freezeWorkspace(parsed.workspace);
  const frozenIdentity = freezeFileIdentity(parsed.fileIdentity);
  return Object.freeze({ workspace: frozenWorkspace, fileIdentity: frozenIdentity });
}

function cloneResolveInput(input: DownloadTokenResolveInput): DownloadTokenResolveInput {
  const cloned: DownloadTokenResolveInput = {
    principal: freezePrincipal(input.principal),
    node: freezeNode(input.node),
    sessionBindingGeneration: input.sessionBindingGeneration,
    workspaceId: input.workspaceId,
    relativePath: input.relativePath,
  };
  return Object.freeze(cloned);
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") {
    return Object.freeze({
      principalType: input.principalType,
      principalId: input.principalId,
      organizationId: input.organizationId,
      grants,
      credentialId: input.credentialId,
      grantVersion: input.grantVersion,
    });
  }
  if (input.principalType === "service") {
    return Object.freeze({
      principalType: input.principalType,
      principalId: input.principalId,
      organizationId: input.organizationId,
      grants,
      credentialId: input.credentialId,
      grantVersion: input.grantVersion,
    });
  }
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    grants,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
  });
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  const grant: ResourceGrant = {
    action: input.action,
    selector: cloneSelector(input.selector),
  };
  return Object.freeze(grant);
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") {
    return Object.freeze({ kind: input.kind });
  }
  if (input.kind === "organization") {
    return Object.freeze({ kind: input.kind, organizationId: input.organizationId });
  }
  const workspaceIds = [...input.workspaceIds];
  Object.freeze(workspaceIds);
  return Object.freeze({ kind: input.kind, workspaceIds });
}

function freezeNode(input: NodeContext): NodeContext {
  const cloned: NodeContext = {
    nodeId: input.nodeId,
    paseoServerId: input.paseoServerId,
    mode: input.mode,
  };
  return Object.freeze(cloned);
}

function freezeWorkspace(input: AuthorizedWorkspace): AuthorizedWorkspace {
  const cloned: AuthorizedWorkspace = {
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    workspaceId: input.workspaceId,
  };
  return Object.freeze(cloned);
}

function freezeFileIdentity(input: DownloadFileIdentity): DownloadFileIdentity {
  const cloned: DownloadFileIdentity = {
    dev: input.dev,
    ino: input.ino,
    size: input.size,
    mtimeMs: input.mtimeMs,
  };
  return Object.freeze(cloned);
}

function freezeRecord(input: DownloadTokenRecord): DownloadTokenRecord {
  const cloned: DownloadTokenRecord = {
    organizationId: input.organizationId,
    node: freezeNode(input.node),
    principalType: input.principalType,
    principalId: input.principalId,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
    sessionBindingGeneration: input.sessionBindingGeneration,
    workspace: freezeWorkspace(input.workspace),
    relativePath: input.relativePath,
    fileIdentity: freezeFileIdentity(input.fileIdentity),
    expiresAt: input.expiresAt,
  };
  return Object.freeze(cloned);
}

function freezeBinding(
  record: DownloadTokenRecord,
  target: DownloadTokenResolvedTarget,
): DownloadTokenBinding {
  const binding: DownloadTokenBinding = {
    organizationId: record.organizationId,
    node: freezeNode(record.node),
    principalType: record.principalType,
    principalId: record.principalId,
    credentialId: record.credentialId,
    grantVersion: record.grantVersion,
    sessionBindingGeneration: record.sessionBindingGeneration,
    workspace: freezeWorkspace(record.workspace),
    relativePath: record.relativePath,
    fileIdentity: freezeFileIdentity(target.fileIdentity),
    expiresAt: record.expiresAt,
  };
  return Object.freeze(binding);
}

function recordMatchesCleanupScope(
  record: DownloadTokenRecord,
  scope: DownloadTokenCleanupScope,
): boolean {
  if (
    record.organizationId !== scope.organizationId ||
    !nodeMatches(record.node, scope.node) ||
    record.principalType !== scope.principalType ||
    record.principalId !== scope.principalId
  ) {
    return false;
  }
  if (scope.kind === "principal") return true;
  if (scope.kind === "credential") return record.credentialId === scope.credentialId;
  if (scope.kind === "grant") return record.grantVersion === scope.grantVersion;
  return (
    record.credentialId === scope.credentialId &&
    record.grantVersion === scope.grantVersion &&
    record.sessionBindingGeneration === scope.sessionBindingGeneration
  );
}

function requestMatchesCleanupScope(
  request: DownloadTokenResolveInput,
  scope: DownloadTokenCleanupScope,
): boolean {
  if (
    request.principal.organizationId !== scope.organizationId ||
    !nodeMatches(request.node, scope.node) ||
    request.principal.principalType !== scope.principalType ||
    request.principal.principalId !== scope.principalId
  ) {
    return false;
  }
  if (scope.kind === "principal") return true;
  if (scope.kind === "credential") {
    return request.principal.credentialId === scope.credentialId;
  }
  if (scope.kind === "grant") return request.principal.grantVersion === scope.grantVersion;
  return (
    request.principal.credentialId === scope.credentialId &&
    request.principal.grantVersion === scope.grantVersion &&
    request.sessionBindingGeneration === scope.sessionBindingGeneration
  );
}

function resolvedWorkspaceMatchesRequest(
  request: DownloadTokenResolveInput,
  workspace: AuthorizedWorkspace,
): boolean {
  return (
    workspace.organizationId === request.principal.organizationId &&
    workspace.nodeId === request.node.nodeId &&
    workspace.workspaceId === request.workspaceId
  );
}

function recordMatchesRequest(
  record: DownloadTokenRecord,
  request: DownloadTokenResolveInput,
): boolean {
  return (
    record.organizationId === request.principal.organizationId &&
    nodeMatches(record.node, request.node) &&
    record.principalType === request.principal.principalType &&
    record.principalId === request.principal.principalId &&
    record.credentialId === request.principal.credentialId &&
    record.grantVersion === request.principal.grantVersion &&
    record.sessionBindingGeneration === request.sessionBindingGeneration &&
    record.workspace.workspaceId === request.workspaceId &&
    record.relativePath === request.relativePath
  );
}

function nodeMatches(expected: NodeContext, actual: NodeContext): boolean {
  return (
    expected.nodeId === actual.nodeId &&
    expected.paseoServerId === actual.paseoServerId &&
    expected.mode === actual.mode
  );
}

function workspaceMatches(expected: AuthorizedWorkspace, actual: AuthorizedWorkspace): boolean {
  return (
    expected.organizationId === actual.organizationId &&
    expected.nodeId === actual.nodeId &&
    expected.ownerPrincipalId === actual.ownerPrincipalId &&
    expected.createdByPrincipalId === actual.createdByPrincipalId &&
    expected.workspaceId === actual.workspaceId
  );
}

function createIssueOperation(request: DownloadTokenResolveInput): DownloadTokenIssueOperation {
  let resolveSettled!: () => void;
  return {
    request,
    active: true,
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve;
    }),
    settle: () => resolveSettled(),
  };
}

function fileIdentityMatches(
  expected: DownloadFileIdentity,
  actual: DownloadFileIdentity,
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  );
}
