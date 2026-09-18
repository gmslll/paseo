import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type { FileUploadResponse } from "../messages.js";
import { FileUploadStore, type EnterpriseFileUploadStorePort } from "./index.js";

const tempDirs: string[] = [];

describe("file uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores chunked upload bytes and returns an uploaded-file attachment", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-upload"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", "hello"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-upload", " world"))).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-upload", "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-upload"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        file: {
          type: "uploaded_file",
          id: "upload_req-upload",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("rejects chunks beyond the declared size and removes the partial file", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-overflow",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-overflow"))).resolves.toBeNull();

    const uploadDir = join(paseoHome, "uploads", "upload_req-overflow");
    const path = join(uploadDir, "notes.txt");
    await expect(uploads.receiveFrame(uploadChunk("req-overflow", "hello!"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-overflow",
        file: null,
        error: "Upload exceeded declared size: expected 5, received 6.",
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
  });

  it("preserves chunk order when frames arrive before earlier disk writes finish", async () => {
    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-queued",
    });

    const results = await Promise.all([
      uploads.receiveFrame(uploadBegins("req-queued")),
      uploads.receiveFrame(uploadChunk("req-queued", "hello")),
      uploads.receiveFrame(uploadChunk("req-queued", " world")),
      uploads.receiveFrame(uploadEnds("req-queued")),
    ]);

    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]?.payload.error).toBeNull();
    expect(readFileSync(join(paseoHome, "uploads", "upload_req-queued", "notes.txt"), "utf8")).toBe(
      "hello world",
    );
  });

  it("replaces duplicate upload starts without letting the old stale timeout evict the replacement", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "old.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "old"))).resolves.toBeNull();

    await vi.advanceTimersByTimeAsync(25);
    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "new.txt",
      mimeType: "text/plain",
      size: 3,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-duplicate",
    });
    await vi.advanceTimersByTimeAsync(30);

    const path = join(paseoHome, "uploads", "upload_req-duplicate_2", "new.txt");
    await expect(uploads.receiveFrame(uploadBegins("req-duplicate"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadChunk("req-duplicate", "new"))).resolves.toBeNull();
    await expect(uploads.receiveFrame(uploadEnds("req-duplicate"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-duplicate",
        file: {
          type: "uploaded_file",
          id: "upload_req-duplicate_2",
          fileName: "new.txt",
          mimeType: "text/plain",
          size: 3,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("new");
  });

  it("keeps an active upload alive beyond the initial stale timeout", async () => {
    vi.useFakeTimers();

    const paseoHome = makePaseoHome();
    const uploads = new FileUploadStore({ paseoHome, staleUploadTimeoutMs: 50 });

    uploads.beginUpload({
      type: "file.upload.request",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 11,
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-slow-active",
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(uploads.receiveFrame(uploadBegins("req-slow-active"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(uploads.receiveFrame(uploadChunk("req-slow-active", "hello"))).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(30);
    await expect(
      uploads.receiveFrame(uploadChunk("req-slow-active", " world")),
    ).resolves.toBeNull();

    const path = join(paseoHome, "uploads", "upload_req-slow-active", "notes.txt");
    await expect(uploads.receiveFrame(uploadEnds("req-slow-active"))).resolves.toEqual({
      type: "file.upload.response",
      payload: {
        requestId: "req-slow-active",
        file: {
          type: "uploaded_file",
          id: "upload_req-slow-active",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 11,
          path,
        },
        error: null,
      },
    });
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });

  it("binds enterprise frames to the begin workspace without trusting the response payload", async () => {
    const calls: string[] = [];
    const port: EnterpriseFileUploadStorePort = {
      begin: (input) => calls.push(`begin:${input.requestId}`),
      beginStaged: (input) => calls.push(`staged:${input.requestId}`),
      receiveFrame: async (frame) => {
        calls.push(`frame:${frame.requestId}`);
        return {
          type: "file.upload.response",
          payload: {
            requestId: frame.requestId,
            workspaceId: "untrusted-response-workspace",
            file: null,
            error: "denied",
          },
        };
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    uploads.beginEnterpriseUpload({
      workspaceId: "workspace-authoritative",
      relativePath: "uploads/notes.txt",
      requestId: "request-enterprise",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 0,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    port.receiveFrame = async () => {
      throw new Error("replacement must not run");
    };

    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-enterprise"))).resolves.toEqual(
      {
        workspaceId: "workspace-authoritative",
        response: {
          type: "file.upload.response",
          payload: {
            requestId: "request-enterprise",
            workspaceId: "workspace-authoritative",
            file: null,
            error: "Enterprise file access denied.",
          },
        },
      },
    );
    await expect(
      uploads.receiveEnterpriseFrame(uploadEnds("request-enterprise")),
    ).resolves.toBeNull();
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("unknown"))).resolves.toBeNull();
    expect(calls).toEqual(["begin:request-enterprise", "frame:request-enterprise"]);
  });

  it("burns invalid enterprise response correlations and emits only canonical denial", async () => {
    const responses: FileUploadResponse[] = [
      {
        type: "file.upload.response",
        payload: {
          requestId: "wrong-request",
          workspaceId: "workspace-one",
          file: null,
          error: null,
        },
      },
      {
        type: "file.upload.response",
        payload: {
          requestId: "request-attachment",
          uploadId: "upload-two",
          workspaceId: "workspace-one",
          file: {
            type: "uploaded_file",
            id: "upload-two",
            uploadId: "upload-two",
            workspaceId: "workspace-other",
            fileName: "notes.txt",
            mimeType: "text/plain",
            size: 5,
            path: "uploads/notes.txt",
          },
          error: null,
        },
      },
    ];
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async () => {
        const response = responses.shift();
        if (!response) throw new Error("missing test response");
        return response;
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    for (const requestId of ["request-id", "request-attachment"]) {
      uploads.beginEnterpriseUpload({
        workspaceId: "workspace-one",
        relativePath: `uploads/${requestId}.txt`,
        requestId,
        fileName: `${requestId}.txt`,
        mimeType: "text/plain",
        size: 5,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
      await expect(uploads.receiveEnterpriseFrame(uploadEnds(requestId))).resolves.toEqual({
        workspaceId: "workspace-one",
        response: {
          type: "file.upload.response",
          payload: {
            requestId,
            workspaceId: "workspace-one",
            file: null,
            error: "Enterprise file access denied.",
          },
        },
      });
      await expect(uploads.receiveEnterpriseFrame(uploadEnds(requestId))).resolves.toBeNull();
    }
    expect(JSON.stringify(responses)).not.toContain("workspace-other");
  });

  it("requires upload capability IDs to be absent from error responses", async () => {
    const uploadIds = ["untrusted-upload-capability", undefined];
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async (frame) => ({
        type: "file.upload.response",
        payload: {
          requestId: frame.requestId,
          uploadId: uploadIds.shift(),
          workspaceId: "workspace-one",
          file: null,
          error: "denied",
        },
      }),
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    for (const requestId of ["request-error-id", "request-error-undefined-id"]) {
      uploads.beginEnterpriseUpload({
        workspaceId: "workspace-one",
        relativePath: "uploads/notes.txt",
        requestId,
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 0,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });

      await expect(uploads.receiveEnterpriseFrame(uploadEnds(requestId))).resolves.toEqual({
        workspaceId: "workspace-one",
        response: {
          type: "file.upload.response",
          payload: {
            requestId,
            workspaceId: "workspace-one",
            file: null,
            error: "Enterprise file access denied.",
          },
        },
      });
      await expect(uploads.receiveEnterpriseFrame(uploadEnds(requestId))).resolves.toBeNull();
    }
  });

  it("detaches and freezes a canonical enterprise upload success", async () => {
    const response: FileUploadResponse = {
      type: "file.upload.response",
      payload: {
        requestId: "request-success",
        uploadId: "upload-success",
        workspaceId: "workspace-one",
        file: {
          type: "uploaded_file",
          id: "upload-success",
          uploadId: "upload-success",
          workspaceId: "workspace-one",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 5,
          path: "uploads/notes.txt",
        },
        error: null,
      },
    };
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async () => response,
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    uploads.beginEnterpriseUpload({
      workspaceId: "workspace-one",
      relativePath: "uploads/notes.txt",
      requestId: "request-success",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });

    const result = await uploads.receiveEnterpriseFrame(uploadEnds("request-success"));
    const responseFile = response.payload.file;
    if (!responseFile) throw new Error("expected test upload file");
    response.payload.workspaceId = "workspace-mutated";
    responseFile.workspaceId = "workspace-mutated";

    expect(result).toEqual({
      workspaceId: "workspace-one",
      response: {
        type: "file.upload.response",
        payload: {
          requestId: "request-success",
          uploadId: "upload-success",
          workspaceId: "workspace-one",
          file: {
            type: "uploaded_file",
            id: "upload-success",
            uploadId: "upload-success",
            workspaceId: "workspace-one",
            fileName: "notes.txt",
            mimeType: "text/plain",
            size: 5,
            path: "uploads/notes.txt",
          },
          error: null,
        },
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.response.payload)).toBe(true);
    expect(Object.isFrozen(result?.response.payload.file)).toBe(true);
  });

  it("burns a throwing enterprise response proxy without invoking payload getters", async () => {
    let payloadGetterCalls = 0;
    const response: FileUploadResponse = {
      type: "file.upload.response",
      get payload() {
        payloadGetterCalls += 1;
        throw new Error("payload getter must not run");
      },
    };
    const throwingResponse = new Proxy(response, {
      getOwnPropertyDescriptor() {
        throw new Error("proxy descriptor failed");
      },
    });
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async () => throwingResponse,
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    uploads.beginEnterpriseUpload({
      workspaceId: "workspace-one",
      relativePath: "uploads/notes.txt",
      requestId: "request-proxy",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 0,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });

    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-proxy"))).resolves.toEqual({
      workspaceId: "workspace-one",
      response: {
        type: "file.upload.response",
        payload: {
          requestId: "request-proxy",
          workspaceId: "workspace-one",
          file: null,
          error: "Enterprise file access denied.",
        },
      },
    });
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-proxy"))).resolves.toBeNull();
    expect(payloadGetterCalls).toBe(0);
  });

  it("snapshots every response descriptor once before parsing", async () => {
    const descriptorReads = new Map<string, number>();
    const changing = <T extends object>(scope: string, target: T): T =>
      new Proxy(target, {
        getOwnPropertyDescriptor(current, key) {
          const field = `${scope}:${String(key)}`;
          const reads = (descriptorReads.get(field) ?? 0) + 1;
          descriptorReads.set(field, reads);
          if (reads > 1) {
            return { configurable: true, enumerable: true, writable: true, value: "changed" };
          }
          return Reflect.getOwnPropertyDescriptor(current, key);
        },
      });
    const file = changing("file", {
      type: "uploaded_file" as const,
      id: "upload-changing",
      uploadId: "upload-changing",
      workspaceId: "workspace-one",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      path: "uploads/notes.txt",
    });
    const payload: FileUploadResponse["payload"] = {
      requestId: "request-changing",
      uploadId: "upload-changing",
      workspaceId: "workspace-one",
      file,
      error: null,
    };
    const response = changing<FileUploadResponse>("root", {
      type: "file.upload.response",
      payload: changing("payload", payload),
    });
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async () => response,
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    uploads.beginEnterpriseUpload({
      workspaceId: "workspace-one",
      relativePath: "uploads/notes.txt",
      requestId: "request-changing",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });

    const result = await uploads.receiveEnterpriseFrame(uploadEnds("request-changing"));

    expect(result?.response.payload.file?.workspaceId).toBe("workspace-one");
    expect(descriptorReads.size).toBe(15);
    expect(new Set(descriptorReads.values())).toEqual(new Set([1]));
  });

  it("rejects symbol and non-enumerable response fields without leaking them", async () => {
    const symbolResponse: FileUploadResponse & { [key: symbol]: string } = {
      type: "file.upload.response",
      payload: {
        requestId: "request-symbol",
        workspaceId: "workspace-one",
        file: null,
        error: "denied",
      },
      [Symbol("secret")]: "must not escape",
    };
    const nonEnumerableResponse: FileUploadResponse = {
      type: "file.upload.response",
      payload: {
        requestId: "request-non-enumerable",
        workspaceId: "workspace-one",
        file: null,
        error: "denied",
      },
    };
    Object.defineProperty(nonEnumerableResponse.payload, "workspaceId", {
      configurable: true,
      enumerable: false,
      value: "workspace-one",
      writable: true,
    });
    const responses = [symbolResponse, nonEnumerableResponse];
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async () => responses.shift() ?? null,
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    for (const requestId of ["request-symbol", "request-non-enumerable"]) {
      uploads.beginEnterpriseUpload({
        workspaceId: "workspace-one",
        relativePath: `uploads/${requestId}.txt`,
        requestId,
        fileName: `${requestId}.txt`,
        mimeType: "text/plain",
        size: 0,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
      const result = await uploads.receiveEnterpriseFrame(uploadEnds(requestId));
      expect(result?.response).toEqual({
        type: "file.upload.response",
        payload: {
          requestId,
          workspaceId: "workspace-one",
          file: null,
          error: "Enterprise file access denied.",
        },
      });
      expect(Reflect.ownKeys(result?.response ?? {})).toEqual(["type", "payload"]);
    }
  });

  it("burns only the exact request binding when the enterprise port rejects", async () => {
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async (frame) => {
        if (frame.requestId === "request-reject") throw new Error("port rejected");
        return {
          type: "file.upload.response",
          payload: {
            requestId: frame.requestId,
            workspaceId: "workspace-survivor",
            file: null,
            error: "denied",
          },
        };
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    for (const [requestId, workspaceId] of [
      ["request-reject", "workspace-reject"],
      ["request-survivor", "workspace-survivor"],
    ]) {
      uploads.beginEnterpriseUpload({
        workspaceId,
        relativePath: `uploads/${requestId}.txt`,
        requestId,
        fileName: `${requestId}.txt`,
        mimeType: "text/plain",
        size: 0,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
    }

    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-reject"))).rejects.toThrow(
      "port rejected",
    );
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-reject"))).resolves.toBeNull();
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-survivor"))).resolves.toEqual({
      workspaceId: "workspace-survivor",
      response: {
        type: "file.upload.response",
        payload: {
          requestId: "request-survivor",
          workspaceId: "workspace-survivor",
          file: null,
          error: "denied",
        },
      },
    });
  });

  it("burns only the exact binding for a malformed terminal frame", async () => {
    const received: string[] = [];
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async (frame) => {
        received.push(frame.requestId);
        return {
          type: "file.upload.response",
          payload: {
            requestId: frame.requestId,
            workspaceId: "workspace-survivor",
            file: null,
            error: "denied",
          },
        };
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    for (const [requestId, workspaceId] of [
      ["request-malformed", "workspace-malformed"],
      ["request-survivor", "workspace-survivor"],
    ]) {
      uploads.beginEnterpriseUpload({
        workspaceId,
        relativePath: `uploads/${requestId}.txt`,
        requestId,
        fileName: `${requestId}.txt`,
        mimeType: "text/plain",
        size: 0,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
    }
    const malformed = uploadEnds("request-malformed");
    Object.defineProperty(malformed, "metadata", {
      configurable: true,
      enumerable: true,
      value: { mime: "text/plain" },
    });

    await expect(uploads.receiveEnterpriseFrame(malformed)).rejects.toThrow(
      "Invalid enterprise upload frame fields.",
    );
    await expect(
      uploads.receiveEnterpriseFrame(uploadEnds("request-malformed")),
    ).resolves.toBeNull();
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-survivor"))).resolves.toEqual({
      workspaceId: "workspace-survivor",
      response: {
        type: "file.upload.response",
        payload: {
          requestId: "request-survivor",
          workspaceId: "workspace-survivor",
          file: null,
          error: "denied",
        },
      },
    });
    expect(received).toEqual(["request-survivor"]);
  });

  it("does not let an old terminal completion burn a same-workspace rebind", async () => {
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let receiveCalls = 0;
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async (frame) => {
        receiveCalls += 1;
        if (receiveCalls === 1) await oldGate;
        return {
          type: "file.upload.response",
          payload: {
            requestId: frame.requestId,
            workspaceId: "workspace-one",
            file: null,
            error: receiveCalls === 1 ? "old" : "new",
          },
        };
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    const begin = () =>
      uploads.beginEnterpriseUpload({
        workspaceId: "workspace-one",
        relativePath: "uploads/notes.txt",
        requestId: "request-rebind",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 0,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
    begin();
    const oldReceive = uploads.receiveEnterpriseFrame(uploadEnds("request-rebind"));
    expect(receiveCalls).toBe(1);
    begin();
    releaseOld();

    await expect(oldReceive).resolves.toBeNull();
    await expect(uploads.receiveEnterpriseFrame(uploadEnds("request-rebind"))).resolves.toEqual({
      workspaceId: "workspace-one",
      response: {
        type: "file.upload.response",
        payload: {
          requestId: "request-rebind",
          workspaceId: "workspace-one",
          file: null,
          error: "new",
        },
      },
    });
    expect(receiveCalls).toBe(2);
  });

  it("passes a detached frame snapshot across the enterprise await boundary", async () => {
    let releaseFrame!: () => void;
    const frameGate = new Promise<void>((resolve) => {
      releaseFrame = resolve;
    });
    let receivedRequestId = "";
    let receivedText = "";
    const port: EnterpriseFileUploadStorePort = {
      begin: () => undefined,
      beginStaged: () => undefined,
      receiveFrame: async (frame) => {
        await frameGate;
        receivedRequestId = frame.requestId;
        receivedText = new TextDecoder().decode(frame.payload);
        return null;
      },
      cleanup: async () => undefined,
    };
    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });
    uploads.beginEnterpriseUpload({
      workspaceId: "workspace-one",
      relativePath: "uploads/notes.txt",
      requestId: "request-frame",
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      modifiedAt: "2026-09-10T00:00:00.000Z",
    });
    const callerFrame = uploadChunk("request-frame", "hello");

    const receiving = uploads.receiveEnterpriseFrame(callerFrame);
    callerFrame.requestId = "request-mutated";
    callerFrame.payload.fill(0);
    releaseFrame();
    await receiving;

    expect(receivedRequestId).toBe("request-frame");
    expect(receivedText).toBe("hello");
  });

  it("reads each enterprise port method once at construction", () => {
    const reads = { begin: 0, beginStaged: 0, receiveFrame: 0, cleanup: 0 };
    const port: EnterpriseFileUploadStorePort = {
      get begin() {
        reads.begin += 1;
        return () => undefined;
      },
      get beginStaged() {
        reads.beginStaged += 1;
        return () => undefined;
      },
      get receiveFrame() {
        reads.receiveFrame += 1;
        return async () => null;
      },
      get cleanup() {
        reads.cleanup += 1;
        return async () => undefined;
      },
    };

    const uploads = new FileUploadStore({ paseoHome: makePaseoHome(), enterprise: port });

    expect(uploads).toBeInstanceOf(FileUploadStore);
    expect(reads).toEqual({ begin: 1, beginStaged: 1, receiveFrame: 1, cleanup: 1 });
  });
});

function makePaseoHome(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-upload-test-")));
  tempDirs.push(root);
  return root;
}

function uploadBegins(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: 11,
        encoding: "binary",
        modifiedAt: "2026-05-02T00:00:00.000Z",
        fileName: "notes.txt",
      },
    }),
  );
}

function uploadChunk(requestId: string, text: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId,
      payload: new TextEncoder().encode(text),
    }),
  );
}

function uploadEnds(requestId: string): FileTransferFrame {
  return decodeUploadFrame(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId,
    }),
  );
}

function decodeUploadFrame(bytes: Uint8Array): FileTransferFrame {
  const frame = decodeFileTransferFrame(bytes);
  if (!frame) {
    throw new Error("Expected file transfer frame");
  }
  return frame;
}
