import { describe, expect, test, vi } from "vitest";
import {
  BrowserProfileLeaseManager,
  type BrowserLeaseScheduler,
  type BrowserProfileLeaseAcquireInput,
  type BrowserProfileLeaseAuthorization,
  type BrowserProfileLeaseGenerationSnapshot,
  type BrowserProfileLeaseGenerationStorage,
  type BrowserProfileLeaseManagerOptions,
  type BrowserProfileLeaseWaitingNotice,
} from "./lease-manager.js";
import type {
  AuditAppendOptions,
  AuditEvent,
  AuditEventInput,
  AuditSink,
  FencedLease,
  LeaseCoordinator,
} from "@getpaseo/protocol/messages";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseAgentContextHandle,
  type EnterpriseAgentSessionContextRegistry,
} from "../../session/enterprise-agent-session-context-registry.js";

const PROFILE_ID = "brp_1111111111111111";
const SECOND_PROFILE_ID = "brp_2222222222222222";
const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_1111111111111111";
const PRINCIPAL_ID = "usr_1111111111111111";
const OWNER_ID = "usr_2222222222222222";
const WORKSPACE_ID = "workspace-1";
const sessionRegistry = createEnterpriseAgentSessionContextRegistry();
const sessionCache = new Map<string, EnterpriseAgentContextHandle>();

function sessionHandle(
  agentId: string,
  generation: string,
  current = true,
  identity: {
    principalId?: string;
    organizationId?: string;
    nodeId?: string;
    credentialId?: string;
    grantVersion?: string;
  } = {},
  registry: EnterpriseAgentSessionContextRegistry = sessionRegistry,
): EnterpriseAgentContextHandle {
  const cacheKey = JSON.stringify([
    agentId,
    generation,
    current,
    identity,
    registry === sessionRegistry,
  ]);
  if (current && sessionCache.has(cacheKey)) return sessionCache.get(cacheKey)!;
  const principal = {
    organizationId: identity.organizationId ?? ORGANIZATION_ID,
    principalType: "human" as const,
    principalId: identity.principalId ?? PRINCIPAL_ID,
    grants: [],
    credentialId: identity.credentialId ?? "credential-1",
    grantVersion: identity.grantVersion ?? "grant-version-1",
  };
  const handle = registry.bind({
    agentId,
    context: {
      principal,
      node: {
        nodeId: identity.nodeId ?? NODE_ID,
        paseoServerId: "server-1",
        mode: "managed",
      },
      sessionBindingGeneration: generation,
    },
  });
  if (!current) registry.release({ agentId, sessionBindingGeneration: generation });
  if (current && registry === sessionRegistry) sessionCache.set(cacheKey, handle);
  return handle;
}

type TestOverrides = Partial<BrowserProfileLeaseAcquireInput> & {
  holderAgentId?: string;
  sessionBindingGeneration?: string;
};

class MemoryGenerationStorage implements BrowserProfileLeaseGenerationStorage {
  public failWrites = false;
  public failNextWrite = false;
  public constructor(public value: unknown | null = null) {}

  public async read(): Promise<unknown | null> {
    return structuredClone(this.value);
  }

  public async write(snapshot: BrowserProfileLeaseGenerationSnapshot): Promise<void> {
    if (this.failWrites || this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("generation storage unavailable");
    }
    this.value = structuredClone(snapshot);
  }
}

class BlockingGenerationStorage extends MemoryGenerationStorage {
  public blockNextWrite = false;
  public writeStarted: Promise<void> | null = null;
  private releaseBlockedWrite: (() => void) | null = null;

  public override async write(snapshot: BrowserProfileLeaseGenerationSnapshot): Promise<void> {
    if (this.blockNextWrite) {
      this.blockNextWrite = false;
      this.writeStarted = new Promise<void>((resolve) => {
        this.releaseBlockedWrite = resolve;
      });
      await this.writeStarted;
    }
    await super.write(snapshot);
  }

  public releaseWrite(): void {
    this.releaseBlockedWrite?.();
    this.releaseBlockedWrite = null;
  }
}

class RecordingAuditSink implements AuditSink {
  public readonly events: AuditEventInput[] = [];
  public readonly attempts: Array<{ input: AuditEventInput; options: AuditAppendOptions }> = [];
  public fail = false;
  public failNext = false;
  public failReasonCode: string | null = null;
  public blockedReasonCode: string | null = null;
  public blocker: Promise<void> | null = null;
  public onAppend?: (input: AuditEventInput) => void;
  public async append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent> {
    this.attempts.push({ input: structuredClone(input), options: structuredClone(options) });
    this.onAppend?.(input);
    if (this.fail || this.failNext || input.reasonCode === this.failReasonCode) {
      this.failNext = false;
      throw new Error("audit unavailable");
    }
    if (input.reasonCode === this.blockedReasonCode && this.blocker) await this.blocker;
    this.events.push(structuredClone(input));
    return input as AuditEvent;
  }
}

class FakeClockScheduler implements BrowserLeaseScheduler {
  public nowMs = Date.parse("2026-09-09T10:00:00.000Z");
  private nextId = 0;
  private readonly tasks = new Map<number, { at: number; callback: () => void }>();

  public now(): number {
    return this.nowMs;
  }

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  public advance(ms: number): void {
    this.nowMs += ms;
    const due = Array.from(this.tasks.entries())
      .filter(([, task]) => task.at <= this.nowMs)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      task.callback();
    }
  }

  public fireNextTimer(): void {
    const next = Array.from(this.tasks.entries()).sort(
      (left, right) => left[1].at - right[1].at,
    )[0];
    if (!next) throw new Error("No timer is scheduled.");
    this.tasks.delete(next[0]);
    next[1].callback();
  }
}

function acquireInput(overrides: TestOverrides = {}): BrowserProfileLeaseAcquireInput {
  const holderAgentId = overrides.holderAgentId ?? "agent-1";
  const sessionBindingGeneration = overrides.sessionBindingGeneration ?? "session-generation-1";
  const {
    holderAgentId: _holderAgentId,
    sessionBindingGeneration: _generation,
    ...rest
  } = overrides;
  return {
    handle: overrides.handle ?? sessionHandle(holderAgentId, sessionBindingGeneration),
    resourceId: PROFILE_ID,
    mode: "read",
    ttlMs: 1_000,
    ...rest,
  };
}

