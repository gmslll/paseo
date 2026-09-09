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
    enterpriseRequired?: boolean;
  } = {},
) {
  const emitted: SessionOutboundMessage[] = [];
  const legacyEmitted: SessionOutboundMessage[] = [];
  const binary: Uint8Array[] = [];
  const legacyBinary: Uint8Array[] = [];
  const enterpriseEmitted: Array<{
    message: SessionOutboundMessage;
    workspaceId: string;
    source?: object;
  }> = [];
  const enterpriseBinary: Array<{ frame: Uint8Array; workspaceId: string; source?: object }> = [];
  let hasBinary = options.hasBinaryChannel ?? false;
  const host: WorkspaceFilesSessionHost = {
    emit: (msg) => {
      emitted.push(msg);
      legacyEmitted.push(msg);
    },
    emitBinary: async (frame) => {
      binary.push(frame);
      legacyBinary.push(frame);
      await options.emitBinary?.(frame);
    },
    emitWorkspace: (message, workspaceId, source) => {
      emitted.push(message);
      enterpriseEmitted.push({ message, workspaceId, source });
    },
    emitBinaryWorkspace: async (frame, workspaceId, source) => {
      binary.push(frame);
      enterpriseBinary.push({ frame, workspaceId, source });
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
    enterpriseRequired: options.enterpriseRequired,
  });
  return {
    subsystem,
    emitted,
    legacyEmitted,
    binary,
    legacyBinary,
    enterpriseEmitted,
    enterpriseBinary,
    host,
    paseoHome,
    setHasBinary: (value: boolean) => {
      hasBinary = value;
    },
  };
}

class TestEnterpriseRuntime implements EnterpriseWorkspaceFilesRuntime {
  public readonly listCalls: unknown[] = [];
  public readonly writeCalls: unknown[] = [];
  public readonly createCalls: unknown[] = [];
  public readonly renameCalls: unknown[] = [];
  public readonly copyCalls: unknown[] = [];
  public readonly deleteCalls: unknown[] = [];
  public readonly downloadCalls: unknown[] = [];
  public readonly uploadBegins: EnterpriseFileUploadBeginInput[] = [];
  public readonly stagedUploadBegins: EnterpriseStagedFileUploadBeginInput[] = [];
  public readonly cleanupCalls: Array<"session-closed" | "generation-replaced"> = [];
  public openReadCalls = 0;
  public readCloseCalls = 0;
  public watchCalls = 0;
  public statCalls = 0;
  public watchDisposeCalls = 0;
  public readonly statGates: Array<Promise<void> | undefined> = [];
  public readonly watchGates: Array<Promise<void> | undefined> = [];
  public readonly watchCallbacks: Array<() => void> = [];
  public watchDisposeGate: Promise<void> | undefined;
  public watchDisposeError: unknown;
  public cleanupError: unknown;
  public listGate: Promise<void> | undefined;
  public readGate: Promise<void> | undefined;
  public readCloseError: unknown;
  public uploadFrameResponse: SessionOutboundMessage | null = null;
  public uploadFrameGate: Promise<void> | undefined;
  public uploadFrameCalls = 0;
  public downloadWorkspaceId = "workspace-one";
  public downloadRelativePath = "reports/quarter.csv";

  public async stat() {
    const call = this.statCalls;
    this.statCalls += 1;
    await this.statGates[call];
    return { kind: "file" as const, dev: 1, ino: 2, size: 5, mtimeMs: 1_000 };
  }

  public async list(input: unknown) {
    this.listCalls.push(input);
    await this.listGate;
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
    this.openReadCalls += 1;
    return {
      kind: "file" as const,
      dev: 1,
      ino: 2,
      size: 5,
      mtimeMs: 1_000,
      workspaceId: "workspace-one",
      relativePath: "reports/quarter.csv",
      read: async (offset: number, length: number) => {
        await this.readGate;
        return new TextEncoder().encode("hello").subarray(offset, offset + length);
      },
      close: async () => {
        this.readCloseCalls += 1;
        if (this.readCloseError !== undefined) throw this.readCloseError;
      },
    };
  }

