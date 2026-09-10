import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import {
  AgentSnapshotPayloadSchema,
  AgentOwnershipEnvelopeSchema,
  AppSlotRecordSchema,
  AuditAppendOptionsSchema,
  AuditEventInputSchema,
  AuditEventSchema,
  BrowserProfileRecordSchema,
  BrowserProfileBindingProjectionSchema,
  BrowserProfileSummarySchema,
  ConnectionContextSchema,
  CurrentIdentityProjectionSchema,
  EnterpriseFeatureFlagsWireSchema,
  ENTERPRISE_ACTIONS,
  ENTERPRISE_IDENTITY_SELF_OUTBOUND_ALLOWLIST,
  ENTERPRISE_RUNTIME_ACTIONS_REQUIRING_EXPLICIT_GRANT,
  ENTERPRISE_MULTI_USER_SERVICE_PROXY_POLICY,
  ENTERPRISE_TRANSPORT_CONTROL_OUTBOUND_ALLOWLIST,
  ENTERPRISE_FEATURE_FLAGS,
  EnterpriseActionSchema,
  EnterpriseNodeRecordSchema,
  EnterpriseOrganizationResourceProjectionSchema,
  EnterprisePrincipalSummaryProjectionSchema,
  EnterprisePrincipalRecordSchema,
  EnterpriseWorkspaceContentReadRequestSchema,
  EnterpriseWorkspaceContentReadResponseSchema,
  EnterpriseAgentContentReadRequestSchema,
  EnterpriseBrowserProfileContentReadRequestSchema,
  EnterpriseAppSlotContentReadRequestSchema,
  EnterpriseResourceOwnershipTransferRequestSchema,
  EnterpriseResourceOwnershipTransferResponseSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
  EnterpriseBrowserPageIdentityObservationResponseSchema,
  EnterpriseResourceOwnerWireSchema,
  EnterpriseResourceStatusProjectionSchema,
  EnterpriseSessionBindingSchema,
  FencedLeaseSchema,
  GlobalResourceRefSchema,
  OutboundAuthorizationContextSchema,
  PrincipalContextSchema,
  ResourceLeaseSchema,
  ResourceGrantSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
  createEnterpriseSessionBindingKey,
  normalizeEnterpriseDisplayStrings,
  normalizeEnterpriseFeatureFlags,
  normalizeEnterpriseResourceOwner,
  normalizeResourceGrants,
  projectBrowserProfileSummary,
  projectCurrentIdentity,
  type AuthorizedAgent,
  type AuthorizedAppSlot,
  type AuthorizedBrowserProfile,
  type AuthorizedWorkspace,
  type AuditAppendOptions,
  type AuditEvent,
  type AuditEventInput,
  type AuditSequence,
  type AuditStorage,
  type EnterpriseAction,
  type EnterpriseWorkspaceAuthorizationRecord,
  type LocalAuditSinkContract,
  type LocalAuditSinkDependencies,
  type PrincipalContext,
  type ResourceAuthorization,
  type SessionOutboundMessage,
  type OutboundAuthorizationContext,
} from "./messages.js";

describe("enterprise feature compatibility", () => {
  test("an old daemon shape normalizes every enterprise capability to disabled", () => {
    const serverInfo = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
    });

    expect(normalizeEnterpriseFeatureFlags(serverInfo.features)).toEqual({
      enterpriseIdentityV1: false,
      enterpriseResourceAuthorizationV1: false,
      enterpriseBrowserProfilesV1: false,
      enterpriseAuditV1: false,
      enterpriseDistributedNodeV1: false,
      enterpriseWorkspaceContentReadV1: false,
      enterpriseAgentContentReadV1: false,
      enterpriseBrowserProfileContentReadV1: false,
      enterpriseAppSlotContentReadV1: false,
      enterpriseResourceOwnershipTransferV1: false,
      enterpriseBrowserPageIdentityObservationV1: false,
    });
  });

  test("enterprise feature fields stay optional on the wire", () => {
    expect(EnterpriseFeatureFlagsWireSchema.parse({})).toEqual({});
  });

  test("feature constants, wire fields, server info, and normalization stay exhaustive", () => {
    const advertised = Object.fromEntries(ENTERPRISE_FEATURE_FLAGS.map((flag) => [flag, true]));
    const serverInfo = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "enterprise-server",
      features: advertised,
    });

    expect(Object.keys(EnterpriseFeatureFlagsWireSchema.shape).sort()).toEqual(
      [...ENTERPRISE_FEATURE_FLAGS].sort(),
    );
    expect(
      Object.fromEntries(
        ENTERPRISE_FEATURE_FLAGS.map((flag) => [flag, serverInfo.features?.[flag]]),
      ),
    ).toEqual(advertised);
    expect(normalizeEnterpriseFeatureFlags(serverInfo.features)).toEqual(advertised);
  });

  test("a frozen old client parses new server info and ignores enterprise features", () => {
    const LegacyServerInfoSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z.object({ providersSnapshot: z.boolean().optional() }).optional(),
    });
    const parsed = LegacyServerInfoSchema.parse({
      status: "server_info",
      serverId: "enterprise-server",
      features: {
        providersSnapshot: true,
        enterpriseIdentityV1: true,
        enterpriseResourceAuthorizationV1: true,
        enterpriseBrowserProfilesV1: true,
        enterpriseAuditV1: true,
        enterpriseDistributedNodeV1: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "enterprise-server",
      features: { providersSnapshot: true },
    });
  });
});

describe("enterprise Browser page identity observation contract", () => {
  const request = {
    type: "enterprise.browser.page_identity.observe.request" as const,
    requestId: "observation-1",
    browser: {
      browserId: "11111111-1111-4111-8111-111111111111",
      browserProfileId: "brp_3333333333333333",
    },
    hostname: "account.example.com",
    accountLabelHash: "a".repeat(64),
    observationRevision: "obs-rev-1",
    bindingRevision: "binding-rev-1",
    lifecycleGeneration: "generation-1",
  };

  test("accepts normalized observation and exact correlated revision", () => {
    expect(EnterpriseBrowserPageIdentityObservationRequestSchema.parse(request)).toEqual(request);
    expect(
      EnterpriseBrowserPageIdentityObservationResponseSchema.parse({
        type: "enterprise.browser.page_identity.observe.response",
        payload: { requestId: request.requestId, acceptedRevision: request.observationRevision },
      }),
    ).toEqual({
      type: "enterprise.browser.page_identity.observe.response",
      payload: { requestId: request.requestId, acceptedRevision: request.observationRevision },
    });
  });

  test("accepts BrowserAutomation timestamp-hex browser ids", () => {
    expect(
      EnterpriseBrowserPageIdentityObservationRequestSchema.parse({
        ...request,
        browser: { ...request.browser, browserId: "1712345678901-abcdef012345" },
      }),
    ).toBeTruthy();
  });

  test("accepts hostname-only observation without an account label hash", () => {
    const { accountLabelHash: _omitted, ...hostnameOnly } = request;
    expect(EnterpriseBrowserPageIdentityObservationRequestSchema.parse(hostnameOnly)).toEqual(
      hostnameOnly,
    );
  });

  test("rejects identity secrets, extras, invalid hash, and invalid revision", () => {
    for (const extra of [
      { url: "https://account.example.com/private" },
      { cookie: "secret" },
      { accountLabel: "Alice" },
      { path: "/tmp/profile" },
      { pat: "token" },
      { lease: "lease-1" },
      { clientId: "client-1" },
      { homeNodeId: "node-1" },
    ]) {
      expect(() =>
        EnterpriseBrowserPageIdentityObservationRequestSchema.parse({ ...request, ...extra }),
      ).toThrow();
    }
    expect(() =>
      EnterpriseBrowserPageIdentityObservationRequestSchema.parse({
        ...request,
        accountLabelHash: "",
      }),
    ).toThrow();
    expect(() =>
      EnterpriseBrowserPageIdentityObservationRequestSchema.parse({
        ...request,
        observationRevision: "",
      }),
    ).toThrow();
    expect(() =>
      EnterpriseBrowserPageIdentityObservationRequestSchema.parse({
        ...request,
        hostname: "Account.Example.com",
      }),
    ).toThrow();
  });
});