function authorization(
  handle: EnterpriseAgentContextHandle,
  browserProfileId: string,
  overrides: Partial<BrowserProfileLeaseAuthorization> = {},
): BrowserProfileLeaseAuthorization {
  const organizationId = handle.context.principal.organizationId;
  const nodeId = handle.context.node.nodeId;
  return {
    workspace: {
      organizationId,
      nodeId,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
    },
    agent: {
      organizationId,
      nodeId,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: OWNER_ID,
      agentId: handle.agentId,
      workspaceId: WORKSPACE_ID,
    },
    profile: {
      browserProfileId,
      organizationId,
      homeNodeId: nodeId,
      businessIdentityId:
        browserProfileId === SECOND_PROFILE_ID ? "bid_2222222222222222" : "bid_1111111111111111",
      ownerPrincipalId: OWNER_ID,
      platform: "generic",
      businessAccountKey: `account-${browserProfileId}`,
      label: `Profile ${browserProfileId}`,
      partitionKey: `persist:paseo-enterprise-${browserProfileId}`,
      downloadRoot: `/profiles/${browserProfileId}/downloads`,
      status: "ready",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
    bindingRevision: "binding-revision-1",
    ...overrides,
  };
}

function createManager(
  options: {
    storage?: MemoryGenerationStorage;
    clock?: FakeClockScheduler;
    waiting?: BrowserProfileLeaseWaitingNotice[];
    ids?: string[];
    requestIds?: string[];
    createLeaseId?: () => string;
    createRequestId?: () => string;
    onWaiting?: (notice: BrowserProfileLeaseWaitingNotice) => void | Promise<void>;
    resolveAuthorization?: BrowserProfileLeaseManagerOptions["resolveAuthorization"];
    waitingErrorLimit?: number;
    initialLeaseRevision?: number;
    onError?: (error: Error) => void;
    registry?: EnterpriseAgentSessionContextRegistry;
    auditSink?: AuditSink;
    leaseCoordinator?: LeaseCoordinator;
  } = {},
): BrowserProfileLeaseManager {
  sessionCache.clear();
  const ids = options.ids ?? [
    "lea_11111111-1111-4111-8111-111111111111",
    "lea_22222222-2222-4222-8222-222222222222",
    "lea_33333333-3333-4333-8333-333333333333",
    "lea_44444444-4444-4444-8444-444444444444",
  ];
  const requestIds = options.requestIds ?? ["req-opaque-1", "req-opaque-2", "req-opaque-3"];
  return new BrowserProfileLeaseManager({
    auditSink: options.auditSink ?? new RecordingAuditSink(),
    maxLeaseTtlMs: 60_000,
    generationStorage: options.storage ?? new MemoryGenerationStorage(),
    clock: options.clock ?? new FakeClockScheduler(),
    createLeaseId:
      options.createLeaseId ?? (() => ids.shift() ?? "lea_55555555-5555-4555-8555-555555555555"),
    createRequestId: options.createRequestId ?? (() => requestIds.shift() ?? "req-opaque-fallback"),
    isCurrentHandle: (handle) => (options.registry ?? sessionRegistry).isCurrentHandle(handle),
    resolveAuthorization:
      options.resolveAuthorization ??
      ((handle, browserProfileId) => authorization(handle, browserProfileId)),
    onWaiting: options.onWaiting ?? ((notice) => options.waiting?.push(notice)),
    waitingErrorLimit: options.waitingErrorLimit,
    initialLeaseRevision: options.initialLeaseRevision,
    onError: options.onError,
    leaseCoordinator: options.leaseCoordinator,
  });
}

function holder(
  input: BrowserProfileLeaseAcquireInput = acquireInput(),
): EnterpriseAgentContextHandle {
  return input.handle;
}

function access(
  lease: FencedLease,
  input: BrowserProfileLeaseAcquireInput = acquireInput(),
): { handle: EnterpriseAgentContextHandle; lease: FencedLease } {
  return { handle: input.handle, lease };
}

async function expectStillWaiting(promise: Promise<unknown>): Promise<void> {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe("BrowserProfileLeaseManager", () => {
  test("acquire accepts only a canonical handle and lease intent", async () => {
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) =>
        authorization(handle, browserProfileId),
    );
    const manager = createManager({ resolveAuthorization });
    const handle = holder();
    const forbiddenAuthority = {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      principalContext: handle.context.principal,
      workspace: authorization(handle, PROFILE_ID).workspace,
      agent: authorization(handle, PROFILE_ID).agent,
      profile: authorization(handle, PROFILE_ID).profile,
      session: handle,
      resourceKind: "browser_profile",
      grantVersion: handle.context.principal.grantVersion,
      bindingRevision: "caller-revision",
      actorCredentialId: "caller-credential",
    };
    for (const [field, value] of Object.entries(forbiddenAuthority))
      await expect(
        manager.acquire({ ...acquireInput({ handle }), [field]: value } as never),
      ).rejects.toThrow(/Invalid Browser Profile lease acquisition/i);
    expect(resolveAuthorization).not.toHaveBeenCalled();
  });

  test("requires audit before publishing a lease", async () => {
    const audit = new RecordingAuditSink();
    audit.fail = true;
    const manager = createManager({ auditSink: audit });
    await expect(manager.acquire(acquireInput())).rejects.toThrow(/audit unavailable/i);
    expect(audit.events).toHaveLength(0);
    expect(audit.attempts.map((attempt) => attempt.options.durability)).toEqual([
      "required",
      "buffered",
    ]);
    audit.fail = false;
    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-after-failure" })),
    ).resolves.toMatchObject({
      holderAgentId: "agent-after-failure",
    });
  });

  test("rechecks the canonical handle after required acquire audit", async () => {
    const audit = new RecordingAuditSink();
    const gate = deferred<void>();
    const started = deferred<void>();
    audit.blockedReasonCode = "lease_acquired";
    audit.blocker = gate.promise;
    audit.onAppend = (event) => {
      if (event.reasonCode === "lease_acquired") started.resolve();
    };
    const manager = createManager({ auditSink: audit });
    const input = acquireInput({
      holderAgentId: "agent-audit-await",
      sessionBindingGeneration: "generation-audit-await",
      mode: "write",
    });
    const acquiring = manager.acquire(input);
    await started.promise;
    expect(audit.attempts[0]?.input.reasonCode).toBe("lease_acquired");
    sessionRegistry.release({
      agentId: input.handle.agentId,
      sessionBindingGeneration: input.handle.context.sessionBindingGeneration,
    });
    gate.resolve();
    await expect(acquiring).rejects.toThrow(/current/i);
    expect(audit.events.map(({ outcome, reasonCode }) => ({ outcome, reasonCode }))).toEqual([
      { outcome: "allowed", reasonCode: "lease_acquired" },
      { outcome: "failed", reasonCode: "lease_acquire_publication_failed" },
    ]);
    await manager.close();
  });

  test("records post-audit authorization failure without replacing its primary error", async () => {
    const audit = new RecordingAuditSink();
    audit.failReasonCode = "lease_acquire_publication_failed";
    let calls = 0;
    const manager = createManager({
      auditSink: audit,
      resolveAuthorization: (handle, browserProfileId) => {
        calls++;
        if (calls === 3) throw new Error("post-audit authorization changed");
        return authorization(handle, browserProfileId);
      },
    });

    await expect(manager.acquire(acquireInput({ mode: "write" }))).rejects.toThrow(
      "post-audit authorization changed",
    );
    expect(
      audit.attempts.map(({ input, options }) => [input.reasonCode, options.durability]),
    ).toEqual([
      ["lease_acquired", "required"],
      ["lease_acquire_publication_failed", "buffered"],
    ]);
    audit.failReasonCode = null;
    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-after-publication-failure" })),
    ).resolves.toMatchObject({ holderAgentId: "agent-after-publication-failure" });
  });

  test("records one allowed audit for a successful grant", async () => {
    const audit = new RecordingAuditSink();
    const manager = createManager({ auditSink: audit });
    await manager.acquire(acquireInput());
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      actorCredentialId: "credential-1",
      outcome: "allowed",
      reasonCode: "lease_acquired",
      resource: { kind: "browser_profile_lease" },
    });
    expect(audit.attempts[0]?.options).toEqual({ durability: "required" });
  });

  test("uses a global coordinator for acquire, validate, renew, release, and close", async () => {
    const clock = new FakeClockScheduler();
    let current: FencedLease | null = null;
    let fencingToken = 40;
    const acquire = vi.fn(async (input) => {
      const at = new Date(clock.nowMs).toISOString();
      current = {
        ...input,
        businessIdentityId: input.businessIdentityId!,
        leaseId: "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fencingToken: ++fencingToken,
        leaseRevision: "remote-1",
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: new Date(clock.nowMs + input.ttlMs).toISOString(),
      } as FencedLease;
      return current;
    });
    const validate = vi.fn(async () => current!);
    const renew = vi.fn(async (input) => {
      current = {
        ...current!,
        leaseRevision: "remote-2",
        heartbeatAt: new Date(clock.nowMs).toISOString(),
        expiresAt: new Date(clock.nowMs + input.ttlMs).toISOString(),
      };
      return current;
    });
    const release = vi.fn(async () => {
      current = null;
    });
    const manager = createManager({
      clock,
      leaseCoordinator: { acquire, validate, renew, release },
    });

    const lease = await manager.acquire(acquireInput({ mode: "write", ttlMs: 2_000 }));
    expect(lease).toMatchObject({ fencingToken: 41, leaseRevision: "remote-1" });
    expect(acquire).toHaveBeenCalledOnce();
    await expect(manager.validateLease(access(lease))).resolves.toEqual(lease);
    expect(validate).toHaveBeenCalledOnce();
    const renewed = await manager.renew({ ...access(lease), ttlMs: 3_000 });
    expect(renewed.leaseRevision).toBe("remote-2");
    expect(renew).toHaveBeenCalledOnce();
    await manager.releaseLease(access(renewed));
    expect(release).toHaveBeenCalledOnce();

    const closingLease = await manager.acquire(
      acquireInput({ mode: "write", holderAgentId: "agent-close-global" }),
    );
    expect(closingLease.fencingToken).toBe(42);
    await manager.close();
    expect(release).toHaveBeenCalledTimes(2);
  });

  test("releases a globally acquired lease when the coordinator returns mismatched authority", async () => {
    const clock = new FakeClockScheduler();
    const release = vi.fn(async () => undefined);
    const manager = createManager({
      clock,
      leaseCoordinator: {
        acquire: async (input) => ({
          ...input,
          businessIdentityId: input.businessIdentityId!,
          leaseId: "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          fencingToken: 1,
          leaseRevision: "remote-invalid",
          acquiredAt: new Date(clock.nowMs).toISOString(),
          heartbeatAt: new Date(clock.nowMs).toISOString(),
          expiresAt: new Date(clock.nowMs + input.ttlMs).toISOString(),
          resourceId: "brp_2222222222222222",
        }),
        validate: async () => {
          throw new Error("unexpected validation");
        },
        renew: async () => {
          throw new Error("unexpected renewal");
        },
        release,
      },
    });

    await expect(manager.acquire(acquireInput({ mode: "write" }))).rejects.toThrow(
      "does not match the lease",
    );
    expect(release).toHaveBeenCalledOnce();
    await manager.close();
  });

  test("release audit failure does not block FIFO drain", async () => {
    const audit = new RecordingAuditSink();
    const manager = createManager({ auditSink: audit });
    const active = await manager.acquire(acquireInput({ ttlMs: 10_000 }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-next", mode: "write" }));
    audit.failNext = true;
    await manager.releaseLease(access(active));
    await expect(waiting).resolves.toMatchObject({ holderAgentId: "agent-next" });
  });

  test("rejects removed authority fields and stale handles before authorization", async () => {
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) =>
        authorization(handle, browserProfileId),
    );
    const manager = createManager({ resolveAuthorization });
    const input = acquireInput();
    await expect(
      manager.acquire({
        ...input,
        principalContext: input.handle.context.principal,
      } as BrowserProfileLeaseAcquireInput & { principalContext: unknown }),
    ).rejects.toThrow(/Invalid Browser Profile lease acquisition/i);
    await expect(
      manager.acquire({
        ...input,
        handle: sessionHandle("agent-stale", "stale-generation", false),
      }),
    ).rejects.toThrow(/current/i);
    expect(resolveAuthorization).not.toHaveBeenCalled();
  });

  test("rejects structural, foreign, released, and replaced handles before authorization", async () => {
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) =>
        authorization(handle, browserProfileId),
    );
    const manager = createManager({ resolveAuthorization });
    const canonical = sessionHandle("agent-canonical", "generation-canonical");
    const structural = {
      agentId: canonical.agentId,
      context: canonical.context,
      isCurrent: () => true,
    } as EnterpriseAgentContextHandle;
    const throwingStructural = {
      get agentId() {
        throw new Error("structural getter must not run");
      },
    } as EnterpriseAgentContextHandle;
    const foreignRegistry = createEnterpriseAgentSessionContextRegistry();
    const foreign = sessionHandle("agent-foreign", "generation-foreign", true, {}, foreignRegistry);
    const released = sessionHandle("agent-released", "generation-released");
    sessionRegistry.release({
      agentId: released.agentId,
      sessionBindingGeneration: released.context.sessionBindingGeneration,
    });
    const replaced = sessionHandle("agent-replaced", "generation-old");
    sessionHandle("agent-replaced", "generation-new");

    for (const handle of [structural, throwingStructural, foreign, released, replaced])
      await expect(manager.acquire(acquireInput({ handle }))).rejects.toThrow(/current/i);
    expect(resolveAuthorization).not.toHaveBeenCalled();
  });

  test("derives every lease authority field from the handle and trusted resolver", async () => {
    const handle = sessionHandle("agent-derived", "generation-derived", true, {
      principalId: "usr_3333333333333333",
      credentialId: "credential-derived",
      grantVersion: "grant-derived",
    });
    const manager = createManager({
      resolveAuthorization: (candidate, browserProfileId) => {
        expect(candidate).toBe(handle);
        return authorization(candidate, browserProfileId, {
          bindingRevision: "binding-derived",
          profile: {
            ...authorization(candidate, browserProfileId).profile,
            businessIdentityId: "bid_3333333333333333",
          },
        });
      },
    });
    const lease = await manager.acquire(acquireInput({ handle, mode: "write" }));
    expect(lease).toMatchObject({
      organizationId: handle.context.principal.organizationId,
      nodeId: handle.context.node.nodeId,
      businessIdentityId: "bid_3333333333333333",
      resourceId: PROFILE_ID,
      holderPrincipalId: "usr_3333333333333333",
      holderAgentId: "agent-derived",
      mode: "write",
    });
  });

  test("fails closed when trusted authorization disagrees with the handle or resource", async () => {
    const mutations: Array<(value: BrowserProfileLeaseAuthorization) => void> = [
      (value) => {
        value.workspace.organizationId = "org_2222222222222222";
      },
      (value) => {
        value.workspace.nodeId = "nod_2222222222222222";
      },
      (value) => {
        value.agent.agentId = "agent-other";
      },
      (value) => {
        value.agent.workspaceId = "workspace-other";
      },
      (value) => {
        value.profile.browserProfileId = SECOND_PROFILE_ID;
      },
      (value) => {
        value.profile.homeNodeId = "nod_2222222222222222";
      },
    ];
    for (const mutate of mutations) {
      const manager = createManager({
        resolveAuthorization: (handle, browserProfileId) => {
          const resolved = structuredClone(authorization(handle, browserProfileId));
          mutate(resolved);
          return resolved;
        },
      });
      await expect(manager.acquire(acquireInput())).rejects.toThrow(/authorization|Workspace/i);
    }
    const handle = holder();
    const manager = createManager({
      resolveAuthorization: (candidate, browserProfileId) =>
        ({
          ...authorization(candidate, browserProfileId),
          grantVersion: handle.context.principal.grantVersion,
        }) as never,
    });
    await expect(manager.acquire(acquireInput({ handle }))).rejects.toThrow(/unrecognized/i);
  });

  test("uses the manager-injected Session registry verifier", async () => {
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) =>
        authorization(handle, browserProfileId),
    );
    const manager = new BrowserProfileLeaseManager({
      generationStorage: new MemoryGenerationStorage(),
      clock: new FakeClockScheduler(),
      createLeaseId: () => "lea_11111111-1111-4111-8111-111111111111",
      createRequestId: () => "request-1",
      auditSink: new RecordingAuditSink(),
      maxLeaseTtlMs: 60_000,
      isCurrentHandle: () => false,
      resolveAuthorization,
    });
    await expect(manager.acquire(acquireInput())).rejects.toThrow(/current/i);
    expect(resolveAuthorization).not.toHaveBeenCalled();
  });

  test("validates generated lease IDs and bounds invalid allocation attempts", async () => {
    let valid = false;
    const createLeaseId = vi.fn(() =>
      valid ? "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "invalid lease id",
    );
    const manager = createManager({ createLeaseId });

    await expect(manager.acquire(acquireInput({ mode: "write" }))).rejects.toThrow(
      /unique valid lease ID/i,
    );
    expect(createLeaseId).toHaveBeenCalledTimes(16);
    valid = true;
    await expect(manager.acquire(acquireInput({ mode: "write" }))).resolves.toMatchObject({
      leaseId: "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  });

  test("never overwrites a live lease when generated lease IDs collide", async () => {
    const firstId = "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "lea_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ids = [firstId, firstId, secondId];
    const manager = createManager({ createLeaseId: () => ids.shift() ?? secondId });
    const firstInput = acquireInput({ mode: "write" });
    const first = await manager.acquire(firstInput);
    const second = await manager.acquire(
      acquireInput({
        resourceId: SECOND_PROFILE_ID,
        holderAgentId: "agent-second-profile",
        sessionBindingGeneration: "generation-second-profile",
        mode: "write",
      }),
    );

    expect([first.leaseId, second.leaseId]).toEqual([firstId, secondId]);
    await expect(manager.validateLease(access(first, firstInput))).resolves.toEqual(first);
  });

  test("fails closed after bounded live lease ID collisions", async () => {
    const repeatedId = "lea_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const createLeaseId = vi.fn(() => repeatedId);
    const manager = createManager({ createLeaseId });
    const firstInput = acquireInput({ mode: "write" });
    const first = await manager.acquire(firstInput);

    await expect(
      manager.acquire(
        acquireInput({
          resourceId: SECOND_PROFILE_ID,
          holderAgentId: "agent-collision",
          sessionBindingGeneration: "generation-collision",
          mode: "write",
        }),
      ),
    ).rejects.toThrow(/unique valid lease ID/i);
    expect(createLeaseId).toHaveBeenCalledTimes(17);
    await expect(manager.validateLease(access(first, firstInput))).resolves.toEqual(first);
  });

  test("keeps request IDs unique across Profiles so cancel cannot target the wrong waiter", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const requestIds = ["request-shared", "request-shared", "request-second"];
    const manager = createManager({ waiting, requestIds });
    const firstActiveInput = acquireInput({ mode: "write", ttlMs: 10_000 });
    const secondActiveInput = acquireInput({
      resourceId: SECOND_PROFILE_ID,
      holderAgentId: "agent-active-second",
      sessionBindingGeneration: "generation-active-second",
      mode: "write",
      ttlMs: 10_000,
    });
    const firstActive = await manager.acquire(firstActiveInput);
    const secondActive = await manager.acquire(secondActiveInput);
    const waitingHandle = sessionHandle("agent-shared-waiter", "generation-shared-waiter");
    const firstWait = manager.acquire(
      acquireInput({ handle: waitingHandle, mode: "write", ttlMs: 10_000 }),
    );
    const secondWait = manager.acquire(
      acquireInput({
        handle: waitingHandle,
        resourceId: SECOND_PROFILE_ID,
        mode: "write",
        ttlMs: 10_000,
      }),
    );
    await flushMicrotasks();

    expect(waiting.map((notice) => notice.requestId)).toEqual(["request-shared", "request-second"]);
    expect(manager.cancel({ handle: waitingHandle, requestId: "request-shared" })).toBe(true);
    await expect(firstWait).rejects.toThrow(/canceled/i);
    await expectStillWaiting(secondWait);
    await manager.releaseLease(access(secondActive, secondActiveInput));
    await expect(secondWait).resolves.toMatchObject({ resourceId: SECOND_PROFILE_ID });
    await manager.releaseLease(access(firstActive, firstActiveInput));
  });

  test("validates request IDs and bounds queued collision attempts", async () => {
    let requestId = "invalid request id";
    const createRequestId = vi.fn(() => requestId);
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ createRequestId, waiting });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 10_000 }));

    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-invalid-request" })),
    ).rejects.toThrow(/unique valid lease request ID/i);
    expect(createRequestId).toHaveBeenCalledTimes(16);

    requestId = "request-live";
    const live = manager.acquire(acquireInput({ holderAgentId: "agent-live-request" }));
    await flushMicrotasks();
    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-colliding-request" })),
    ).rejects.toThrow(/unique valid lease request ID/i);
    expect(createRequestId).toHaveBeenCalledTimes(33);
    expect(waiting).toHaveLength(1);
    expect(
      manager.cancel({
        handle: holder(acquireInput({ holderAgentId: "agent-live-request" })),
        requestId: "request-live",
      }),
    ).toBe(true);
    await expect(live).rejects.toThrow(/canceled/i);
    await manager.releaseLease(access(active));
  });

  test("cancels a queued wait without disturbing later FIFO requests", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ waiting });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 10_000 }));
    const canceled = manager.acquire(acquireInput({ holderAgentId: "agent-cancel" }));
    const later = manager.acquire(acquireInput({ holderAgentId: "agent-later" }));
    await flushMicrotasks();
    expect(waiting).toHaveLength(2);
    expect(manager.cancel({ requestId: waiting[0]?.requestId ?? "", handle: holder() })).toBe(
      false,
    );
    expect(manager.cancel({ requestId: "missing-opaque-request", handle: holder() })).toBe(false);
    expect(
      manager.cancel({
        requestId: waiting[0]?.requestId ?? "",
        handle: holder(acquireInput({ holderAgentId: "agent-cancel" })),
      }),
    ).toBe(true);
    await expect(canceled).rejects.toThrow(/canceled/i);
    await manager.releaseLease(access(active, acquireInput({ holderAgentId: "agent-1" })));
    await expect(later).resolves.toMatchObject({ holderAgentId: "agent-later" });
  });

  test("canceling a ready queue head drains the next waiter", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ waiting });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 10_000 }));
    const first = manager.acquire(acquireInput({ holderAgentId: "agent-first", mode: "write" }));
    const second = manager.acquire(acquireInput({ holderAgentId: "agent-second", mode: "write" }));
    await flushMicrotasks();
    expect(
      manager.cancel({
        requestId: waiting[0]?.requestId ?? "",
        handle: holder(acquireInput({ holderAgentId: "agent-first" })),
      }),
    ).toBe(true);
    await expect(first).rejects.toThrow(/canceled/i);
    await manager.releaseLease(access(active));
    await expect(second).resolves.toMatchObject({ holderAgentId: "agent-second" });
  });

  test("every lease entry rejects non-holder and non-canonical handles before authorization", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) =>
        authorization(handle, browserProfileId),
    );
    const manager = createManager({ waiting, resolveAuthorization });
    const activeInput = acquireInput({ mode: "write", ttlMs: 10_000 });
    const lease = await manager.acquire(activeInput);
    const queuedInput = acquireInput({ holderAgentId: "agent-queued-security", mode: "write" });
    const queued = manager.acquire(queuedInput);
    await flushMicrotasks();
    const requestId = waiting[0]?.requestId ?? "";

    const canonical = activeInput.handle;
    const structural = {
      agentId: canonical.agentId,
      context: canonical.context,
      isCurrent: () => true,
    } as EnterpriseAgentContextHandle;
    const foreignRegistry = createEnterpriseAgentSessionContextRegistry();
    const foreign = sessionHandle(
      "agent-foreign-entry",
      "shared-generation",
      true,
      {},
      foreignRegistry,
    );
    const otherPrincipal = sessionHandle("agent-principal-b", "shared-generation", true, {
      principalId: "usr_4444444444444444",
    });
    const otherNode = sessionHandle("agent-node-b", "shared-generation", true, {
      nodeId: "nod_2222222222222222",
    });
    const otherAgent = sessionHandle("agent-b", "shared-generation");
    const released = sessionHandle("agent-entry-released", "shared-generation");
    sessionRegistry.release({
      agentId: released.agentId,
      sessionBindingGeneration: released.context.sessionBindingGeneration,
    });
    const replaced = sessionHandle("agent-entry-replaced", "shared-generation");
    sessionHandle("agent-entry-replaced", "replacement-generation");

    resolveAuthorization.mockClear();
    for (const handle of [
      structural,
      foreign,
      otherPrincipal,
      otherNode,
      otherAgent,
      released,
      replaced,
    ]) {
      await expect(manager.renew({ handle, lease, ttlMs: 500 })).rejects.toThrow(/current|holder/i);
      await expect(manager.validateLease({ handle, lease })).rejects.toThrow(/current|holder/i);
      await expect(
        manager.attachHost({ handle, lease, hostClientId: "host-security" }),
      ).rejects.toThrow(/current|holder/i);
      await expect(manager.releaseLease({ handle, lease })).rejects.toThrow(/current|holder/i);
      expect(manager.cancel({ handle, requestId })).toBe(false);
    }
    expect(resolveAuthorization).not.toHaveBeenCalled();

    const extraAuthority = { principalContext: otherPrincipal.context.principal };
    await expect(
      manager.renew({ handle: canonical, lease, ttlMs: 500, ...extraAuthority } as never),
    ).rejects.toThrow(/Invalid Browser Profile lease renewal/i);
    await expect(
      manager.validateLease({ handle: canonical, lease, ...extraAuthority } as never),
    ).rejects.toThrow(/Invalid Browser Profile lease validation/i);
    await expect(
      manager.attachHost({
        handle: canonical,
        lease,
        hostClientId: "host-security",
        ...extraAuthority,
      } as never),
    ).rejects.toThrow(/Invalid Browser Profile host attachment/i);
    await expect(
      manager.releaseLease({ handle: canonical, lease, ...extraAuthority } as never),
    ).rejects.toThrow(/Invalid Browser Profile lease release/i);
    expect(
      manager.cancel({ handle: queuedInput.handle, requestId, ...extraAuthority } as never),
    ).toBe(false);
    expect(resolveAuthorization).not.toHaveBeenCalled();

    expect(manager.cancel({ handle: queuedInput.handle, requestId })).toBe(true);
    await expect(queued).rejects.toThrow(/canceled/i);
    await manager.releaseLease({ handle: canonical, lease });
  });

  test("observes waiting notification failures without unhandled rejections", async () => {
    const manager = createManager({
      onWaiting: () => Promise.reject(new Error("notification failed")),
    });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-2" }));
    await manager.waitForIdle();
    await expect(waiting).rejects.toThrow(/status unavailable/i);
    expect(manager.getWaitingErrors()).toEqual([new Error("notification failed")]);
    await manager.releaseLease(access(active));
  });

  test("captures synchronous waiting notification throws, rejects the waiter, and bounds errors", async () => {
    const clock = new FakeClockScheduler();
    const manager = createManager({
      clock,
      waitingErrorLimit: 2,
      onError: () => {
        throw new Error("observer failed");
      },
      onWaiting: () => {
        throw new Error("sync notification failed");
      },
    });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const waits = [
      manager.acquire(acquireInput({ holderAgentId: "agent-2" })),
      manager.acquire(acquireInput({ holderAgentId: "agent-3" })),
      manager.acquire(acquireInput({ holderAgentId: "agent-4" })),
    ];
    await expect(Promise.all(waits)).rejects.toThrow(/status unavailable/i);
    await manager.waitForIdle();
    expect(manager.getWaitingErrors()).toHaveLength(2);
    await manager.releaseLease(access(active));
    clock.advance(30 * 60 * 1000);
    expect(manager.getWaitingErrors()).toHaveLength(0);
  });

  test.each([
    ["NaN", Number.NaN],
    ["fraction", 1.5],
    ["overflow", 1_025],
  ])("rejects a %s waiting error limit", (_label, waitingErrorLimit) => {
    expect(() => createManager({ waitingErrorLimit })).toThrow(
      /positive safe integer no greater than 1024/i,
    );
  });

  test("rechecks binding authorization when a queued request is granted", async () => {
    let bindingRevision = "binding-revision-1";
    const manager = createManager({
      resolveAuthorization: (handle, browserProfileId) =>
        authorization(handle, browserProfileId, { bindingRevision }),
    });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const queued = manager.acquire(acquireInput({ holderAgentId: "agent-queued", mode: "write" }));
    await flushMicrotasks();
    bindingRevision = "binding-revision-2";
    await manager.releaseLease(access(active));
    await expect(queued).rejects.toThrow(/authorization changed/i);
  });

  test("rechecks authorization before renew and attachHost", async () => {
    let bindingRevision = "binding-revision-1";
    const manager = createManager({
      resolveAuthorization: (handle, browserProfileId) =>
        authorization(handle, browserProfileId, { bindingRevision }),
    });
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    bindingRevision = "binding-revision-2";
    await expect(manager.renew({ lease, handle: holder(), ttlMs: 500 })).rejects.toThrow(
      /authorization/i,
    );
    await expect(
      manager.attachHost({ lease, hostClientId: "host-1", handle: holder() }),
    ).rejects.toThrow(/authorization/i);
    await expect(manager.releaseLease(access(lease))).resolves.toBeUndefined();
  });

  test("lets the original current holder release after authorization is revoked", async () => {
    let revokedHandle: EnterpriseAgentContextHandle | null = null;
    const resolveAuthorization = vi.fn(
      (handle: EnterpriseAgentContextHandle, browserProfileId: string) => {
        if (handle === revokedHandle) throw new Error("browser authorization revoked");
        return authorization(handle, browserProfileId);
      },
    );
    const manager = createManager({ resolveAuthorization });
    const activeInput = acquireInput({ mode: "write" });
    const lease = await manager.acquire(activeInput);
    revokedHandle = activeInput.handle;
    await expect(manager.validateLease(access(lease, activeInput))).rejects.toThrow(/revoked/i);
    resolveAuthorization.mockClear();
    await expect(manager.releaseLease(access(lease, activeInput))).resolves.toBeUndefined();
    expect(resolveAuthorization).not.toHaveBeenCalled();
    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-after-revocation", mode: "write" })),
    ).resolves.toMatchObject({ holderAgentId: "agent-after-revocation" });
  });

  test("rejects validate and renew when invalidated during authorization resolution", async () => {
    let block = false;
    let resolverGate = deferred<void>();
    const manager = createManager({
      resolveAuthorization: (handle, browserProfileId) => {
        const scope = authorization(handle, browserProfileId);
        return block ? resolverGate.promise.then(() => scope) : scope;
      },
    });
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    block = true;
    const validation = manager.validateLease(access(lease));
    await flushMicrotasks();
    await manager.invalidateSession("session-generation-1");
    resolverGate.resolve();
    await expect(validation).rejects.toThrow(/inactive|authorization/i);

    resolverGate = deferred<void>();
    const manager2 = createManager({
      resolveAuthorization: (handle, browserProfileId) => {
        const scope = authorization(handle, browserProfileId);
        return block ? resolverGate.promise.then(() => scope) : scope;
      },
    });
    block = false;
    const lease2 = await manager2.acquire(acquireInput({ mode: "write" }));
    block = true;
    const renewal = manager2.renew({
      lease: lease2,
      handle: holder(),
      ttlMs: 500,
    });
    await flushMicrotasks();
    await manager2.invalidateSession("session-generation-1");
    resolverGate.resolve();
    await expect(renewal).rejects.toThrow(/inactive|authorization/i);
  });

  test.each(["renew", "validate", "attach"] as const)(
    "%s rechecks the canonical handle after authorization awaits",
    async (operation) => {
      let block = false;
      const gate = deferred<void>();
      const manager = createManager({
        resolveAuthorization: (handle, browserProfileId) => {
          const resolved = authorization(handle, browserProfileId);
          return block ? gate.promise.then(() => resolved) : resolved;
        },
      });
      const activeInput = acquireInput({
        holderAgentId: `agent-await-${operation}`,
        sessionBindingGeneration: `generation-await-${operation}`,
        mode: "write",
      });
      const lease = await manager.acquire(activeInput);
      block = true;
      let pending: Promise<unknown>;
      if (operation === "renew")
        pending = manager.renew({ handle: activeInput.handle, lease, ttlMs: 500 });
      else if (operation === "validate")
        pending = manager.validateLease({ handle: activeInput.handle, lease });
      else
        pending = manager.attachHost({
          handle: activeInput.handle,
          lease,
          hostClientId: "host-await",
        });
      await flushMicrotasks();
      sessionRegistry.release({
        agentId: activeInput.handle.agentId,
        sessionBindingGeneration: activeInput.handle.context.sessionBindingGeneration,
      });
      gate.resolve();
      await expect(pending).rejects.toThrow(/current/i);
      await manager.close();
    },
  );

  test("release rechecks the canonical handle after initialization awaits", async () => {
    const manager = createManager();
    const activeInput = acquireInput({
      holderAgentId: "agent-release-await",
      sessionBindingGeneration: "generation-release-await",
      mode: "write",
    });
    const lease = await manager.acquire(activeInput);
    const releasing = manager.releaseLease({ handle: activeInput.handle, lease });
    sessionRegistry.release({
      agentId: activeInput.handle.agentId,
      sessionBindingGeneration: activeInput.handle.context.sessionBindingGeneration,
    });
    await expect(releasing).rejects.toThrow(/current/i);
    await manager.close();
  });

  test("shares reads, queues a writer FIFO, and reports waiting to the original Agent immediately", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ waiting });
    const firstRead = await manager.acquire(acquireInput());
    const secondRead = await manager.acquire(
      acquireInput({ holderAgentId: "agent-2", sessionBindingGeneration: "session-generation-2" }),
    );

    const writerPromise = manager.acquire(
      acquireInput({
        holderAgentId: "agent-writer",
        sessionBindingGeneration: "session-generation-writer",
        mode: "write",
      }),
    );
    const lateReaderPromise = manager.acquire(
      acquireInput({
        holderAgentId: "agent-late-reader",
        sessionBindingGeneration: "session-generation-late",
      }),
    );
    await flushMicrotasks();

    expect(firstRead.fencingToken).toBe(secondRead.fencingToken);
    expect(waiting).toMatchObject([
      {
        agentId: "agent-writer",
        workspaceId: "workspace-1",
        resourceId: PROFILE_ID,
        mode: "write",
        position: 1,
      },
      {
        agentId: "agent-late-reader",
        workspaceId: "workspace-1",
        resourceId: PROFILE_ID,
        mode: "read",
        position: 2,
      },
    ]);
    await expectStillWaiting(writerPromise);
    await expectStillWaiting(lateReaderPromise);

    await manager.releaseLease(access(firstRead));
    await expectStillWaiting(writerPromise);
    await manager.releaseLease(
      access(
        secondRead,
        acquireInput({
          holderAgentId: "agent-2",
          sessionBindingGeneration: "session-generation-2",
        }),
      ),
    );
    const writer = await writerPromise;
    expect(writer.mode).toBe("write");
    await expectStillWaiting(lateReaderPromise);
    await manager.releaseLease(
      access(
        writer,
        acquireInput({
          holderAgentId: "agent-writer",
          sessionBindingGeneration: "session-generation-writer",
          mode: "write",
        }),
      ),
    );
    await expect(lateReaderPromise).resolves.toMatchObject({ mode: "read" });
  });

  test("grants different Profiles without waiting", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ waiting });
    const [first, second] = await Promise.all([
      manager.acquire(acquireInput({ mode: "write" })),
      manager.acquire(
        acquireInput({
          resourceId: SECOND_PROFILE_ID,
          holderAgentId: "agent-2",
          sessionBindingGeneration: "session-generation-2",
          mode: "write",
        }),
      ),
    ]);
    expect(first.resourceId).toBe(PROFILE_ID);
    expect(second.resourceId).toBe(SECOND_PROFILE_ID);
    expect(waiting).toEqual([]);
  });

  test("serializes concurrent same-Profile writers", async () => {
    const waiting: BrowserProfileLeaseWaitingNotice[] = [];
    const manager = createManager({ waiting });
    const first = manager.acquire(acquireInput({ mode: "write" }));
    const second = manager.acquire(acquireInput({ holderAgentId: "agent-2", mode: "write" }));
    await expect(first).resolves.toMatchObject({ holderAgentId: "agent-1" });
    await expectStillWaiting(second);
    await manager.releaseLease(access(await first));
    await expect(second).resolves.toMatchObject({ holderAgentId: "agent-2" });
  });

  test("serializes concurrent drains to one same-Profile writer", async () => {
    const manager = createManager();
    const first = await manager.acquire(acquireInput({ mode: "read" }));
    const second = await manager.acquire(
      acquireInput({
        holderAgentId: "agent-2",
        sessionBindingGeneration: "session-generation-2",
        mode: "read",
      }),
    );
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-writer", mode: "write" }));
    await Promise.all([
      manager.releaseLease(access(first, acquireInput({ mode: "read" }))),
      manager.releaseLease(
        access(
          second,
          acquireInput({
            holderAgentId: "agent-2",
            sessionBindingGeneration: "session-generation-2",
            mode: "read",
          }),
        ),
      ),
    ]);
    await expect(waiting).resolves.toMatchObject({ holderAgentId: "agent-writer" });
  });

  test("does not grant before waiting notification succeeds", async () => {
    const notification = deferred<void>();
    const manager = createManager({ onWaiting: () => notification.promise });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-writer", mode: "write" }));
    await flushMicrotasks();
    await manager.releaseLease(access(active));
    await expectStillWaiting(waiting);
    notification.resolve();
    await expect(waiting).resolves.toMatchObject({ holderAgentId: "agent-writer" });
  });

  test("removes a waiter when notification times out, including after release", async () => {
    const clock = new FakeClockScheduler();
    const manager = createManager({ clock, onWaiting: () => new Promise<void>(() => undefined) });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-writer", mode: "write" }));
    await flushMicrotasks();
    await manager.releaseLease(access(active));
    clock.advance(2_000);
    await expect(waiting).rejects.toThrow(/timed out/i);
    await manager.waitForIdle();
  });

  test("ignores late notification completion after timeout, cancel, and close", async () => {
    const clock = new FakeClockScheduler();
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const notices: BrowserProfileLeaseWaitingNotice[] = [];
    let index = 0;
    const errors: Error[] = [];
    const manager = createManager({
      clock,
      onWaiting: (notice) => {
        notices.push(notice);
        return gates[index++]?.promise ?? Promise.resolve();
      },
      onError: (error) => errors.push(error),
    });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 10_000 }));
    const timedOut = manager.acquire(acquireInput({ holderAgentId: "agent-timeout" }));
    await flushMicrotasks();
    clock.advance(2_000);
    await expect(timedOut).rejects.toThrow(/timed out/i);
    gates[0]?.resolve();
    await manager.waitForIdle();

    const canceled = manager.acquire(acquireInput({ holderAgentId: "agent-cancel" }));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const canceledNotice = notices.find((notice) => notice.agentId === "agent-cancel");
    expect(canceledNotice).toBeDefined();
    expect(
      manager.cancel({
        requestId: canceledNotice?.requestId ?? "",
        handle: holder(acquireInput({ holderAgentId: "agent-cancel" })),
      }),
    ).toBe(true);
    gates[1]?.resolve();
    await expect(canceled).rejects.toThrow(/canceled/i);

    const closed = manager.acquire(acquireInput({ holderAgentId: "agent-close" }));
    await flushMicrotasks();
    await manager.close();
    gates[2]?.reject(new Error("late notification rejection"));
    await expect(closed).rejects.toThrow(/daemon ended|canceled/i);
    await manager.waitForIdle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("late notification rejection"));
    await expect(manager.releaseLease(access(active))).rejects.toThrow(/closed|inactive/i);
  });

  test("records late notification rejection after timeout without granting", async () => {
    const clock = new FakeClockScheduler();
    const gate = deferred<void>();
    const manager = createManager({ clock, onWaiting: () => gate.promise });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 10_000 }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-late-reject" }));
    await flushMicrotasks();
    clock.advance(2_000);
    await expect(waiting).rejects.toThrow(/timed out/i);
    gate.reject(new Error("late notification rejection"));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(manager.getWaitingErrors()).toEqual([new Error("late notification rejection")]);
    await manager.releaseLease(access(active));
  });

  test("double close shares teardown while initialization is blocked", async () => {
    const storage = new BlockingGenerationStorage();
    storage.blockNextWrite = true;
    const manager = createManager({ storage });
    const initializing = manager.acquire(acquireInput());
    await flushMicrotasks();
    const firstClose = manager.close();
    const secondClose = manager.close();
    expect(secondClose).toBe(firstClose);
    storage.releaseWrite();
    await expect(initializing).rejects.toThrow(/ended|closed|corrupt/i);
    await expect(firstClose).resolves.toBeUndefined();
  });

  test("double close shares teardown while a grant is blocked", async () => {
    const storage = new BlockingGenerationStorage();
    const manager = createManager({ storage });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-blocked" }));
    storage.blockNextWrite = true;
    const releasing = manager.releaseLease(access(active));
    await storage.writeStarted;
    const firstClose = manager.close();
    const secondClose = manager.close();
    expect(secondClose).toBe(firstClose);
    storage.releaseWrite();
    await expect(waiting).rejects.toThrow(/ended|closed|current/i);
    await releasing;
    await expect(firstClose).resolves.toBeUndefined();
  });

  test("heartbeat expiry releases a lease and grants the next waiter", async () => {
    const clock = new FakeClockScheduler();
    const manager = createManager({ clock });
    const writer = await manager.acquire(acquireInput({ mode: "write", ttlMs: 500 }));
    const waitingRead = manager.acquire(
      acquireInput({
        holderAgentId: "agent-2",
        sessionBindingGeneration: "session-generation-2",
        ttlMs: 500,
      }),
    );
    clock.advance(500);
    await manager.waitForIdle();
    await expect(waitingRead).resolves.toMatchObject({ holderAgentId: "agent-2" });
    await expect(manager.validateLease(access(writer))).rejects.toThrow(/expired|inactive/i);
  });

  test("validate emits lease_expired audit and close waits for that buffered append", async () => {
    const audit = new RecordingAuditSink();
    const clock = new FakeClockScheduler();
    const gate = deferred<void>();
    const started = deferred<void>();
    audit.blockedReasonCode = "lease_expired";
    audit.blocker = gate.promise;
    audit.onAppend = (event) => {
      if (event.reasonCode === "lease_expired") started.resolve();
    };
    const manager = createManager({ auditSink: audit, clock });
    const lease = await manager.acquire(acquireInput({ mode: "write", ttlMs: 500 }));
    clock.nowMs += 500;

    const validation = manager.validateLease(access(lease));
    await started.promise;
    const closing = manager.close();
    await expectStillWaiting(closing);
    gate.resolve();
    await expect(validation).rejects.toThrow(/expired|inactive/i);
    await expect(closing).resolves.toBeUndefined();
    expect(audit.events.map((event) => event.reasonCode)).toEqual([
      "lease_acquired",
      "lease_expired",
    ]);
  });

  test.each([
    ["negative", -1],
    ["NaN", Number.NaN],
  ])("rejects a %s clock sample without publishing a lease", async (_label, nowMs) => {
    const clock = new FakeClockScheduler();
    clock.nowMs = nowMs;
    const manager = createManager({ clock });
    await expect(manager.acquire(acquireInput({ mode: "write" }))).rejects.toThrow(/clock/i);
    await expect(
      manager.acquire(acquireInput({ holderAgentId: "agent-after-clock" })),
    ).rejects.toThrow(/clock/i);
    await expect(manager.close()).resolves.toBeUndefined();
  });

  test("timer callback fails closed on clock rollback and leaves no active lease", async () => {
    const clock = new FakeClockScheduler();
    const manager = createManager({ clock });
    const active = await manager.acquire(acquireInput({ mode: "write", ttlMs: 500 }));
    const waiting = manager.acquire(acquireInput({ holderAgentId: "agent-clock-waiter" }));
    await flushMicrotasks();

    clock.nowMs -= 1;
    clock.fireNextTimer();
    await expect(waiting).rejects.toThrow(/clock.*backwards/i);
    await manager.waitForIdle();
    await expect(manager.validateLease(access(active))).rejects.toThrow(/clock.*backwards/i);
    await expect(manager.close()).resolves.toBeUndefined();
  });

  test("samples the fenced clock once per acquire, renew, validate, and attach mutation", async () => {
    const clock = new FakeClockScheduler();
    const now = vi.spyOn(clock, "now");
    const manager = createManager({ clock });
    const acquired = await manager.acquire(acquireInput({ mode: "write" }));
    expect(now).toHaveBeenCalledTimes(1);
    const renewed = await manager.renew({ handle: holder(), lease: acquired, ttlMs: 1_000 });
    expect(now).toHaveBeenCalledTimes(2);
    await manager.validateLease(access(renewed));
    expect(now).toHaveBeenCalledTimes(3);
    await manager.attachHost({ handle: holder(), lease: renewed, hostClientId: "host-clock" });
    expect(now).toHaveBeenCalledTimes(4);
  });

  test("renew heartbeat postpones expiry and changes the monotonic lease revision", async () => {
    const clock = new FakeClockScheduler();
    const manager = createManager({ clock });
    const lease = await manager.acquire(acquireInput({ mode: "write", ttlMs: 500 }));
    clock.advance(400);
    const renewed = await manager.renew({
      lease,
      handle: holder(),
      ttlMs: 500,
    });
    expect(renewed.leaseRevision).not.toBe(lease.leaseRevision);
    clock.advance(400);
    await manager.waitForIdle();
    await expect(manager.validateLease(access(renewed))).resolves.toEqual(renewed);
    clock.advance(100);
    await manager.waitForIdle();
    await expect(manager.validateLease(access(renewed))).rejects.toThrow(/expired|inactive/i);
  });

  test("uses the safe revision fence for grants and renewals at MAX_SAFE_INTEGER", async () => {
    const manager = createManager({ initialLeaseRevision: Number.MAX_SAFE_INTEGER - 1 });
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    expect(lease.leaseRevision).toBe(`1:${Number.MAX_SAFE_INTEGER}`);
    await expect(manager.renew({ handle: holder(), lease, ttlMs: 500 })).rejects.toThrow(
      /revision exhausted/i,
    );
    await expect(manager.releaseLease(access(lease))).resolves.toBeUndefined();

    const exhausted = createManager({ initialLeaseRevision: Number.MAX_SAFE_INTEGER });
    await expect(
      exhausted.acquire(
        acquireInput({
          holderAgentId: "agent-revision-exhausted",
          sessionBindingGeneration: "generation-revision-exhausted",
          mode: "write",
        }),
      ),
    ).rejects.toThrow(/revision exhausted/i);
    await expect(exhausted.close()).resolves.toBeUndefined();
  });

  test("close waits for an in-flight buffered renew audit", async () => {
    const audit = new RecordingAuditSink();
    const gate = deferred<void>();
    audit.blockedReasonCode = "lease_renewed";
    audit.blocker = gate.promise;
    const manager = createManager({ auditSink: audit });
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    await manager.renew({ handle: holder(), lease, ttlMs: 500 });
    const closing = manager.close();
    await expectStillWaiting(closing);
    gate.resolve();
    await expect(closing).resolves.toBeUndefined();
    expect(audit.events.map((event) => event.reasonCode)).toEqual([
      "lease_acquired",
      "lease_renewed",
    ]);
  });

  test("renew rejects a same-principal request from the wrong Agent/session", async () => {
    const manager = createManager();
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    await expect(
      manager.renew({
        lease,
        handle: holder(
          acquireInput({
            holderAgentId: "agent-other",
            sessionBindingGeneration: "generation-other",
          }),
        ),
        ttlMs: 500,
      }),
    ).rejects.toThrow(/holder handle/i);
  });

  test("agent, Session, and Host invalidation release active and queued leases", async () => {
    const audit = new RecordingAuditSink();
    const manager = createManager({ auditSink: audit });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    await manager.attachHost({ lease: active, hostClientId: "host-1", handle: holder() });
    const queuedBySession = manager.acquire(
      acquireInput({
        holderAgentId: "agent-2",
        sessionBindingGeneration: "session-generation-2",
        mode: "write",
      }),
    );
    await flushMicrotasks();
    await manager.invalidateSession("session-generation-2");
    await expect(queuedBySession).rejects.toThrow(/invalidated/i);
    const next = manager.acquire(
      acquireInput({
        holderAgentId: "agent-3",
        sessionBindingGeneration: "session-generation-3",
        mode: "write",
      }),
    );
    await manager.invalidateHost("host-1");
    await expect(next).resolves.toMatchObject({ holderAgentId: "agent-3" });
    await manager.invalidateAgent("agent-3");
    await expect(
      manager.validateLease(
        access(
          await next,
          acquireInput({
            holderAgentId: "agent-3",
            sessionBindingGeneration: "session-generation-3",
            mode: "write",
          }),
        ),
      ),
    ).rejects.toThrow(/inactive/i);
    expect(audit.events.map((event) => event.reasonCode)).toEqual([
      "lease_acquired",
      "lease_invalidated_host",
      "lease_acquired",
      "lease_invalidated_agent",
    ]);
  });

  test("daemon restart invalidates old leases and preserves monotonic fencing", async () => {
    const storage = new MemoryGenerationStorage();
    const firstManager = createManager({ storage });
    const oldLease = await firstManager.acquire(acquireInput({ mode: "write" }));
    await firstManager.close();
    const restarted = createManager({ storage, ids: ["lea_66666666-6666-4666-8666-666666666666"] });
    const newLease = await restarted.acquire(acquireInput({ mode: "write" }));
    expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
    expect(newLease.leaseRevision).not.toBe(oldLease.leaseRevision);
    await expect(restarted.validateLease(access(oldLease))).rejects.toThrow(/inactive|generation/i);
  });

  test("persists generation and fence state across restart and concurrent initialization", async () => {
    const storage = new MemoryGenerationStorage();
    const manager = createManager({ storage });
    await Promise.all([manager.initialize(), manager.initialize(), manager.initialize()]);
    expect(storage.value).toEqual({ version: 1, generation: 1, nextFencingToken: 1 });
    const oldLease = await manager.acquire(acquireInput({ mode: "write" }));
    expect(storage.value).toEqual({ version: 1, generation: 1, nextFencingToken: 2 });
    await manager.close();
    const restarted = createManager({ storage });
    await Promise.all([restarted.initialize(), restarted.initialize()]);
    expect(storage.value).toEqual({ version: 1, generation: 2, nextFencingToken: 2 });
    const newLease = await restarted.acquire(acquireInput({ mode: "write" }));
    expect(newLease.fencingToken).toBe(2);
    expect(newLease.leaseRevision.startsWith("2:")).toBe(true);
    expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
  });

  test("close during an in-flight grant leaves no active lease after storage resumes", async () => {
    const storage = new BlockingGenerationStorage();
    const manager = createManager({ storage });
    await manager.initialize();
    storage.blockNextWrite = true;
    const pending = manager.acquire(acquireInput({ mode: "write" }));
    await flushMicrotasks();
    expect(storage.writeStarted).not.toBeNull();
    const closing = manager.close();
    storage.releaseWrite();
    await expect(pending).rejects.toThrow(/daemon ended|closed|no longer current/i);
    await expect(closing).resolves.toBeUndefined();
  });

  test("rejects a persisted grant when the Session is revoked before publication", async () => {
    const storage = new BlockingGenerationStorage();
    const manager = createManager({ storage });
    await manager.initialize();
    const testSession = sessionHandle("agent-1", "session-generation-1");
    const input = acquireInput({
      mode: "write",
      handle: testSession,
    });
    storage.blockNextWrite = true;
    const pending = manager.acquire(input);
    await flushMicrotasks();
    sessionRegistry.release({
      agentId: "agent-1",
      sessionBindingGeneration: "session-generation-1",
    });
    storage.releaseWrite();
    await expect(pending).rejects.toThrow(/current|authorization/i);
    await manager.close();
  });

  test("close waits for in-flight initialization", async () => {
    const storage = new BlockingGenerationStorage();
    const manager = createManager({ storage });
    storage.blockNextWrite = true;
    const initializing = manager.initialize();
    await flushMicrotasks();
    expect(storage.writeStarted).not.toBeNull();
    const closing = manager.close();
    storage.releaseWrite();
    await expect(initializing).rejects.toThrow(/ended|closed|corrupt/i);
    await expect(closing).resolves.toBeUndefined();
  });

  test("a queued grant storage failure rejects that waiter and continues FIFO", async () => {
    const storage = new MemoryGenerationStorage();
    const manager = createManager({ storage });
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    storage.failNextWrite = true;
    const failed = manager.acquire(acquireInput({ holderAgentId: "agent-failed", mode: "write" }));
    const later = manager.acquire(acquireInput({ holderAgentId: "agent-later", mode: "write" }));
    await manager.releaseLease(access(active));
    await expect(failed).rejects.toThrow(/storage unavailable/i);
    await expect(later).resolves.toMatchObject({ holderAgentId: "agent-later" });
  });

  test("validates the complete lease tuple and rejects stale fencing before execution", async () => {
    const manager = createManager();
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    await expect(
      manager.validateLease({
        handle: holder(),
        lease: { ...lease, resourceId: SECOND_PROFILE_ID },
      }),
    ).rejects.toThrow(/inactive|tuple/i);
    await expect(
      manager.validateLease({
        handle: holder(),
        lease: { ...lease, fencingToken: lease.fencingToken - 1 },
      }),
    ).rejects.toThrow(/fencing/i);
    await expect(
      manager.validateLease({
        handle: holder(),
        lease: { ...lease, leaseRevision: "stale-revision" },
      }),
    ).rejects.toThrow(/revision/i);
    await expect(
      manager.validateLease({
        handle: holder(),
        lease: { ...lease, nodeId: "nod_2222222222222222" },
      }),
    ).rejects.toThrow(/tuple/i);
    await expect(
      manager.validateLease({
        handle: holder(),
        lease: { ...lease, heartbeatAt: "2026-09-09T10:00:01.000Z" },
      }),
    ).rejects.toThrow(/tuple/i);
  });

  test("re-resolves current authorization before execution", async () => {
    let bindingRevision = "binding-revision-1";
    const manager = createManager({
      resolveAuthorization: (handle, browserProfileId) =>
        authorization(handle, browserProfileId, { bindingRevision }),
    });
    const lease = await manager.acquire(acquireInput({ mode: "write" }));
    await expect(manager.validateLease(access(lease))).resolves.toEqual(lease);
    bindingRevision = "binding-revision-2";
    await expect(manager.validateLease(access(lease))).rejects.toThrow(/authorization/i);
  });

  test("fails closed when persisted generation state is corrupt", async () => {
    const manager = createManager({
      storage: new MemoryGenerationStorage({ version: 1, generation: 2 }),
    });
    await expect(manager.initialize()).rejects.toThrow(/corrupt/i);
    await expect(manager.acquire(acquireInput())).rejects.toThrow(/corrupt/i);
  });

  test("close invalidates every active and queued lease", async () => {
    const manager = createManager();
    const active = await manager.acquire(acquireInput({ mode: "write" }));
    const queued = manager.acquire(
      acquireInput({ holderAgentId: "agent-2", sessionBindingGeneration: "session-generation-2" }),
    );
    await flushMicrotasks();
    await manager.close();
    await expect(queued).rejects.toThrow(/daemon.*ended/i);
    await expect(manager.validateLease(access(active))).rejects.toThrow(/closed|inactive/i);
    await expect(manager.acquire(acquireInput())).rejects.toThrow(/closed/i);
  });
});
