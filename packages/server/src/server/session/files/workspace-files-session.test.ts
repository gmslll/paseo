import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WorkspaceFilesSession,
  type WorkspaceFilesSessionHost,
} from "./workspace-files-session.js";
import { DownloadTokenStore } from "../../file-download/token-store.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { EnterpriseFileUploadBeginInput } from "../../file-upload/index.js";
import type { EnterpriseStagedFileUploadBeginInput } from "../../file-upload/index.js";
import type { EnterpriseWorkspaceFilesRuntime } from "../../enterprise/runtime/workspace-files-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeSubsystem(
  options: {
    hasBinaryChannel?: boolean;
    emitBinary?: (frame: Uint8Array) => Promise<void> | void;
    enterpriseRuntime?: EnterpriseWorkspaceFilesRuntime;
  } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const binary: Uint8Array[] = [];
  let hasBinary = options.hasBinaryChannel ?? false;
  const host: WorkspaceFilesSessionHost = {
    emit: (msg) => emitted.push(msg),
    emitBinary: async (frame) => {
      binary.push(frame);
      await options.emitBinary?.(frame);
    },
    hasBinaryChannel: () => hasBinary,
  };
  const paseoHome = makeDir("workspace-files-home-");
  const subsystem = new WorkspaceFilesSession({
    host,
    downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
    paseoHome,
    logger: pino({ level: "silent" }),
    enterpriseRuntime: options.enterpriseRuntime,
  });
  return {
    subsystem,
    emitted,
    binary,
    paseoHome,
    setHasBinary: (value: boolean) => {
      hasBinary = value;
    },
  };
}

class TestEnterpriseRuntime implements EnterpriseWorkspaceFilesRuntime {
  public readonly listCalls: unknown[] = [];
  public readonly downloadCalls: unknown[] = [];
  public readonly uploadBegins: EnterpriseFileUploadBeginInput[] = [];
  public readonly stagedUploadBegins: EnterpriseStagedFileUploadBeginInput[] = [];
  public readonly cleanupCalls: Array<"session-closed" | "generation-replaced"> = [];
  public watchCalls = 0;
  public statCalls = 0;
  public watchDisposeCalls = 0;
  public readonly statGates: Array<Promise<void> | undefined> = [];
  public readonly watchGates: Array<Promise<void> | undefined> = [];
  public readonly watchCallbacks: Array<() => void> = [];
  public watchDisposeGate: Promise<void> | undefined;
  public watchDisposeError: unknown;
  public cleanupError: unknown;

  public async stat() {
    const call = this.statCalls;
    this.statCalls += 1;
    await this.statGates[call];
    return { kind: "file" as const, dev: 1, ino: 2, size: 5, mtimeMs: 1_000 };
  }

  public async list(input: unknown) {
    this.listCalls.push(input);
    return [
      {
        kind: "file" as const,
        dev: 1,
        ino: 2,
        size: 5,
        mtimeMs: 1_000,
        relativePath: "reports/quarter.csv",
        name: "quarter.csv",
      },
    ];
  }

  public async openRead() {
    return {
      kind: "file" as const,
      dev: 1,
      ino: 2,
      size: 5,
      mtimeMs: 1_000,
      workspaceId: "workspace-one",
      relativePath: "reports/quarter.csv",
      read: async (offset: number, length: number) =>
        new TextEncoder().encode("hello").subarray(offset, offset + length),
      close: async () => undefined,
    };
  }

  public async write(): Promise<void> {}
  public async create(): Promise<void> {}
  public async rename(): Promise<void> {}
  public async copy(): Promise<void> {}
  public async delete(): Promise<void> {}

  public async watch(_input: unknown, onChange: () => void) {
    const call = this.watchCalls;
    this.watchCalls += 1;
    this.watchCallbacks.push(onChange);
    await this.watchGates[call];
    return {
      [Symbol.asyncDispose]: async () => {
        this.watchDisposeCalls += 1;
        await this.watchDisposeGate;
        if (this.watchDisposeError !== undefined) throw this.watchDisposeError;
      },
    };
  }

