import {
  NodeContextSchema,
  PrincipalContextSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceAuthorization,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  EnterpriseDownloadHttpConsumer,
  type EnterpriseDownloadHttpLifecycleAttempt,
  type EnterpriseDownloadReadCapability,
} from "../../file-download/enterprise-consumer.js";
import type { EnterpriseFileUploadStorePort } from "../../file-upload/index.js";
import type { EnterpriseSessionContext } from "../identity/session-context.js";
import {
  DownloadTokenPolicy,
  type DownloadTokenCleanupScope,
  type DownloadTokenPolicyOptions,
  type DownloadTokenResolveInput,
  type DownloadTokenResolvedTarget,
} from "./download-token-policy.js";
import type { EnterpriseUploadPolicy } from "./enterprise-upload-policy.js";
import { EnterpriseUploadStore } from "./enterprise-upload-store.js";
import {
  type SafeWorkspaceFsPort,
  type WorkspacePathStat,
  WorkspacePathPolicy,
  type WorkspaceReadHandle,
} from "./workspace-path-policy.js";

const EnterpriseSessionContextSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
  })
  .strict();

const PathRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1).refine(isSafeRelativePath),
    requestId: z.string().min(1),
  })
  .strict();

const WriteRequestSchema = PathRequestSchema.extend({ bytes: z.instanceof(Uint8Array) }).strict();
const ConditionalWriteRequestSchema = WriteRequestSchema.extend({
  expectedModifiedAt: z.string().min(1),
  expectedRevision: z.string().min(1).optional(),
}).strict();
const CreateRequestSchema = PathRequestSchema.extend({
  kind: z.enum(["file", "directory"]),
}).strict();
const MoveRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceRelativePath: z.string().min(1).refine(isSafeRelativePath),
    destinationRelativePath: z.string().min(1).refine(isSafeRelativePath),
    requestId: z.string().min(1),
  })
  .strict();

export interface EnterpriseWorkspacePathRequest {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly requestId: string;
}

export interface EnterpriseWorkspaceWriteRequest extends EnterpriseWorkspacePathRequest {
  readonly bytes: Uint8Array;
  readonly expectedModifiedAt: string;
  readonly expectedRevision?: string;
}

export interface EnterpriseWorkspaceCreateRequest extends EnterpriseWorkspacePathRequest {
  readonly kind: "file" | "directory";
}

export interface EnterpriseWorkspaceMoveRequest {
  readonly workspaceId: string;
  readonly sourceRelativePath: string;
  readonly destinationRelativePath: string;
  readonly requestId: string;
}

export interface EnterpriseWorkspaceEntry extends WorkspacePathStat {
  readonly relativePath: string;
  readonly name: string;
}

