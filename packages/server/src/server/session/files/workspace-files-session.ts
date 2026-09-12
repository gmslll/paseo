import { Buffer } from "node:buffer";
import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  FileDownloadTokenRequest,
  FileEntryCreateRequest,
  FileEntryDeleteRequest,
  FileEntryDuplicateRequest,
  FileEntryRenameRequest,
  FileExplorerRequest,
  FileUploadRequest,
  FileSubscribeRequest,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import { FileUploadStore } from "../../file-upload/index.js";
import type { DownloadTokenStore } from "../../file-download/token-store.js";
import {
  createExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  renameExplorerEntry,
  streamExplorerFile,
  writeExplorerFile,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import { getProjectIcon } from "../../../utils/project-icon.js";
import type {
  EnterpriseWorkspaceFilesRuntime,
  EnterpriseWorkspaceReadCapability,
} from "../../enterprise/runtime/workspace-files-runtime.js";
import type {
  EnterpriseFileUploadBeginInput,
  EnterpriseStagedFileUploadBeginInput,
} from "../../file-upload/index.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). Enterprise methods carry only a
 * canonical workspace correlation; Session owns the authenticated outbound
 * authorization context.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  emitWorkspace?(msg: SessionOutboundMessage, workspaceId: string, source?: object): void;
  emitBinaryWorkspace?(frame: Uint8Array, workspaceId: string, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
  enterpriseRuntime?: EnterpriseWorkspaceFilesRuntime;
  /** Trusted Session lifecycle fact derived from its canonical enterprise context. */
  enterpriseRequired?: boolean;
}

interface AsyncTeardown {
  close(): Promise<void>;
}

type CloseSettlement = { readonly ok: true } | { readonly ok: false; readonly closeError: unknown };

interface EnterpriseSubscriptionAttempt {
  active: boolean;
  readonly workspaceId: string;
  teardown: AsyncTeardown | null;
  cleanupPromise: Promise<void> | null;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

interface EnterpriseWorkspacePathRequest {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly requestId: string;
}

interface EnterpriseFileWriteRequest extends EnterpriseWorkspacePathRequest {
  readonly content: string;
  readonly expectedModifiedAt: string;
  readonly expectedRevision?: string;
}

interface EnterpriseFileCreateRequest {
  readonly workspaceId: string;
  readonly parentPath: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly requestId: string;
}

interface EnterpriseFileRenameRequest extends EnterpriseWorkspacePathRequest {
  readonly name: string;
}

interface EnterpriseFileSubscriptionRequest extends EnterpriseWorkspacePathRequest {
  readonly subscriptionId: string;
}

interface EnterpriseFileUnsubscribeRequest {
  readonly subscriptionId: string;
  readonly requestId: string;
}

interface EnterpriseFileExplorerRequest extends EnterpriseWorkspacePathRequest {
  readonly mode: "list" | "file";
  readonly acceptBinary: boolean;
  readonly maxBytes?: number;
}

interface EnterpriseProjectIconRequest {
  readonly workspaceId: string;
  readonly requestId: string;
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. It owns the upload store and reaches no
 * workspace-git, registry, or subscription state — file I/O scoped to a cwd is
 * the whole concern.
 */
export class WorkspaceFilesSession {
  private readonly emit: WorkspaceFilesSessionHost["emit"];
  private readonly emitBinary: WorkspaceFilesSessionHost["emitBinary"];
  private readonly emitWorkspace: NonNullable<WorkspaceFilesSessionHost["emitWorkspace"]> | null;
  private readonly emitBinaryWorkspace: NonNullable<
    WorkspaceFilesSessionHost["emitBinaryWorkspace"]
  > | null;
  private readonly hasBinaryChannel: WorkspaceFilesSessionHost["hasBinaryChannel"];
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly enterpriseRuntime: EnterpriseWorkspaceFilesRuntime | null;
  private readonly enterpriseRequired: boolean;
  private readonly enterpriseOperations = new Set<Promise<void>>();
  private readonly fileSubscriptions = new Map<string, AsyncTeardown>();
  private readonly enterpriseSubscriptions = new Map<string, EnterpriseSubscriptionAttempt>();
  private cleanupPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: WorkspaceFilesSessionOptions) {
    const host = options.host;
    const runtime = options.enterpriseRuntime;
    const enterpriseRequired = options.enterpriseRequired;
    const { emit, emitBinary, emitWorkspace, emitBinaryWorkspace, hasBinaryChannel } = host;
    this.emit = emit.bind(host);
    this.emitBinary = emitBinary.bind(host);
    this.emitWorkspace = emitWorkspace?.bind(host) ?? null;
    this.emitBinaryWorkspace = emitBinaryWorkspace?.bind(host) ?? null;
    this.hasBinaryChannel = hasBinaryChannel.bind(host);
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.enterpriseRuntime = runtime ? bindEnterpriseRuntime(runtime) : null;
    this.enterpriseRequired = enterpriseRequired === true;
    this.fileUploads = new FileUploadStore({
      paseoHome: options.paseoHome,
      enterprise: this.enterpriseRuntime?.createUploadStore(),
    });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.closed) throw new Error("Workspace file session is closed.");
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileSubscribeRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.handleEnterpriseSubscribe(snapshot);
    }
    try {
      await this.closeSubscription(request.subscriptionId);
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(
        request.subscriptionId,
        onceAsyncTeardown(async () => subscription.unsubscribe()),
      );
      this.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: getErrorMessage(error),
          },
          requestId: request.requestId,
        },
      });
    }
  }

  async handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileUnsubscribeRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      const attempt = this.enterpriseSubscriptions.get(snapshot.subscriptionId);
      if (!attempt) return;
      await this.closeEnterpriseSubscription(snapshot.subscriptionId);
      if (this.closed) return;
      this.emitEnterprise(
        {
          type: "fs.file.unsubscribe.response",
          payload: { subscriptionId: snapshot.subscriptionId, requestId: snapshot.requestId },
        },
        attempt.workspaceId,
      );
      return;
    } else {
      await this.closeSubscription(request.subscriptionId);
    }
    this.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileWriteRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.performEnterpriseWrite(snapshot));
    }
    const result = await writeExplorerFile({
      root: request.cwd,
      relativePath: request.path,
      content: request.content,
      expectedModifiedAt: request.expectedModifiedAt,
      expectedRevision: request.expectedRevision,
    });
    this.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  private async performEnterpriseWrite(request: EnterpriseFileWriteRequest): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, relativePath, requestId } = request;
    try {
      await runtime.write({
        workspaceId,
        relativePath,
        requestId,
        bytes: new TextEncoder().encode(request.content),
        expectedModifiedAt: request.expectedModifiedAt,
        expectedRevision: request.expectedRevision,
      });
      if (this.closed) return;
      const stat = await runtime.stat({ workspaceId, relativePath, requestId });
      this.emitEnterprise(
        {
          type: "fs.file.write.response",
          payload: {
            result: {
              status: "written",
              modifiedAt: new Date(stat.mtimeMs).toISOString(),
              size: stat.size,
              revision: fileRevision(stat),
            },
            requestId,
          },
        },
        workspaceId,
      );
    } catch {
      this.emitEnterprise(
        {
          type: "fs.file.write.response",
          payload: { result: { status: "error", error: enterpriseDenied() }, requestId },
        },
        workspaceId,
      );
    }
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileCreateRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.performEnterpriseCreate(snapshot));
    }
    const result = await createExplorerEntry({
      root: request.cwd,
      parentPath: request.parentPath,
      name: request.name,
      kind: request.kind,
    });
    this.emit({
      type: "fs.entry.create.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  private async performEnterpriseCreate(request: EnterpriseFileCreateRequest): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, parentPath, requestId } = request;
    let relativePath: string | null = null;
    try {
      relativePath = joinRelative(parentPath, request.name);
      await runtime.create({ workspaceId, relativePath, requestId, kind: request.kind });
      this.emitEnterprise(
        {
          type: "fs.entry.create.response",
          payload: {
            cwd: "",
            parentPath,
            path: relativePath,
            success: true,
            error: null,
            requestId,
          },
        },
        workspaceId,
      );
    } catch {
      this.emitEnterprise(
        {
          type: "fs.entry.create.response",
          payload: {
            cwd: "",
            parentPath,
            path: null,
            success: false,
            error: enterpriseDenied(),
            requestId,
          },
        },
        workspaceId,
      );
    }
  }

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileRenameRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.performEnterpriseRename(snapshot));
    }
    const result = await renameExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      name: request.name,
    });
    this.emit({
      type: "fs.entry.rename.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        renamedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  private async performEnterpriseRename(request: EnterpriseFileRenameRequest): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, relativePath, requestId } = request;
    let destinationRelativePath: string | null = null;
    try {
      destinationRelativePath = joinRelative(parentRelative(relativePath), request.name);
      await runtime.rename({
        workspaceId,
        sourceRelativePath: relativePath,
        destinationRelativePath,
        requestId,
      });
      this.emitEnterprise(
        {
          type: "fs.entry.rename.response",
          payload: {
            cwd: "",
            path: relativePath,
            renamedPath: destinationRelativePath,
            success: true,
            error: null,
            requestId,
          },
        },
        workspaceId,
      );
    } catch {
      this.emitEnterprise(
        {
          type: "fs.entry.rename.response",
          payload: {
            cwd: "",
            path: relativePath,
            renamedPath: null,
            success: false,
            error: enterpriseDenied(),
            requestId,
          },
        },
        workspaceId,
      );
    }
  }

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotWorkspacePathRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.performEnterpriseDuplicate(snapshot));
    }
    const result = await duplicateExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.emit({
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        duplicatedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  private async performEnterpriseDuplicate(request: EnterpriseWorkspacePathRequest): Promise<void> {
    const { workspaceId, relativePath, requestId } = request;
    this.emitEnterprise(
      {
        type: "fs.entry.duplicate.response",
        payload: {
          cwd: "",
          path: relativePath,
          duplicatedPath: null,
          success: false,
          error: enterpriseDenied(),
          requestId,
        },
      },
      workspaceId,
    );
  }

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotWorkspacePathRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.performEnterpriseDelete(snapshot));
    }
    const result = await deleteExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.emit({
      type: "fs.entry.delete.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  private async performEnterpriseDelete(request: EnterpriseWorkspacePathRequest): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, relativePath, requestId } = request;
    try {
      await runtime.delete({ workspaceId, relativePath, requestId });
      this.emitEnterprise(
        {
          type: "fs.entry.delete.response",
          payload: {
            cwd: "",
            path: relativePath,
            success: true,
            error: null,
            requestId,
          },
        },
        workspaceId,
      );
    } catch {
      this.emitEnterprise(
        {
          type: "fs.entry.delete.response",
          payload: {
            cwd: "",
            path: relativePath,
            success: false,
            error: enterpriseDenied(),
            requestId,
          },
        },
        workspaceId,
      );
    }
  }

  dispose(): Promise<void> {
    return this.cleanupEnterprise("session-closed");
  }

  cleanupEnterprise(reason: "session-closed" | "generation-replaced"): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const subscriptions = [...this.fileSubscriptions.values()];
    this.fileSubscriptions.clear();
    const enterpriseSubscriptions = [...this.enterpriseSubscriptions.values()];
    const enterpriseOperations = [...this.enterpriseOperations];
    for (const subscription of enterpriseSubscriptions) subscription.active = false;
    this.enterpriseSubscriptions.clear();
    this.cleanupPromise = rejectAggregate(
      [
        ...subscriptions.map((subscription) => subscription.close()),
        ...enterpriseSubscriptions.map((subscription) =>
          this.cleanupEnterpriseSubscription(subscription),
        ),
        ...enterpriseOperations,
        this.fileUploads.cleanupEnterprise(reason),
        ...(this.enterpriseRuntime ? [this.enterpriseRuntime.cleanup(reason)] : []),
      ],
      "Workspace file cleanup failed.",
    );
    return this.cleanupPromise;
  }

  async handleFileExplorerRequest(request: FileExplorerRequest, source?: object): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotFileExplorerRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      if (snapshot.acceptBinary && this.hasBinaryChannel() && !this.emitBinaryWorkspace) {
        this.emitEnterprise(explorerDenied(snapshot), snapshot.workspaceId, source);
        return;
      }
      return this.trackEnterpriseOperation(this.handleEnterpriseExplorer(snapshot, source));
    }
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: workspaceCwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: "cwd is required",
            requestId,
          },
        },
        source,
      );
      return;
    }

    try {
      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: cwd,
          relativePath: requestedPath,
        });

        this.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd,
              path: directory.path,
              mode,
              directory,
              file: null,
              error: null,
              requestId,
            },
          },
          source,
        );
      } else {
        if (request.maxBytes) {
          const file = await getDownloadableFileInfo({ root: cwd, relativePath: requestedPath });
          if (file.size > request.maxBytes) {
            throw new Error("File is too large to display");
          }
        }
        if (request.acceptBinary && this.hasBinaryChannel()) {
          await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
            await this.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileBegin,
                requestId,
                metadata: {
                  mime: file.mimeType,
                  size: file.size,
                  encoding: file.encoding,
                  modifiedAt: file.modifiedAt,
                  revision: file.revision,
                },
              }),
              source,
            );
            for await (const chunk of file.chunks) {
              await this.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileEnd,
                requestId,
              }),
              source,
            );
          });
        } else {
          const file = await readExplorerFile({
            root: cwd,
            relativePath: requestedPath,
          });

          this.emit(
            {
              type: "file_explorer_response",
              payload: {
                cwd,
                path: file.path,
                mode,
                directory: null,
                file,
                error: null,
                requestId,
              },
            },
            source,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  handleFileUploadRequest(request: FileUploadRequest): void {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotStagedUploadRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      try {
        this.fileUploads.beginEnterpriseStagedUpload(snapshot);
      } catch {
        this.emitEnterprise(uploadDenied(snapshot), snapshot.workspaceId);
      }
      return;
    }
    this.fileUploads.beginUpload(request);
  }

  handleEnterpriseFileUploadRequest(request: EnterpriseFileUploadBeginInput): void {
    this.assertRuntimeAvailable();
    const snapshot = snapshotUploadRequest(request);
    if (!snapshot || !this.enterpriseRuntime || !this.emitWorkspace) return;
    try {
      this.fileUploads.beginEnterpriseUpload(snapshot);
    } catch {
      this.emitEnterprise(uploadDenied(snapshot), snapshot.workspaceId);
    }
  }

  async handleFileTransferFrame(frame: FileTransferFrame): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      if (!this.emitWorkspace) return;
      const snapshot = snapshotTransferFrame(frame);
      if (!snapshot) return;
      return this.trackEnterpriseOperation(this.receiveEnterpriseUploadFrame(snapshot));
    }
    const response = await this.fileUploads.receiveFrame(frame);
    if (response) {
      this.emit(response);
    }
  }

  private async receiveEnterpriseUploadFrame(frame: FileTransferFrame): Promise<void> {
    const result = await this.fileUploads.receiveEnterpriseFrame(frame);
    if (!result) return;
    this.emitEnterprise(result.response, result.workspaceId);
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotProjectIconRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      this.emitEnterprise(
        {
          type: "project_icon_response",
          payload: {
            cwd: "",
            icon: null,
            error: enterpriseDenied(),
            requestId: snapshot.requestId,
          },
        },
        snapshot.workspaceId,
      );
      return;
    }
    const { cwd, requestId } = request;

    try {
      const icon = await getProjectIcon(cwd);
      this.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    this.assertRuntimeAvailable();
    if (this.enterpriseRuntime) {
      const snapshot = snapshotWorkspacePathRequest(request);
      if (!snapshot || !this.emitWorkspace) return;
      return this.trackEnterpriseOperation(this.issueEnterpriseDownloadToken(snapshot));
    }
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  private handleEnterpriseSubscribe(request: EnterpriseFileSubscriptionRequest): Promise<void> {
    const previous = this.enterpriseSubscriptions.get(request.subscriptionId) ?? null;
    if (previous) previous.active = false;
    const attempt = createEnterpriseSubscriptionAttempt(request.workspaceId);
    this.enterpriseSubscriptions.set(request.subscriptionId, attempt);
    return this.performEnterpriseSubscribe(request, attempt, previous);
  }

  private async performEnterpriseSubscribe(
    request: EnterpriseFileSubscriptionRequest,
    attempt: EnterpriseSubscriptionAttempt,
    previous: EnterpriseSubscriptionAttempt | null,
  ): Promise<void> {
    try {
      if (previous) await this.cleanupEnterpriseSubscription(previous);
      this.assertEnterpriseSubscriptionCurrent(request.subscriptionId, attempt);
      const runtime = this.enterpriseRuntime;
      if (!runtime) throw new Error("Enterprise file runtime is unavailable.");
      const workspaceId = request.workspaceId;
      const requestContext = {
        workspaceId,
        relativePath: request.relativePath,
        requestId: request.requestId,
      };
      const initial = await runtime.stat(requestContext);
      this.assertEnterpriseSubscriptionCurrent(request.subscriptionId, attempt);
      const subscription = await runtime.watch(requestContext, () => {
        if (this.enterpriseSubscriptionIsCurrent(request.subscriptionId, attempt)) {
          void this.trackEnterpriseOperation(
            this.emitEnterpriseFileVersion(
              runtime,
              workspaceId,
              request.relativePath,
              request.subscriptionId,
              request.requestId,
              attempt,
            ),
          );
        }
      });
      attempt.teardown = onceAsyncTeardown(() =>
        Promise.resolve(subscription[Symbol.asyncDispose]()),
      );
      if (!this.enterpriseSubscriptionIsCurrent(request.subscriptionId, attempt)) {
        await attempt.teardown.close();
        return;
      }
      this.emitEnterprise(
        {
          type: "fs.file.subscribe.response",
          payload: {
            subscriptionId: request.subscriptionId,
            initial: enterpriseFileVersion(request.relativePath, initial),
            requestId: request.requestId,
          },
        },
        workspaceId,
      );
    } catch {
      if (this.enterpriseSubscriptionIsCurrent(request.subscriptionId, attempt)) {
        attempt.active = false;
        this.enterpriseSubscriptions.delete(request.subscriptionId);
        this.emitEnterprise(
          {
            type: "fs.file.subscribe.response",
            payload: {
              subscriptionId: request.subscriptionId,
              initial: {
                status: "error",
                cwd: "",
                path: request.relativePath,
                error: enterpriseDenied(),
              },
              requestId: request.requestId,
            },
          },
          request.workspaceId,
        );
      }
    } finally {
      attempt.resolveSettled();
    }
  }

  private async emitEnterpriseFileVersion(
    runtime: EnterpriseWorkspaceFilesRuntime,
    workspaceId: string,
    relativePath: string,
    subscriptionId: string,
    requestId: string,
    attempt: EnterpriseSubscriptionAttempt,
  ): Promise<void> {
    if (!this.enterpriseSubscriptionIsCurrent(subscriptionId, attempt)) return;
    try {
      const stat = await runtime.stat({ workspaceId, relativePath, requestId });
      if (!this.enterpriseSubscriptionIsCurrent(subscriptionId, attempt)) return;
      this.emitEnterprise(
        {
          type: "fs.file.update",
          payload: { subscriptionId, version: enterpriseFileVersion(relativePath, stat) },
        },
        workspaceId,
      );
    } catch {
      if (!this.enterpriseSubscriptionIsCurrent(subscriptionId, attempt)) return;
      this.emitEnterprise(
        {
          type: "fs.file.update",
          payload: {
            subscriptionId,
            version: { status: "error", cwd: "", path: relativePath, error: enterpriseDenied() },
          },
        },
        workspaceId,
      );
    }
  }

  private async handleEnterpriseExplorer(
    request: EnterpriseFileExplorerRequest,
    source?: object,
  ): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, relativePath, requestId } = request;
    let published = false;
    try {
      if (request.mode === "list") {
        const entries = await runtime.list({ workspaceId, relativePath, requestId });
        published = true;
        this.emitEnterprise(
          {
            type: "file_explorer_response",
            payload: {
              cwd: "",
              path: relativePath,
              mode: request.mode,
              directory: {
                path: relativePath,
                entries: entries.map((entry) => ({
                  name: entry.name,
                  path: entry.relativePath,
                  kind: entry.kind,
                  size: entry.size,
                  modifiedAt: new Date(entry.mtimeMs).toISOString(),
                })),
              },
              file: null,
              error: null,
              requestId,
            },
          },
          workspaceId,
          source,
        );
        return;
      }

      const capability = await runtime.openRead({ workspaceId, relativePath, requestId });
      const closeCapability = onceAsyncTeardown(() => capability.close());
      const capabilityWorkspaceId = await requireCapabilityWorkspaceId(capability, closeCapability);
      if (capabilityWorkspaceId !== workspaceId) {
        await closePreserving(
          new Error("Enterprise read capability workspace changed."),
          closeCapability,
        );
      }
      if (request.maxBytes !== undefined && capability.size > request.maxBytes) {
        await closePreserving(new Error("File is too large to display."), closeCapability);
      }
      if (request.acceptBinary && this.hasBinaryChannel()) {
        try {
          await this.streamEnterpriseFile(
            capability,
            capabilityWorkspaceId,
            requestId,
            () => {
              published = true;
            },
            source,
          );
        } catch (error) {
          await closePreserving(error, closeCapability);
        }
        await closeCapability.close();
        return;
      }

      const message = await readEnterpriseExplorerMessage(capability, request, closeCapability);
      await closeCapability.close();
      if (this.closed) return;
      published = true;
      this.emitEnterprise(message, workspaceId, source);
    } catch (error) {
      if (published) throw error;
      this.emitEnterprise(explorerDenied(request), workspaceId, source);
    }
  }

  private async streamEnterpriseFile(
    capability: EnterpriseWorkspaceReadCapability,
    workspaceId: string,
    requestId: string,
    onPublish: () => void,
    source?: object,
  ): Promise<void> {
    const emitBinaryWorkspace = this.emitBinaryWorkspace;
    if (!emitBinaryWorkspace || this.closed) return;
    onPublish();
    await emitBinaryWorkspace(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: mimeType(capability.relativePath),
          size: capability.size,
          encoding: "binary",
          modifiedAt: new Date(capability.mtimeMs).toISOString(),
          revision: fileRevision(capability),
          fileName: fileName(capability.relativePath),
        },
      }),
      workspaceId,
      source,
    );
    for (let offset = 0; offset < capability.size; offset += 256 * 1024) {
      if (this.closed) return;
      const chunk = await capability.read(offset, Math.min(256 * 1024, capability.size - offset));
      if (this.closed) return;
      await emitBinaryWorkspace(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId,
          payload: chunk,
        }),
        workspaceId,
        source,
      );
    }
    if (this.closed) return;
    await emitBinaryWorkspace(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
      workspaceId,
      source,
    );
  }

  private async issueEnterpriseDownloadToken(
    request: EnterpriseWorkspacePathRequest,
  ): Promise<void> {
    const runtime = this.enterpriseRuntime;
    if (!runtime) return;
    const { workspaceId, relativePath, requestId } = request;
    try {
      const issued = await runtime.issueDownloadToken({ workspaceId, relativePath, requestId });
      if (issued.workspaceId !== workspaceId || issued.relativePath !== relativePath) {
        throw new Error("Enterprise download token binding changed.");
      }
      this.emitEnterprise(
        {
          type: "file_download_token_response",
          payload: {
            cwd: "",
            path: issued.relativePath,
            token: issued.token,
            fileName: fileName(issued.relativePath),
            mimeType: mimeType(issued.relativePath),
            size: issued.size,
            error: null,
            requestId,
          },
        },
        workspaceId,
      );
    } catch {
      this.emitEnterprise(
        {
          type: "file_download_token_response",
          payload: {
            cwd: "",
            path: relativePath,
            token: null,
            fileName: null,
            mimeType: null,
            size: null,
            error: enterpriseDenied(),
            requestId,
          },
        },
        workspaceId,
      );
    }
  }

  private async closeSubscription(subscriptionId: string): Promise<void> {
    const subscription = this.fileSubscriptions.get(subscriptionId);
    if (!subscription) return;
    try {
      await subscription.close();
    } finally {
      if (this.fileSubscriptions.get(subscriptionId) === subscription) {
        this.fileSubscriptions.delete(subscriptionId);
      }
    }
  }

  private closeEnterpriseSubscription(subscriptionId: string): Promise<void> {
    const attempt = this.enterpriseSubscriptions.get(subscriptionId);
    if (!attempt) return Promise.resolve();
    attempt.active = false;
    if (this.enterpriseSubscriptions.get(subscriptionId) === attempt) {
      this.enterpriseSubscriptions.delete(subscriptionId);
    }
    return this.cleanupEnterpriseSubscription(attempt);
  }

  private cleanupEnterpriseSubscription(attempt: EnterpriseSubscriptionAttempt): Promise<void> {
    if (attempt.cleanupPromise) return attempt.cleanupPromise;
    attempt.active = false;
    attempt.cleanupPromise = (async () => {
      await attempt.settled;
      await attempt.teardown?.close();
    })();
    return attempt.cleanupPromise;
  }

  private enterpriseSubscriptionIsCurrent(
    subscriptionId: string,
    attempt: EnterpriseSubscriptionAttempt,
  ): boolean {
    return (
      !this.closed && attempt.active && this.enterpriseSubscriptions.get(subscriptionId) === attempt
    );
  }

  private assertEnterpriseSubscriptionCurrent(
    subscriptionId: string,
    attempt: EnterpriseSubscriptionAttempt,
  ): void {
    if (!this.enterpriseSubscriptionIsCurrent(subscriptionId, attempt)) {
      throw new Error("Enterprise file subscription is no longer current.");
    }
  }

  private assertRuntimeAvailable(): void {
    if (this.closed && (this.enterpriseRuntime || this.enterpriseRequired)) {
      throw new Error("Workspace file session is closed.");
    }
    if (this.enterpriseRequired && !this.enterpriseRuntime) {
      throw new Error("Enterprise workspace file runtime is required.");
    }
  }

  private emitEnterprise(
    message: SessionOutboundMessage,
    workspaceId: string,
    source?: object,
  ): void {
    if (this.closed) return;
    this.emitWorkspace?.(message, workspaceId, source);
  }

  private trackEnterpriseOperation(operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => {
      this.enterpriseOperations.delete(tracked);
    });
    this.enterpriseOperations.add(tracked);
    return tracked;
  }
}

