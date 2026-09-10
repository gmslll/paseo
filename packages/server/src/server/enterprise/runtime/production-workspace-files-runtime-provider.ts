import path from "node:path";
import { createHash } from "node:crypto";
import {
  EnterpriseResourceOwnerSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { EnterpriseDownloadReadCapability } from "../../file-download/enterprise-consumer.js";
import {
  isCurrentProductionAuthorizationRuntime,
  type ProductionAuthorizationRuntime,
} from "../access/production-authorization-runtime.js";
import type { EnterpriseSessionContext } from "../identity/session-context.js";
import { DarwinWorkspaceFileSystem } from "./darwin-workspace-fs.js";
import {
  ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX,
  EnterpriseUploadPolicy,
  type EnterpriseUploadSafeFsPort,
} from "./enterprise-upload-policy.js";
import type { SafeWorkspaceFsPort } from "./workspace-path-policy.js";
import {
  EnterpriseWorkspaceFilesHost,
  type EnterpriseDownloadIssueResult,
  type EnterpriseWorkspaceCreateRequest,
  type EnterpriseWorkspaceEntry,
  type EnterpriseWorkspaceFilesRuntime,
  type EnterpriseWorkspaceMoveRequest,
  type EnterpriseWorkspacePathRequest,
  type EnterpriseWorkspaceReadCapability,
  type EnterpriseWorkspaceWriteRequest,
} from "./workspace-files-runtime.js";
import { DOWNLOAD_TOKEN_CAPACITY_HARD_MAX } from "./download-token-policy.js";

const DEFAULT_TOKEN_TTL_MS = 60_000;
const DEFAULT_TOKEN_CAPACITY = 1_024;
const DEFAULT_UPLOAD_TTL_MS = 10 * 60_000;
const DEFAULT_UPLOAD_CAPACITY = 256;

const WorkspaceRootRecordSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  archivedAt: z.string().nullable(),
}).passthrough();

const HttpRequestEnvelopeSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export interface EnterpriseWorkspaceRootRecord {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly ownerPrincipalId: string;
  readonly createdByPrincipalId: string;
  readonly cwd: string;
  readonly archivedAt: string | null;
}

export interface EnterpriseWorkspaceRootRegistry {
  get(workspaceId: string): Promise<EnterpriseWorkspaceRootRecord | null>;
}

export interface ProductionEnterpriseWorkspaceFilesProviderOptions {
  readonly workspaceRoots: EnterpriseWorkspaceRootRegistry;
  readonly nativeAddonPath?: string;
  readonly pollIntervalMs?: number;
  readonly downloadTokenTtlMs?: number;
  readonly downloadTokenCapacity?: number;
  readonly uploadTtlMs?: number;
  readonly uploadCapacity?: number;
}

export interface EnterpriseAuthenticatedDownloadHttpRequest {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly token: string;
}

export interface EnterpriseAuthenticatedDownloadHttpConsumer {
  consume(input: unknown): Promise<EnterpriseDownloadReadCapability | null>;
}

export interface EnterpriseDownloadHttpRouteInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly query: unknown;
  readonly response: EnterpriseDownloadHttpResponsePort;
}

export interface EnterpriseDownloadHttpResponsePort {
  reject(status: 400 | 403): Promise<void>;
  begin(metadata: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly size: number;
  }): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  abort(): Promise<void>;
}

export interface EnterpriseDownloadHttpHandler {
  handle(input: EnterpriseDownloadHttpRouteInput): Promise<void>;
}

declare const productionWorkspaceFilesProviderBrand: unique symbol;

/** W5 production seam consumed by W1 WebSocket admission and the bootstrap HTTP route. */
export interface EnterpriseWorkspaceFilesProductionProvider {
  readonly [productionWorkspaceFilesProviderBrand]: never;
  readonly releaseReady: boolean;
  readonly httpHandler: EnterpriseDownloadHttpHandler;
  createSessionRuntime(
    authorizationRuntime: ProductionAuthorizationRuntime,
  ): EnterpriseWorkspaceFilesRuntime | null;
}

