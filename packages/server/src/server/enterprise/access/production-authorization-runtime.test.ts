import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { DaemonPermission, NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SessionInboundMessage } from "../../messages.js";
import { SessionAuthorization } from "../../authorization/index.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  releaseEnterpriseAdmissionSession,
  replaceEnterpriseAdmissionSession,
} from "../identity/admission-authorization.js";
import {
  FileBackedGrantStorage,
  GrantStore,
  type GrantStorage,
  type GrantVersionSource,
} from "./grant-store.js";
import { OwnerRegistry } from "./owner-registry.js";
import {
  createEnterpriseAuthorizationRuntime,
  isCurrentProductionAuthorizationRuntimeForSession,
  isCurrentProductionAuthorizationRuntime,
  ProductionAuthorizationRuntimeTeardownError,
  type ProductionAuthorizationRuntime,
  type ProductionAuthorizationRuntimeOptions,
  type ProductionAuthorizationStatePort,
} from "./production-authorization-runtime.js";

const executeFile = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_authorization",
  mode: "standalone",
};
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_authorization",
  grantVersion: "grv_1",
  grants: [
    {
      action: "workspace.content.read",
      selector: { kind: "workspace", workspaceIds: ["wks_a"] },
    },
  ],
};
const grantRecord = {
  principalId: principal.principalId,
  organizationId: principal.organizationId,
  grants: principal.grants,
  grantVersion: principal.grantVersion,
};

class EmptyAuthorityState implements ProductionAuthorizationStatePort {
  async consumeAuthorizedRequest() {
    return null;
  }
  async resolveCurrentSessionBinding() {
    return null;
  }
  async register() {
    return null;
  }
  async resolveOpen() {
    return null;
  }
  async mintFreshReceipt() {
    return null;
  }
  async burnFreshReceipts() {}
  async close() {}
}

class TeardownAuthorityState extends EmptyAuthorityState {
  readonly closeErrors: readonly Error[];
  readonly closeStarted = deferred<void>();
  readonly releaseClose = deferred<void>();
  closeCalls = 0;

  constructor(closeErrors: readonly Error[] = []) {
    super();
    this.closeErrors = closeErrors;
  }

  override async register(input: Parameters<ProductionAuthorizationStatePort["register"]>[0]) {
    return input.binding;
  }

  override async close() {
    const index = this.closeCalls;
    this.closeCalls += 1;
    if (this.closeCalls === 1) this.closeStarted.resolve();
    await this.releaseClose.promise;
    const error = this.closeErrors[index];
    if (error) throw error;
  }
}

class PendingRegisterAuthorityState extends TeardownAuthorityState {
  readonly registerStarted = deferred<void>();
  readonly releaseRegister = deferred<void>();

  override async register(input: Parameters<ProductionAuthorizationStatePort["register"]>[0]) {
    this.registerStarted.resolve();
    await this.releaseRegister.promise;
    return input.binding;
  }
}

class PendingReceiptAuthorityState extends EmptyAuthorityState {
  readonly receiptMinted = deferred<void>();
  readonly releaseReceipt = deferred<void>();
  readonly receipts = new Set<string>();
  private binding: Awaited<ReturnType<ProductionAuthorizationStatePort["register"]>> = null;
  burnCalls = 0;
  closeCalls = 0;

  override async register(input: Parameters<ProductionAuthorizationStatePort["register"]>[0]) {
    this.binding = input.binding;
    return input.binding;
  }

  override async resolveOpen() {
    return this.binding;
  }

  override async mintFreshReceipt(
    input: Parameters<ProductionAuthorizationStatePort["mintFreshReceipt"]>[0],
  ) {
    const receipt = input.materializeReceipt({
      receiptId: "receipt-pending-runtime-release",
      expiresAt: 2_000_000_000_000,
    });
    if (receipt) this.receipts.add(receipt.receiptId);
    this.receiptMinted.resolve();
    await this.releaseReceipt.promise;
    return receipt;
  }

  override async burnFreshReceipts() {
    this.burnCalls += 1;
    this.receipts.clear();
  }

  override async close() {
    this.closeCalls += 1;
    this.receipts.clear();
  }
}

class Versions implements GrantVersionSource {
  private nextValue = 1;
  next() {
    this.nextValue += 1;
    return `grv_${this.nextValue}`;
  }
}

let parent = "";
let addonPath = "";

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  parent = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-production-auth-"));
  addonPath = path.join(parent, "darwin-audit-fs.node");
  await executeFile(process.execPath, [
    fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
    "--output",
    addonPath,
  ]);
});

afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("production enterprise authorization runtime", () => {
  test("rejects a structural factory input without touching authority-shaped getters", async () => {
    let getterCalls = 0;
    const input = Object.defineProperty({}, "audit", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { releaseReady: true };
      },
    });

    await expect(createEnterpriseAuthorizationRuntime(input)).resolves.toBeNull();
    expect(getterCalls).toBe(0);
  });

  test.runIf(process.platform === "darwin")(
    "restores a real GrantStore and derives all authority from the W1 handle",
    async () => {
      const fixture = await createFixture("real");
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);

      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error("expected production authorization runtime");
      expect(runtime.principal).toEqual(principal);
      expect(runtime.node).toEqual(node);
      expect(runtime.binding).toMatchObject({
        sessionId: "session-real",
        clientId: "client-a",
        organizationId: principal.organizationId,
        principalId: principal.principalId,
        nodeId: node.nodeId,
        grantVersion: principal.grantVersion,
      });
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(Object.isFrozen(runtime.principal)).toBe(true);
      expect(Object.isFrozen(runtime.binding)).toBe(true);
      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(true);
      await expect(
        runtime.resourceAuthorization.assertWorkspace(
          runtime.principal,
          "workspace.content.read",
          "wks_a",
        ),
      ).resolves.toMatchObject({ workspaceId: "wks_a" });

      await runtime.release();
      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(false);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "accepts only the exact current runtime and authoritative session source",
    async () => {
      const fixture = await createFixture("session-current");
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      if (!runtime) throw new Error("expected production authorization runtime");
      const input = runtimeSessionInput(runtime, fixture);

      expect(isCurrentProductionAuthorizationRuntimeForSession(runtime, input)).toBe(true);
      expect(isCurrentProductionAuthorizationRuntimeForSession({ ...runtime }, input)).toBe(false);
      expect(
        isCurrentProductionAuthorizationRuntimeForSession(runtime, {
          ...input,
          admissionAuthorizationIssuer: createEnterpriseAdmissionAuthorizationIssuer(
            Object.freeze({}),
          ),
        }),
      ).toBe(false);
      expect(
        isCurrentProductionAuthorizationRuntimeForSession(runtime, {
          ...input,
          admissionAuthorizationHandle: Object.freeze({}),
        }),
      ).toBe(false);
      expect(
        isCurrentProductionAuthorizationRuntimeForSession(runtime, {
          ...input,
          sessionAuthorization: new SessionAuthorization(["workspace.read"]),
        }),
      ).toBe(false);

      for (const mismatch of [
        { sessionId: "session-other" },
        { clientId: "client-other" },
        { sessionBindingKey: "binding-other" },
        {
          enterpriseContext: {
            ...input.enterpriseContext,
            sessionBindingGeneration: "generation-other",
          },
        },
        {
          enterpriseContext: {
            ...input.enterpriseContext,
            node: { ...input.enterpriseContext.node, nodeId: "nod_fedcba9876543210" },
          },
        },
        {
          enterpriseContext: {
            ...input.enterpriseContext,
            principal: { ...input.enterpriseContext.principal, grantVersion: "grv_other" },
          },
        },
        {
          enterpriseContext: {
            ...input.enterpriseContext,
            principal: { ...input.enterpriseContext.principal, grants: [] },
          },
        },
      ]) {
        expect(
          isCurrentProductionAuthorizationRuntimeForSession(runtime, { ...input, ...mismatch }),
        ).toBe(false);
      }

      let getterCalls = 0;
      const malformed = Object.defineProperty({ ...input }, "enterpriseContext", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return input.enterpriseContext;
        },
      });
      expect(isCurrentProductionAuthorizationRuntimeForSession(runtime, malformed)).toBe(false);
      expect(getterCalls).toBe(0);

      await runtime.release();
      expect(isCurrentProductionAuthorizationRuntimeForSession(runtime, input)).toBe(false);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "invalidates the whole runtime after a persisted Grant update",
    async () => {
      const fixture = await createFixture("grant-revoke");
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error("expected production authorization runtime");

      await fixture.store.update({
        actor: principal,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
        grants: [],
        expectedVersion: principal.grantVersion,
      });

      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(false);
      expect(runtime.grantVersionGuard.isCurrent(runtime.principal)).toBe(false);
      await expect(
        runtime.resourceAuthorization.assertWorkspace(
          runtime.principal,
          "workspace.content.read",
          "wks_a",
        ),
      ).rejects.toThrow("Resource unavailable");
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "fails closed when the W1 handle is released during Grant restore",
    async () => {
      let unblock!: (record: typeof grantRecord) => void;
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<typeof grantRecord>((resolve) => {
        unblock = resolve;
      });
      const storage: GrantStorage = {
        get: async () => {
          started();
          return blocked;
        },
        put: async () => undefined,
      };
      const fixture = await createFixture("revoke-race", storage);
      const pending = createEnterpriseAuthorizationRuntime(fixture.options);
      await didStart;
      expect(releaseEnterpriseAdmissionSession(fixture.issuer, fixture.handle)).toBe(true);
      unblock(grantRecord);

      await expect(pending).resolves.toBeNull();
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "rejects caller authority fields, foreign issuers, and structural GrantStores",
    async () => {
      const fixture = await createFixture("forgeries");
      await expect(
        createEnterpriseAuthorizationRuntime({
          ...fixture.options,
          principal,
          node,
          permission: "workspace.read",
          generation: "caller-generation",
          current: true,
        }),
      ).resolves.toBeNull();
      await expect(
        createEnterpriseAuthorizationRuntime({
          ...fixture.options,
          admissionAuthorizationIssuer: createEnterpriseAdmissionAuthorizationIssuer(
            Object.freeze({}),
          ),
        }),
      ).resolves.toBeNull();
      await expect(
        createEnterpriseAuthorizationRuntime({ ...fixture.options, grantStore: {} }),
      ).resolves.toBeNull();

      expect(await createEnterpriseAuthorizationRuntime(fixture.options)).not.toBeNull();
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "rejects a persisted Grant version or grant-set mismatch",
    async () => {
      const wrongVersion = await createFixture("wrong-version", {
        get: async () => ({ ...grantRecord, grantVersion: "grv_other" }),
        put: async () => undefined,
      });
      await expect(createEnterpriseAuthorizationRuntime(wrongVersion.options)).resolves.toBeNull();
      await wrongVersion.audit.close();

      const wrongGrants = await createFixture("wrong-grants", {
        get: async () => ({ ...grantRecord, grants: [] }),
        put: async () => undefined,
      });
      await expect(createEnterpriseAuthorizationRuntime(wrongGrants.options)).resolves.toBeNull();
      await wrongGrants.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "requires the GrantStore and runtime to share the exact production audit capability",
    async () => {
      const fixture = await createFixture("audit-source");
      const foreignAudit = await createProductionAuditRuntime({
        node,
        auditRoot: path.join(parent, "audit-source-foreign"),
        nativeAddonPath: addonPath,
      });

      await expect(
        createEnterpriseAuthorizationRuntime({ ...fixture.options, audit: foreignAudit }),
      ).resolves.toBeNull();

      await fixture.audit.close();
      await foreignAudit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "fails closed immediately, shares teardown, unsubscribes, and preserves close failures",
    async () => {
      const firstCloseError = new Error("first W3 close failed");
      const secondCloseError = new Error("second W3 close failed");
      const state = new TeardownAuthorityState([firstCloseError, secondCloseError]);
      const fixture = await createFixture("release-teardown", undefined, state, [
        "workspace.read",
        "daemon.read",
      ]);
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      if (!runtime) throw new Error("expected production authorization runtime");
      await registerDaemonRequest(runtime, fixture.sessionAuthorization, "release-a");
      await registerDaemonRequest(runtime, fixture.sessionAuthorization, "release-b");

      const first = runtime.release();
      const second = runtime.release();
      expect(second).toBe(first);
      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(false);
      expect(runtime.grantVersionGuard.isCurrent(runtime.principal)).toBe(false);
      await state.closeStarted.promise;

      await expect(
        fixture.store.update({
          actor: principal,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
          grants: [],
          expectedVersion: principal.grantVersion,
        }),
      ).resolves.toMatchObject({ changed: true });
      state.releaseClose.resolve();

      const error = await first.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProductionAuthorizationRuntimeTeardownError);
      if (!(error instanceof ProductionAuthorizationRuntimeTeardownError)) throw error;
      expect(error.errors).toEqual([firstCloseError, secondCloseError]);
      expect(error.cause).toBe(firstCloseError);
      expect(Object.isFrozen(error.errors)).toBe(true);
      expect(runtime.release()).toBe(first);
      await expect(runtime.release()).rejects.toBe(error);
      expect(state.closeCalls).toBe(2);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "makes Grant invalidation wait for the shared one-shot W3 teardown",
    async () => {
      const state = new TeardownAuthorityState();
      const fixture = await createFixture("invalidation-teardown", undefined, state, [
        "workspace.read",
        "daemon.read",
      ]);
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      if (!runtime) throw new Error("expected production authorization runtime");
      await registerDaemonRequest(runtime, fixture.sessionAuthorization, "invalidation");

      let updateSettled = false;
      const update = fixture.store
        .update({
          actor: principal,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
          grants: [],
          expectedVersion: principal.grantVersion,
        })
        .finally(() => {
          updateSettled = true;
        });
      await state.closeStarted.promise;
      const release = runtime.release();
      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(false);
      expect(updateSettled).toBe(false);
      expect(state.closeCalls).toBe(1);

      state.releaseClose.resolve();
      await expect(update).resolves.toMatchObject({ changed: true });
      await expect(release).resolves.toBeUndefined();
      expect(state.closeCalls).toBe(1);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "waits for a pending registration and fails its late authority state closed",
    async () => {
      const closeError = new Error("late registration close failed");
      const state = new PendingRegisterAuthorityState([closeError]);
      const fixture = await createFixture("pending-registration", undefined, state, [
        "workspace.read",
        "daemon.read",
      ]);
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      if (!runtime) throw new Error("expected production authorization runtime");
      const handle = prepareDaemonRequest(
        runtime,
        fixture.sessionAuthorization,
        "pending-register",
      );

      const registration = runtime.outboundAuthorityEmissionAuthorizer.register(handle);
      await state.registerStarted.promise;
      let releaseSettled = false;
      const release = runtime.release();
      void release.then(
        () => {
          releaseSettled = true;
          return undefined;
        },
        () => {
          releaseSettled = true;
          return undefined;
        },
      );
      expect(isCurrentProductionAuthorizationRuntime(runtime)).toBe(false);
      await Promise.resolve();
      expect(releaseSettled).toBe(false);

      state.releaseRegister.resolve();
      await state.closeStarted.promise;
      expect(releaseSettled).toBe(false);
      state.releaseClose.resolve();

      await expect(registration).resolves.toBe(false);
      const error = await release.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProductionAuthorizationRuntimeTeardownError);
      if (!(error instanceof ProductionAuthorizationRuntimeTeardownError)) throw error;
      expect(error.errors).toEqual([closeError]);
      expect(error.cause).toBe(closeError);
      expect(runtime.release()).toBe(release);
      expect(state.closeCalls).toBe(1);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "waits for pending receipt materialization and burns the late receipt before release",
    async () => {
      const state = new PendingReceiptAuthorityState();
      const fixture = await createFixture("pending-receipt", undefined, state, [
        "workspace.read",
        "daemon.read",
      ]);
      const runtime = await createEnterpriseAuthorizationRuntime(fixture.options);
      if (!runtime) throw new Error("expected production authorization runtime");
      const handle = prepareDaemonRequest(runtime, fixture.sessionAuthorization, "pending-receipt");
      await expect(runtime.outboundAuthorityEmissionAuthorizer.register(handle)).resolves.toBe(
        true,
      );

      const emission = runtime.outboundAuthorityEmissionAuthorizer.authorizeEmission(
        handle,
        daemonStatusResponse("pending-receipt"),
      );
      await state.receiptMinted.promise;
      expect(state.receipts).toEqual(new Set(["receipt-pending-runtime-release"]));
      let releaseSettled = false;
      const release = runtime.release();
      void release.then(
        () => {
          releaseSettled = true;
          return undefined;
        },
        () => {
          releaseSettled = true;
          return undefined;
        },
      );
      await Promise.resolve();
      expect(releaseSettled).toBe(false);

      state.releaseReceipt.resolve();
      await expect(emission).resolves.toBeNull();
      await expect(release).resolves.toBeUndefined();
      expect(state.receipts.size).toBe(0);
      expect(state.burnCalls).toBe(1);
      expect(state.closeCalls).toBe(1);
      expect(runtime.release()).toBe(release);
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "invalidates the old runtime and accepts only the exact replacement handle",
    async () => {
      const fixture = await createFixture("replace");
      const oldRuntime = await createEnterpriseAuthorizationRuntime(fixture.options);
      expect(oldRuntime).not.toBeNull();
      const nextEvidence = issueEnterpriseAdmissionEvidence(
        fixture.issuer,
        fixture.mintSecret,
        principal,
        node,
        { node, transport: "direct", peer: "loopback" },
      )!;
      const nextHandle = replaceEnterpriseAdmissionSession(
        fixture.issuer,
        fixture.handle,
        nextEvidence,
        "client-a",
      );
      expect(nextHandle).not.toBeNull();
      expect(isCurrentProductionAuthorizationRuntime(oldRuntime)).toBe(false);

      const nextRuntime = await createEnterpriseAuthorizationRuntime({
        ...fixture.options,
        admissionAuthorizationHandle: nextHandle,
        sessionId: "session-replacement",
      });
      expect(nextRuntime).not.toBeNull();
      expect(nextRuntime?.binding.sessionBindingGeneration).not.toBe(
        oldRuntime?.binding.sessionBindingGeneration,
      );
      await oldRuntime?.release();
      await nextRuntime?.release();
      await fixture.audit.close();
    },
  );
});

async function createFixture(
  name: string,
  storageOverride?: GrantStorage,
  authorityState: ProductionAuthorizationStatePort = new EmptyAuthorityState(),
  permissions: readonly DaemonPermission[] = ["workspace.read"],
) {
  const audit = await createProductionAuditRuntime({
    node,
    auditRoot: path.join(parent, `audit-${name}`),
    nativeAddonPath: addonPath,
  });
  const storage =
    storageOverride ?? new FileBackedGrantStorage(path.join(parent, `grants-${name}.json`));
  if (!storageOverride) await storage.put(grantRecord);
  const store = new GrantStore(storage, new Versions(), audit);
  const mintSecret = Object.freeze({});
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
  const evidence = issueEnterpriseAdmissionEvidence(issuer, mintSecret, principal, node, {
    node,
    transport: "direct",
    peer: "loopback",
  });
  const handle = bindEnterpriseAdmissionSession(issuer, evidence!, "client-a")!;
  const owners = new OwnerRegistry();
  owners.registerWorkspace({
    id: "wks_a",
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const options = {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    grantStore: store,
    audit,
    sessionAuthorization: new SessionAuthorization([...permissions]),
    sessionId: `session-${name}`,
    owners,
    authorityState,
  } satisfies ProductionAuthorizationRuntimeOptions;
  return {
    audit,
    store,
    issuer,
    handle,
    mintSecret,
    sessionAuthorization: options.sessionAuthorization,
    options,
  };
}

async function registerDaemonRequest(
  runtime: ProductionAuthorizationRuntime,
  authorization: SessionAuthorization,
  requestId: string,
): Promise<void> {
  const handle = prepareDaemonRequest(runtime, authorization, requestId);
  await expect(runtime.outboundAuthorityEmissionAuthorizer.register(handle)).resolves.toBe(true);
}

function prepareDaemonRequest(
  runtime: ProductionAuthorizationRuntime,
  authorization: SessionAuthorization,
  requestId: string,
) {
  const message = { type: "daemon.get_status.request", requestId } as SessionInboundMessage;
  const decision = authorization.authorizeInbound(message);
  if (!decision) throw new Error("expected daemon authorization decision");
  const pending = runtime.inboundAuthorityRequestAuthorizer.authorize(message, decision);
  if (!pending) throw new Error("expected inbound authority evidence");
  const consumed = runtime.inboundAuthorityRequestAuthorizer.consumeForRegistration(
    message,
    pending,
  );
  if (!consumed) throw new Error("expected active authorized request handle");
  return consumed.activeRequestHandle;
}

function daemonStatusResponse(requestId: string) {
  return {
    type: "daemon.get_status.response" as const,
    payload: {
      requestId,
      serverId: "srv_authorization",
      version: "1.0.0",
      pid: 1,
      nodePath: "/usr/bin/node",
      startedAt: null,
      listen: "127.0.0.1:0",
      relay: null,
      providers: [],
    },
  };
}

function runtimeSessionInput(
  runtime: ProductionAuthorizationRuntime,
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  return {
    admissionAuthorizationIssuer: fixture.issuer,
    admissionAuthorizationHandle: fixture.handle,
    sessionAuthorization: fixture.sessionAuthorization,
    sessionId: runtime.binding.sessionId,
    clientId: runtime.binding.clientId,
    sessionBindingKey: runtime.binding.sessionBindingKey,
    enterpriseContext: {
      principal: runtime.principal,
      node: runtime.node,
      sessionBindingGeneration: runtime.binding.sessionBindingGeneration,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
