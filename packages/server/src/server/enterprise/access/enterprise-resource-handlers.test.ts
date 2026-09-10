import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AppSlotRecord,
  BrowserProfileRecord,
  EnterpriseOrganizationResourceProjection,
  NodeContext,
  PrincipalContext,
  ResourceGrant,
} from "@getpaseo/protocol/messages";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import { SessionAuthorization } from "../../authorization/index.js";
import type { SessionInboundMessage } from "../../messages.js";
import type { EnterpriseDispatchContext } from "../../session/enterprise-dispatcher.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
} from "../identity/admission-authorization.js";
import {
  consumeEnterpriseResourceHandlerResult,
  createEnterpriseResourceDispatcher,
  ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES,
  EnterpriseResourceAuthorizationHandlers,
  enterpriseResourceHandlerPolicyForRequestType,
  enterpriseResourceRequestPolicyForType,
  type EnterpriseOrganizationResourcePage,
  type EnterpriseOrganizationResourceSource,
} from "./enterprise-resource-handlers.js";
import {
  FileBackedGrantStorage,
  GrantStore,
  type GrantRecord,
  type GrantVersionSource,
} from "./grant-store.js";
import { OwnerRegistry } from "./owner-registry.js";
import {
  createEnterpriseAuthorizationRuntime,
  type ProductionAuthorizationRuntime,
  type ProductionAuthorizationRuntimeOptions,
  type ProductionAuthorizationStatePort,
} from "./production-authorization-runtime.js";
import { createLocalWorkspaceTransfer, type WorkspaceTransfer } from "./workspace-transfer.js";

const executeFile = promisify(execFile);
const organizationId = "org_0123456789abcdef";
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_resource_handlers",
  mode: "standalone",
};
const identityManage: ResourceGrant = {
  action: "identity.manage",
  selector: { kind: "organization", organizationId },
};
const workspaceMetadata: ResourceGrant = {
  action: "workspace.metadata.read",
  selector: { kind: "workspace", workspaceIds: ["wks_a"] },
};
const workspaceManage: ResourceGrant = {
  action: "workspace.manage",
  selector: { kind: "workspace", workspaceIds: ["wks_a"] },
};
const principalFields = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId,
  credentialId: "cred_resource_handlers",
  grantVersion: "grv_1",
} as const;
const targetRecord: GrantRecord = {
  principalId: "svc_0123456789abcdef",
  organizationId,
  grants: [],
  grantVersion: "grv_target_1",
};
const workspaceRow: EnterpriseOrganizationResourceProjection = {
  organizationId,
  nodeId: node.nodeId,
  resourceKind: "workspace",
  workspaceId: "wks_a",
  ownerPrincipalId: principalFields.principalId,
  label: "Workspace A",
  status: "ready",
  updatedAt: "2026-09-10T00:00:00.000Z",
};
const agentRow: EnterpriseOrganizationResourceProjection = {
  organizationId,
  nodeId: node.nodeId,
  resourceKind: "agent",
  agentId: "agent_a",
  workspaceId: "wks_a",
  ownerPrincipalId: principalFields.principalId,
  label: "Agent A",
  status: "running",
  provider: "codex",
  model: null,
  startedAt: "2026-09-10T00:00:00.000Z",
  lastActivityAt: "2026-09-10T00:00:01.000Z",
  durationMs: 1_000,
};
const browserProfile: BrowserProfileRecord = {
  browserProfileId: "brp_0123456789abcdef",
  organizationId,
  homeNodeId: node.nodeId,
  businessIdentityId: "bid_0123456789abcdef",
  ownerPrincipalId: principalFields.principalId,
  platform: "generic",
  businessAccountKey: "account-a",
  label: "Browser A",
  partitionKey: "partition-a",
  downloadRoot: "/tmp/downloads-a",
  status: "ready",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:01.000Z",
};
const appSlot: AppSlotRecord = {
  appSlotId: "aps_0123456789abcdef",
  organizationId,
  nodeId: node.nodeId,
  appBundleId: "com.example.app",
  accountBindingKey: "account-a",
  ownerPrincipalId: principalFields.principalId,
  concurrency: 1,
  status: "ready",
};

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

class Versions implements GrantVersionSource {
  private value = 1;
  next(previousVersion: string | null) {
    this.value += 1;
    return `${previousVersion ?? "grv_new"}_${this.value}`;
  }
}

