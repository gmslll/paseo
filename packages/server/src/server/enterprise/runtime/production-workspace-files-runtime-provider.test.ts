import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionAuthorization } from "../../authorization/index.js";
import { FileBackedGrantStorage, type GrantRecord } from "../access/grant-store.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
} from "../access/production-authorization-runtime-provider.js";
import type { ProductionAuthorizationStatePort } from "../access/production-authorization-runtime.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
} from "../identity/admission-authorization.js";
import {
  createProductionEnterpriseWorkspaceFilesProvider,
  type EnterpriseDownloadHttpResponsePort,
  type EnterpriseWorkspaceFilesProductionProvider,
} from "./production-workspace-files-runtime-provider.js";

const executeFile = promisify(execFile);
const node: NodeContext = Object.freeze({
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_w5_files",
  mode: "standalone",
});
const principal: PrincipalContext = Object.freeze({
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_w5_files",
  grantVersion: "grv_1",
  grants: Object.freeze([
    {
      action: "workspace.content.read",
      selector: { kind: "workspace", workspaceIds: ["wks_a"] },
    },
    {
      action: "workspace.write",
      selector: { kind: "workspace", workspaceIds: ["wks_a"] },
    },
  ]),
});

class EmptyAuthorityState implements ProductionAuthorizationStatePort {
  async consumeAuthorizedRequest() {
    return null;
  }
  async resolveCurrentSessionBinding() {
    return null;
  }
  async register() {
    return null;
  }
  async resolveOpen() {
    return null;
  }
  async mintFreshReceipt() {
    return null;
  }
  async burnFreshReceipts() {}
  async close() {}
}

let parent = "";
let auditAddonPath = "";
let workspaceAddonPath = "";

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  parent = await mkdtemp(path.join(os.tmpdir(), "paseo-w5-production-files-"));
  auditAddonPath = path.join(parent, "darwin-audit-fs.node");
  workspaceAddonPath = path.join(parent, "darwin-workspace-fs.node");
  await Promise.all([
    executeFile(process.execPath, [
      fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      auditAddonPath,
    ]),
    executeFile(process.execPath, [
      fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
      "--output",
      workspaceAddonPath,
    ]),
  ]);
});

afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("production enterprise workspace files provider", () => {
  test("fails closed without the real Darwin binding before consulting workspace storage", async () => {
    let getCalls = 0;
    const provider = createProductionEnterpriseWorkspaceFilesProvider({
      workspaceRoots: {
        async get() {
          getCalls += 1;
          return null;
        },
      },
      nativeAddonPath: path.join(os.tmpdir(), "missing-paseo-workspace-fs.node"),
    });

    expect(provider).not.toBeNull();
    expect(provider?.releaseReady).toBe(false);
    const response = new TestHttpResponse();
    await expect(
      provider?.httpHandler.handle({
        principal,
        node,
        query: {
          workspaceId: "wks_a",
          relativePath: "file.txt",
          token: "not-issued",
        },
        response,
      }),
    ).resolves.toBeUndefined();
    expect(response.rejections).toEqual([403]);
    expect(getCalls).toBe(0);
  });

  test.runIf(process.platform === "darwin")(
    "binds one W2 authorization runtime to safe workspace IO and the HTTP consumer",
    async () => {
      const workspaceRootInput = path.join(parent, "workspace-a");
      await mkdir(workspaceRootInput, { recursive: true });
      const workspaceRoot = await realpath(workspaceRootInput);
      await writeFile(path.join(workspaceRoot, "file.txt"), "enterprise-file");
      const fixture = await createAuthorizationFixture("happy");
      const provider = createProvider(workspaceRoot);
      const runtime = provider.createSessionRuntime(fixture.runtime);

      expect(runtime).not.toBeNull();
      await expect(
        runtime?.stat({ workspaceId: "wks_a", relativePath: "file.txt", requestId: "stat-1" }),
      ).resolves.toMatchObject({ kind: "file", size: 15 });
      const issued = await runtime!.issueDownloadToken({
        workspaceId: "wks_a",
        relativePath: "file.txt",
        requestId: "download-1",
      });
      const response = new TestHttpResponse();
      await provider.httpHandler.handle({
        principal: fixture.runtime.principal,
        node: fixture.runtime.node,
        query: {
          workspaceId: issued.workspaceId,
          relativePath: issued.relativePath,
          token: issued.token,
        },
        response,
      });

      expect(response.metadata).toEqual({
        fileName: "file.txt",
        mimeType: "text/plain",
        size: 15,
      });
      expect(Buffer.concat(response.chunks).toString()).toBe("enterprise-file");
      expect(response.ended).toBe(true);

      const uploadStore = runtime!.createUploadStore();
      uploadStore.beginStaged({
        workspaceId: "wks_a",
        requestId: "upload-1",
        fileName: "attachment.txt",
        mimeType: "text/plain",
        size: 17,
        modifiedAt: "2026-09-10T00:00:00.000Z",
      });
      await expect(
        uploadStore.receiveFrame(uploadFrame(FileTransferOpcode.FileBegin)),
      ).resolves.toBeNull();
      await expect(
        uploadStore.receiveFrame(
          uploadFrame(FileTransferOpcode.FileChunk, new TextEncoder().encode("enterprise-upload")),
        ),
      ).resolves.toBeNull();
      const uploaded = await uploadStore.receiveFrame(uploadFrame(FileTransferOpcode.FileEnd));
      const uploadedPath = uploaded?.payload.file?.path;
      expect(uploaded).toMatchObject({
        type: "file.upload.response",
        payload: {
          requestId: "upload-1",
          workspaceId: "wks_a",
          error: null,
          file: {
            workspaceId: "wks_a",
            fileName: "attachment.txt",
            size: 17,
          },
        },
      });
      expect(uploadedPath).toMatch(/^\.paseo-uploads\/[a-f0-9]{64}$/);
      if (!uploadedPath) throw new Error("expected canonical upload path");
      expect(await readFile(path.join(workspaceRoot, ...uploadedPath.split("/")), "utf8")).toBe(
        "enterprise-upload",
      );
      const replay = new TestHttpResponse();
      await expect(
        provider.httpHandler.handle({
          principal: fixture.runtime.principal,
          node: fixture.runtime.node,
          query: {
            workspaceId: issued.workspaceId,
            relativePath: issued.relativePath,
            token: issued.token,
          },
          response: replay,
        }),
      ).resolves.toBeUndefined();
      expect(replay.rejections).toEqual([403]);

      await runtime?.cleanup("session-closed");
      await fixture.runtime.release();
      await fixture.audit.close();
    },
  );

  test.runIf(process.platform === "darwin")(
    "burns a token before rejecting the wrong authenticated HTTP principal",
    async () => {
      const workspaceRootInput = path.join(parent, "workspace-wrong-principal");
      await mkdir(workspaceRootInput, { recursive: true });
      const workspaceRoot = await realpath(workspaceRootInput);
      await writeFile(path.join(workspaceRoot, "file.txt"), "secret");
      const fixture = await createAuthorizationFixture("wrong-principal");
      const provider = createProvider(workspaceRoot);
      const runtime = provider.createSessionRuntime(fixture.runtime)!;
      const issued = await runtime.issueDownloadToken({
        workspaceId: "wks_a",
        relativePath: "file.txt",
        requestId: "download-wrong",
      });
      const wrongPrincipal = { ...fixture.runtime.principal, credentialId: "cred_wrong" };

      const wrongResponse = new TestHttpResponse();
      await expect(
        provider.httpHandler.handle({
          principal: wrongPrincipal,
          node: fixture.runtime.node,
          query: {
            workspaceId: issued.workspaceId,
            relativePath: issued.relativePath,
            token: issued.token,
          },
          response: wrongResponse,
        }),
      ).resolves.toBeUndefined();
      expect(wrongResponse.rejections).toEqual([403]);
      const rightResponse = new TestHttpResponse();
      await expect(
        provider.httpHandler.handle({
          principal: fixture.runtime.principal,
          node: fixture.runtime.node,
          query: {
            workspaceId: issued.workspaceId,
            relativePath: issued.relativePath,
            token: issued.token,
          },
          response: rightResponse,
        }),
      ).resolves.toBeUndefined();
      expect(rightResponse.rejections).toEqual([403]);

      await runtime.cleanup("session-closed");
      await fixture.runtime.release();
      await fixture.audit.close();
    },
  );
});

