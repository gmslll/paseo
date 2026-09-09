import type {
  AuthorizedWorkspace,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";
import {
  DownloadTokenPolicy,
  type DownloadFileIdentity,
  type DownloadTokenResolveInput,
  type DownloadTokenResolvedTarget,
} from "../enterprise/runtime/download-token-policy.js";
import type { WorkspaceReadHandle } from "../enterprise/runtime/workspace-path-policy.js";
import {
  EnterpriseDownloadHttpConsumer,
  type EnterpriseDownloadPathPolicy,
} from "./enterprise-consumer.js";

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
const SESSION_GENERATION = "session-generation-one";
const OTHER_SESSION_GENERATION = "session-generation-two";

const FILE_IDENTITY: DownloadFileIdentity = {
  dev: 11,
  ino: 22,
  size: 7,
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
    credentialId: overrides.credentialId ?? "credential-one",
    grantVersion: overrides.grantVersion ?? "grant-version-one",
    grants: [
      {
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

function node(nodeId = NODE_ID): NodeContext {
  return { nodeId, paseoServerId: "server-one", mode: "standalone" };
}

function context(overrides: Partial<EnterpriseSessionContext> = {}): EnterpriseSessionContext {
  return {
    principal: principal(),
    node: node(),
    sessionBindingGeneration: SESSION_GENERATION,
    ...overrides,
  };
}

function workspace(): AuthorizedWorkspace {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    createdByPrincipalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
  };
}

class TestResolver {
  public readonly calls: DownloadTokenResolveInput[] = [];
  public identity: DownloadFileIdentity = { ...FILE_IDENTITY };

  public async resolve(input: DownloadTokenResolveInput): Promise<DownloadTokenResolvedTarget> {
    this.calls.push(input);
    return { workspace: workspace(), fileIdentity: { ...this.identity } };
  }
}

class TestReadHandle implements WorkspaceReadHandle {
  public closed = 0;
  public identity: DownloadFileIdentity = { ...FILE_IDENTITY };
  public statError: unknown;
  public closeError: unknown;

  public async stat() {
    if (this.statError !== undefined) throw this.statError;
    return { ...this.identity };
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    return new TextEncoder().encode("content").subarray(offset, offset + length);
  }

  public async close(): Promise<void> {
    this.closed += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

class TestPathPolicy implements EnterpriseDownloadPathPolicy {
  public readonly reads: Array<{ workspaceId: string; relativePath: string }> = [];
  public readonly handles: TestReadHandle[] = [];
  public nextIdentity: DownloadFileIdentity = { ...FILE_IDENTITY };
  public nextStatError: unknown;
  public nextCloseError: unknown;

  public async read(workspaceId: string, relativePath: string): Promise<WorkspaceReadHandle> {
    this.reads.push({ workspaceId, relativePath });
    const handle = new TestReadHandle();
    handle.identity = { ...this.nextIdentity };
    handle.statError = this.nextStatError;
    handle.closeError = this.nextCloseError;
    this.handles.push(handle);
    return handle;
  }
}

function createHarness(releaseReady = true) {
  const resolver = new TestResolver();
  let randomByte = 1;
  const policy = new DownloadTokenPolicy({
    ttlMs: 60_000,
    capacity: 20,
    resolver,
    clock: { now: () => 1_000 },
    randomSource: {
      randomBytes(size) {
        return new Uint8Array(size).fill(randomByte++);
      },
    },
  });
  const paths = new TestPathPolicy();
  const createdFor: EnterpriseSessionContext[] = [];
  const consumer = new EnterpriseDownloadHttpConsumer({
    safeFs: { releaseReady, supportsDirectoryRelativeOperations: true },
    policy,
    createPathPolicy(input) {
      createdFor.push(input);
      return paths;
    },
    lifecycle: {
      begin() {
        return {
          isCurrent: () => true,
          publish: (capability) => capability,
          recordCleanupFailure: () => undefined,
          finish: () => undefined,
        };
      },
    },
  });
  return { consumer, createdFor, paths, policy, resolver };
}

function tokenInput(inputContext = context()) {
  return {
    principal: inputContext.principal,
    node: inputContext.node,
    sessionBindingGeneration: inputContext.sessionBindingGeneration,
    workspaceId: WORKSPACE_ID,
    relativePath: RELATIVE_PATH,
  };
}

describe("EnterpriseDownloadHttpConsumer", () => {
  it("returns one safe read capability without exposing an absolute path", async () => {
    const { consumer, paths, policy } = createHarness();
    const issued = await policy.issue(tokenInput());

    const capability = await consumer.consume({
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });

    expect(capability).not.toBeNull();
    expect(Object.keys(capability ?? {}).sort()).toEqual([
      "close",
      "fileName",
      "mimeType",
      "modifiedAt",
      "read",
      "relativePath",
      "size",
      "workspaceId",
    ]);
    expect(Object.hasOwn(capability ?? {}, "absolutePath")).toBe(false);
    await expect(capability?.read(0, 7)).resolves.toEqual(new TextEncoder().encode("content"));
    await capability?.close();
    await capability?.close();
    expect(paths.handles[0]?.closed).toBe(1);
    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when request parsing encounters a throwing getter", async () => {
    const { consumer, paths, policy, resolver } = createHarness();
    const issued = await policy.issue(tokenInput());
    const request = {
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    };
    Object.defineProperty(request, "workspaceId", {
      get() {
        throw new Error("throwing getter");
      },
    });

    await expect(consumer.consume(request)).resolves.toBeNull();
    expect(paths.reads).toHaveLength(0);
    expect(resolver.calls).toHaveLength(1);
    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      label: "principal",
      requestContext: context({ principal: principal({ principalId: OTHER_PRINCIPAL_ID }) }),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    },
    {
      label: "organization",
      requestContext: context({
        principal: principal({ organizationId: OTHER_ORGANIZATION_ID }),
      }),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    },
    {
      label: "node",
      requestContext: context({ node: node(OTHER_NODE_ID) }),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    },
    {
      label: "Session generation",
      requestContext: context({ sessionBindingGeneration: OTHER_SESSION_GENERATION }),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    },
    {
      label: "workspace",
      requestContext: context(),
      workspaceId: OTHER_WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    },
    {
      label: "relative path",
      requestContext: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: OTHER_RELATIVE_PATH,
    },
  ])("burns before safe-FS on a wrong $label", async (row) => {
    const { consumer, paths, policy, resolver } = createHarness();
    const issued = await policy.issue(tokenInput());

    await expect(
      consumer.consume({
        context: row.requestContext,
        workspaceId: row.workspaceId,
        relativePath: row.relativePath,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(paths.reads).toEqual([]);
    expect(resolver.calls).toHaveLength(1);
    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
  });

  it("closes and rejects a safe handle whose identity changed after token validation", async () => {
    const { consumer, paths, policy } = createHarness();
    const issued = await policy.issue(tokenInput());
    paths.nextIdentity = { ...FILE_IDENTITY, ino: FILE_IDENTITY.ino + 1 };

    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(paths.handles[0]?.closed).toBe(1);
  });

  it("closes a failing safe handle exactly once even when close also fails", async () => {
    const { consumer, paths, policy } = createHarness();
    const issued = await policy.issue(tokenInput());
    paths.nextStatError = new Error("primary stat failure");
    paths.nextCloseError = new Error("secondary close failure");

    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(paths.handles[0]?.closed).toBe(1);
  });

  it("permits only one concurrent consumer to receive a capability", async () => {
    const { consumer, policy } = createHarness();
    const issued = await policy.issue(tokenInput());
    const request = {
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    };

    const capabilities = await Promise.all([
      consumer.consume(request),
      consumer.consume(request),
      consumer.consume(request),
    ]);

    expect(capabilities.filter((entry) => entry !== null)).toHaveLength(1);
  });

  it("fails closed without policy resolution or safe-FS access when releaseReady is false", async () => {
    const { consumer, createdFor, paths, policy, resolver } = createHarness(false);
    const issued = await policy.issue(tokenInput());
    expect(resolver.calls).toHaveLength(1);

    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(resolver.calls).toHaveLength(1);
    expect(createdFor).toEqual([]);
    expect(paths.reads).toEqual([]);
  });
});
