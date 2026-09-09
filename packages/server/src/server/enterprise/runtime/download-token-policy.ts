import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  EnterpriseResourceOwnerSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

const MAX_DOWNLOAD_TOKEN_TTL_MS = 60_000;
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
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
  })
  .strict();

const DownloadTokenConsumeInputSchema = DownloadTokenResolveInputSchema.extend({
  token: z.string().min(1),
}).strict();

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
  readonly workspaceId: string;
  readonly relativePath: string;
}

export interface DownloadTokenConsumeInput extends DownloadTokenResolveInput {
  readonly token: string;
}

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
  readonly nodeId: string;
  readonly principalId: string;
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
  readonly nodeId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly fileIdentity: DownloadFileIdentity;
  readonly expiresAt: number;
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
  private readonly resolver: DownloadTokenResolver;
  private readonly clock: DownloadTokenClock;
  private readonly randomSource: DownloadTokenRandomSource;
  private readonly records = new Map<string, DownloadTokenRecord>();
  private lastObservedNow: number | null = null;

  public constructor(options: DownloadTokenPolicyOptions) {
    if (
      !Number.isSafeInteger(options.ttlMs) ||
      options.ttlMs <= 0 ||
      options.ttlMs > MAX_DOWNLOAD_TOKEN_TTL_MS
    ) {
      throw new DownloadTokenPolicyError(
        "invalid_configuration",
        `Download token TTL must be a positive safe integer no greater than ${MAX_DOWNLOAD_TOKEN_TTL_MS}.`,
      );
    }
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      throw new DownloadTokenPolicyError(
        "invalid_configuration",
        "Download token capacity must be a positive safe integer.",
      );
    }
    this.ttlMs = options.ttlMs;
    this.capacity = options.capacity;
    this.resolver = options.resolver;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.randomSource = options.randomSource ?? SECURE_RANDOM_SOURCE;
  }

  public async issue(input: DownloadTokenResolveInput): Promise<DownloadTokenIssue> {
    const request = parseResolveInput(input);
    const target = parseResolvedTarget(await this.resolver.resolve(cloneResolveInput(request)));
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
    if (this.records.size >= this.capacity) {
      throw new DownloadTokenPolicyError(
        "capacity_exceeded",
        "Download token capacity is exhausted.",
      );
    }

    const token = this.createUniqueToken();
    const record = freezeRecord({
      organizationId: request.principal.organizationId,
      nodeId: request.node.nodeId,
      principalId: request.principal.principalId,
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      fileIdentity: target.fileIdentity,
      expiresAt,
    });
    this.records.set(token, record);
    return Object.freeze({ token, expiresAt });
  }

  public async consume(input: DownloadTokenConsumeInput): Promise<DownloadTokenBinding | null> {
    const record = this.records.get(input.token);
    if (!record) {
      return null;
    }
    this.records.delete(input.token);

    const parsed = DownloadTokenConsumeInputSchema.parse(input);
    const request = cloneResolveInput(parsed);
    const now = this.readClock();
    if (record.expiresAt <= now || !recordMatchesRequest(record, request)) {
      return null;
    }

    const target = parseResolvedTarget(await this.resolver.resolve(cloneResolveInput(request)));
    if (!resolvedWorkspaceMatchesRequest(request, target.workspace)) {
      return null;
    }
    if (!fileIdentityMatches(record.fileIdentity, target.fileIdentity)) {
      return null;
    }
    return freezeBinding(record, target);
  }

  private readClock(): number {
    const now = this.clock.now();
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
        this.records.delete(token);
      }
    }
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const bytes = this.randomSource.randomBytes(DOWNLOAD_TOKEN_BYTES);
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
    nodeId: input.nodeId,
    principalId: input.principalId,
    workspaceId: input.workspaceId,
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
    nodeId: record.nodeId,
    principalId: record.principalId,
    workspace: freezeWorkspace(target.workspace),
    relativePath: record.relativePath,
    fileIdentity: freezeFileIdentity(target.fileIdentity),
    expiresAt: record.expiresAt,
  };
  return Object.freeze(binding);
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
    record.nodeId === request.node.nodeId &&
    record.principalId === request.principal.principalId &&
    record.workspaceId === request.workspaceId &&
    record.relativePath === request.relativePath
  );
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
