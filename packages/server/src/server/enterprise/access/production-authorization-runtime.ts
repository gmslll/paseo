import { z } from "zod";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { isSessionAuthorization, type SessionAuthorization } from "../../authorization/index.js";
import type {
  EnterpriseAdmissionAuthorizationHandle,
  EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import {
  StrictOutboundAuthorityVerifier,
  AuthoritySessionBindingRecordSchema,
  type AuthorityReceiptClock,
  type AuthorityReceiptStatePort,
  type AuthoritySessionBindingRecord,
} from "./authority-receipt-verifier.js";
import {
  FileBinaryOutboundAuthorizer,
  type FileBinaryOutboundAuthorizerDependencies,
} from "./file-binary-outbound-authorizer.js";
import { subscribeAuthoritativeGrantInvalidation, type GrantStore } from "./grant-store.js";
import { InboundAuthorityRequestAuthorizer } from "./inbound-authority-request-authorizer.js";
import {
  getAuthoritativeAgent,
  getAuthoritativeWorkspace,
  isOwnerRegistry,
  type OwnerRegistry,
} from "./owner-registry.js";
import {
  type ActiveAuthorizedRequestCloseReason,
  OutboundAuthorityEmissionAuthorizer,
  type OutboundAuthorityEmissionStatePort,
} from "./outbound-authority-emission-authorizer.js";
import {
  resolveProductionAuthorizationAuthority,
  type ResolvedProductionAuthorizationAuthority,
} from "./production-authorization-authority.js";
import {
  ResourceAuthorizationService,
  type AppSlotRegistry,
  type BrowserProfileRegistry,
  type PrincipalGrantVersionGuard,
  type WorkspacePathRegistry,
} from "./resource-authorization.js";
import type { ActiveAuthorizedRequestHandle } from "./inbound-authority-request-authorizer.js";
import type { OutboundAuthorizationContext } from "@getpaseo/protocol/messages";

type AuthorityContext = Extract<OutboundAuthorizationContext, { kind: "authority" }>;

export type ProductionAuthorizationStatePort = AuthorityReceiptStatePort &
  OutboundAuthorityEmissionStatePort;

export interface ProductionAuthorizationRuntimeOptions {
  readonly admissionAuthorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly admissionAuthorizationHandle: EnterpriseAdmissionAuthorizationHandle;
  readonly grantStore: GrantStore;
  readonly audit: ProductionAuditCapability;
  readonly sessionAuthorization: SessionAuthorization;
  readonly sessionId: string;
  readonly owners: OwnerRegistry;
  readonly authorityState: ProductionAuthorizationStatePort;
  readonly authorityReceiptClock?: AuthorityReceiptClock;
  readonly browserProfiles?: BrowserProfileRegistry;
  readonly appSlots?: AppSlotRegistry;
  readonly workspacePaths?: WorkspacePathRegistry;
}

export interface BoundOutboundAuthorityEmissionAuthorizer {
  register(handle: ActiveAuthorizedRequestHandle): Promise<boolean>;
  authorizeEmission(
    handle: ActiveAuthorizedRequestHandle,
    event: SessionOutboundMessage,
  ): Promise<AuthorityContext | null>;
  close(
    handle: ActiveAuthorizedRequestHandle,
    reason: Exclude<ActiveAuthorizedRequestCloseReason, "authorization_failed">,
  ): Promise<boolean>;
}

const RUNTIME_OPTION_KEYS = new Set([
  "admissionAuthorizationIssuer",
  "admissionAuthorizationHandle",
  "grantStore",
  "audit",
  "sessionAuthorization",
  "sessionId",
  "owners",
  "authorityState",
  "authorityReceiptClock",
  "browserProfiles",
  "appSlots",
  "workspacePaths",
]);

const REQUIRED_RUNTIME_OPTION_KEYS = new Set([
  "admissionAuthorizationIssuer",
  "admissionAuthorizationHandle",
  "grantStore",
  "audit",
  "sessionAuthorization",
  "sessionId",
  "owners",
  "authorityState",
]);

interface RuntimeRecord {
  active: boolean;
  readonly guard: RuntimeGrantVersionGuard;
  readonly fileBinary: FileBinaryOutboundAuthorizer;
  readonly outbound: BoundOutboundAuthorityEmissionAuthorizerImpl;
  unsubscribe: (() => void) | null;
  teardownPromise: Promise<void> | null;
}

const runtimeRecords = new WeakMap<object, RuntimeRecord>();

export class ProductionAuthorizationRuntimeTeardownError extends AggregateError {
  declare readonly errors: AggregateError["errors"];

  constructor(failures: readonly unknown[]) {
    const stableFailures = Object.freeze([...failures]);
    super(stableFailures, "production authorization runtime teardown failed", {
      cause: stableFailures[0],
    });
    this.name = "ProductionAuthorizationRuntimeTeardownError";
    Object.defineProperty(this, "errors", {
      value: stableFailures,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.freeze(this);
  }
}

export class ProductionAuthorizationRuntime {
  readonly principal: ResolvedProductionAuthorizationAuthority["principal"];
  readonly node: ResolvedProductionAuthorizationAuthority["node"];
  readonly binding: AuthoritySessionBindingRecord;
  readonly grantVersionGuard: PrincipalGrantVersionGuard;
  readonly resourceAuthorization: ResourceAuthorizationService;
  readonly inboundAuthorityRequestAuthorizer: InboundAuthorityRequestAuthorizer;
  readonly outboundAuthorityEmissionAuthorizer: BoundOutboundAuthorityEmissionAuthorizer;
  readonly fileBinaryOutboundAuthorizer: FileBinaryOutboundAuthorizer;

  constructor(input: {
    authority: ResolvedProductionAuthorizationAuthority;
    binding: AuthoritySessionBindingRecord;
    guard: RuntimeGrantVersionGuard;
    resourceAuthorization: ResourceAuthorizationService;
    inbound: InboundAuthorityRequestAuthorizer;
    outbound: BoundOutboundAuthorityEmissionAuthorizerImpl;
    fileBinary: FileBinaryOutboundAuthorizer;
  }) {
    this.principal = input.authority.principal;
    this.node = input.authority.node;
    this.binding = input.binding;
    this.grantVersionGuard = input.guard;
    this.resourceAuthorization = input.resourceAuthorization;
    this.inboundAuthorityRequestAuthorizer = input.inbound;
    this.outboundAuthorityEmissionAuthorizer = input.outbound;
    this.fileBinaryOutboundAuthorizer = input.fileBinary;
    Object.freeze(this);
  }

  release(): Promise<void> {
    const record = runtimeRecords.get(this);
    if (!record) return Promise.resolve();
    return beginRuntimeTeardown(record, "session_release");
  }
}

class RuntimeGrantVersionGuard implements PrincipalGrantVersionGuard {
  #active = true;

  constructor(private readonly delegate: PrincipalGrantVersionGuard) {
    Object.freeze(this);
  }

  isCurrent(ctx: Parameters<PrincipalGrantVersionGuard["isCurrent"]>[0]): boolean {
    if (!this.#active) return false;
    try {
      return this.delegate.isCurrent(ctx) === true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#active = false;
  }
}

class BoundOutboundAuthorityEmissionAuthorizerImpl implements BoundOutboundAuthorityEmissionAuthorizer {
  private readonly activeHandles = new Set<ActiveAuthorizedRequestHandle>();
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private readonly pendingCleanupFailures: unknown[] = [];
  #closing = false;

  constructor(
    private readonly delegate: OutboundAuthorityEmissionAuthorizer,
    private readonly principal: ResolvedProductionAuthorizationAuthority["principal"],
    private readonly binding: AuthoritySessionBindingRecord,
    private readonly onCleanupFailure: () => Promise<void>,
  ) {
    Object.freeze(this);
  }

  register(handle: ActiveAuthorizedRequestHandle): Promise<boolean> {
    if (this.#closing) return Promise.resolve(false);
    return this.track(
      (async () => {
        const registered = await this.delegate.register({
          handle,
          principal: this.principal,
          binding: this.binding,
        });
        if (!registered) {
          if (this.#closing) await this.captureLateCleanup(handle);
          return false;
        }
        this.activeHandles.add(handle);
        if (!this.#closing) return true;
        await this.captureLateCleanup(handle);
        this.activeHandles.delete(handle);
        return false;
      })(),
    );
  }

  authorizeEmission(
    handle: ActiveAuthorizedRequestHandle,
    event: SessionOutboundMessage,
  ): Promise<AuthorityContext | null> {
    if (this.#closing) return Promise.resolve(null);
    return this.track(
      (async () => {
        const context = await this.delegate.authorizeEmission({
          handle,
          principal: this.principal,
          binding: this.binding,
          event,
        });
        if (!this.#closing) return context;
        await this.captureLateCleanup(handle);
        this.activeHandles.delete(handle);
        return null;
      })(),
    );
  }

  close(
    handle: ActiveAuthorizedRequestHandle,
    reason: Exclude<ActiveAuthorizedRequestCloseReason, "authorization_failed">,
  ): Promise<boolean> {
    if (this.#closing || !this.activeHandles.has(handle)) return Promise.resolve(false);
    const cleanup = this.delegate.closeForTeardown({
      handle,
      principal: this.principal,
      binding: this.binding,
      reason,
    });
    let operation!: Promise<boolean>;
    operation = cleanup.then(
      () => {
        this.activeHandles.delete(handle);
        return true;
      },
      (error: unknown) => {
        this.pendingOperations.delete(operation);
        this.activeHandles.delete(handle);
        this.pendingCleanupFailures.push(error);
        void this.onCleanupFailure().catch(() => undefined);
        return false;
      },
    );
    return this.track(operation);
  }

  async releaseAll(): Promise<readonly unknown[]> {
    this.seal();
    const failures: unknown[] = [];
    while (this.pendingOperations.size > 0) {
      const pending = [...this.pendingOperations];
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") appendFailure(failures, result.reason);
      }
    }
    for (const failure of this.pendingCleanupFailures.splice(0)) {
      appendFailure(failures, failure);
    }
    const handles = [...this.activeHandles];
    const results = await Promise.allSettled(
      handles.map(async (handle) => {
        await this.delegate.closeForTeardown({
          handle,
          principal: this.principal,
          binding: this.binding,
          reason: "release",
        });
      }),
    );
    this.activeHandles.clear();
    for (const result of results) {
      if (result.status === "rejected") appendFailure(failures, result.reason);
    }
    return Object.freeze(failures);
  }

  seal(): void {
    this.#closing = true;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pendingOperations.add(operation);
    void operation.then(
      () => this.pendingOperations.delete(operation),
      () => this.pendingOperations.delete(operation),
    );
    return operation;
  }

  private async captureLateCleanup(handle: ActiveAuthorizedRequestHandle): Promise<void> {
    try {
      await this.delegate.closeForTeardown({
        handle,
        principal: this.principal,
        binding: this.binding,
        reason: "release",
      });
    } catch (error) {
      this.pendingCleanupFailures.push(error);
    }
  }
}

function appendFailure(failures: unknown[], failure: unknown): void {
  if (failure instanceof AggregateError) {
    for (const nested of failure.errors) appendFailure(failures, nested);
    return;
  }
  failures.push(failure);
}

function beginRuntimeTeardown(
  record: RuntimeRecord,
  reason: "revoked" | "session_release",
): Promise<void> {
  if (record.teardownPromise) return record.teardownPromise;

  record.active = false;
  record.guard.close();
  record.outbound.seal();
  const immediateFailures: unknown[] = [];
  try {
    record.fileBinary.closeAll(reason);
  } catch (error) {
    immediateFailures.push(error);
  }
  const unsubscribe = record.unsubscribe;
  record.unsubscribe = null;

  let resolveTeardown!: () => void;
  let rejectTeardown!: (error: unknown) => void;
  const teardown = new Promise<void>((resolve, reject) => {
    resolveTeardown = resolve;
    rejectTeardown = reject;
  });
  record.teardownPromise = teardown;

  void (async () => {
    let unsubscribeFailure: unknown = null;
    try {
      unsubscribe?.();
    } catch (error) {
      unsubscribeFailure = error;
    }
    const outboundFailures = await record.outbound.releaseAll();
    const failures = [...immediateFailures, ...outboundFailures];
    if (unsubscribeFailure !== null) failures.push(unsubscribeFailure);
    if (failures.length > 0) throw new ProductionAuthorizationRuntimeTeardownError(failures);
  })().then(resolveTeardown, rejectTeardown);

  return teardown;
}

export async function createEnterpriseAuthorizationRuntime(
  input: unknown,
): Promise<ProductionAuthorizationRuntime | null> {
  let fileBinary: FileBinaryOutboundAuthorizer | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    const options = captureRuntimeOptions(input);
    if (
      !options ||
      !isSessionAuthorization(options.sessionAuthorization) ||
      !isOwnerRegistry(options.owners) ||
      !productionAuditCapabilityIssuer.current(options.audit)
    ) {
      return null;
    }
    const ports = captureRuntimePorts(options);
    if (!ports) return null;
    const authority = await resolveProductionAuthorizationAuthority({
      admissionAuthorizationIssuer: options.admissionAuthorizationIssuer,
      admissionAuthorizationHandle: options.admissionAuthorizationHandle,
      grantStore: options.grantStore,
      audit: options.audit,
    });
    if (!authority) return null;
    const binding = canonicalBinding(options.sessionId, authority);
    if (!binding) return null;
    const guard = new RuntimeGrantVersionGuard(authority.grantVersionGuard);
    const owners = Object.freeze({
      getWorkspace: (workspaceId: string) => getAuthoritativeWorkspace(options.owners, workspaceId),
      getAgent: (agentId: string) => getAuthoritativeAgent(options.owners, agentId),
    });
    const verifier = new StrictOutboundAuthorityVerifier(
      authority.node.nodeId,
      ports.state,
      ports.authorityReceiptClock,
    );
    const resourceAuthorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: ports.browserProfiles,
      appSlots: ports.appSlots,
      workspacePaths: ports.workspacePaths,
      authorityVerifier: verifier,
      nodeId: authority.node.nodeId,
      grantVersionGuard: guard,
    });
    const inbound = new InboundAuthorityRequestAuthorizer({
      sessionAuthorization: options.sessionAuthorization,
      principal: authority.principal,
      grantVersionGuard: guard,
    });
    const outboundDelegate = new OutboundAuthorityEmissionAuthorizer({
      inboundAuthorizer: inbound,
      sessionAuthorization: options.sessionAuthorization,
      nodeId: authority.node.nodeId,
      state: ports.state,
    });
    let runtimeRecord: RuntimeRecord | null = null;
    const outbound = new BoundOutboundAuthorityEmissionAuthorizerImpl(
      outboundDelegate,
      authority.principal,
      binding,
      () =>
        runtimeRecord
          ? beginRuntimeTeardown(runtimeRecord, "revoked")
          : Promise.reject(new Error("authorization runtime is not registered")),
    );
    const binaryDependencies: FileBinaryOutboundAuthorizerDependencies = {
      admissionAuthorizationIssuer: options.admissionAuthorizationIssuer,
      admissionAuthorizationHandle: options.admissionAuthorizationHandle,
      grantStore: options.grantStore,
      audit: options.audit,
      sessionAuthorization: options.sessionAuthorization,
      owners: options.owners,
    };
    fileBinary = await FileBinaryOutboundAuthorizer.create(binaryDependencies);
    if (!fileBinary || !guard.isCurrent(authority.principal)) return null;

    let runtime: ProductionAuthorizationRuntime;
    unsubscribe = subscribeAuthoritativeGrantInvalidation(options.grantStore, (change) => {
      if (
        change.organizationId === authority.principal.organizationId &&
        change.principalId === authority.principal.principalId
      ) {
        const record = runtimeRecords.get(runtime);
        if (record?.active) {
          return beginRuntimeTeardown(record, "revoked");
        }
      }
    });
    if (!guard.isCurrent(authority.principal)) {
      unsubscribe();
      unsubscribe = null;
      fileBinary.closeAll("revoked");
      return null;
    }
    runtime = new ProductionAuthorizationRuntime({
      authority,
      binding,
      guard,
      resourceAuthorization,
      inbound,
      outbound,
      fileBinary,
    });
    runtimeRecord = {
      active: true,
      guard,
      fileBinary,
      outbound,
      unsubscribe,
      teardownPromise: null,
    };
    runtimeRecords.set(runtime, runtimeRecord);
    return runtime;
  } catch {
    unsubscribe?.();
    fileBinary?.closeAll("revoked");
    return null;
  }
}

export function isCurrentProductionAuthorizationRuntime(
  value: unknown,
): value is ProductionAuthorizationRuntime {
  try {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    const record = runtimeRecords.get(value as object);
    return Boolean(
      record?.active && record.guard.isCurrent((value as ProductionAuthorizationRuntime).principal),
    );
  } catch {
    return false;
  }
}

function captureRuntimeOptions(
  input: unknown,
): Readonly<ProductionAuthorizationRuntimeOptions> | null {
  if (!hasOnlyDataProperties(input, RUNTIME_OPTION_KEYS, REQUIRED_RUNTIME_OPTION_KEYS)) return null;
  try {
    return Object.freeze({
      admissionAuthorizationIssuer: dataProperty(
        input,
        "admissionAuthorizationIssuer",
      ) as EnterpriseAdmissionAuthorizationIssuer,
      admissionAuthorizationHandle: dataProperty(
        input,
        "admissionAuthorizationHandle",
      ) as EnterpriseAdmissionAuthorizationHandle,
      grantStore: dataProperty(input, "grantStore") as GrantStore,
      audit: dataProperty(input, "audit") as ProductionAuditCapability,
      sessionAuthorization: dataProperty(input, "sessionAuthorization") as SessionAuthorization,
      sessionId: dataProperty(input, "sessionId") as string,
      owners: dataProperty(input, "owners") as OwnerRegistry,
      authorityState: dataProperty(input, "authorityState") as ProductionAuthorizationStatePort,
      authorityReceiptClock: dataProperty(input, "authorityReceiptClock") as
        | AuthorityReceiptClock
        | undefined,
      browserProfiles: dataProperty(input, "browserProfiles") as BrowserProfileRegistry | undefined,
      appSlots: dataProperty(input, "appSlots") as AppSlotRegistry | undefined,
      workspacePaths: dataProperty(input, "workspacePaths") as WorkspacePathRegistry | undefined,
    });
  } catch {
    return null;
  }
}

function captureAuthorityState(
  state: ProductionAuthorizationStatePort,
): Readonly<ProductionAuthorizationStatePort> | null {
  try {
    const consumeAuthorizedRequest = state.consumeAuthorizedRequest.bind(state);
    const resolveCurrentSessionBinding = state.resolveCurrentSessionBinding.bind(state);
    const register = state.register.bind(state);
    const resolveOpen = state.resolveOpen.bind(state);
    const mintFreshReceipt = state.mintFreshReceipt.bind(state);
    const burnFreshReceipts = state.burnFreshReceipts.bind(state);
    const close = state.close.bind(state);
    if (
      ![
        consumeAuthorizedRequest,
        resolveCurrentSessionBinding,
        register,
        resolveOpen,
        mintFreshReceipt,
        burnFreshReceipts,
        close,
      ].every((method) => typeof method === "function")
    ) {
      return null;
    }
    return Object.freeze({
      consumeAuthorizedRequest,
      resolveCurrentSessionBinding,
      register,
      resolveOpen,
      mintFreshReceipt,
      burnFreshReceipts,
      close,
    });
  } catch {
    return null;
  }
}

function captureRuntimePorts(options: Readonly<ProductionAuthorizationRuntimeOptions>): {
  readonly state: Readonly<ProductionAuthorizationStatePort>;
  readonly browserProfiles?: BrowserProfileRegistry;
  readonly appSlots?: AppSlotRegistry;
  readonly workspacePaths?: WorkspacePathRegistry;
  readonly authorityReceiptClock?: AuthorityReceiptClock;
} | null {
  const state = captureAuthorityState(options.authorityState);
  const browserProfiles = captureOptionalGetPort(options.browserProfiles);
  const appSlots = captureOptionalGetPort(options.appSlots);
  const workspacePaths = captureOptionalResolvePort(options.workspacePaths);
  const authorityReceiptClock = captureOptionalClock(options.authorityReceiptClock);
  if (
    !state ||
    browserProfiles === null ||
    appSlots === null ||
    workspacePaths === null ||
    authorityReceiptClock === null
  ) {
    return null;
  }
  return Object.freeze({
    state,
    browserProfiles,
    appSlots,
    workspacePaths,
    authorityReceiptClock,
  });
}

function captureOptionalGetPort<T extends { get(id: string): Promise<unknown> }>(
  port: T | undefined,
): T | undefined | null {
  if (!port) return undefined;
  try {
    const get = port.get.bind(port);
    return Object.freeze({ get }) as T;
  } catch {
    return null;
  }
}

function captureOptionalResolvePort(
  port: WorkspacePathRegistry | undefined,
): WorkspacePathRegistry | undefined | null {
  if (!port) return undefined;
  try {
    const resolve = port.resolve.bind(port);
    return Object.freeze({ resolve });
  } catch {
    return null;
  }
}

function captureOptionalClock(
  clock: AuthorityReceiptClock | undefined,
): AuthorityReceiptClock | undefined | null {
  if (!clock) return undefined;
  try {
    const now = clock.now.bind(clock);
    return Object.freeze({ now });
  } catch {
    return null;
  }
}

function canonicalBinding(
  sessionId: string,
  authority: ResolvedProductionAuthorizationAuthority,
): AuthoritySessionBindingRecord | null {
  try {
    return deepFreeze(
      AuthoritySessionBindingRecordSchema.parse({
        sessionId: z.string().min(1).parse(sessionId),
        sessionBindingKey: authority.sessionBindingKey,
        sessionBindingGeneration: authority.sessionBindingGeneration,
        organizationId: authority.principal.organizationId,
        principalId: authority.principal.principalId,
        principalType: authority.principal.principalType,
        credentialId: authority.principal.credentialId,
        grantVersion: authority.principal.grantVersion,
        nodeId: authority.node.nodeId,
        clientId: authority.clientId,
      }),
    );
  } catch {
    return null;
  }
}

function hasOnlyDataProperties(
  input: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
): input is object {
  try {
    if (typeof input !== "object" || input === null) return false;
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
    for (const key of required) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function dataProperty(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("runtime options must use enumerable data properties");
  }
  return descriptor.value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