class TestHttpResponse implements EnterpriseDownloadHttpResponsePort {
  readonly rejections: Array<400 | 403> = [];
  readonly chunks: Buffer[] = [];
  metadata: { fileName: string; mimeType: string; size: number } | null = null;
  ended = false;
  aborted = false;

  async reject(status: 400 | 403) {
    this.rejections.push(status);
  }
  async begin(metadata: { fileName: string; mimeType: string; size: number }) {
    this.metadata = { ...metadata };
  }
  async write(bytes: Uint8Array) {
    this.chunks.push(Buffer.from(bytes));
  }
  async end() {
    this.ended = true;
  }
  async abort() {
    this.aborted = true;
  }
}

function createProvider(workspaceRoot: string): EnterpriseWorkspaceFilesProductionProvider {
  const provider = createProductionEnterpriseWorkspaceFilesProvider({
    workspaceRoots: {
      async get(workspaceId) {
        if (workspaceId !== "wks_a") return null;
        return {
          workspaceId,
          organizationId: principal.organizationId,
          nodeId: node.nodeId,
          ownerPrincipalId: principal.principalId,
          createdByPrincipalId: principal.principalId,
          cwd: workspaceRoot,
          archivedAt: null,
        };
      },
    },
    nativeAddonPath: workspaceAddonPath,
  });
  if (!provider?.releaseReady) throw new Error("expected production workspace files provider");
  return provider;
}

function uploadFrame(opcode: FileTransferOpcode, payload = new Uint8Array()): FileTransferFrame {
  if (opcode === FileTransferOpcode.FileBegin) {
    return {
      opcode,
      requestId: "upload-1",
      metadata: {
        mime: "text/plain",
        size: 17,
        encoding: "binary",
        modifiedAt: "2026-09-10T00:00:00.000Z",
        fileName: "attachment.txt",
      },
      payload,
    };
  }
  return { opcode, requestId: "upload-1", payload };
}

async function createAuthorizationFixture(name: string) {
  const audit = await createProductionAuditRuntime({
    node,
    auditRoot: path.join(parent, `audit-${name}`),
    nativeAddonPath: auditAddonPath,
  });
  const grantFilePath = path.join(parent, `grants-${name}.json`);
  const grantRecord: GrantRecord = {
    principalId: principal.principalId,
    organizationId: principal.organizationId,
    grants: principal.grants,
    grantVersion: principal.grantVersion,
  };
  await new FileBackedGrantStorage(grantFilePath).put(grantRecord);
  const provider = createProductionAuthorizationRuntimeProvider({ audit, grantFilePath });
  if (!provider) throw new Error("expected production authorization provider");
  provider.owners.registerWorkspace({
    id: "wks_a",
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const mintAuthority = Object.freeze({});
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintAuthority);
  const evidence = issueEnterpriseAdmissionEvidence(issuer, mintAuthority, principal, node, {
    node,
    transport: "direct",
    peer: "loopback",
  });
  if (!evidence) throw new Error("expected admission evidence");
  const handle = bindEnterpriseAdmissionSession(issuer, evidence, "client-a");
  if (!handle) throw new Error("expected admission handle");
  const runtime = await createProductionAuthorizationRuntimeForSession(provider, {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    sessionAuthorization: new SessionAuthorization(["workspace.read", "workspace.write"]),
    sessionId: `session-${name}`,
    authorityState: new EmptyAuthorityState(),
  });
  if (!runtime) throw new Error("expected production authorization runtime");
  return { audit, runtime };
}
