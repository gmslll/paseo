import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileUploadRequest, FileUploadResponse } from "../messages.js";

interface FileUploadStoreOptions {
  paseoHome: string;
  staleUploadTimeoutMs?: number;
  enterprise?: EnterpriseFileUploadStorePort;
}

export interface EnterpriseFileUploadBeginInput {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly requestId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export type EnterpriseStagedFileUploadBeginInput = Omit<
  EnterpriseFileUploadBeginInput,
  "relativePath"
>;

export interface EnterpriseFileUploadStorePort {
  begin(input: EnterpriseFileUploadBeginInput): void;
  beginStaged(input: EnterpriseStagedFileUploadBeginInput): void;
  receiveFrame(frame: FileTransferFrame): Promise<FileUploadResponse | null>;
  cleanup(reason: "session-closed" | "generation-replaced"): Promise<void>;
}

export interface EnterpriseFileUploadFrameResult {
  readonly workspaceId: string;
  readonly response: FileUploadResponse;
}

interface EnterpriseUploadAttempt {
  readonly workspaceId: string;
}

interface PendingUpload {
  requestId: string;
  id: string;
  attempt: number;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  receivedBytes: number;
  started: boolean;
  staleTimeout: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
}

export class FileUploadStore {
  private static readonly defaultStaleUploadTimeoutMs = 10 * 60 * 1000;

  private readonly paseoHome: string;
  private readonly staleUploadTimeoutMs: number;
  private readonly enterprise: EnterpriseFileUploadStorePort | null;
  private readonly pending = new Map<string, PendingUpload>();
  private readonly enterpriseWorkspaces = new Map<string, EnterpriseUploadAttempt>();

  constructor(options: FileUploadStoreOptions) {
    const enterprise = options.enterprise;
    this.paseoHome = options.paseoHome;
    this.enterprise = enterprise ? bindEnterprisePort(enterprise) : null;
    this.staleUploadTimeoutMs =
      options.staleUploadTimeoutMs ?? FileUploadStore.defaultStaleUploadTimeoutMs;
  }

  beginUpload(request: FileUploadRequest): void {
    if (this.enterprise) {
      throw new Error("Enterprise uploads require canonical workspace input.");
    }
    const existingUpload = this.pending.get(request.requestId);
    if (existingUpload) {
      this.clearPendingUpload(existingUpload);
      void existingUpload.queue.then(() => this.removeUploadDirectory(existingUpload));
    }

    const fileName = sanitizeFileName(request.fileName);
    const attempt = existingUpload ? existingUpload.attempt + 1 : 1;
    const id = buildUploadId(request.requestId, attempt);
    const uploadDir = join(this.paseoHome, "uploads", id);
    const upload: PendingUpload = {
      requestId: request.requestId,
      id,
      attempt,
      fileName,
      mimeType: request.mimeType,
      size: request.size,
      path: join(uploadDir, fileName),
      receivedBytes: 0,
      started: false,
      staleTimeout: this.createStaleUploadTimeout(request.requestId),
      queue: Promise.resolve(),
    };
    this.pending.set(request.requestId, upload);
  }

  beginEnterpriseUpload(input: EnterpriseFileUploadBeginInput): void {
    if (!this.enterprise) {
      throw new Error("Enterprise upload runtime is unavailable.");
    }
    const { requestId, workspaceId } = input;
    this.enterprise.begin(input);
    this.enterpriseWorkspaces.set(requestId, Object.freeze({ workspaceId }));
  }

  beginEnterpriseStagedUpload(input: EnterpriseStagedFileUploadBeginInput): void {
    if (!this.enterprise) {
      throw new Error("Enterprise upload runtime is unavailable.");
    }
    const { requestId, workspaceId } = input;
    this.enterprise.beginStaged(input);
    this.enterpriseWorkspaces.set(requestId, Object.freeze({ workspaceId }));
  }