function bindEnterpriseRuntime(
  runtime: EnterpriseWorkspaceFilesRuntime,
): EnterpriseWorkspaceFilesRuntime {
  const stat = runtime.stat.bind(runtime);
  const list = runtime.list.bind(runtime);
  const openRead = runtime.openRead.bind(runtime);
  const write = runtime.write.bind(runtime);
  const create = runtime.create.bind(runtime);
  const rename = runtime.rename.bind(runtime);
  const copy = runtime.copy.bind(runtime);
  const deleteEntry = runtime.delete.bind(runtime);
  const watch = runtime.watch.bind(runtime);
  const issueDownloadToken = runtime.issueDownloadToken.bind(runtime);
  const createUploadStore = runtime.createUploadStore.bind(runtime);
  const cleanup = runtime.cleanup.bind(runtime);
  return Object.freeze({
    stat,
    list,
    openRead,
    write,
    create,
    rename,
    copy,
    delete: deleteEntry,
    watch,
    issueDownloadToken,
    createUploadStore,
    cleanup,
  });
}

function snapshotWorkspacePathRequest(input: object): EnterpriseWorkspacePathRequest | null {
  try {
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      relativePath: requireOwnString(input, "path"),
      requestId: requireOwnString(input, "requestId"),
    });
  } catch {
    return null;
  }
}