interface CapturedOptions {
  readonly getWorkspaceRoot: EnterpriseWorkspaceRootRegistry["get"];
  readonly nativeAddonPath?: string;
  readonly pollIntervalMs?: number;
  readonly downloadTokenTtlMs: number;
  readonly downloadTokenCapacity: number;
  readonly uploadTtlMs: number;
  readonly uploadCapacity: number;
}

interface SessionRegistration {
  readonly context: EnterpriseSessionContext;
  readonly authorizationRuntime: ProductionAuthorizationRuntime;
  readonly host: EnterpriseWorkspaceFilesHost;
  readonly consumer: ReturnType<EnterpriseWorkspaceFilesHost["createHttpConsumer"]>;
  readonly tokens: Set<string>;
  active: boolean;
}

interface DownloadRoute {
  readonly registration: SessionRegistration;
  readonly token: string;
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly expiresAt: number;
}

const PROVIDER_OPTION_KEYS = new Set([
  "workspaceRoots",
  "nativeAddonPath",
  "pollIntervalMs",
  "downloadTokenTtlMs",
  "downloadTokenCapacity",
  "uploadTtlMs",
  "uploadCapacity",
]);
const REQUIRED_PROVIDER_OPTION_KEYS = new Set(["workspaceRoots"]);

export function createProductionEnterpriseWorkspaceFilesProvider(
  input: unknown,
): EnterpriseWorkspaceFilesProductionProvider | null {
  try {
    const options = captureOptions(input);
    if (!options) return null;
    const safeFs = new DarwinWorkspaceFileSystem({
      ...(options.nativeAddonPath === undefined ? {} : { addonPath: options.nativeAddonPath }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    return new ProductionWorkspaceFilesProvider(options, safeFs).publicPort;
  } catch {
    return null;
  }
}

class ProductionWorkspaceFilesProvider {
  public readonly publicPort: EnterpriseWorkspaceFilesProductionProvider;
  private readonly safeFs: SafeWorkspaceFsPort;
  private readonly getWorkspaceRoot: EnterpriseWorkspaceRootRegistry["get"];
  private readonly options: CapturedOptions;
  private readonly routes = new Map<string, DownloadRoute>();
  private readonly registrations = new Set<SessionRegistration>();

  public constructor(options: CapturedOptions, safeFs: SafeWorkspaceFsPort) {
    this.options = options;
    this.safeFs = safeFs;
    this.getWorkspaceRoot = options.getWorkspaceRoot;
    const httpConsumer = Object.freeze({
      consume: (input: unknown) => this.consumeDownload(input),
    });
    this.publicPort = Object.freeze({
      releaseReady:
        safeFs.releaseReady === true && safeFs.supportsDirectoryRelativeOperations === true,
      httpHandler: createDownloadHttpHandler(httpConsumer),
      createSessionRuntime: (runtime: ProductionAuthorizationRuntime) =>
        this.createSessionRuntime(runtime),
    }) as EnterpriseWorkspaceFilesProductionProvider;
  }

  private createSessionRuntime(
    authorizationRuntime: ProductionAuthorizationRuntime,
  ): EnterpriseWorkspaceFilesRuntime | null {
    if (!isCurrentProductionAuthorizationRuntime(authorizationRuntime)) return null;
    const context = contextFromAuthorizationRuntime(authorizationRuntime);
    if (!context) return null;
    const resourceAuthorization = authorizationRuntime.resourceAuthorization;
    const uploadPolicy = new EnterpriseUploadPolicy({
      ttlMs: this.options.uploadTtlMs,
      capacity: this.options.uploadCapacity,
      authorization: resourceAuthorization,
      safeFs: UNAVAILABLE_UPLOAD_SAFE_FS,
    });
    const host = new EnterpriseWorkspaceFilesHost({
      authorization: resourceAuthorization,
      safeFs: this.safeFs,
      resolveCanonicalRoot: (workspace) => this.resolveCanonicalRoot(workspace),
      createUploadStagingRelativePath: ({ requestId }) => stagingRelativePath(requestId),
      uploadPolicy,
      downloadTokens: {
        ttlMs: this.options.downloadTokenTtlMs,
        capacity: this.options.downloadTokenCapacity,
      },
    });
    const registration: SessionRegistration = {
      context,
      authorizationRuntime,
      host,
      consumer: host.createHttpConsumer(),
      tokens: new Set<string>(),
      active: true,
    };
    const runtime = host.createRuntime(context, {
      isCurrent: () =>
        registration.active &&
        isCurrentProductionAuthorizationRuntime(registration.authorizationRuntime),
    });
    this.registrations.add(registration);
    return new RoutedWorkspaceFilesRuntime(
      runtime,
      registration,
      (issued) => this.registerDownload(registration, issued),
      (reason) => this.cleanupSession(registration, runtime, reason),
    );
  }

  private registerDownload(
    registration: SessionRegistration,
    issued: EnterpriseDownloadIssueResult,
  ): void {
    this.pruneExpiredRoutes(Date.now());
    if (
      !registration.active ||
      !isCurrentProductionAuthorizationRuntime(registration.authorizationRuntime) ||
      this.routes.size >= this.options.downloadTokenCapacity ||
      this.routes.has(issued.token)
    ) {
      registration.host.burnDownload(issued.token);
      throw new Error("Enterprise download access denied.");
    }
    const route = Object.freeze({
      registration,
      token: issued.token,
      workspaceId: issued.workspaceId,
      relativePath: issued.relativePath,
      expiresAt: issued.expiresAt,
    });
    this.routes.set(issued.token, route);
    registration.tokens.add(issued.token);
  }

  private cleanupSession(
    registration: SessionRegistration,
    runtime: EnterpriseWorkspaceFilesRuntime,
    reason: "session-closed" | "generation-replaced",
  ): Promise<void> {
    if (!registration.active) return runtime.cleanup(reason);
    registration.active = false;
    this.burnRegistrationRoutes(registration);
    this.registrations.delete(registration);
    return runtime.cleanup(reason);
  }

  private async consumeDownload(input: unknown): Promise<EnterpriseDownloadReadCapability | null> {
    if (!this.publicPort.releaseReady) return null;
    const token = captureOwnDataString(input, "token");
    if (token === null) return null;
    const route = this.routes.get(token);
    if (!route) return null;
    this.routes.delete(token);
    route.registration.tokens.delete(token);
    const request = parseHttpRequest(input, token);
    if (
      !request ||
      !route.registration.active ||
      !isCurrentProductionAuthorizationRuntime(route.registration.authorizationRuntime) ||
      route.expiresAt <= Date.now() ||
      route.workspaceId !== request.workspaceId ||
      route.relativePath !== request.relativePath ||
      !principalMatches(route.registration.context.principal, request.principal) ||
      !nodeMatches(route.registration.context.node, request.node)
    ) {
      route.registration.host.burnDownload(token);
      return null;
    }
    return route.registration.consumer.consume({
      context: route.registration.context,
      workspaceId: request.workspaceId,
      relativePath: request.relativePath,
      token,
    });
  }

  private burnRegistrationRoutes(registration: SessionRegistration): void {
    for (const token of registration.tokens) {
      const route = this.routes.get(token);
      if (route?.registration === registration) this.routes.delete(token);
      registration.host.burnDownload(token);
    }
    registration.tokens.clear();
  }

  private pruneExpiredRoutes(now: number): void {
    for (const [token, route] of this.routes) {
      if (route.expiresAt > now) continue;
      this.routes.delete(token);
      route.registration.tokens.delete(token);
      route.registration.host.burnDownload(token);
    }
  }

  private async resolveCanonicalRoot(workspace: AuthorizedWorkspace): Promise<string> {
    const value = await this.getWorkspaceRoot(workspace.workspaceId);
    const record = snapshotWorkspaceRoot(value);
    if (
      !record ||
      record.archivedAt !== null ||
      !workspaceMatchesRoot(workspace, record) ||
      !isCanonicalAbsoluteRoot(record.cwd)
    ) {
      throw new Error("Workspace access denied.");
    }
    return record.cwd;
  }
}

class RoutedWorkspaceFilesRuntime implements EnterpriseWorkspaceFilesRuntime {
  private readonly statRuntime: EnterpriseWorkspaceFilesRuntime["stat"];
  private readonly listRuntime: EnterpriseWorkspaceFilesRuntime["list"];
  private readonly openReadRuntime: EnterpriseWorkspaceFilesRuntime["openRead"];
  private readonly writeRuntime: EnterpriseWorkspaceFilesRuntime["write"];
  private readonly createRuntime: EnterpriseWorkspaceFilesRuntime["create"];
  private readonly renameRuntime: EnterpriseWorkspaceFilesRuntime["rename"];
  private readonly copyRuntime: EnterpriseWorkspaceFilesRuntime["copy"];
  private readonly deleteRuntime: EnterpriseWorkspaceFilesRuntime["delete"];
  private readonly watchRuntime: EnterpriseWorkspaceFilesRuntime["watch"];
  private readonly issueRuntime: EnterpriseWorkspaceFilesRuntime["issueDownloadToken"];
  private readonly uploadRuntime: EnterpriseWorkspaceFilesRuntime["createUploadStore"];
  private cleanupPromise: Promise<void> | null = null;

  public constructor(
    runtime: EnterpriseWorkspaceFilesRuntime,
    private readonly registration: SessionRegistration,
    private readonly registerDownload: (issued: EnterpriseDownloadIssueResult) => void,
    private readonly cleanupRuntime: (
      reason: "session-closed" | "generation-replaced",
    ) => Promise<void>,
  ) {
    this.statRuntime = runtime.stat.bind(runtime);
    this.listRuntime = runtime.list.bind(runtime);
    this.openReadRuntime = runtime.openRead.bind(runtime);
    this.writeRuntime = runtime.write.bind(runtime);
    this.createRuntime = runtime.create.bind(runtime);
    this.renameRuntime = runtime.rename.bind(runtime);
    this.copyRuntime = runtime.copy.bind(runtime);
    this.deleteRuntime = runtime.delete.bind(runtime);
    this.watchRuntime = runtime.watch.bind(runtime);
    this.issueRuntime = runtime.issueDownloadToken.bind(runtime);
    this.uploadRuntime = runtime.createUploadStore.bind(runtime);
  }

  public stat(input: EnterpriseWorkspacePathRequest) {
    return this.statRuntime(input);
  }
  public list(input: EnterpriseWorkspacePathRequest): Promise<readonly EnterpriseWorkspaceEntry[]> {
    return this.listRuntime(input);
  }
  public openRead(
    input: EnterpriseWorkspacePathRequest,
  ): Promise<EnterpriseWorkspaceReadCapability> {
    return this.openReadRuntime(input);
  }
  public write(input: EnterpriseWorkspaceWriteRequest): Promise<void> {
    return this.writeRuntime(input);
  }
  public create(input: EnterpriseWorkspaceCreateRequest): Promise<void> {
    return this.createRuntime(input);
  }
  public rename(input: EnterpriseWorkspaceMoveRequest): Promise<void> {
    return this.renameRuntime(input);
  }
  public copy(input: EnterpriseWorkspaceMoveRequest): Promise<void> {
    return this.copyRuntime(input);
  }
  public delete(input: EnterpriseWorkspacePathRequest): Promise<void> {
    return this.deleteRuntime(input);
  }
  public watch(
    input: EnterpriseWorkspacePathRequest,
    onChange: () => void,
  ): Promise<AsyncDisposable> {
    return this.watchRuntime(input, onChange);
  }
  public async issueDownloadToken(
    input: EnterpriseWorkspacePathRequest,
  ): Promise<EnterpriseDownloadIssueResult> {
    const issued = await this.issueRuntime(input);
    if (!this.registration.active) {
      this.registration.host.burnDownload(issued.token);
      throw new Error("Enterprise download access denied.");
    }
    this.registerDownload(issued);
    return issued;
  }
  public createUploadStore() {
    return this.uploadRuntime();
  }
  public cleanup(reason: "session-closed" | "generation-replaced"): Promise<void> {
    this.cleanupPromise ??= this.cleanupRuntime(reason);
    return this.cleanupPromise;
  }
}

const UNAVAILABLE_UPLOAD_SAFE_FS: EnterpriseUploadSafeFsPort = Object.freeze({
  releaseReady: false,
  supportsDirectoryRelativeOperations: false,
  prepare: async () => Promise.reject(new Error("Enterprise upload safe-FS is unavailable.")),
  append: async () => Promise.reject(new Error("Enterprise upload safe-FS is unavailable.")),
  finalize: async () => Promise.reject(new Error("Enterprise upload safe-FS is unavailable.")),
  abort: async () => Promise.reject(new Error("Enterprise upload safe-FS is unavailable.")),
});

function captureOptions(input: unknown): CapturedOptions | null {
  const values = captureExactRecord(input, PROVIDER_OPTION_KEYS, REQUIRED_PROVIDER_OPTION_KEYS);
  if (!values) return null;
  const workspaceRoots = values.workspaceRoots;
  if (!isObject(workspaceRoots)) return null;
  const getDescriptor = Reflect.getOwnPropertyDescriptor(
    findPropertyOwner(workspaceRoots, "get"),
    "get",
  );
  if (!getDescriptor || !("value" in getDescriptor) || typeof getDescriptor.value !== "function") {
    return null;
  }
  const getWorkspaceRoot = getDescriptor.value.bind(
    workspaceRoots,
  ) as EnterpriseWorkspaceRootRegistry["get"];
  const nativeAddonPath = optionalString(values.nativeAddonPath);
  const pollIntervalMs = optionalPositiveInteger(values.pollIntervalMs, 60_000);
  const downloadTokenTtlMs = optionalPositiveInteger(
    values.downloadTokenTtlMs,
    60_000,
    DEFAULT_TOKEN_TTL_MS,
  );
  const downloadTokenCapacity = optionalPositiveInteger(
    values.downloadTokenCapacity,
    DOWNLOAD_TOKEN_CAPACITY_HARD_MAX,
    DEFAULT_TOKEN_CAPACITY,
  );
  const uploadTtlMs = optionalPositiveInteger(
    values.uploadTtlMs,
    Number.MAX_SAFE_INTEGER,
    DEFAULT_UPLOAD_TTL_MS,
  );
  const uploadCapacity = optionalPositiveInteger(
    values.uploadCapacity,
    ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX,
    DEFAULT_UPLOAD_CAPACITY,
  );
  if (
    nativeAddonPath === null ||
    pollIntervalMs === null ||
    downloadTokenTtlMs === null ||
    downloadTokenTtlMs === undefined ||
    downloadTokenCapacity === null ||
    downloadTokenCapacity === undefined ||
    uploadTtlMs === null ||
    uploadTtlMs === undefined ||
    uploadCapacity === null ||
    uploadCapacity === undefined
  ) {
    return null;
  }
  return Object.freeze({
    getWorkspaceRoot,
    nativeAddonPath,
    pollIntervalMs,
    downloadTokenTtlMs,
    downloadTokenCapacity,
    uploadTtlMs,
    uploadCapacity,
  });
}

function contextFromAuthorizationRuntime(
  runtime: ProductionAuthorizationRuntime,
): EnterpriseSessionContext | null {
  try {
    const principal = PrincipalContextSchema.parse(structuredClone(runtime.principal));
    const node = NodeContextSchema.parse(structuredClone(runtime.node));
    const binding = runtime.binding;
    if (
      binding.organizationId !== principal.organizationId ||
      binding.principalType !== principal.principalType ||
      binding.principalId !== principal.principalId ||
      binding.credentialId !== principal.credentialId ||
      binding.grantVersion !== principal.grantVersion ||
      binding.nodeId !== node.nodeId
    ) {
      return null;
    }
    return Object.freeze({
      principal: deepFreeze(principal),
      node: Object.freeze(node),
      sessionBindingGeneration: binding.sessionBindingGeneration,
    });
  } catch {
    return null;
  }
}

function parseHttpRequest(
  input: unknown,
  token: string,
): Readonly<EnterpriseAuthenticatedDownloadHttpRequest> | null {
  try {
    const snapshot = captureExactRecord(
      input,
      new Set(["principal", "node", "workspaceId", "relativePath", "token"]),
      new Set(["principal", "node", "workspaceId", "relativePath", "token"]),
    );
    if (!snapshot || snapshot.token !== token) return null;
    const parsed = HttpRequestEnvelopeSchema.parse(snapshot);
    return Object.freeze({
      principal: deepFreeze(parsed.principal),
      node: Object.freeze({ ...parsed.node }),
      workspaceId: parsed.workspaceId,
      relativePath: parsed.relativePath,
      token: parsed.token,
    });
  } catch {
    return null;
  }
}

function captureOwnDataString(input: unknown, key: string): string | null {
  try {
    if (!isObject(input)) return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function snapshotWorkspaceRoot(value: unknown): EnterpriseWorkspaceRootRecord | null {
  try {
    if (!isObject(value)) return null;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of [
      "workspaceId",
      "organizationId",
      "nodeId",
      "ownerPrincipalId",
      "createdByPrincipalId",
      "cwd",
      "archivedAt",
    ]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    const parsed = WorkspaceRootRecordSchema.parse(snapshot);
    return Object.freeze({ ...parsed });
  } catch {
    return null;
  }
}

function workspaceMatchesRoot(
  workspace: AuthorizedWorkspace,
  record: EnterpriseWorkspaceRootRecord,
): boolean {
  return (
    workspace.workspaceId === record.workspaceId &&
    workspace.organizationId === record.organizationId &&
    workspace.nodeId === record.nodeId &&
    workspace.ownerPrincipalId === record.ownerPrincipalId &&
    workspace.createdByPrincipalId === record.createdByPrincipalId
  );
}

function isCanonicalAbsoluteRoot(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    path.parse(value).root !== value &&
    !value.includes("\0")
  );
}

function stagingRelativePath(requestId: string): string {
  return `.paseo-uploads/${createHash("sha256").update(requestId).digest("hex")}`;
}

function principalMatches(expected: PrincipalContext, actual: PrincipalContext): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function nodeMatches(expected: NodeContext, actual: NodeContext): boolean {
  return (
    expected.nodeId === actual.nodeId &&
    expected.paseoServerId === actual.paseoServerId &&
    expected.mode === actual.mode
  );
}

function captureExactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
): Record<string, unknown> | null {
  try {
    if (!isObject(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      [...required].some((key) => !keys.includes(key))
    ) {
      return null;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function findPropertyOwner(value: object, key: PropertyKey): object {
  let owner: object | null = value;
  while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner) as object | null;
  return owner ?? value;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalPositiveInteger(
  value: unknown,
  max: number,
  fallback?: number,
): number | undefined | null {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
    ? (value as number)
    : null;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

function createDownloadHttpHandler(
  consumer: EnterpriseAuthenticatedDownloadHttpConsumer,
): EnterpriseDownloadHttpHandler {
  const consume = consumer.consume.bind(consumer);
  return Object.freeze({
    handle: (input: EnterpriseDownloadHttpRouteInput) => handleHttpDownload(input, consume),
  });
}

async function handleHttpDownload(
  input: EnterpriseDownloadHttpRouteInput,
  consume: EnterpriseAuthenticatedDownloadHttpConsumer["consume"],
): Promise<void> {
  const captured = captureRouteInput(input);
  if (!captured) throw new Error("Invalid enterprise download HTTP response port.");
  const capability = await consume(captured.request);
  if (!capability) {
    await captured.response.reject(captured.tokenPresent ? 403 : 400);
    return;
  }

  let started = false;
  let primary: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await captured.response.begin({
      fileName: capability.fileName,
      mimeType: capability.mimeType,
      size: capability.size,
    });
    started = true;
    let offset = 0;
    while (offset < capability.size) {
      const bytes = await capability.read(
        offset,
        Math.min(DOWNLOAD_CHUNK_BYTES, capability.size - offset),
      );
      if (bytes.byteLength === 0 || bytes.byteLength > capability.size - offset) {
        throw new Error("Enterprise download read returned an invalid byte range.");
      }
      await captured.response.write(new Uint8Array(bytes));
      offset += bytes.byteLength;
    }
    await captured.response.end();
  } catch (error) {
    primary = error;
    if (started) {
      try {
        await captured.response.abort();
      } catch (abortError) {
        cleanupFailures.push(abortError);
      }
    }
  }
  try {
    await capability.close();
  } catch (closeError) {
    cleanupFailures.push(closeError);
  }
  if (primary !== undefined || cleanupFailures.length > 0) {
    const errors = [...(primary === undefined ? [] : [primary]), ...cleanupFailures];
    throw new AggregateError(errors, "Enterprise download HTTP stream failed.", {
      cause: errors[0],
    });
  }
}

interface CapturedRouteInput {
  readonly request: unknown;
  readonly response: Readonly<EnterpriseDownloadHttpResponsePort>;
  readonly tokenPresent: boolean;
}

function captureRouteInput(input: EnterpriseDownloadHttpRouteInput): CapturedRouteInput | null {
  try {
    const response = captureResponsePort(ownData(input, "response"));
    if (!response) return null;
    const query = captureHttpQuery(ownData(input, "query"));
    return Object.freeze({
      request: Object.freeze({
        principal: ownData(input, "principal"),
        node: ownData(input, "node"),
        workspaceId: query.workspaceId,
        relativePath: query.relativePath,
        token: query.token,
        ...(query.invalid === true ? { invalid: true } : {}),
      }),
      response,
      tokenPresent: typeof query.token === "string" && query.token.length > 0,
    });
  } catch {
    return null;
  }
}

function captureHttpQuery(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return Object.freeze(Object.create(null));
  const result = Object.create(null) as Record<string, unknown>;
  let valid = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !["workspaceId", "relativePath", "token"].includes(key)) {
      valid = false;
      continue;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      valid = false;
      continue;
    }
    result[key] = descriptor.value;
  }
  if (valid === false) result.invalid = true;
  return Object.freeze(result);
}

function captureResponsePort(value: unknown): Readonly<EnterpriseDownloadHttpResponsePort> | null {
  if (!isObject(value)) return null;
  try {
    return Object.freeze({
      reject: bindMethod(value, "reject") as EnterpriseDownloadHttpResponsePort["reject"],
      begin: bindMethod(value, "begin") as EnterpriseDownloadHttpResponsePort["begin"],
      write: bindMethod(value, "write") as EnterpriseDownloadHttpResponsePort["write"],
      end: bindMethod(value, "end") as EnterpriseDownloadHttpResponsePort["end"],
      abort: bindMethod(value, "abort") as EnterpriseDownloadHttpResponsePort["abort"],
    });
  } catch {
    return null;
  }
}

function bindMethod(value: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(findPropertyOwner(value, key), key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new Error("Invalid enterprise download HTTP response port.");
  }
  return descriptor.value.bind(value);
}

function ownData(value: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Invalid enterprise download HTTP route input.");
  }
  return descriptor.value;
}