  public async write(input: unknown): Promise<void> {
    this.writeCalls.push(input);
  }
  public async create(input: unknown): Promise<void> {
    this.createCalls.push(input);
  }
  public async rename(input: unknown): Promise<void> {
    this.renameCalls.push(input);
  }
  public async copy(input: unknown): Promise<void> {
    this.copyCalls.push(input);
  }
  public async delete(input: unknown): Promise<void> {
    this.deleteCalls.push(input);
  }

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
      workspaceId: this.downloadWorkspaceId,
      relativePath: this.downloadRelativePath,
      token: "download-token",
      expiresAt: 2_000,
    };
  }

  public createUploadStore() {
    return {
      begin: (input: EnterpriseFileUploadBeginInput) => this.uploadBegins.push(input),
      beginStaged: (input: EnterpriseStagedFileUploadBeginInput) =>
        this.stagedUploadBegins.push(input),
      receiveFrame: async () => {
        this.uploadFrameCalls += 1;
        await this.uploadFrameGate;
        return this.uploadFrameResponse;
      },
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
  test("enterprise-required sessions reject every file entry class before legacy access", async () => {
    const cwd = makeDir("workspace-files-required-");
    writeFileSync(join(cwd, "notes.txt"), "unchanged");
    const { subsystem, emitted, binary, paseoHome } = makeSubsystem({ enterpriseRequired: true });

    await expect(
      subsystem.handleFileExplorerRequest({
        type: "file_explorer_request",
        cwd,
        workspaceId: "workspace-one",
        path: ".",
        mode: "list",
        requestId: "required-explorer",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileWriteRequest({
        type: "fs.file.write.request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        content: "changed",
        expectedModifiedAt: "2026-09-10T00:00:00.000Z",
        requestId: "required-write",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileEntryCreateRequest({
        type: "fs.entry.create.request",
        cwd,
        workspaceId: "workspace-one",
        parentPath: ".",
        name: "created.txt",
        kind: "file",
        requestId: "required-create",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileEntryRenameRequest({
        type: "fs.entry.rename.request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        name: "renamed.txt",
        requestId: "required-rename",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileEntryDuplicateRequest({
        type: "fs.entry.duplicate.request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        requestId: "required-copy",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileEntryDeleteRequest({
        type: "fs.entry.delete.request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        requestId: "required-delete",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileSubscribeRequest({
        type: "fs.file.subscribe.request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        subscriptionId: "required-subscription",
        requestId: "required-subscribe",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileUnsubscribeRequest({
        type: "fs.file.unsubscribe.request",
        subscriptionId: "required-subscription",
        requestId: "required-unsubscribe",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileDownloadTokenRequest({
        type: "file_download_token_request",
        cwd,
        workspaceId: "workspace-one",
        path: "notes.txt",
        requestId: "required-download",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    expect(() =>
      subsystem.handleFileUploadRequest({
        type: "file.upload.request",
        workspaceId: "workspace-one",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 1,
        modifiedAt: "2026-09-10T00:00:00.000Z",
        requestId: "required-upload",
      }),
    ).toThrow("Enterprise workspace file runtime is required.");
    expect(() =>
      subsystem.handleEnterpriseFileUploadRequest({
        workspaceId: "workspace-one",
        relativePath: "uploads/notes.txt",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 1,
        modifiedAt: "2026-09-10T00:00:00.000Z",
        requestId: "required-explicit-upload",
      }),
    ).toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleFileTransferFrame(
        uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "required-upload" }),
      ),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");
    await expect(
      subsystem.handleProjectIconRequest({
        type: "project_icon_request",
        cwd,
        workspaceId: "workspace-one",
        requestId: "required-icon",
      }),
    ).rejects.toThrow("Enterprise workspace file runtime is required.");

    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("unchanged");
    expect(existsSync(join(cwd, "created.txt"))).toBe(false);
    expect(existsSync(join(cwd, "renamed.txt"))).toBe(false);
    expect(existsSync(join(paseoHome, "uploads"))).toBe(false);
    expect(emitted).toEqual([]);
    expect(binary).toEqual([]);
  });

  test("enterprise JSON responses carry the exact call-time workspace snapshot", async () => {
    const listGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.listGate = listGate.promise;
    const { subsystem, enterpriseEmitted, legacyEmitted } = makeSubsystem({ enterpriseRuntime });
    const request = {
      type: "file_explorer_request" as const,
      cwd: "/caller/claimed/root",
      workspaceId: "workspace-original",
      path: "reports",
      mode: "list" as const,
      requestId: "request-original",
    };

    const listing = subsystem.handleFileExplorerRequest(request);
    await waitUntil(() => enterpriseRuntime.listCalls.length === 1);
    request.workspaceId = "workspace-mutated";
    request.path = "mutated";
    request.requestId = "request-mutated";
    listGate.resolve();
    await listing;

    expect(enterpriseRuntime.listCalls).toEqual([
      {
        workspaceId: "workspace-original",
        relativePath: "reports",
        requestId: "request-original",
      },
    ]);
    expect(enterpriseEmitted).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-original",
        message: expect.objectContaining({
          type: "file_explorer_response",
          payload: expect.objectContaining({ path: "reports", requestId: "request-original" }),
        }),
      }),
    ]);
    expect(legacyEmitted).toEqual([]);
  });

  test("every enterprise mutation and token response uses its canonical workspace", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, enterpriseEmitted, legacyEmitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileWriteRequest({
      type: "fs.file.write.request",
      cwd: "/caller/root",
      workspaceId: "workspace-write",
      path: "notes.txt",
      content: "hello",
      expectedModifiedAt: "2026-09-10T00:00:00.000Z",
      requestId: "request-write",
    });
    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd: "/caller/root",
      workspaceId: "workspace-create",
      parentPath: ".",
      name: "notes.txt",
      kind: "file",
      requestId: "request-create",
    });
    await subsystem.handleFileEntryRenameRequest({
      type: "fs.entry.rename.request",
      cwd: "/caller/root",
      workspaceId: "workspace-rename",
      path: "notes.txt",
      name: "renamed.txt",
      requestId: "request-rename",
    });
    await subsystem.handleFileEntryDuplicateRequest({
      type: "fs.entry.duplicate.request",
      cwd: "/caller/root",
      workspaceId: "workspace-copy",
      path: "notes.txt",
      requestId: "request-copy",
    });
    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd: "/caller/root",
      workspaceId: "workspace-delete",
      path: "notes.txt",
      requestId: "request-delete",
    });
    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      requestId: "request-download",
    });
    await subsystem.handleFileEntryCreateRequest({
      type: "fs.entry.create.request",
      cwd: "/caller/root",
      workspaceId: "workspace-error",
      parentPath: ".",
      name: "../unsafe.txt",
      kind: "file",
      requestId: "request-error",
    });

    expect(enterpriseEmitted.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-write",
      "workspace-create",
      "workspace-rename",
      "workspace-copy",
      "workspace-delete",
      "workspace-one",
      "workspace-error",
    ]);
    expect(enterpriseEmitted.map(({ message }) => message.type)).toEqual([
      "fs.file.write.response",
      "fs.entry.create.response",
      "fs.entry.rename.response",
      "fs.entry.duplicate.response",
      "fs.entry.delete.response",
      "file_download_token_response",
      "fs.entry.create.response",
    ]);
    expect(enterpriseRuntime.copyCalls).toEqual([]);
    expect(enterpriseEmitted[3]?.message).toMatchObject({
      payload: { success: false, duplicatedPath: null },
    });
    expect(enterpriseEmitted[6]?.message).toMatchObject({ payload: { success: false } });
    expect(legacyEmitted).toEqual([]);
  });

  test("enterprise emitters are captured at construction", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, enterpriseEmitted, host } = makeSubsystem({ enterpriseRuntime });
    const replacementCalls: string[] = [];
    host.emitWorkspace = (_message, workspaceId) => replacementCalls.push(workspaceId);

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/old.csv",
      requestId: "request-delete",
    });

    expect(replacementCalls).toEqual([]);
    expect(enterpriseEmitted).toEqual([expect.objectContaining({ workspaceId: "workspace-one" })]);
  });

  test("constructor reads host, runtime, flag, and each host method exactly once", async () => {
    const reads = {
      host: 0,
      runtime: 0,
      enterpriseRequired: 0,
      emit: 0,
      emitBinary: 0,
      emitWorkspace: 0,
      emitBinaryWorkspace: 0,
      hasBinaryChannel: 0,
    };
    const workspaceIds: string[] = [];
    const host = {
      get emit() {
        reads.emit += 1;
        return (_message: SessionOutboundMessage) => undefined;
      },
      get emitBinary() {
        reads.emitBinary += 1;
        return async (_frame: Uint8Array) => undefined;
      },
      get emitWorkspace() {
        reads.emitWorkspace += 1;
        return (_message: SessionOutboundMessage, workspaceId: string) => {
          workspaceIds.push(workspaceId);
        };
      },
      get emitBinaryWorkspace() {
        reads.emitBinaryWorkspace += 1;
        return async (_frame: Uint8Array, _workspaceId: string) => undefined;
      },
      get hasBinaryChannel() {
        reads.hasBinaryChannel += 1;
        return () => false;
      },
    };
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const subsystem = new WorkspaceFilesSession({
      get host() {
        reads.host += 1;
        return host;
      },
      get enterpriseRuntime() {
        reads.runtime += 1;
        return enterpriseRuntime;
      },
      get enterpriseRequired() {
        reads.enterpriseRequired += 1;
        return true;
      },
      downloadTokenStore: new DownloadTokenStore({ ttlMs: 60_000 }),
      paseoHome: makeDir("workspace-files-constructor-"),
      logger: pino({ level: "silent" }),
    });
    enterpriseRuntime.delete = async () => {
      throw new Error("replacement must not run");
    };

    await subsystem.handleFileEntryDeleteRequest({
      type: "fs.entry.delete.request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "notes.txt",
      requestId: "request-delete",
    });

    expect(reads).toEqual({
      host: 1,
      runtime: 1,
      enterpriseRequired: 1,
      emit: 1,
      emitBinary: 1,
      emitWorkspace: 1,
      emitBinaryWorkspace: 1,
      hasBinaryChannel: 1,
    });
    expect(workspaceIds).toEqual(["workspace-one"]);
    expect(enterpriseRuntime.deleteCalls).toHaveLength(1);
  });

  test("missing or accessor workspace IDs perform no enterprise operation or emit", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, enterpriseEmitted, legacyEmitted } = makeSubsystem({ enterpriseRuntime });
    let getterCalls = 0;
    const accessorRequest = {
      type: "fs.entry.delete.request" as const,
      cwd: "/caller/root",
      get workspaceId(): string {
        getterCalls += 1;
        throw new Error("caller getter must not run");
      },
      path: "reports/old.csv",
      requestId: "request-delete",
    };

    await expect(subsystem.handleFileEntryDeleteRequest(accessorRequest)).resolves.toBeUndefined();
    await expect(
      subsystem.handleFileEntryDeleteRequest({
        type: "fs.entry.delete.request",
        cwd: "/caller/root",
        path: "reports/old.csv",
        requestId: "request-missing",
      }),
    ).resolves.toBeUndefined();

    expect(getterCalls).toBe(0);
    expect(enterpriseRuntime.deleteCalls).toEqual([]);
    expect(enterpriseEmitted).toEqual([]);
    expect(legacyEmitted).toEqual([]);
  });

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
    expect(emitted).toEqual([]);
  });

  test("enterprise binary explorer frames retain one capability workspace correlation", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const source = {};
    const { subsystem, enterpriseBinary, legacyBinary } = makeSubsystem({
      enterpriseRuntime,
      hasBinaryChannel: true,
    });

    await subsystem.handleFileExplorerRequest(
      {
        type: "file_explorer_request",
        cwd: "/caller/root",
        workspaceId: "workspace-one",
        path: "reports/quarter.csv",
        mode: "file",
        acceptBinary: true,
        requestId: "request-binary",
      },
      source,
    );

    expect(enterpriseBinary.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-one",
      "workspace-one",
      "workspace-one",
    ]);
    expect(enterpriseBinary.map(({ source: emittedSource }) => emittedSource)).toEqual([
      source,
      source,
      source,
    ]);
    expect(enterpriseBinary.map(({ frame }) => decodeFileTransferFrame(frame)?.opcode)).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileEnd,
    ]);
    expect(legacyBinary).toEqual([]);
  });

  test("enterprise cleanup waits for a blocked binary read and publishes no late frames", async () => {
    const readGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.readGate = readGate.promise;
    const { subsystem, enterpriseBinary } = makeSubsystem({
      enterpriseRuntime,
      hasBinaryChannel: true,
    });
    const transfer = subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      mode: "file",
      acceptBinary: true,
      requestId: "request-binary-cleanup",
    });
    await waitUntil(() => enterpriseBinary.length === 1);

    const cleanup = subsystem.cleanupEnterprise("generation-replaced");
    let cleanupSettled = false;
    cleanup.then(() => {
      cleanupSettled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);
    readGate.resolve();

    await expect(transfer).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    expect(enterpriseBinary).toHaveLength(1);
  });

  test("inline explorer waits for close and emits one denied response when close fails", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.readCloseError = new Error("read close failed");
    const { subsystem, enterpriseEmitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileExplorerRequest({
      type: "file_explorer_request",
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      mode: "file",
      requestId: "request-inline-close",
    });

    expect(enterpriseRuntime.readCloseCalls).toBe(1);
    expect(enterpriseEmitted).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-one",
        message: expect.objectContaining({
          type: "file_explorer_response",
          payload: expect.objectContaining({ file: null, error: "Enterprise file access denied." }),
        }),
      }),
    ]);
  });

  test("binary explorer close failure is observable without a second JSON response", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.readCloseError = new Error("read close failed");
    const { subsystem, enterpriseBinary, enterpriseEmitted } = makeSubsystem({
      enterpriseRuntime,
      hasBinaryChannel: true,
    });

    await expect(
      subsystem.handleFileExplorerRequest({
        type: "file_explorer_request",
        cwd: "/caller/root",
        workspaceId: "workspace-one",
        path: "reports/quarter.csv",
        mode: "file",
        acceptBinary: true,
        requestId: "request-binary-close",
      }),
    ).rejects.toBe(enterpriseRuntime.readCloseError);

    expect(enterpriseRuntime.readCloseCalls).toBe(1);
    expect(enterpriseBinary).toHaveLength(3);
    expect(enterpriseEmitted).toEqual([]);
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

  test("rejects a download token whose returned path changes the request binding", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.downloadRelativePath = "reports/other.csv";
    const { subsystem, enterpriseEmitted } = makeSubsystem({ enterpriseRuntime });

    await subsystem.handleFileDownloadTokenRequest({
      type: "file_download_token_request",
      cwd: "/caller/claimed/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      requestId: "request-enterprise-download-path",
    });

    expect(enterpriseEmitted).toEqual([
      {
        workspaceId: "workspace-one",
        source: undefined,
        message: {
          type: "file_download_token_response",
          payload: {
            cwd: "",
            path: "reports/quarter.csv",
            token: null,
            fileName: null,
            mimeType: null,
            size: null,
            error: "Enterprise file access denied.",
            requestId: "request-enterprise-download-path",
          },
        },
      },
    ]);
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

  test("enterprise upload frames emit only through their authoritative request binding", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.uploadFrameResponse = {
      type: "file.upload.response",
      payload: {
        requestId: "request-upload-frame",
        uploadId: "upload-one",
        workspaceId: "payload-must-not-authorize",
        file: null,
        error: "denied",
      },
    };
    const { subsystem, enterpriseEmitted, legacyEmitted } = makeSubsystem({ enterpriseRuntime });
    subsystem.handleEnterpriseFileUploadRequest({
      workspaceId: "workspace-one",
      relativePath: "uploads/report.csv",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 0,
      modifiedAt: "2026-09-10T00:00:00.000Z",
      requestId: "request-upload-frame",
    });

    await subsystem.handleFileTransferFrame(
      uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "request-upload-frame" }),
    );
    await subsystem.handleFileTransferFrame(
      uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "unknown-request" }),
    );

    expect(enterpriseEmitted).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-one",
        message: {
          type: "file.upload.response",
          payload: {
            requestId: "request-upload-frame",
            workspaceId: "workspace-one",
            file: null,
            error: "Enterprise file access denied.",
          },
        },
      }),
    ]);
    expect(legacyEmitted).toEqual([]);
  });

  test("enterprise cleanup invalidates an upload response blocked in the upload port", async () => {
    const uploadGate = deferred();
    const enterpriseRuntime = new TestEnterpriseRuntime();
    enterpriseRuntime.uploadFrameGate = uploadGate.promise;
    enterpriseRuntime.uploadFrameResponse = {
      type: "file.upload.response",
      payload: {
        requestId: "request-upload-cleanup",
        workspaceId: "workspace-one",
        file: null,
        error: "denied",
      },
    };
    const { subsystem, enterpriseEmitted } = makeSubsystem({ enterpriseRuntime });
    subsystem.handleEnterpriseFileUploadRequest({
      workspaceId: "workspace-one",
      relativePath: "uploads/report.csv",
      fileName: "report.csv",
      mimeType: "text/csv",
      size: 0,
      modifiedAt: "2026-09-10T00:00:00.000Z",
      requestId: "request-upload-cleanup",
    });
    const receiving = subsystem.handleFileTransferFrame(
      uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "request-upload-cleanup" }),
    );
    await waitUntil(() => enterpriseRuntime.uploadFrameCalls === 1);

    const cleanup = subsystem.cleanupEnterprise("generation-replaced");
    uploadGate.resolve();

    await expect(receiving).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBeUndefined();
    expect(enterpriseEmitted).toEqual([]);
    await expect(
      subsystem.handleFileTransferFrame(
        uploadFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "request-upload-cleanup" }),
      ),
    ).rejects.toThrow("Workspace file session is closed.");
  });

  test("enterprise subscription updates retain workspace correlation and stop after replacement", async () => {
    const enterpriseRuntime = new TestEnterpriseRuntime();
    const { subsystem, enterpriseEmitted } = makeSubsystem({ enterpriseRuntime });
    const request = {
      type: "fs.file.subscribe.request" as const,
      cwd: "/caller/root",
      workspaceId: "workspace-one",
      path: "reports/quarter.csv",
      subscriptionId: "subscription-one",
      requestId: "request-old",
    };
    await subsystem.handleFileSubscribeRequest(request);
    const oldCallback = enterpriseRuntime.watchCallbacks[0];
    await subsystem.handleFileSubscribeRequest({ ...request, requestId: "request-new" });
    oldCallback?.();
    enterpriseRuntime.watchCallbacks[1]?.();
    await waitUntil(() => enterpriseEmitted.length === 3);

    expect(enterpriseEmitted.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace-one",
      "workspace-one",
      "workspace-one",
    ]);
    expect(
      enterpriseEmitted.map(({ message }) =>
        "requestId" in message.payload ? message.payload.requestId : null,
      ),
    ).toEqual(["request-old", "request-new", null]);
    await subsystem.cleanupEnterprise("generation-replaced");
    enterpriseRuntime.watchCallbacks[1]?.();
    await Promise.resolve();
    expect(enterpriseEmitted).toHaveLength(3);
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
