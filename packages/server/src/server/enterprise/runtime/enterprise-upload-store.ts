import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import {
  NodeContextSchema,
  PrincipalContextSchema,
  type NodeContext,
  type PrincipalContext,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { EnterpriseSessionContext } from "../identity/session-context.js";
import type {
  EnterpriseFileUploadBeginInput,
  EnterpriseFileUploadStorePort,
  EnterpriseStagedFileUploadBeginInput,
} from "../../file-upload/index.js";
import type { FileUploadResponse } from "../../messages.js";
import type {
  EnterpriseUploadCleanupInput,
  EnterpriseUploadFinalizeInput,
  EnterpriseUploadIssue,
  EnterpriseUploadPolicy,
} from "./enterprise-upload-policy.js";
import type { SafeWorkspaceFsPort } from "./workspace-path-policy.js";

const EnterpriseSessionContextSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
  })
  .strict();

const EnterpriseUploadBeginSchema = z
  .object({
    workspaceId: z.string().min(1),
    relativePath: z.string().min(1).refine(isSafeRelativePath),
    requestId: z.string().min(1),
    fileName: z.string().min(1).refine(isSafeFileName),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    modifiedAt: z.string().min(1),
  })
  .strict();

const EnterpriseStagedUploadBeginSchema = EnterpriseUploadBeginSchema.omit({
  relativePath: true,
}).strict();

const ISSUE_CANCELLED = Symbol("enterprise-upload-issue-cancelled");

export interface EnterpriseUploadStoreOptions {
  readonly context: EnterpriseSessionContext;
  readonly policy: Pick<
    EnterpriseUploadPolicy,
    "issue" | "append" | "finalize" | "abort" | "cleanup"
  >;
  readonly safeFs: Pick<
    SafeWorkspaceFsPort,
    "releaseReady" | "supportsDirectoryRelativeOperations"
  >;
  readonly createStagingRelativePath?: (input: {
    readonly context: EnterpriseSessionContext;
    readonly workspaceId: string;
    readonly requestId: string;
  }) => string;
}

type IssueSettlement =
  | { readonly ok: true; readonly value: EnterpriseUploadIssue }
  | { readonly ok: false; readonly error: unknown };

interface PendingUpload {
  readonly input: EnterpriseFileUploadBeginInput;
  readonly issue: Promise<IssueSettlement>;
  queue: Promise<FileUploadResponse | null>;
  receivedBytes: number;
  started: boolean;
}

/** Session-bound binary upload lifecycle. No filesystem path or capability crosses this boundary. */
export class EnterpriseUploadStore implements EnterpriseFileUploadStorePort {
  private readonly context: EnterpriseSessionContext;
  private readonly issueUpload: EnterpriseUploadPolicy["issue"];
  private readonly appendUpload: EnterpriseUploadPolicy["append"];
  private readonly finalizeUpload: EnterpriseUploadPolicy["finalize"];
  private readonly abortUpload: EnterpriseUploadPolicy["abort"];
  private readonly cleanupUploads: EnterpriseUploadPolicy["cleanup"];
  private readonly releaseReady: boolean;
  private readonly createStagingRelativePath: NonNullable<
    EnterpriseUploadStoreOptions["createStagingRelativePath"]
  >;
  private readonly pending = new Map<string, PendingUpload>();
  private readonly failures: unknown[] = [];
  private closed = false;
  private cleanupPromise: Promise<void> | null = null;

  public constructor(options: EnterpriseUploadStoreOptions) {
    this.context = freezeContext(EnterpriseSessionContextSchema.parse(options.context));
    this.releaseReady =
      options.safeFs.releaseReady === true &&
      options.safeFs.supportsDirectoryRelativeOperations === true;
    this.issueUpload = options.policy.issue.bind(options.policy);
    this.appendUpload = options.policy.append.bind(options.policy);
    this.finalizeUpload = options.policy.finalize.bind(options.policy);
    this.abortUpload = options.policy.abort.bind(options.policy);
    this.cleanupUploads = options.policy.cleanup.bind(options.policy);
    const createStagingRelativePath =
      options.createStagingRelativePath ??
      (() => {
        throw new Error("Enterprise upload staging policy is unavailable.");
      });
    this.createStagingRelativePath = (input) => createStagingRelativePath(input);
  }

