import {
  CurrentIdentityProjectionSchema,
  type CurrentIdentityProjection,
} from "@getpaseo/protocol/messages";
import {
  createLifecycleGeneration,
  createPrincipalScopeKey,
  samePrincipalScope,
  type LifecycleGeneration,
  type PrincipalScopeKey,
} from "./daemon-client.js";
import type { EnterpriseFileRequest, EnterpriseFileRequestInput } from "./daemon-client.js";

export type { CurrentIdentityProjection };
declare const credentialHandleBrand: unique symbol;
export type CredentialHandle = string & { readonly [credentialHandleBrand]: "CredentialHandle" };

export interface CredentialVault {
  put(serverId: string, token: string): CredentialHandle;
  read(serverId: string, handle: CredentialHandle): string | null;
  delete(serverId: string, handle: CredentialHandle): void;
}
declare const processCredentialVaultBrand: unique symbol;
export type ProcessCredentialVault = CredentialVault & {
  readonly [processCredentialVaultBrand]: "ProcessCredentialVault";
};

/**
 * Production vault: secrets live only in this closure and are never exposed by
 * object enumeration or serialization. Restarting the process signs the host out.
 */
export function createProcessCredentialVault(): ProcessCredentialVault {
  const values = new Map<CredentialHandle, { readonly serverId: string; readonly token: string }>();
  const vault = Object.create(null) as CredentialVault;
  Object.defineProperties(vault, {
    put: {
      enumerable: false,
      value(serverId: string, token: string) {
        if (!serverId || !token) throw new Error("Invalid credential");
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (typeof globalThis.crypto?.randomUUID !== "function")
            throw new Error("Secure credential handle unavailable");
          const handle = globalThis.crypto.randomUUID() as CredentialHandle;
          if (values.has(handle)) continue;
          values.set(handle, Object.freeze({ serverId, token }));
          return handle;
        }
        throw new Error("Credential handle collision");
      },
    },
    read: {
      enumerable: false,
      value(serverId: string, handle: CredentialHandle) {
        const value = values.get(handle);
        return value && value.serverId === serverId ? value.token : null;
      },
    },
    delete: {
      enumerable: false,
      value(serverId: string, handle: CredentialHandle) {
        if (values.get(handle)?.serverId === serverId) values.delete(handle);
      },
    },
  });
  Object.freeze(vault);
  processCredentialVaults.add(vault);
  return vault as ProcessCredentialVault;
}
const processCredentialVaults = new WeakSet<object>();

export class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<CredentialHandle, { serverId: string; token: string }>();
  put(serverId: string, token: string): CredentialHandle {
    if (!serverId || !token) throw new Error("Invalid credential");
    for (let i = 0; i < 3; i++) {
      const handle = globalThis.crypto.randomUUID() as CredentialHandle;
      if (!this.values.has(handle)) {
        this.values.set(handle, { serverId, token });
        return handle;
      }
    }
    throw new Error("Credential handle collision");
  }
  read(serverId: string, handle: CredentialHandle): string | null {
    const value = this.values.get(handle);
    return value?.serverId === serverId ? value.token : null;
  }
  delete(serverId: string, handle: CredentialHandle): void {
    if (this.values.get(handle)?.serverId === serverId) this.values.delete(handle);
  }
}

export type EnterpriseIdentityLifecycleState =
  | "booting"
  | "signed_out"
  | "signed_in"
  | "unavailable";
