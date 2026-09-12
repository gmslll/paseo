import { Buffer } from "node:buffer";
import type {
  AuthorizedWorkspace,
  EnterpriseAction,
  NodeContext,
  PrincipalContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type { EnterpriseSessionContext } from "../identity/session-context.js";
import type {
  EnterpriseUploadAppendInput,
  EnterpriseUploadCleanupInput,
  EnterpriseUploadFinalizeInput,
  EnterpriseUploadIssueInput,
} from "./enterprise-upload-policy.js";
import type {
  SafeDirectoryHandle,
  SafeFileHandle,
  SafeWorkspaceFsPort,
  WorkspacePathStat,
} from "./workspace-path-policy.js";
import { EnterpriseWorkspaceFilesHost } from "./workspace-files-runtime.js";

const ORGANIZATION_ID = "org_0123456789abcdef";
const NODE_ID = "nod_0123456789abcdef";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const WORKSPACE_ID = "workspace-one";
const RELATIVE_PATH = "reports/quarter.csv";

function principal(): PrincipalContext {
  return {
    principalType: "human",
    principalId: PRINCIPAL_ID,
    organizationId: ORGANIZATION_ID,
    credentialId: "credential-one",
    grantVersion: "grant-one",
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

function context(
  generation = "generation-one",
  inputPrincipal = principal(),
  inputNode = node(),
): EnterpriseSessionContext {
  return { principal: inputPrincipal, node: inputNode, sessionBindingGeneration: generation };
}

function lifecycle(isCurrent: () => boolean = () => true) {
  return { isCurrent: (_context: EnterpriseSessionContext) => isCurrent() };
}

function cleanupHostScope(
  host: EnterpriseWorkspaceFilesHost,
  kind: "credential" | "grant" | "principal",
  inputContext: EnterpriseSessionContext,
): Promise<void> {
  if (kind === "credential") return host.cleanupCredential(inputContext);
  if (kind === "grant") return host.cleanupDownloadsForGrant(inputContext);
  return host.cleanupPrincipal(inputContext);
}

function survivorContextFor(kind: "credential" | "grant" | "principal") {
  if (kind === "credential") {
    return context("generation-two", { ...principal(), credentialId: "credential-two" });
  }
  if (kind === "grant") {
    return context("generation-two", { ...principal(), grantVersion: "grant-two" });
  }
  return context("generation-two", {
    ...principal(),
    principalId: "usr_fedcba9876543210",
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for test operation.");
}

function workspace(nodeId = NODE_ID): AuthorizedWorkspace {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId,
    ownerPrincipalId: PRINCIPAL_ID,
    createdByPrincipalId: PRINCIPAL_ID,
    workspaceId: WORKSPACE_ID,
  };
}

interface AuthorizationCall {
  principal: PrincipalContext;
  action: EnterpriseAction;
  workspaceId: string;
}

class TestAuthorization implements Pick<ResourceAuthorization, "assertWorkspace"> {
  public readonly calls: AuthorizationCall[] = [];
  public result = workspace();

  public async assertWorkspace(
    inputPrincipal: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    this.calls.push({ principal: inputPrincipal, action, workspaceId });
    return this.result;
  }
}

class TestRoot implements SafeDirectoryHandle {
  public closed = 0;

  public async stat() {
    return { dev: 1, ino: 1, isDirectory: () => true };
  }

  public async close(): Promise<void> {
    this.closed += 1;
  }
}

class TestFile implements SafeFileHandle {
  public closed = 0;
  public readCalls = 0;
  public readGate: Promise<void> | null = null;
  public readError: unknown = null;
  public closeError: unknown = null;
  public identity = { dev: 1, ino: 2, size: 5, mtimeMs: 1_000 };

  public async stat() {
    return { ...this.identity };
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    this.readCalls += 1;
    await this.readGate;
    if (this.readError !== null) throw this.readError;
    return new TextEncoder().encode("hello").subarray(offset, offset + length);
  }

  public async close(): Promise<void> {
    this.closed += 1;
    if (this.closeError !== null) throw this.closeError;
  }
}

class TestSafeFs implements SafeWorkspaceFsPort {
  public releaseReady = true;
  public supportsDirectoryRelativeOperations = true;
  public readonly roots: string[] = [];
  public readonly stats: readonly string[][] = [];
  public readonly reads: readonly string[][] = [];
  public readonly handles: TestFile[] = [];
  public readonly rootHandles: TestRoot[] = [];
  public fileIdentity = { dev: 1, ino: 2, size: 5, mtimeMs: 1_000 };
  public readGate: Promise<void> | null = null;
  public writeGate: Promise<void> | null = null;
  public watchGate: Promise<void> | null = null;
  public statGate: { readonly call: number; readonly promise: Promise<void> } | null = null;
  public writes = 0;
  public watches = 0;
  public watchDisposals = 0;

  public async openWorkspaceRoot(root: string): Promise<SafeDirectoryHandle> {
    this.roots.push(root);
    const handle = new TestRoot();
    this.rootHandles.push(handle);
    return handle;
  }

  public async read(_root: SafeDirectoryHandle, path: readonly string[]): Promise<SafeFileHandle> {
    this.reads.push(path);
    await this.readGate;
    const file = new TestFile();
    file.identity = { ...this.fileIdentity };
    this.handles.push(file);
    return file;
  }

  public async stat(
    _root: SafeDirectoryHandle,
    path: readonly string[],
  ): Promise<WorkspacePathStat> {
    this.stats.push(path);
    if (this.statGate?.call === this.stats.length) await this.statGate.promise;
    return { kind: "file", ...this.fileIdentity };
  }

  public async list(): Promise<readonly string[]> {
    return [];
  }

  public async listRoot(): Promise<readonly string[]> {
    return [];
  }

  public async write(): Promise<void> {
    this.writes += 1;
    await this.writeGate;
  }
  public async create(): Promise<void> {}
  public async rename(): Promise<void> {}
  public async copy(): Promise<void> {}
  public async delete(): Promise<void> {}

  public async watch(): Promise<AsyncDisposable> {
    this.watches += 1;
    await this.watchGate;
    return {
      [Symbol.asyncDispose]: async () => {
        this.watchDisposals += 1;
      },
    };
  }
}

class NoopUploadPolicy {
  public readonly cleanups: EnterpriseUploadCleanupInput[] = [];

  public async issue(_input: EnterpriseUploadIssueInput) {
    return { uploadId: "upload-one", expiresAt: 2_000 };
  }

  public async append(_input: EnterpriseUploadAppendInput): Promise<boolean> {
    return true;
  }

  public async finalize(input: EnterpriseUploadFinalizeInput) {
    return {
      uploadId: input.uploadId,
      workspace: workspace(),
      relativePath: input.relativePath,
      fileIdentity: { dev: 1, ino: 2, size: 5, mtimeMs: 1_000 },
    };
  }

  public async abort(_input: EnterpriseUploadFinalizeInput): Promise<boolean> {
    return true;
  }

  public async cleanup(input: EnterpriseUploadCleanupInput) {
    this.cleanups.push(input);
    return { cleaned: 0 };
  }
}

function createHarness(releaseReady = true, configureSafeFs?: (safeFs: TestSafeFs) => void) {
  const authorization = new TestAuthorization();
  const safeFs = new TestSafeFs();
  safeFs.releaseReady = releaseReady;
  configureSafeFs?.(safeFs);
  const uploadPolicy = new NoopUploadPolicy();
  let rootResolutions = 0;
  let randomByte = 1;
  let randomRequests = 0;
  const host = new EnterpriseWorkspaceFilesHost({
    authorization,
    safeFs,
    async resolveCanonicalRoot() {
      rootResolutions += 1;
      return "/internal/workspace/root";
    },
    createUploadStagingRelativePath: ({ requestId }) => `.paseo-uploads/${requestId}`,
    uploadPolicy,
    downloadTokens: {
      ttlMs: 60_000,
      capacity: 20,
      clock: { now: () => 1_000 },
      randomSource: {
        randomBytes(size) {
          randomRequests += 1;
          return new Uint8Array(size).fill(randomByte++);
        },
      },
    },
  });
  return {
    authorization,
    host,
    safeFs,
    uploadPolicy,
    rootResolutions: () => rootResolutions,
    randomRequests: () => randomRequests,
  };
}

describe("EnterpriseWorkspaceFilesHost", () => {
  it.each([
    { label: "absolute path", request: { relativePath: "/etc/passwd" } },
    { label: "parent path", request: { relativePath: "reports/../secret" } },
    { label: "caller cwd", request: { relativePath: RELATIVE_PATH, cwd: "/trusted/by-caller" } },
  ])("rejects $label before authorization or safe-FS", async ({ request }) => {
    const { authorization, host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());

    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: request.relativePath,
        requestId: "request-one",
        ...(request.cwd ? { cwd: request.cwd } : {}),
      }),
    ).rejects.toThrow();

    expect(authorization.calls).toHaveLength(0);
    expect(safeFs.roots).toHaveLength(0);
  });

  it("fails closed with zero authorization and filesystem access when safe-FS is not release ready", async () => {
    const { authorization, host, rootResolutions, safeFs, uploadPolicy, randomRequests } =
      createHarness(false);
    const runtime = host.createRuntime(context(), lifecycle());

    const pathRequest = {
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
    };
    const operations = [
      runtime.stat(pathRequest),
      runtime.list(pathRequest),
      runtime.openRead(pathRequest),
      runtime.write({
        ...pathRequest,
        bytes: new Uint8Array([1]),
        expectedModifiedAt: "2026-09-10T00:00:00.000Z",
      }),
      runtime.create({ ...pathRequest, kind: "file" }),
      runtime.rename({
        workspaceId: WORKSPACE_ID,
        sourceRelativePath: RELATIVE_PATH,
        destinationRelativePath: "reports/other.csv",
        requestId: "request-one",
      }),
      runtime.copy({
        workspaceId: WORKSPACE_ID,
        sourceRelativePath: RELATIVE_PATH,
        destinationRelativePath: "reports/other.csv",
        requestId: "request-one",
      }),
      runtime.delete(pathRequest),
      runtime.watch(pathRequest, () => undefined),
      runtime.issueDownloadToken(pathRequest),
    ];
    for (const operation of operations) await expect(operation).rejects.toThrow("safe-FS");
    const uploadStore = runtime.createUploadStore();
    expect(() =>
      uploadStore.begin({
        ...pathRequest,
        fileName: "quarter.csv",
        mimeType: "text/csv",
        size: 1,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      }),
    ).toThrow("access denied");

    expect(authorization.calls).toHaveLength(0);
    expect(rootResolutions()).toBe(0);
    expect(safeFs.roots).toHaveLength(0);
    expect(safeFs.stats).toHaveLength(0);
    expect(randomRequests()).toBe(0);
    expect(uploadPolicy.cleanups).toHaveLength(0);
    await expect(
      host.createHttpConsumer().consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: "untrusted-token",
      }),
    ).resolves.toBeNull();
    expect(authorization.calls).toHaveLength(0);
  });

  it("captures dependencies and readiness at host construction", async () => {
    const authorization = new TestAuthorization();
    const safeFs = new TestSafeFs();
    const uploadPolicy = new NoopUploadPolicy();
    let rootCalls = 0;
    const clock = { now: () => 1_000 };
    const randomSource = { randomBytes: (size: number) => new Uint8Array(size).fill(7) };
    const options = {
      authorization,
      safeFs,
      resolveCanonicalRoot: async () => {
        rootCalls += 1;
        return "/captured/root";
      },
      createUploadStagingRelativePath: ({ requestId }: { requestId: string }) =>
        `.paseo-uploads/${requestId}`,
      uploadPolicy,
      downloadTokens: { ttlMs: 60_000, capacity: 20, clock, randomSource },
    };
    const host = new EnterpriseWorkspaceFilesHost(options);
    safeFs.releaseReady = false;
    safeFs.supportsDirectoryRelativeOperations = false;
    safeFs.openWorkspaceRoot = async () => {
      throw new Error("mutated safe-FS method");
    };
    authorization.assertWorkspace = async () => {
      throw new Error("mutated authorization");
    };
    options.resolveCanonicalRoot = async () => {
      throw new Error("mutated root resolver");
    };
    uploadPolicy.cleanup = async () => {
      throw new Error("mutated upload policy");
    };
    clock.now = () => {
      throw new Error("mutated clock");
    };
    randomSource.randomBytes = () => {
      throw new Error("mutated random source");
    };
    const runtime = host.createRuntime(context(), lifecycle());

    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-one",
      }),
    ).resolves.toMatchObject({ kind: "file", size: 5 });
    await expect(
      runtime.issueDownloadToken({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-two",
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
    await expect(runtime.cleanup("session-closed")).resolves.toBeUndefined();
    expect(rootCalls).toBeGreaterThan(0);
  });

  it("issues and consumes a bound HTTP token as a safe handle without exposing a path", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
    });

    const capability = await host.createHttpConsumer().consume({
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });

    expect(capability).not.toBeNull();
    expect(Object.hasOwn(capability ?? {}, "absolutePath")).toBe(false);
    await expect(capability?.read(0, 5)).resolves.toEqual(new TextEncoder().encode("hello"));
    await capability?.close();
    expect(safeFs.handles.at(-1)?.closed).toBe(1);
  });

  it("fails closed and burns when no exact current runtime owns the HTTP context", async () => {
    const { host, safeFs } = createHarness();
    const issued = await host.issueDownload({
      principal: principal(),
      node: node(),
      sessionBindingGeneration: "generation-one",
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    });
    const consumer = host.createHttpConsumer();

    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    host.createRuntime(context(), lifecycle());
    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(safeFs.reads).toHaveLength(0);
  });

  it("fences an opened HTTP capability when its external lifecycle is no longer current", async () => {
    const { host, safeFs } = createHarness();
    let current = true;
    const runtime = host.createRuntime(
      context(),
      lifecycle(() => current),
    );
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-http-lifecycle",
    });
    const capability = await host.createHttpConsumer().consume({
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });
    if (!capability) throw new Error("Expected an HTTP read capability.");
    current = false;

    await expect(capability.read(0, 1)).rejects.toThrow("closed or no longer current");
    await runtime.cleanup("generation-replaced");
    expect(safeFs.handles.at(-1)?.closed).toBe(1);
  });

  it("burns a download token on wrong generation before opening a file", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
    });
    const readsBefore = safeFs.reads.length;
    const consumer = host.createHttpConsumer();

    await expect(
      consumer.consume({
        context: context("generation-two"),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    await expect(
      consumer.consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: issued.token,
      }),
    ).resolves.toBeNull();
    expect(safeFs.reads).toHaveLength(readsBefore);
  });

  it("rejects a mismatched canonical workspace before resolving its root", async () => {
    const { authorization, host, rootResolutions, safeFs } = createHarness();
    authorization.result = workspace("nod_fedcba9876543210");
    const runtime = host.createRuntime(context(), lifecycle());

    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-one",
      }),
    ).rejects.toThrow("access denied");
    expect(rootResolutions()).toBe(0);
    expect(safeFs.roots).toHaveLength(0);
  });

  it.each(["ownerPrincipalId", "createdByPrincipalId"] as const)(
    "burns a download when canonical workspace %s is rebound",
    async (field) => {
      const { authorization, host, safeFs } = createHarness();
      const runtime = host.createRuntime(context(), lifecycle());
      const issued = await runtime.issueDownloadToken({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-workspace-rebinding",
      });
      authorization.result = {
        ...workspace(),
        [field]: "usr_fedcba9876543210",
      };
      const readsBefore = safeFs.reads.length;

      await expect(
        host.createHttpConsumer().consume({
          context: context(),
          workspaceId: WORKSPACE_ID,
          relativePath: RELATIVE_PATH,
          token: issued.token,
        }),
      ).resolves.toBeNull();
      expect(safeFs.reads).toHaveLength(readsBefore);
    },
  );

  it.each(["session-closed", "generation-replaced"] as const)(
    "uses exact session scope for %s cleanup",
    async (reason) => {
      const { host, uploadPolicy } = createHarness();
      const runtime = host.createRuntime(context(), lifecycle());

      await runtime.cleanup(reason);

      expect(uploadPolicy.cleanups).toEqual([
        {
          reason,
          organizationId: ORGANIZATION_ID,
          node: node(),
          principalId: PRINCIPAL_ID,
          credentialId: principal().credentialId,
          grantVersion: principal().grantVersion,
          sessionBindingGeneration: "generation-one",
        },
      ]);
    },
  );

  it("burns credential downloads across grant versions and generations", async () => {
    const { host } = createHarness();
    const baseContext = context();
    const sameCredential = context("generation-two", {
      ...principal(),
      grantVersion: "grant-two",
    });
    const otherCredential = context("generation-three", {
      ...principal(),
      credentialId: "credential-two",
    });
    const pathRequest = {
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-download",
    };
    const base = await host.createRuntime(baseContext, lifecycle()).issueDownloadToken(pathRequest);
    const otherGrant = await host
      .createRuntime(sameCredential, lifecycle())
      .issueDownloadToken(pathRequest);
    const survivor = await host
      .createRuntime(otherCredential, lifecycle())
      .issueDownloadToken(pathRequest);

    await host.cleanupCredential(baseContext);
    const consumer = host.createHttpConsumer();
    await expect(
      consumer.consume({
        context: baseContext,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: base.token,
      }),
    ).resolves.toBeNull();
    await expect(
      consumer.consume({
        context: sameCredential,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: otherGrant.token,
      }),
    ).resolves.toBeNull();
    const capability = await consumer.consume({
      context: otherCredential,
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: survivor.token,
    });
    expect(capability).not.toBeNull();
    await capability?.close();
  });

  it("burns principal downloads across credentials, grants, and generations", async () => {
    const { host } = createHarness();
    const baseContext = context();
    const samePrincipal = context("generation-two", {
      ...principal(),
      credentialId: "credential-two",
      grantVersion: "grant-two",
    });
    const otherPrincipal = context("generation-three", {
      ...principal(),
      principalId: "usr_fedcba9876543210",
    });
    const pathRequest = {
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-download",
    };
    const base = await host.createRuntime(baseContext, lifecycle()).issueDownloadToken(pathRequest);
    const otherCredential = await host
      .createRuntime(samePrincipal, lifecycle())
      .issueDownloadToken(pathRequest);
    const survivor = await host
      .createRuntime(otherPrincipal, lifecycle())
      .issueDownloadToken(pathRequest);

    await host.cleanupPrincipal(baseContext);
    const consumer = host.createHttpConsumer();
    await expect(
      consumer.consume({
        context: baseContext,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: base.token,
      }),
    ).resolves.toBeNull();
    await expect(
      consumer.consume({
        context: samePrincipal,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: otherCredential.token,
      }),
    ).resolves.toBeNull();
    const capability = await consumer.consume({
      context: otherPrincipal,
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: survivor.token,
    });
    expect(capability).not.toBeNull();
    await capability?.close();
  });

  it("captures the lifecycle checker and passes it an exact frozen context", async () => {
    const { host } = createHarness();
    let current = true;
    const checked: EnterpriseSessionContext[] = [];
    const runtimeLifecycle = {
      isCurrent(input: EnterpriseSessionContext) {
        checked.push(input);
        return current;
      },
    };
    const runtime = host.createRuntime(context(), runtimeLifecycle);
    runtimeLifecycle.isCurrent = () => true;
    current = false;

    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-one",
      }),
    ).rejects.toThrow("no longer current");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toEqual(context());
    expect(Object.isFrozen(checked[0])).toBe(true);
    expect(Object.isFrozen(checked[0]?.principal)).toBe(true);
    expect(Object.isFrozen(checked[0]?.node)).toBe(true);
  });

  it("fails closed without leaking a lifecycle checker error", async () => {
    const { authorization, host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), {
      isCurrent() {
        throw new Error("private lifecycle failure");
      },
    });

    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-lifecycle-error",
      }),
    ).rejects.toThrow("closed or no longer current");
    await expect(
      runtime.stat({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-lifecycle-error-two",
      }),
    ).rejects.not.toThrow("private lifecycle failure");
    expect(authorization.calls).toHaveLength(0);
    expect(safeFs.roots).toHaveLength(0);
  });

  it("waits for a blocked write and rejects its late completion after replacement", async () => {
    const gate = deferred();
    const { host, safeFs } = createHarness(true, (fs) => {
      fs.writeGate = gate.promise;
    });
    const runtime = host.createRuntime(context(), lifecycle());
    const write = runtime.write({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-write",
      bytes: new Uint8Array([1]),
      expectedModifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await waitUntil(() => safeFs.writes === 1);

    const cleanup = runtime.cleanup("generation-replaced");
    expect(cleanup).toBe(runtime.cleanup("session-closed"));
    let settled = false;
    cleanup.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    await expect(write).rejects.toThrow("no longer current");
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("closes one late read handle and waits for the blocked open", async () => {
    const gate = deferred();
    const { host, safeFs } = createHarness(true, (fs) => {
      fs.readGate = gate.promise;
    });
    const runtime = host.createRuntime(context(), lifecycle());
    const opening = runtime.openRead({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-read",
    });
    await waitUntil(() => safeFs.reads.length === 1);

    const cleanup = runtime.cleanup("generation-replaced");
    let settled = false;
    cleanup.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    await expect(opening).rejects.toThrow("no longer current");
    await expect(cleanup).resolves.toBeUndefined();
    expect(safeFs.handles).toHaveLength(1);
    expect(safeFs.handles[0]?.closed).toBe(1);
    expect(safeFs.rootHandles[0]?.closed).toBe(1);
  });

  it("waits for a published capability read before closing its handle", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const capability = await runtime.openRead({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-published-read",
    });
    const gate = deferred();
    const handle = safeFs.handles[0];
    if (!handle) throw new Error("Expected a safe read handle.");
    handle.readGate = gate.promise;

    const reading = capability.read(0, 5);
    await waitUntil(() => handle.readCalls === 1);
    const cleanup = runtime.cleanup("generation-replaced");
    let cleanupSettled = false;
    cleanup.finally(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(handle.closed).toBe(0);
    gate.resolve();

    await expect(reading).rejects.toThrow("closed or no longer current");
    await expect(cleanup).resolves.toBeUndefined();
    expect(handle.closed).toBe(1);
    await expect(capability.close()).resolves.toBeUndefined();
    expect(handle.closed).toBe(1);
  });

  it("waits for a blocked HTTP capability read before closing its handle", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-http-read",
    });
    const capability = await host.createHttpConsumer().consume({
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });
    if (!capability) throw new Error("Expected an HTTP read capability.");
    const gate = deferred();
    const handle = safeFs.handles.at(-1);
    if (!handle) throw new Error("Expected a safe HTTP read handle.");
    handle.readGate = gate.promise;

    const reading = capability.read(0, 5);
    await waitUntil(() => handle.readCalls === 1);
    const cleanup = runtime.cleanup("generation-replaced");
    let cleanupSettled = false;
    cleanup.then(() => {
      cleanupSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    expect(handle.closed).toBe(0);
    gate.resolve();

    await expect(reading).rejects.toThrow("closed or no longer current");
    await expect(cleanup).resolves.toBeUndefined();
    expect(handle.closed).toBe(1);
    await expect(capability.read(0, 1)).rejects.toThrow("closed or no longer current");
    await expect(capability.close()).resolves.toBeUndefined();
    expect(handle.closed).toBe(1);
  });

  it("shares one blocked HTTP teardown across concurrent session and credential cleanup", async () => {
    const { host, safeFs } = createHarness();
    const runtimeContext = context();
    const runtime = host.createRuntime(runtimeContext, lifecycle());
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-http-shared-cleanup",
    });
    const capability = await host.createHttpConsumer().consume({
      context: runtimeContext,
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });
    if (!capability) throw new Error("Expected an HTTP read capability.");
    const gate = deferred();
    const handle = safeFs.handles.at(-1);
    if (!handle) throw new Error("Expected a safe HTTP read handle.");
    handle.readGate = gate.promise;

    const reading = capability.read(0, 1);
    await waitUntil(() => handle.readCalls === 1);
    const sessionCleanup = runtime.cleanup("session-closed");
    const credentialCleanup = host.cleanupCredential(runtimeContext);
    let settled = 0;
    for (const cleanup of [sessionCleanup, credentialCleanup]) {
      cleanup.then(() => {
        settled += 1;
        return undefined;
      });
    }
    await Promise.resolve();
    expect(settled).toBe(0);
    expect(handle.closed).toBe(0);
    gate.resolve();

    await expect(reading).rejects.toThrow("closed or no longer current");
    await expect(Promise.all([sessionCleanup, credentialCleanup])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(handle.closed).toBe(1);
    await expect(capability.close()).resolves.toBeUndefined();
    expect(handle.closed).toBe(1);
  });

  it("preserves an HTTP read failure while cleanup exposes one close failure", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const issued = await runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-http-close-error",
    });
    const capability = await host.createHttpConsumer().consume({
      context: context(),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: issued.token,
    });
    if (!capability) throw new Error("Expected an HTTP read capability.");
    const closeError = new Error("HTTP handle close failed");
    const readError = new Error("HTTP read failed");
    const gate = deferred();
    const handle = safeFs.handles.at(-1);
    if (!handle) throw new Error("Expected a safe HTTP read handle.");
    handle.readGate = gate.promise;
    handle.readError = readError;
    handle.closeError = closeError;

    const reading = capability.read(0, 1);
    await waitUntil(() => handle.readCalls === 1);
    const cleanup = runtime.cleanup("session-closed");
    expect(handle.closed).toBe(0);
    gate.resolve();

    await expect(reading).rejects.toBe(readError);
    const cleanupError = await cleanup.catch((error: unknown) => error);
    expect(flattenAggregateErrors(cleanupError)).toContain(closeError);
    expect(handle.closed).toBe(1);
    await expect(capability.close()).rejects.toBe(closeError);
    expect(handle.closed).toBe(1);
  });

  it("preserves a blocked read failure while cleanup exposes one close failure", async () => {
    const { host, safeFs } = createHarness();
    const runtime = host.createRuntime(context(), lifecycle());
    const capability = await runtime.openRead({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-read-close-failures",
    });
    const gate = deferred();
    const readError = new Error("primary read failure");
    const closeError = new Error("secondary close failure");
    const handle = safeFs.handles[0];
    if (!handle) throw new Error("Expected a safe read handle.");
    handle.readGate = gate.promise;
    handle.readError = readError;
    handle.closeError = closeError;

    const reading = capability.read(0, 5);
    await waitUntil(() => handle.readCalls === 1);
    const cleanup = runtime.cleanup("session-closed");
    expect(handle.closed).toBe(0);
    gate.resolve();

    await expect(reading).rejects.toBe(readError);
    const cleanupError = await cleanup.catch((error: unknown) => error);
    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([closeError]);
    expect(handle.closed).toBe(1);
    await expect(capability.close()).rejects.toBe(closeError);
    expect(handle.closed).toBe(1);
  });

  it("disposes one late watch and waits for its blocked creation", async () => {
    const gate = deferred();
    const { host, safeFs } = createHarness(true, (fs) => {
      fs.watchGate = gate.promise;
    });
    const runtime = host.createRuntime(context(), lifecycle());
    const watching = runtime.watch(
      {
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-watch",
      },
      () => undefined,
    );
    await waitUntil(() => safeFs.watches === 1);

    const cleanup = runtime.cleanup("generation-replaced");
    let settled = false;
    cleanup.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    await expect(watching).rejects.toThrow("no longer current");
    await expect(cleanup).resolves.toBeUndefined();
    expect(safeFs.watchDisposals).toBe(1);
    expect(safeFs.rootHandles[0]?.closed).toBe(1);
  });

  it("burns a token issued after replacement and waits for the blocked resolver", async () => {
    const gate = deferred();
    const { host, randomRequests, safeFs } = createHarness(true, (fs) => {
      fs.statGate = { call: 2, promise: gate.promise };
    });
    const runtime = host.createRuntime(context(), lifecycle());
    const issuing = runtime.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-download",
    });
    await waitUntil(() => safeFs.stats.length === 2);

    const cleanup = runtime.cleanup("generation-replaced");
    let settled = false;
    cleanup.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    await expect(issuing).rejects.toThrow("no longer current");
    await expect(cleanup).resolves.toBeUndefined();
    expect(randomRequests()).toBe(0);
    const statCalls = safeFs.stats.length;
    await expect(
      host.createHttpConsumer().consume({
        context: context(),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: Buffer.alloc(32, 1).toString("base64url"),
      }),
    ).resolves.toBeNull();
    expect(safeFs.stats).toHaveLength(statCalls);
  });

  it.each(["credential", "grant", "principal"] as const)(
    "$kind cleanup invalidates and waits for a blocked token issue",
    async (kind) => {
      const gate = deferred();
      const { host, randomRequests, safeFs } = createHarness(true, (fs) => {
        fs.statGate = { call: 2, promise: gate.promise };
      });
      const runtimeContext = context();
      const runtime = host.createRuntime(runtimeContext, lifecycle());
      const issuing = runtime.issueDownloadToken({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: `request-${kind}-blocked-download`,
      });
      await waitUntil(() => safeFs.stats.length === 2);

      const cleanup = cleanupHostScope(host, kind, runtimeContext);
      let cleanupSettled = false;
      cleanup.then(() => {
        cleanupSettled = true;
        return undefined;
      });
      await Promise.resolve();
      expect(cleanupSettled).toBe(false);
      expect(randomRequests()).toBe(0);
      gate.resolve();

      await expect(issuing).rejects.toThrow("no longer current");
      await expect(cleanup).resolves.toBeUndefined();
      expect(randomRequests()).toBe(0);
    },
  );

  it("burns only active tokens for the cleaned runtime generation", async () => {
    const { host } = createHarness();
    const first = host.createRuntime(context("generation-one"), lifecycle());
    const second = host.createRuntime(context("generation-two"), lifecycle());
    const firstIssue = await first.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-first-download",
    });
    const secondIssue = await second.issueDownloadToken({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-second-download",
    });

    await first.cleanup("generation-replaced");
    const consumer = host.createHttpConsumer();
    await expect(
      consumer.consume({
        context: context("generation-one"),
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: firstIssue.token,
      }),
    ).resolves.toBeNull();
    const survivor = await consumer.consume({
      context: context("generation-two"),
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      token: secondIssue.token,
    });
    expect(survivor).not.toBeNull();
    await survivor?.close();
    await second.cleanup("session-closed");
  });

  it.each(["credential", "grant", "principal"] as const)(
    "$kind cleanup closes only matching HTTP capabilities",
    async (kind) => {
      const { host, safeFs } = createHarness();
      const targetContext = context();
      const survivorContext = survivorContextFor(kind);
      const targetRuntime = host.createRuntime(targetContext, lifecycle());
      const survivorRuntime = host.createRuntime(survivorContext, lifecycle());
      const request = {
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-scope-capability",
      };
      const targetToken = await targetRuntime.issueDownloadToken(request);
      const survivorToken = await survivorRuntime.issueDownloadToken(request);
      const consumer = host.createHttpConsumer();
      const targetCapability = await consumer.consume({
        context: targetContext,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: targetToken.token,
      });
      const survivorCapability = await consumer.consume({
        context: survivorContext,
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        token: survivorToken.token,
      });
      if (!targetCapability || !survivorCapability) {
        throw new Error("Expected both HTTP capabilities.");
      }
      const targetHandle = safeFs.handles.at(-2);
      const survivorHandle = safeFs.handles.at(-1);
      if (!targetHandle || !survivorHandle) throw new Error("Expected safe HTTP handles.");
      const readGate = deferred();
      targetHandle.readGate = readGate.promise;
      const targetRead = targetCapability.read(0, 1);
      await waitUntil(() => targetHandle.readCalls === 1);

      const cleanup = cleanupHostScope(host, kind, targetContext);
      let cleanupSettled = false;
      cleanup.then(() => {
        cleanupSettled = true;
        return undefined;
      });
      await Promise.resolve();
      expect(cleanupSettled).toBe(false);
      expect(targetHandle.closed).toBe(0);
      readGate.resolve();

      await expect(targetRead).rejects.toThrow("closed or no longer current");
      await expect(cleanup).resolves.toBeUndefined();
      await expect(survivorCapability.read(0, 1)).resolves.toEqual(new TextEncoder().encode("h"));
      expect(targetHandle.closed).toBe(1);
      expect(survivorHandle.closed).toBe(0);
      await targetCapability.close();
      expect(targetHandle.closed).toBe(1);
      await survivorCapability.close();
      await survivorRuntime.cleanup("session-closed");
    },
  );
});

function flattenAggregateErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(flattenAggregateErrors);
}