  public begin(input: EnterpriseFileUploadBeginInput): void {
    if (this.closed) throw new Error("Enterprise upload session is closed.");
    if (!this.releaseReady) throw new Error("Enterprise upload access denied.");
    const request = EnterpriseUploadBeginSchema.parse(input);
    if (this.pending.has(request.requestId)) throw new Error("Enterprise upload access denied.");
    const requestInput = Object.freeze({ ...request });
    const issue: Promise<IssueSettlement> = Promise.resolve()
      .then(() => {
        if (this.closed) throw ISSUE_CANCELLED;
        return this.issueUpload({
          principal: this.context.principal,
          node: this.context.node,
          sessionBindingGeneration: this.context.sessionBindingGeneration,
          workspaceId: request.workspaceId,
          relativePath: request.relativePath,
        });
      })
      .then<IssueSettlement>((value) => ({ ok: true, value }))
      .catch((error: unknown): IssueSettlement => {
        if (error !== ISSUE_CANCELLED && !this.closed) this.failures.push(error);
        return { ok: false, error };
      });
    const pending: PendingUpload = {
      input: requestInput,
      issue,
      queue: Promise.resolve(null),
      receivedBytes: 0,
      started: false,
    };
    this.pending.set(request.requestId, pending);
  }

  public beginStaged(input: EnterpriseStagedFileUploadBeginInput): void {
    if (this.closed) throw new Error("Enterprise upload session is closed.");
    if (!this.releaseReady) throw new Error("Enterprise upload access denied.");
    const request = EnterpriseStagedUploadBeginSchema.parse(input);
    if (this.pending.has(request.requestId)) throw new Error("Enterprise upload access denied.");
    const relativePath = this.createStagingRelativePath({
      context: this.context,
      workspaceId: request.workspaceId,
      requestId: request.requestId,
    });
    this.begin({ ...request, relativePath });
  }

  public receiveFrame(frame: FileTransferFrame): Promise<FileUploadResponse | null> {
    const pending = this.pending.get(frame.requestId);
    if (!pending || this.closed) return Promise.resolve(null);
    const operation = pending.queue.then(() => this.applyFrame(pending, frame));
    pending.queue = operation;
    return operation;
  }