export type EnterpriseIdentityTarget = "legacy_passthrough" | "enterprise_host";
export interface EnterpriseIdentitySnapshot {
  readonly state: EnterpriseIdentityLifecycleState;
  readonly target: EnterpriseIdentityTarget;
  readonly scope?: PrincipalScopeKey;
  readonly projection?: Readonly<CurrentIdentityProjection>;
  readonly generation?: LifecycleGeneration;
  readonly sessionBindingKey?: string;
}
export interface EnterpriseAuthenticationResult {
  readonly projection: CurrentIdentityProjection;
  readonly sessionBindingKey: string;
  readonly teardownAttempt: () => Promise<void>;
}
export interface EnterpriseLifecycleTeardown {
  stopNetworkAndSubscriptions(): Promise<void>;
  disposeRuntimeAndCachePartition(): Promise<void>;
  destroyDaemonClient(): Promise<void>;
  startNewClient(input: {
    serverId: string;
    scope: PrincipalScopeKey;
    generation: LifecycleGeneration;
    credentialHandle: CredentialHandle;
  }): Promise<void>;
  hydrateScope(scope: PrincipalScopeKey): Promise<void>;
}
export interface EnterpriseRemoteLogout {
  logoutAll(serverId: string): Promise<void>;
}
export interface EnterpriseIdentityLifecycle {
  bootstrap(input: {
    target: EnterpriseIdentityTarget;
    enterpriseIdentityV1: boolean;
  }): Promise<EnterpriseIdentitySnapshot>;
  readSnapshot(): EnterpriseIdentitySnapshot;
  subscribe(listener: (snapshot: EnterpriseIdentitySnapshot) => void): () => void;
  authenticateEnterpriseHost(input: {
    serverId: string;
    token: string;
    signal?: AbortSignal;
  }): Promise<EnterpriseIdentitySnapshot>;
  logoutCurrent(serverId: string): Promise<void>;
  logoutEnterpriseHost(serverId: string): Promise<void>;
  logoutAll(): Promise<void>;
  credentialRevoked(input: CorrelatedIdentityEvent): Promise<void>;
  principalChanged(input: CorrelatedIdentityEvent): Promise<void>;
  scopeRefreshed(
    input: CorrelatedIdentityEvent & { projection: CurrentIdentityProjection },
  ): Promise<void>;
  createEnterpriseFileRequest(input: {
    serverId: string;
    transport: EnterpriseFileRequestTransport;
  }): EnterpriseFileRequest;
}

/** Host-runtime transport; Authorization is assembled inside the lifecycle owner. */
export interface EnterpriseFileRequestTransport {
  request(input: {
    readonly serverId: string;
    readonly workspaceId: string;
    readonly relativePath: string;
    readonly scopeGeneration: string;
    readonly authorization: string;
    readonly signal: AbortSignal;
  }): Promise<Response>;
}
export interface CorrelatedIdentityEvent {
  readonly serverId: string;
  readonly generation: LifecycleGeneration;
  readonly sessionBindingKey: string;
}

export class MemoryEnterpriseIdentityLifecycle implements EnterpriseIdentityLifecycle {
  private snapshot: EnterpriseIdentitySnapshot = freezeSnapshot({
    state: "booting",
    target: "enterprise_host",
  });
  private readonly listeners = new Set<(snapshot: EnterpriseIdentitySnapshot) => void>();
  private queue: Promise<void> = Promise.resolve();
  private pending?: { controller: AbortController; attempt: number; serverId?: string };
  private attempt = 0;
  private handle?: CredentialHandle;
  private handleServerId?: string;
  private readonly activeFileRequestControllers = new Set<AbortController>();

  constructor(
    private readonly vault: CredentialVault,
    private readonly authenticate: (input: {
      serverId: string;
      token: string;
      signal: AbortSignal;
    }) => Promise<EnterpriseAuthenticationResult>,
    private readonly teardown: EnterpriseLifecycleTeardown,
    private readonly remoteLogout: EnterpriseRemoteLogout,
  ) {}