function snapshotFileWriteRequest(input: object): EnterpriseFileWriteRequest | null {
  try {
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      relativePath: requireOwnString(input, "path"),
      requestId: requireOwnString(input, "requestId"),
      content: requireOwnString(input, "content"),
      expectedModifiedAt: requireOwnString(input, "expectedModifiedAt"),
      expectedRevision: optionalOwnString(input, "expectedRevision"),
    });
  } catch {
    return null;
  }
}

function snapshotFileCreateRequest(input: object): EnterpriseFileCreateRequest | null {
  try {
    const kind = requireOwnString(input, "kind");
    if (kind !== "file" && kind !== "directory") throw new Error("Invalid entry kind.");
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      parentPath: requireOwnString(input, "parentPath"),
      name: requireOwnString(input, "name"),
      kind,
      requestId: requireOwnString(input, "requestId"),
    });
  } catch {
    return null;
  }
}

function snapshotFileRenameRequest(input: object): EnterpriseFileRenameRequest | null {
  const request = snapshotWorkspacePathRequest(input);
  if (!request) return null;
  try {
    return Object.freeze({ ...request, name: requireOwnString(input, "name") });
  } catch {
    return null;
  }
}

function snapshotFileSubscribeRequest(input: object): EnterpriseFileSubscriptionRequest | null {
  const request = snapshotWorkspacePathRequest(input);
  if (!request) return null;
  try {
    return Object.freeze({
      ...request,
      subscriptionId: requireOwnString(input, "subscriptionId"),
    });
  } catch {
    return null;
  }
}

