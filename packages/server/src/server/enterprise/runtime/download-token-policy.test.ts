import type {
  AuthorizedWorkspace,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_TOKEN_CAPACITY_HARD_MAX,
  DownloadTokenPolicy,
  DownloadTokenPolicyError,
  type DownloadTokenCleanupScope,
  type DownloadFileIdentity,
  type DownloadTokenBinding,
  type DownloadTokenClock,
  type DownloadTokenConsumeInput,
  type DownloadTokenRandomSource,
  type DownloadTokenResolveInput,
  type DownloadTokenResolvedTarget,
  type DownloadTokenResolver,
} from "./download-token-policy.js";

const ORGANIZATION_ID = "org_0123456789abcdef";
const OTHER_ORGANIZATION_ID = "org_fedcba9876543210";
const NODE_ID = "nod_0123456789abcdef";
const OTHER_NODE_ID = "nod_fedcba9876543210";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const OTHER_PRINCIPAL_ID = "usr_fedcba9876543210";
const SERVICE_PRINCIPAL_ID = "svc_0123456789abcdef";
const CREDENTIAL_ID = "credential-one";
const OTHER_CREDENTIAL_ID = "credential-two";
const GRANT_VERSION = "grant-version-one";
const OTHER_GRANT_VERSION = "grant-version-two";
const SESSION_GENERATION = "session-generation-one";
const OTHER_SESSION_GENERATION = "session-generation-two";
const WORKSPACE_ID = "workspace-one";
const OTHER_WORKSPACE_ID = "workspace-two";
const RELATIVE_PATH = "reports/quarter.csv";
const OTHER_RELATIVE_PATH = "reports/other.csv";

const FILE_IDENTITY: DownloadFileIdentity = {
  dev: 11,
  ino: 22,
  size: 33,
  mtimeMs: 44.5,
};

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
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

function servicePrincipal(): PrincipalContext {
  return {
    principalType: "service",
    principalId: SERVICE_PRINCIPAL_ID,
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    grantVersion: GRANT_VERSION,
    grants: principal().grants,
  };
}