  readSnapshot(): EnterpriseIdentitySnapshot {
    return freezeSnapshot(this.snapshot);
  }
  createEnterpriseFileRequest(input: {
    serverId: string;
    transport: EnterpriseFileRequestTransport;
  }): EnterpriseFileRequest {
    const serverId = input.serverId;
    const transport = input.transport;
    if (!serverId || !transport || typeof transport.request !== "function")
      throw new Error("Invalid enterprise file request owner");
    // oxlint-disable-next-line complexity -- request scope, credential, and late-response fences.
    return async (request: EnterpriseFileRequestInput) => {
      if (
        request.serverId !== serverId ||
        !request.workspaceId ||
        !request.relativePath ||
        request.relativePath.includes("\0") ||
        request.relativePath.startsWith("/") ||
        !request.scopeGeneration
      )
        throw new Error("Invalid enterprise file request scope");
      const snapshot = this.readSnapshot();
      const handle = this.handle;
      const handleServerId = this.handleServerId;
      if (
        snapshot.state !== "signed_in" ||
        snapshot.scope?.paseoServerId !== serverId ||
        snapshot.generation !== request.scopeGeneration ||
        !handle ||
        handleServerId !== serverId
      )
        throw new Error("Enterprise file request scope is no longer current");
      const token = this.vault.read(serverId, handle);
      if (!token) throw new Error("Enterprise credential unavailable");
      const controller = new AbortController();
      this.activeFileRequestControllers.add(controller);
      const onAbort = () => controller.abort();
      if (request.signal?.aborted) controller.abort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await transport.request({
          serverId,
          workspaceId: request.workspaceId,
          relativePath: request.relativePath,
          scopeGeneration: request.scopeGeneration,
          authorization: `Bearer ${token}`,
          signal: controller.signal,
        });
        const current = this.readSnapshot();
        if (
          current.state !== "signed_in" ||
          current.scope?.paseoServerId !== serverId ||
          current.generation !== request.scopeGeneration ||
          this.handle !== handle ||
          this.handleServerId !== handleServerId
        )
          throw new Error("Enterprise file request scope is no longer current");
        return response;
      } finally {
        this.activeFileRequestControllers.delete(controller);
        request.signal?.removeEventListener("abort", onAbort);
      }
    };
  }
  subscribe(listener: (snapshot: EnterpriseIdentitySnapshot) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.readSnapshot());
    } catch {}
    return () => this.listeners.delete(listener);
  }
  async bootstrap(input: {
    target: EnterpriseIdentityTarget;
    enterpriseIdentityV1: boolean;
  }): Promise<EnterpriseIdentitySnapshot> {
    const target = input.target;
    const enterpriseIdentityV1 = input.enterpriseIdentityV1;
    if (target !== "legacy_passthrough" && target !== "enterprise_host")
      return Promise.reject(new Error("Invalid identity target"));
    this.abortPending();
    const attempt = ++this.attempt;
    return this.enqueue(async () => {
      if (attempt !== this.attempt) return this.readSnapshot();
      const changing =
        this.snapshot.state === "signed_in" &&
        (target !== this.snapshot.target ||
          (target === "enterprise_host" && !enterpriseIdentityV1));
      if (changing) {
        this.publish({ state: "unavailable", target });
        await this.localTeardown();
      }
      if (attempt !== this.attempt) return this.readSnapshot();
      if (target === "legacy_passthrough") this.publish({ state: "signed_out", target });
      else if (!enterpriseIdentityV1) this.publish({ state: "unavailable", target });
      else if (this.snapshot.state !== "signed_in") this.publish({ state: "signed_out", target });
      return this.readSnapshot();
    });
  }

  authenticateEnterpriseHost(input: {
    serverId: string;
    token: string;
    signal?: AbortSignal;
  }): Promise<EnterpriseIdentitySnapshot> {
    const serverId = input.serverId;
    const token = input.token;
    const signal = input.signal;
    if (!serverId || !token) return Promise.reject(new Error("Invalid authentication input"));
    this.abortPending();
    const attempt = ++this.attempt;
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    } else signal?.addEventListener("abort", forward, { once: true });
    this.pending = { controller, attempt, serverId };
    return this.enqueue(async () => {
      try {
        this.publish({ state: "unavailable", target: "enterprise_host" });
        const oldTeardown = await this.bestEffortTeardown();
        this.deleteHandle();
        if (oldTeardown.length) throw new AggregateError(oldTeardown, "teardown failed");
        if (!this.isCurrent(attempt, controller)) throw new DOMException("Aborted", "AbortError");
        let result: EnterpriseAuthenticationResult | undefined;
        let compensated = false;
        const compensate = async () => {
          if (result && !compensated) {
            compensated = true;
            await result.teardownAttempt();
          }
        };
        try {
          const remoteResult = await this.authenticate({
            serverId,
            token,
            signal: controller.signal,
          });
          result = await parseAuthenticationResult(remoteResult);
          if (!this.isCurrent(attempt, controller) || signal?.aborted) {
            await compensatePreserving(new DOMException("Aborted", "AbortError"), compensate);
          }
          const projection = result.projection;
          if (projection.paseoServerId !== serverId) {
            await compensatePreserving(new Error("Invalid authentication binding"), compensate);
          }
          const scope = createPrincipalScopeKey(projection);
          const generation = createLifecycleGeneration();
          const handle = this.vault.put(serverId, token);
          try {
            await this.teardown.startNewClient({
              serverId,
              scope,
              generation,
              credentialHandle: handle,
            });
            await this.teardown.hydrateScope(scope);
            if (!this.isCurrent(attempt, controller))
              throw new DOMException("Aborted", "AbortError");
          } catch (error) {
            const cleanup = await this.bestEffortTeardown();
            this.vault.delete(serverId, handle);
            const compensation = await compensate().then(
              () => undefined,
              (e) => e,
            );
            const aggregate = new AggregateError(
              [error, ...cleanup, ...(compensation ? [compensation] : [])],
              "authentication setup failed",
            );
            (aggregate as Error & { cause?: unknown }).cause = error;
            throw aggregate;
          }
          this.handle = handle;
          this.handleServerId = serverId;
          this.publish({
            state: "signed_in",
            target: "enterprise_host",
            scope,
            projection,
            generation,
            sessionBindingKey: result.sessionBindingKey,
          });
          return this.readSnapshot();
        } catch (error) {
          if (result && !compensated) await compensatePreserving(error, compensate);
          throw error;
        }
      } finally {
        signal?.removeEventListener("abort", forward);
        if (this.pending?.controller === controller) this.pending = undefined;
      }
    });
  }

  logoutCurrent(serverId: string): Promise<void> {
    if (this.pending?.serverId && this.pending.serverId !== serverId) return Promise.resolve();
    this.abortPending();
    const attempt = ++this.attempt;
    return this.enqueue(async () => {
      if (attempt !== this.attempt) return;
      if (this.snapshot.scope?.paseoServerId !== serverId) return;
      await this.localTeardown();
    });
  }
  logoutEnterpriseHost(serverId: string): Promise<void> {
    return this.logoutCurrent(serverId);
  }
  async logoutAll(): Promise<void> {
    this.abortPending();
    const attempt = ++this.attempt;
    return this.enqueue(async () => {
      if (attempt !== this.attempt) return;
      const serverId = this.snapshot.scope?.paseoServerId;
      if (!serverId) return;
      await this.remoteLogout.logoutAll(serverId);
      await this.localTeardown();
    });
  }
  credentialRevoked(input: CorrelatedIdentityEvent): Promise<void> {
    const correlation = snapshotCorrelation(input);
    if (!correlation || !this.matchesCurrent(correlation)) return Promise.resolve();
    this.abortPending();
    const attempt = ++this.attempt;
    return this.enqueue(async () => {
      if (attempt !== this.attempt) return;
      if (!this.matchesCurrent(correlation)) return;
      await this.localTeardown(true);
    });
  }
  principalChanged(input: CorrelatedIdentityEvent): Promise<void> {
    return this.credentialRevoked(input);
  }
  scopeRefreshed(
    input: CorrelatedIdentityEvent & { projection: CurrentIdentityProjection },
  ): Promise<void> {
    const correlation = snapshotCorrelation(input);
    if (!correlation || !this.matchesCurrent(correlation)) return Promise.resolve();
    const projectionInput = structuredClone(input.projection);
    const frozenInput = structuredClone(projectionInput);
    this.abortPending();
    const attempt = ++this.attempt;
    const controller = new AbortController();
    this.pending = { controller, attempt, serverId: correlation.serverId };
    return this.enqueue(async () => {
      try {
        if (!this.isCurrent(attempt, controller)) return;
        let incomingScope: PrincipalScopeKey;
        try {
          incomingScope = createPrincipalScopeKey(
            CurrentIdentityProjectionSchema.parse(frozenInput),
          );
        } catch {
          await this.localTeardown(true);
          return;
        }
        if (
          this.snapshot.state !== "signed_in" ||
          !this.snapshot.scope ||
          !samePrincipalScope(this.snapshot.scope, incomingScope)
        ) {
          await this.localTeardown(true);
          return;
        }
        const requestedProjection = CurrentIdentityProjectionSchema.parse(frozenInput);
        const requestedScope = createPrincipalScopeKey(requestedProjection);
        const scope = requestedScope;
        const generation = createLifecycleGeneration();
        const handle = this.handle;
        const serverId = this.handleServerId;
        if (!handle || !serverId) {
          await this.localTeardown(true);
          return;
        }
        let token: string | null;
        try {
          token = this.vault.read(serverId, handle);
        } catch {
          await this.localTeardown(true);
          return;
        }
        if (!token) {
          await this.localTeardown(true);
          return;
        }
        this.publish({ state: "unavailable", target: "enterprise_host" });
        const errors = await this.bestEffortTeardown();
        this.deleteHandle();
        if (errors.length) throw new AggregateError(errors, "teardown failed");
        if (!this.isCurrent(attempt, controller)) throw new DOMException("Aborted", "AbortError");
        this.deleteHandle();
        const refreshed = await parseAuthenticationResult(
          await this.authenticate({ serverId, token, signal: controller.signal }),
        );
        let compensated = false;
        const compensate = async () => {
          if (!compensated) {
            compensated = true;
            await refreshed.teardownAttempt();
          }
        };
        if (!this.isCurrent(attempt, controller)) {
          await compensate();
          throw new DOMException("Aborted", "AbortError");
        }
        let refreshedProjection!: CurrentIdentityProjection;
        let refreshedScope!: PrincipalScopeKey;
        let newHandle!: CredentialHandle;
        try {
          refreshedProjection = CurrentIdentityProjectionSchema.parse(refreshed.projection);
          refreshedScope = createPrincipalScopeKey(refreshedProjection);
          if (!samePrincipalScope(scope, refreshedScope) || !refreshed.sessionBindingKey)
            throw new Error("Invalid refreshed binding");
          newHandle = this.vault.put(serverId, token);
        } catch (error) {
          await compensatePreserving(error, compensate);
        }
        try {
          await this.teardown.startNewClient({
            serverId,
            scope: refreshedScope,
            generation,
            credentialHandle: newHandle,
          });
          await this.teardown.hydrateScope(refreshedScope);
          if (!this.isCurrent(attempt, controller)) throw new DOMException("Aborted", "AbortError");
        } catch (error) {
          await this.bestEffortTeardown();
          this.vault.delete(serverId, newHandle);
          await compensatePreserving(error, compensate);
          this.publish({ state: "unavailable", target: "enterprise_host" });
          throw error;
        }
        this.handle = newHandle;
        this.handleServerId = serverId;
        this.publish({
          state: "signed_in",
          target: "enterprise_host",
          scope: refreshedScope,
          projection: refreshedProjection,
          generation,
          sessionBindingKey: refreshed.sessionBindingKey,
        });
      } finally {
        if (this.pending?.controller === controller) this.pending = undefined;
      }
    });
  }
  private abortPending(): void {
    this.pending?.controller.abort();
  }
  private matchesCurrent(input: CorrelatedIdentityEvent): boolean {
    return (
      this.snapshot.state === "signed_in" &&
      this.snapshot.scope?.paseoServerId === input.serverId &&
      this.snapshot.generation === input.generation &&
      this.snapshot.sessionBindingKey === input.sessionBindingKey &&
      !!input.serverId &&
      !!input.generation &&
      !!input.sessionBindingKey
    );
  }
  private isCurrent(attempt: number, controller: AbortController): boolean {
    return (
      this.attempt === attempt &&
      this.pending?.controller === controller &&
      !controller.signal.aborted
    );
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private async localTeardown(force = false): Promise<void> {
    for (const controller of this.activeFileRequestControllers) controller.abort();
    this.publish({ state: "unavailable", target: "enterprise_host" });
    const errors = await this.bestEffortTeardown();
    this.deleteHandle();
    if (errors.length || force) {
      this.publish({ state: "unavailable", target: "enterprise_host" });
      if (errors.length) throw new AggregateError(errors, "teardown failed");
      return;
    }
    this.publish({ state: "signed_out", target: "enterprise_host" });
  }
  private deleteHandle(): void {
    if (this.handle && this.handleServerId) this.vault.delete(this.handleServerId, this.handle);
    this.handle = undefined;
    this.handleServerId = undefined;
  }
  private async bestEffortTeardown(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const step of [
      () => this.teardown.stopNetworkAndSubscriptions(),
      () => this.teardown.disposeRuntimeAndCachePartition(),
      () => this.teardown.destroyDaemonClient(),
    ])
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    return errors;
  }
  private publish(snapshot: EnterpriseIdentitySnapshot): void {
    this.snapshot = freezeSnapshot(snapshot);
    for (const listener of this.listeners)
      try {
        listener(this.readSnapshot());
      } catch {}
  }
}