function snapshotFileUnsubscribeRequest(input: object): EnterpriseFileUnsubscribeRequest | null {
  try {
    return Object.freeze({
      subscriptionId: requireOwnString(input, "subscriptionId"),
      requestId: requireOwnString(input, "requestId"),
    });
  } catch {
    return null;
  }
}

function snapshotFileExplorerRequest(input: object): EnterpriseFileExplorerRequest | null {
  try {
    const mode = requireOwnString(input, "mode");
    if (mode !== "list" && mode !== "file") throw new Error("Invalid explorer mode.");
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      relativePath: optionalOwnString(input, "path") ?? ".",
      requestId: requireOwnString(input, "requestId"),
      mode,
      acceptBinary: optionalOwnBoolean(input, "acceptBinary") ?? false,
      maxBytes: optionalOwnNumber(input, "maxBytes"),
    });
  } catch {
    return null;
  }
}

function snapshotProjectIconRequest(input: object): EnterpriseProjectIconRequest | null {
  try {
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      requestId: requireOwnString(input, "requestId"),
    });
  } catch {
    return null;
  }
}

function snapshotStagedUploadRequest(input: object): EnterpriseStagedFileUploadBeginInput | null {
  try {
    return Object.freeze({
      workspaceId: requireWorkspaceId(requireOwnString(input, "workspaceId")),
      requestId: requireOwnString(input, "requestId"),
      fileName: requireOwnString(input, "fileName"),
      mimeType: requireOwnString(input, "mimeType"),
      size: requireOwnNumber(input, "size"),
      modifiedAt: requireOwnString(input, "modifiedAt"),
    });
  } catch {
    return null;
  }
}