  async receiveFrame(frame: FileTransferFrame): Promise<FileUploadResponse | null> {
    if (this.enterprise) {
      throw new Error("Enterprise upload frames require workspace correlation.");
    }
    const upload = this.pending.get(frame.requestId);
    if (!upload) {
      return null;
    }
    this.refreshStaleUploadTimeout(upload);

    const operation = upload.queue.then(() => this.applyFrame(upload, frame));
    upload.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async receiveEnterpriseFrame(
    frame: FileTransferFrame,
  ): Promise<EnterpriseFileUploadFrameResult | null> {
    const enterprise = this.enterprise;
    if (!enterprise) throw new Error("Enterprise upload runtime is unavailable.");
    const frameSnapshot = snapshotOwnData(frame, ["opcode", "requestId", "payload", "metadata"]);
    const requestId = requireSnapshotString(frameSnapshot, "requestId");
    const attempt = this.enterpriseWorkspaces.get(requestId);
    if (!attempt) return null;
    let request: FileTransferFrame;
    try {
      request = parseEnterpriseFrameSnapshot(frameSnapshot, requestId);
    } catch (error) {
      if (
        frameSnapshot.opcode === FileTransferOpcode.FileEnd &&
        this.enterpriseWorkspaces.get(requestId) === attempt
      ) {
        this.enterpriseWorkspaces.delete(requestId);
      }
      throw error;
    }
    let response: FileUploadResponse | null;
    try {
      response = await enterprise.receiveFrame(request);
    } catch (error) {
      if (this.enterpriseWorkspaces.get(requestId) === attempt) {
        this.enterpriseWorkspaces.delete(requestId);
      }
      throw error;
    }
    if (!response) {
      if (
        request.opcode === FileTransferOpcode.FileEnd &&
        this.enterpriseWorkspaces.get(requestId) === attempt
      ) {
        this.enterpriseWorkspaces.delete(requestId);
      }
      return null;
    }
    if (this.enterpriseWorkspaces.get(requestId) !== attempt) return null;
    this.enterpriseWorkspaces.delete(requestId);
    return Object.freeze({
      workspaceId: attempt.workspaceId,
      response: snapshotEnterpriseResponse(response, requestId, attempt.workspaceId),
    });
  }

  cleanupEnterprise(reason: "session-closed" | "generation-replaced"): Promise<void> {
    this.enterpriseWorkspaces.clear();
    return this.enterprise?.cleanup(reason) ?? Promise.resolve();
  }

  private async applyFrame(
    upload: PendingUpload,
    frame: FileTransferFrame,
  ): Promise<FileUploadResponse | null> {
    if (this.pending.get(upload.requestId) !== upload) {
      return null;
    }

    try {
      if (frame.opcode === FileTransferOpcode.FileBegin) {
        await this.startWriting(upload);
        return null;
      }
      if (frame.opcode === FileTransferOpcode.FileChunk) {
        await this.writeChunk(upload, frame.payload);
        return null;
      }
      return await this.completeUpload(upload);
    } catch (error) {
      await this.removeFailedUpload(upload);
      return buildUploadResponse(upload, getErrorMessage(error));
    }
  }

  private async startWriting(upload: PendingUpload): Promise<void> {
    await mkdir(join(this.paseoHome, "uploads", upload.id), { recursive: true });
    await writeFile(upload.path, new Uint8Array());
    upload.started = true;
  }

  private async writeChunk(upload: PendingUpload, bytes: Uint8Array): Promise<void> {
    if (!upload.started) {
      throw new Error("Upload chunks arrived before file begin.");
    }
    const nextReceivedBytes = upload.receivedBytes + bytes.byteLength;
    if (nextReceivedBytes > upload.size) {
      throw new Error(
        `Upload exceeded declared size: expected ${upload.size}, received ${nextReceivedBytes}.`,
      );
    }
    await appendFile(upload.path, bytes);
    upload.receivedBytes += bytes.byteLength;
  }

  private async completeUpload(upload: PendingUpload): Promise<FileUploadResponse> {
    this.clearPendingUpload(upload);
    if (upload.receivedBytes !== upload.size) {
      await this.removeUploadDirectory(upload);
      return buildUploadResponse(
        upload,
        `Upload size mismatch: expected ${upload.size}, received ${upload.receivedBytes}.`,
      );
    }
    return buildUploadResponse(upload, null);
  }

  private createStaleUploadTimeout(requestId: string): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => {
      this.expireStaleUpload(requestId);
    }, this.staleUploadTimeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private refreshStaleUploadTimeout(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    upload.staleTimeout = this.createStaleUploadTimeout(upload.requestId);
  }

  private expireStaleUpload(requestId: string): void {
    const upload = this.pending.get(requestId);
    if (!upload) {
      return;
    }
    this.clearPendingUpload(upload);
    const cleanup = upload.queue.then(
      () => this.removeUploadDirectory(upload),
      () => this.removeUploadDirectory(upload),
    );
    upload.queue = cleanup.then(
      () => undefined,
      () => undefined,
    );
  }

  private clearPendingUpload(upload: PendingUpload): void {
    clearTimeout(upload.staleTimeout);
    if (this.pending.get(upload.requestId) === upload) {
      this.pending.delete(upload.requestId);
    }
  }

  private async removeFailedUpload(upload: PendingUpload): Promise<void> {
    this.clearPendingUpload(upload);
    await this.removeUploadDirectory(upload);
  }

  private async removeUploadDirectory(upload: PendingUpload): Promise<void> {
    await rm(join(this.paseoHome, "uploads", upload.id), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function bindEnterprisePort(port: EnterpriseFileUploadStorePort): EnterpriseFileUploadStorePort {
  const begin = port.begin.bind(port);
  const beginStaged = port.beginStaged.bind(port);
  const receiveFrame = port.receiveFrame.bind(port);
  const cleanup = port.cleanup.bind(port);
  return Object.freeze({ begin, beginStaged, receiveFrame, cleanup });
}

interface OwnDataSnapshot {
  readonly [key: string]: unknown;
}

function parseEnterpriseFrameSnapshot(root: OwnDataSnapshot, requestId: string): FileTransferFrame {
  const opcode = requireSnapshotNumber(root, "opcode");
  const payloadValue = requireSnapshotValue(root, "payload");
  if (!(payloadValue instanceof Uint8Array)) {
    throw new Error("Invalid enterprise upload frame payload.");
  }
  const payload = new Uint8Array(payloadValue);
  if (opcode === FileTransferOpcode.FileChunk) {
    requireSnapshotKeys(root, ["opcode", "requestId", "payload"]);
    return Object.freeze({ opcode, requestId, payload });
  }
  if (opcode === FileTransferOpcode.FileEnd) {
    requireSnapshotKeys(root, ["opcode", "requestId", "payload"]);
    return Object.freeze({ opcode, requestId, payload });
  }
  if (opcode !== FileTransferOpcode.FileBegin) {
    throw new Error("Invalid enterprise upload frame opcode.");
  }
  requireSnapshotKeys(root, ["opcode", "requestId", "metadata", "payload"]);
  const metadataSnapshot = snapshotOwnData(requireSnapshotValue(root, "metadata"), [
    "mime",
    "size",
    "encoding",
    "modifiedAt",
    "revision",
    "fileName",
  ]);
  const encoding = requireSnapshotString(metadataSnapshot, "encoding");
  if (encoding !== "utf-8" && encoding !== "binary") {
    throw new Error("Invalid enterprise upload frame encoding.");
  }
  const size = requireSnapshotNumber(metadataSnapshot, "size");
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid enterprise upload frame size.");
  }
  const metadata = Object.freeze({
    mime: requireSnapshotString(metadataSnapshot, "mime"),
    size,
    encoding,
    modifiedAt: requireSnapshotString(metadataSnapshot, "modifiedAt"),
    revision: optionalSnapshotString(metadataSnapshot, "revision"),
    fileName: optionalSnapshotString(metadataSnapshot, "fileName"),
  });
  return Object.freeze({ opcode, requestId, metadata, payload });
}

function snapshotEnterpriseResponse(
  response: FileUploadResponse,
  requestId: string,
  workspaceId: string,
): FileUploadResponse {
  try {
    const root = snapshotOwnData(response, ["type", "payload"]);
    if (root.type !== "file.upload.response") {
      throw new Error("Invalid enterprise upload response type.");
    }
    const payload = snapshotOwnData(root.payload, [
      "requestId",
      "uploadId",
      "workspaceId",
      "file",
      "error",
    ]);
    if (requireSnapshotString(payload, "requestId") !== requestId) {
      throw new Error("Enterprise upload response request changed.");
    }
    const responseWorkspaceId = optionalSnapshotString(payload, "workspaceId");
    if (responseWorkspaceId !== undefined && responseWorkspaceId !== workspaceId) {
      throw new Error("Enterprise upload response workspace changed.");
    }
    const error = requireSnapshotValue(payload, "error");
    if (error !== null && typeof error !== "string") {
      throw new Error("Invalid enterprise upload response error.");
    }
    const fileValue = requireSnapshotValue(payload, "file");
    const hasUploadId = Object.prototype.hasOwnProperty.call(payload, "uploadId");
    const uploadId = optionalSnapshotNonEmptyString(payload, "uploadId");
    if (error !== null) {
      if (fileValue !== null || hasUploadId) {
        throw new Error("Invalid enterprise upload error response.");
      }
      return Object.freeze({
        type: "file.upload.response",
        payload: Object.freeze({ requestId, workspaceId, file: null, error }),
      });
    }
    if (fileValue === null || uploadId === undefined) {
      throw new Error("Invalid enterprise upload success response.");
    }
    const file = snapshotEnterpriseFile(fileValue, workspaceId, uploadId);
    const snapshotPayload = Object.freeze({
      requestId,
      uploadId,
      workspaceId,
      file,
      error: null,
    });
    return Object.freeze({ type: "file.upload.response", payload: snapshotPayload });
  } catch {
    return deniedEnterpriseResponse(requestId, workspaceId);
  }
}

function snapshotEnterpriseFile(
  value: unknown,
  workspaceId: string,
  responseUploadId: string | undefined,
): NonNullable<FileUploadResponse["payload"]["file"]> {
  const file = snapshotOwnData(value, [
    "type",
    "id",
    "uploadId",
    "workspaceId",
    "fileName",
    "mimeType",
    "size",
    "path",
  ]);
  if (file.type !== "uploaded_file") {
    throw new Error("Invalid enterprise uploaded file type.");
  }
  const uploadId = requireSnapshotNonEmptyString(file, "uploadId");
  if (responseUploadId === undefined || responseUploadId !== uploadId) {
    throw new Error("Enterprise upload response ID changed.");
  }
  if (requireSnapshotString(file, "id") !== uploadId) {
    throw new Error("Enterprise uploaded file ID changed.");
  }
  if (requireSnapshotNonEmptyString(file, "workspaceId") !== workspaceId) {
    throw new Error("Enterprise uploaded file workspace changed.");
  }
  const size = requireSnapshotValue(file, "size");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("Invalid enterprise uploaded file size.");
  }
  return Object.freeze({
    type: "uploaded_file",
    id: uploadId,
    uploadId,
    workspaceId,
    fileName: requireSnapshotString(file, "fileName"),
    mimeType: requireSnapshotString(file, "mimeType"),
    size,
    path: requireSnapshotString(file, "path"),
  });
}

function deniedEnterpriseResponse(requestId: string, workspaceId: string): FileUploadResponse {
  return Object.freeze({
    type: "file.upload.response",
    payload: Object.freeze({
      requestId,
      workspaceId,
      file: null,
      error: "Enterprise file access denied.",
    }),
  });
}

function snapshotOwnData(value: unknown, allowedKeys: readonly string[]): OwnDataSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid enterprise upload response.");
  }
  const allowed = new Set(allowedKeys);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error("Invalid enterprise upload response fields.");
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Invalid enterprise upload response field.");
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function requireSnapshotValue(snapshot: OwnDataSnapshot, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
    throw new Error(`Invalid enterprise upload ${key}.`);
  }
  return snapshot[key];
}

function requireSnapshotKeys(snapshot: OwnDataSnapshot, keys: readonly string[]): void {
  const actualKeys = Object.keys(snapshot);
  if (actualKeys.length !== keys.length || keys.some((key) => !actualKeys.includes(key))) {
    throw new Error("Invalid enterprise upload frame fields.");
  }
}

function requireSnapshotString(snapshot: OwnDataSnapshot, key: string): string {
  const field = requireSnapshotValue(snapshot, key);
  if (typeof field !== "string") throw new Error(`Invalid enterprise upload ${key}.`);
  return field;
}

function requireSnapshotNumber(snapshot: OwnDataSnapshot, key: string): number {
  const field = requireSnapshotValue(snapshot, key);
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Invalid enterprise upload ${key}.`);
  }
  return field;
}

function requireSnapshotNonEmptyString(snapshot: OwnDataSnapshot, key: string): string {
  const field = requireSnapshotString(snapshot, key);
  if (field.length === 0) throw new Error(`Invalid enterprise upload ${key}.`);
  return field;
}

function optionalSnapshotString(snapshot: OwnDataSnapshot, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(snapshot, key)) return undefined;
  const field = snapshot[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") throw new Error(`Invalid enterprise upload ${key}.`);
  return field;
}

function optionalSnapshotNonEmptyString(
  snapshot: OwnDataSnapshot,
  key: string,
): string | undefined {
  const field = optionalSnapshotString(snapshot, key);
  if (field !== undefined && field.length === 0) {
    throw new Error(`Invalid enterprise upload ${key}.`);
  }
  return field;
}

function buildUploadResponse(upload: PendingUpload, error: string | null): FileUploadResponse {
  return {
    type: "file.upload.response",
    payload: {
      requestId: upload.requestId,
      file: error
        ? null
        : {
            type: "uploaded_file",
            id: upload.id,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            size: upload.size,
            path: upload.path,
          },
      error,
    },
  };
}

function sanitizeUploadId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

function buildUploadId(requestId: string, attempt: number): string {
  const baseId = `upload_${sanitizeUploadId(requestId)}`;
  return attempt === 1 ? baseId : `${baseId}_${attempt}`;
}

function sanitizeFileName(value: string): string {
  const name = basename(value)
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
  return name.length > 0 && name !== "." && name !== ".." ? name : "upload";
}