function freezeSnapshot(snapshot: EnterpriseIdentitySnapshot): EnterpriseIdentitySnapshot {
  const projection = snapshot.projection
    ? (Object.freeze({
        ...snapshot.projection,
        navigation: Object.freeze([...snapshot.projection.navigation]),
        allowedOperations: Object.freeze([...snapshot.projection.allowedOperations]),
      }) as unknown as Readonly<CurrentIdentityProjection>)
    : undefined;
  return Object.freeze({
    ...snapshot,
    scope: snapshot.scope && Object.freeze({ ...snapshot.scope }),
    projection,
  }) as EnterpriseIdentitySnapshot;
}

function snapshotCorrelation(input: CorrelatedIdentityEvent): CorrelatedIdentityEvent | null {
  if (
    typeof input.serverId !== "string" ||
    !input.serverId ||
    typeof input.generation !== "string" ||
    !input.generation ||
    typeof input.sessionBindingKey !== "string" ||
    !input.sessionBindingKey
  )
    return null;
  return Object.freeze({
    serverId: input.serverId,
    generation: input.generation,
    sessionBindingKey: input.sessionBindingKey,
  });
}

async function parseAuthenticationResult(
  input: EnterpriseAuthenticationResult,
): Promise<EnterpriseAuthenticationResult> {
  let teardownAttempt: (() => Promise<void>) | undefined;
  try {
    const rawTeardownAttempt = input?.teardownAttempt;
    teardownAttempt = typeof rawTeardownAttempt === "function" ? rawTeardownAttempt : undefined;
    const binding = input?.sessionBindingKey;
    const projectionInput = input?.projection;
    if (!teardownAttempt || typeof binding !== "string" || !binding)
      throw new Error("Invalid authentication binding");
    const projection = CurrentIdentityProjectionSchema.parse(structuredClone(projectionInput));
    return Object.freeze({
      projection,
      sessionBindingKey: binding,
      teardownAttempt,
    });
  } catch (error) {
    if (teardownAttempt) {
      try {
        await teardownAttempt();
      } catch (cleanupError) {
        const aggregate = new AggregateError(
          [error, cleanupError],
          "authentication result compensation failed",
        );
        (aggregate as Error & { cause?: unknown }).cause = error;
        throw aggregate;
      }
    }
    throw error;
  }
}

async function compensatePreserving(
  primary: unknown,
  compensate: () => Promise<void>,
): Promise<never> {
  try {
    await compensate();
  } catch (cleanup) {
    const aggregate = new AggregateError([primary, cleanup], "compensation failed");
    (aggregate as Error & { cause?: unknown }).cause = primary;
    throw aggregate;
  }
  throw primary;
}