function node(
  nodeId = NODE_ID,
  paseoServerId = "server-one",
  mode: NodeContext["mode"] = "standalone",
): NodeContext {
  return {
    nodeId,
    paseoServerId,
    mode,
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

interface TargetOverrides {
  workspace?: AuthorizedWorkspace;
  fileIdentity?: DownloadFileIdentity;
}

function target(overrides: TargetOverrides = {}): DownloadTokenResolvedTarget {
  return {
    workspace: overrides.workspace ?? workspace(),
    fileIdentity: overrides.fileIdentity ?? { ...FILE_IDENTITY },
  };
}

type ResolverHandler = (
  input: DownloadTokenResolveInput,
  callNumber: number,
) => DownloadTokenResolvedTarget | Promise<DownloadTokenResolvedTarget>;

interface TestResolver extends DownloadTokenResolver {
  readonly calls: DownloadTokenResolveInput[];
}

function createResolver(handler: ResolverHandler = () => target()): TestResolver {
  const calls: DownloadTokenResolveInput[] = [];
  return {
    calls,
    async resolve(input) {
      calls.push(input);
      return handler(input, calls.length);
    },
  };
}

class TestClock implements DownloadTokenClock {
  public constructor(public value: number) {}

  public now(): number {
    return this.value;
  }
}

class IncrementingRandomSource implements DownloadTokenRandomSource {
  public readonly requestedSizes: number[] = [];
  private nextByte = 1;

  public randomBytes(size: number): Uint8Array {
    this.requestedSizes.push(size);
    const bytes = new Uint8Array(size);
    bytes.fill(this.nextByte);
    this.nextByte += 1;
    return bytes;
  }
}

class SequenceRandomSource implements DownloadTokenRandomSource {
  public readonly requestedSizes: number[] = [];

  public constructor(private readonly sequence: readonly Uint8Array[]) {}

  public randomBytes(size: number): Uint8Array {
    this.requestedSizes.push(size);
    const bytes = this.sequence[this.requestedSizes.length - 1];
    if (!bytes) {
      throw new Error("Test random sequence exhausted");
    }
    return bytes;
  }
}

interface PolicyOptions {
  ttlMs?: number;
  capacity?: number;
  clock?: DownloadTokenClock;
  randomSource?: DownloadTokenRandomSource;
  resolver?: DownloadTokenResolver;
}

function createPolicy(options: PolicyOptions = {}): DownloadTokenPolicy {
  return new DownloadTokenPolicy({
    ttlMs: options.ttlMs ?? 60_000,
    capacity: options.capacity ?? 8,
    clock: options.clock ?? new TestClock(1_000),
    randomSource: options.randomSource ?? new IncrementingRandomSource(),
    resolver: options.resolver ?? createResolver(),
  });
}

function issueInput() {
  return {
    principal: principal(),
    node: node(),
    sessionBindingGeneration: SESSION_GENERATION,
    workspaceId: WORKSPACE_ID,
    relativePath: RELATIVE_PATH,
  };
}

function cleanupScope(
  kind: DownloadTokenCleanupScope["kind"],
  input = issueInput(),
): DownloadTokenCleanupScope {
  const base = {
    organizationId: input.principal.organizationId,
    node: input.node,
    principalType: input.principal.principalType,
    principalId: input.principal.principalId,
  };
  if (kind === "principal") return { kind, ...base };
  if (kind === "credential") {
    return { kind, ...base, credentialId: input.principal.credentialId };
  }
  if (kind === "grant") return { kind, ...base, grantVersion: input.principal.grantVersion };
  return {
    kind,
    ...base,
    credentialId: input.principal.credentialId,
    grantVersion: input.principal.grantVersion,
    sessionBindingGeneration: input.sessionBindingGeneration,
  };
}

interface ConsumeOverrides {
  principal?: PrincipalContext;
  node?: NodeContext;
  workspaceId?: string;
  relativePath?: string;
  sessionBindingGeneration?: string;
}

function consumeInput(token: string, overrides: ConsumeOverrides = {}): DownloadTokenConsumeInput {
  return {
    token,
    principal: overrides.principal ?? principal(),
    node: overrides.node ?? node(),
    sessionBindingGeneration: overrides.sessionBindingGeneration ?? SESSION_GENERATION,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    relativePath: overrides.relativePath ?? RELATIVE_PATH,
  };
}

function expectedBinding(expiresAt: number): DownloadTokenBinding {
  return {
    organizationId: ORGANIZATION_ID,
    node: node(),
    principalType: "human",
    principalId: PRINCIPAL_ID,
    credentialId: CREDENTIAL_ID,
    grantVersion: GRANT_VERSION,
    sessionBindingGeneration: SESSION_GENERATION,
    workspace: workspace(),
    relativePath: RELATIVE_PATH,
    fileIdentity: FILE_IDENTITY,
    expiresAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface CleanupMatrixTokens {
  readonly base: string;
  readonly otherSession: string;
  readonly otherCredential: string;
  readonly otherGrant: string;
  readonly otherNode: string;
  readonly otherPaseoServer: string;
  readonly otherNodeMode: string;
  readonly otherPrincipal: string;
  readonly otherPrincipalType: string;
  readonly otherOrganization: string;
}

function createCleanupScopePolicy(): DownloadTokenPolicy {
  return createPolicy({
    capacity: 16,
    resolver: createResolver((input) =>
      target({
        workspace: workspace({
          organizationId: input.principal.organizationId,
          nodeId: input.node.nodeId,
          workspaceId: input.workspaceId,
        }),
      }),
    ),
  });
}

async function issueCleanupMatrix(policy: DownloadTokenPolicy): Promise<CleanupMatrixTokens> {
  const base = await policy.issue(issueInput());
  const otherSession = await policy.issue({
    ...issueInput(),
    sessionBindingGeneration: OTHER_SESSION_GENERATION,
  });
  const otherCredential = await policy.issue({
    ...issueInput(),
    principal: principal({ credentialId: OTHER_CREDENTIAL_ID }),
  });
  const otherGrant = await policy.issue({
    ...issueInput(),
    principal: principal({ grantVersion: OTHER_GRANT_VERSION }),
  });
  const otherNode = await policy.issue({ ...issueInput(), node: node(OTHER_NODE_ID) });
  const otherPaseoServer = await policy.issue({
    ...issueInput(),
    node: node(NODE_ID, "server-two"),
  });
  const otherNodeMode = await policy.issue({
    ...issueInput(),
    node: node(NODE_ID, "server-one", "managed"),
  });
  const otherPrincipal = await policy.issue({
    ...issueInput(),
    principal: principal({ principalId: OTHER_PRINCIPAL_ID }),
  });
  const otherPrincipalType = await policy.issue({
    ...issueInput(),
    principal: servicePrincipal(),
  });
  const otherOrganization = await policy.issue({
    ...issueInput(),
    principal: principal({ organizationId: OTHER_ORGANIZATION_ID }),
  });
  return {
    base: base.token,
    otherSession: otherSession.token,
    otherCredential: otherCredential.token,
    otherGrant: otherGrant.token,
    otherNode: otherNode.token,
    otherPaseoServer: otherPaseoServer.token,
    otherNodeMode: otherNodeMode.token,
    otherPrincipal: otherPrincipal.token,
    otherPrincipalType: otherPrincipalType.token,
    otherOrganization: otherOrganization.token,
  };
}

async function expectPolicyError(
  promise: Promise<unknown>,
  code: DownloadTokenPolicyError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "DownloadTokenPolicyError",
    code,
  });
}

describe("DownloadTokenPolicy", () => {
  it("captures and binds the resolver once before caller mutation", async () => {
    interface StatefulResolver extends DownloadTokenResolver {
      calls: number;
    }

    const original: StatefulResolver = {
      calls: 0,
      async resolve() {
        this.calls += 1;
        return target();
      },
    };
    const replacement: StatefulResolver = {
      calls: 0,
      async resolve() {
        this.calls += 1;
        throw new Error("replacement resolver must not run");
      },
    };
    let selectedResolver: DownloadTokenResolver = original;
    let resolverReads = 0;
    const policy = new DownloadTokenPolicy({
      ttlMs: 60_000,
      capacity: 1,
      get resolver() {
        resolverReads += 1;
        return selectedResolver;
      },
      clock: new TestClock(1_000),
      randomSource: new IncrementingRandomSource(),
    });

    selectedResolver = replacement;
    original.resolve = replacement.resolve;
    const issued = await policy.issue(issueInput());
    await expect(policy.consume(consumeInput(issued.token))).resolves.toEqual(
      expectedBinding(61_000),
    );
    expect(resolverReads).toBe(1);
    expect(original.calls).toBe(2);
    expect(replacement.calls).toBe(0);
  });

  it.each(["resolver", "resolve"] as const)(
    "fails construction when the %s getter throws without reading later dependencies",
    (boundary) => {
      const failure = new Error(`${boundary} getter failed`);
      let resolverReads = 0;
      let resolveReads = 0;
      let clockReads = 0;
      let randomReads = 0;
      const throwingResolver = Object.defineProperty({}, "resolve", {
        get(): DownloadTokenResolver["resolve"] {
          resolveReads += 1;
          throw failure;
        },
      }) as DownloadTokenResolver;
      const options = {
        ttlMs: 1,
        capacity: 1,
        get resolver(): DownloadTokenResolver {
          resolverReads += 1;
          if (boundary === "resolver") throw failure;
          return throwingResolver;
        },
        get clock(): DownloadTokenClock {
          clockReads += 1;
          return new TestClock(0);
        },
        get randomSource(): DownloadTokenRandomSource {
          randomReads += 1;
          return new IncrementingRandomSource();
        },
      };

      expect(() => new DownloadTokenPolicy(options)).toThrow(failure);
      expect(resolverReads).toBe(1);
      expect(resolveReads).toBe(boundary === "resolve" ? 1 : 0);
      expect(clockReads).toBe(0);
      expect(randomReads).toBe(0);
    },
  );

  it("parses authenticated context before resolving and issues only a canonical token and expiry", async () => {
    const resolver = createResolver();
    const randomSource = new IncrementingRandomSource();
    const rawPrincipal = { ...principal(), untrustedActor: OTHER_PRINCIPAL_ID };
    const rawNode = { ...node(), untrustedNode: OTHER_NODE_ID };
    const policy = createPolicy({ resolver, randomSource });

    const issued = await policy.issue({
      principal: rawPrincipal,
      node: rawNode,
      sessionBindingGeneration: SESSION_GENERATION,
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    });

    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "token"]);
    expect(issued.token).toHaveLength(43);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(61_000);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(randomSource.requestedSizes).toEqual([32]);
    expect(resolver.calls).toHaveLength(1);

    const resolverInput = resolver.calls[0];
    expect(resolverInput).toEqual(issueInput());
    if (!resolverInput) {
      throw new Error("Resolver was not called");
    }
    expect(Object.hasOwn(resolverInput, "token")).toBe(false);
    expect(Object.isFrozen(resolverInput)).toBe(true);
    expect(Object.isFrozen(resolverInput.principal)).toBe(true);
    expect(Object.isFrozen(resolverInput.principal.grants)).toBe(true);
    expect(Object.isFrozen(resolverInput.node)).toBe(true);
  });

  it("binds principal type and the complete node context in the returned capability", async () => {
    const resolver = createResolver((input) =>
      target({ workspace: workspace({ nodeId: input.node.nodeId }) }),
    );
    const policy = createPolicy({ resolver });
    const input = {
      ...issueInput(),
      principal: servicePrincipal(),
      node: node(NODE_ID, "managed-server", "managed"),
    };
    const issued = await policy.issue(input);

    await expect(policy.consume({ ...input, token: issued.token })).resolves.toMatchObject({
      principalType: "service",
      principalId: SERVICE_PRINCIPAL_ID,
      node: input.node,
    });
  });

  it.each([
    {
      label: "PrincipalContext",
      input: { ...issueInput(), principal: principal({ principalId: "attacker" }) },
    },
    {
      label: "NodeContext",
      input: { ...issueInput(), node: node("node-one") },
    },
  ])("rejects an invalid runtime $label before calling the resolver", async (row) => {
    const resolver = createResolver();
    const randomSource = new IncrementingRandomSource();
    const policy = createPolicy({ resolver, randomSource });

    await expect(policy.issue(row.input)).rejects.toMatchObject({ name: "ZodError" });
    expect(resolver.calls).toEqual([]);
    expect(randomSource.requestedSizes).toEqual([]);
  });

  it("burns a token before rejecting an invalid runtime context", async () => {
    const resolver = createResolver();
    const policy = createPolicy({ resolver });
    const issued = await policy.issue(issueInput());

    await expect(
      policy.consume(
        consumeInput(issued.token, { principal: principal({ principalId: "attacker" }) }),
      ),
    ).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
  });

  it("reads the token getter once and burns before another getter throws", async () => {
    const resolver = createResolver();
    const policy = createPolicy({ resolver });
    const issued = await policy.issue(issueInput());
    const input = consumeInput(issued.token);
    let tokenReads = 0;
    Object.defineProperty(input, "token", {
      get() {
        tokenReads += 1;
        return issued.token;
      },
    });
    Object.defineProperty(input, "workspaceId", {
      get() {
        throw new Error("throwing getter");
      },
    });

    await expect(policy.consume(input)).resolves.toBeNull();
    expect(tokenReads).toBe(1);
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
  });

  it.each([
    {
      label: "organization",
      override: { principal: principal({ organizationId: OTHER_ORGANIZATION_ID }) },
    },
    { label: "node", override: { node: node(OTHER_NODE_ID) } },
    { label: "Paseo server", override: { node: node(NODE_ID, "server-two") } },
    { label: "node mode", override: { node: node(NODE_ID, "server-one", "managed") } },
    {
      label: "principal",
      override: { principal: principal({ principalId: OTHER_PRINCIPAL_ID }) },
    },
    {
      label: "credential",
      override: { principal: principal({ credentialId: OTHER_CREDENTIAL_ID }) },
    },
    {
      label: "Grant version",
      override: { principal: principal({ grantVersion: OTHER_GRANT_VERSION }) },
    },
    {
      label: "Session generation",
      override: { sessionBindingGeneration: OTHER_SESSION_GENERATION },
    },
    { label: "workspace", override: { workspaceId: OTHER_WORKSPACE_ID } },
    { label: "relative path", override: { relativePath: OTHER_RELATIVE_PATH } },
  ])(
    "burns a token before rejecting the wrong $label without calling the resolver",
    async (row) => {
      const resolver = createResolver();
      const policy = createPolicy({ resolver });
      const issued = await policy.issue(issueInput());
      expect(resolver.calls).toHaveLength(1);

      await expect(policy.consume(consumeInput(issued.token, row.override))).resolves.toBeNull();
      expect(resolver.calls).toHaveLength(1);

      await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
      expect(resolver.calls).toHaveLength(1);
    },
  );

  it.each(["dev", "ino", "size", "mtimeMs"] as const)(
    "compares file identity field %s exactly and burns a mismatch",
    async (field) => {
      const mismatchedIdentity = { ...FILE_IDENTITY, [field]: FILE_IDENTITY[field] + 1 };
      const resolver = createResolver((_input, callNumber) =>
        callNumber === 1 ? target() : target({ fileIdentity: mismatchedIdentity }),
      );
      const policy = createPolicy({ resolver });
      const issued = await policy.issue(issueInput());

      await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
      expect(resolver.calls).toHaveLength(2);
      await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
      expect(resolver.calls).toHaveLength(2);
    },
  );

  it("accepts one millisecond before expiry and rejects the exact expiry boundary", async () => {
    const clock = new TestClock(1_000);
    const resolver = createResolver();
    const policy = createPolicy({ ttlMs: 100, clock, resolver });
    const beforeBoundary = await policy.issue(issueInput());

    clock.value = 1_099;
    const binding = await policy.consume(consumeInput(beforeBoundary.token));
    expect(binding).toEqual(expectedBinding(1_100));
    expect(resolver.calls).toHaveLength(2);
    expect(resolver.calls.map((call) => Object.hasOwn(call, "token"))).toEqual([false, false]);

    clock.value = 2_000;
    const atBoundary = await policy.issue(issueInput());
    clock.value = 2_100;
    await expect(policy.consume(consumeInput(atBoundary.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(3);
  });

  it.each([0, -1, 60_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid TTL %s",
    (ttlMs) => {
      expect(
        () =>
          new DownloadTokenPolicy({
            ttlMs,
            capacity: 1,
            clock: new TestClock(0),
            randomSource: new IncrementingRandomSource(),
            resolver: createResolver(),
          }),
      ).toThrowError(DownloadTokenPolicyError);
    },
  );

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    DOWNLOAD_TOKEN_CAPACITY_HARD_MAX + 1,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid capacity %s", (capacity) => {
    expect(
      () =>
        new DownloadTokenPolicy({
          ttlMs: 1,
          capacity,
          clock: new TestClock(0),
          randomSource: new IncrementingRandomSource(),
          resolver: createResolver(),
        }),
    ).toThrowError(DownloadTokenPolicyError);
  });

  it("accepts the exported hard capacity maximum", () => {
    expect(() => createPolicy({ capacity: DOWNLOAD_TOKEN_CAPACITY_HARD_MAX })).not.toThrow();
  });

  it("rejects capacity above the hard maximum before reading any dependency", () => {
    let resolverReads = 0;
    let clockReads = 0;
    let randomReads = 0;
    const options = {
      ttlMs: 1,
      capacity: DOWNLOAD_TOKEN_CAPACITY_HARD_MAX + 1,
      get resolver(): DownloadTokenResolver {
        resolverReads += 1;
        return createResolver();
      },
      get clock(): DownloadTokenClock {
        clockReads += 1;
        return new TestClock(0);
      },
      get randomSource(): DownloadTokenRandomSource {
        randomReads += 1;
        return new IncrementingRandomSource();
      },
    };

    expect(() => new DownloadTokenPolicy(options)).toThrowError(DownloadTokenPolicyError);
    expect(resolverReads).toBe(0);
    expect(clockReads).toBe(0);
    expect(randomReads).toBe(0);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid clock value %s before creating a token", async (now) => {
    const randomSource = new IncrementingRandomSource();
    const policy = createPolicy({ clock: new TestClock(now), randomSource });

    await expectPolicyError(policy.issue(issueInput()), "invalid_clock");
    expect(randomSource.requestedSizes).toEqual([]);
  });

  it("rejects clock rollback after burning the token", async () => {
    const clock = new TestClock(100);
    const resolver = createResolver();
    const policy = createPolicy({ ttlMs: 10, clock, resolver });
    const issued = await policy.issue(issueInput());

    clock.value = 99;
    await expectPolicyError(policy.consume(consumeInput(issued.token)), "clock_rollback");
    expect(resolver.calls).toHaveLength(1);
    clock.value = 100;
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
  });

  it("rejects expiry overflow without creating a token", async () => {
    const randomSource = new IncrementingRandomSource();
    const clock = new TestClock(Number.MAX_SAFE_INTEGER - 59_999);
    const policy = createPolicy({ clock, randomSource });

    await expectPolicyError(policy.issue(issueInput()), "expiry_overflow");
    expect(randomSource.requestedSizes).toEqual([]);
  });

  it("burns a token when the authenticated resolver throws", async () => {
    const resolverError = new Error("resolver unavailable");
    const resolver = createResolver((_input, callNumber) => {
      if (callNumber === 2) {
        throw resolverError;
      }
      return target();
    });
    const policy = createPolicy({ resolver });
    const issued = await policy.issue(issueInput());

    await expect(policy.consume(consumeInput(issued.token))).rejects.toBe(resolverError);
    expect(resolver.calls).toHaveLength(2);
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(2);
  });

  it("burns a token when the resolver returns a different canonical workspace", async () => {
    const resolver = createResolver((_input, callNumber) =>
      callNumber === 1 ? target() : target({ workspace: workspace({ nodeId: OTHER_NODE_ID }) }),
    );
    const policy = createPolicy({ resolver });
    const issued = await policy.issue(issueInput());

    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(2);
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(2);
  });

  it.each(["ownerPrincipalId", "createdByPrincipalId"] as const)(
    "burns a token when canonical workspace %s is rebound",
    async (field) => {
      const resolver = createResolver((_input, callNumber) =>
        callNumber === 1
          ? target()
          : target({ workspace: workspace({ [field]: OTHER_PRINCIPAL_ID }) }),
      );
      const policy = createPolicy({ resolver });
      const issued = await policy.issue(issueInput());

      await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
      await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
      expect(resolver.calls).toHaveLength(2);
    },
  );

  it("rejects a resolver mismatch during issue before drawing randomness", async () => {
    const randomSource = new IncrementingRandomSource();
    const resolver = createResolver(() =>
      target({ workspace: workspace({ organizationId: OTHER_ORGANIZATION_ID }) }),
    );
    const policy = createPolicy({ resolver, randomSource });

    await expectPolicyError(policy.issue(issueInput()), "resolved_target_mismatch");
    expect(resolver.calls).toHaveLength(1);
    expect(randomSource.requestedSizes).toEqual([]);
  });

  it.each([31, 33])("rejects a random source that returns %s bytes", async (invalidLength) => {
    const randomSource = new SequenceRandomSource([
      new Uint8Array(invalidLength),
      new Uint8Array(32).fill(9),
    ]);
    const policy = createPolicy({ capacity: 1, randomSource });

    await expectPolicyError(policy.issue(issueInput()), "invalid_random_bytes");
    const issued = await policy.issue(issueInput());
    expect(issued.token).toHaveLength(43);
    expect(randomSource.requestedSizes).toEqual([32, 32]);
  });

  it("bounds collision handling at three attempts without replacing the existing token", async () => {
    const repeated = new Uint8Array(32).fill(7);
    const distinct = new Uint8Array(32).fill(8);
    const randomSource = new SequenceRandomSource([
      repeated,
      repeated,
      repeated,
      repeated,
      distinct,
    ]);
    const resolver = createResolver();
    const policy = createPolicy({ resolver, randomSource });
    const first = await policy.issue(issueInput());

    await expectPolicyError(policy.issue(issueInput()), "token_collision");
    expect(randomSource.requestedSizes).toEqual([32, 32, 32, 32]);

    const firstBinding = await policy.consume(consumeInput(first.token));
    expect(firstBinding).toEqual(expectedBinding(61_000));
    const next = await policy.issue(issueInput());
    expect(next.token).not.toBe(first.token);
    expect(randomSource.requestedSizes).toEqual([32, 32, 32, 32, 32]);
  });

  it("enforces capacity and removes expired records before the next issue", async () => {
    const clock = new TestClock(0);
    const policy = createPolicy({ ttlMs: 100, capacity: 2, clock });
    const first = await policy.issue(issueInput());
    clock.value = 10;
    const second = await policy.issue(issueInput());

    clock.value = 20;
    await expectPolicyError(policy.issue(issueInput()), "capacity_exceeded");

    clock.value = 100;
    const replacement = await policy.issue(issueInput());
    await expect(policy.consume(consumeInput(first.token))).resolves.toBeNull();
    await expect(policy.consume(consumeInput(second.token))).resolves.toEqual(expectedBinding(110));
    await expect(policy.consume(consumeInput(replacement.token))).resolves.toEqual(
      expectedBinding(200),
    );
  });

  it("reserves capacity before a blocked resolver can publish", async () => {
    const gate = deferred<DownloadTokenResolvedTarget>();
    const resolver = createResolver(() => gate.promise);
    const randomSource = new IncrementingRandomSource();
    const policy = createPolicy({ capacity: 1, resolver, randomSource });
    const first = policy.issue(issueInput());

    await expectPolicyError(policy.issue(issueInput()), "capacity_exceeded");
    expect(resolver.calls).toHaveLength(1);
    expect(randomSource.requestedSizes).toEqual([]);
    gate.resolve(target());
    await expect(first).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("clones and freezes caller, resolver, and returned binding data field by field", async () => {
    let releaseResolution: () => void = () => undefined;
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const issuedTarget = target();
    const resolver = createResolver(async (_input, callNumber) => {
      if (callNumber === 1) {
        await resolutionGate;
        return issuedTarget;
      }
      return target();
    });
    const policy = createPolicy({ resolver });
    const input = issueInput();
    const issuing = policy.issue(input);

    input.principal.organizationId = OTHER_ORGANIZATION_ID;
    input.principal.principalId = OTHER_PRINCIPAL_ID;
    input.node.nodeId = OTHER_NODE_ID;
    input.workspaceId = OTHER_WORKSPACE_ID;
    input.relativePath = OTHER_RELATIVE_PATH;
    releaseResolution();

    const issued = await issuing;
    expect(Reflect.set(issuedTarget.workspace, "workspaceId", OTHER_WORKSPACE_ID)).toBe(true);
    expect(Reflect.set(issuedTarget.workspace, "ownerPrincipalId", OTHER_PRINCIPAL_ID)).toBe(true);
    expect(Reflect.set(issuedTarget.fileIdentity, "ino", 999)).toBe(true);

    const binding = await policy.consume(consumeInput(issued.token));
    expect(binding).toEqual(expectedBinding(61_000));
    if (!binding) {
      throw new Error("Expected a download binding");
    }
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.node)).toBe(true);
    expect(Object.isFrozen(binding.workspace)).toBe(true);
    expect(Object.isFrozen(binding.fileIdentity)).toBe(true);
    expect(Object.hasOwn(binding, "token")).toBe(false);
    expect(Reflect.set(binding, "principalId", OTHER_PRINCIPAL_ID)).toBe(false);
    expect(Reflect.set(binding.node, "paseoServerId", "other-server")).toBe(false);
    expect(Reflect.set(binding.workspace, "workspaceId", OTHER_WORKSPACE_ID)).toBe(false);
    expect(Reflect.set(binding.fileIdentity, "ino", 999)).toBe(false);

    const resolverInput = resolver.calls[0];
    if (!resolverInput) {
      throw new Error("Resolver was not called");
    }
    expect(resolverInput).toEqual(issueInput());
    expect(Reflect.set(resolverInput.principal, "principalId", OTHER_PRINCIPAL_ID)).toBe(false);
    expect(Reflect.set(resolverInput.node, "nodeId", OTHER_NODE_ID)).toBe(false);
  });

  it("lets only one concurrent consume resolve the token", async () => {
    let releaseConsume: () => void = () => undefined;
    const consumeGate = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const resolver = createResolver(async (_input, callNumber) => {
      if (callNumber === 2) {
        await consumeGate;
      }
      return target();
    });
    const policy = createPolicy({ resolver });
    const issued = await policy.issue(issueInput());
    const input = consumeInput(issued.token);

    const consuming = Promise.all([
      policy.consume(input),
      policy.consume(input),
      policy.consume(input),
    ]);
    expect(resolver.calls).toHaveLength(2);
    releaseConsume();
    const bindings = await consuming;

    expect(bindings.filter((binding) => binding !== null)).toHaveLength(1);
    expect(bindings.filter((binding) => binding === null)).toHaveLength(2);
    expect(resolver.calls).toHaveLength(2);
  });

  it("starts every new policy instance with an empty in-memory store", async () => {
    const firstResolver = createResolver();
    const secondResolver = createResolver();
    const randomSource = new SequenceRandomSource([new Uint8Array(32).fill(3)]);
    const firstPolicy = createPolicy({ resolver: firstResolver, randomSource });
    const issued = await firstPolicy.issue(issueInput());
    const secondPolicy = createPolicy({ resolver: secondResolver });

    await expect(secondPolicy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(secondResolver.calls).toEqual([]);
    await expect(firstPolicy.consume(consumeInput(issued.token))).resolves.toEqual(
      expectedBinding(61_000),
    );
    expect(firstResolver.calls).toHaveLength(2);
  });

  it("does not retain consumed token history in exact-scope cleanup", async () => {
    const policy = createPolicy({ capacity: 4 });

    for (let index = 0; index < 20; index += 1) {
      const issued = await policy.issue(issueInput());
      await expect(policy.consume(consumeInput(issued.token))).resolves.not.toBeNull();
    }

    expect(
      policy.burnScope({
        kind: "session",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human",
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
        grantVersion: GRANT_VERSION,
        sessionBindingGeneration: SESSION_GENERATION,
      }),
    ).toBe(0);
  });

  it.each([
    {
      label: "session",
      scope: {
        kind: "session" as const,
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human" as const,
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
        grantVersion: GRANT_VERSION,
        sessionBindingGeneration: SESSION_GENERATION,
      },
      burned: ["base"] as const,
    },
    {
      label: "credential",
      scope: {
        kind: "credential" as const,
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human" as const,
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
      },
      burned: ["base", "otherSession", "otherGrant"] as const,
    },
    {
      label: "grant",
      scope: {
        kind: "grant" as const,
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human" as const,
        principalId: PRINCIPAL_ID,
        grantVersion: GRANT_VERSION,
      },
      burned: ["base", "otherSession", "otherCredential"] as const,
    },
    {
      label: "principal",
      scope: {
        kind: "principal" as const,
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human" as const,
        principalId: PRINCIPAL_ID,
      },
      burned: ["base", "otherSession", "otherCredential", "otherGrant"] as const,
    },
  ])("burns only the strict $label lifecycle scope", async ({ scope, burned }) => {
    const policy = createCleanupScopePolicy();
    const tokens = await issueCleanupMatrix(policy);

    expect(policy.burnScope(scope)).toBe(burned.length);
    const burnedKeys = new Set<keyof CleanupMatrixTokens>(burned);
    for (const [key, token] of Object.entries(tokens) as [keyof CleanupMatrixTokens, string][]) {
      expect(policy.burn(token), key).toBe(!burnedKeys.has(key));
    }
  });

  it("rejects a non-strict cleanup scope without burning any token", async () => {
    const policy = createPolicy();
    const issued = await policy.issue(issueInput());

    expect(
      policy.burnScope({
        kind: "session",
        organizationId: ORGANIZATION_ID,
        node: node(),
        principalType: "human",
        principalId: PRINCIPAL_ID,
        credentialId: CREDENTIAL_ID,
        grantVersion: GRANT_VERSION,
        sessionBindingGeneration: SESSION_GENERATION,
        unexpected: true,
      } as never),
    ).toBe(0);
    expect(policy.burn(issued.token)).toBe(true);
  });

  it.each([
    {
      kind: "session" as const,
      survivor: { ...issueInput(), sessionBindingGeneration: OTHER_SESSION_GENERATION },
    },
    {
      kind: "credential" as const,
      survivor: {
        ...issueInput(),
        principal: principal({ credentialId: OTHER_CREDENTIAL_ID }),
      },
    },
    {
      kind: "grant" as const,
      survivor: {
        ...issueInput(),
        principal: principal({ grantVersion: OTHER_GRANT_VERSION }),
      },
    },
    {
      kind: "principal" as const,
      survivor: {
        ...issueInput(),
        principal: principal({ principalId: OTHER_PRINCIPAL_ID }),
      },
    },
  ])(
    "$kind cleanup synchronously invalidates a blocked issue and leaves another scope alive",
    async ({ kind, survivor }) => {
      const targetGate = deferred<DownloadTokenResolvedTarget>();
      const survivorGate = deferred<DownloadTokenResolvedTarget>();
      const resolver = createResolver((_input, callNumber) =>
        callNumber === 1 ? targetGate.promise : survivorGate.promise,
      );
      const randomSource = new IncrementingRandomSource();
      const policy = createPolicy({ capacity: 2, resolver, randomSource });
      const blocked = policy.issue(issueInput());
      const surviving = policy.issue(survivor);

      const cleanup = policy.cleanupScope(cleanupScope(kind));
      let cleanupSettled = false;
      cleanup.then(() => {
        cleanupSettled = true;
        return undefined;
      });
      targetGate.resolve(target());
      await expect(blocked).rejects.toMatchObject({ code: "issue_invalidated" });
      await expect(cleanup).resolves.toBe(1);
      expect(cleanupSettled).toBe(true);
      expect(randomSource.requestedSizes).toEqual([]);

      survivorGate.resolve(
        target({
          workspace: workspace({
            organizationId: survivor.principal.organizationId,
            nodeId: survivor.node.nodeId,
            workspaceId: survivor.workspaceId,
          }),
        }),
      );
      const issued = await surviving;
      await expect(policy.consume({ ...survivor, token: issued.token })).resolves.not.toBeNull();
      expect(randomSource.requestedSizes).toEqual([32]);
    },
  );

  it.each([
    { label: "Paseo server", issueNode: node(NODE_ID, "server-two") },
    { label: "node mode", issueNode: node(NODE_ID, "server-one", "managed") },
  ])("session cleanup leaves a blocked issue on another $label alive", async ({ issueNode }) => {
    const gate = deferred<DownloadTokenResolvedTarget>();
    const resolver = createResolver(() => gate.promise);
    const policy = createPolicy({ resolver });
    const input = { ...issueInput(), node: issueNode };
    const issuing = policy.issue(input);

    await expect(policy.cleanupScope(cleanupScope("session"))).resolves.toBe(0);
    gate.resolve(target({ workspace: workspace({ nodeId: issueNode.nodeId }) }));
    const issued = await issuing;
    await expect(policy.consume({ ...input, token: issued.token })).resolves.not.toBeNull();
  });
});