function snapshotUploadRequest(input: object): EnterpriseFileUploadBeginInput | null {
  const staged = snapshotStagedUploadRequest(input);
  if (!staged) return null;
  try {
    return Object.freeze({ ...staged, relativePath: requireOwnString(input, "relativePath") });
  } catch {
    return null;
  }
}

function snapshotTransferFrame(frame: object): FileTransferFrame | null {
  try {
    return snapshotTransferFrameRequired(frame);
  } catch {
    return null;
  }
}

function snapshotTransferFrameRequired(frame: object): FileTransferFrame {
  const opcode = requireOwnNumber(frame, "opcode");
  const requestId = requireOwnString(frame, "requestId");
  const payloadValue = ownDataValue(frame, "payload");
  if (!(payloadValue instanceof Uint8Array)) throw new Error("Invalid file transfer payload.");
  const payload = new Uint8Array(payloadValue);
  if (opcode === FileTransferOpcode.FileChunk) {
    return Object.freeze({ opcode, requestId, payload });
  }
  if (opcode === FileTransferOpcode.FileEnd) {
    return Object.freeze({ opcode, requestId, payload });
  }
  if (opcode !== FileTransferOpcode.FileBegin) throw new Error("Invalid file transfer opcode.");
  const metadataValue = ownDataValue(frame, "metadata");
  if (typeof metadataValue !== "object" || metadataValue === null) {
    throw new Error("Invalid file transfer metadata.");
  }
  const encoding = requireOwnString(metadataValue, "encoding");
  if (encoding !== "utf-8" && encoding !== "binary") {
    throw new Error("Invalid file transfer encoding.");
  }
  const metadata = Object.freeze({
    mime: requireOwnString(metadataValue, "mime"),
    size: requireOwnNumber(metadataValue, "size"),
    encoding,
    modifiedAt: requireOwnString(metadataValue, "modifiedAt"),
    revision: optionalOwnString(metadataValue, "revision"),
    fileName: optionalOwnString(metadataValue, "fileName"),
  });
  return Object.freeze({ opcode, requestId, metadata, payload });
}

function ownDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(`Invalid ${key}.`);
  return descriptor.value;
}

function optionalOwnDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error(`Invalid ${key}.`);
  return descriptor.value;
}

function requireOwnString(input: object, key: string): string {
  const value = ownDataValue(input, key);
  if (typeof value !== "string") throw new Error(`Invalid ${key}.`);
  return value;
}

function optionalOwnString(input: object, key: string): string | undefined {
  const value = optionalOwnDataValue(input, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${key}.`);
  return value;
}

function requireOwnNumber(input: object, key: string): number {
  const value = ownDataValue(input, key);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

function optionalOwnNumber(input: object, key: string): number | undefined {
  const value = optionalOwnDataValue(input, key);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

function optionalOwnBoolean(input: object, key: string): boolean | undefined {
  const value = optionalOwnDataValue(input, key);
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${key}.`);
  return value;
}

function explorerDenied(request: EnterpriseFileExplorerRequest): SessionOutboundMessage {
  return {
    type: "file_explorer_response",
    payload: {
      cwd: "",
      path: request.relativePath,
      mode: request.mode,
      directory: null,
      file: null,
      error: enterpriseDenied(),
      requestId: request.requestId,
    },
  };
}

function uploadDenied(request: EnterpriseStagedFileUploadBeginInput): SessionOutboundMessage {
  return {
    type: "file.upload.response",
    payload: {
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      file: null,
      error: enterpriseDenied(),
    },
  };
}

