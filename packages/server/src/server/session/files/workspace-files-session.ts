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
import type { EnterpriseFileUploadBeginInput } from "../../file-upload/index.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
  enterpriseRuntime?: EnterpriseWorkspaceFilesRuntime;
}

interface AsyncTeardown {
  close(): Promise<void>;
}

interface EnterpriseSubscriptionAttempt {
  active: boolean;
  teardown: AsyncTeardown | null;
  cleanupPromise: Promise<void> | null;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. It owns the upload store and reaches no
 * workspace-git, registry, or subscription state — file I/O scoped to a cwd is
 * the whole concern.
 */
export class WorkspaceFilesSession {
  private readonly host: WorkspaceFilesSessionHost;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly enterpriseRuntime: EnterpriseWorkspaceFilesRuntime | null;
  private readonly fileSubscriptions = new Map<string, AsyncTeardown>();
  private readonly enterpriseSubscriptions = new Map<string, EnterpriseSubscriptionAttempt>();
  private cleanupPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.enterpriseRuntime = options.enterpriseRuntime ?? null;
    this.fileUploads = new FileUploadStore({
      paseoHome: options.paseoHome,
      enterprise: this.enterpriseRuntime?.createUploadStore(),
    });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    if (this.closed) throw new Error("Workspace file session is closed.");
    if (this.enterpriseRuntime) {
      await this.handleEnterpriseSubscribe(request);
      return;
    }
    try {
      await this.closeSubscription(request.subscriptionId);
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.host.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(
        request.subscriptionId,
        onceAsyncTeardown(async () => subscription.unsubscribe()),
      );
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
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
    if (this.enterpriseRuntime) {
      await this.closeEnterpriseSubscription(request.subscriptionId);
      if (this.closed) return;
    } else {
      await this.closeSubscription(request.subscriptionId);
    }
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    if (this.enterpriseRuntime) {
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        await this.enterpriseRuntime.write({
          workspaceId,
          relativePath: request.path,
          requestId: request.requestId,
          bytes: new TextEncoder().encode(request.content),
          expectedModifiedAt: request.expectedModifiedAt,
          expectedRevision: request.expectedRevision,
        });
        const stat = await this.enterpriseRuntime.stat({
          workspaceId,
          relativePath: request.path,
          requestId: request.requestId,
        });
        this.host.emit({
          type: "fs.file.write.response",
          payload: {
            result: {
              status: "written",
              modifiedAt: new Date(stat.mtimeMs).toISOString(),
              size: stat.size,
              revision: fileRevision(stat),
            },
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "fs.file.write.response",
          payload: {
            result: { status: "error", error: enterpriseDenied() },
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const result = await writeExplorerFile({
      root: request.cwd,
      relativePath: request.path,
      content: request.content,
      expectedModifiedAt: request.expectedModifiedAt,
      expectedRevision: request.expectedRevision,
    });
    this.host.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    if (this.enterpriseRuntime) {
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        const relativePath = joinRelative(request.parentPath, request.name);
        await this.enterpriseRuntime.create({
          workspaceId,
          relativePath,
          requestId: request.requestId,
          kind: request.kind,
        });
        this.host.emit({
          type: "fs.entry.create.response",
          payload: {
            cwd: "",
            parentPath: request.parentPath,
            path: relativePath,
            success: true,
            error: null,
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "fs.entry.create.response",
          payload: {
            cwd: "",
            parentPath: request.parentPath,
            path: null,
            success: false,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const result = await createExplorerEntry({
      root: request.cwd,
      parentPath: request.parentPath,
      name: request.name,
      kind: request.kind,
    });
    this.host.emit({
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

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    if (this.enterpriseRuntime) {
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        const destinationRelativePath = joinRelative(parentRelative(request.path), request.name);
        await this.enterpriseRuntime.rename({
          workspaceId,
          sourceRelativePath: request.path,
          destinationRelativePath,
          requestId: request.requestId,
        });
        this.host.emit({
          type: "fs.entry.rename.response",
          payload: {
            cwd: "",
            path: request.path,
            renamedPath: destinationRelativePath,
            success: true,
            error: null,
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "fs.entry.rename.response",
          payload: {
            cwd: "",
            path: request.path,
            renamedPath: null,
            success: false,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const result = await renameExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      name: request.name,
    });
    this.host.emit({
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

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    if (this.enterpriseRuntime) {
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        const destinationRelativePath = `${request.path}.copy`;
        await this.enterpriseRuntime.copy({
          workspaceId,
          sourceRelativePath: request.path,
          destinationRelativePath,
          requestId: request.requestId,
        });
        this.host.emit({
          type: "fs.entry.duplicate.response",
          payload: {
            cwd: "",
            path: request.path,
            duplicatedPath: destinationRelativePath,
            success: true,
            error: null,
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "fs.entry.duplicate.response",
          payload: {
            cwd: "",
            path: request.path,
            duplicatedPath: null,
            success: false,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const result = await duplicateExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
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

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    if (this.enterpriseRuntime) {
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        await this.enterpriseRuntime.delete({
          workspaceId,
          relativePath: request.path,
          requestId: request.requestId,
        });
        this.host.emit({
          type: "fs.entry.delete.response",
          payload: {
            cwd: "",
            path: request.path,
            success: true,
            error: null,
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "fs.entry.delete.response",
          payload: {
            cwd: "",
            path: request.path,
            success: false,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const result = await deleteExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
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

  dispose(): Promise<void> {
    return this.cleanupEnterprise("session-closed");
  }

  cleanupEnterprise(reason: "session-closed" | "generation-replaced"): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const subscriptions = [...this.fileSubscriptions.values()];
    this.fileSubscriptions.clear();
    const enterpriseSubscriptions = [...this.enterpriseSubscriptions.values()];
    for (const subscription of enterpriseSubscriptions) subscription.active = false;
    this.enterpriseSubscriptions.clear();
    this.cleanupPromise = rejectAggregate(
      [
        ...subscriptions.map((subscription) => subscription.close()),
        ...enterpriseSubscriptions.map((subscription) =>
          this.cleanupEnterpriseSubscription(subscription),
        ),
        this.fileUploads.cleanupEnterprise(reason),
        ...(this.enterpriseRuntime ? [this.enterpriseRuntime.cleanup(reason)] : []),
      ],
      "Workspace file cleanup failed.",
    );
    return this.cleanupPromise;
  }

  async handleFileExplorerRequest(request: FileExplorerRequest, source?: object): Promise<void> {
    if (this.enterpriseRuntime) {
      await this.handleEnterpriseExplorer(request, source);
      return;
    }
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit(
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

        this.host.emit(
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
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
            await this.host.emitBinary(
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
              await this.host.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.host.emitBinary(
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

          this.host.emit(
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
      this.host.emit(
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
    if (this.enterpriseRuntime) {
      try {
        this.fileUploads.beginEnterpriseStagedUpload({
          workspaceId: requireWorkspaceId(request.workspaceId),
          requestId: request.requestId,
          fileName: request.fileName,
          mimeType: request.mimeType,
          size: request.size,
          modifiedAt: request.modifiedAt,
        });
      } catch {
        this.host.emit({
          type: "file.upload.response",
          payload: {
            requestId: request.requestId,
            workspaceId: request.workspaceId,
            file: null,
            error: enterpriseDenied(),
          },
        });
      }
      return;
    }
    this.fileUploads.beginUpload(request);
  }

  handleEnterpriseFileUploadRequest(request: EnterpriseFileUploadBeginInput): void {
    try {
      this.fileUploads.beginEnterpriseUpload(request);
    } catch {
      this.host.emit({
        type: "file.upload.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          file: null,
          error: enterpriseDenied(),
        },
      });
    }
  }

  async handleFileTransferFrame(frame: FileTransferFrame): Promise<void> {
    const response = await this.fileUploads.receiveFrame(frame);
    if (response) {
      this.host.emit(response);
    }
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    if (this.enterpriseRuntime) {
      this.host.emit({
        type: "project_icon_response",
        payload: { cwd: "", icon: null, error: enterpriseDenied(), requestId },
      });
      return;
    }

    try {
      const icon = await getProjectIcon(cwd);
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
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
    if (this.enterpriseRuntime) {
      const requestedPath = request.path;
      try {
        const workspaceId = requireWorkspaceId(request.workspaceId);
        const issued = await this.enterpriseRuntime.issueDownloadToken({
          workspaceId,
          relativePath: requestedPath,
          requestId: request.requestId,
        });
        this.host.emit({
          type: "file_download_token_response",
          payload: {
            cwd: "",
            path: issued.relativePath,
            token: issued.token,
            fileName: fileName(issued.relativePath),
            mimeType: mimeType(issued.relativePath),
            size: issued.size,
            error: null,
            requestId: request.requestId,
          },
        });
      } catch {
        this.host.emit({
          type: "file_download_token_response",
          payload: {
            cwd: "",
            path: requestedPath,
            token: null,
            fileName: null,
            mimeType: null,
            size: null,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        });
      }
      return;
    }
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
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

      this.host.emit({
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
      this.host.emit({
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

  private handleEnterpriseSubscribe(request: FileSubscribeRequest): Promise<void> {
    const previous = this.enterpriseSubscriptions.get(request.subscriptionId) ?? null;
    if (previous) previous.active = false;
    const attempt = createEnterpriseSubscriptionAttempt();
    this.enterpriseSubscriptions.set(request.subscriptionId, attempt);
    return this.performEnterpriseSubscribe(request, attempt, previous);
  }

  private async performEnterpriseSubscribe(
    request: FileSubscribeRequest,
    attempt: EnterpriseSubscriptionAttempt,
    previous: EnterpriseSubscriptionAttempt | null,
  ): Promise<void> {
    try {
      if (previous) await this.cleanupEnterpriseSubscription(previous);
      this.assertEnterpriseSubscriptionCurrent(request.subscriptionId, attempt);
      const runtime = this.enterpriseRuntime;
      if (!runtime) throw new Error("Enterprise file runtime is unavailable.");
      const workspaceId = requireWorkspaceId(request.workspaceId);
      const requestContext = {
        workspaceId,
        relativePath: request.path,
        requestId: request.requestId,
      };
      const initial = await runtime.stat(requestContext);
      this.assertEnterpriseSubscriptionCurrent(request.subscriptionId, attempt);
      const subscription = await runtime.watch(requestContext, () => {
        if (this.enterpriseSubscriptionIsCurrent(request.subscriptionId, attempt)) {
          void this.emitEnterpriseFileVersion(
            runtime,
            workspaceId,
            request.path,
            request.subscriptionId,
            request.requestId,
            attempt,
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
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: enterpriseFileVersion(request.path, initial),
          requestId: request.requestId,
        },
      });
    } catch {
      if (this.enterpriseSubscriptionIsCurrent(request.subscriptionId, attempt)) {
        attempt.active = false;
        this.enterpriseSubscriptions.delete(request.subscriptionId);
        this.host.emit({
          type: "fs.file.subscribe.response",
          payload: {
            subscriptionId: request.subscriptionId,
            initial: {
              status: "error",
              cwd: "",
              path: request.path,
              error: enterpriseDenied(),
            },
            requestId: request.requestId,
          },
        });
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
      this.host.emit({
        type: "fs.file.update",
        payload: { subscriptionId, version: enterpriseFileVersion(relativePath, stat) },
      });
    } catch {
      if (!this.enterpriseSubscriptionIsCurrent(subscriptionId, attempt)) return;
      this.host.emit({
        type: "fs.file.update",
        payload: {
          subscriptionId,
          version: { status: "error", cwd: "", path: relativePath, error: enterpriseDenied() },
        },
      });
    }
  }

  private async handleEnterpriseExplorer(
    request: FileExplorerRequest,
    source?: object,
  ): Promise<void> {
    const relativePath = request.path ?? ".";
    try {
      const runtime = this.enterpriseRuntime;
      if (!runtime) throw new Error("Enterprise file runtime is unavailable.");
      const workspaceId = requireWorkspaceId(request.workspaceId);
      if (request.mode === "list") {
        const entries = await runtime.list({
          workspaceId,
          relativePath,
          requestId: request.requestId,
        });
        this.host.emit(
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
              requestId: request.requestId,
            },
          },
          source,
        );
        return;
      }
      const capability = await runtime.openRead({
        workspaceId,
        relativePath,
        requestId: request.requestId,
      });
      try {
        if (request.maxBytes !== undefined && capability.size > request.maxBytes) {
          throw new Error("File is too large to display.");
        }
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await this.streamEnterpriseFile(capability, request.requestId, source);
          return;
        }
        const bytes = await readAll(capability);
        const kind = fileKind(relativePath);
        this.host.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd: "",
              path: relativePath,
              mode: request.mode,
              directory: null,
              file: {
                path: relativePath,
                kind,
                encoding: fileEncoding(kind),
                ...fileContent(kind, bytes),
                mimeType: mimeType(relativePath),
                size: capability.size,
                modifiedAt: new Date(capability.mtimeMs).toISOString(),
                revision: fileRevision(capability),
              },
              error: null,
              requestId: request.requestId,
            },
          },
          source,
        );
      } finally {
        await capability.close();
      }
    } catch {
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: "",
            path: relativePath,
            mode: request.mode,
            directory: null,
            file: null,
            error: enterpriseDenied(),
            requestId: request.requestId,
          },
        },
        source,
      );
    }
  }

  private async streamEnterpriseFile(
    capability: EnterpriseWorkspaceReadCapability,
    requestId: string,
    source?: object,
  ): Promise<void> {
    await this.host.emitBinary(
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
      source,
    );
    for (let offset = 0; offset < capability.size; offset += 256 * 1024) {
      const chunk = await capability.read(offset, Math.min(256 * 1024, capability.size - offset));
      await this.host.emitBinary(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId,
          payload: chunk,
        }),
        source,
      );
    }
    await this.host.emitBinary(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
      source,
    );
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
}

function createEnterpriseSubscriptionAttempt(): EnterpriseSubscriptionAttempt {
  let resolveSettled!: () => void;
  return {
    active: true,
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

async function rejectAggregate(
  promises: readonly Promise<unknown>[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(promises);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}
