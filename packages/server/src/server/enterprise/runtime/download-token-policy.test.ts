import type {
  AuthorizedWorkspace,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  DownloadTokenPolicy,
  DownloadTokenPolicyError,
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
}

function principal(overrides: PrincipalOverrides = {}): PrincipalContext {
  return {
    principalType: "human",
    principalId: overrides.principalId ?? PRINCIPAL_ID,
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    credentialId: "credential-one",
    grantVersion: "grant-version-one",
    grants: [
      {
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

function node(nodeId = NODE_ID): NodeContext {
  return {
    nodeId,
    paseoServerId: "server-one",
    mode: "standalone",
  };
}

interface WorkspaceOverrides {
  organizationId?: string;
  nodeId?: string;
  workspaceId?: string;
}

function workspace(overrides: WorkspaceOverrides = {}): AuthorizedWorkspace {
  return {
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    nodeId: overrides.nodeId ?? NODE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    createdByPrincipalId: PRINCIPAL_ID,
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
    workspaceId: WORKSPACE_ID,
    relativePath: RELATIVE_PATH,
  };
}

interface ConsumeOverrides {
  principal?: PrincipalContext;
  node?: NodeContext;
  workspaceId?: string;
  relativePath?: string;
}

function consumeInput(token: string, overrides: ConsumeOverrides = {}): DownloadTokenConsumeInput {
  return {
    token,
    principal: overrides.principal ?? principal(),
    node: overrides.node ?? node(),
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    relativePath: overrides.relativePath ?? RELATIVE_PATH,
  };
}

function expectedBinding(expiresAt: number): DownloadTokenBinding {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    principalId: PRINCIPAL_ID,
    workspace: workspace(),
    relativePath: RELATIVE_PATH,
    fileIdentity: FILE_IDENTITY,
    expiresAt,
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
  it("parses authenticated context before resolving and issues only a canonical token and expiry", async () => {
    const resolver = createResolver();
    const randomSource = new IncrementingRandomSource();
    const rawPrincipal = { ...principal(), untrustedActor: OTHER_PRINCIPAL_ID };
    const rawNode = { ...node(), untrustedNode: OTHER_NODE_ID };
    const policy = createPolicy({ resolver, randomSource });

    const issued = await policy.issue({
      principal: rawPrincipal,
      node: rawNode,
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
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(resolver.calls).toHaveLength(1);
    await expect(policy.consume(consumeInput(issued.token))).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
  });

  it.each([
    {
      label: "organization",
      override: { principal: principal({ organizationId: OTHER_ORGANIZATION_ID }) },
    },
    { label: "node", override: { node: node(OTHER_NODE_ID) } },
    {
      label: "principal",
      override: { principal: principal({ principalId: OTHER_PRINCIPAL_ID }) },
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

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid capacity %s",
    (capacity) => {
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
    },
  );

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
    expect(Reflect.set(issuedTarget.fileIdentity, "ino", 999)).toBe(true);

    const binding = await policy.consume(consumeInput(issued.token));
    expect(binding).toEqual(expectedBinding(61_000));
    if (!binding) {
      throw new Error("Expected a download binding");
    }
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.workspace)).toBe(true);
    expect(Object.isFrozen(binding.fileIdentity)).toBe(true);
    expect(Object.hasOwn(binding, "token")).toBe(false);
    expect(Reflect.set(binding, "principalId", OTHER_PRINCIPAL_ID)).toBe(false);
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
});