  public cleanup(reason: "session-closed" | "generation-replaced"): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const uploads = [...this.pending.values()];
    this.cleanupPromise = this.performCleanup(reason, uploads);
    return this.cleanupPromise;
  }

  private async applyFrame(
    pending: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.closed || this.pending.get(frame.requestId) !== pending) return null;
    try {
      const settlement = await pending.issue;
      if (!settlement.ok) return this.denied(pending);
      const issued = settlement.value;
      if (this.closed || this.pending.get(frame.requestId) !== pending) return null;
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        if (pending.started) {
          return await this.fail(pending, issued.uploadId, "Upload already started.");
        }
        pending.started = true;
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        if (!pending.started) {
          return await this.fail(
            pending,
            issued.uploadId,
            "Upload chunks arrived before file begin.",
          );
        }
        const nextSize = pending.receivedBytes + frame.payload.byteLength;
        if (!Number.isSafeInteger(nextSize) || nextSize > pending.input.size) {
          return await this.fail(pending, issued.uploadId, "Upload exceeded declared size.");
        }
        const appended = await this.appendUpload({
          ...this.policyInput(pending, issued.uploadId),
          offset: pending.receivedBytes,
          bytes: new Uint8Array(frame.payload),
        });
        if (!appended) return this.denied(pending);
        pending.receivedBytes = nextSize;
        return null;
      }
      if (!pending.started || pending.receivedBytes !== pending.input.size) {
        return await this.fail(pending, issued.uploadId, "Upload size mismatch.");
      }
      this.pending.delete(pending.input.requestId);
      const result = await this.finalizeUpload(this.policyInput(pending, issued.uploadId));
      if (result === null) return this.denied(pending);
      return {
        type: "file.upload.response",
        payload: {
          requestId: pending.input.requestId,
          uploadId: result.uploadId,
          workspaceId: result.workspace.workspaceId,
          file: {
            type: "uploaded_file",
            id: result.uploadId,
            uploadId: result.uploadId,
            workspaceId: result.workspace.workspaceId,
            fileName: pending.input.fileName,
            mimeType: pending.input.mimeType,
            size: result.fileIdentity.size,
            path: result.relativePath,
          },
          error: null,
        },
      };
    } catch (error) {
      this.failures.push(error);
      this.pending.delete(pending.input.requestId);
      return this.denied(pending);
    }
  }

  private async fail(
    pending: PendingUpload,
    uploadId: string,
    error: string,
  ): Promise<FileUploadResponse> {
    this.pending.delete(pending.input.requestId);
    try {
      await this.abortUpload(this.policyInput(pending, uploadId));
    } catch (abortError) {
      this.failures.push(abortError);
      return response(pending.input.requestId, "Upload cleanup failed.");
    }
    return response(pending.input.requestId, error);
  }

  private async performCleanup(
    reason: "session-closed" | "generation-replaced",
    uploads: readonly PendingUpload[],
  ): Promise<void> {
    const policyCleanup = settleCall(() => this.cleanupUploads(this.cleanupInput(reason)));
    await Promise.all(uploads.map((upload) => upload.issue));
    const results = await Promise.all([
      policyCleanup,
      ...uploads.map((upload) => settlePromise(upload.queue)),
    ]);
    for (const result of results) {
      if (result.status === "rejected") this.failures.push(result.reason);
    }
    for (const upload of uploads) {
      if (this.pending.get(upload.input.requestId) === upload) {
        this.pending.delete(upload.input.requestId);
      }
    }
    if (this.failures.length > 0) {
      throw new AggregateError([...this.failures], "Enterprise upload cleanup failed.");
    }
  }

  private denied(pending: PendingUpload): FileUploadResponse {
    this.pending.delete(pending.input.requestId);
    return response(pending.input.requestId, "Upload access denied.");
  }

  private policyInput(pending: PendingUpload, uploadId: string): EnterpriseUploadFinalizeInput {
    return {
      principal: this.context.principal,
      node: this.context.node,
      sessionBindingGeneration: this.context.sessionBindingGeneration,
      workspaceId: pending.input.workspaceId,
      relativePath: pending.input.relativePath,
      uploadId,
    };
  }

  private cleanupInput(
    reason: "session-closed" | "generation-replaced",
  ): EnterpriseUploadCleanupInput {
    return {
      reason,
      organizationId: this.context.principal.organizationId,
      node: this.context.node,
      principalId: this.context.principal.principalId,
      credentialId: this.context.principal.credentialId,
      grantVersion: this.context.principal.grantVersion,
      sessionBindingGeneration: this.context.sessionBindingGeneration,
    };
  }
}

type PromiseSettlement =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: unknown };

function settleCall(operation: () => PromiseLike<unknown>): Promise<PromiseSettlement> {
  try {
    return settlePromise(operation());
  } catch (error) {
    return Promise.resolve({ status: "rejected", reason: error });
  }
}

function settlePromise(promise: PromiseLike<unknown>): Promise<PromiseSettlement> {
  return Promise.resolve(promise).then<PromiseSettlement, PromiseSettlement>(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function response(requestId: string, error: string): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: { requestId, file: null, error },
  };
}

function freezeContext(
  input: z.infer<typeof EnterpriseSessionContextSchema>,
): EnterpriseSessionContext {
  return Object.freeze({
    principal: freezePrincipal(input.principal),
    node: freezeNode(input.node),
    sessionBindingGeneration: input.sessionBindingGeneration,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") {
    return Object.freeze({ ...input, grants });
  }
  if (input.principalType === "service") {
    return Object.freeze({ ...input, grants });
  }
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
    grants,
  });
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  return Object.freeze({ action: input.action, selector: cloneSelector(input.selector) });
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") return Object.freeze({ kind: input.kind });
  if (input.kind === "organization") {
    return Object.freeze({ kind: input.kind, organizationId: input.organizationId });
  }
  const workspaceIds = [...input.workspaceIds];
  Object.freeze(workspaceIds);
  return Object.freeze({ kind: input.kind, workspaceIds });
}

function freezeNode(input: NodeContext): NodeContext {
  return Object.freeze({
    nodeId: input.nodeId,
    paseoServerId: input.paseoServerId,
    mode: input.mode,
  });
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\"),
  );
}

function isSafeFileName(value: string): boolean {
  return (
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}