describe("enterprise ownership-transfer contract", () => {
  const request = {
    type: "enterprise.resource.ownership.transfer.request" as const,
    requestId: "transfer-1",
    resource: {
      organizationId: "org_1111111111111111",
      nodeId: "nod_2222222222222222",
      resourceKind: "workspace" as const,
      localResourceId: "workspace-1",
    },
    expectedOwnerPrincipalId: "usr_3333333333333333",
    expectedRevision: "rev-1",
    newPrincipalId: "usr_4444444444444444",
  };

  test("accepts workspace and agent requests and correlated receipt response", () => {
    expect(EnterpriseResourceOwnershipTransferRequestSchema.parse(request)).toEqual(request);
    expect(
      EnterpriseResourceOwnershipTransferRequestSchema.parse({
        ...request,
        resource: { ...request.resource, resourceKind: "agent" },
      }),
    ).toBeTruthy();
    expect(
      EnterpriseResourceOwnershipTransferResponseSchema.parse({
        type: "enterprise.resource.ownership.transfer.response",
        payload: {
          requestId: request.requestId,
          resource: request.resource,
          ownerPrincipalId: request.newPrincipalId,
          revision: "rev-2",
          receiptId: "receipt-1",
        },
      }),
    ).toBeTruthy();
  });

  test("rejects non-resource families and unknown fields", () => {
    expect(() =>
      EnterpriseResourceOwnershipTransferRequestSchema.parse({
        ...request,
        resource: { ...request.resource, resourceKind: "browser_profile" },
      }),
    ).toThrow();
    expect(() =>
      EnterpriseResourceOwnershipTransferRequestSchema.parse({ ...request, extra: true }),
    ).toThrow();
    expect(() =>
      EnterpriseResourceOwnershipTransferRequestSchema.parse({
        ...request,
        resource: { ...request.resource, extra: true },
      }),
    ).toThrow();
    expect(() =>
      EnterpriseResourceOwnershipTransferResponseSchema.parse({
        type: "enterprise.resource.ownership.transfer.response",
        payload: {
          requestId: request.requestId,
          resource: request.resource,
          ownerPrincipalId: request.newPrincipalId,
          revision: "rev-2",
          receiptId: "receipt-1",
          extra: true,
        },
      }),
    ).toThrow();
  });
});

describe("enterprise content-read contracts", () => {
  const base = {
    type: "enterprise.workspace.content.read.request" as const,
    requestId: "content-1",
    resource: {
      organizationId: "org_1111111111111111",
      nodeId: "nod_2222222222222222",
      resourceKind: "workspace" as const,
      localResourceId: "workspace-1",
    },
    selector: { kind: "workspace" as const, view: "timeline" as const },
    page: { limit: 20 },
  };

  test("accepts each strict family request and response envelope", () => {
    expect(EnterpriseWorkspaceContentReadRequestSchema.parse(base)).toEqual(base);
    expect(
      EnterpriseWorkspaceContentReadResponseSchema.parse({
        type: "enterprise.workspace.content.read.response",
        payload: {
          requestId: "content-1",
          resource: base.resource,
          selector: base.selector,
          page: {
            items: [{ itemId: "item-1", occurredAt: "2026-01-01", text: "safe", kind: "message" }],
            nextCursor: null,
          },
        },
      }),
    ).toBeTruthy();
    expect(
      EnterpriseAgentContentReadRequestSchema.parse({
        ...base,
        type: "enterprise.agent.content.read.request",
        resource: { ...base.resource, resourceKind: "agent" },
        selector: { kind: "agent", view: "transcript" },
      }),
    ).toBeTruthy();
    expect(
      EnterpriseBrowserProfileContentReadRequestSchema.parse({
        ...base,
        type: "enterprise.browser_profile.content.read.request",
        resource: {
          ...base.resource,
          resourceKind: "browser_profile",
          localResourceId: "brp_3333333333333333",
        },
        selector: { kind: "browser_profile", view: "state" },
      }),
    ).toBeTruthy();
    expect(
      EnterpriseAppSlotContentReadRequestSchema.parse({
        ...base,
        type: "enterprise.app_slot.content.read.request",
        resource: {
          ...base.resource,
          resourceKind: "app_slot",
          localResourceId: "aps_4444444444444444",
        },
        selector: { kind: "app_slot", view: "state" },
      }),
    ).toBeTruthy();
  });

  test("rejects unknown fields and resource/selector family mismatch", () => {
    expect(() =>
      EnterpriseWorkspaceContentReadRequestSchema.parse({ ...base, extra: true }),
    ).toThrow();
    expect(() =>
      EnterpriseWorkspaceContentReadRequestSchema.parse({
        ...base,
        resource: { ...base.resource, resourceKind: "agent" },
      }),
    ).toThrow();
    expect(() =>
      EnterpriseWorkspaceContentReadResponseSchema.parse({
        type: "enterprise.workspace.content.read.response",
        payload: {
          requestId: "content-1",
          resource: base.resource,
          selector: base.selector,
          page: {
            items: [
              { itemId: "item-1", occurredAt: "2026-01-01", content: "secret", kind: "message" },
            ],
            nextCursor: null,
          },
        },
      }),
    ).toThrow();
  });
});

const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_2222222222222222";
const OWNER_ID = "usr_3333333333333333";
const CREATOR_ID = "usr_4444444444444444";

const PRINCIPAL: PrincipalContext = {
  principalId: OWNER_ID,
  organizationId: ORGANIZATION_ID,
  principalType: "human",
  grants: [],
  credentialId: "credential-1",
  grantVersion: "grant-v1",
};

class MemoryResourceAuthorization implements ResourceAuthorization {
  constructor(
    private readonly appSlots: ReadonlyMap<string, AuthorizedAppSlot>,
    private readonly allowedActions: ReadonlySet<EnterpriseAction>,
  ) {}

  filterWorkspaces<T extends EnterpriseWorkspaceAuthorizationRecord>(
    ctx: PrincipalContext,
    rows: readonly T[],
  ): T[] {
    return rows.filter((row) => {
      try {
        return (
          normalizeEnterpriseResourceOwner({
            organizationId: row.organizationId,
            nodeId: row.nodeId,
            ownerPrincipalId: row.ownerPrincipalId,
            createdByPrincipalId: row.createdByPrincipalId,
          })?.ownerPrincipalId === ctx.principalId && row.organizationId === ctx.organizationId
        );
      } catch {
        return false;
      }
    });
  }

