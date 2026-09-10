import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  decodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  NodeContext,
  PrincipalContext,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { extractHttpBearerToken } from "../../auth.js";
import { OWNER_PERMISSIONS, SessionAuthorization } from "../../authorization/index.js";
import { Session, type SessionOptions } from "../../session.js";
import { createEnterpriseAgentSessionContextRegistry } from "../../session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "../../session/enterprise-authority-receipt-state.js";
import { createStub } from "../../test-utils/class-mocks.js";
import {
  asAgentManager,
  asAgentStorage,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asDownloadTokenStore,
  asGitHubService,
  asPushNotifications,
  asScheduleService,
  asWorkspaceGitService,
  createAgentRequestsStub,
  createProviderSnapshotManagerStub,
} from "../../test-utils/session-stubs.js";
import {
  FileBackedGrantStorage,
  isAuthoritativeGrantStoreForAudit,
  type GrantRecord,
} from "../access/grant-store.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
  isProductionAuthorizationRuntimeProvider,
} from "../access/production-authorization-runtime-provider.js";
import {
  isCurrentProductionAuthorizationRuntime,
  isCurrentProductionAuthorizationRuntimeForSession,
  type ProductionAuthorizationRuntime,
} from "../access/production-authorization-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  releaseEnterpriseAdmissionSession,
  resolveCurrentEnterpriseAdmissionAuthorization,
  type EnterpriseAdmissionAuthorizationHandle,
  type EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import { EnterpriseAdmission } from "../identity/admission.js";
