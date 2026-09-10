import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { compare, hash } from "bcryptjs";
import { z } from "zod";
import type {
  AuditSink,
  NodeContext,
  OrganizationId,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { NodeContextSchema, PrincipalContextSchema } from "@getpaseo/protocol/messages";
import { type IdentityRegistryFsPort, nodeIdentityRegistryFs } from "./fs-port.js";

export const PAT_PREFIX = "pso_u_";
export const PAT_BCRYPT_COST = 12;
const PAT_PATTERN = /^pso_u_(cred_[0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
const CREDENTIAL_ID_PATTERN = /^cred_[0-9a-f]{24}$/;
const CredentialSchema = z
  .object({
    credentialId: z.string().regex(CREDENTIAL_ID_PATTERN),
    principalId: z.string().regex(/^(usr|svc)_[0-9a-f]{16}$/),
    organizationId: z.string().regex(/^org_[0-9a-f]{16}$/),
    secretHash: z.string().regex(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    lastUsedAt: z.string().datetime({ offset: true }).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const RegistryDocumentSchema = z
  .object({ version: z.literal(1), credentials: z.record(z.string(), CredentialSchema) })
  .strict()
  .superRefine((doc, ctx) => {
    for (const [key, value] of Object.entries(doc.credentials))
      if (key !== value.credentialId)
        ctx.addIssue({
          code: "custom",
          path: ["credentials", key],
          message: "credential key mismatch",
        });
  });
type CredentialRecord = z.infer<typeof CredentialSchema>;
type RegistryDocument = z.infer<typeof RegistryDocumentSchema>;

export type PrincipalGrantProjection = Omit<PrincipalContext, "credentialId">;
export interface PrincipalGrantSource {
  resolvePrincipal(
    principalId: string,
    organizationId: OrganizationId,
  ): Promise<PrincipalGrantProjection | null>;
}
export interface IdentityClock {
  now(): string;
}
export interface CredentialIdSource {
  next(): string;
}
export interface SecretSource {
  next(): string;
}
export interface PasswordHasher {
  hash(secret: string): Promise<string>;
}
export interface PasswordVerifier {
  compare(secret: string, digest: string): Promise<boolean>;
}
export interface IdentityAuditSink extends AuditSink {}
export interface IdentityRegistryOptions {
  filePath: string;
  principalSource: PrincipalGrantSource;
  node: NodeContext;
  audit: IdentityAuditSink;
  clock?: IdentityClock;
  credentialIds?: CredentialIdSource;
  secrets?: SecretSource;
  hasher?: PasswordHasher;
  verifier?: PasswordVerifier;
  invalidation: CredentialInvalidationSink;
  fs?: IdentityRegistryFsPort;
}
export interface CredentialInvalidation {
  kind: "credential.revoke" | "credential.rotate" | "principal.logout_all";
  credentialIds: string[];
  principalId: string;
  organizationId: OrganizationId;
}
export interface CurrentCredentialContext {
  organizationId: OrganizationId;
  principalId: string;
  credentialId: string;
  grantVersion: string;
}
export type InitialCredentialResult =
  | { readonly status: "issued"; readonly token: string; readonly credentialId: string }
  | { readonly status: "already_provisioned"; readonly credentialIds: readonly string[] };
export interface CredentialInvalidationSink {
  publish?(event: CredentialInvalidation): Promise<void>;
  publishCredentialInvalidation?(event: CredentialInvalidation): Promise<void>;
}
export class CredentialInvalidationCommittedError extends Error {
  readonly committed = true as const;
  constructor(
    readonly event: CredentialInvalidation,
    cause: unknown,
  ) {
    super("Credential state committed but invalidation delivery failed", { cause });
  }
}
export class IdentityRegistryPoisonedError extends Error {
  readonly code = "identity_registry_poisoned";

  constructor(options?: ErrorOptions) {
    super("Identity registry is poisoned", options);
    this.name = "IdentityRegistryPoisonedError";
  }
}

export class IdentityRegistryStorageUnsupportedError extends Error {
  readonly code = "identity_registry_nofollow_unavailable";

  constructor() {
    super("Identity registry requires a non-zero O_NOFOLLOW flag");
    this.name = "IdentityRegistryStorageUnsupportedError";
  }
}

class PostCommitPersistenceError extends Error {
  readonly postCommit = true as const;

  constructor(readonly primaryError: unknown) {
    super("Registry directory durability failed after rename", { cause: primaryError });
  }
}
export type CredentialActor = PrincipalContext;
export interface IssuedPersonalAccessToken {
  token: string;
  credentialId: string;
  principal: PrincipalContext;
}

const defaultClock: IdentityClock = { now: () => new Date().toISOString() };
const defaultIds: CredentialIdSource = { next: () => `cred_${randomBytes(12).toString("hex")}` };
const defaultSecrets: SecretSource = { next: () => randomBytes(32).toString("base64url") };
const defaultHasher: PasswordHasher = { hash: (secret) => hash(secret, PAT_BCRYPT_COST) };
const defaultVerifier: PasswordVerifier = { compare: (secret, digest) => compare(secret, digest) };

export function formatPersonalAccessToken(credentialId: string, secret: string): string {
  if (!CREDENTIAL_ID_PATTERN.test(credentialId) || !isCanonicalSecret(secret))
    throw new Error("Invalid personal access token components");
  return `${PAT_PREFIX}${credentialId}.${secret}`;
}
function isCanonicalSecret(secret: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  try {
    const bytes = Buffer.from(secret, "base64url");
    return bytes.length === 32 && bytes.toString("base64url") === secret;
  } catch {
    return false;
  }
}
export function parsePersonalAccessToken(
  token: string,
): { credentialId: string; secret: string } | null {
  const match = PAT_PATTERN.exec(token);
  if (!match) return null;
  const secret = match[2]!;
  try {
    if (!isCanonicalSecret(secret)) return null;
  } catch {
    return null;
  }
  return { credentialId: match[1]!, secret };
}
function isExpired(value: string | undefined, now: string): boolean {
  return value !== undefined && Date.parse(value) <= Date.parse(now);
}
function normalizedGrants(value: PrincipalContext["grants"]): string {
  return JSON.stringify([...value].map((g) => JSON.stringify(g)).sort());
}

export class IdentityRegistry {
  private readonly options: IdentityRegistryOptions;
  private readonly clock: IdentityClock;
  private readonly ids: CredentialIdSource;
  private readonly secrets: SecretSource;
  private readonly hasher: PasswordHasher;
  private readonly verifier: PasswordVerifier;
  private readonly fs: IdentityRegistryFsPort;
  private readonly noFollowFlag: number;
  private document: RegistryDocument = { version: 1, credentials: {} };
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  private poisoned = false;
  private lastClockMs = -Infinity;
  private captureClock(): string {
    const value = this.clock.now();
    if (!z.string().datetime({ offset: true }).safeParse(value).success)
      throw new Error("Invalid identity clock");
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || ms < this.lastClockMs)
      throw new Error("Identity clock moved backwards");
    this.lastClockMs = ms;
    return value;
  }

  private poisonPath(): string {
    return `${this.options.filePath}.poison`;
  }

  private assertHealthy(): void {
    if (this.poisoned) throw new IdentityRegistryPoisonedError();
  }

  private openIfPresent(filePath: string, flags: number): number | null {
    try {
      return this.fs.open(filePath, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private closeHandle(fd: number, primaryError?: unknown): void {
    try {
      this.fs.close(fd);
    } catch (closeError) {
      if (primaryError !== undefined)
        // oxlint-disable-next-line preserve-caught-error -- both failures are retained in order.
        throw new AggregateError(
          [primaryError, closeError],
          "Identity registry handle operation and close both failed",
          { cause: primaryError },
        );
      throw closeError;
    }
  }

  private openParentDirectory(directoryPath: string): number {
    const fd = this.fs.open(directoryPath, constants.O_RDONLY | this.noFollowFlag);
    let primaryError: unknown;
    try {
      if (!this.fs.fstat(fd).isDirectory())
        throw new Error("Identity registry parent is not a directory");
      return fd;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (primaryError !== undefined) this.closeHandle(fd, primaryError);
    }
  }

  private syncParentDirectory(directoryPath: string): void {
    const fd = this.openParentDirectory(directoryPath);
    let primaryError: unknown;
    try {
      this.fs.fsync(fd);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      this.closeHandle(fd, primaryError);
    }
  }

  private ensurePrivateParentDirectory(): void {
    const directoryPath = path.dirname(this.options.filePath);
    this.fs.mkdir(directoryPath, 0o700);
    const fd = this.openParentDirectory(directoryPath);
    let primaryError: unknown;
    try {
      this.fs.fchmod(fd, 0o700);
      if ((this.fs.fstat(fd).mode & 0o777) !== 0o700)
        throw new Error("Identity registry directory is not private");
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      this.closeHandle(fd, primaryError);
    }
  }

  private persistPoisonMarker(): void {
    const marker = this.poisonPath();
    const dir = path.dirname(marker);
    const fd = this.fs.open(
      marker,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | this.noFollowFlag,
      0o600,
    );
    let primaryError: unknown;
    try {
      this.fs.write(fd, "poisoned\n");
      this.fs.fchmod(fd, 0o600);
      const markerStat = this.fs.fstat(fd);
      if (!markerStat.isFile() || (markerStat.mode & 0o777) !== 0o600)
        throw new Error("Invalid identity registry poison marker");
      this.fs.fsync(fd);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      this.closeHandle(fd, primaryError);
    }
    this.syncParentDirectory(dir);
  }
  private snapshot(): RegistryDocument {
    return JSON.parse(JSON.stringify(this.document)) as RegistryDocument;
  }
  private async auditBuffered(input: Parameters<AuditSink["append"]>[0]): Promise<void> {
    await this.options.audit.append(input, { durability: "required" });
  }
  private async auditFailure(
    input: Omit<Parameters<AuditSink["append"]>[0], "outcome" | "reasonCode">,
    primary: unknown,
  ): Promise<never> {
    try {
      await this.options.audit.append(
        { ...input, outcome: "failed", reasonCode: "storage_or_invalidation_failure" },
        { durability: "required" },
      );
    } catch (auditError) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError retains primary and audit failures.
      throw new AggregateError(
        [primary, auditError],
        "Identity failure and failed-audit both failed",
        { cause: primary },
      );
    }
    throw primary;
  }
  private async publishInvalidation(event: CredentialInvalidation): Promise<void> {
    try {
      const sink =
        this.options.invalidation.publishCredentialInvalidation ??
        this.options.invalidation.publish;
      if (!sink) throw new Error("Credential invalidation sink is unavailable");
      await sink(Object.freeze(JSON.parse(JSON.stringify(event))));
    } catch (error) {
      throw new CredentialInvalidationCommittedError(event, error);
    }
  }
  constructor(options: IdentityRegistryOptions) {
    if (!options.invalidation.publish && !options.invalidation.publishCredentialInvalidation)
      throw new Error("Credential invalidation sink is required");
    this.options = { ...options, node: NodeContextSchema.parse(options.node) };
    this.clock = options.clock ?? defaultClock;
    this.ids = options.credentialIds ?? defaultIds;
    this.secrets = options.secrets ?? defaultSecrets;
    this.hasher = options.hasher ?? defaultHasher;
    this.verifier = options.verifier ?? defaultVerifier;
    this.fs = options.fs ?? nodeIdentityRegistryFs;
    if (!Number.isInteger(this.fs.noFollowFlag) || this.fs.noFollowFlag <= 0)
      throw new IdentityRegistryStorageUnsupportedError();
    this.noFollowFlag = this.fs.noFollowFlag;
  }

  private persistSnapshot(snapshot: RegistryDocument): void {
    snapshot = RegistryDocumentSchema.parse(JSON.parse(JSON.stringify(snapshot)));
    const dir = path.dirname(this.options.filePath);
    this.ensurePrivateParentDirectory();
    const temp = `${this.options.filePath}.${randomBytes(8).toString("hex")}.tmp`;
    let fd = -1;
    let tempExists = false;
    let committed = false;
    try {
      fd = this.fs.open(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | this.noFollowFlag,
        0o600,
      );
      tempExists = true;
      this.fs.write(fd, `${JSON.stringify(snapshot)}\n`);
      this.fs.fchmod(fd, 0o600);
      const tempStat = this.fs.fstat(fd);
      if (!tempStat.isFile() || (tempStat.mode & 0o777) !== 0o600)
        throw new Error("Identity registry temporary file is not private");
      this.fs.fsync(fd);
      this.fs.close(fd);
      fd = -1;
      this.fs.rename(temp, this.options.filePath);
      tempExists = false;
      committed = true;
      this.syncParentDirectory(dir);
    } catch (error) {
      if (committed) throw new PostCommitPersistenceError(error);
      const failures: unknown[] = [error];
      if (fd !== -1)
        try {
          this.fs.close(fd);
        } catch (closeError) {
          failures.push(closeError);
        }
      if (tempExists)
        try {
          this.fs.unlink(temp);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(unlinkError);
        }
      if (failures.length > 1)
        // oxlint-disable-next-line preserve-caught-error -- both failures are retained in order.
        throw new AggregateError(
          failures,
          "Identity registry write and pre-rename cleanup failed",
          { cause: error },
        );
      throw error;
    }
  }

  private removeSnapshot(): void {
    try {
      this.fs.unlink(this.options.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.syncParentDirectory(path.dirname(this.options.filePath));
  }

  private persist(previous: RegistryDocument | null): void {
    try {
      this.persistSnapshot(this.document);
    } catch (error) {
      if (error instanceof PostCommitPersistenceError) {
        let rollbackError: unknown;
        try {
          if (previous) this.persistSnapshot(previous);
          else this.removeSnapshot();
        } catch (failure) {
          rollbackError = failure;
        }
        if (rollbackError === undefined) throw error.primaryError;
        this.poisoned = true;
        try {
          this.persistPoisonMarker();
        } catch (markerError) {
          // oxlint-disable-next-line preserve-caught-error
          throw new AggregateError(
            [error.primaryError, rollbackError, markerError],
            "Identity registry rollback and poison marker persistence failed",
            { cause: error.primaryError },
          );
        }
        // oxlint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [error.primaryError, rollbackError],
          "Identity registry rollback failed; registry is poisoned",
          { cause: error.primaryError },
        );
      }
      throw error;
    }
  }

  async load(): Promise<void> {
    this.assertHealthy();
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadOnce();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }
  private async loadOnce(): Promise<void> {
    if (this.loaded) return;
    let markerFd: number | null;
    try {
      markerFd = this.openIfPresent(this.poisonPath(), constants.O_RDONLY | this.noFollowFlag);
    } catch (error) {
      this.poisoned = true;
      throw new IdentityRegistryPoisonedError({ cause: error });
    }
    if (markerFd !== null) {
      this.poisoned = true;
      let markerError: unknown;
      try {
        const st = this.fs.fstat(markerFd);
        if (!st.isFile() || (st.mode & 0o777) !== 0o600 || this.fs.read(markerFd) !== "poisoned\n")
          throw new IdentityRegistryPoisonedError();
      } catch (error) {
        markerError =
          error instanceof IdentityRegistryPoisonedError
            ? error
            : new IdentityRegistryPoisonedError({ cause: error });
        throw markerError;
      } finally {
        this.closeHandle(markerFd, markerError);
      }
      throw new IdentityRegistryPoisonedError();
    }
    this.ensurePrivateParentDirectory();
    const fd = this.openIfPresent(this.options.filePath, constants.O_RDONLY | this.noFollowFlag);
    if (fd === null) {
      this.persist(null);
      this.loaded = true;
      return;
    }
    let operationError: unknown;
    try {
      const opened = this.fs.fstat(fd);
      if (!opened.isFile()) throw new Error("Identity registry is not a regular file");
      this.fs.fchmod(fd, 0o600);
      if ((this.fs.fstat(fd).mode & 0o777) !== 0o600)
        throw new Error("Identity registry permissions are not private");
      const contents = this.fs.read(fd);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(contents);
      } catch (error) {
        throw new Error("Invalid identity registry", { cause: error });
      }
      const parsed = RegistryDocumentSchema.safeParse(parsedJson);
      if (!parsed.success) throw new Error("Invalid identity registry");
      this.document = parsed.data;
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      this.closeHandle(fd, operationError);
    }
    this.loaded = true;
  }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.load();
      return await operation();
    } finally {
      release();
    }
  }
  async issueToken(input: {
    actor: CredentialActor;
    principalId: string;
    organizationId: OrganizationId;
    expiresAt?: string;
  }): Promise<IssuedPersonalAccessToken> {
    const snapshotInput = { ...input, actor: PrincipalContextSchema.parse(input.actor) };
    return this.serial(async () => {
      const actor = snapshotInput.actor;
      if (actor.organizationId !== snapshotInput.organizationId)
        throw new Error("Actor organization mismatch");
      const principal = await this.options.principalSource.resolvePrincipal(
        snapshotInput.principalId,
        snapshotInput.organizationId,
      );
      if (
        !principal ||
        principal.principalId !== snapshotInput.principalId ||
        principal.organizationId !== snapshotInput.organizationId
      )
        throw new Error("Unknown principal");
      const candidateCredentialId = this.ids.next();
      const canonicalPrincipal = PrincipalContextSchema.parse({
        ...principal,
        credentialId: candidateCredentialId,
      });
      if (this.document.credentials[candidateCredentialId])
        throw new Error("Credential ID collision");
      const credentialId = candidateCredentialId;
      const createdAt = this.captureClock();
      if (snapshotInput.expiresAt) {
        if (!z.string().datetime({ offset: true }).safeParse(snapshotInput.expiresAt).success)
          throw new Error("Invalid expiration");
        if (isExpired(snapshotInput.expiresAt, createdAt))
          throw new Error("Credential already expired");
      }
      const secret = this.secrets.next();
      if (!CREDENTIAL_ID_PATTERN.test(credentialId) || !isCanonicalSecret(secret))
        throw new Error("Invalid credential source");
      const record: CredentialRecord = {
        credentialId,
        principalId: snapshotInput.principalId,
        organizationId: snapshotInput.organizationId,
        secretHash: await this.hasher.hash(secret),
        createdAt,
        ...(snapshotInput.expiresAt ? { expiresAt: snapshotInput.expiresAt } : {}),
      };
      const valid = CredentialSchema.safeParse(record);
      if (!valid.success) throw new Error("Invalid credential metadata");
      const previous = this.snapshot();
      this.document.credentials[credentialId] = valid.data;
      try {
        await this.options.audit.append(
          {
            organizationId: snapshotInput.organizationId,
            actorPrincipalId: actor.principalId,
            actorCredentialId: actor.credentialId,
            action: "identity.credential.issue",
            outcome: "allowed",
            resource: { kind: "credential", id: credentialId },
          },
          { durability: "required" },
        );
      } catch (error) {
        delete this.document.credentials[credentialId];
        throw error;
      }
      try {
        this.persist(previous);
      } catch (error) {
        this.document = previous;
        return this.auditFailure(
          {
            organizationId: snapshotInput.organizationId,
            actorPrincipalId: actor.principalId,
            actorCredentialId: actor.credentialId,
            action: "identity.credential.issue",
            resource: { kind: "credential", id: credentialId },
          },
          error,
        );
      }
      const authenticatedPrincipal = canonicalPrincipal;
      return {
        token: formatPersonalAccessToken(credentialId, secret),
        credentialId,
        principal: authenticatedPrincipal,
      };
    });
  }

  async issueInitialCredential(input: {
    actor: CredentialActor;
    principalId: string;
    organizationId: OrganizationId;
    expiresAt?: string;
  }): Promise<InitialCredentialResult> {
    const existing = await this.serial(async () => {
      const now = this.captureClock();
      return Object.values(this.document.credentials)
        .filter(
          (credential) =>
            credential.principalId === input.principalId &&
            credential.organizationId === input.organizationId &&
            !credential.revokedAt &&
            (!credential.expiresAt || !isExpired(credential.expiresAt, now)),
        )
        .map((credential) => credential.credentialId);
    });
    if (existing.length > 0)
      return { status: "already_provisioned", credentialIds: Object.freeze(existing) };
    const issued = await this.issueToken(input);
    return { status: "issued", token: issued.token, credentialId: issued.credentialId };
  }
  async authenticate(token: string, node: NodeContext): Promise<PrincipalContext | null> {
    if (this.poisoned) return null;
    const canonicalNode = NodeContextSchema.parse(node);
    if (
      canonicalNode.nodeId !== this.options.node.nodeId ||
      canonicalNode.paseoServerId !== this.options.node.paseoServerId ||
      canonicalNode.mode !== this.options.node.mode
    )
      return null;
    try {
      await this.load();
    } catch (error) {
      if (error instanceof IdentityRegistryPoisonedError) return null;
      throw error;
    }
    const parsed = parsePersonalAccessToken(token);
    if (!parsed) return null;
    const credential = this.document.credentials[parsed.credentialId];
    const now = this.captureClock();
    if (
      !z.string().datetime({ offset: true }).safeParse(now).success ||
      !Number.isFinite(Date.parse(now))
    )
      throw new Error("Invalid identity clock");
    if (!credential || credential.revokedAt || isExpired(credential.expiresAt, now)) return null;
    if (!(await this.verifier.compare(parsed.secret, credential.secretHash))) {
      await this.auditBuffered({
        organizationId: credential.organizationId,
        actorPrincipalId: credential.principalId,
        action: "identity.credential.use",
        outcome: "failed",
        reasonCode: "invalid_secret",
        resource: { kind: "credential", id: credential.credentialId },
      });
      return null;
    }
    const projection = await this.options.principalSource.resolvePrincipal(
      credential.principalId,
      credential.organizationId,
    );
    if (
      !projection ||
      projection.principalId !== credential.principalId ||
      projection.organizationId !== credential.organizationId
    )
      return null;
    let currentValid = false;
    await this.serial(async () => {
      const current = this.document.credentials[credential.credentialId];
      if (!current || current.revokedAt || isExpired(current.expiresAt, now)) return;
      const previous = this.snapshot();
      current.lastUsedAt = now;
      try {
        this.persist(previous);
        currentValid = true;
      } catch (error) {
        this.document = previous;
        if (this.poisoned) throw error;
      }
    });
    if (!currentValid) return null;
    await this.auditBuffered({
      organizationId: credential.organizationId,
      actorPrincipalId: credential.principalId,
      actorCredentialId: credential.credentialId,
      action: "identity.credential.use",
      outcome: "allowed",
      resource: { kind: "credential", id: credential.credentialId },
    });
    const stillValid = await this.serial(async () => {
      const current = this.document.credentials[credential.credentialId];
      return Boolean(current && !current.revokedAt && !isExpired(current.expiresAt, now));
    });
    if (!stillValid) return null;
    return PrincipalContextSchema.parse({ ...projection, credentialId: credential.credentialId });
  }

  async isCurrentPrincipalContext(context: PrincipalContext): Promise<boolean> {
    try {
      const parsed = PrincipalContextSchema.parse(context);
      await this.load();
      const initial = this.document.credentials[parsed.credentialId];
      if (!initial) return false;
      const current = await this.options.principalSource.resolvePrincipal(
        initial.principalId,
        initial.organizationId,
      );
      if (!current) return false;
      const canonical = PrincipalContextSchema.parse({
        ...current,
        credentialId: initial.credentialId,
      });
      return await this.serial(async () => {
        const record = this.document.credentials[parsed.credentialId];
        if (
          !record ||
          record !== initial ||
          record.revokedAt ||
          isExpired(record.expiresAt, this.captureClock())
        )
          return false;
        return (
          canonical.principalType === parsed.principalType &&
          canonical.principalId === parsed.principalId &&
          canonical.organizationId === parsed.organizationId &&
          canonical.credentialId === parsed.credentialId &&
          canonical.grantVersion === parsed.grantVersion &&
          normalizedGrants(canonical.grants) === normalizedGrants(parsed.grants)
        );
      });
      /* istanbul ignore next */
    } catch {
      return false;
    }
  }
  async revokeCredential(actor: CredentialActor, credentialId: string): Promise<boolean> {
    const actorSnapshot = PrincipalContextSchema.parse(actor);
    const credentialSnapshot = String(credentialId);
    return this.serial(async () => {
      const parsedActor = actorSnapshot;
      const credential = this.document.credentials[credentialSnapshot];
      if (!credential || credential.revokedAt) return false;
      if (parsedActor.organizationId !== credential.organizationId) return false;
      const principal = await this.options.principalSource.resolvePrincipal(
        credential.principalId,
        credential.organizationId,
      );
      if (
        !principal ||
        principal.principalId !== credential.principalId ||
        principal.organizationId !== credential.organizationId
      )
        return false;
      const timestamp = this.captureClock();
      await this.options.audit.append(
        {
          organizationId: credential.organizationId,
          actorPrincipalId: parsedActor.principalId,
          actorCredentialId: parsedActor.credentialId,
          action: "identity.credential.revoke",
          outcome: "allowed",
          resource: { kind: "credential", id: credentialId },
        },
        { durability: "required" },
      );
      const previous = this.snapshot();
      credential.revokedAt = timestamp;
      try {
        this.persist(previous);
      } catch (error) {
        this.document = previous;
        return this.auditFailure(
          {
            organizationId: credential.organizationId,
            actorPrincipalId: parsedActor.principalId,
            actorCredentialId: parsedActor.credentialId,
            action: "identity.credential.revoke",
            resource: { kind: "credential", id: credentialId },
          },
          error,
        );
      }
      await this.publishInvalidation({
        kind: "credential.revoke",
        credentialIds: [credentialId],
        principalId: credential.principalId,
        organizationId: credential.organizationId,
      });
      return true;
    });
  }

  async logoutAll(
    actor: CredentialActor,
    principalId: string,
    organizationId: OrganizationId,
  ): Promise<number> {
    const actorSnapshot = PrincipalContextSchema.parse(actor);
    const principalSnapshot = String(principalId);
    const orgSnapshot = organizationId;
    return this.serial(async () => {
      const parsedActor = actorSnapshot;
      principalId = principalSnapshot;
      organizationId = orgSnapshot;
      if (parsedActor.organizationId !== organizationId) return 0;
      const principal = await this.options.principalSource.resolvePrincipal(
        principalId,
        organizationId,
      );
      if (
        !principal ||
        principal.principalId !== principalId ||
        principal.organizationId !== organizationId
      )
        return 0;
      const active = Object.values(this.document.credentials).filter(
        (credential) =>
          credential.principalId === principalId &&
          credential.organizationId === organizationId &&
          !credential.revokedAt,
      );
      if (active.length === 0) return 0;
      const timestamp = this.captureClock();
      await this.options.audit.append(
        {
          organizationId,
          actorPrincipalId: parsedActor.principalId,
          actorCredentialId: parsedActor.credentialId,
          action: "identity.logout_all",
          outcome: "allowed",
          resource: { kind: "principal", id: principalId },
        },
        { durability: "required" },
      );
      const previous = this.snapshot();
      for (const credential of active) credential.revokedAt = timestamp;
      try {
        this.persist(previous);
      } catch (error) {
        this.document = previous;
        return this.auditFailure(
          {
            organizationId,
            actorPrincipalId: parsedActor.principalId,
            actorCredentialId: parsedActor.credentialId,
            action: "identity.logout_all",
            resource: { kind: "principal", id: principalId },
          },
          error,
        );
      }
      await this.publishInvalidation({
        kind: "principal.logout_all",
        credentialIds: active.map((c) => c.credentialId),
        principalId,
        organizationId,
      });
      return active.length;
    });
  }

  async rotateCredential(
    actor: CredentialActor,
    credentialId: string,
    expiresAt?: string,
  ): Promise<IssuedPersonalAccessToken | null> {
    const actorSnapshot = PrincipalContextSchema.parse(actor);
    const credentialSnapshot = String(credentialId);
    const expirySnapshot = expiresAt;
    return this.serial(async () => {
      const parsedActor = actorSnapshot;
      credentialId = credentialSnapshot;
      expiresAt = expirySnapshot;
      const old = this.document.credentials[credentialId];
      if (!old || old.revokedAt) return null;
      if (parsedActor.organizationId !== old.organizationId) return null;
      const principal = await this.options.principalSource.resolvePrincipal(
        old.principalId,
        old.organizationId,
      );
      if (
        !principal ||
        principal.principalId !== old.principalId ||
        principal.organizationId !== old.organizationId
      )
        return null;
      const candidateCredentialId = this.ids.next();
      const canonicalPrincipal = PrincipalContextSchema.parse({
        ...principal,
        credentialId: candidateCredentialId,
      });
      const timestamp = this.captureClock();
      if (isExpired(old.expiresAt, timestamp)) throw new Error("Credential expired");
      if (
        expiresAt &&
        (!z.string().datetime({ offset: true }).safeParse(expiresAt).success ||
          isExpired(expiresAt, timestamp))
      )
        throw new Error("Credential already expired");
      const nextId = candidateCredentialId;
      if (this.document.credentials[nextId]) throw new Error("Credential ID collision");
      const secret = this.secrets.next();
      if (!CREDENTIAL_ID_PATTERN.test(nextId) || !isCanonicalSecret(secret))
        throw new Error("Invalid credential source");
      const next: CredentialRecord = {
        credentialId: nextId,
        principalId: old.principalId,
        organizationId: old.organizationId,
        secretHash: await this.hasher.hash(secret),
        createdAt: timestamp,
        ...(expiresAt ? { expiresAt } : {}),
      };
      const valid = CredentialSchema.safeParse(next);
      if (!valid.success) throw new Error("Invalid credential metadata");
      await this.options.audit.append(
        {
          organizationId: old.organizationId,
          actorPrincipalId: parsedActor.principalId,
          actorCredentialId: parsedActor.credentialId,
          action: "identity.credential.rotate",
          outcome: "allowed",
          resource: { kind: "credential", id: nextId },
        },
        { durability: "required" },
      );
      const previous = this.snapshot();
      old.revokedAt = timestamp;
      this.document.credentials[nextId] = valid.data;
      try {
        this.persist(previous);
      } catch (error) {
        this.document = previous;
        return this.auditFailure(
          {
            organizationId: old.organizationId,
            actorPrincipalId: parsedActor.principalId,
            actorCredentialId: parsedActor.credentialId,
            action: "identity.credential.rotate",
            resource: { kind: "credential", id: nextId },
          },
          error,
        );
      }
      const authenticatedPrincipal = canonicalPrincipal;
      await this.publishInvalidation({
        kind: "credential.rotate",
        credentialIds: [credentialId],
        principalId: old.principalId,
        organizationId: old.organizationId,
      });
      return {
        token: formatPersonalAccessToken(nextId, secret),
        credentialId: nextId,
        principal: authenticatedPrincipal,
      };
    });
  }
}