  async assertWorkspace(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    this.assertAllowed(ctx, action);
    if (workspaceId !== "wks_1") throw new Error("resource_denied");
    return {
      workspaceId,
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    };
  }

  async assertAgent(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    agentId: string,
  ): Promise<AuthorizedAgent> {
    this.assertAllowed(ctx, action);
    if (agentId !== "agent-1") throw new Error("resource_denied");
    return {
      agentId,
      workspaceId: "wks_1",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    };
  }

  async assertBrowserProfile(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    browserProfileId: string,
  ): Promise<AuthorizedBrowserProfile> {
    this.assertAllowed(ctx, action);
    return BrowserProfileRecordSchema.parse({
      browserProfileId,
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_6666666666666666",
      ownerPrincipalId: OWNER_ID,
      platform: "generic",
      businessAccountKey: "account-hash",
      label: "Store account",
      partitionKey: `persist:${browserProfileId}`,
      downloadRoot: `/downloads/${browserProfileId}`,
      status: "ready",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
  }

  async assertAppSlot(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    appSlotId: string,
  ): Promise<AuthorizedAppSlot> {
    const appSlot = this.appSlots.get(appSlotId);
    if (
      !appSlot ||
      appSlot.organizationId !== ctx.organizationId ||
      appSlot.ownerPrincipalId !== ctx.principalId ||
      !this.allowedActions.has(action)
    ) {
      throw new Error("resource_denied");
    }
    return appSlot;
  }

  async resolveWorkspacePath(
    ctx: PrincipalContext,
    workspaceId: string,
    requestedPath: string,
  ): Promise<string> {
    if (
      ctx.organizationId !== ORGANIZATION_ID ||
      workspaceId !== "wks_1" ||
      requestedPath.split("/").includes("..")
    ) {
      throw new Error("resource_denied");
    }
    return `/workspace/${requestedPath.replace(/^\/+/, "")}`;
  }

  async canEmit(
    _ctx: PrincipalContext,
    event: SessionOutboundMessage,
    context: OutboundAuthorizationContext,
  ): Promise<boolean> {
    if (context.kind === "resources") {
      return context.resources.every((resource) => resource.organizationId === ORGANIZATION_ID);
    }
    if (context.kind === "authority") {
      return false;
    }
    if (context.control === "pong") {
      return event.type === "pong";
    }
    return event.type === "status" && event.payload.status === "server_info";
  }

  private assertAllowed(ctx: PrincipalContext, action: EnterpriseAction): void {
    if (ctx.organizationId !== ORGANIZATION_ID || !this.allowedActions.has(action)) {
      throw new Error("resource_denied");
    }
  }
}

describe("enterprise resource contracts", () => {
  test("audit callers submit strict business input without sink-owned chain fields", () => {
    const input = {
      organizationId: ORGANIZATION_ID,
      actorPrincipalId: OWNER_ID,
      actorCredentialId: "credential-1",
      sessionId: "session-1",
      action: "browser.lease.acquired",
      resource: { kind: "browser_profile", id: "brp_5555555555555555" },
      workspaceId: "wks_1",
      agentId: "agent-1",
      outcome: "allowed",
      reasonCode: "lease_acquired",
      metadata: { mode: "write" },
    } as const;

    expect(AuditEventInputSchema.parse(input)).toEqual(input);

    const sinkOwnedFields = {
      eventId: "evt-1",
      occurredAt: "2026-09-09T00:00:00.000Z",
      nodeId: NODE_ID,
      nodeEventSeq: 1,
      previousHash: "previous-hash",
      eventHash: "event-hash",
    };
    for (const [field, value] of Object.entries(sinkOwnedFields)) {
      expect(AuditEventInputSchema.safeParse({ ...input, [field]: value }).success).toBe(false);
    }
  });

  test("keeps priority optional for old events and round-trips high priority", () => {
    const legacy = AuditEventSchema.parse({
      eventId: "evt-legacy",
      occurredAt: "2026-09-09T00:00:00.000Z",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      nodeEventSeq: 1,
      actorPrincipalId: OWNER_ID,
      action: "identity.break_glass.use",
      resource: { kind: "organization", id: ORGANIZATION_ID },
      outcome: "allowed",
    });
    expect(legacy.priority).toBeUndefined();

    const highInput = AuditEventInputSchema.parse({
      organizationId: ORGANIZATION_ID,
      actorPrincipalId: OWNER_ID,
      action: "identity.break_glass.use",
      resource: { kind: "organization", id: ORGANIZATION_ID },
      outcome: "allowed",
      priority: "high",
    });
    expect(highInput.priority).toBe("high");
    expect(
      AuditEventSchema.parse({
        ...highInput,
        eventId: "evt-high",
        occurredAt: "2026-09-09T00:00:00.000Z",
        nodeId: NODE_ID,
        nodeEventSeq: 2,
      }),
    ).toMatchObject({ priority: "high" });
    expect(AuditEventInputSchema.safeParse({ ...highInput, priority: "urgent" }).success).toBe(
      false,
    );
  });

  test("the Local AuditSink contract returns one finalized event for explicit durability", async () => {
    const node = { nodeId: NODE_ID, paseoServerId: "srv_local", mode: "standalone" } as const;
    const input: AuditEventInput = AuditEventInputSchema.parse({
      organizationId: ORGANIZATION_ID,
      actorPrincipalId: OWNER_ID,
      action: "boss.content.viewed",
      resource: { kind: "workspace", id: "wks_1" },
      workspaceId: "wks_1",
      outcome: "allowed",
    });
    const finalized: AuditEvent = AuditEventSchema.parse({
      ...input,
      eventId: "evt-1",
      occurredAt: "2026-09-09T00:00:00.000Z",
      nodeId: NODE_ID,
      nodeEventSeq: 1,
      eventHash: "event-hash",
    });
    const calls: Array<{ input: AuditEventInput; options: AuditAppendOptions }> = [];
    const sink: LocalAuditSinkContract = {
      adapterKind: "local",
      node,
      append: async (candidate, options) => {
        calls.push({ input: candidate, options });
        return finalized;
      },
    };

    await expect(
      sink.append(input, AuditAppendOptionsSchema.parse({ durability: "required" })),
    ).resolves.toEqual(finalized);
    expect(calls).toEqual([{ input, options: { durability: "required" } }]);
    expect(AuditAppendOptionsSchema.parse({ durability: "buffered" })).toEqual({
      durability: "buffered",
    });
    expect(AuditAppendOptionsSchema.safeParse({ durability: "best_effort" }).success).toBe(false);
    expect(
      AuditAppendOptionsSchema.safeParse({ durability: "required", extra: true }).success,
    ).toBe(false);
  });

  test("Local AuditSink construction dependencies keep authority behind injected ports", async () => {
    expectTypeOf<AuditStorage["readAll"]>().toEqualTypeOf<() => Promise<readonly AuditEvent[]>>();
    expectTypeOf<AuditStorage["append"]>().toEqualTypeOf<
      (event: Readonly<AuditEvent>) => Promise<void>
    >();
    expectTypeOf<AuditSequence["next"]>().toEqualTypeOf<
      (previousSequence: number | null) => Promise<number>
    >();

    const node = { nodeId: NODE_ID, paseoServerId: "srv_local", mode: "standalone" } as const;
    const dependencies: LocalAuditSinkDependencies = {
      node,
      clock: { now: () => "2026-09-09T00:00:00.000Z" },
      idSource: { next: () => "evt-1" },
      hash: { hash: async () => "event-hash" },
      sequence: { next: async (previousSequence) => (previousSequence ?? 0) + 1 },
      storage: {
        readAll: async () => [],
        append: async () => undefined,
      },
    };

    expect(dependencies.node).toBe(node);
    expect(dependencies.clock.now()).toBe("2026-09-09T00:00:00.000Z");
    expect(dependencies.idSource.next()).toBe("evt-1");
    await expect(dependencies.storage.readAll()).resolves.toEqual([]);
    await expect(dependencies.sequence.next(null)).resolves.toBe(1);
    await expect(dependencies.sequence.next(7)).resolves.toBe(8);
  });

  test("UI identity and Profile projections omit authentication and browser storage fields", () => {
    const principal = PrincipalContextSchema.parse({
      ...PRINCIPAL,
      grants: [{ action: "workspace.write", selector: { kind: "self" } }],
    });
    const node = { nodeId: NODE_ID, paseoServerId: "srv_local", mode: "standalone" } as const;
    const identity = projectCurrentIdentity(principal, node, {
      displayName: "Operator",
      navigation: ["workspaces", "future-navigation", "workspaces"],
      allowedOperations: ["workspace.create", "future-operation"],
    });
    const profile = BrowserProfileRecordSchema.parse({
      browserProfileId: "brp_5555555555555555",
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_6666666666666666",
      ownerPrincipalId: OWNER_ID,
      platform: "taobao",
      businessAccountKey: "account-hash",
      label: "Store account",
      partitionKey: "persist:paseo-enterprise-brp_5555555555555555",
      downloadRoot: "/enterprise/downloads/brp_5555555555555555",
      credentialRef: "keychain:item",
      expectedIdentity: { hostnames: ["seller.example"] },
      status: "ready",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    const summary = projectBrowserProfileSummary(profile);

    expect(CurrentIdentityProjectionSchema.parse(identity)).not.toHaveProperty("credentialId");
    expect(CurrentIdentityProjectionSchema.parse(identity)).not.toHaveProperty("grants");
    expect(normalizeEnterpriseDisplayStrings(identity.navigation, ["workspaces"])).toEqual([
      "workspaces",
    ]);
    expect(
      normalizeEnterpriseDisplayStrings(identity.allowedOperations, ["workspace.create"]),
    ).toEqual(["workspace.create"]);
    for (const field of [
      "partitionKey",
      "downloadRoot",
      "credentialRef",
      "businessAccountKey",
      "expectedIdentity",
    ]) {
      expect(summary).not.toHaveProperty(field);
    }
    expect(BrowserProfileSummarySchema.parse(summary)).toEqual(summary);
    expect(
      BrowserProfileBindingProjectionSchema.parse({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        workspaceId: "wks_1",
        browserProfileId: profile.browserProfileId,
        boundByPrincipalId: OWNER_ID,
        boundAt: "2026-09-09T00:00:00.000Z",
        credentialRef: "must-be-dropped",
      }),
    ).not.toHaveProperty("credentialRef");
    expect(
      BrowserProfileBindingProjectionSchema.parse({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        workspaceId: "wks_1",
        browserProfileId: profile.browserProfileId,
        boundByPrincipalId: OWNER_ID,
        boundAt: "2026-09-09T00:00:00.000Z",
      }),
    ).not.toHaveProperty("boundByPrincipalId");
  });

  test("resource status and organization projections expose metadata without lease holders", () => {
    const status = EnterpriseResourceStatusProjectionSchema.parse({
      resource: {
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        resourceKind: "app_slot",
        localResourceId: "aps_7777777777777777",
      },
      status: "resource_waiting",
      workspaceId: "wks_1",
      agentId: "agent-1",
      label: "Accounting app",
      queue: { queuedAt: "2026-09-09T00:00:00.000Z", position: 2 },
      allowedOperations: ["open", "future-operation"],
      reasonCode: "capacity_wait",
      holderPrincipalId: OWNER_ID,
      holderAgentId: "agent-1",
    });
    const profileResource = EnterpriseOrganizationResourceProjectionSchema.parse({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      resourceKind: "browser_profile",
      browserProfileId: "brp_5555555555555555",
      label: "Store account",
      ownerPrincipalId: OWNER_ID,
      status: "ready",
      occupancy: "available",
      partitionKey: "must-be-dropped",
      downloadRoot: "must-be-dropped",
      credentialRef: "must-be-dropped",
      businessAccountKey: "must-be-dropped",
      expectedIdentity: { hostnames: ["secret.example"] },
    });
    const agentResource = EnterpriseOrganizationResourceProjectionSchema.parse({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      resourceKind: "agent",
      agentId: "agent-1",
      workspaceId: "wks_1",
      ownerPrincipalId: OWNER_ID,
      label: "Import orders",
      status: "running",
      provider: "codex",
      model: "gpt-5",
      startedAt: "2026-09-09T00:00:00.000Z",
      lastActivityAt: "2026-09-09T00:01:00.000Z",
      durationMs: 60_000,
      resourcePressure: { waitingCount: 1, unavailableCount: 0 },
      resourceStatuses: [status],
      cwd: "/secret/workspace",
      path: "/secret/workspace/customer.csv",
      prompt: "secret prompt",
      timeline: ["secret"],
      content: "secret",
    });
    const principal = EnterprisePrincipalSummaryProjectionSchema.parse({
      principalId: OWNER_ID,
      displayName: "Operator",
      status: "active",
      credentialId: "must-be-dropped",
      grants: ["must-be-dropped"],
    });

    expect(status).not.toHaveProperty("holderPrincipalId");
    expect(status).not.toHaveProperty("holderAgentId");
    expect(
      normalizeEnterpriseDisplayStrings(
        [status.reasonCode ?? "", "future_reason_code"],
        ["capacity_wait"],
      ),
    ).toEqual(["capacity_wait"]);
    for (const field of [
      "partitionKey",
      "downloadRoot",
      "credentialRef",
      "businessAccountKey",
      "expectedIdentity",
    ]) {
      expect(profileResource).not.toHaveProperty(field);
    }
    for (const field of ["cwd", "path", "prompt", "timeline", "content"]) {
      expect(agentResource).not.toHaveProperty(field);
    }
    expect(principal).not.toHaveProperty("credentialId");
    expect(principal).not.toHaveProperty("grants");
  });

  test("V1 actions keep privileged execution capabilities separate from workspace.write", async () => {
    expect(ENTERPRISE_ACTIONS).toEqual([
      "workspace.metadata.read",
      "workspace.content.read",
      "workspace.write",
      "workspace.manage",
      "browser.use",
      "browser.profile.manage",
      "app.use",
      "audit.read",
      "identity.manage",
      "terminal.use",
      "provider.history.read",
      "provider.history.import",
      "workspace.script.execute",
      "workspace.script.configure",
      "workspace.editor.open",
    ]);
    expect(ENTERPRISE_RUNTIME_ACTIONS_REQUIRING_EXPLICIT_GRANT).toEqual([
      "terminal.use",
      "provider.history.read",
      "provider.history.import",
      "workspace.script.execute",
      "workspace.script.configure",
      "workspace.editor.open",
    ]);

    const writeOnly = new Set<EnterpriseAction>(["workspace.write"]);
    for (const action of [
      "terminal.use",
      "provider.history.read",
      "provider.history.import",
      "workspace.script.execute",
      "workspace.script.configure",
      "workspace.editor.open",
    ] as const) {
      expect(writeOnly.has(action)).toBe(false);
    }
    const authorization = new MemoryResourceAuthorization(new Map(), writeOnly);
    await expect(authorization.assertWorkspace(PRINCIPAL, "terminal.use", "wks_1")).rejects.toThrow(
      "resource_denied",
    );
  });

  test("the typed ResourceAuthorization memory adapter fails closed for AppSlot access", async () => {
    const appSlot = AppSlotRecordSchema.parse({
      appSlotId: "aps_7777777777777777",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      appBundleId: "com.example.app",
      accountBindingKey: "account-hash",
      ownerPrincipalId: OWNER_ID,
      concurrency: 1,
      status: "ready",
    });
    const denied = new MemoryResourceAuthorization(
      new Map([[appSlot.appSlotId, appSlot]]),
      new Set(),
    );
    const allowed = new MemoryResourceAuthorization(
      new Map([[appSlot.appSlotId, appSlot]]),
      new Set(["app.use"]),
    );

    await expect(denied.assertAppSlot(PRINCIPAL, "app.use", appSlot.appSlotId)).rejects.toThrow(
      "resource_denied",
    );
    await expect(allowed.assertAppSlot(PRINCIPAL, "app.use", appSlot.appSlotId)).resolves.toEqual(
      appSlot,
    );
  });

  test("the typed ResourceAuthorization memory adapter covers every resource assertion", async () => {
    const authorization = new MemoryResourceAuthorization(
      new Map(),
      new Set(["workspace.metadata.read", "browser.use"]),
    );

    await expect(
      authorization.assertWorkspace(PRINCIPAL, "workspace.metadata.read", "wks_1"),
    ).resolves.toMatchObject({ workspaceId: "wks_1", ownerPrincipalId: OWNER_ID });
    await expect(
      authorization.assertAgent(PRINCIPAL, "workspace.metadata.read", "agent-1"),
    ).resolves.toMatchObject({ agentId: "agent-1", workspaceId: "wks_1" });
    await expect(
      authorization.assertBrowserProfile(PRINCIPAL, "browser.use", "brp_5555555555555555"),
    ).resolves.toMatchObject({
      browserProfileId: "brp_5555555555555555",
      homeNodeId: NODE_ID,
    });
    await expect(
      authorization.resolveWorkspacePath(PRINCIPAL, "wks_1", "src/index.ts"),
    ).resolves.toBe("/workspace/src/index.ts");
    await expect(
      authorization.resolveWorkspacePath(PRINCIPAL, "wks_1", "../secret"),
    ).rejects.toThrow("resource_denied");
  });

  test("workspace filtering quarantines legacy and partial ownership rows", () => {
    const authorization = new MemoryResourceAuthorization(new Map(), new Set());
    const rows: EnterpriseWorkspaceAuthorizationRecord[] = [
      {
        id: "complete",
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      },
      { id: "legacy-owner-only" },
      { id: "partial", organizationId: ORGANIZATION_ID, ownerPrincipalId: OWNER_ID },
    ];

    expect(authorization.filterWorkspaces(PRINCIPAL, rows)).toEqual([rows[0]]);
  });

  test("outbound authorization preserves resource and transport-control contexts", async () => {
    const authorization = new MemoryResourceAuthorization(new Map(), new Set());
    const event = SessionOutboundMessageSchema.parse({
      type: "enterprise.resource.status",
      payload: {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          localResourceId: "brp_5555555555555555",
        },
        status: "ready",
        allowedOperations: [],
      },
    });
    const resources = OutboundAuthorizationContextSchema.parse({
      kind: "resources",
      resources: [
        {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          localResourceId: "brp_5555555555555555",
        },
      ],
    });
    const transportControl = {
      kind: "transport_control",
      control: "server_info",
    } as const;

    expect(ENTERPRISE_TRANSPORT_CONTROL_OUTBOUND_ALLOWLIST).toEqual(["pong", "server_info"]);
    expect(OutboundAuthorizationContextSchema.parse(transportControl)).toEqual(transportControl);
    expect(
      OutboundAuthorizationContextSchema.safeParse({ kind: "resources", resources: [] }).success,
    ).toBe(false);
    expect(
      OutboundAuthorizationContextSchema.safeParse({
        kind: "transport_control",
        control: "source",
      }).success,
    ).toBe(false);
    expect(
      OutboundAuthorizationContextSchema.safeParse({
        kind: "transport_control",
        control: "rpc_error",
      }).success,
    ).toBe(false);
    expect(
      OutboundAuthorizationContextSchema.safeParse({ ...resources, unexpected: true }).success,
    ).toBe(false);
    expect(
      OutboundAuthorizationContextSchema.safeParse({
        kind: "transport_control",
        control: "pong",
        unexpected: true,
      }).success,
    ).toBe(false);
    await expect(authorization.canEmit(PRINCIPAL, event, resources)).resolves.toBe(true);
    await expect(
      authorization.canEmit(PRINCIPAL, event, {
        kind: "transport_control",
        control: "server_info",
      }),
    ).resolves.toBe(false);
    const pong = SessionOutboundMessageSchema.parse({
      type: "pong",
      payload: {
        requestId: "req-ping",
        serverReceivedAt: 1,
        serverSentAt: 2,
      },
    });
    const serverInfo = SessionOutboundMessageSchema.parse({
      type: "status",
      payload: { status: "server_info", serverId: "srv_local" },
    });
    const rpcError = SessionOutboundMessageSchema.parse({
      type: "rpc_error",
      payload: { requestId: "req-resource", error: "fixed_error" },
    });

    await expect(
      authorization.canEmit(PRINCIPAL, pong, { kind: "transport_control", control: "pong" }),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(PRINCIPAL, serverInfo, {
        kind: "transport_control",
        control: "server_info",
      }),
    ).resolves.toBe(true);
    await expect(authorization.canEmit(PRINCIPAL, rpcError, resources)).resolves.toBe(true);
    await expect(
      authorization.canEmit(PRINCIPAL, rpcError, {
        kind: "transport_control",
        control: "server_info",
      }),
    ).resolves.toBe(false);
  });

  test("authorized-request authority carries a strict server receipt and open request type", () => {
    const context = {
      kind: "authority",
      authority: {
        kind: "authorized_request",
        receiptId: "opaque-receipt-1",
        requestId: "req-global-1",
        requestType: "future.global.operation.request",
        sessionBindingKey: "binding-key-1",
        sessionBindingGeneration: "generation-1",
      },
    } as const;

    expect(OutboundAuthorizationContextSchema.parse(context)).toEqual(context);

    for (const value of [
      { kind: "authority" },
      { ...context, unexpected: true },
      { ...context, authority: { ...context.authority, unexpected: true } },
      { ...context, authority: { ...context.authority, receiptId: "" } },
      { ...context, authority: { ...context.authority, requestId: "" } },
      { ...context, authority: { ...context.authority, requestType: "" } },
      { ...context, authority: { ...context.authority, sessionBindingKey: "" } },
      { ...context, authority: { ...context.authority, sessionBindingGeneration: "" } },
      { ...context, authority: { ...context.authority, receiptId: 1 } },
      { ...context, authority: { ...context.authority, requestType: false } },
    ]) {
      expect(OutboundAuthorizationContextSchema.safeParse(value).success).toBe(false);
    }
  });

  test("identity-self authority has an exact response and event allowlist", () => {
    expect(ENTERPRISE_IDENTITY_SELF_OUTBOUND_ALLOWLIST).toEqual([
      "enterprise.identity.get_current.response",
      "enterprise.identity.logout_all.response",
      "enterprise.identity.scope_refreshed",
      "enterprise.identity.credential_revoked",
    ]);

    const binding = {
      sessionBindingKey: "binding-key-1",
      sessionBindingGeneration: "generation-1",
    } as const;
    const accepted = [
      {
        kind: "authority",
        authority: {
          kind: "identity_self",
          ...binding,
          message: {
            type: "enterprise.identity.get_current.response",
            requestId: "req-current",
          },
        },
      },
      {
        kind: "authority",
        authority: {
          kind: "identity_self",
          ...binding,
          message: {
            type: "enterprise.identity.logout_all.response",
            requestId: "req-logout",
          },
        },
      },
      {
        kind: "authority",
        authority: {
          kind: "identity_self",
          ...binding,
          message: { type: "enterprise.identity.scope_refreshed" },
        },
      },
      {
        kind: "authority",
        authority: {
          kind: "identity_self",
          ...binding,
          message: { type: "enterprise.identity.credential_revoked" },
        },
      },
    ] as const;

    for (const context of accepted) {
      expect(OutboundAuthorizationContextSchema.parse(context)).toEqual(context);
    }

    for (const context of [
      {
        ...accepted[0],
        unexpected: true,
      },
      {
        ...accepted[0],
        authority: {
          ...accepted[0].authority,
          message: { type: "enterprise.identity.get_current.response" },
        },
      },
      {
        ...accepted[0],
        authority: {
          ...accepted[0].authority,
          message: { type: "enterprise.identity.get_current.response", requestId: "" },
        },
      },
      {
        ...accepted[2],
        authority: {
          ...accepted[2].authority,
          message: { type: "enterprise.identity.scope_refreshed", requestId: "req-not-allowed" },
        },
      },
      {
        ...accepted[2],
        authority: {
          ...accepted[2].authority,
          message: { type: "enterprise.identity.list_principals.response", requestId: "req-1" },
        },
      },
      {
        ...accepted[2],
        authority: {
          ...accepted[2].authority,
          message: { type: "rpc_error", requestId: "req-1" },
        },
      },
      {
        ...accepted[2],
        authority: { ...accepted[2].authority, message: null },
      },
      {
        ...accepted[2],
        authority: { ...accepted[2].authority, unexpected: true },
      },
      {
        ...accepted[2],
        authority: { ...accepted[2].authority, sessionBindingKey: "" },
      },
      {
        ...accepted[2],
        authority: { ...accepted[2].authority, sessionBindingGeneration: 1 },
      },
    ]) {
      expect(OutboundAuthorizationContextSchema.safeParse(context).success).toBe(false);
    }
  });

  test("enterprise mode denies a public Workspace Service Proxy request without a principal", () => {
    expect(ENTERPRISE_MULTI_USER_SERVICE_PROXY_POLICY).toEqual({
      unauthenticatedRequest: "deny",
      legacySingleUserBehavior: "unchanged",
    });
  });

  test("principal grants use discriminated selectors instead of roles", () => {
    const grant = ResourceGrantSchema.parse({
      action: "workspace.content.read",
      selector: { kind: "workspace", workspaceIds: ["wks_1", "wks_2"] },
    });
    const principal = PrincipalContextSchema.parse({
      principalId: OWNER_ID,
      organizationId: ORGANIZATION_ID,
      principalType: "human",
      grants: [grant],
      credentialId: "credential-1",
      grantVersion: "grant-v1",
    });

    expect(principal).toEqual({
      principalId: OWNER_ID,
      organizationId: ORGANIZATION_ID,
      principalType: "human",
      grants: [
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: ["wks_1", "wks_2"] },
        },
      ],
      credentialId: "credential-1",
      grantVersion: "grant-v1",
    });
    expect(
      ResourceGrantSchema.safeParse({
        action: "workspace.content.read",
        selector: { kind: "workspace", organizationId: ORGANIZATION_ID },
      }).success,
    ).toBe(false);
    expect(
      PrincipalContextSchema.parse({
        principalId: "owner",
        organizationId: ORGANIZATION_ID,
        principalType: "break_glass_owner",
        grants: [],
        credentialId: "local-daemon-password",
        grantVersion: "grant-owner-v1",
      }),
    ).toMatchObject({ principalId: "owner", principalType: "break_glass_owner" });
    expect(
      EnterprisePrincipalRecordSchema.safeParse({
        principalId: "svc_5555555555555555",
        organizationId: ORGANIZATION_ID,
        principalType: "human",
        status: "active",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("connection authentication carries node context and grants normalize deterministically", () => {
    expect(
      ConnectionContextSchema.parse({
        node: { nodeId: NODE_ID, paseoServerId: "srv_local", mode: "standalone" },
        transport: "direct",
        peer: "loopback",
      }),
    ).toEqual({
      node: { nodeId: NODE_ID, paseoServerId: "srv_local", mode: "standalone" },
      transport: "direct",
      peer: "loopback",
    });

    expect(
      normalizeResourceGrants([
        {
          action: "workspace.write",
          selector: { kind: "workspace", workspaceIds: ["wks_2", "wks_1", "wks_2"] },
        },
        { action: "workspace.metadata.read", selector: { kind: "self" } },
        {
          action: "workspace.write",
          selector: { kind: "workspace", workspaceIds: ["wks_1", "wks_2"] },
        },
      ]),
    ).toEqual([
      { action: "workspace.metadata.read", selector: { kind: "self" } },
      {
        action: "workspace.write",
        selector: { kind: "workspace", workspaceIds: ["wks_1", "wks_2"] },
      },
    ]);
    const binding = EnterpriseSessionBindingSchema.parse({
      organizationId: ORGANIZATION_ID,
      principalId: OWNER_ID,
      credentialId: "credential-1",
      grantVersion: "grant-v1",
      clientId: "client-1",
    });
    expect(createEnterpriseSessionBindingKey(binding)).toBe(
      '["org_1111111111111111","usr_3333333333333333","credential-1","grant-v1","client-1"]',
    );
  });

  test("legacy owner fields stay optional but partial enterprise ownership fails normalization", () => {
    expect(EnterpriseResourceOwnerWireSchema.parse({})).toEqual({});
    expect(normalizeEnterpriseResourceOwner({})).toBeUndefined();
    expect(() =>
      normalizeEnterpriseResourceOwner({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
      }),
    ).toThrow();
    expect(
      normalizeEnterpriseResourceOwner({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toEqual({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    });
    expect(
      AgentOwnershipEnvelopeSchema.parse({
        workspaceId: "wks_1",
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toEqual({
      workspaceId: "wks_1",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    });
  });

  test("agent and workspace projections accept legacy rows and retain optional owner fields", () => {
    const LegacyAgentProjectionSchema = z.object({
      id: z.string(),
      provider: z.string(),
      cwd: z.string(),
    });
    const LegacyWorkspaceProjectionSchema = z.object({
      id: z.string(),
      projectId: z.string(),
      projectRootPath: z.string(),
    });
    const agent = {
      id: "agent-1",
      provider: "codex",
      cwd: "/workspace",
      model: null,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
    };
    const workspace = {
      id: "wks_1",
      projectId: "prj_1",
      projectDisplayName: "Project",
      projectRootPath: "/workspace",
      projectKind: "git",
      workspaceKind: "local_checkout",
      name: "main",
      status: "done",
      activityAt: null,
    };

    expect(AgentSnapshotPayloadSchema.parse(agent)).not.toHaveProperty("organizationId");
    expect(WorkspaceDescriptorPayloadSchema.parse(workspace)).not.toHaveProperty("organizationId");
    expect(
      AgentSnapshotPayloadSchema.parse({
        ...agent,
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toMatchObject({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    });
    expect(
      WorkspaceDescriptorPayloadSchema.parse({
        ...workspace,
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toMatchObject({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    });
    expect(
      LegacyAgentProjectionSchema.parse({
        ...agent,
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toEqual({ id: "agent-1", provider: "codex", cwd: "/workspace" });
    expect(
      LegacyWorkspaceProjectionSchema.parse({
        ...workspace,
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        ownerPrincipalId: OWNER_ID,
        createdByPrincipalId: CREATOR_ID,
      }),
    ).toEqual({ id: "wks_1", projectId: "prj_1", projectRootPath: "/workspace" });
  });

  test("enterprise resources carry their explicit node dimension", () => {
    const profile = BrowserProfileRecordSchema.parse({
      browserProfileId: "brp_5555555555555555",
      organizationId: ORGANIZATION_ID,
      homeNodeId: NODE_ID,
      businessIdentityId: "bid_6666666666666666",
      ownerPrincipalId: OWNER_ID,
      platform: "taobao",
      businessAccountKey: "account-hash",
      label: "Store account",
      partitionKey: "persist:paseo-enterprise-brp_5555555555555555",
      downloadRoot: "/enterprise/downloads/brp_5555555555555555",
      status: "ready",
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    });
    const appSlot = AppSlotRecordSchema.parse({
      appSlotId: "aps_7777777777777777",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      businessIdentityId: "bid_6666666666666666",
      appBundleId: "com.example.app",
      accountBindingKey: "account-hash",
      ownerPrincipalId: OWNER_ID,
      concurrency: 1,
      status: "ready",
    });
    const lease = FencedLeaseSchema.parse({
      leaseId: "lea_11111111-1111-1111-1111-111111111111",
      organizationId: ORGANIZATION_ID,
      businessIdentityId: "bid_6666666666666666",
      resourceKind: "browser_profile",
      resourceId: profile.browserProfileId,
      nodeId: NODE_ID,
      holderPrincipalId: OWNER_ID,
      holderAgentId: "agent-1",
      fencingToken: 1,
      leaseRevision: "revision-1",
      mode: "write",
      acquiredAt: "2026-09-09T00:00:00.000Z",
      expiresAt: "2026-09-09T00:01:00.000Z",
      heartbeatAt: "2026-09-09T00:00:30.000Z",
    });
    const audit = AuditEventSchema.parse({
      eventId: "evt-1",
      occurredAt: "2026-09-09T00:00:00.000Z",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      nodeEventSeq: 1,
      actorPrincipalId: OWNER_ID,
      action: "browser.lease.acquired",
      resource: { kind: "browser_profile", id: profile.browserProfileId },
      outcome: "allowed",
    });
    const node = EnterpriseNodeRecordSchema.parse({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      paseoServerId: "srv_local",
      mode: "standalone",
      status: "active",
      capabilities: {},
    });
    const ref = GlobalResourceRefSchema.parse({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      resourceKind: "browser_profile",
      localResourceId: profile.browserProfileId,
    });

    expect([
      profile.homeNodeId,
      appSlot.nodeId,
      lease.nodeId,
      audit.nodeId,
      node.nodeId,
      ref.nodeId,
    ]).toEqual([NODE_ID, NODE_ID, NODE_ID, NODE_ID, NODE_ID, NODE_ID]);
    expect(profile).not.toHaveProperty("nodeId");
    expect(
      FencedLeaseSchema.safeParse({
        ...lease,
        resourceKind: "browser_profile",
        resourceId: appSlot.appSlotId,
      }).success,
    ).toBe(false);
    expect(
      ResourceLeaseSchema.safeParse({
        ...lease,
        resourceKind: "app_slot",
        resourceId: profile.browserProfileId,
      }).success,
    ).toBe(false);
    expect(
      GlobalResourceRefSchema.safeParse({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        resourceKind: "browser_profile",
        localResourceId: appSlot.appSlotId,
      }).success,
    ).toBe(false);
    expect(
      GlobalResourceRefSchema.safeParse({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        resourceKind: "organization",
        localResourceId: ORGANIZATION_ID,
      }).success,
    ).toBe(false);
  });

  test("V1 enums reject future values until a V2 capability is introduced", () => {
    expect(EnterpriseActionSchema.safeParse("workspace.share").success).toBe(false);
    expect(
      BrowserProfileRecordSchema.safeParse({
        browserProfileId: "brp_5555555555555555",
        organizationId: ORGANIZATION_ID,
        homeNodeId: NODE_ID,
        businessIdentityId: "bid_6666666666666666",
        ownerPrincipalId: OWNER_ID,
        platform: "future_platform",
        businessAccountKey: "account-hash",
        label: "Store account",
        partitionKey: "persist:paseo-enterprise-brp_5555555555555555",
        downloadRoot: "/enterprise/downloads/brp_5555555555555555",
        status: "ready",
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      EnterpriseNodeRecordSchema.safeParse({
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        paseoServerId: "srv_local",
        mode: "standalone",
        status: "future_status",
        capabilities: {},
      }).success,
    ).toBe(false);
  });
});

describe("enterprise RPC contracts", () => {
  test.each([
    { type: "enterprise.identity.get_current.request", requestId: "req-1" },
    { type: "enterprise.identity.list_principals.request", requestId: "req-2" },
    {
      type: "enterprise.access.list_grants.request",
      requestId: "req-3",
      principalId: OWNER_ID,
    },
    {
      type: "enterprise.access.update_grants.request",
      requestId: "req-4",
      principalId: OWNER_ID,
      grants: [],
      expectedRevision: "revision-1",
    },
    { type: "enterprise.audit.list_events.request", requestId: "req-5", limit: 50 },
    {
      type: "enterprise.browser.list_profiles.request",
      requestId: "req-6",
      workspaceId: "wks_1",
    },
    {
      type: "enterprise.browser.bind_profile.request",
      requestId: "req-7",
      workspaceId: "wks_1",
      browserProfileId: "brp_5555555555555555",
    },
    {
      type: "enterprise.resource.acquire_lease.request",
      requestId: "req-8",
      workspaceId: "wks_1",
      agentId: "agent-1",
      resourceKind: "browser_profile",
      mode: "write",
    },
    {
      type: "enterprise.resource.renew_lease.request",
      requestId: "req-9",
      leaseId: "lea_11111111-1111-1111-1111-111111111111",
      fencingToken: 1,
    },
    {
      type: "enterprise.resource.release_lease.request",
      requestId: "req-10",
      leaseId: "lea_11111111-1111-1111-1111-111111111111",
      fencingToken: 1,
    },
    { type: "enterprise.node.list_nodes.request", requestId: "req-11" },
    {
      type: "enterprise.node.set_drain.request",
      requestId: "req-12",
      nodeId: NODE_ID,
      draining: true,
    },
    {
      type: "enterprise.placement.resolve_workspace.request",
      requestId: "req-13",
      workspaceId: "wks_1",
    },
    {
      type: "enterprise.organization.list_resources.request",
      requestId: "req-14",
      resourceKinds: ["workspace", "browser_profile"],
      limit: 50,
    },
    { type: "enterprise.identity.logout_all.request", requestId: "req-15" },
  ])("parses $type as an inbound request", (message) => {
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  test.each([
    {
      type: "enterprise.identity.get_current.response",
      payload: {
        requestId: "req-1",
        identity: {
          principalId: OWNER_ID,
          organizationId: ORGANIZATION_ID,
          principalType: "human",
          grantVersion: "grant-v1",
          nodeId: NODE_ID,
          paseoServerId: "srv_local",
          navigation: ["workspaces"],
          allowedOperations: ["workspace.create"],
        },
      },
    },
    {
      type: "enterprise.identity.list_principals.response",
      payload: { requestId: "req-2", principals: [] },
    },
    {
      type: "enterprise.access.list_grants.response",
      payload: {
        requestId: "req-3",
        principalId: OWNER_ID,
        grants: [],
        revision: "revision-1",
      },
    },
    {
      type: "enterprise.access.update_grants.response",
      payload: {
        requestId: "req-4",
        principalId: OWNER_ID,
        grants: [],
        revision: "revision-2",
      },
    },
    {
      type: "enterprise.audit.list_events.response",
      payload: { requestId: "req-5", events: [], nextCursor: null },
    },
    {
      type: "enterprise.browser.list_profiles.response",
      payload: { requestId: "req-6", profiles: [], bindings: [] },
    },
    {
      type: "enterprise.browser.bind_profile.response",
      payload: {
        requestId: "req-7",
        binding: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          workspaceId: "wks_1",
          browserProfileId: "brp_5555555555555555",
          boundAt: "2026-09-09T00:00:00.000Z",
        },
      },
    },
    {
      type: "enterprise.resource.acquire_lease.response",
      payload: { requestId: "req-8", lease: null, waiting: true },
    },
    {
      type: "enterprise.resource.renew_lease.response",
      payload: { requestId: "req-9", lease: null },
    },
    {
      type: "enterprise.resource.release_lease.response",
      payload: { requestId: "req-10", released: true },
    },
    {
      type: "enterprise.node.list_nodes.response",
      payload: { requestId: "req-11", nodes: [] },
    },
    {
      type: "enterprise.node.set_drain.response",
      payload: {
        requestId: "req-12",
        node: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          paseoServerId: "srv_local",
          mode: "standalone",
          status: "draining",
          capabilities: {},
        },
      },
    },
    {
      type: "enterprise.placement.resolve_workspace.response",
      payload: { requestId: "req-13", resource: null },
    },
    {
      type: "enterprise.organization.list_resources.response",
      payload: { requestId: "req-14", principals: [], resources: [], nextCursor: null },
    },
    {
      type: "enterprise.identity.logout_all.response",
      payload: { requestId: "req-15", loggedOut: true },
    },
  ])("parses $type as an outbound response", (message) => {
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  test("lease wire requests discard authority fields supplied by a client", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "enterprise.resource.acquire_lease.request",
      requestId: "req-untrusted",
      workspaceId: "wks_1",
      agentId: "agent-1",
      resourceKind: "browser_profile",
      mode: "write",
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      holderPrincipalId: OWNER_ID,
      credentialId: "credential-1",
    });

    expect(parsed).toEqual({
      type: "enterprise.resource.acquire_lease.request",
      requestId: "req-untrusted",
      workspaceId: "wks_1",
      agentId: "agent-1",
      resourceKind: "browser_profile",
      mode: "write",
    });
  });

  test("outbound authorization context is not a wire message or client authority field", () => {
    const authorityContext = {
      kind: "authority",
      authority: {
        kind: "authorized_request",
        receiptId: "opaque-receipt-1",
        requestId: "req-current",
        requestType: "enterprise.identity.get_current.request",
        sessionBindingKey: "binding-key-1",
        sessionBindingGeneration: "generation-1",
      },
    } as const;

    expect(SessionInboundMessageSchema.safeParse(authorityContext).success).toBe(false);
    expect(SessionOutboundMessageSchema.safeParse(authorityContext).success).toBe(false);
    expect(
      SessionInboundMessageSchema.parse({
        type: "enterprise.identity.get_current.request",
        requestId: "req-current",
        outboundAuthorizationContext: authorityContext,
      }),
    ).toEqual({
      type: "enterprise.identity.get_current.request",
      requestId: "req-current",
    });
  });

  test("audit wire requests discard a client-supplied actor", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "enterprise.audit.list_events.request",
        requestId: "req-audit-untrusted",
        actorPrincipalId: OWNER_ID,
        workspaceId: "wks_1",
      }),
    ).toEqual({
      type: "enterprise.audit.list_events.request",
      requestId: "req-audit-untrusted",
      workspaceId: "wks_1",
    });
  });

  test("resource waiting is an enterprise-gated outbound event with node context", () => {
    const event = {
      type: "enterprise.resource.waiting",
      payload: {
        status: "resource_waiting",
        workspaceId: "wks_1",
        agentId: "agent-1",
        nodeId: NODE_ID,
        resourceKind: "browser_profile",
        resourceId: "brp_5555555555555555",
        mode: "write",
        queuedAt: "2026-09-09T00:00:00.000Z",
        position: 2,
      },
    } as const;

    expect(SessionOutboundMessageSchema.parse(event)).toEqual(event);
  });

  test.each([
    {
      type: "enterprise.resource.status",
      payload: {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          localResourceId: "brp_5555555555555555",
        },
        status: "ready",
        allowedOperations: [],
      },
    },
    {
      type: "enterprise.identity.scope_refreshed",
      payload: {
        identity: {
          principalId: OWNER_ID,
          organizationId: ORGANIZATION_ID,
          principalType: "human",
          grantVersion: "grant-v2",
          nodeId: NODE_ID,
          paseoServerId: "srv_local",
          navigation: [],
          allowedOperations: [],
        },
      },
    },
    {
      type: "enterprise.identity.credential_revoked",
      payload: { revokedAt: "2026-09-09T00:00:00.000Z", reasonCode: "administrator_action" },
    },
  ])("parses the $type projection event", (event) => {
    expect(SessionOutboundMessageSchema.parse(event)).toEqual(event);
  });
});