function createEnterpriseSubscriptionAttempt(workspaceId: string): EnterpriseSubscriptionAttempt {
  let resolveSettled!: () => void;
  return {
    active: true,
    workspaceId,
    teardown: null,
    cleanupPromise: null,
    settled: new Promise<void>((resolve) => {
      resolveSettled = resolve;
    }),
    resolveSettled: () => resolveSettled(),
  };
}

function requireWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) throw new Error("Enterprise workspace ID is required.");
  return workspaceId;
}

function enterpriseDenied(): string {
  return "Enterprise file access denied.";
}

function joinRelative(parent: string, name: string): string {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("Unsafe workspace path.");
  }
  return parent === "." ? name : `${parent}/${name}`;
}

function parentRelative(relativePath: string): string {
  const segments = relativePath.split("/");
  segments.pop();
  return segments.join("/") || ".";
}

function fileRevision(identity: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}): string {
  return `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}`;
}

function enterpriseFileVersion(
  relativePath: string,
  stat: { dev: number; ino: number; size: number; mtimeMs: number },
) {
  return {
    status: "ready" as const,
    cwd: "",
    path: relativePath,
    size: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    revision: fileRevision(stat),
  };
}

async function requireCapabilityWorkspaceId(
  capability: EnterpriseWorkspaceReadCapability,
  teardown: AsyncTeardown,
): Promise<string> {
  try {
    return requireOwnString(capability, "workspaceId");
  } catch (error) {
    return closePreserving(error, teardown);
  }
}