import { createEnterpriseSessionBindingKey } from "@getpaseo/protocol/messages";
import {
  createProductionEnterpriseWorkspaceFilesProvider,
  type EnterpriseDownloadHttpResponsePort,
  type EnterpriseWorkspaceFilesProductionProvider,
} from "../runtime/production-workspace-files-runtime-provider.js";
import type { EnterpriseWorkspaceFilesRuntime } from "../runtime/workspace-files-runtime.js";
import {
  createProductionAuditRuntime,
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./production-audit-runtime.js";

const executeFile = promisify(execFile);
const node: NodeContext = Object.freeze({
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_crossflow",
  mode: "standalone",
});
const workspaceId = "wks_crossflow";
const clientId = "client-crossflow";
const sessionId = "session-crossflow";
const principal: PrincipalContext = Object.freeze({
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_0123456789abcdef01234567",
  grantVersion: "grv_crossflow_1",
  grants: Object.freeze([
    {
      action: "workspace.content.read",
      selector: { kind: "workspace", workspaceIds: [workspaceId] },
    },
    {
      action: "workspace.write",
      selector: { kind: "workspace", workspaceIds: [workspaceId] },
    },
  ]),
});

interface SessionAuthority {
  readonly issuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly handle: EnterpriseAdmissionAuthorizationHandle;
  readonly authorization: SessionAuthorization;
  readonly authorityState: MemoryAuthorityReceiptState;
  readonly runtime: ProductionAuthorizationRuntime;
  readonly context: {
    readonly principal: PrincipalContext;
    readonly node: NodeContext;
    readonly sessionBindingGeneration: string;
  };
  readonly sessionBindingKey: string;
}

interface SessionHarnessInput extends SessionAuthority {
  readonly filesRuntime: EnterpriseWorkspaceFilesRuntime;
  readonly paseoHome: string;
  readonly messages: SessionOutboundMessage[];
  readonly binary: Array<{ readonly source: object; readonly frame: Uint8Array }>;
  readonly handleOverride?: EnterpriseAdmissionAuthorizationHandle;
}

function createSessionHarness(input: SessionHarnessInput): Session {
  const github = asGitHubService({
    invalidate: vi.fn(),
    searchIssuesAndPrs: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
  });
  const workspaceGitService = asWorkspaceGitService({
    getCheckout: vi.fn(),
    getCheckoutDiff: vi.fn(),
    getSnapshot: vi.fn(),
    suggestBranchesForCwd: vi.fn(),
    listStashes: vi.fn(),
    peekSnapshot: vi.fn(),
    validateBranchRef: vi.fn(),
    hasLocalBranch: vi.fn(),
    resolveRepoRemoteUrl: vi.fn(),
    resolveRepoRoot: vi.fn(),
    getWorkspaceGitMetadata: vi.fn(),
    resolveForge: vi.fn().mockResolvedValue({ forge: "github", service: github }),
    invalidateForge: vi.fn(),
    getProjectSlug: vi.fn(),
  });
  const options: SessionOptions = {
    clientId,
    enterpriseContext: input.context,
    enterpriseAgentContextRegistry: createEnterpriseAgentSessionContextRegistry(),
    authorityReceiptState: input.authorityState,
    principalGrantVersionGuard: input.runtime.grantVersionGuard,
    resourceAuthorization: input.runtime.resourceAuthorization,
    enterpriseWorkspaceFilesRuntime: input.filesRuntime,
    sessionId,
    sessionAuthorization: input.authorization,
    admissionAuthorizationIssuer: input.issuer,
    admissionAuthorizationHandle: input.handleOverride ?? input.handle,
    enterpriseAuthorizationRuntime: input.runtime,
    permissions: OWNER_PERMISSIONS,
    onMessage: (message) => input.messages.push(message),
    onBinaryMessage: () => {
      throw new Error("unexpected unscoped binary delivery");
    },
    onBinaryMessageToSource: async (source, frame) => {
      input.binary.push({ source, frame: new Uint8Array(frame) });
    },
    logger: pino({ level: "silent" }),
    downloadTokenStore: asDownloadTokenStore(),
    pushNotifications: asPushNotifications(),
    paseoHome: input.paseoHome,
    agentManager: asAgentManager({
      listAgents: vi.fn(() => []),
      listProviderSubagentActivity: vi.fn(() => []),
      subscribe: vi.fn(() => () => {}),
    }),
    agentStorage: asAgentStorage({
      get: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    }),
    agentRequests: createAgentRequestsStub(),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      getOrCreateActiveByRoot: vi.fn(),
      upsert: vi.fn(),
      archive: vi.fn(),
      remove: vi.fn(),
      initialize: vi.fn(),
      existsOnDisk: vi.fn(),
      subscribeToMutations: vi.fn(() => () => {}),
    }),
    workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      subscribeToMutations: vi.fn(() => () => {}),
    }),
    scheduleService: asScheduleService(),
    checkoutDiffManager: asCheckoutDiffManager({
      scheduleRefreshForCwd: vi.fn(),
    }),
    github,
    workspaceGitService,
    workspaceAutoName: createStub<SessionOptions["workspaceAutoName"]>({}),
    daemonConfigStore: asDaemonConfigStore({
      get: vi.fn(() => ({ mcp: { injectIntoAgents: false }, providers: {} })),
      onChange: vi.fn(() => () => {}),
    }),
    stt: null,
    tts: null,
    terminalManager: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    providerUsageService: createStub<SessionOptions["providerUsageService"]>({}),
    serverId: node.paseoServerId,
    daemonVersion: "1.0.0-crossflow",
  };
  return new Session(options);
}

async function createAuthority(
  audit: ProductionAuditCapability,
  grantFilePath: string,
): Promise<
  SessionAuthority & {
    readonly provider: NonNullable<ReturnType<typeof createProductionAuthorizationRuntimeProvider>>;
    readonly admission: EnterpriseAdmission;
    readonly personalAccessToken: string;
  }