interface Fixture {
  readonly runtime: ProductionAuthorizationRuntime;
  readonly store: GrantStore;
  readonly storage: FileBackedGrantStorage;
  readonly owners: OwnerRegistry;
  readonly handler: EnterpriseResourceAuthorizationHandlers;
  readonly context: EnterpriseDispatchContext;
}

let parent = "";
let addonPath = "";
let audit: Awaited<ReturnType<typeof createProductionAuditRuntime>>;
let fixtureNumber = 0;
const runtimes: ProductionAuthorizationRuntime[] = [];

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  parent = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-resource-handlers-"));
  addonPath = path.join(parent, "darwin-audit-fs.node");
  await executeFile(process.execPath, [
    fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
    "--output",
    addonPath,
  ]);
  audit = await createProductionAuditRuntime({
    node,
    auditRoot: path.join(parent, "audit"),
    nativeAddonPath: addonPath,
  });
});

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.release()));
});

afterAll(async () => {
  await audit?.close();
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe("enterprise resource handler policy", () => {
  test("classifies every Batch B response", () => {
    expect(Object.isFrozen(ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES)).toBe(true);
    expect(
      [
        "enterprise.access.list_grants.request",
        "enterprise.access.update_grants.request",
        "enterprise.organization.list_resources.request",
        "enterprise.placement.resolve_workspace.request",
        "enterprise.resource.ownership.transfer.request",
      ].map(enterpriseResourceHandlerPolicyForRequestType),
    ).toEqual([
      {
        requestType: "enterprise.access.list_grants.request",
        responseType: "enterprise.access.list_grants.response",
        authorization: "authority_receipt",
      },
      {
        requestType: "enterprise.access.update_grants.request",
        responseType: "enterprise.access.update_grants.response",
        authorization: "authority_receipt",
      },
      {
        requestType: "enterprise.organization.list_resources.request",
        responseType: "enterprise.organization.list_resources.response",
        authorization: "resources",
      },
      {
        requestType: "enterprise.placement.resolve_workspace.request",
        responseType: "enterprise.placement.resolve_workspace.response",
        authorization: "resources",
      },
      {
        requestType: "enterprise.resource.ownership.transfer.request",
        responseType: "enterprise.resource.ownership.transfer.response",
        authorization: "authority_receipt",
      },
    ]);
    expect(
      enterpriseResourceHandlerPolicyForRequestType("enterprise.identity.get_current.request"),
    ).toBeNull();
    expect(
      ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES.map(enterpriseResourceRequestPolicyForType),
    ).toEqual(["authority", "authority", "resources", "resources", "authority"]);
    expect(enterpriseResourceRequestPolicyForType("enterprise.unknown.request")).toBeNull();
  });
});

describe.runIf(process.platform === "darwin")("enterprise resource handler core", () => {
  test("exports a dispatcher adapter with strict response-or-false results and metadata", async () => {
    const fixture = await createFixture();
    const dispatcher = createEnterpriseResourceDispatcher({
      runtime: fixture.runtime,
      grantStore: fixture.store,
      owners: fixture.owners,
      placement: { resolveWorkspace: async () => workspaceRef() },
      organizationResources: { list: async () => defaultPage() },
    });
    const message = listRequest("adapter-a");
    const input = { sessionContext: fixture.context, message };
    const response = await dispatcher.handle(input);

    expect(response).not.toBe(false);
    expect(dispatcher.requestPolicyForType(message.type)).toBe("authority");
    if (response === false) throw new Error("expected response");
    const contextual = dispatcher.consumeResponse({
      sessionContext: fixture.context,
      message,
      response,
    });
    expect(contextual).toEqual({
      response,
      receiptClassification: "authority",
    });
    expect(Object.isFrozen(contextual)).toBe(true);

    const burnMessage = listRequest("adapter-burn");
    const burnInput = { sessionContext: fixture.context, message: burnMessage };
    const burnResponse = await dispatcher.handle(burnInput);
    if (burnResponse === false) throw new Error("expected response");
    expect(
      dispatcher.consumeResponse({
        ...burnInput,
        response: burnResponse,
        callerAuthority: true,
      } as never),
    ).toBeNull();
    expect(dispatcher.consumeResponse({ ...burnInput, response: burnResponse })).toBeNull();
    await expect(
      dispatcher.handle({
        sessionContext: fixture.context,
        message: { type: "enterprise.identity.get_current.request", requestId: "unsupported" },
      }),
    ).resolves.toBe(false);
    expect(Object.isFrozen(dispatcher)).toBe(true);
  });

  test("returns a frozen, one-use authority-classified list_grants response", async () => {
    const fixture = await createFixture();
    const message = listRequest("list-a");
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);

    expect(response).toEqual({
      type: "enterprise.access.list_grants.response",
      payload: {
        requestId: "list-a",
        principalId: targetRecord.principalId,
        grants: [],
        revision: targetRecord.grantVersion,
      },
    });
    expect(Object.isFrozen(response)).toBe(true);
    if (response === false) throw new Error("expected response");
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toEqual({
      response,
      authorization: "authority_receipt",
    });
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toBeNull();
  });

  test.each([
    { action: "identity.manage", selector: { kind: "self" } },
    {
      action: "identity.manage",
      selector: { kind: "workspace", workspaceIds: ["wks_a"] },
    },
  ] satisfies ResourceGrant[])(
    "rejects a non-organization identity.manage selector",
    async (grant) => {
      const fixture = await createFixture({ grants: [grant, workspaceMetadata] });
      await expect(
        fixture.handler.handle({
          sessionContext: fixture.context,
          message: listRequest("wrong-selector"),
        }),
      ).resolves.toBe(false);
    },
  );

  test("updates an existing same-organization record and returns its persisted revision", async () => {
    const fixture = await createFixture();
    const grants: ResourceGrant[] = [
      { action: "audit.read", selector: { kind: "organization", organizationId } },
    ];
    const message = {
      type: "enterprise.access.update_grants.request",
      requestId: "update-a",
      principalId: targetRecord.principalId,
      grants,
      expectedRevision: targetRecord.grantVersion,
    } as const satisfies SessionInboundMessage;
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);

    expect(response).not.toBe(false);
    if (response === false) throw new Error("expected response");
    expect(response.type).toBe("enterprise.access.update_grants.response");
    if (response.type !== "enterprise.access.update_grants.response") throw new Error("wrong type");
    expect(response.payload).toMatchObject({ requestId: "update-a", grants });
    expect(response.payload.revision).not.toBe(targetRecord.grantVersion);
    await expect(fixture.storage.get(targetRecord.principalId)).resolves.toEqual({
      principalId: targetRecord.principalId,
      organizationId,
      grants,
      grantVersion: response.payload.revision,
    });
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toEqual({
      response,
      authorization: "authority_receipt",
    });

    const missing = {
      ...message,
      requestId: "update-missing",
      principalId: "svc_fedcba9876543210",
    } as const satisfies SessionInboundMessage;
    await expect(
      fixture.handler.handle({ sessionContext: fixture.context, message: missing }),
    ).resolves.toBe(false);
    await expect(fixture.storage.get(missing.principalId)).resolves.toBeNull();
  });

  test("transfers only a current Workspace and returns a one-use authority response with the audit receipt", async () => {
    const registry = new FileBackedWorkspaceRegistry(
      path.join(parent, `workspace-transfer-${fixtureNumber + 1}.json`),
      createTestLogger(),
    );
    await registry.initialize();
    await registry.upsert({
      ...createPersistedWorkspaceRecord({
        workspaceId: "wks_a",
        projectId: "prj_a",
        cwd: path.join(parent, "workspace-a"),
        kind: "directory",
        displayName: "Workspace A",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      }),
      organizationId,
      nodeId: node.nodeId,
      ownerPrincipalId: principalFields.principalId,
      createdByPrincipalId: principalFields.principalId,
    });
    let principalReads = 0;
    let principalEnabled = true;
    const workspaceTransfers = createLocalWorkspaceTransfer({
      workspaceRegistry: registry,
      audit,
      principalSource: {
        isCurrent: () => true,
        resolvePrincipal: async (principalId: string, requestedOrganizationId: string) => {
          principalReads += 1;
          return principalEnabled && principalId === targetRecord.principalId
            ? {
                principalType: "service" as const,
                principalId,
                organizationId: requestedOrganizationId,
                grants: targetRecord.grants,
                grantVersion: targetRecord.grantVersion,
              }
            : null;
        },
      },
    });
    if (!workspaceTransfers) throw new Error("expected WorkspaceTransfer");
    const fixture = await createFixture({
      grants: [workspaceMetadata, workspaceManage],
      workspaceTransfers,
    });
    const beforeAudit = await audit.snapshotEvents();
    const agentMessage = {
      type: "enterprise.resource.ownership.transfer.request",
      requestId: "transfer-agent",
      resource: {
        organizationId,
        nodeId: node.nodeId,
        resourceKind: "agent",
        localResourceId: "agent_a",
      },
      expectedOwnerPrincipalId: principalFields.principalId,
      expectedRevision: "0",
      newPrincipalId: targetRecord.principalId,
    } as const satisfies SessionInboundMessage;
    await expect(
      fixture.handler.handle({ sessionContext: fixture.context, message: agentMessage }),
    ).resolves.toBe(false);
    expect(principalReads).toBe(0);
    expect(await audit.snapshotEvents()).toHaveLength(beforeAudit.length);

    const ungrantedFixture = await createFixture({
      grants: [workspaceMetadata],
      workspaceTransfers,
    });
    await expect(
      ungrantedFixture.handler.handle({
        sessionContext: ungrantedFixture.context,
        message: {
          ...agentMessage,
          requestId: "transfer-without-workspace-manage",
          resource: workspaceRef(),
        },
      }),
    ).resolves.toBe(false);
    expect(principalReads).toBe(0);
    expect(await audit.snapshotEvents()).toHaveLength(beforeAudit.length);

    const denialMessages = [
      {
        ...agentMessage,
        requestId: "transfer-foreign",
        resource: { ...workspaceRef(), organizationId: "org_fedcba9876543210" },
      },
      {
        ...agentMessage,
        requestId: "transfer-guessed",
        resource: { ...workspaceRef(), localResourceId: "wks_guessed" },
      },
      {
        ...agentMessage,
        requestId: "transfer-stale",
        resource: workspaceRef(),
        expectedRevision: "9",
      },
      {
        ...agentMessage,
        requestId: "transfer-wrong-owner",
        resource: workspaceRef(),
        expectedOwnerPrincipalId: "usr_1111111111111111",
      },
      {
        ...agentMessage,
        requestId: "transfer-missing-principal",
        resource: workspaceRef(),
        newPrincipalId: "usr_fedcba9876543210",
      },
    ] as const satisfies readonly SessionInboundMessage[];
    for (const denied of denialMessages) {
      await expect(
        fixture.handler.handle({ sessionContext: fixture.context, message: denied }),
      ).resolves.toBe(false);
    }
    principalEnabled = false;
    await expect(
      fixture.handler.handle({
        sessionContext: fixture.context,
        message: { ...agentMessage, requestId: "transfer-disabled", resource: workspaceRef() },
      }),
    ).resolves.toBe(false);
    principalEnabled = true;
    expect(await audit.snapshotEvents()).toHaveLength(beforeAudit.length);
    await expect(registry.get("wks_a")).resolves.toMatchObject({
      ownerPrincipalId: principalFields.principalId,
    });

    const message = {
      ...agentMessage,
      requestId: "transfer-workspace",
      resource: workspaceRef(),
    } as const satisfies SessionInboundMessage;
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);
    if (response === false) throw new Error("expected transfer response");
    expect(response.type).toBe("enterprise.resource.ownership.transfer.response");
    if (response.type !== "enterprise.resource.ownership.transfer.response") {
      throw new Error("wrong transfer response");
    }
    const transferAudit = (await audit.snapshotEvents()).slice(beforeAudit.length);
    expect(transferAudit).toHaveLength(1);
    const [finalizedIntent] = transferAudit;
    if (!finalizedIntent) throw new Error("expected finalized transfer intent");
    expect(finalizedIntent).toMatchObject({
      action: "enterprise.resource.ownership.transfer",
      outcome: "allowed",
      metadata: {
        phase: "intent",
        newOwnerPrincipalId: targetRecord.principalId,
        revision: "1",
      },
    });
    expect(response).toEqual({
      type: "enterprise.resource.ownership.transfer.response",
      payload: {
        requestId: "transfer-workspace",
        resource: workspaceRef(),
        ownerPrincipalId: targetRecord.principalId,
        revision: "1",
        receiptId: finalizedIntent.eventId,
      },
    });
    expect(fixture.owners.getWorkspace("wks_a")?.ownerPrincipalId).toBe(targetRecord.principalId);
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toEqual({
      response,
      authorization: "authority_receipt",
    });
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toBeNull();
  });

  test("persists intent and storage-failure metadata through the real audit sink", async () => {
    let writes = 0;
    const registry = new FileBackedWorkspaceRegistry(
      path.join(parent, `workspace-transfer-failure-${fixtureNumber + 1}.json`),
      createTestLogger(),
      {
        writeRecords: async (filePath, records) => {
          writes += 1;
          if (writes === 2) throw new Error("workspace-write");
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    await registry.initialize();
    await registry.upsert({
      ...createPersistedWorkspaceRecord({
        workspaceId: "wks_a",
        projectId: "prj_a",
        cwd: path.join(parent, "workspace-failure"),
        kind: "directory",
        displayName: "Workspace Failure",
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      }),
      organizationId,
      nodeId: node.nodeId,
      ownerPrincipalId: principalFields.principalId,
      createdByPrincipalId: principalFields.principalId,
    });
    const workspaceTransfers = createLocalWorkspaceTransfer({
      workspaceRegistry: registry,
      audit,
      principalSource: {
        isCurrent: () => true,
        resolvePrincipal: async (principalId: string, requestedOrganizationId: string) =>
          principalId === targetRecord.principalId
            ? {
                principalType: "service" as const,
                principalId,
                organizationId: requestedOrganizationId,
                grants: targetRecord.grants,
                grantVersion: targetRecord.grantVersion,
              }
            : null,
      },
    });
    if (!workspaceTransfers) throw new Error("expected WorkspaceTransfer");
    const fixture = await createFixture({
      grants: [workspaceMetadata, workspaceManage],
      workspaceTransfers,
    });
    const beforeAudit = await audit.snapshotEvents();
    await expect(
      fixture.handler.handle({
        sessionContext: fixture.context,
        message: {
          type: "enterprise.resource.ownership.transfer.request",
          requestId: "transfer-write-failure",
          resource: workspaceRef(),
          expectedOwnerPrincipalId: principalFields.principalId,
          expectedRevision: "0",
          newPrincipalId: targetRecord.principalId,
        },
      }),
    ).resolves.toBe(false);

    const transferEvents = (await audit.snapshotEvents()).slice(beforeAudit.length);
    expect(transferEvents).toHaveLength(2);
    const [intent, failure] = transferEvents;
    if (!intent) throw new Error("expected finalized transfer intent");
    expect(intent).toMatchObject({
      action: "enterprise.resource.ownership.transfer",
      outcome: "allowed",
      metadata: {
        phase: "intent",
        newOwnerPrincipalId: targetRecord.principalId,
        revision: "1",
      },
    });
    expect(failure).toMatchObject({
      action: "enterprise.resource.ownership.transfer",
      outcome: "failed",
      reasonCode: "workspace_ownership_transfer_failed",
      metadata: {
        phase: "storage",
        newOwnerPrincipalId: targetRecord.principalId,
        revision: "1",
        intentEventId: intent.eventId,
      },
    });
    await expect(registry.get("wks_a")).resolves.toMatchObject({
      ownerPrincipalId: principalFields.principalId,
    });
    expect(fixture.owners.getWorkspace("wks_a")?.ownerPrincipalId).toBe(
      principalFields.principalId,
    );
  });

  test("does not emit a stale response when an update revokes the caller runtime", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.handler.handle({
        sessionContext: fixture.context,
        message: {
          type: "enterprise.access.update_grants.request",
          requestId: "self-revoke",
          principalId: principalFields.principalId,
          grants: [workspaceMetadata],
          expectedRevision: principalFields.grantVersion,
        },
      }),
    ).resolves.toBe(false);
    await expect(fixture.storage.get(principalFields.principalId)).resolves.toMatchObject({
      grants: [workspaceMetadata],
    });
  });

  test("resolves the exact authorized workspace with resource response metadata", async () => {
    const fixture = await createFixture();
    const message = placementRequest("place-a");
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);

    expect(response).toEqual({
      type: "enterprise.placement.resolve_workspace.response",
      payload: { requestId: "place-a", resource: workspaceRef() },
    });
    if (response === false) throw new Error("expected response");
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toEqual({
      response,
      authorization: "resources",
      context: { kind: "resources", resources: [workspaceRef()] },
    });
  });

  test("filters organization rows and principals through authoritative ownership", async () => {
    const foreignRow = {
      ...workspaceRow,
      organizationId: "org_fedcba9876543210",
      workspaceId: "wks_foreign",
    } satisfies EnterpriseOrganizationResourceProjection;
    const list = vi.fn(
      async (input: Parameters<EnterpriseOrganizationResourceSource["list"]>[0]) => {
        expect(input).toEqual({
          organizationId,
          nodeId: node.nodeId,
          resourceKinds: ["workspace", "agent"],
          cursor: "cursor-a",
          limit: 25,
        });
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.resourceKinds)).toBe(true);
        return {
          principals: [
            { principalId: principalFields.principalId, displayName: "Owner", status: "active" },
            { principalId: targetRecord.principalId, displayName: "Hidden", status: "active" },
          ],
          resources: [workspaceRow, workspaceRow, agentRow, foreignRow],
          nextCursor: "cursor-b",
        } satisfies EnterpriseOrganizationResourcePage;
      },
    );
    const fixture = await createFixture({ organizationResources: { list } });
    const message = {
      type: "enterprise.organization.list_resources.request",
      requestId: "resources-a",
      resourceKinds: ["workspace", "agent"],
      cursor: "cursor-a",
      limit: 25,
    } as const satisfies SessionInboundMessage;
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);

    expect(list).toHaveBeenCalledTimes(1);
    expect(response).not.toBe(false);
    if (response === false) throw new Error("expected response");
    expect(response.type).toBe("enterprise.organization.list_resources.response");
    if (response.type !== "enterprise.organization.list_resources.response")
      throw new Error("wrong type");
    expect(response.payload.resources).toEqual([workspaceRow, agentRow]);
    expect(response.payload.principals).toEqual([
      { principalId: principalFields.principalId, displayName: "Owner", status: "active" },
    ]);
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toMatchObject({
      response,
      authorization: "resources",
      context: {
        kind: "resources",
        resources: [
          { resourceKind: "workspace", localResourceId: "wks_a" },
          { resourceKind: "agent", localResourceId: "agent_a" },
        ],
      },
    });
  });

  test("returns an exact safe empty organization page with an empty resources context", async () => {
    const fixture = await createFixture({
      organizationResources: {
        list: async () => ({
          principals: [{ principalId: targetRecord.principalId, status: "active" }],
          resources: [],
          nextCursor: "hidden-cursor",
        }),
      },
    });
    const dispatcher = createEnterpriseResourceDispatcher({
      runtime: fixture.runtime,
      grantStore: fixture.store,
      owners: fixture.owners,
      placement: { resolveWorkspace: async () => workspaceRef() },
      organizationResources: {
        list: async () => ({
          principals: [{ principalId: targetRecord.principalId, status: "active" }],
          resources: [],
          nextCursor: "hidden-cursor",
        }),
      },
    });
    const message = resourcesRequest("empty-page");
    const input = { sessionContext: fixture.context, message };
    const response = await dispatcher.handle(input);

    expect(response).toEqual({
      type: "enterprise.organization.list_resources.response",
      payload: { requestId: "empty-page", principals: [], resources: [], nextCursor: null },
    });
    if (response === false) throw new Error("expected response");
    expect(
      dispatcher.consumeResponse({ sessionContext: fixture.context, message, response }),
    ).toEqual({
      response,
      authorizationContext: { kind: "resources", resources: [] },
      receiptClassification: "resources",
    });
  });

  test("includes typed browser/app metadata only through an authorized workspace binding", async () => {
    const browserRow: EnterpriseOrganizationResourceProjection = {
      organizationId,
      nodeId: node.nodeId,
      resourceKind: "browser_profile",
      browserProfileId: browserProfile.browserProfileId,
      ownerPrincipalId: principalFields.principalId,
      label: "Browser A",
      status: "ready",
      occupancy: "idle",
      workspaceId: "wks_a",
    };
    const appRow: EnterpriseOrganizationResourceProjection = {
      organizationId,
      nodeId: node.nodeId,
      resourceKind: "app_slot",
      appSlotId: appSlot.appSlotId,
      ownerPrincipalId: principalFields.principalId,
      label: "App A",
      status: "ready",
      occupancy: "idle",
      workspaceId: "wks_a",
    };
    const unboundBrowser = { ...browserRow, workspaceId: undefined };
    const fixture = await createFixture({
      typedResources: true,
      organizationResources: {
        list: async () => ({
          principals: [{ principalId: principalFields.principalId, status: "active" }],
          resources: [browserRow, appRow, unboundBrowser],
          nextCursor: null,
        }),
      },
    });
    const message = {
      type: "enterprise.organization.list_resources.request",
      requestId: "typed-resources",
      resourceKinds: ["browser_profile", "app_slot"],
    } as const satisfies SessionInboundMessage;
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);

    expect(response).not.toBe(false);
    if (response === false) throw new Error("expected response");
    expect(response.type).toBe("enterprise.organization.list_resources.response");
    if (response.type !== "enterprise.organization.list_resources.response")
      throw new Error("wrong type");
    expect(response.payload.resources).toEqual([browserRow, appRow]);
    const consumed = consumeEnterpriseResourceHandlerResult(fixture.handler, input, response);
    expect(consumed).toMatchObject({ authorization: "resources" });
    if (!consumed || consumed.authorization !== "resources") throw new Error("expected context");
    expect(consumed.context.resources.map((resource) => resource.resourceKind)).toEqual([
      "browser_profile",
      "workspace",
      "app_slot",
    ]);
  });

  test("rechecks current authority after placement and organization awaits", async () => {
    const placementStarted = deferred<void>();
    const placementGate = deferred<void>();
    const fixture = await createFixture({
      placement: {
        resolveWorkspace: async () => {
          placementStarted.resolve();
          await placementGate.promise;
          return workspaceRef();
        },
      },
    });
    const pendingPlacement = fixture.handler.handle({
      sessionContext: fixture.context,
      message: placementRequest("place-stale"),
    });
    await placementStarted.promise;
    const release = fixture.runtime.release();
    placementGate.resolve();
    await expect(pendingPlacement).resolves.toBe(false);
    await release;

    const listStarted = deferred<void>();
    const listGate = deferred<void>();
    const listing = await createFixture({
      organizationResources: {
        list: async () => {
          listStarted.resolve();
          await listGate.promise;
          return defaultPage();
        },
      },
    });
    const pendingList = listing.handler.handle({
      sessionContext: listing.context,
      message: resourcesRequest("list-stale"),
    });
    await listStarted.promise;
    const listRelease = listing.runtime.release();
    listGate.resolve();
    await expect(pendingList).resolves.toBe(false);
    await listRelease;
  });

  test("burns metadata before foreign-handler and caller-mutation checks", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const message = listRequest("burn-foreign");
    const input = { sessionContext: fixture.context, message };
    const response = await fixture.handler.handle(input);
    if (response === false) throw new Error("expected response");
    expect(consumeEnterpriseResourceHandlerResult(foreign.handler, input, response)).toBeNull();
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toBeNull();

    const mutableMessage = listRequest("burn-mutation");
    const mutableInput = { sessionContext: fixture.context, message: mutableMessage };
    const mutableResponse = await fixture.handler.handle(mutableInput);
    if (mutableResponse === false) throw new Error("expected response");
    mutableMessage.requestId = "changed";
    expect(
      consumeEnterpriseResourceHandlerResult(fixture.handler, mutableInput, mutableResponse),
    ).toBeNull();
    mutableMessage.requestId = "burn-mutation";
    expect(
      consumeEnterpriseResourceHandlerResult(fixture.handler, mutableInput, mutableResponse),
    ).toBeNull();
  });

  test("rejects foreign authority sources, mismatched context, proxies, and late revoke", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    expect(
      () =>
        new EnterpriseResourceAuthorizationHandlers({
          runtime: fixture.runtime,
          grantStore: foreign.store,
          owners: fixture.owners,
          placement: { resolveWorkspace: async () => workspaceRef() },
          organizationResources: { list: async () => defaultPage() },
        }),
    ).toThrow("exact production authority sources");
    await expect(
      fixture.handler.handle({
        sessionContext: { ...fixture.context, credentialId: "cred_foreign" },
        message: listRequest("wrong-context"),
      }),
    ).resolves.toBe(false);

    let proxyTouches = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          proxyTouches += 1;
          throw new Error("hostile proxy");
        },
      },
    );
    await expect(fixture.handler.handle(proxy as never)).resolves.toBe(false);
    expect(proxyTouches).toBe(1);

    const hostileSource = await createFixture({
      organizationResources: {
        list: async () =>
          Object.defineProperty({}, "resources", {
            enumerable: true,
            get() {
              throw new Error("hostile source result");
            },
          }) as EnterpriseOrganizationResourcePage,
      },
    });
    await expect(
      hostileSource.handler.handle({
        sessionContext: hostileSource.context,
        message: resourcesRequest("hostile-source"),
      }),
    ).resolves.toBe(false);

    const input = { sessionContext: fixture.context, message: listRequest("late-revoke") };
    const response = await fixture.handler.handle(input);
    if (response === false) throw new Error("expected response");
    await fixture.runtime.release();
    expect(consumeEnterpriseResourceHandlerResult(fixture.handler, input, response)).toBeNull();
  });
});

