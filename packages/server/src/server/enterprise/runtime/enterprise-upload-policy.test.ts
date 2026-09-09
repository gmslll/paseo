import type {
  AuthorizedWorkspace,
  EnterpriseAction,
  NodeContext,
  PrincipalContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX,
  EnterpriseUploadPolicy,
  EnterpriseUploadPolicyError,
  type EnterpriseUploadAbortInput,
  type EnterpriseUploadAppendInput,
  type EnterpriseUploadCapability,
  type EnterpriseUploadCleanupInput,
  type EnterpriseUploadClock,
  type EnterpriseUploadFinalizeInput,
  type EnterpriseUploadFinalizedTarget,
  type EnterpriseUploadIssueInput,
  type EnterpriseUploadRandomSource,
  type EnterpriseUploadSafeFsPort,
} from "./enterprise-upload-policy.js";

const ORGANIZATION_ID = "org_0123456789abcdef";
const OTHER_ORGANIZATION_ID = "org_fedcba9876543210";
const NODE_ID = "nod_0123456789abcdef";
const OTHER_NODE_ID = "nod_fedcba9876543210";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const OTHER_PRINCIPAL_ID = "usr_fedcba9876543210";
const CREDENTIAL_ID = "credential-one";
const OTHER_CREDENTIAL_ID = "credential-two";
const GRANT_VERSION = "grant-version-one";
const OTHER_GRANT_VERSION = "grant-version-two";
const SESSION_GENERATION = "session-generation-one";
const OTHER_SESSION_GENERATION = "session-generation-two";
const WORKSPACE_ID = "workspace-one";
const OTHER_WORKSPACE_ID = "workspace-two";
const RELATIVE_PATH = "uploads/report.csv";
const OTHER_RELATIVE_PATH = "uploads/other.csv";

interface PrincipalOverrides {
  organizationId?: string;
  principalId?: string;
  credentialId?: string;
  grantVersion?: string;
}