> {
  const grant: GrantRecord = {
    principalId: principal.principalId,
    organizationId: principal.organizationId,
    grants: principal.grants,
    grantVersion: principal.grantVersion,
  };
  await new FileBackedGrantStorage(grantFilePath).put(grant);
  const provider = createProductionAuthorizationRuntimeProvider({ audit, grantFilePath });
  if (!provider) throw new Error("expected production authorization provider");
  provider.owners.registerWorkspace({
    id: workspaceId,
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const admission = new EnterpriseAdmission({
    filePath: `${grantFilePath}.identities.json`,
    principalSource: {
      async resolvePrincipal(principalId, organizationId) {
        if (principalId !== principal.principalId || organizationId !== principal.organizationId) {
          return null;
        }
        return {
          principalType: principal.principalType,
          principalId: principal.principalId,
          organizationId: principal.organizationId,
          grantVersion: principal.grantVersion,
          grants: principal.grants,
        };
      },
    },
    node,
    audit,
    organizationId: principal.organizationId,
    invalidation: { publish: async () => undefined },
    credentialIds: { next: () => principal.credentialId },
    secrets: { next: () => Buffer.alloc(32, 7).toString("base64url") },
  });
  const issued = await admission.registry.issueToken({
    actor: principal,
    principalId: principal.principalId,
    organizationId: principal.organizationId,
  });
  const evidence = await admission.authenticateEvidence(issued.token, {
    node,
    transport: "direct",
    peer: "loopback",
  });
  if (!evidence) throw new Error("expected enterprise admission evidence");
  const issuer = admission.authorizationIssuer;
  const handle = admission.bindSession(evidence, clientId);
  if (!handle) throw new Error("expected enterprise admission handle");
  const resolved = resolveCurrentEnterpriseAdmissionAuthorization(issuer, handle);
  if (!resolved) throw new Error("expected current enterprise admission handle");
  const authorization = new SessionAuthorization(OWNER_PERMISSIONS);
  const authorityState = new MemoryAuthorityReceiptState();
  const runtime = await createProductionAuthorizationRuntimeForSession(provider, {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    sessionAuthorization: authorization,
    sessionId,
    authorityState,
  });
  if (!runtime) throw new Error("expected production authorization runtime");
  const context = Object.freeze({
    principal: resolved.principal,
    node: resolved.node,
    sessionBindingGeneration: resolved.sessionBindingGeneration,
  });
  return {
    provider,
    admission,
    personalAccessToken: issued.token,
    issuer,
    handle,
    authorization,
    authorityState,
    runtime,
    context,
    sessionBindingKey: resolved.sessionBindingKey,
  };
}

class TestHttpResponse implements EnterpriseDownloadHttpResponsePort {
  readonly rejections: Array<400 | 403> = [];
  readonly chunks: Buffer[] = [];
  metadata: { fileName: string; mimeType: string; size: number } | null = null;
  ended = false;
  aborted = false;

  async reject(status: 400 | 403): Promise<void> {
    this.rejections.push(status);
  }

  async begin(metadata: { fileName: string; mimeType: string; size: number }): Promise<void> {
    this.metadata = { ...metadata };
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.chunks.push(Buffer.from(bytes));
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

async function handleAuthenticatedHttpDownload(input: {
  readonly admission: EnterpriseAdmission;
  readonly provider: EnterpriseWorkspaceFilesProductionProvider;
  readonly authorization: string | undefined;
  readonly query: unknown;
  readonly response: EnterpriseDownloadHttpResponsePort;
}): Promise<void> {
  const token = extractHttpBearerToken(input.authorization);
  if (!token) {
    await input.response.reject(403);
    return;
  }
  const authenticated = await input.admission.authenticate(token, {
    node: input.admission.node,
    transport: "direct",
    peer: "external",
    remoteAddress: "127.0.0.1",
  });
  if (!authenticated) {
    await input.response.reject(403);
    return;
  }
  await input.provider.httpHandler.handle({
    principal: authenticated,
    node: input.admission.node,
    query: input.query,
    response: input.response,
  });
}

describe.runIf(process.platform === "darwin")("real Darwin enterprise ownership cross-flow", () => {
  let suiteRoot = "";
  let auditAddonPath = "";
  let workspaceAddonPath = "";

  beforeAll(async () => {
    suiteRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-enterprise-ownership-"));
    auditAddonPath = path.join(suiteRoot, "darwin-audit-fs.node");
    workspaceAddonPath = path.join(suiteRoot, "darwin-workspace-fs.node");
    await Promise.all([
      executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        auditAddonPath,
      ]),
      executeFile(process.execPath, [
        fileURLToPath(new URL("../runtime/native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        workspaceAddonPath,
      ]),
    ]);
  });

  afterAll(async () => {
    if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
  });

  test("keeps audit, GrantStore, hello handle, runtimes, and Session in one authority chain", async () => {
    const caseRoot = path.join(suiteRoot, "same-source");
    const auditRoot = path.join(caseRoot, "audit");
    const workspaceInput = path.join(caseRoot, "workspace");
    await mkdir(workspaceInput, { recursive: true });
    const workspaceRoot = await realpath(workspaceInput);
    const content = "same-source-enterprise-file";
    const filePath = path.join(workspaceRoot, "owned.txt");
    await writeFile(filePath, content);

    const audit = await createProductionAuditRuntime({
      node,
      auditRoot,
      nativeAddonPath: auditAddonPath,
    });
    const auditEvent = await audit.append(
      {
        organizationId: principal.organizationId,
        actorPrincipalId: principal.principalId,
        actorCredentialId: principal.credentialId,
        action: "workspace.content.read",
        resource: { kind: "workspace", id: workspaceId },
        workspaceId,
        outcome: "allowed",
      },
      { durability: "required" },
    );
    const authority = await createAuthority(audit, path.join(caseRoot, "grants.json"));
    let workspaceRootReads = 0;
    const filesProvider = createProductionEnterpriseWorkspaceFilesProvider({
      workspaceRoots: {
        async get(requestedWorkspaceId) {
          workspaceRootReads += 1;
          if (requestedWorkspaceId !== workspaceId) return null;
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
    if (!filesProvider?.releaseReady) throw new Error("expected Darwin workspace provider");

    expect(isProductionAuthorizationRuntimeProvider(authority.provider)).toBe(true);
    expect(isAuthoritativeGrantStoreForAudit(authority.provider.grantStore, audit)).toBe(true);
    expect(
      isCurrentProductionAuthorizationRuntimeForSession(authority.runtime, {
        admissionAuthorizationIssuer: authority.issuer,
        admissionAuthorizationHandle: authority.handle,
        sessionAuthorization: authority.authorization,
        sessionId,
        clientId,
        sessionBindingKey: authority.sessionBindingKey,
        enterpriseContext: authority.context,
      }),
    ).toBe(true);

    const wrongEvidence = issueEnterpriseAdmissionEvidence(
      authority.issuer,
      Object.freeze(Object.create(null)),
      principal,
      node,
      { node, transport: "direct", peer: "loopback" },
    );
    expect(wrongEvidence).toBeNull();

    const alternateMint = Object.freeze(Object.create(null)) as object;
    const alternateIssuer = createEnterpriseAdmissionAuthorizationIssuer(alternateMint, () =>
      productionAuditCapabilityIssuer.current(audit),
    );
    const alternateEvidence = issueEnterpriseAdmissionEvidence(
      alternateIssuer,
      alternateMint,
      principal,
      node,
      { node, transport: "direct", peer: "loopback" },
    );
    if (!alternateEvidence) throw new Error("expected alternate evidence");
    const alternateHandle = bindEnterpriseAdmissionSession(
      alternateIssuer,
      alternateEvidence,
      clientId,
    );
    if (!alternateHandle) throw new Error("expected alternate handle");

    const rejectedMessages: SessionOutboundMessage[] = [];
    const rejectedBinary: Array<{ source: object; frame: Uint8Array }> = [];
    const rejectedFilesRuntime = filesProvider.createSessionRuntime(authority.runtime);
    if (!rejectedFilesRuntime) throw new Error("expected rejected-case files runtime");
    expect(() =>
      createSessionHarness({
        ...authority,
        filesRuntime: rejectedFilesRuntime,
        paseoHome: caseRoot,
        messages: rejectedMessages,
        binary: rejectedBinary,
        handleOverride: alternateHandle,
      }),
    ).toThrow("Enterprise authorization runtime does not match canonical session authority");
    expect({ rejectedMessages, rejectedBinary, workspaceRootReads }).toEqual({
      rejectedMessages: [],
      rejectedBinary: [],
      workspaceRootReads: 0,
    });
    expect(await readFile(filePath, "utf8")).toBe(content);
    await rejectedFilesRuntime.cleanup("session-closed");
    expect(releaseEnterpriseAdmissionSession(alternateIssuer, alternateHandle)).toBe(true);

    const filesRuntime = filesProvider.createSessionRuntime(authority.runtime);
    if (!filesRuntime) throw new Error("expected production workspace files runtime");
    const messages: SessionOutboundMessage[] = [];
    const binary: Array<{ source: object; frame: Uint8Array }> = [];
    const session = createSessionHarness({
      ...authority,
      filesRuntime,
      paseoHome: caseRoot,
      messages,
      binary,
    });
    expect(session.getSessionId()).toBe(sessionId);
    expect(session.getEnterpriseSessionContext()).toEqual(authority.context);
    expect(session.getEnterpriseSessionBindingKey()).toBe(
      createEnterpriseSessionBindingKey({
        organizationId: principal.organizationId,
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        grantVersion: principal.grantVersion,
        clientId,
      }),
    );

    const source = Object.freeze({ id: "crossflow-source" });
    await session.handleMessage(
      {
        type: "file_explorer_request",
        cwd: "ignored-by-enterprise-runtime",
        workspaceId,
        path: "owned.txt",
        mode: "file",
        acceptBinary: true,
        requestId: "crossflow-read",
      },
      source,
    );
    const decoded = binary.map(({ frame }) => decodeFileTransferFrame(frame));
    expect(messages).toEqual([]);
    expect(binary.map(({ source: target }) => target)).toEqual([source, source, source]);
    expect(decoded.map((frame) => frame?.opcode)).toEqual([
      FileTransferOpcode.FileBegin,
      FileTransferOpcode.FileChunk,
      FileTransferOpcode.FileEnd,
    ]);
    expect(
      Buffer.concat(
        decoded.flatMap((frame) =>
          frame?.opcode === FileTransferOpcode.FileChunk ? [Buffer.from(frame.payload)] : [],
        ),
      ).toString("utf8"),
    ).toBe(content);
    expect(workspaceRootReads).toBe(1);

    await session.cleanup();
    expect(isCurrentProductionAuthorizationRuntime(authority.runtime)).toBe(false);
    expect(releaseEnterpriseAdmissionSession(authority.issuer, authority.handle)).toBe(true);
    await audit.close();

    const journalFiles = (await readdir(auditRoot)).filter((name) => name.endsWith(".jsonl"));
    expect(journalFiles).toHaveLength(1);
    const journal = await readFile(path.join(auditRoot, journalFiles[0]!), "utf8");
    expect(
      journal
        .split("\n")
        .filter(Boolean)
        .map((row) => JSON.parse(row)),
    ).toEqual([
      expect.objectContaining({
        eventId: auditEvent.eventId,
        action: "workspace.content.read",
      }),
      expect.objectContaining({ action: "identity.credential.issue" }),
      expect.objectContaining({ action: "identity.credential.use" }),
    ]);
  });

  test("streams a one-use Session token only for the same real PAT principal and node", async () => {
    const caseRoot = path.join(suiteRoot, "http-same-source");
    const auditRoot = path.join(caseRoot, "audit");
    const workspaceInput = path.join(caseRoot, "workspace");
    await mkdir(workspaceInput, { recursive: true });
    const workspaceRoot = await realpath(workspaceInput);
    const content = "same-source-enterprise-http-file";
    await writeFile(path.join(workspaceRoot, "download.txt"), content);

    const audit = await createProductionAuditRuntime({
      node,
      auditRoot,
      nativeAddonPath: auditAddonPath,
    });
    const authority = await createAuthority(audit, path.join(caseRoot, "grants.json"));
    let workspaceRootReads = 0;
    const filesProvider = createProductionEnterpriseWorkspaceFilesProvider({
      workspaceRoots: {
        async get(requestedWorkspaceId) {
          workspaceRootReads += 1;
          if (requestedWorkspaceId !== workspaceId) return null;
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
    if (!filesProvider?.releaseReady) throw new Error("expected Darwin workspace provider");
    const filesRuntime = filesProvider.createSessionRuntime(authority.runtime);
    if (!filesRuntime) throw new Error("expected production workspace files runtime");
    const issued = await filesRuntime.issueDownloadToken({
      workspaceId,
      relativePath: "download.txt",
      requestId: "http-download",
    });
    const readsAfterIssue = workspaceRootReads;
    expect(readsAfterIssue).toBeGreaterThan(0);

    for (const authorization of [undefined, "Bearer not-a-personal-access-token"]) {
      const response = new TestHttpResponse();
      await handleAuthenticatedHttpDownload({
        admission: authority.admission,
        provider: filesProvider,
        authorization,
        query: {
          workspaceId: issued.workspaceId,
          relativePath: issued.relativePath,
          token: issued.token,
        },
        response,
      });
      expect(response.rejections).toEqual([403]);
      expect(response.chunks).toEqual([]);
      expect(workspaceRootReads).toBe(readsAfterIssue);
    }

    const success = new TestHttpResponse();
    await handleAuthenticatedHttpDownload({
      admission: authority.admission,
      provider: filesProvider,
      authorization: `Bearer ${authority.personalAccessToken}`,
      query: {
        workspaceId: issued.workspaceId,
        relativePath: issued.relativePath,
        token: issued.token,
      },
      response: success,
    });
    expect(success.rejections).toEqual([]);
    expect(success.metadata).toEqual({
      fileName: "download.txt",
      mimeType: "text/plain",
      size: Buffer.byteLength(content),
    });
    expect(Buffer.concat(success.chunks).toString("utf8")).toBe(content);
    expect(success.ended).toBe(true);
    expect(success.aborted).toBe(false);
    const readsAfterSuccess = workspaceRootReads;
    expect(readsAfterSuccess).toBeGreaterThan(readsAfterIssue);

    for (const query of [
      {
        workspaceId: issued.workspaceId,
        relativePath: issued.relativePath,
        token: issued.token,
      },
      {
        workspaceId: issued.workspaceId,
        relativePath: issued.relativePath,
        token: "not-an-issued-download-token",
      },
    ]) {
      const rejected = new TestHttpResponse();
      await handleAuthenticatedHttpDownload({
        admission: authority.admission,
        provider: filesProvider,
        authorization: `Bearer ${authority.personalAccessToken}`,
        query,
        response: rejected,
      });
      expect(rejected.rejections).toEqual([403]);
      expect(rejected.chunks).toEqual([]);
      expect(workspaceRootReads).toBe(readsAfterSuccess);
    }

    const missingDownloadToken = new TestHttpResponse();
    await handleAuthenticatedHttpDownload({
      admission: authority.admission,
      provider: filesProvider,
      authorization: `Bearer ${authority.personalAccessToken}`,
      query: {
        workspaceId: issued.workspaceId,
        relativePath: issued.relativePath,
      },
      response: missingDownloadToken,
    });
    expect(missingDownloadToken.rejections).toEqual([400]);
    expect(workspaceRootReads).toBe(readsAfterSuccess);

    const closedIssued = await filesRuntime.issueDownloadToken({
      workspaceId,
      relativePath: "download.txt",
      requestId: "http-download-closed",
    });
    await filesRuntime.cleanup("session-closed");
    const readsAfterClose = workspaceRootReads;
    const closed = new TestHttpResponse();
    await handleAuthenticatedHttpDownload({
      admission: authority.admission,
      provider: filesProvider,
      authorization: `Bearer ${authority.personalAccessToken}`,
      query: {
        workspaceId: closedIssued.workspaceId,
        relativePath: closedIssued.relativePath,
        token: closedIssued.token,
      },
      response: closed,
    });
    expect(closed.rejections).toEqual([403]);
    expect(closed.chunks).toEqual([]);
    expect(workspaceRootReads).toBe(readsAfterClose);

    await authority.runtime.release();
    expect(authority.admission.releaseSession(authority.handle)).toBe(true);
    await audit.close();
  });
});
