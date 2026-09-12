import { describe, expect, test } from "vitest";

import type {
  AppSlotRecord,
  BrowserProfileRecord,
  PrincipalContext,
  ResourceGrant,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { OwnerRegistry } from "./owner-registry.js";
import {
  ResourceAuthorizationError,
  ResourceAuthorizationService,
  type AppSlotRegistry,
  type BrowserProfileRegistry,
  type EnterpriseAgentContentAuthorizationRow,
  type WorkspacePathRegistry,
} from "./resource-authorization.js";

const owner = {
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  ownerPrincipalId: "usr_0123456789abcdef",
  createdByPrincipalId: "usr_0123456789abcdef",
} as const;

const ctx: PrincipalContext = {
  principalType: "human",
  principalId: owner.ownerPrincipalId,
  organizationId: owner.organizationId,
  credentialId: "cred_test",
  grantVersion: "grv_1",
  grants: [
    { action: "workspace.metadata.read", selector: { kind: "self" } },
    { action: "workspace.content.read", selector: { kind: "workspace", workspaceIds: ["wks_a"] } },
    { action: "browser.use", selector: { kind: "self" } },
  ],
};

const workspaceRecord = { id: "wks_a", ...owner } as const;
const agentContentRow = { id: "agent_a", workspaceId: "wks_a", ...owner } as const;
const guard = { isCurrent: () => true };

function contentContext(selector: ResourceGrant["selector"]): PrincipalContext {
  return {
    ...ctx,
    grants: [{ action: "workspace.content.read", selector }],
  };
}

class MemoryBrowserProfiles implements BrowserProfileRegistry {
  constructor(private readonly profiles: readonly BrowserProfileRecord[]) {}

  async get(browserProfileId: string): Promise<BrowserProfileRecord | null> {
    return this.profiles.find((profile) => profile.browserProfileId === browserProfileId) ?? null;
  }
}

class MemoryAppSlots implements AppSlotRegistry {
  constructor(private readonly slots: readonly AppSlotRecord[]) {}

  async get(appSlotId: string): Promise<AppSlotRecord | null> {
    return this.slots.find((slot) => slot.appSlotId === appSlotId) ?? null;
  }
}

class MemoryWorkspacePaths implements WorkspacePathRegistry {
  async resolve(workspace: { workspaceId: string }, requestedPath: string): Promise<string | null> {
    return workspace.workspaceId === "wks_a" && requestedPath === "src/index.ts"
      ? "/tmp/paseo-workspace/src/index.ts"
      : null;
  }
}

function outbound(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  return { type } as SessionOutboundMessage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function revocableGuard() {
  let current = true;
  return {
    guard: { isCurrent: () => current },
    revoke: () => {
      current = false;
    },
  };
}

describe("ResourceAuthorizationService", () => {
  test("preauthorizes only current owned agents with content grant", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace({ id: "wks_a", ...owner });
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    expect(authorization.preauthorizeAgentEvent(ctx, "agent_a")).toBe(true);
    expect(authorization.preauthorizeAgentEvent(ctx, "missing")).toBe(false);
    expect(authorization.preauthorizeAgentEvent(ctx, "")).toBe(false);
  });

  test("preauthorization fails closed on revoked guard and foreign owner", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace({ id: "wks_a", ...owner });
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    const revocable = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: revocable.guard,
    });
    revocable.revoke();
    expect(
      authorization.preauthorizeAgentEvent(
        { ...ctx, grants: [{ action: "workspace.content.read", selector: { kind: "self" } }] },
        "agent_a",
      ),
    ).toBe(false);
    const currentAuthorization = new ResourceAuthorizationService({
      owners,
      nodeId: "nod_ffffffffffffffff",
      grantVersionGuard: guard,
    });
    expect(currentAuthorization.preauthorizeAgentEvent(ctx, "agent_a")).toBe(false);
  });
  test("preauthorization rejects foreign organization and owner rebind", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace({ id: "wks_a", ...owner });
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    expect(
      authorization.preauthorizeAgentEvent(
        { ...ctx, organizationId: "org_ffffffffffffffff" },
        "agent_a",
      ),
    ).toBe(false);
    owners.registerWorkspace({ id: "wks_a", ...owner, ownerPrincipalId: "usr_ffffffffffffffff" });
    owners.registerAgent({
      id: "agent_a",
      workspaceId: "wks_a",
      ...owner,
      ownerPrincipalId: "usr_ffffffffffffffff",
    });
    expect(
      authorization.preauthorizeAgentEvent(
        { ...ctx, grants: [{ action: "workspace.content.read", selector: { kind: "self" } }] },
        "agent_a",
      ),
    ).toBe(false);
  });
  test("rejects no grant, owner lookup errors, and a post-check guard flip", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace({ id: "wks_a", ...owner });
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    const noGrantAuthorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    expect(noGrantAuthorization.preauthorizeAgentEvent({ ...ctx, grants: [] }, "agent_a")).toBe(
      false,
    );

    const throwingOwners = new OwnerRegistry();
    throwingOwners.registerWorkspace({ id: "wks_a", ...owner });
    throwingOwners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    throwingOwners.getAgent = () => {
      throw new Error("owners unavailable");
    };
    const throwingAuthorization = new ResourceAuthorizationService({
      owners: throwingOwners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    expect(throwingAuthorization.preauthorizeAgentEvent(ctx, "agent_a")).toBe(false);

    let checks = 0;
    const flippingAuthorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: { isCurrent: () => ++checks === 1 },
    });
    expect(flippingAuthorization.preauthorizeAgentEvent(ctx, "agent_a")).toBe(false);
  });

  test.each([
    ["workspace", { kind: "workspace", workspaceIds: ["wks_a"] }],
    ["organization", { kind: "organization", organizationId: owner.organizationId }],
    ["self", { kind: "self" }],
  ] as const)("prefilters Agent content rows with an explicit %s grant", (_kind, selector) => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    const row = { ...agentContentRow };
    const rows = [row];
    const before = { ...row };
    const result = authorization.prefilterAgentContentRows(contentContext(selector), rows);

    expect(result).toEqual([row]);
    expect(result[0]).toBe(row);
    expect(rows).toEqual([row]);
    expect(row).toEqual(before);
  });

  test("prefilter is fixed to content grants and has no implicit self access", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    expect(
      authorization.prefilterAgentContentRows({ ...ctx, grants: [] }, [agentContentRow]),
    ).toEqual([]);
    expect(
      authorization.prefilterAgentContentRows(
        {
          ...ctx,
          grants: [{ action: "workspace.metadata.read", selector: { kind: "self" } }],
        },
        [agentContentRow],
      ),
    ).toEqual([]);
  });

  test.each([
    ["agent id", { id: "agent_b" }],
    ["workspace id", { workspaceId: "wks_b" }],
    ["organization", { organizationId: "org_ffffffffffffffff" }],
    ["node", { nodeId: "nod_ffffffffffffffff" }],
    ["owner", { ownerPrincipalId: "usr_ffffffffffffffff" }],
    ["creator", { createdByPrincipalId: "usr_ffffffffffffffff" }],
  ] as const)("rejects a noncanonical Agent content %s", (_field, replacement) => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    expect(
      authorization.prefilterAgentContentRows(ctx, [{ ...agentContentRow, ...replacement }]),
    ).toEqual([]);
  });

  test.each([
    ["organization", { ...owner, organizationId: "org_ffffffffffffffff" }],
    ["node", { ...owner, nodeId: "nod_ffffffffffffffff" }],
  ] as const)("rejects a canonical Agent outside the runtime %s", (_field, canonicalOwner) => {
    const owners = new OwnerRegistry();
    const row = { id: "agent_a", workspaceId: "wks_a", ...canonicalOwner };
    owners.registerWorkspace({ id: "wks_a", ...canonicalOwner });
    owners.registerAgent(row);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    expect(authorization.prefilterAgentContentRows(ctx, [row])).toEqual([]);
  });

  test("prefilter rejects missing and malformed minimal rows", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    const invalidRows = [
      { id: "agent_a", workspaceId: "wks_a" },
      { ...agentContentRow, organizationId: "malformed" },
      { ...agentContentRow, id: "missing" },
    ] as unknown as readonly EnterpriseAgentContentAuthorizationRow[];

    expect(authorization.prefilterAgentContentRows(ctx, invalidRows)).toEqual([]);
  });

  test("prefilter fails closed for false, throwing, and post-call stale guards", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const withGuard = (grantVersionGuard: { isCurrent(ctx: PrincipalContext): boolean }) =>
      new ResourceAuthorizationService({
        owners,
        nodeId: owner.nodeId,
        grantVersionGuard,
      });

    expect(
      withGuard({ isCurrent: () => false }).prefilterAgentContentRows(ctx, [agentContentRow]),
    ).toEqual([]);
    expect(
      withGuard({
        isCurrent: () => {
          throw new Error("guard unavailable");
        },
      }).prefilterAgentContentRows(ctx, [agentContentRow]),
    ).toEqual([]);
    let checks = 0;
    expect(
      withGuard({ isCurrent: () => ++checks === 1 }).prefilterAgentContentRows(ctx, [
        agentContentRow,
      ]),
    ).toEqual([]);
    expect(checks).toBe(2);
  });

  test("prefilter rechecks canonical ownership instead of caching a shortlist", () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent(agentContentRow);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    expect(authorization.prefilterAgentContentRows(ctx, [agentContentRow])).toEqual([
      agentContentRow,
    ]);

    const reboundOwner = {
      ...owner,
      ownerPrincipalId: "usr_ffffffffffffffff",
      createdByPrincipalId: "usr_ffffffffffffffff",
    } as const;
    owners.registerWorkspace({ id: workspaceRecord.id, ...reboundOwner });
    owners.registerAgent({ ...agentContentRow, ...reboundOwner });

    expect(authorization.prefilterAgentContentRows(ctx, [agentContentRow])).toEqual([]);
  });

  test("permits only an exact empty organization projection with empty resource context", async () => {
    const authorization = new ResourceAuthorizationService({
      owners: new OwnerRegistry(),
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    const empty = {
      type: "enterprise.organization.list_resources.response" as const,
      payload: {
        requestId: "empty",
        principals: [],
        resources: [],
        nextCursor: null,
      },
    };

    await expect(
      authorization.canEmit(ctx, empty, { kind: "resources", resources: [] }),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(
        ctx,
        { ...empty, payload: { ...empty.payload, nextCursor: "leaky-cursor" } },
        { kind: "resources", resources: [] },
      ),
    ).resolves.toBe(false);
    await expect(
      authorization.canEmit(
        ctx,
        {
          ...empty,
          payload: {
            ...empty.payload,
            principals: [{ principalId: ctx.principalId, status: "active" }],
          },
        },
        { kind: "resources", resources: [] },
      ),
    ).resolves.toBe(false);
  });

  test("asserts resources and filters rows without making foreign ids enumerable", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a" });
    owners.registerWorkspace({ id: "wks_b" });
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a" });

    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    await expect(
      authorization.assertWorkspace(ctx, "workspace.metadata.read", "wks_a"),
    ).resolves.toEqual({
      workspaceId: "wks_a",
      ...owner,
    });
    await expect(
      authorization.assertAgent(ctx, "workspace.content.read", "agent_a"),
    ).resolves.toEqual({
      agentId: "agent_a",
      workspaceId: "wks_a",
      ...owner,
    });
    await expect(authorization.assertAgent(ctx, "browser.use", "agent_a")).resolves.toEqual({
      agentId: "agent_a",
      workspaceId: "wks_a",
      ...owner,
    });
    await expect(authorization.assertAgent(ctx, "app.use", "agent_a")).rejects.toBeInstanceOf(
      ResourceAuthorizationError,
    );
    expect(
      authorization.filterWorkspaces(ctx, [workspaceRecord, { id: "wks_a" }, { id: "wks_b" }]),
    ).toEqual([workspaceRecord]);
    await expect(
      authorization.assertWorkspace(ctx, "workspace.metadata.read", "wks_b"),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("asserts browser and app resources only through typed registries", async () => {
    const owners = new OwnerRegistry();
    const profile: BrowserProfileRecord = {
      browserProfileId: "brp_0123456789abcdef",
      organizationId: owner.organizationId,
      homeNodeId: owner.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      ownerPrincipalId: owner.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: "account",
      label: "Test",
      partitionKey: "persist:test",
      downloadRoot: "/tmp/downloads",
      status: "ready",
    };
    const slot: AppSlotRecord = {
      appSlotId: "aps_0123456789abcdef",
      organizationId: owner.organizationId,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
      appBundleId: "com.example.app",
      accountBindingKey: "account",
      concurrency: 1,
      status: "ready",
    };
    const authorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: new MemoryBrowserProfiles([profile]),
      appSlots: new MemoryAppSlots([slot]),
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    await expect(
      authorization.assertBrowserProfile(ctx, "browser.use", profile.browserProfileId),
    ).resolves.toEqual(profile);
    await expect(
      authorization.assertAppSlot(ctx, "app.use", slot.appSlotId),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("blocks path traversal and only emits authorized resources or matching transport control", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const authorization = new ResourceAuthorizationService({
      owners,
      workspacePaths: new MemoryWorkspacePaths(),
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    await expect(authorization.resolveWorkspacePath(ctx, "wks_a", "src/index.ts")).resolves.toBe(
      "/tmp/paseo-workspace/src/index.ts",
    );
    await expect(
      authorization.resolveWorkspacePath(ctx, "wks_a", "../secrets.txt"),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
    await expect(
      authorization.canEmit(ctx, outbound("agent_update"), {
        kind: "resources",
        resources: [
          {
            organizationId: owner.organizationId,
            nodeId: owner.nodeId,
            resourceKind: "workspace",
            localResourceId: "wks_a",
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(ctx, outbound("agent_update"), {
        kind: "resources",
        resources: [
          {
            organizationId: owner.organizationId,
            nodeId: owner.nodeId,
            resourceKind: "workspace",
            localResourceId: "wks_unknown",
          },
        ],
      }),
    ).resolves.toBe(false);
    await expect(
      authorization.canEmit(ctx, outbound("pong"), { kind: "transport_control", control: "pong" }),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(
        ctx,
        {
          type: "status",
          payload: { status: "server_info", serverId: "srv_test" },
        } as SessionOutboundMessage,
        { kind: "transport_control", control: "server_info" },
      ),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(ctx, outbound("status"), {
        kind: "transport_control",
        control: "pong",
      }),
    ).resolves.toBe(false);
  });

  test("does not emit agent content to metadata-only principals", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const metadataOnly: PrincipalContext = {
      ...ctx,
      grants: [{ action: "workspace.metadata.read", selector: { kind: "self" } }],
    };
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    await expect(
      authorization.canEmit(metadataOnly, outbound("agent_stream"), {
        kind: "resources",
        resources: [
          {
            organizationId: owner.organizationId,
            nodeId: owner.nodeId,
            resourceKind: "workspace",
            localResourceId: "wks_a",
          },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("rejects stale grant snapshots across every authorization entry", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: { isCurrent: (value) => value.grantVersion === "grv_current" },
    });
    const stale = { ...ctx, grantVersion: "grv_old" };
    expect(authorization.filterWorkspaces(stale, [workspaceRecord])).toEqual([]);
    await expect(
      authorization.assertWorkspace(stale, "workspace.metadata.read", "wks_a"),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
    await expect(
      authorization.assertAgent(stale, "workspace.metadata.read", "agent_a"),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
    await expect(
      authorization.canEmit(stale, outbound("agent_update"), { kind: "resources", resources: [] }),
    ).resolves.toBe(false);
  });

  test("rechecks an Agent against the current canonical Workspace owner", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    owners.registerAgent({ id: "agent_a", workspaceId: "wks_a", ...owner });
    owners.registerWorkspace({
      ...workspaceRecord,
      ownerPrincipalId: "usr_fedcba9876543210",
      createdByPrincipalId: "usr_fedcba9876543210",
    });
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });

    await expect(
      authorization.assertAgent(ctx, "workspace.metadata.read", "agent_a"),
    ).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("does not use a Browser Profile reference to authorize unrelated events", async () => {
    const owners = new OwnerRegistry();
    const profile: BrowserProfileRecord = {
      browserProfileId: "brp_0123456789abcdef",
      organizationId: owner.organizationId,
      homeNodeId: owner.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      ownerPrincipalId: owner.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: "account",
      label: "Test",
      partitionKey: "persist:test",
      downloadRoot: "/tmp/downloads",
      status: "ready",
    };
    const authorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: new MemoryBrowserProfiles([profile]),
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    const context = {
      kind: "resources",
      resources: [
        {
          organizationId: owner.organizationId,
          nodeId: owner.nodeId,
          resourceKind: "browser_profile",
          localResourceId: profile.browserProfileId,
        },
      ],
    } as const;

    await expect(
      authorization.canEmit(ctx, outbound("get_daemon_config_response"), context),
    ).resolves.toBe(false);
    await expect(
      authorization.canEmit(ctx, outbound("enterprise.browser.bind_profile.response"), context),
    ).resolves.toBe(false);
    await expect(
      authorization.canEmit(ctx, outbound("browser.automation.execute.request"), context),
    ).resolves.toBe(true);
  });

  test("fails closed for uncorrelated errors and non-Agent status envelopes", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    const context = {
      kind: "resources",
      resources: [
        {
          organizationId: owner.organizationId,
          nodeId: owner.nodeId,
          resourceKind: "workspace",
          localResourceId: "wks_a",
        },
      ],
    } as const;

    await expect(
      authorization.canEmit(
        ctx,
        { type: "rpc_error", payload: { requestId: "req", error: "redacted" } },
        context,
      ),
    ).resolves.toBe(false);
    await expect(
      authorization.canEmit(
        ctx,
        {
          type: "rpc_error",
          payload: {
            requestId: "req",
            requestType: "fetch_agent_request",
            error: "redacted",
          },
        },
        context,
      ),
    ).resolves.toBe(true);
    await expect(
      authorization.canEmit(
        ctx,
        {
          type: "status",
          payload: { status: "shutdown_requested", clientId: "client", requestId: "req" },
        },
        context,
      ),
    ).resolves.toBe(false);
  });

  test("uses organization metadata grants or a verified Workspace binding for profile inventory", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const profile: BrowserProfileRecord = {
      browserProfileId: "brp_0123456789abcdef",
      organizationId: owner.organizationId,
      homeNodeId: owner.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      ownerPrincipalId: owner.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: "account",
      label: "Test",
      partitionKey: "persist:test",
      downloadRoot: "/tmp/downloads",
      status: "ready",
    };
    const authorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: new MemoryBrowserProfiles([profile]),
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
    });
    const profileRef = {
      organizationId: owner.organizationId,
      nodeId: owner.nodeId,
      resourceKind: "browser_profile",
      localResourceId: profile.browserProfileId,
    } as const;
    const projection = {
      resourceKind: "browser_profile" as const,
      organizationId: owner.organizationId,
      nodeId: owner.nodeId,
      browserProfileId: profile.browserProfileId,
      ownerPrincipalId: owner.ownerPrincipalId,
      label: "Test",
      status: "ready",
      occupancy: "idle",
    };
    const event = {
      type: "enterprise.organization.list_resources.response" as const,
      payload: { requestId: "req", principals: [], resources: [projection], nextCursor: null },
    };

    await expect(
      authorization.canEmit(ctx, event, { kind: "resources", resources: [profileRef] }),
    ).resolves.toBe(false);

    const organizationReader: PrincipalContext = {
      ...ctx,
      grants: [
        {
          action: "workspace.metadata.read",
          selector: { kind: "organization", organizationId: owner.organizationId },
        },
      ],
    };
    await expect(
      authorization.canEmit(organizationReader, event, {
        kind: "resources",
        resources: [profileRef],
      }),
    ).resolves.toBe(true);

    await expect(
      authorization.canEmit(
        ctx,
        {
          ...event,
          payload: {
            ...event.payload,
            resources: [{ ...projection, workspaceId: "wks_a" }],
          },
        },
        {
          kind: "resources",
          resources: [
            profileRef,
            {
              organizationId: owner.organizationId,
              nodeId: owner.nodeId,
              resourceKind: "workspace",
              localResourceId: "wks_a",
            },
          ],
        },
      ),
    ).resolves.toBe(true);
  });

  test("rejects a Browser Profile when the Grant is revoked during registry lookup", async () => {
    const owners = new OwnerRegistry();
    const profile: BrowserProfileRecord = {
      browserProfileId: "brp_0123456789abcdef",
      organizationId: owner.organizationId,
      homeNodeId: owner.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      ownerPrincipalId: owner.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: "account",
      label: "Test",
      partitionKey: "persist:test",
      downloadRoot: "/tmp/downloads",
      status: "ready",
    };
    const lookup = deferred<BrowserProfileRecord | null>();
    const current = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: { get: () => lookup.promise },
      nodeId: owner.nodeId,
      grantVersionGuard: current.guard,
    });

    const pending = authorization.assertBrowserProfile(
      ctx,
      "browser.use",
      profile.browserProfileId,
    );
    current.revoke();
    lookup.resolve(profile);

    await expect(pending).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("rejects an App Slot when the Grant is revoked during registry lookup", async () => {
    const owners = new OwnerRegistry();
    const slot: AppSlotRecord = {
      appSlotId: "aps_0123456789abcdef",
      organizationId: owner.organizationId,
      nodeId: owner.nodeId,
      grantVersionGuard: guard,
      appBundleId: "com.example.app",
      accountBindingKey: "account",
      ownerPrincipalId: owner.ownerPrincipalId,
      concurrency: 1,
      status: "ready",
    };
    const appCtx: PrincipalContext = {
      ...ctx,
      grants: [...ctx.grants, { action: "app.use", selector: { kind: "self" } }],
    };
    const lookup = deferred<AppSlotRecord | null>();
    const current = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      appSlots: { get: () => lookup.promise },
      nodeId: owner.nodeId,
      grantVersionGuard: current.guard,
    });

    const pending = authorization.assertAppSlot(appCtx, "app.use", slot.appSlotId);
    current.revoke();
    lookup.resolve(slot);

    await expect(pending).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("rejects a Workspace path when the Grant is revoked during path resolution", async () => {
    const owners = new OwnerRegistry();
    owners.registerWorkspace(workspaceRecord);
    const lookupStarted = deferred<void>();
    const lookup = deferred<string | null>();
    const current = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      workspacePaths: {
        resolve: () => {
          lookupStarted.resolve();
          return lookup.promise;
        },
      },
      nodeId: owner.nodeId,
      grantVersionGuard: current.guard,
    });

    const pending = authorization.resolveWorkspacePath(ctx, "wks_a", "src/index.ts");
    await lookupStarted.promise;
    current.revoke();
    lookup.resolve("/tmp/paseo-workspace/src/index.ts");

    await expect(pending).rejects.toBeInstanceOf(ResourceAuthorizationError);
  });

  test("does not emit authority output when the Grant is revoked during verification", async () => {
    const owners = new OwnerRegistry();
    const verified = deferred<boolean>();
    const current = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      authorityVerifier: { verify: () => verified.promise },
      nodeId: owner.nodeId,
      grantVersionGuard: current.guard,
    });
    const pending = authorization.canEmit(
      ctx,
      {
        type: "enterprise.identity.credential_revoked",
        payload: { revokedAt: "2026-09-10T00:00:00.000Z" },
      },
      {
        kind: "authority",
        authority: {
          kind: "identity_self",
          sessionBindingKey: "binding",
          sessionBindingGeneration: "generation",
          message: { type: "enterprise.identity.credential_revoked" },
        },
      },
    );
    current.revoke();
    verified.resolve(true);

    await expect(pending).resolves.toBe(false);
  });

  test("does not emit resource output when the Grant is revoked during registry lookup", async () => {
    const owners = new OwnerRegistry();
    const profile: BrowserProfileRecord = {
      browserProfileId: "brp_0123456789abcdef",
      organizationId: owner.organizationId,
      homeNodeId: owner.nodeId,
      businessIdentityId: "bid_0123456789abcdef",
      ownerPrincipalId: owner.ownerPrincipalId,
      platform: "generic",
      businessAccountKey: "account",
      label: "Test",
      partitionKey: "persist:test",
      downloadRoot: "/tmp/downloads",
      status: "ready",
    };
    const lookup = deferred<BrowserProfileRecord | null>();
    const current = revocableGuard();
    const authorization = new ResourceAuthorizationService({
      owners,
      browserProfiles: { get: () => lookup.promise },
      nodeId: owner.nodeId,
      grantVersionGuard: current.guard,
    });
    const pending = authorization.canEmit(ctx, outbound("browser.automation.execute.request"), {
      kind: "resources",
      resources: [
        {
          organizationId: owner.organizationId,
          nodeId: owner.nodeId,
          resourceKind: "browser_profile",
          localResourceId: profile.browserProfileId,
        },
      ],
    });
    current.revoke();
    lookup.resolve(profile);

    await expect(pending).resolves.toBe(false);
  });

  test("converts Grant guard failures into fixed fail-closed results", async () => {
    const owners = new OwnerRegistry();
    const authorization = new ResourceAuthorizationService({
      owners,
      nodeId: owner.nodeId,
      grantVersionGuard: {
        isCurrent: () => {
          throw new Error("guard unavailable");
        },
      },
    });
    const fixedError = {
      name: "ResourceAuthorizationError",
      code: "resource_not_visible",
      message: "Resource unavailable",
    };

    expect(authorization.filterWorkspaces(ctx, [workspaceRecord])).toEqual([]);
    await expect(
      authorization.assertWorkspace(ctx, "workspace.metadata.read", "wks_a"),
    ).rejects.toMatchObject(fixedError);
    await expect(
      authorization.assertAgent(ctx, "workspace.metadata.read", "agent_a"),
    ).rejects.toMatchObject(fixedError);
    await expect(
      authorization.assertBrowserProfile(ctx, "browser.use", "brp_0123456789abcdef"),
    ).rejects.toMatchObject(fixedError);
    await expect(
      authorization.assertAppSlot(ctx, "app.use", "aps_0123456789abcdef"),
    ).rejects.toMatchObject(fixedError);
    await expect(
      authorization.resolveWorkspacePath(ctx, "wks_a", "src/index.ts"),
    ).rejects.toMatchObject(fixedError);
    await expect(
      authorization.canEmit(ctx, outbound("pong"), {
        kind: "transport_control",
        control: "pong",
      }),
    ).resolves.toBe(false);
  });
});