export interface EnterpriseWorkspaceReadCapability extends WorkspacePathStat {
  readonly workspaceId: string;
  readonly relativePath: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface EnterpriseDownloadIssueResult extends WorkspacePathStat {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface EnterpriseWorkspaceFilesRuntime {
  stat(input: EnterpriseWorkspacePathRequest): Promise<WorkspacePathStat>;
  list(input: EnterpriseWorkspacePathRequest): Promise<readonly EnterpriseWorkspaceEntry[]>;
  openRead(input: EnterpriseWorkspacePathRequest): Promise<EnterpriseWorkspaceReadCapability>;
  write(input: EnterpriseWorkspaceWriteRequest): Promise<void>;
  create(input: EnterpriseWorkspaceCreateRequest): Promise<void>;
  rename(input: EnterpriseWorkspaceMoveRequest): Promise<void>;
  copy(input: EnterpriseWorkspaceMoveRequest): Promise<void>;
  delete(input: EnterpriseWorkspacePathRequest): Promise<void>;
  watch(input: EnterpriseWorkspacePathRequest, onChange: () => void): Promise<AsyncDisposable>;
  issueDownloadToken(input: EnterpriseWorkspacePathRequest): Promise<EnterpriseDownloadIssueResult>;
  createUploadStore(): EnterpriseFileUploadStorePort;
  cleanup(reason: "session-closed" | "generation-replaced"): Promise<void>;
}

export interface EnterpriseWorkspaceFilesRuntimeLifecycle {
  isCurrent(context: EnterpriseSessionContext): boolean;
}

export interface EnterpriseWorkspaceFilesHostOptions {
  readonly authorization: Pick<ResourceAuthorization, "assertWorkspace">;
  readonly safeFs: SafeWorkspaceFsPort;
  readonly resolveCanonicalRoot: (workspace: AuthorizedWorkspace) => Promise<string>;
  readonly createUploadStagingRelativePath: (input: {
    readonly context: EnterpriseSessionContext;
    readonly workspaceId: string;
    readonly requestId: string;
  }) => string;
  readonly uploadPolicy: Pick<
    EnterpriseUploadPolicy,
    "issue" | "append" | "finalize" | "abort" | "cleanup"
  >;
  readonly downloadTokens: Pick<DownloadTokenPolicyOptions, "ttlMs" | "capacity"> &
    Partial<Pick<DownloadTokenPolicyOptions, "clock" | "randomSource">>;
}

/** W5 host for canonical enterprise file requests and the bootstrap HTTP consumer. */
export class EnterpriseWorkspaceFilesHost {
  private readonly downloadPolicy: DownloadTokenPolicy;
  private readonly assertWorkspace: ResourceAuthorization["assertWorkspace"];
  private readonly safeFs: SafeWorkspaceFsPort;
  private readonly resolveCanonicalRoot: EnterpriseWorkspaceFilesHostOptions["resolveCanonicalRoot"];
  private readonly enterpriseUploadPolicy: EnterpriseWorkspaceFilesHostOptions["uploadPolicy"];
  private readonly createUploadStagingRelativePath: EnterpriseWorkspaceFilesHostOptions["createUploadStagingRelativePath"];
  private readonly ready: boolean;
  private readonly runtimeLifecycles = new Set<EnterpriseWorkspaceFilesRuntimeRegistration>();

  public constructor(options: EnterpriseWorkspaceFilesHostOptions) {
    const sourceFs = options.safeFs;
    this.ready =
      sourceFs.releaseReady === true && sourceFs.supportsDirectoryRelativeOperations === true;
    this.safeFs = Object.freeze({
      releaseReady: this.ready,
      supportsDirectoryRelativeOperations: this.ready,
      openWorkspaceRoot: sourceFs.openWorkspaceRoot.bind(sourceFs),
      read: sourceFs.read.bind(sourceFs),
      stat: sourceFs.stat.bind(sourceFs),
      list: sourceFs.list.bind(sourceFs),
      listRoot: sourceFs.listRoot.bind(sourceFs),
      write: sourceFs.write.bind(sourceFs),
      create: sourceFs.create.bind(sourceFs),
      rename: sourceFs.rename.bind(sourceFs),
      copy: sourceFs.copy.bind(sourceFs),
      delete: sourceFs.delete.bind(sourceFs),
      watch: sourceFs.watch.bind(sourceFs),
    });
    this.assertWorkspace = options.authorization.assertWorkspace.bind(options.authorization);
    const rootResolver = options.resolveCanonicalRoot;
    this.resolveCanonicalRoot = (workspace) => rootResolver(workspace);
    const uploadPolicy = options.uploadPolicy;
    this.enterpriseUploadPolicy = Object.freeze({
      issue: uploadPolicy.issue.bind(uploadPolicy),
      append: uploadPolicy.append.bind(uploadPolicy),
      finalize: uploadPolicy.finalize.bind(uploadPolicy),
      abort: uploadPolicy.abort.bind(uploadPolicy),
      cleanup: uploadPolicy.cleanup.bind(uploadPolicy),
    });
    const createUploadStagingRelativePath = options.createUploadStagingRelativePath;
    this.createUploadStagingRelativePath = (input) => createUploadStagingRelativePath(input);
    this.downloadPolicy = new DownloadTokenPolicy({
      ...options.downloadTokens,
      resolver: { resolve: (input) => this.resolveDownload(input) },
    });
  }

  public createRuntime(
    context: EnterpriseSessionContext,
    lifecycle: EnterpriseWorkspaceFilesRuntimeLifecycle,
  ): EnterpriseWorkspaceFilesRuntime {
    const canonical = freezeContext(context);
    const isCurrent = lifecycle.isCurrent.bind(lifecycle);
    const registration = new EnterpriseWorkspaceFilesRuntimeRegistration(
      canonical,
      () => isCurrent(canonical) === true,
      () => this.runtimeLifecycles.delete(registration),
    );
    this.runtimeLifecycles.add(registration);
    return new BoundEnterpriseWorkspaceFilesRuntime(this, canonical, registration);
  }

  public createPathPolicy(
    context: EnterpriseSessionContext,
    isCurrent: () => boolean = () => true,
  ): WorkspacePathPolicy {
    const canonical = freezeContext(context);
    return new WorkspacePathPolicy({
      authorizeWorkspace: async ({ workspaceId, action }) =>
        this.authorizeWorkspace(canonical, action, workspaceId),
      resolveCanonicalRoot: this.resolveCanonicalRoot,
      fs: this.safeFs,
      isCurrent,
    });
  }

  public get releaseReady(): boolean {
    return this.ready;
  }

  public createHttpConsumer(): EnterpriseDownloadHttpConsumer {
    return new EnterpriseDownloadHttpConsumer({
      safeFs: this.safeFs,
      policy: this.downloadPolicy,
      createPathPolicy: (context) =>
        this.createPathPolicy(context, () => this.httpContextIsCurrent(context)),
      lifecycle: { begin: (context) => this.beginHttpDownload(context) },
    });
  }

  public issueDownload(input: DownloadTokenResolveInput) {
    return this.downloadPolicy.issue(input);
  }

  public burnDownload(token: string): boolean {
    return this.downloadPolicy.burn(token);
  }

  public cleanupDownloadsForSession(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    return this.cleanupDownloadScope({
      kind: "session",
      organizationId: canonical.principal.organizationId,
      node: canonical.node,
      principalType: canonical.principal.principalType,
      principalId: canonical.principal.principalId,
      credentialId: canonical.principal.credentialId,
      grantVersion: canonical.principal.grantVersion,
      sessionBindingGeneration: canonical.sessionBindingGeneration,
    });
  }

  public cleanupDownloadsForCredential(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    return this.cleanupDownloadScope({
      kind: "credential",
      organizationId: canonical.principal.organizationId,
      node: canonical.node,
      principalType: canonical.principal.principalType,
      principalId: canonical.principal.principalId,
      credentialId: canonical.principal.credentialId,
    });
  }

  public cleanupDownloadsForPrincipal(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    return this.cleanupDownloadScope({
      kind: "principal",
      organizationId: canonical.principal.organizationId,
      node: canonical.node,
      principalType: canonical.principal.principalType,
      principalId: canonical.principal.principalId,
    });
  }

  public cleanupDownloadsForGrant(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    return this.cleanupDownloadScope({
      kind: "grant",
      organizationId: canonical.principal.organizationId,
      node: canonical.node,
      principalType: canonical.principal.principalType,
      principalId: canonical.principal.principalId,
      grantVersion: canonical.principal.grantVersion,
    });
  }

  public async cleanupCredential(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    await rejectAggregate(
      [
        this.cleanupDownloadsForCredential(canonical),
        capturePromise(() =>
          this.enterpriseUploadPolicy.cleanup({
            reason: "credential-revoked",
            organizationId: canonical.principal.organizationId,
            node: canonical.node,
            principalId: canonical.principal.principalId,
            credentialId: canonical.principal.credentialId,
          }),
        ),
      ],
      "Enterprise credential file cleanup failed.",
    );
  }

  public async cleanupPrincipal(context: EnterpriseSessionContext): Promise<void> {
    const canonical = freezeContext(context);
    await rejectAggregate(
      [
        this.cleanupDownloadsForPrincipal(canonical),
        capturePromise(() =>
          this.enterpriseUploadPolicy.cleanup({
            reason: "principal-logout",
            organizationId: canonical.principal.organizationId,
            node: canonical.node,
            principalId: canonical.principal.principalId,
          }),
        ),
      ],
      "Enterprise principal file cleanup failed.",
    );
  }

  public uploadPolicy(): EnterpriseWorkspaceFilesHostOptions["uploadPolicy"] {
    return this.enterpriseUploadPolicy;
  }

  public createUploadStore(context: EnterpriseSessionContext): EnterpriseUploadStore {
    return new EnterpriseUploadStore({
      context,
      policy: this.enterpriseUploadPolicy,
      safeFs: this.safeFs,
      createStagingRelativePath: this.createUploadStagingRelativePath,
    });
  }

  private beginHttpDownload(
    context: EnterpriseSessionContext,
  ): EnterpriseDownloadHttpLifecycleAttempt | null {
    let canonical: EnterpriseSessionContext;
    try {
      canonical = freezeContext(context);
    } catch {
      return null;
    }
    const matches = this.currentRegistrations(canonical);
    if (matches.length !== 1) return null;
    return matches[0]?.beginHttpAttempt() ?? null;
  }

  private httpContextIsCurrent(context: EnterpriseSessionContext): boolean {
    try {
      return this.currentRegistrations(freezeContext(context)).length === 1;
    } catch {
      return false;
    }
  }

  private currentRegistrations(
    context: EnterpriseSessionContext,
  ): EnterpriseWorkspaceFilesRuntimeRegistration[] {
    return [...this.runtimeLifecycles].filter(
      (registration) =>
        registration.isCurrent() && contextIdentityMatches(registration.context, context),
    );
  }

  private cleanupDownloadScope(scope: DownloadTokenCleanupScope): Promise<void> {
    const tokenCleanup = capturePromise(() => this.downloadPolicy.cleanupScope(scope));
    const lifecycleCleanups = [...this.runtimeLifecycles]
      .filter((registration) => contextMatchesDownloadScope(registration.context, scope))
      .map((registration) => registration.cleanup());
    return rejectAggregate(
      [tokenCleanup, ...lifecycleCleanups],
      "Enterprise download lifecycle cleanup failed.",
    );
  }

  private async resolveDownload(
    input: DownloadTokenResolveInput,
  ): Promise<DownloadTokenResolvedTarget> {
    const context = freezeContext({
      principal: input.principal,
      node: input.node,
      sessionBindingGeneration: input.sessionBindingGeneration,
    });
    let workspace: AuthorizedWorkspace | null = null;
    const paths = new WorkspacePathPolicy({
      authorizeWorkspace: async ({ workspaceId, action }) => {
        workspace = await this.authorizeWorkspace(context, action, workspaceId);
        return workspace;
      },
      resolveCanonicalRoot: this.resolveCanonicalRoot,
      fs: this.safeFs,
    });
    const stat = await paths.stat(input.workspaceId, input.relativePath);
    if (workspace === null || stat.kind !== "file") throw new Error("Download access denied.");
    return {
      workspace,
      fileIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  }

  private async authorizeWorkspace(
    context: EnterpriseSessionContext,
    action: Parameters<ResourceAuthorization["assertWorkspace"]>[1],
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    const workspace = await this.assertWorkspace(context.principal, action, workspaceId);
    if (
      workspace.organizationId !== context.principal.organizationId ||
      workspace.nodeId !== context.node.nodeId ||
      workspace.workspaceId !== workspaceId
    ) {
      throw new Error("Workspace access denied.");
    }
    return workspace;
  }
}

class EnterpriseWorkspaceFilesRuntimeRegistration {
  private readonly attempts = new Set<RuntimeAttempt>();
  private readonly capabilities = new Set<ManagedHttpDownloadCapability>();
  private readonly cleanupFailures: unknown[] = [];
  private active = true;
  private cleanupPromise: Promise<void> | null = null;

  public constructor(
    public readonly context: EnterpriseSessionContext,
    private readonly externalCurrent: () => boolean,
    private readonly unregister: () => void,
  ) {}

  public isCurrent(): boolean {
    if (!this.active) return false;
    try {
      return this.externalCurrent() === true;
    } catch {
      return false;
    }
  }

  public beginHttpAttempt(): EnterpriseDownloadHttpLifecycleAttempt | null {
    const attempt = this.beginAttempt();
    if (attempt === null) return null;
    let published = false;
    return Object.freeze({
      isCurrent: () => this.attemptIsCurrent(attempt),
      publish: (capability: EnterpriseDownloadReadCapability) => {
        if (published || !this.attemptIsCurrent(attempt)) return null;
        published = true;
        return this.manageCapability(capability).capability;
      },
      recordCleanupFailure: (error: unknown) => {
        this.cleanupFailures.push(error);
      },
      finish: () => this.finishAttempt(attempt),
    });
  }

  public cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.active = false;
    const attempts = [...this.attempts];
    for (const attempt of attempts) attempt.active = false;
    const capabilities = [...this.capabilities];
    this.cleanupPromise = this.performCleanup(attempts, capabilities).finally(() => {
      this.unregister();
    });
    return this.cleanupPromise;
  }

  private async performCleanup(
    attempts: readonly RuntimeAttempt[],
    capabilities: readonly ManagedHttpDownloadCapability[],
  ): Promise<void> {
    await Promise.all(attempts.map((attempt) => attempt.settled));
    const closeResults = await settleAll(
      capabilities.map((capability) => capability.capability.close()),
    );
    const closeFailures = closeResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    const errors = [...this.cleanupFailures, ...closeFailures];
    if (errors.length > 0) {
      throw new AggregateError(errors, "Enterprise HTTP download cleanup failed.");
    }
  }

  private beginAttempt(): RuntimeAttempt | null {
    if (!this.isCurrent()) return null;
    let resolveSettled!: () => void;
    const attempt: RuntimeAttempt = {
      active: true,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled(),
    };
    this.attempts.add(attempt);
    return attempt;
  }

  private finishAttempt(attempt: RuntimeAttempt): void {
    if (!this.attempts.delete(attempt)) return;
    attempt.active = false;
    attempt.resolveSettled();
  }

  private attemptIsCurrent(attempt: RuntimeAttempt): boolean {
    return attempt.active && this.isCurrent();
  }

  private manageCapability(
    source: EnterpriseDownloadReadCapability,
  ): ManagedHttpDownloadCapability {
    let closePromise: Promise<void> | null = null;
    const readAttempts = new Set<RuntimeAttempt>();
    const managed: ManagedHttpDownloadCapability = {
      active: true,
      capability: undefined as unknown as EnterpriseDownloadReadCapability,
    };
    const capability = Object.freeze({
      workspaceId: source.workspaceId,
      relativePath: source.relativePath,
      fileName: source.fileName,
      mimeType: source.mimeType,
      size: source.size,
      modifiedAt: source.modifiedAt,
      read: async (offset: number, length: number) => {
        if (!managed.active) throw runtimeClosed();
        const attempt = this.beginAttempt();
        if (attempt === null) throw runtimeClosed();
        readAttempts.add(attempt);
        try {
          const bytes = await source.read(offset, length);
          if (!managed.active || !this.attemptIsCurrent(attempt)) throw runtimeClosed();
          return bytes;
        } finally {
          readAttempts.delete(attempt);
          this.finishAttempt(attempt);
        }
      },
      close: () => {
        if (!closePromise) {
          managed.active = false;
          const reads = [...readAttempts];
          for (const read of reads) read.active = false;
          closePromise = (async () => {
            await Promise.all(reads.map((read) => read.settled));
            await source.close();
            this.capabilities.delete(managed);
          })();
        }
        return closePromise;
      },
    });
    managed.capability = capability;
    this.capabilities.add(managed);
    return managed;
  }
}

class BoundEnterpriseWorkspaceFilesRuntime implements EnterpriseWorkspaceFilesRuntime {
  private readonly uploadStores = new Set<EnterpriseUploadStore>();
  private readonly attempts = new Set<RuntimeAttempt>();
  private readonly reads = new Set<ManagedRuntimeRead>();
  private readonly watches = new Set<ManagedRuntimeWatch>();
  private closed = false;
  private cleanupPromise: Promise<void> | null = null;

  public constructor(
    private readonly host: EnterpriseWorkspaceFilesHost,
    private readonly context: EnterpriseSessionContext,
    private readonly registration: EnterpriseWorkspaceFilesRuntimeRegistration,
  ) {}

  public async stat(input: EnterpriseWorkspacePathRequest): Promise<WorkspacePathStat> {
    const attempt = this.beginAttempt();
    try {
      const request = parsePathRequest(input);
      const result = await this.paths(attempt).stat(request.workspaceId, request.relativePath);
      this.assertAttemptCurrent(attempt);
      return result;
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async list(
    input: EnterpriseWorkspacePathRequest,
  ): Promise<readonly EnterpriseWorkspaceEntry[]> {
    const attempt = this.beginAttempt();
    try {
      const request = parsePathRequest(input);
      const paths = this.paths(attempt);
      const names =
        request.relativePath === "."
          ? await paths.listRoot(request.workspaceId)
          : await paths.list(request.workspaceId, request.relativePath);
      this.assertAttemptCurrent(attempt);
      const entries: EnterpriseWorkspaceEntry[] = [];
      for (const name of names) {
        const relativePath =
          request.relativePath === "." ? name : `${request.relativePath}/${name}`;
        const stat = await paths.stat(request.workspaceId, relativePath);
        this.assertAttemptCurrent(attempt);
        entries.push(Object.freeze({ ...stat, relativePath, name }));
      }
      return Object.freeze(entries);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async openRead(
    input: EnterpriseWorkspacePathRequest,
  ): Promise<EnterpriseWorkspaceReadCapability> {
    const attempt = this.beginAttempt();
    let handle: WorkspaceReadHandle | null = null;
    try {
      const request = parsePathRequest(input);
      handle = await this.paths(attempt).read(request.workspaceId, request.relativePath);
      this.assertAttemptCurrent(attempt);
      const stat = await handle.stat();
      this.assertAttemptCurrent(attempt);
      const capability = this.manageRead(request, stat, handle);
      handle = null;
      return capability;
    } catch (error) {
      await closePreserving(error, handle);
      throw error;
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async write(input: EnterpriseWorkspaceWriteRequest): Promise<void> {
    const attempt = this.beginAttempt();
    try {
      const request = ConditionalWriteRequestSchema.parse(input);
      await this.paths(attempt).write(
        request.workspaceId,
        request.relativePath,
        new Uint8Array(request.bytes),
        {
          modifiedAt: request.expectedModifiedAt,
          revision: request.expectedRevision,
        },
      );
      this.assertAttemptCurrent(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async create(input: EnterpriseWorkspaceCreateRequest): Promise<void> {
    const attempt = this.beginAttempt();
    try {
      const request = CreateRequestSchema.parse(input);
      await this.paths(attempt).create(request.workspaceId, request.relativePath, request.kind);
      this.assertAttemptCurrent(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async rename(input: EnterpriseWorkspaceMoveRequest): Promise<void> {
    const attempt = this.beginAttempt();
    try {
      const request = MoveRequestSchema.parse(input);
      await this.paths(attempt).rename(
        request.workspaceId,
        request.sourceRelativePath,
        request.destinationRelativePath,
      );
      this.assertAttemptCurrent(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async copy(input: EnterpriseWorkspaceMoveRequest): Promise<void> {
    const attempt = this.beginAttempt();
    try {
      const request = MoveRequestSchema.parse(input);
      await this.paths(attempt).copy(
        request.workspaceId,
        request.sourceRelativePath,
        request.destinationRelativePath,
      );
      this.assertAttemptCurrent(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async delete(input: EnterpriseWorkspacePathRequest): Promise<void> {
    const attempt = this.beginAttempt();
    try {
      const request = parsePathRequest(input);
      await this.paths(attempt).delete(request.workspaceId, request.relativePath);
      this.assertAttemptCurrent(attempt);
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async watch(
    input: EnterpriseWorkspacePathRequest,
    onChange: () => void,
  ): Promise<AsyncDisposable> {
    const attempt = this.beginAttempt();
    let published: ManagedRuntimeWatch | null = null;
    try {
      const request = parsePathRequest(input);
      let watch: ManagedRuntimeWatch | null = null;
      const subscription = await this.paths(attempt).watch(
        request.workspaceId,
        request.relativePath,
        () => {
          if (watch?.active === true && this.runtimeIsCurrent()) onChange();
        },
      );
      this.assertAttemptCurrent(attempt);
      watch = this.manageWatch(subscription);
      published = watch;
      return watch.capability;
    } catch (error) {
      if (published) await closePreserving(error, published.capability);
      throw error;
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public async issueDownloadToken(
    input: EnterpriseWorkspacePathRequest,
  ): Promise<EnterpriseDownloadIssueResult> {
    const attempt = this.beginAttempt();
    let token: string | null = null;
    try {
      const request = parsePathRequest(input);
      const stat = await this.paths(attempt).stat(request.workspaceId, request.relativePath);
      this.assertAttemptCurrent(attempt);
      if (stat.kind !== "file") throw new Error("Download access denied.");
      const issued = await this.host.issueDownload({
        principal: this.context.principal,
        node: this.context.node,
        sessionBindingGeneration: this.context.sessionBindingGeneration,
        workspaceId: request.workspaceId,
        relativePath: request.relativePath,
      });
      token = issued.token;
      this.assertAttemptCurrent(attempt);
      return Object.freeze({
        ...stat,
        workspaceId: request.workspaceId,
        relativePath: request.relativePath,
        token,
        expiresAt: issued.expiresAt,
      });
    } catch (error) {
      if (token !== null) this.host.burnDownload(token);
      throw error;
    } finally {
      this.finishAttempt(attempt);
    }
  }

  public createUploadStore(): EnterpriseFileUploadStorePort {
    this.assertRuntimeCurrent();
    const store = this.host.createUploadStore(this.context);
    this.uploadStores.add(store);
    return store;
  }

  public cleanup(reason: "session-closed" | "generation-replaced"): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const attempts = [...this.attempts];
    for (const attempt of attempts) attempt.active = false;
    const stores = [...this.uploadStores];
    this.uploadStores.clear();
    const reads = [...this.reads];
    const watches = [...this.watches];
    const downloadCleanup = this.host.cleanupDownloadsForSession(this.context);
    const uploadOperations =
      stores.length > 0
        ? stores.map((store) => capturePromise(() => store.cleanup(reason)))
        : [
            capturePromise(() =>
              this.host.uploadPolicy().cleanup({
                reason,
                organizationId: this.context.principal.organizationId,
                node: this.context.node,
                principalId: this.context.principal.principalId,
                credentialId: this.context.principal.credentialId,
                grantVersion: this.context.principal.grantVersion,
                sessionBindingGeneration: this.context.sessionBindingGeneration,
              }),
            ),
          ];
    this.cleanupPromise = this.performCleanup(attempts, reads, watches, [
      downloadCleanup,
      ...uploadOperations,
    ]);
    return this.cleanupPromise;
  }

  private async performCleanup(
    attempts: readonly RuntimeAttempt[],
    reads: readonly ManagedRuntimeRead[],
    watches: readonly ManagedRuntimeWatch[],
    uploadOperations: readonly PromiseLike<unknown>[],
  ): Promise<void> {
    const initial = await settleAll([
      ...watches.map((watch) => watch.capability[Symbol.asyncDispose]()),
      ...uploadOperations,
      ...attempts.map((attempt) => attempt.settled),
    ]);
    const readCleanup = await settleAll(reads.map((read) => read.capability.close()));
    rejectSettled([...initial, ...readCleanup], "Enterprise file runtime cleanup failed.");
  }

  private paths(attempt: RuntimeAttempt): WorkspacePathPolicy {
    return this.host.createPathPolicy(this.context, () => this.attemptIsCurrent(attempt));
  }

  private beginAttempt(): RuntimeAttempt {
    this.assertRuntimeCurrent();
    let resolveSettled!: () => void;
    const attempt: RuntimeAttempt = {
      active: true,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled(),
    };
    this.attempts.add(attempt);
    return attempt;
  }

  private finishAttempt(attempt: RuntimeAttempt): void {
    if (!this.attempts.delete(attempt)) return;
    attempt.active = false;
    attempt.resolveSettled();
  }

  private attemptIsCurrent(attempt: RuntimeAttempt): boolean {
    return attempt.active && this.runtimeIsCurrent();
  }

  private assertAttemptCurrent(attempt: RuntimeAttempt): void {
    if (!this.attemptIsCurrent(attempt)) throw runtimeClosed();
  }

  private assertRuntimeCurrent(): void {
    if (!this.runtimeIsCurrent()) throw runtimeClosed();
  }

  private runtimeIsCurrent(): boolean {
    if (this.closed) return false;
    return this.registration.isCurrent();
  }

  private manageRead(
    request: EnterpriseWorkspacePathRequest,
    stat: Awaited<ReturnType<WorkspaceReadHandle["stat"]>>,
    handle: WorkspaceReadHandle,
  ): EnterpriseWorkspaceReadCapability {
    let closePromise: Promise<void> | null = null;
    const managed: ManagedRuntimeRead = {
      active: true,
      capability: undefined as unknown as EnterpriseWorkspaceReadCapability,
    };
    const capability = Object.freeze({
      kind: "file" as const,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      read: async (offset: number, length: number) => {
        const attempt = this.beginAttempt();
        try {
          if (!managed.active) throw runtimeClosed();
          const bytes = await handle.read(offset, length);
          this.assertAttemptCurrent(attempt);
          if (!managed.active) throw runtimeClosed();
          return bytes;
        } finally {
          this.finishAttempt(attempt);
        }
      },
      close: () => {
        if (!closePromise) {
          managed.active = false;
          this.reads.delete(managed);
          closePromise = capturePromise(() => handle.close());
        }
        return closePromise;
      },
    });
    managed.capability = capability;
    this.reads.add(managed);
    return capability;
  }

  private manageWatch(subscription: AsyncDisposable): ManagedRuntimeWatch {
    let closePromise: Promise<void> | null = null;
    const managed: ManagedRuntimeWatch = {
      active: true,
      capability: undefined as unknown as AsyncDisposable,
    };
    const capability = Object.freeze({
      [Symbol.asyncDispose]: () => {
        if (!closePromise) {
          managed.active = false;
          this.watches.delete(managed);
          closePromise = capturePromise(() => subscription[Symbol.asyncDispose]());
        }
        return closePromise;
      },
    });
    managed.capability = capability;
    this.watches.add(managed);
    return managed;
  }
}

interface RuntimeAttempt {
  active: boolean;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

interface ManagedRuntimeRead {
  active: boolean;
  capability: EnterpriseWorkspaceReadCapability;
}

interface ManagedRuntimeWatch {
  active: boolean;
  capability: AsyncDisposable;
}

interface ManagedHttpDownloadCapability {
  active: boolean;
  capability: EnterpriseDownloadReadCapability;
}

function parsePathRequest(input: EnterpriseWorkspacePathRequest) {
  return PathRequestSchema.parse(input);
}

function freezeContext(input: EnterpriseSessionContext): EnterpriseSessionContext {
  const parsed = EnterpriseSessionContextSchema.parse(input);
  return Object.freeze({
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    sessionBindingGeneration: parsed.sessionBindingGeneration,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") {
    return Object.freeze({ ...input, grants });
  }
  if (input.principalType === "service") {
    return Object.freeze({ ...input, grants });
  }
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
    grants,
  });
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

function contextIdentityMatches(
  expected: EnterpriseSessionContext,
  actual: EnterpriseSessionContext,
): boolean {
  return (
    expected.principal.organizationId === actual.principal.organizationId &&
    expected.principal.principalType === actual.principal.principalType &&
    expected.principal.principalId === actual.principal.principalId &&
    expected.principal.credentialId === actual.principal.credentialId &&
    expected.principal.grantVersion === actual.principal.grantVersion &&
    nodeIdentityMatches(expected.node, actual.node) &&
    expected.sessionBindingGeneration === actual.sessionBindingGeneration
  );
}

function contextMatchesDownloadScope(
  context: EnterpriseSessionContext,
  scope: DownloadTokenCleanupScope,
): boolean {
  if (
    context.principal.organizationId !== scope.organizationId ||
    context.principal.principalType !== scope.principalType ||
    context.principal.principalId !== scope.principalId ||
    !nodeIdentityMatches(context.node, scope.node)
  ) {
    return false;
  }
  if (scope.kind === "principal") return true;
  if (scope.kind === "credential") {
    return context.principal.credentialId === scope.credentialId;
  }
  if (scope.kind === "grant") return context.principal.grantVersion === scope.grantVersion;
  return (
    context.principal.credentialId === scope.credentialId &&
    context.principal.grantVersion === scope.grantVersion &&
    context.sessionBindingGeneration === scope.sessionBindingGeneration
  );
}

function nodeIdentityMatches(expected: NodeContext, actual: NodeContext): boolean {
  return (
    expected.nodeId === actual.nodeId &&
    expected.paseoServerId === actual.paseoServerId &&
    expected.mode === actual.mode
  );
}

function isSafeRelativePath(value: string): boolean {
  if (value === ".") return true;
  if (value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"),
    );
}

function settleAll(
  promises: readonly PromiseLike<unknown>[],
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(promises);
}

async function rejectAggregate(
  promises: readonly PromiseLike<unknown>[],
  message: string,
): Promise<void> {
  const results = await settleAll(promises);
  rejectSettled(results, message);
}

function rejectSettled(results: readonly PromiseSettledResult<unknown>[], message: string): void {
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

function capturePromise<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function closePreserving(
  primary: unknown,
  resource: { close(): PromiseLike<void> } | { [Symbol.asyncDispose](): PromiseLike<void> } | null,
): Promise<void> {
  if (!resource) return;
  try {
    if ("close" in resource) await resource.close();
    else await resource[Symbol.asyncDispose]();
  } catch {
    // The operation error remains primary. Cleanup failures are exposed by runtime cleanup.
  }
  if (primary === undefined) return;
}

function runtimeClosed(): Error {
  return new Error("Enterprise file runtime is closed or no longer current.");
}