  public async issueDownloadToken(input: unknown) {
    this.downloadCalls.push(input);
    return {
      kind: "file" as const,
      dev: 1,
      ino: 2,
      size: 5,
      mtimeMs: 1_000,
      workspaceId: "workspace-one",
      relativePath: "reports/quarter.csv",
      token: "download-token",
      expiresAt: 2_000,
    };
  }

  public createUploadStore() {
    return {
      begin: (input: EnterpriseFileUploadBeginInput) => this.uploadBegins.push(input),
      beginStaged: (input: EnterpriseStagedFileUploadBeginInput) =>
        this.stagedUploadBegins.push(input),
      receiveFrame: async () => null,
      cleanup: async () => undefined,
    };
  }

  public async cleanup(reason: "session-closed" | "generation-replaced"): Promise<void> {
    this.cleanupCalls.push(reason);
    if (this.cleanupError !== undefined) throw this.cleanupError;
  }
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

function uploadFrame(args: Parameters<typeof encodeFileTransferFrame>[0]): FileTransferFrame {
  const frame = decodeFileTransferFrame(encodeFileTransferFrame(args));
  if (!frame) {
    throw new Error("Expected a file transfer frame");
  }
  return frame;
}

describe("WorkspaceFilesSession", () => {
  test("enterprise explorer dispatch ignores cwd and sends only workspace-relative input", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, emitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "/caller/claimed/root",
      workspaceId: "workspace-one",
      path: "reports",
      mode: "list",
      requestId: "request-enterprise-list",
    });

    expect(enterpriseRuntime.listCalls).toEqual([
      {
        workspaceId: "workspace-one",
        relativePath: "reports",
        requestId: "request-enterprise-list",
      },
    ]);
    expect(JSON.stringify(enterpriseRuntime.listCalls)).not.toContain("caller/claimed/root");
    expect(emitted[0]).toMatchObject({
      type: "file_explorer_response",
      payload: { cwd: "", path: "reports", error: null },
    });
  });

  test("enterprise explorer fails closed without workspaceId and never calls the runtime", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, emitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "/caller/claimed/root",
      path: "/etc/passwd",
      mode: "file",
      requestId: "request-enterprise-denied",
    });

    expect(enterpriseRuntime.listCalls).toHaveLength(0);
    expect(emitted[0]).toMatchObject({
      type: "file_explorer_response",
      payload: { cwd: "", error: "Enterprise file access denied." },
    });
  });

  test("enterprise download token dispatch never touches the legacy absolute-path store", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, emitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd: "/caller/claimed/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      requestId: "request-enterprise-download",
    });

    expect(enterpriseRuntime.downloadCalls).toEqual([
      {
        workspaceId: "workspace-one",
        relativePath: "reports/quarter.csv",
        requestId: "request-enterprise-download",
      },
    ]);
    expect(emitted[0]).toMatchObject({
      type: "file_download_token_response",
      payload: { cwd: "", token: "download-token", path: "reports/quarter.csv" },
    });
    expect(JSON.stringify(emitted[0])).not.toContain("caller/claimed/root");
  });

  test("enterprise upload uses server staging for the wire shape and keeps explicit paths typed", () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, emitted } = makeSubsystem({ enterpriseRuntime });

    subsystem.handleFileUploadRequest({
      type: "file.upload.request",
      workspaceId: "workspace-one",
      fileName: "quarter.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
      requestId: "request-old-upload-shape",
    });
    subsystem.handleEnterpriseFileUploadRequest({
      workspaceId: "workspace-one",
      relativePath: "uploads/quarter.csv",
      fileName: "quarter.csv",
      mimeType: "text/csv",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
      requestId: "request-enterprise-upload",
    });

    expect(emitted).toHaveLength(0);
    expect(enterpriseRuntime.stagedUploadBegins).toEqual([
      {
        workspaceId: "workspace-one",
        fileName: "quarter.csv",
        mimeType: "text/csv",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
        requestId: "request-old-upload-shape",
      },
    ]);
    expect(enterpriseRuntime.uploadBegins).toEqual([
      {
        workspaceId: "workspace-one",
        relativePath: "uploads/quarter.csv",
        fileName: "quarter.csv",
        mimeType: "text/csv",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
        requestId: "request-enterprise-upload",
      },
    ]);
  });

  test("enterprise watch replacement waits for exactly-once async teardown", async () => {
    let releaseDispose!: () => void;
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem } = makeSubsystem({ enterpriseRuntime });
    const request = {
      type: "fs.file.subscribe.request" as const,
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-one",
    };
    await subsystem.handleFileSubscribeRequest(request);
    enterpriseRuntime.watchDisposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });

    const replacement = subsystem.handleFileSubscribeRequest({
      ...request,
      requestId: "request-two",
    });
    await Promise.resolve();
    expect(enterpriseRuntime.watchCalls).toBe(1);
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
    releaseDispose();
    await replacement;
    expect(enterpriseRuntime.watchCalls).toBe(2);
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
  });

  test("enterprise unsubscribe and cleanup share exactly-once teardown", async () => {
    let releaseDispose!: () => void;
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem } = makeSubsystem({ enterpriseRuntime });
    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-one",
    });
    enterpriseRuntime.watchDisposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });

    const unsubscribe = subsystem.handleFileUnsubscribeRequest({
      type: "fs.file.unsubscribe.request",
      subscriptionId: "subscription-one",
      requestId: "request-unsubscribe",
    });
    const cleanupOne = subsystem.cleanupEnterprise("session-closed");
    const cleanupTwo = subsystem.cleanupEnterprise("generation-replaced");
    expect(cleanupOne).toBe(cleanupTwo);
    await Promise.resolve();
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
    releaseDispose();

    await expect(unsubscribe).resolves.toBeUndefined();
    await expect(cleanupOne).resolves.toBeUndefined();
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
    expect(enterpriseRuntime.cleanupCalls).toEqual(["session-closed"]);
  });

  test("enterprise cleanup preserves watch and runtime teardown failures", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.watchDisposeError = new Error("watch cleanup failed");
    enterpriseRuntime.cleanupError = new Error("runtime cleanup failed");
    const { subsystem } = makeSubsystem({ enterpriseRuntime });
    await subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-one",
    });

    const cleanup = subsystem.dispose();
    expect(cleanup).toBe(subsystem.cleanupEnterprise("generation-replaced"));
    await expect(cleanup).rejects.toMatchObject({
      errors: expect.arrayContaining([
        enterpriseRuntime.watchDisposeError,
        enterpriseRuntime.cleanupError,
      ]),
    });
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
  });

  test("enterprise cleanup invalidates a subscription blocked in stat without a late emit", async () => {
    const statGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.statGates[0] = statGate.promise;
    const { emitted, subsystem } = makeSubsystem({ enterpriseRuntime });
    const subscribing = subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-one",
    });
    await waitUntil(() => enterpriseRuntime.statCalls === 1);

    const cleanup = subsystem.cleanupEnterprise("generation-replaced");
    let settled = false;
    cleanup.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    statGate.resolve();

    await expect(subscribing).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    expect(enterpriseRuntime.watchCalls).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("enterprise cleanup disposes a late watch once and preserves its failure", async () => {
    const watchGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.watchGates[0] = watchGate.promise;
    enterpriseRuntime.watchDisposeError = new Error("late watch dispose failed");
    const { emitted, subsystem } = makeSubsystem({ enterpriseRuntime });
    const subscribing = subsystem.handleFileSubscribeRequest({
      type: "fs.file.subscribe.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-one",
    });
    await waitUntil(() => enterpriseRuntime.watchCalls === 1);

    const cleanup = subsystem.cleanupEnterprise("generation-replaced");
    watchGate.resolve();

    await expect(subscribing).resolves.toBeUndefined();
    await expect(cleanup).rejects.toMatchObject({
      errors: expect.arrayContaining([enterpriseRuntime.watchDisposeError]),
    });
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
    enterpriseRuntime.watchCallbacks[0]?.();
    await Promise.resolve();
    expect(emitted).toEqual([]);
  });

  test("a replacement invalidates an older stat attempt before the new route starts", async () => {
    const oldStatGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.statGates[0] = oldStatGate.promise;
    const { emitted, subsystem } = makeSubsystem({ enterpriseRuntime });
    const request = {
      type: "fs.file.subscribe.request" as const,
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-old",
    };
    const old = subsystem.handleFileSubscribeRequest(request);
    await waitUntil(() => enterpriseRuntime.statCalls === 1);
    const replacement = subsystem.handleFileSubscribeRequest({
      ...request,
      requestId: "request-new",
    });
    oldStatGate.resolve();

    await expect(old).resolves.toBeUndefined();
    await expect(replacement).resolves.toBeUndefined();
    expect(enterpriseRuntime.statCalls).toBe(2);
    expect(enterpriseRuntime.watchCalls).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ payload: { requestId: "request-new" } });
    await subsystem.dispose();
  });

  test("a replacement waits for and disposes an older late watch before publishing", async () => {
    const oldWatchGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.watchGates[0] = oldWatchGate.promise;
    const { emitted, subsystem } = makeSubsystem({ enterpriseRuntime });
    const request = {
      type: "fs.file.subscribe.request" as const,
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-old",
    };
    const old = subsystem.handleFileSubscribeRequest(request);
    await waitUntil(() => enterpriseRuntime.watchCalls === 1);
    const replacement = subsystem.handleFileSubscribeRequest({
      ...request,
      requestId: "request-new",
    });
    oldWatchGate.resolve();

    await expect(old).resolves.toBeUndefined();
    await expect(replacement).resolves.toBeUndefined();
    expect(enterpriseRuntime.watchCalls).toBe(2);
    expect(enterpriseRuntime.watchDisposeCalls).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ payload: { requestId: "request-new" } });
    enterpriseRuntime.watchCallbacks[0]?.();
    await Promise.resolve();
    expect(emitted).toHaveLength(1);
    await subsystem.dispose();
    expect(enterpriseRuntime.watchDisposeCalls).toBe(2);
  });
  test("creates an entry and emits the complete success response", async () => {
    const cwd = makeDir("workspace-files-create-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd,
      parentPath: ".",
      name: "notes.txt",
      kind: "file",
      requestId: "req-create",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(true);
    expect(emitted).toEqual([
      {
        type: "fs.entry.create.response",
        payload: {
          cwd,
          parentPath: ".",
          path: "notes.txt",
          success: true,
          error: null,
          requestId: "req-create",
        },
      },
    ]);
  });

  test("passes entry creation errors through in the response", async () => {
    const cwd = makeDir("workspace-files-create-error-");
    writeFileSync(join(cwd, "notes.txt"), "existing");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd,
      parentPath: ".",
      name: "notes.txt",
      kind: "file",
      requestId: "req-create-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.create.response",
        payload: {
          cwd,
          parentPath: ".",
          path: null,
          success: false,
          error: '"notes.txt" already exists',
          requestId: "req-create-error",
        },
      },
    ]);
  });

  test("renames an entry and emits the resulting path", async () => {
    const cwd = makeDir("workspace-files-rename-");
    writeFileSync(join(cwd, "notes.txt"), "rename me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryRenameRequest({
      type: "fs.entry.rename.request",
      cwd,
      path: "notes.txt",
      name: "renamed.txt",
      requestId: "req-rename",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(false);
    expect(existsSync(join(cwd, "renamed.txt"))).toBe(true);
    expect(emitted).toEqual([
      {
        type: "fs.entry.rename.response",
        payload: {
          cwd,
          path: "notes.txt",
          renamedPath: "renamed.txt",
          success: true,
          error: null,
          requestId: "req-rename",
        },
      },
    ]);
  });

  test("passes entry rename errors through in the response", async () => {
    const cwd = makeDir("workspace-files-rename-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryRenameRequest({
      type: "fs.entry.rename.request",
      cwd,
      path: "missing.txt",
      name: "renamed.txt",
      requestId: "req-rename-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.rename.response",
        payload: {
          cwd,
          path: "missing.txt",
          renamedPath: null,
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-rename-error",
        },
      },
    ]);
  });

  test("duplicates an entry and emits the resulting path", async () => {
    const cwd = makeDir("workspace-files-duplicate-");
    writeFileSync(join(cwd, "notes.txt"), "duplicate me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDuplicateRequest({
      type: "fs.entry.duplicate.request",
      cwd,
      path: "notes.txt",
      requestId: "req-duplicate",
    });

    expect(readFileSync(join(cwd, "notes copy.txt"), "utf8")).toBe("duplicate me");
    expect(emitted).toEqual([
      {
        type: "fs.entry.duplicate.response",
        payload: {
          cwd,
          path: "notes.txt",
          duplicatedPath: "notes copy.txt",
          success: true,
          error: null,
          requestId: "req-duplicate",
        },
      },
    ]);
  });

  test("passes entry duplication errors through in the response", async () => {
    const cwd = makeDir("workspace-files-duplicate-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDuplicateRequest({
      type: "fs.entry.duplicate.request",
      cwd,
      path: "missing.txt",
      requestId: "req-duplicate-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.duplicate.response",
        payload: {
          cwd,
          path: "missing.txt",
          duplicatedPath: null,
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-duplicate-error",
        },
      },
    ]);
  });

  test("deletes an entry and emits the complete success response", async () => {
    const cwd = makeDir("workspace-files-delete-");
    writeFileSync(join(cwd, "notes.txt"), "delete me");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd,
      path: "notes.txt",
      requestId: "req-delete",
    });

    expect(existsSync(join(cwd, "notes.txt"))).toBe(false);
    expect(emitted).toEqual([
      {
        type: "fs.entry.delete.response",
        payload: {
          cwd,
          path: "notes.txt",
          success: true,
          error: null,
          requestId: "req-delete",
        },
      },
    ]);
  });

  test("passes entry deletion errors through in the response", async () => {
    const cwd = makeDir("workspace-files-delete-error-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd,
      path: "missing.txt",
      requestId: "req-delete-error",
    });

    expect(emitted).toEqual([
      {
        type: "fs.entry.delete.response",
        payload: {
          cwd,
          path: "missing.txt",
          success: false,
          error: "File or folder no longer exists",
          requestId: "req-delete-error",
        },
      },
    ]);
  });

  test("lists directory entries", async () => {
    const cwd = makeDir("workspace-files-list-");
    writeFileSync(join(cwd, "a.txt"), "alpha");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-list",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.directory).not.toBeNull();
  });

  test("reads file content inline when the client has no binary channel", async () => {
    const cwd = makeDir("workspace-files-read-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: false });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-read",
      acceptBinary: true,
    });

    expect(binary).toEqual([]);
    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_explorer_response") {
      throw new Error(`expected file_explorer_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.file).not.toBeNull();
  });

  test("streams binary frames when the client accepts binary and has a channel", async () => {
    const cwd = makeDir("workspace-files-binary-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-binary",
      acceptBinary: true,
    });

    expect(emitted).toEqual([]);
    expect(binary).toHaveLength(3);
    const opcodes = binary.map((frame) => decodeFileTransferFrame(frame)?.opcode);
    expect(opcodes).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileEnd,
    ]);
  });

  test("rejects an over-budget file before opening a binary transfer", async () => {
    const cwd = makeDir("workspace-files-read-budget-");
    writeFileSync(join(cwd, "notes.txt"), "hello world");
    const { subsystem, emitted, binary } = makeSubsystem({ hasBinaryChannel: true });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "notes.txt",
      mode: "file",
      requestId: "req-read-budget",
      acceptBinary: true,
      maxBytes: 5,
    });

    expect(binary).toEqual([]);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "file_explorer_response",
        payload: expect.objectContaining({ error: "File is too large to display" }),
      }),
    ]);
  });

  test("streams a real file larger than the socket limit as paced ordered chunks", async () => {
    const cwd = makeDir("workspace-files-large-binary-");
    const fileBytes = Buffer.alloc(8 * 1024 * 1024 + 123);
    for (let index = 0; index < fileBytes.length; index += 1) {
      fileBytes[index] = index % 251;
    }
    writeFileSync(join(cwd, "large.bin"), fileBytes);

    let releaseFirstChunk: (() => void) | undefined;
    const firstChunkSent = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });
    let chunkSends = 0;
    const { subsystem, emitted, binary } = makeSubsystem({
      hasBinaryChannel: true,
      emitBinary: async (frame) => {
        if (decodeFileTransferFrame(frame)?.opcode !== FileTransferOpcode.FileChunk) return;
        chunkSends += 1;
        if (chunkSends === 1) await firstChunkSent;
      },
    });

    const transfer = subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: "large.bin",
      mode: "file",
      requestId: "req-large-binary",
      acceptBinary: true,
    });

    await expect.poll(() => chunkSends).toBe(1);
    expect(binary.map((frame) => decodeFileTransferFrame(frame)?.opcode)).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
    ]);

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd,
      path: ".",
      mode: "list",
      requestId: "req-unrelated-list",
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "file_explorer_response",
        payload: expect.objectContaining({ requestId: "req-unrelated-list", error: null }),
      }),
    ]);

    releaseFirstChunk?.();
    await transfer;

    const frames = binary.map((frame) => decodeFileTransferFrame(frame));
    const chunks = frames.flatMap((frame) =>
      frame?.opcode === FileTransferOpcode.FileChunk ? [frame.payload] : [],
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(
      Buffer.compare(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), fileBytes),
    ).toBe(0);
    expect(frames.at(0)?.opcode).toBe(FileTransferOpcode.FileBegin);
    expect(frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(emitted).toHaveLength(1);
  }, 30_000);

  test("rejects an empty file-explorer cwd with an error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "  ",
      path: ".",
      mode: "list",
      requestId: "req-empty",
    });

    expect(emitted).toEqual([
      {
        type: "file_explorer_response",
        payload: expect.objectContaining({
          error: "cwd is required",
          directory: null,
          file: null,
          requestId: "req-empty",
        }),
      },
    ]);
  });

  test("issues a download token for a real file", async () => {
    const cwd = makeDir("workspace-files-token-");
    writeFileSync(join(cwd, "report.txt"), "hello world");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd,
      path: "report.txt",
      requestId: "req-token",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "file_download_token_response") {
      throw new Error(`expected file_download_token_response, got ${message.type}`);
    }
    expect(message.payload.error).toBeNull();
    expect(typeof message.payload.token).toBe("string");
    expect(message.payload.fileName).toBe("report.txt");
    expect(message.payload.size).toBe(11);
  });

  test("rejects an empty download-token cwd with an error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd: "",
      path: "report.txt",
      requestId: "req-token-empty",
    });

    expect(emitted).toEqual([
      {
        type: "file_download_token_response",
        payload: expect.objectContaining({
          token: null,
          error: "cwd is required",
          requestId: "req-token-empty",
        }),
      },
    ]);
  });

  test("responds to a project icon request", async () => {
    const cwd = makeDir("workspace-files-icon-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleProjectIconRequest({
      type: "project_icon_request",
      cwd,
      requestId: "req-icon",
    });

    expect(emitted).toHaveLength(1);
    const message = emitted[0];
    if (message.type !== "project_icon_response") {
      throw new Error(`expected project_icon_response, got ${message.type}`);
    }
    expect(message.payload.cwd).toBe(cwd);
    expect(message.payload.error).toBeNull();
  });

  test("round-trips an upload through transfer frames", async () => {
    const { subsystem, emitted, paseoHome } = makeSubsystem();

    subsystem.handleFileUploadRequest({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await subsystem.handleFileTransferFrame(
      uploadFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "req-upload",
        metadata: {
          mime: "text/plain",
          size: 11,
          encoding: "binary",
          modifiedAt: "2026-05-02T00:00:00.000Z",
          fileName: "notes.txt",
        },
      }),
    );
    await subsystem.handleFileTransferFrame(
      uploadFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "req-upload",
        payload: new TextEncoder().encode("hello world"),
      }),
    );
    await subsystem.handleFileTransferFrame(
      uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "req-upload" }),
    );

    const message = emitted.find((entry) => entry.type === "file.upload.response");
    if (message?.type !== "file.upload.response") {
      throw new Error("expected a file.upload.response message");
    }
    expect(message.payload.error).toBeNull();
    expect(message.payload.file?.fileName).toBe("notes.txt");
    expect(readFileSync(join(paseoHome, "uploads", "upload_req-upload", "notes.txt"), "utf8")).toBe(
      "hello world",
    );
  });
});