async function readEnterpriseExplorerMessage(
  capability: EnterpriseWorkspaceReadCapability,
  request: EnterpriseFileExplorerRequest,
  teardown: AsyncTeardown,
): Promise<SessionOutboundMessage> {
  try {
    const bytes = await readAll(capability);
    const kind = fileKind(request.relativePath);
    return {
      type: "file_explorer_response",
      payload: {
        cwd: "",
        path: request.relativePath,
        mode: request.mode,
        directory: null,
        file: {
          path: request.relativePath,
          kind,
          encoding: fileEncoding(kind),
          ...fileContent(kind, bytes),
          mimeType: mimeType(request.relativePath),
          size: capability.size,
          modifiedAt: new Date(capability.mtimeMs).toISOString(),
          revision: fileRevision(capability),
        },
        error: null,
        requestId: request.requestId,
      },
    };
  } catch (error) {
    return closePreserving(error, teardown);
  }
}

async function readAll(capability: EnterpriseWorkspaceReadCapability): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < capability.size; offset += 256 * 1024) {
    chunks.push(await capability.read(offset, Math.min(256 * 1024, capability.size - offset)));
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function fileName(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? "file";
}

function mimeType(relativePath: string): string {
  const extension = relativePath.toLowerCase().split(".").at(-1);
  if (extension === "txt" || extension === "md" || extension === "ts" || extension === "tsx") {
    return "text/plain";
  }
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return "application/octet-stream";
}

function fileKind(relativePath: string): "text" | "image" | "binary" {
  const mime = mimeType(relativePath);
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  if (mime.startsWith("image/")) return "image";
  return "binary";
}

function fileEncoding(kind: "text" | "image" | "binary"): "utf-8" | "base64" | "none" {
  if (kind === "text") return "utf-8";
  if (kind === "image") return "base64";
  return "none";
}

function fileContent(kind: "text" | "image" | "binary", bytes: Uint8Array): { content?: string } {
  if (kind === "text") return { content: new TextDecoder().decode(bytes) };
  if (kind === "image") return { content: Buffer.from(bytes).toString("base64") };
  return {};
}

function onceAsyncTeardown(close: () => Promise<void>): AsyncTeardown {
  let promise: Promise<void> | null = null;
  return Object.freeze({
    close: () => {
      if (!promise) {
        try {
          promise = close();
        } catch (error) {
          promise = Promise.reject(error);
        }
      }
      return promise;
    },
  });
}

async function closePreserving(error: unknown, teardown: AsyncTeardown): Promise<never> {
  const settlement = await settleClose(teardown);
  if (!settlement.ok) {
    throw new AggregateError(
      [error, settlement.closeError],
      "Workspace file read and cleanup failed.",
      {
        cause: error,
      },
    );
  }
  throw error;
}

async function settleClose(teardown: AsyncTeardown): Promise<CloseSettlement> {
  try {
    await teardown.close();
    return { ok: true };
  } catch (closeError) {
    return { ok: false, closeError };
  }
}

async function rejectAggregate(
  promises: readonly Promise<unknown>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(promises);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}