async function createFixture(
  overrides: {
    grants?: readonly ResourceGrant[];
    organizationResources?: EnterpriseOrganizationResourceSource;
    typedResources?: boolean;
    placement?: {
      resolveWorkspace(workspaceId: string): Promise<ReturnType<typeof workspaceRef> | null>;
    };
    workspaceTransfers?: WorkspaceTransfer;
  } = {},
): Promise<Fixture> {
  fixtureNumber += 1;
  const principal: PrincipalContext = {
    ...principalFields,
    grants: [...(overrides.grants ?? [identityManage, workspaceMetadata])],
  };
  const storage = new FileBackedGrantStorage(path.join(parent, `grants-${fixtureNumber}.json`));
  await storage.put({
    principalId: principal.principalId,
    organizationId: principal.organizationId,
    grants: principal.grants,
    grantVersion: principal.grantVersion,
  });
  await storage.put(targetRecord);
  const store = new GrantStore(storage, new Versions(), audit);
  const mintSecret = Object.freeze({});
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
  const evidence = issueEnterpriseAdmissionEvidence(issuer, mintSecret, principal, node, {
    node,
    transport: "direct",
    peer: "loopback",
  });
  if (!evidence) throw new Error("expected admission evidence");
  const handle = bindEnterpriseAdmissionSession(issuer, evidence, `client-${fixtureNumber}`);
  if (!handle) throw new Error("expected admission handle");
  const owners = new OwnerRegistry();
  owners.registerWorkspace({
    id: "wks_a",
    organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  owners.registerAgent({
    id: "agent_a",
    workspaceId: "wks_a",
    organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const options = {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    grantStore: store,
    audit,
    sessionAuthorization: new SessionAuthorization(["workspace.read"]),
    sessionId: `session-${fixtureNumber}`,
    owners,
    authorityState: new EmptyAuthorityState(),
    ...(overrides.typedResources
      ? {
          browserProfiles: {
            get: async (browserProfileId: string) =>
              browserProfileId === browserProfile.browserProfileId ? browserProfile : null,
          },
          appSlots: {
            get: async (appSlotId: string) => (appSlotId === appSlot.appSlotId ? appSlot : null),
          },
        }
      : {}),
  } satisfies ProductionAuthorizationRuntimeOptions;
  const runtime = await createEnterpriseAuthorizationRuntime(options);
  if (!runtime) throw new Error("expected production runtime");
  runtimes.push(runtime);
  const handler = new EnterpriseResourceAuthorizationHandlers({
    runtime,
    grantStore: store,
    owners,
    placement: overrides.placement ?? {
      resolveWorkspace: async (workspaceId) => (workspaceId === "wks_a" ? workspaceRef() : null),
    },
    organizationResources: overrides.organizationResources ?? {
      list: async () => defaultPage(),
    },
    ...(overrides.workspaceTransfers ? { workspaceTransfers: overrides.workspaceTransfers } : {}),
  });
  const context: EnterpriseDispatchContext = {
    sessionId: runtime.binding.sessionId,
    clientId: runtime.binding.clientId,
    credentialId: runtime.principal.credentialId,
    sessionBindingGeneration: runtime.binding.sessionBindingGeneration,
    enterpriseContext: {
      principal: runtime.principal,
      node: runtime.node,
      sessionBindingGeneration: runtime.binding.sessionBindingGeneration,
    },
  };
  return { runtime, store, storage, owners, handler, context };
}

function defaultPage(): EnterpriseOrganizationResourcePage {
  return {
    principals: [{ principalId: principalFields.principalId, status: "active" }],
    resources: [workspaceRow, agentRow],
    nextCursor: null,
  };
}

function workspaceRef() {
  return {
    organizationId,
    nodeId: node.nodeId,
    resourceKind: "workspace" as const,
    localResourceId: "wks_a",
  };
}

function listRequest(requestId: string) {
  return {
    type: "enterprise.access.list_grants.request" as const,
    requestId,
    principalId: targetRecord.principalId,
  };
}

function placementRequest(requestId: string) {
  return {
    type: "enterprise.placement.resolve_workspace.request" as const,
    requestId,
    workspaceId: "wks_a",
  };
}

function resourcesRequest(requestId: string) {
  return { type: "enterprise.organization.list_resources.request" as const, requestId };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
