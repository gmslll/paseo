import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthorizedWorkspace,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import { afterEach, describe, expect, it } from "vitest";
import { FileUploadStore } from "../../file-upload/index.js";
import type {
  EnterpriseUploadCapability,
  EnterpriseUploadAppendInput,
  EnterpriseUploadCleanupInput,
  EnterpriseUploadFinalizedTarget,
  EnterpriseUploadFinalizeInput,
  EnterpriseUploadIssueInput,
  EnterpriseUploadSafeFsPort,
} from "./enterprise-upload-policy.js";
import { EnterpriseUploadPolicy } from "./enterprise-upload-policy.js";
import { EnterpriseUploadStore } from "./enterprise-upload-store.js";

const WORKSPACE_ID = "workspace-one";
const RELATIVE_PATH = "uploads/report.csv";
const tempDirs: string[] = [];

function principal(): PrincipalContext {
  return {
    principalType: "human",
    principalId: "usr_0123456789abcdef",
    organizationId: "org_0123456789abcdef",
    credentialId: "credential-one",
    grantVersion: "grant-one",
    grants: [
      {
        action: "workspace.write",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

function node(): NodeContext {
  return { nodeId: "nod_0123456789abcdef", paseoServerId: "server-one", mode: "standalone" };
}

function workspace(): AuthorizedWorkspace {
  return {
    organizationId: principal().organizationId,
    nodeId: node().nodeId,
    ownerPrincipalId: principal().principalId,
    createdByPrincipalId: principal().principalId,
    workspaceId: WORKSPACE_ID,
  };
}

class TestPolicy {
  public readonly issued: EnterpriseUploadIssueInput[] = [];
  public readonly appended: EnterpriseUploadAppendInput[] = [];
  public readonly finalized: EnterpriseUploadFinalizeInput[] = [];
  public readonly aborted: EnterpriseUploadFinalizeInput[] = [];
  public readonly cleanups: EnterpriseUploadCleanupInput[] = [];
  public issueError: unknown;
  public abortError: unknown;
  public cleanupError: unknown;
  public cleanupGate: Promise<void> | undefined;

  public async issue(input: EnterpriseUploadIssueInput) {
    this.issued.push(input);
    if (this.issueError !== undefined) throw this.issueError;
    return { uploadId: "upload-token", expiresAt: 2_000 };
  }

  public async append(input: EnterpriseUploadAppendInput): Promise<boolean> {
    this.appended.push(input);
    return true;
  }

  public async finalize(input: EnterpriseUploadFinalizeInput) {
    this.finalized.push(input);
    return {
      uploadId: input.uploadId,
      workspace: workspace(),
      relativePath: input.relativePath,
      fileIdentity: { dev: 1, ino: 2, size: 5, mtimeMs: 3 },
    };
  }

  public async abort(input: EnterpriseUploadFinalizeInput): Promise<boolean> {
    this.aborted.push(input);
    if (this.abortError !== undefined) throw this.abortError;
    return true;
  }

  public async cleanup(input: EnterpriseUploadCleanupInput) {
    this.cleanups.push(input);
    await this.cleanupGate;
    if (this.cleanupError !== undefined) throw this.cleanupError;
    return { cleaned: 1 };
  }
}

class BlockingPrepareSafeFs implements EnterpriseUploadSafeFsPort {
  public readonly releaseReady = true;
  public readonly supportsDirectoryRelativeOperations = true;
  public prepareSignal: AbortSignal | null = null;
  public abortCalls = 0;
  public readonly prepareStarted: Promise<void>;
  public readonly prepareGate: Promise<void>;
  private resolvePrepareStarted!: () => void;
  private resolvePrepareGate!: () => void;

  public constructor() {
    this.prepareStarted = new Promise<void>((resolve) => {
      this.resolvePrepareStarted = resolve;
    });
    this.prepareGate = new Promise<void>((resolve) => {
      this.resolvePrepareGate = resolve;
    });
  }

  public releasePrepare(): void {
    this.resolvePrepareGate();
  }

  public async prepare(input: {
    readonly workspace: AuthorizedWorkspace;
    readonly relativePath: string;
    readonly signal: AbortSignal;
  }): Promise<EnterpriseUploadCapability> {
    this.prepareSignal = input.signal;
    this.resolvePrepareStarted();
    await this.prepareGate;
    return {
      capabilityId: "safe-upload-capability",
      organizationId: input.workspace.organizationId,
      nodeId: input.workspace.nodeId,
      workspaceId: input.workspace.workspaceId,
      relativePath: input.relativePath,
      directoryIdentity: { dev: 1, ino: 1 },
    };
  }

  public async append(): Promise<void> {}

  public async finalize(
    capability: EnterpriseUploadCapability,
  ): Promise<EnterpriseUploadFinalizedTarget> {
    return { ...capability, fileIdentity: { dev: 1, ino: 2, size: 5, mtimeMs: 3 } };
  }

  public commit(): true {
    return true;
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }
}

describe("EnterpriseUploadStore", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the binary lifecycle on canonical workspace input and returns no absolute path", async () => {
    const policy = new TestPolicy();
    const stagingCalls: unknown[] = [];
    const enterprise = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
      createStagingRelativePath: (input) => {
        stagingCalls.push(input);
        return RELATIVE_PATH;
      },
    });
    const paseoHome = makePaseoHome();
    const store = new FileUploadStore({ paseoHome, enterprise });

    store.beginEnterpriseStagedUpload({
      workspaceId: WORKSPACE_ID,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await expect(
      store.receiveEnterpriseFrame(frame(FileTransferOpcode.FileBegin)),
    ).resolves.toBeNull();
    await expect(
      store.receiveEnterpriseFrame(
        frame(FileTransferOpcode.FileChunk, new TextEncoder().encode("hello")),
      ),
    ).resolves.toBeNull();
    const frameResult = await store.receiveEnterpriseFrame(frame(FileTransferOpcode.FileEnd));
    const result = frameResult?.response;

    expect(policy.issued[0]).toEqual({
      principal: principal(),
      node: node(),
      sessionBindingGeneration: "generation-one",
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
    });
    expect(stagingCalls).toEqual([
      {
        context: {
          principal: principal(),
          node: node(),
          sessionBindingGeneration: "generation-one",
        },
        workspaceId: WORKSPACE_ID,
        requestId: "request-one",
      },
    ]);
    expect(policy.appended[0]).toMatchObject({
      uploadId: "upload-token",
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      offset: 0,
      bytes: new TextEncoder().encode("hello"),
    });
    expect(result?.payload.file).toMatchObject({
      id: "upload-token",
      uploadId: "upload-token",
      workspaceId: WORKSPACE_ID,
      path: RELATIVE_PATH,
    });
    expect(frameResult?.workspaceId).toBe(WORKSPACE_ID);
    expect(Object.hasOwn(result?.payload.file ?? {}, "absolutePath")).toBe(false);
    expect(existsSync(join(paseoHome, "uploads"))).toBe(false);
  });

  it.each(["/etc/passwd", "uploads/../secret", "C:\\secret.txt"])(
    "rejects unsafe relative path %s before policy access",
    (relativePath) => {
      const policy = new TestPolicy();
      const store = new EnterpriseUploadStore({
        context: {
          principal: principal(),
          node: node(),
          sessionBindingGeneration: "generation-one",
        },
        policy,
        safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
      });

      expect(() =>
        store.begin({
          workspaceId: WORKSPACE_ID,
          relativePath,
          requestId: "request-one",
          fileName: "report.csv",
          mimeType: "text/csv",
          size: 5,
          modifiedAt: "2026-09-10T00:00:00.000Z",
        }),
      ).toThrow();
      expect(policy.issued).toHaveLength(0);
    },
  );

  it("passes exact generation cleanup and rejects frames after disconnect", async () => {
    const policy = new TestPolicy();
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
    });
    store.begin({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });

    await store.cleanup("generation-replaced");

    expect(policy.cleanups).toEqual([
      {
        reason: "generation-replaced",
        organizationId: principal().organizationId,
        node: node(),
        principalId: principal().principalId,
        credentialId: principal().credentialId,
        grantVersion: principal().grantVersion,
        sessionBindingGeneration: "generation-one",
      },
    ]);
    await expect(store.receiveFrame(frame(FileTransferOpcode.FileBegin))).resolves.toBeNull();
    expect(policy.appended).toHaveLength(0);
    expect(policy.finalized).toHaveLength(0);
  });

  it("rejects a duplicate requestId without replacing the original upload", async () => {
    const policy = new TestPolicy();
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
    });
    const original = {
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    };
    store.begin(original);

    expect(() => store.begin({ ...original, relativePath: "uploads/replacement.csv" })).toThrow(
      "access denied",
    );
    await store.receiveFrame(frame(FileTransferOpcode.FileBegin));
    await store.receiveFrame(
      frame(FileTransferOpcode.FileChunk, new TextEncoder().encode("hello")),
    );
    const result = await store.receiveFrame(frame(FileTransferOpcode.FileEnd));

    expect(policy.issued).toHaveLength(1);
    expect(policy.aborted).toHaveLength(0);
    expect(result?.payload.file?.path).toBe(RELATIVE_PATH);
  });

  it("observes an issue rejection and reports it through shared cleanup", async () => {
    const policy = new TestPolicy();
    policy.issueError = new Error("issue failed");
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
    });
    store.begin({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });

    await expect(store.receiveFrame(frame(FileTransferOpcode.FileBegin))).resolves.toMatchObject({
      payload: { error: "Upload access denied." },
    });
    const first = store.cleanup("session-closed");
    const second = store.cleanup("generation-replaced");
    expect(first).toBe(second);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
  });

  it("closes synchronously and shares a blocked cleanup promise", async () => {
    let releaseCleanup!: () => void;
    const policy = new TestPolicy();
    policy.cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
    });
    const first = store.cleanup("session-closed");
    const second = store.cleanup("generation-replaced");

    expect(first).toBe(second);
    expect(() =>
      store.begin({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-one",
        fileName: "report.csv",
        mimeType: "text/csv",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      }),
    ).toThrow("closed");
    releaseCleanup();
    await expect(first).resolves.toBeUndefined();
    expect(policy.cleanups).toHaveLength(1);
  });

  it("preserves abort and cleanup failures for the cleanup caller", async () => {
    const policy = new TestPolicy();
    policy.abortError = new Error("abort failed");
    policy.cleanupError = new Error("cleanup failed");
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: true, supportsDirectoryRelativeOperations: true },
    });
    store.begin({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await expect(
      store.receiveFrame(frame(FileTransferOpcode.FileChunk, new Uint8Array([1]))),
    ).resolves.toMatchObject({ payload: { error: "Upload cleanup failed." } });

    await expect(store.cleanup("session-closed")).rejects.toMatchObject({
      errors: expect.arrayContaining([policy.abortError, policy.cleanupError]),
    });
  });

  it("does not call the upload policy when safe-FS is not release ready", () => {
    const policy = new TestPolicy();
    let stagingCalls = 0;
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs: { releaseReady: false, supportsDirectoryRelativeOperations: true },
      createStagingRelativePath: () => {
        stagingCalls += 1;
        return RELATIVE_PATH;
      },
    });

    expect(() =>
      store.begin({
        workspaceId: WORKSPACE_ID,
        relativePath: RELATIVE_PATH,
        requestId: "request-one",
        fileName: "report.csv",
        mimeType: "text/csv",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      }),
    ).toThrow("access denied");
    expect(() =>
      store.beginStaged({
        workspaceId: WORKSPACE_ID,
        requestId: "request-staged",
        fileName: "report.csv",
        mimeType: "text/csv",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      }),
    ).toThrow("access denied");
    expect(policy.issued).toHaveLength(0);
    expect(stagingCalls).toBe(0);
  });

  it("captures policy, readiness, and staging dependencies at construction", async () => {
    const policy = new TestPolicy();
    const safeFs = { releaseReady: true, supportsDirectoryRelativeOperations: true };
    const options = {
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs,
      createStagingRelativePath: () => RELATIVE_PATH,
    };
    const store = new EnterpriseUploadStore(options);
    safeFs.releaseReady = false;
    policy.issue = async () => {
      throw new Error("mutated issue");
    };
    options.createStagingRelativePath = () => "/mutated/absolute/path";

    store.beginStaged({
      workspaceId: WORKSPACE_ID,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await store.receiveFrame(frame(FileTransferOpcode.FileBegin));
    await store.receiveFrame(
      frame(FileTransferOpcode.FileChunk, new TextEncoder().encode("hello")),
    );
    const result = await store.receiveFrame(frame(FileTransferOpcode.FileEnd));

    expect(result?.payload.file?.path).toBe(RELATIVE_PATH);
    expect(policy.issued).toHaveLength(1);
  });

  it("invalidates a blocked policy issue immediately and prevents late publication", async () => {
    const safeFs = new BlockingPrepareSafeFs();
    const policy = new EnterpriseUploadPolicy({
      ttlMs: 60_000,
      capacity: 4,
      authorization: {
        assertWorkspace: async () => workspace(),
      },
      safeFs,
      clock: { now: () => 1_000 },
      randomSource: { randomBytes: (size) => new Uint8Array(size).fill(1) },
    });
    const store = new EnterpriseUploadStore({
      context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
      policy,
      safeFs,
    });
    store.begin({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      requestId: "request-one",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    await safeFs.prepareStarted;

    const cleanup = store.cleanup("generation-replaced");
    expect(cleanup).toBe(store.cleanup("session-closed"));
    expect(safeFs.prepareSignal?.aborted).toBe(true);
    let settled = false;
    cleanup.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    safeFs.releasePrepare();

    await expect(cleanup).resolves.toBeUndefined();
    expect(safeFs.abortCalls).toBe(1);
    await expect(store.receiveFrame(frame(FileTransferOpcode.FileBegin))).resolves.toBeNull();
  });
});

function makePaseoHome(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "enterprise-upload-store-")));
  tempDirs.push(directory);
  return directory;
}

function frame(opcode: FileTransferOpcode, payload?: Uint8Array): FileTransferFrame {
  const decoded = decodeFileTransferFrame(
    encodeFileTransferFrame({
      opcode,
      requestId: "request-one",
      payload,
      metadata:
        opcode === FileTransferOpcode.FileBegin
          ? {
              mime: "text/csv",
              size: 5,
              encoding: "binary",
              modifiedAt: "2026-09-10T00:00:00.000Z",
              fileName: "report.csv",
            }
          : undefined,
    }),
  );
  if (!decoded) throw new Error("Expected file transfer frame.");
  return decoded;
}