function principal(overrides: PrincipalOverrides = {}): PrincipalContext {
  return {
    principalType: "human",
    principalId: overrides.principalId ?? PRINCIPAL_ID,
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    credentialId: overrides.credentialId ?? CREDENTIAL_ID,
    grantVersion: overrides.grantVersion ?? GRANT_VERSION,
    grants: [
      {
        action: "workspace.write",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

interface NodeOverrides {
  nodeId?: string;
  paseoServerId?: string;
  mode?: "standalone" | "managed";
}

function node(overrides: NodeOverrides = {}): NodeContext {
  return {
    nodeId: overrides.nodeId ?? NODE_ID,
    paseoServerId: overrides.paseoServerId ?? "server-one",
    mode: overrides.mode ?? "standalone",
  };
}

interface WorkspaceOverrides {
  organizationId?: string;
  nodeId?: string;
  workspaceId?: string;
  ownerPrincipalId?: string;
  createdByPrincipalId?: string;
}

function workspace(overrides: WorkspaceOverrides = {}): AuthorizedWorkspace {
  return {
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    nodeId: overrides.nodeId ?? NODE_ID,
    ownerPrincipalId: overrides.ownerPrincipalId ?? PRINCIPAL_ID,
    createdByPrincipalId: overrides.createdByPrincipalId ?? PRINCIPAL_ID,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
  };
}

function capability(
  overrides: Partial<EnterpriseUploadCapability> = {},
): EnterpriseUploadCapability {
  return {
    capabilityId: overrides.capabilityId ?? "safe-upload-capability-one",
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    nodeId: overrides.nodeId ?? NODE_ID,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    relativePath: overrides.relativePath ?? RELATIVE_PATH,
    directoryIdentity: overrides.directoryIdentity ?? { dev: 11, ino: 22 },
  };
}

function finalizedTarget(
  source: EnterpriseUploadCapability,
  overrides: Partial<EnterpriseUploadFinalizedTarget> = {},
): EnterpriseUploadFinalizedTarget {
  return {
    capabilityId: overrides.capabilityId ?? source.capabilityId,
    organizationId: overrides.organizationId ?? source.organizationId,
    nodeId: overrides.nodeId ?? source.nodeId,
    workspaceId: overrides.workspaceId ?? source.workspaceId,
    relativePath: overrides.relativePath ?? source.relativePath,
    directoryIdentity: overrides.directoryIdentity ?? { ...source.directoryIdentity },
    fileIdentity: overrides.fileIdentity ?? { dev: 11, ino: 23, size: 37, mtimeMs: 42.5 },
  };
}

interface AuthorizationCall {
  readonly principal: PrincipalContext;
  readonly action: EnterpriseAction;
  readonly workspaceId: string;
}

interface TestAuthorization extends Pick<ResourceAuthorization, "assertWorkspace"> {
  readonly calls: AuthorizationCall[];
}

type AuthorizationHandler = (
  principal: PrincipalContext,
  action: EnterpriseAction,
  workspaceId: string,
  callNumber: number,
) => AuthorizedWorkspace | Promise<AuthorizedWorkspace>;

function createAuthorization(handler: AuthorizationHandler = () => workspace()): TestAuthorization {
  const calls: AuthorizationCall[] = [];
  return {
    calls,
    async assertWorkspace(inputPrincipal, action, workspaceId) {
      calls.push({ principal: inputPrincipal, action, workspaceId });
      return handler(inputPrincipal, action, workspaceId, calls.length);
    },
  };
}

class TestClock implements EnterpriseUploadClock {
  public constructor(public value: number) {}

  public now(): number {
    return this.value;
  }
}

class IncrementingRandomSource implements EnterpriseUploadRandomSource {
  public readonly requestedSizes: number[] = [];
  private nextByte = 1;

  public randomBytes(size: number): Uint8Array {
    this.requestedSizes.push(size);
    return new Uint8Array(size).fill(this.nextByte++);
  }
}

class SequenceRandomSource implements EnterpriseUploadRandomSource {
  public readonly requestedSizes: number[] = [];

  public constructor(private readonly values: readonly unknown[]) {}

  public randomBytes(size: number): Uint8Array {
    this.requestedSizes.push(size);
    const value = this.values[this.requestedSizes.length - 1];
    if (value === undefined) throw new Error("Test random sequence exhausted");
    return value as Uint8Array;
  }
}

interface PrepareCall {
  readonly workspace: AuthorizedWorkspace;
  readonly relativePath: string;
  readonly signal: AbortSignal;
}

class TestSafeFs implements EnterpriseUploadSafeFsPort {
  public releaseReady = true;
  public supportsDirectoryRelativeOperations = true;
  public readonly prepareCalls: PrepareCall[] = [];
  public readonly appendCalls: Array<{
    capability: EnterpriseUploadCapability;
    offset: number;
    bytes: Uint8Array;
    signal: AbortSignal;
  }> = [];
  public readonly finalizeCalls: EnterpriseUploadCapability[] = [];
  public readonly finalizeSignals: AbortSignal[] = [];
  public readonly abortCalls: EnterpriseUploadCapability[] = [];
  public prepareError: unknown;
  public appendError: unknown;
  public finalizeError: unknown;
  public abortError: unknown;
  public prepareResult: EnterpriseUploadCapability | undefined;
  public finalizeResult: EnterpriseUploadFinalizedTarget | undefined;
  public prepareGate: Promise<void> | undefined;
  public appendGate: Promise<void> | undefined;
  public finalizeGate: Promise<void> | undefined;
  public abortGate: Promise<void> | undefined;
  private nextCapability = 1;

  public async prepare(input: PrepareCall): Promise<EnterpriseUploadCapability> {
    this.prepareCalls.push(input);
    await this.prepareGate;
    if (this.prepareError !== undefined) throw this.prepareError;
    return (
      this.prepareResult ??
      capability({
        capabilityId: `safe-upload-capability-${this.nextCapability++}`,
        organizationId: input.workspace.organizationId,
        nodeId: input.workspace.nodeId,
        workspaceId: input.workspace.workspaceId,
        relativePath: input.relativePath,
      })
    );
  }

  public async append(
    input: EnterpriseUploadCapability,
    options: { readonly offset: number; readonly bytes: Uint8Array; readonly signal: AbortSignal },
  ): Promise<void> {
    this.appendCalls.push({
      capability: input,
      offset: options.offset,
      bytes: options.bytes,
      signal: options.signal,
    });
    await this.appendGate;
    if (this.appendError !== undefined) throw this.appendError;
  }

  public async finalize(
    input: EnterpriseUploadCapability,
    options: { readonly signal: AbortSignal },
  ): Promise<EnterpriseUploadFinalizedTarget> {
    this.finalizeCalls.push(input);
    this.finalizeSignals.push(options.signal);
    await this.finalizeGate;
    if (this.finalizeError !== undefined) throw this.finalizeError;
    return this.finalizeResult ?? finalizedTarget(input);
  }

  public async abort(input: EnterpriseUploadCapability): Promise<void> {
    this.abortCalls.push(input);
    await this.abortGate;
    if (this.abortError !== undefined) throw this.abortError;
  }
}

interface PolicyOptions {
  ttlMs?: number;
  capacity?: number;
  clock?: EnterpriseUploadClock;
  randomSource?: EnterpriseUploadRandomSource;
  authorization?: Pick<ResourceAuthorization, "assertWorkspace">;
  safeFs?: EnterpriseUploadSafeFsPort;
}

function createPolicy(options: PolicyOptions = {}): EnterpriseUploadPolicy {
  return new EnterpriseUploadPolicy({
    ttlMs: options.ttlMs ?? 60_000,
    capacity: options.capacity ?? 16,
    clock: options.clock ?? new TestClock(1_000),
    randomSource: options.randomSource ?? new IncrementingRandomSource(),
    authorization: options.authorization ?? createAuthorization(),
    safeFs: options.safeFs ?? new TestSafeFs(),
  });
}

function issueInput(
  overrides: Partial<EnterpriseUploadIssueInput> = {},
): EnterpriseUploadIssueInput {
  return {
    principal: overrides.principal ?? principal(),
    node: overrides.node ?? node(),
    sessionBindingGeneration: overrides.sessionBindingGeneration ?? SESSION_GENERATION,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    relativePath: overrides.relativePath ?? RELATIVE_PATH,
  };
}

function finalizeInput(
  uploadId: string,
  overrides: Partial<EnterpriseUploadFinalizeInput> = {},
): EnterpriseUploadFinalizeInput {
  return {
    uploadId,
    principal: overrides.principal ?? principal(),
    node: overrides.node ?? node(),
    sessionBindingGeneration: overrides.sessionBindingGeneration ?? SESSION_GENERATION,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    relativePath: overrides.relativePath ?? RELATIVE_PATH,
  };
}

function abortInput(
  uploadId: string,
  overrides: Partial<EnterpriseUploadAbortInput> = {},
): EnterpriseUploadAbortInput {
  return finalizeInput(uploadId, overrides);
}

function appendInput(
  uploadId: string,
  overrides: Partial<EnterpriseUploadAppendInput> = {},
): EnterpriseUploadAppendInput {
  return {
    ...finalizeInput(uploadId, overrides),
    offset: overrides.offset ?? 0,
    bytes: overrides.bytes ?? new Uint8Array([1, 2, 3]),
  };
}

async function expectPolicyError(
  promise: Promise<unknown>,
  code: EnterpriseUploadPolicyError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "EnterpriseUploadPolicyError",
    code,
  });
}

describe("EnterpriseUploadPolicy", () => {
  it("appends through the owned safe-FS capability and preserves the upload for finalize", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(policy.append(appendInput(issued.uploadId))).resolves.toBe(true);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.not.toBeNull();

    expect(safeFs.appendCalls).toHaveLength(1);
    expect(safeFs.appendCalls[0]).toMatchObject({ offset: 0 });
    expect(safeFs.appendCalls[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(safeFs.appendCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(safeFs.finalizeCalls).toHaveLength(1);
  });

  it("burns before append when session generation is wrong", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(
      policy.append(
        appendInput(issued.uploadId, { sessionBindingGeneration: OTHER_SESSION_GENERATION }),
      ),
    ).resolves.toBe(false);
    await expect(policy.append(appendInput(issued.uploadId))).resolves.toBe(false);

    expect(safeFs.appendCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("captures finalize and abort uploadId getters exactly once", async () => {
    const policy = createPolicy();
    for (const kind of ["finalize", "abort"] as const) {
      const issued = await policy.issue(issueInput());
      const base =
        kind === "finalize" ? finalizeInput(issued.uploadId) : abortInput(issued.uploadId);
      let reads = 0;
      Object.defineProperty(base, "uploadId", {
        configurable: true,
        get() {
          reads += 1;
          if (reads > 1) throw new Error("second read");
          return issued.uploadId;
        },
      });
      if (kind === "finalize") await expect(policy.finalize(base)).resolves.not.toBeNull();
      else await expect(policy.abort(base)).resolves.toBe(true);
      expect(reads).toBe(1);
    }
  });

  it.each(["finalize", "abort"] as const)(
    "fails closed when %s uploadId getter throws",
    async (kind) => {
      const safeFs = new TestSafeFs();
      const policy = createPolicy({ safeFs });
      const issued = await policy.issue(issueInput());
      const base =
        kind === "finalize" ? finalizeInput(issued.uploadId) : abortInput(issued.uploadId);
      Object.defineProperty(base, "uploadId", {
        configurable: true,
        get() {
          throw new Error("secret getter failure");
        },
      });
      if (kind === "finalize") await expect(policy.finalize(base)).resolves.toBeNull();
      else await expect(policy.abort(base)).resolves.toBe(false);
      expect(safeFs.finalizeCalls).toHaveLength(0);
      expect(safeFs.abortCalls).toHaveLength(0);
      if (kind === "finalize")
        await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.not.toBeNull();
      else await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(true);
    },
  );

  it("authorizes workspace.write before preparing safe-FS and issues only a canonical opaque ID", async () => {
    const order: string[] = [];
    const authorization = createAuthorization(async () => {
      order.push("authorization");
      return workspace();
    });
    const safeFs = new TestSafeFs();
    const originalPrepare = safeFs.prepare.bind(safeFs);
    safeFs.prepare = async (input) => {
      order.push("safe-fs");
      return originalPrepare(input);
    };
    const randomSource = new IncrementingRandomSource();
    const policy = createPolicy({ authorization, safeFs, randomSource });

    const issued = await policy.issue(issueInput());

    expect(order).toEqual(["authorization", "safe-fs", "authorization"]);
    expect(authorization.calls).toEqual([
      { principal: principal(), action: "workspace.write", workspaceId: WORKSPACE_ID },
      { principal: principal(), action: "workspace.write", workspaceId: WORKSPACE_ID },
    ]);
    expect(safeFs.prepareCalls[0]).toMatchObject({
      workspace: workspace(),
      relativePath: RELATIVE_PATH,
    });
    expect(safeFs.prepareCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(randomSource.requestedSizes).toEqual([32]);
    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "uploadId"]);
    expect(issued.uploadId).toHaveLength(43);
    expect(issued.uploadId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(61_000);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(authorization.calls[0]?.principal)).toBe(true);
    expect(Object.isFrozen(authorization.calls[0]?.principal.grants)).toBe(true);
    expect(Object.isFrozen(safeFs.prepareCalls[0])).toBe(true);
    expect(Object.isFrozen(safeFs.prepareCalls[0]?.workspace)).toBe(true);
  });

  it.each([
    ["empty generation", { sessionBindingGeneration: "" }],
    ["absolute path", { relativePath: "/etc/passwd" }],
    ["parent segment", { relativePath: "uploads/../secret" }],
    ["dot segment", { relativePath: "uploads/./file" }],
    ["backslash", { relativePath: "uploads\\file" }],
    ["empty segment", { relativePath: "uploads//file" }],
    ["NUL", { relativePath: "uploads/\0file" }],
  ])("strictly rejects %s before authorization", async (_label, overrides) => {
    const authorization = createAuthorization();
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ authorization, safeFs });

    await expectPolicyError(policy.issue(issueInput(overrides)), "upload_access_denied");

    expect(authorization.calls).toHaveLength(0);
    expect(safeFs.prepareCalls).toHaveLength(0);
  });

  it("re-authorizes after safe-FS prepare and releases on changed workspace identity", async () => {
    const safeFs = new TestSafeFs();
    const authorization = createAuthorization((_principal, _action, _workspaceId, callNumber) =>
      callNumber === 1 ? workspace() : workspace({ ownerPrincipalId: OTHER_PRINCIPAL_ID }),
    );
    const policy = createPolicy({ authorization, safeFs });

    await expectPolicyError(policy.issue(issueInput()), "upload_access_denied");

    expect(authorization.calls).toHaveLength(2);
    expect(safeFs.prepareCalls).toHaveLength(1);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("rejects requestId and caller authority fields at the public issue boundary", async () => {
    const authorization = createAuthorization();
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ authorization, safeFs });
    const input = {
      ...issueInput(),
      requestId: "caller-request-id",
      organizationId: OTHER_ORGANIZATION_ID,
      ownerPrincipalId: OTHER_PRINCIPAL_ID,
      cwd: "/caller/path",
    };

    await expectPolicyError(policy.issue(input), "upload_access_denied");

    expect(authorization.calls).toHaveLength(0);
    expect(safeFs.prepareCalls).toHaveLength(0);
  });

  it.each([
    ["organization", workspace({ organizationId: OTHER_ORGANIZATION_ID })],
    ["node", workspace({ nodeId: OTHER_NODE_ID })],
    ["workspace", workspace({ workspaceId: OTHER_WORKSPACE_ID })],
  ])("fails closed when authorization returns a different %s", async (_label, authorized) => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({
      authorization: createAuthorization(() => authorized),
      safeFs,
    });

    await expectPolicyError(policy.issue(issueInput()), "upload_access_denied");
    expect(safeFs.prepareCalls).toHaveLength(0);
  });

  it("fails closed on authorization failure, unavailable safe-FS, and prepare failure", async () => {
    const authorizationFailure = createPolicy({
      authorization: createAuthorization(() => {
        throw new Error("secret authorization failure");
      }),
    });
    await expectPolicyError(authorizationFailure.issue(issueInput()), "upload_access_denied");

    const unsupportedFs = new TestSafeFs();
    unsupportedFs.supportsDirectoryRelativeOperations = false;
    const unsupportedPolicy = createPolicy({ safeFs: unsupportedFs });
    await expectPolicyError(unsupportedPolicy.issue(issueInput()), "upload_access_denied");
    expect(unsupportedFs.prepareCalls).toHaveLength(0);

    const failingFs = new TestSafeFs();
    failingFs.prepareError = new Error("secret path failure");
    const failingPolicy = createPolicy({ safeFs: failingFs });
    await expectPolicyError(failingPolicy.issue(issueInput()), "upload_access_denied");
  });

  it("fails closed before authorization and prepare when safe-FS is not release ready", async () => {
    const authorization = createAuthorization();
    const safeFs = new TestSafeFs();
    safeFs.releaseReady = false;
    const policy = createPolicy({ authorization, safeFs });

    await expectPolicyError(policy.issue(issueInput()), "upload_access_denied");
    expect(authorization.calls).toEqual([]);
    expect(safeFs.prepareCalls).toEqual([]);
  });

  it.each([
    ["organization", { organizationId: OTHER_ORGANIZATION_ID }, 1, "upload_access_denied"],
    ["node", { nodeId: OTHER_NODE_ID }, 1, "upload_access_denied"],
    ["workspace", { workspaceId: OTHER_WORKSPACE_ID }, 1, "upload_access_denied"],
    ["relative path", { relativePath: OTHER_RELATIVE_PATH }, 1, "upload_access_denied"],
    [
      "invalid directory identity",
      { directoryIdentity: { dev: -1, ino: 22 } },
      0,
      "store_quarantined",
    ],
  ])(
    "rejects a safe-FS capability with mismatched %s",
    async (_label, overrides, expectedAbortCalls, expectedCode) => {
      const safeFs = new TestSafeFs();
      safeFs.prepareResult = capability(overrides as Partial<EnterpriseUploadCapability>);
      const policy = createPolicy({ safeFs });

      await expectPolicyError(
        policy.issue(issueInput()),
        expectedCode as EnterpriseUploadPolicyError["code"],
      );

      expect(safeFs.abortCalls).toHaveLength(expectedAbortCalls);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe TTL %s",
    (ttlMs) => {
      expect(() => createPolicy({ ttlMs })).toThrowError(EnterpriseUploadPolicyError);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects unsafe capacity %s", (capacity) => {
    expect(() => createPolicy({ capacity })).toThrowError(EnterpriseUploadPolicyError);
  });

  it("accepts the exported hard capacity maximum", () => {
    expect(() => createPolicy({ capacity: ENTERPRISE_UPLOAD_CAPACITY_HARD_MAX })).not.toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe clock value %s before preparing a capability",
    async (value) => {
      const safeFs = new TestSafeFs();
      const policy = createPolicy({ clock: new TestClock(value), safeFs });

      await expectPolicyError(policy.issue(issueInput()), "invalid_clock");

      expect(safeFs.abortCalls).toHaveLength(0);
    },
  );

  it("rejects clock rollback and expiry overflow without retaining prepared capabilities", async () => {
    const rollbackClock = new TestClock(1_000);
    const rollbackFs = new TestSafeFs();
    const rollbackPolicy = createPolicy({ clock: rollbackClock, safeFs: rollbackFs });
    await rollbackPolicy.issue(issueInput());
    rollbackClock.value = 999;
    await expectPolicyError(
      rollbackPolicy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
      "clock_rollback",
    );
    expect(rollbackFs.abortCalls).toHaveLength(0);

    const overflowFs = new TestSafeFs();
    const overflowPolicy = createPolicy({
      ttlMs: 2,
      clock: new TestClock(Number.MAX_SAFE_INTEGER),
      safeFs: overflowFs,
    });
    await expectPolicyError(overflowPolicy.issue(issueInput()), "expiry_overflow");
    expect(overflowFs.abortCalls).toHaveLength(1);
  });

  it.each([
    ["short", new Uint8Array(31)],
    ["long", new Uint8Array(33)],
    ["wrong type", Array.from({ length: 32 }, () => 1)],
  ])("rejects %s random output and releases the prepared capability", async (_label, bytes) => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({
      safeFs,
      randomSource: new SequenceRandomSource([bytes]),
    });

    await expectPolicyError(policy.issue(issueInput()), "invalid_random_bytes");

    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("bounds upload ID collision retries at three and releases the unused capability", async () => {
    const bytes = new Uint8Array(32).fill(7);
    const randomSource = new SequenceRandomSource([bytes, bytes, bytes, bytes]);
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ randomSource, safeFs });
    await policy.issue(issueInput());

    await expectPolicyError(
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
      "upload_id_collision",
    );

    expect(randomSource.requestedSizes).toEqual([32, 32, 32, 32]);
    expect(safeFs.abortCalls).toHaveLength(1);
    expect(safeFs.abortCalls[0]?.relativePath).toBe(OTHER_RELATIVE_PATH);
  });

  it("enforces capacity and prunes expired records through safe-FS abort before admitting more", async () => {
    const clock = new TestClock(1_000);
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ ttlMs: 10, capacity: 1, clock, safeFs });
    const first = await policy.issue(issueInput());

    await expectPolicyError(
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
      "capacity_exceeded",
    );
    expect(safeFs.abortCalls).toHaveLength(0);

    clock.value = first.expiresAt;
    const replacement = await policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH }));
    expect(replacement.uploadId).not.toBe(first.uploadId);
    expect(safeFs.abortCalls).toHaveLength(1);
    expect(safeFs.abortCalls[0]?.relativePath).toBe(RELATIVE_PATH);
  });

  it("reserves capacity before a blocked prepare so a second issue never reaches safe-FS", async () => {
    let releasePrepare!: () => void;
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const originalPrepare = safeFs.prepare.bind(safeFs);
    safeFs.prepare = async (input) => {
      markPrepareStarted();
      return originalPrepare(input);
    };
    const policy = createPolicy({ capacity: 1, safeFs });
    const first = policy.issue(issueInput());
    await prepareStarted;

    await expect(
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    expect(safeFs.prepareCalls).toHaveLength(1);
    releasePrepare();
    await expect(first).resolves.toMatchObject({ expiresAt: 61_000 });
  });

  it("counts a blocked finalize in capacity so a concurrent issue cannot prepare", async () => {
    let releaseFinalize!: () => void;
    let markFinalizeStarted!: () => void;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    const originalFinalize = safeFs.finalize.bind(safeFs);
    safeFs.finalize = async (input, options) => {
      markFinalizeStarted();
      return originalFinalize(input, options);
    };
    const policy = createPolicy({ capacity: 1, safeFs });
    const issued = await policy.issue(issueInput());
    const finalize = policy.finalize(finalizeInput(issued.uploadId));
    await finalizeStarted;

    await expect(
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    expect(safeFs.prepareCalls).toHaveLength(1);
    releaseFinalize();
    await expect(finalize).resolves.not.toBeNull();
  });

  it("gives a same-tick Promise.all reservation to exactly one issue", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ capacity: 1, safeFs });
    const outcomes = await Promise.allSettled([
      policy.issue(issueInput()),
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: "capacity_exceeded",
    });
    expect(safeFs.prepareCalls).toHaveLength(1);
  });

  it("finalizes once with an exact deeply frozen binding and no safe capability disclosure", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    const result = await policy.finalize(finalizeInput(issued.uploadId));

    expect(result).toEqual({
      uploadId: issued.uploadId,
      workspace: workspace(),
      relativePath: RELATIVE_PATH,
      fileIdentity: { dev: 11, ino: 23, size: 37, mtimeMs: 42.5 },
    });
    expect(result).not.toHaveProperty("capability");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.workspace)).toBe(true);
    expect(Object.isFrozen(result?.fileIdentity)).toBe(true);
    expect(safeFs.finalizeCalls).toHaveLength(1);
    expect(Object.isFrozen(safeFs.finalizeCalls[0])).toBe(true);
    expect(Object.isFrozen(safeFs.finalizeCalls[0]?.directoryIdentity)).toBe(true);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(false);
    expect(safeFs.finalizeCalls).toHaveLength(1);
  });

  it.each([
    [
      "authorization rejection",
      () => {
        throw new Error("revoked grant");
      },
    ],
    ["changed workspace owner", () => workspace({ ownerPrincipalId: OTHER_PRINCIPAL_ID })],
  ])("re-authorizes before finalize and burns on %s", async (_label, finalAuthorization) => {
    const safeFs = new TestSafeFs();
    const authorization = createAuthorization((_principal, _action, _workspaceId, callNumber) =>
      callNumber <= 2 ? workspace() : finalAuthorization(),
    );
    const policy = createPolicy({ authorization, safeFs });
    const issued = await policy.issue(issueInput());

    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(authorization.calls).toHaveLength(3);
    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it.each([
    ["organization", { principal: principal({ organizationId: OTHER_ORGANIZATION_ID }) }],
    ["node", { node: node({ nodeId: OTHER_NODE_ID }) }],
    ["server identity", { node: node({ paseoServerId: "server-two" }) }],
    ["node mode", { node: node({ mode: "managed" }) }],
    ["principal", { principal: principal({ principalId: OTHER_PRINCIPAL_ID }) }],
    ["credential", { principal: principal({ credentialId: OTHER_CREDENTIAL_ID }) }],
    ["grant version", { principal: principal({ grantVersion: OTHER_GRANT_VERSION }) }],
    ["session generation", { sessionBindingGeneration: OTHER_SESSION_GENERATION }],
    ["workspace", { workspaceId: OTHER_WORKSPACE_ID }],
    ["path", { relativePath: OTHER_RELATIVE_PATH }],
  ])("burns on wrong %s before finalizing", async (_label, overrides) => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(policy.finalize(finalizeInput(issued.uploadId, overrides))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("burns at the exact expiry boundary and on an invalid clock", async () => {
    const clock = new TestClock(1_000);
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ ttlMs: 10, clock, safeFs });
    const expired = await policy.issue(issueInput());
    clock.value = expired.expiresAt;
    await expect(policy.finalize(finalizeInput(expired.uploadId))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(expired.uploadId))).resolves.toBeNull();

    clock.value = Number.NaN;
    const secondPolicy = createPolicy({ clock, safeFs });
    clock.value = 2_000;
    const invalidClock = await secondPolicy.issue(issueInput());
    clock.value = Number.NaN;
    await expect(secondPolicy.finalize(finalizeInput(invalidClock.uploadId))).resolves.toBeNull();
    await expect(secondPolicy.finalize(finalizeInput(invalidClock.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(2);
  });

  it("burns on clock rollback before invoking finalize", async () => {
    const clock = new TestClock(1_000);
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ clock, safeFs });
    const issued = await policy.issue(issueInput());
    clock.value = 999;

    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it.each([
    ["capability", { capabilityId: "different-capability" }],
    ["organization", { organizationId: OTHER_ORGANIZATION_ID }],
    ["node", { nodeId: OTHER_NODE_ID }],
    ["workspace", { workspaceId: OTHER_WORKSPACE_ID }],
    ["path", { relativePath: OTHER_RELATIVE_PATH }],
    ["directory identity", { directoryIdentity: { dev: 11, ino: 999 } }],
  ])("burns when safe-FS finalization returns mismatched %s", async (_label, overrides) => {
    const safeFs = new TestSafeFs();
    const source = capability();
    safeFs.prepareResult = source;
    safeFs.finalizeResult = finalizedTarget(source, overrides as never);
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(1);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("burns and fails closed when the finalize port throws", async () => {
    const safeFs = new TestSafeFs();
    safeFs.finalizeError = new Error("secret finalization failure");
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(1);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("strictly rejects caller authority fields on finalize and burns the upload", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const input = {
      ...finalizeInput(issued.uploadId),
      requestId: "caller-request-id",
      ownerPrincipalId: OTHER_PRINCIPAL_ID,
      cwd: "/caller/path",
    };

    await expect(policy.finalize(input)).resolves.toBeNull();
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();

    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("clones finalize input before awaiting the safe-FS port", async () => {
    let release!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const input = { ...finalizeInput(issued.uploadId) };

    const pending = policy.finalize(input);
    input.uploadId = "mutated-upload-id";
    input.workspaceId = OTHER_WORKSPACE_ID;
    input.relativePath = OTHER_RELATIVE_PATH;
    input.sessionBindingGeneration = OTHER_SESSION_GENERATION;
    input.principal.organizationId = OTHER_ORGANIZATION_ID;
    input.node.nodeId = OTHER_NODE_ID;
    release();
    const result = await pending;

    expect(result?.uploadId).toBe(issued.uploadId);
    expect(result?.workspace.workspaceId).toBe(WORKSPACE_ID);
    expect(result?.relativePath).toBe(RELATIVE_PATH);
  });

  it("aborts once, burns before awaiting the port, and remains burned on port failure", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(true);
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(false);
    expect(safeFs.abortCalls).toHaveLength(1);

    const failingFs = new TestSafeFs();
    failingFs.abortError = new Error("secret abort failure");
    const failingPolicy = createPolicy({ safeFs: failingFs });
    const failing = await failingPolicy.issue(issueInput());
    await expectPolicyError(failingPolicy.abort(abortInput(failing.uploadId)), "cleanup_failed");
    await expect(failingPolicy.abort(abortInput(failing.uploadId))).resolves.toBe(false);
    await expectPolicyError(
      failingPolicy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
      "store_quarantined",
    );
    expect(failingFs.abortCalls).toHaveLength(1);
  });

  it("burns a wrong-context abort attempt while reporting no success", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(
      policy.abort(
        abortInput(issued.uploadId, {
          principal: principal({ credentialId: OTHER_CREDENTIAL_ID }),
        }),
      ),
    ).resolves.toBe(false);
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(false);

    expect(safeFs.abortCalls).toHaveLength(1);
    expect(safeFs.finalizeCalls).toHaveLength(0);
  });

  it("permits only one concurrent finalize", async () => {
    let release!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    const first = policy.finalize(finalizeInput(issued.uploadId));
    const second = policy.finalize(finalizeInput(issued.uploadId));
    release();
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(safeFs.finalizeCalls).toHaveLength(1);
  });

  it("permits only one concurrent finalize-or-abort operation", async () => {
    let release!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    const finalize = policy.finalize(finalizeInput(issued.uploadId));
    const abort = policy.abort(abortInput(issued.uploadId));
    release();
    const [finalized, aborted] = await Promise.all([finalize, abort]);

    expect(finalized).not.toBeNull();
    expect(aborted).toBe(false);
    expect(safeFs.finalizeCalls).toHaveLength(1);
    expect(safeFs.abortCalls).toHaveLength(0);
  });

  it("clones caller input before asynchronous authorization and safe-FS preparation", async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorization = createAuthorization(async () => {
      await authorizationGate;
      return workspace();
    });
    const safeFs = new TestSafeFs();
    const rawPrincipal = principal();
    const rawNode = node();
    const input = { ...issueInput({ principal: rawPrincipal, node: rawNode }) };
    const policy = createPolicy({ authorization, safeFs });

    const pending = policy.issue(input);
    rawPrincipal.organizationId = OTHER_ORGANIZATION_ID;
    rawPrincipal.credentialId = OTHER_CREDENTIAL_ID;
    rawPrincipal.grants[0]!.selector = { kind: "self" };
    rawNode.nodeId = OTHER_NODE_ID;
    input.workspaceId = OTHER_WORKSPACE_ID;
    input.relativePath = OTHER_RELATIVE_PATH;
    input.sessionBindingGeneration = OTHER_SESSION_GENERATION;
    releaseAuthorization();
    const issued = await pending;

    expect(authorization.calls[0]).toEqual({
      principal: principal(),
      action: "workspace.write",
      workspaceId: WORKSPACE_ID,
    });
    expect(safeFs.prepareCalls[0]).toMatchObject({
      workspace: workspace(),
      relativePath: RELATIVE_PATH,
    });
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.not.toBeNull();
  });

  it("isolates the stored capability and public result from port-owned mutation", async () => {
    const safeFs = new TestSafeFs();
    const portCapability = {
      ...capability(),
      directoryIdentity: { ...capability().directoryIdentity },
    };
    const portTarget = {
      ...finalizedTarget(portCapability),
      directoryIdentity: { ...portCapability.directoryIdentity },
      fileIdentity: { ...finalizedTarget(portCapability).fileIdentity },
    };
    safeFs.prepareResult = portCapability;
    safeFs.finalizeResult = portTarget;
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    portCapability.relativePath = OTHER_RELATIVE_PATH;
    portCapability.directoryIdentity.ino = 999;
    const result = await policy.finalize(finalizeInput(issued.uploadId));
    portTarget.fileIdentity.size = 999;
    portTarget.relativePath = OTHER_RELATIVE_PATH;

    expect(safeFs.finalizeCalls[0]).toMatchObject({
      relativePath: RELATIVE_PATH,
      directoryIdentity: { dev: 11, ino: 22 },
    });
    expect(result).toMatchObject({
      relativePath: RELATIVE_PATH,
      fileIdentity: { dev: 11, ino: 23, size: 37, mtimeMs: 42.5 },
    });
  });

  const cleanupCases: readonly {
    label: string;
    scope: EnterpriseUploadCleanupInput;
    otherIssue: Partial<EnterpriseUploadIssueInput>;
  }[] = [
    {
      label: "Session close",
      scope: {
        reason: "session-closed",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
        grantVersion: GRANT_VERSION,
        sessionBindingGeneration: SESSION_GENERATION,
      },
      otherIssue: { sessionBindingGeneration: OTHER_SESSION_GENERATION },
    },
    {
      label: "generation replacement",
      scope: {
        reason: "generation-replaced",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
        grantVersion: GRANT_VERSION,
        sessionBindingGeneration: SESSION_GENERATION,
      },
      otherIssue: { sessionBindingGeneration: OTHER_SESSION_GENERATION },
    },
    {
      label: "credential revoke",
      scope: {
        reason: "credential-revoked",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
      },
      otherIssue: { principal: principal({ credentialId: OTHER_CREDENTIAL_ID }) },
    },
    {
      label: "principal logout",
      scope: {
        reason: "principal-logout",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalId: PRINCIPAL_ID,
      },
      otherIssue: { principal: principal({ principalId: OTHER_PRINCIPAL_ID }) },
    },
  ];

  it.each(cleanupCases)(
    "$label cleanup burns only the exact scope",
    async ({ scope, otherIssue }) => {
      const safeFs = new TestSafeFs();
      const policy = createPolicy({ safeFs });
      const matching = await policy.issue(issueInput());
      const survivorInput = issueInput({ ...otherIssue, relativePath: OTHER_RELATIVE_PATH });
      const survivor = await policy.issue(survivorInput);

      const cleaned = await policy.cleanup(scope);

      expect(cleaned).toEqual({ cleaned: 1 });
      expect(Object.isFrozen(cleaned)).toBe(true);
      expect(safeFs.abortCalls).toHaveLength(1);
      await expect(policy.finalize(finalizeInput(matching.uploadId))).resolves.toBeNull();
      await expect(
        policy.finalize(finalizeInput(survivor.uploadId, survivorInput)),
      ).resolves.not.toBeNull();
    },
  );

  it("cleanup attempts every scoped abort, reports a fixed error, and leaves all records burned", async () => {
    const safeFs = new TestSafeFs();
    safeFs.abortError = new Error("secret cleanup failure");
    const policy = createPolicy({ safeFs });
    const first = await policy.issue(issueInput());
    const second = await policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH }));
    const scope: EnterpriseUploadCleanupInput = {
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
    };

    await expectPolicyError(policy.cleanup(scope), "cleanup_failed");

    expect(safeFs.abortCalls).toHaveLength(2);
    await expect(policy.finalize(finalizeInput(first.uploadId))).resolves.toBeNull();
    await expect(
      policy.finalize(finalizeInput(second.uploadId, { relativePath: OTHER_RELATIVE_PATH })),
    ).resolves.toBeNull();
  });

  it("strictly rejects an invalid cleanup scope without burning records", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const scope = {
      reason: "principal-logout" as const,
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
    };

    await expectPolicyError(policy.cleanup(scope), "invalid_cleanup_scope");

    expect(safeFs.abortCalls).toHaveLength(0);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.not.toBeNull();
  });

  it("cleanup invalidates an in-flight issue and releases its prepared capability", async () => {
    let releasePrepare!: () => void;
    let markPrepareStarted!: () => void;
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const originalPrepare = safeFs.prepare.bind(safeFs);
    safeFs.prepare = async (input) => {
      markPrepareStarted();
      return originalPrepare(input);
    };
    const policy = createPolicy({ safeFs });
    const pending = policy.issue(issueInput());
    await prepareStarted;
    expect(safeFs.prepareCalls).toHaveLength(1);

    const cleanup = policy.cleanup({
      reason: "session-closed",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      credentialId: CREDENTIAL_ID,
      grantVersion: GRANT_VERSION,
      sessionBindingGeneration: SESSION_GENERATION,
    });
    expect(safeFs.prepareCalls[0]?.signal.aborted).toBe(true);
    releasePrepare();

    await expectPolicyError(pending, "upload_access_denied");
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("cleanup invalidates an in-flight append before it can restore the capability", async () => {
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const originalAppend = safeFs.append.bind(safeFs);
    safeFs.append = async (input, options) => {
      markAppendStarted();
      return originalAppend(input, options);
    };
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const append = policy.append(appendInput(issued.uploadId));
    await appendStarted;

    const cleanup = policy.cleanup({
      reason: "generation-replaced",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      credentialId: CREDENTIAL_ID,
      grantVersion: GRANT_VERSION,
      sessionBindingGeneration: SESSION_GENERATION,
    });
    expect(safeFs.appendCalls[0]?.signal.aborted).toBe(true);
    releaseAppend();

    await expect(append).resolves.toBe(false);
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    expect(safeFs.abortCalls).toHaveLength(1);
  });

  it("gates a cleanup in progress so a new issue cannot publish", async () => {
    let releaseAbort!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const cleanup = policy.cleanup({
      reason: "session-closed",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      credentialId: CREDENTIAL_ID,
      grantVersion: GRANT_VERSION,
      sessionBindingGeneration: SESSION_GENERATION,
    });

    await expect(
      policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH })),
    ).rejects.toMatchObject({ code: "upload_access_denied" });
    expect(safeFs.prepareCalls).toHaveLength(1);
    releaseAbort();
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
  });

  it("invalidates later cleanup targets synchronously while an earlier cleanup is blocked", async () => {
    let releaseAbort!: () => void;
    let releaseFinalize!: () => void;
    let markFinalizeStarted!: () => void;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    const originalFinalize = safeFs.finalize.bind(safeFs);
    safeFs.finalize = async (input, options) => {
      markFinalizeStarted();
      return originalFinalize(input, options);
    };
    const policy = createPolicy({ safeFs });
    const first = await policy.issue(issueInput());
    const secondInput = issueInput({ principal: principal({ principalId: OTHER_PRINCIPAL_ID }) });
    const second = await policy.issue(secondInput);
    const finalize = policy.finalize(finalizeInput(second.uploadId, secondInput));
    await finalizeStarted;

    const cleanupFirst = policy.cleanup({
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
    });
    const cleanupSecond = policy.cleanup({
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: OTHER_PRINCIPAL_ID,
    });
    expect(safeFs.finalizeSignals[0]?.aborted).toBe(true);
    releaseAbort();
    releaseFinalize();

    await expect(finalize).resolves.toBeNull();
    await expect(cleanupFirst).resolves.toEqual({ cleaned: 1 });
    await expect(cleanupSecond).resolves.toEqual({ cleaned: 1 });
    await expect(policy.finalize(finalizeInput(first.uploadId))).resolves.toBeNull();
  });

  it("rejects finalize and abort after cleanup is called before either can start a port", async () => {
    let releaseAbort!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const cleanup = policy.cleanup({
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
    });

    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(false);
    expect(safeFs.finalizeCalls).toHaveLength(0);
    expect(safeFs.abortCalls).toHaveLength(1);
    releaseAbort();
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
  });

  it("serializes close behind blocked cleanup and keeps new operations from starting", async () => {
    let releaseAbort!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const cleanup = policy.cleanup({
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
    });
    const close = policy.close();
    let settled = false;
    void close.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(policy.abort(abortInput(issued.uploadId))).resolves.toBe(false);
    expect(safeFs.finalizeCalls).toHaveLength(0);
    releaseAbort();
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    await expect(close).resolves.toEqual({ cleaned: 0 });
    expect(settled).toBe(true);
  });

  it("aborts an in-flight finalize when close queues behind blocked cleanup", async () => {
    let releaseAbort!: () => void;
    let releaseFinalize!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    const policy = createPolicy({ safeFs });
    const first = await policy.issue(issueInput());
    const secondInput = issueInput({ principal: principal({ principalId: OTHER_PRINCIPAL_ID }) });
    const second = await policy.issue(secondInput);
    const finalize = policy.finalize(finalizeInput(second.uploadId, secondInput));
    for (let attempt = 0; attempt < 5 && safeFs.finalizeSignals.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(safeFs.finalizeSignals[0]?.aborted).toBe(false);
    const cleanup = policy.cleanup({
      reason: "principal-logout",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
    });
    const close = policy.close();
    let settled = false;
    void close.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(safeFs.finalizeSignals[0]?.aborted).toBe(true);
    expect(settled).toBe(false);
    await expect(policy.finalize(finalizeInput(first.uploadId))).resolves.toBeNull();
    await expect(policy.abort(abortInput(first.uploadId))).resolves.toBe(false);
    expect(safeFs.finalizeCalls).toHaveLength(1);
    expect(safeFs.abortCalls).toHaveLength(1);
    releaseAbort();
    releaseFinalize();
    await expect(finalize).resolves.toBeNull();
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    await expect(close).resolves.toEqual({ cleaned: 1 });
    expect(settled).toBe(true);
  });

  it("shares a blocked close promise, aborts exactly once, and retries quarantined cleanup", async () => {
    let releaseAbort!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const policy = createPolicy({ safeFs });
    await policy.issue(issueInput());
    const firstClose = policy.close();
    const secondClose = policy.close();
    expect(secondClose).toBe(firstClose);
    await Promise.resolve();
    expect(safeFs.abortCalls).toHaveLength(1);
    releaseAbort();
    await expect(firstClose).resolves.toEqual({ cleaned: 1 });
    await expect(secondClose).resolves.toEqual({ cleaned: 1 });

    const failingFs = new TestSafeFs();
    failingFs.abortError = new Error("blocked close release");
    const failing = createPolicy({ safeFs: failingFs });
    await failing.issue(issueInput());
    const failedFirst = failing.close();
    const failedSecond = failing.close();
    expect(failedSecond).toBe(failedFirst);
    await expect(failedFirst).rejects.toMatchObject({ code: "cleanup_failed" });
    await expect(failedSecond).rejects.toMatchObject({ code: "cleanup_failed" });
    failingFs.abortError = undefined;
    await expect(failing.close()).resolves.toEqual({ cleaned: 1 });
    expect(failingFs.abortCalls).toHaveLength(2);
  });

  it("does not publish when cleanup crosses a blocked expiry-prune abort", async () => {
    let releaseAbort!: () => void;
    const safeFs = new TestSafeFs();
    safeFs.abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const clock = new TestClock(1_000);
    const policy = createPolicy({ ttlMs: 10, clock, safeFs });
    await policy.issue(issueInput());
    clock.value = 1_010;

    const pendingIssue = policy.issue(issueInput({ relativePath: OTHER_RELATIVE_PATH }));
    await Promise.resolve();
    await Promise.resolve();
    expect(safeFs.abortCalls).toHaveLength(1);
    const cleanup = policy.cleanup({
      reason: "session-closed",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      credentialId: CREDENTIAL_ID,
      grantVersion: GRANT_VERSION,
      sessionBindingGeneration: SESSION_GENERATION,
    });
    releaseAbort();

    await expectPolicyError(pendingIssue, "upload_access_denied");
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    expect(safeFs.prepareCalls).toHaveLength(1);
  });

  it("re-authorizes after a blocked finalize and rejects a grant revoked before publish", async () => {
    let revoke = false;
    const authorization = createAuthorization((_principal, _action, _workspaceId, callNumber) => {
      if (revoke && callNumber >= 4) throw new Error("revoked grant");
      return workspace();
    });
    let releaseFinalize!: () => void;
    let markFinalizeStarted!: () => void;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    const originalFinalize = safeFs.finalize.bind(safeFs);
    safeFs.finalize = async (input, options) => {
      markFinalizeStarted();
      return originalFinalize(input, options);
    };
    const policy = createPolicy({ authorization, safeFs });
    const issued = await policy.issue(issueInput());
    const finalize = policy.finalize(finalizeInput(issued.uploadId));
    await finalizeStarted;
    revoke = true;
    releaseFinalize();

    await expect(finalize).resolves.toBeNull();
    expect(authorization.calls).toHaveLength(4);
    expect(safeFs.abortCalls).toHaveLength(1);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
  });

  it("freezes the port target before deferred post-finalize authorization", async () => {
    let releasePostAuth!: () => void;
    let markPostAuthStarted!: () => void;
    const postAuthStarted = new Promise<void>((resolve) => {
      markPostAuthStarted = resolve;
    });
    const authorization = createAuthorization(
      async (_principal, _action, _workspaceId, callNumber) => {
        if (callNumber === 4) {
          markPostAuthStarted();
          await new Promise<void>((resolve) => {
            releasePostAuth = resolve;
          });
        }
        return workspace();
      },
    );
    const safeFs = new TestSafeFs();
    const source = capability({ capabilityId: "capability-target" });
    const target = {
      ...finalizedTarget(source),
      directoryIdentity: { ...source.directoryIdentity },
      fileIdentity: { ...finalizedTarget(source).fileIdentity },
    };
    safeFs.prepareResult = source;
    safeFs.finalizeResult = target;
    const policy = createPolicy({ authorization, safeFs });
    const issued = await policy.issue(issueInput());
    const pending = policy.finalize(finalizeInput(issued.uploadId));
    await postAuthStarted;

    target.capabilityId = "mutated-capability";
    target.relativePath = OTHER_RELATIVE_PATH;
    target.directoryIdentity.ino = 999;
    target.fileIdentity.size = 999;
    releasePostAuth();
    const result = await pending;

    expect(result).toMatchObject({
      uploadId: issued.uploadId,
      relativePath: RELATIVE_PATH,
      fileIdentity: { dev: 11, ino: 23, size: 37, mtimeMs: 42.5 },
    });
  });

  it("fails closed and aborts a target with an extra field or changing getter", async () => {
    for (const target of [
      Object.assign(finalizedTarget(capability()), { unexpected: true }),
      Object.defineProperty(finalizedTarget(capability()), "capabilityId", {
        configurable: true,
        get() {
          throw new Error("changing target getter");
        },
      }),
    ]) {
      const safeFs = new TestSafeFs();
      safeFs.finalizeResult = target;
      const policy = createPolicy({ safeFs });
      const issued = await policy.issue(issueInput());
      await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
      expect(safeFs.abortCalls).toHaveLength(1);
    }
  });

  it("cleanup invalidates a blocked finalize, waits for its late result, and burns without publishing", async () => {
    let releaseFinalize!: () => void;
    let markFinalizeStarted!: () => void;
    const finalizeStarted = new Promise<void>((resolve) => {
      markFinalizeStarted = resolve;
    });
    const safeFs = new TestSafeFs();
    safeFs.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    const originalFinalize = safeFs.finalize.bind(safeFs);
    safeFs.finalize = async (input, options) => {
      markFinalizeStarted();
      return originalFinalize(input, options);
    };
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());
    const finalize = policy.finalize(finalizeInput(issued.uploadId));
    await finalizeStarted;

    const cleanup = policy.cleanup({
      reason: "session-closed",
      organizationId: ORGANIZATION_ID,
      node: node(),
      principalId: PRINCIPAL_ID,
      credentialId: CREDENTIAL_ID,
      grantVersion: GRANT_VERSION,
      sessionBindingGeneration: SESSION_GENERATION,
    });
    expect(safeFs.finalizeSignals[0]?.aborted).toBe(true);
    releaseFinalize();

    await expect(finalize).resolves.toBeNull();
    await expect(cleanup).resolves.toEqual({ cleaned: 1 });
    expect(safeFs.abortCalls).toHaveLength(1);
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
  });

  it("does not let a same-nodeId cleanup scope cross daemon identity", async () => {
    const safeFs = new TestSafeFs();
    const policy = createPolicy({ safeFs });
    const issued = await policy.issue(issueInput());

    await expect(
      policy.cleanup({
        reason: "principal-logout",
        organizationId: ORGANIZATION_ID,
        node: node({ paseoServerId: "server-two" }),
        principalId: PRINCIPAL_ID,
      }),
    ).resolves.toEqual({ cleaned: 0 });
    await expect(policy.finalize(finalizeInput(issued.uploadId))).resolves.not.toBeNull();
    expect(safeFs.abortCalls).toHaveLength(0);
  });

  it("snapshots dependency methods and capability support at construction", async () => {
    const authorization = createAuthorization();
    const safeFs = new TestSafeFs();
    const clock: EnterpriseUploadClock = { now: () => 1_000 };
    const randomSource: EnterpriseUploadRandomSource = {
      randomBytes: (size) => new Uint8Array(size).fill(9),
    };
    const policy = createPolicy({ authorization, safeFs, clock, randomSource });

    authorization.assertWorkspace = async () => {
      throw new Error("replaced authorization");
    };
    safeFs.supportsDirectoryRelativeOperations = false;
    safeFs.prepare = async () => {
      throw new Error("replaced prepare");
    };
    clock.now = () => Number.NaN;
    randomSource.randomBytes = () => new Uint8Array(1);

    await expect(policy.issue(issueInput())).resolves.toMatchObject({ expiresAt: 61_000 });
  });

  it("a new policy instance has no access to another instance's upload IDs", async () => {
    const sourceFs = new TestSafeFs();
    const source = createPolicy({ safeFs: sourceFs });
    const issued = await source.issue(issueInput());
    const freshFs = new TestSafeFs();
    const fresh = createPolicy({ safeFs: freshFs });

    await expect(fresh.finalize(finalizeInput(issued.uploadId))).resolves.toBeNull();
    await expect(fresh.abort(abortInput(issued.uploadId))).resolves.toBe(false);

    expect(freshFs.finalizeCalls).toHaveLength(0);
    expect(freshFs.abortCalls).toHaveLength(0);
  });
});
