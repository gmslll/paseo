import { describe, expect, test } from "vitest";

import { WSOutboundMessageSchema as GeneratedWSOutboundMessageSchema } from "../../src/generated/validation/ws-outbound.aot.js";

const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_2222222222222222";
const OWNER_ID = "usr_3333333333333333";
const CREATOR_ID = "usr_4444444444444444";
const BROWSER_PROFILE_ID = "brp_5555555555555555";
const ENTERPRISE_CONTEXT = {
  browserProfileId: BROWSER_PROFILE_ID,
  nodeId: NODE_ID,
  leaseId: "lea_11111111-1111-1111-1111-111111111111",
  fencingToken: 7,
  leaseRevision: "revision-7",
} as const;

function envelope(message: unknown) {
  return { type: "session", message };
}

const enterpriseResponses = [
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
    payload: { requestId: "req-3", principalId: OWNER_ID, grants: [], revision: "revision-1" },
  },
  {
    type: "enterprise.access.update_grants.response",
    payload: { requestId: "req-4", principalId: OWNER_ID, grants: [], revision: "revision-2" },
  },
  {
    type: "enterprise.audit.list_events.response",
    payload: { requestId: "req-5", events: [], nextCursor: null },
  },
  {
    type: "enterprise.browser.list_profiles.response",
    payload: {
      requestId: "req-6",
      profiles: [
        {
          browserProfileId: BROWSER_PROFILE_ID,
          organizationId: ORGANIZATION_ID,
          homeNodeId: NODE_ID,
          ownerPrincipalId: OWNER_ID,
          platform: "taobao",
          label: "Store account",
          status: "ready",
        },
      ],
      bindings: [
        {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          workspaceId: "wks_1",
          browserProfileId: BROWSER_PROFILE_ID,
          boundAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    },
  },
  {
    type: "enterprise.browser.bind_profile.response",
    payload: {
      requestId: "req-7",
      binding: {
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        workspaceId: "wks_1",
        browserProfileId: BROWSER_PROFILE_ID,
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
    payload: {
      requestId: "req-14",
      principals: [{ principalId: OWNER_ID, displayName: "Operator", status: "active" }],
      resources: [
        {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "workspace",
          workspaceId: "wks_1",
          ownerPrincipalId: OWNER_ID,
          label: "Store operations",
          status: "running",
          updatedAt: "2026-09-09T00:01:00.000Z",
        },
        {
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
          resourcePressure: { waitingCount: 0, unavailableCount: 0 },
          resourceStatuses: [],
        },
        {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          browserProfileId: BROWSER_PROFILE_ID,
          ownerPrincipalId: OWNER_ID,
          label: "Store account",
          status: "ready",
          occupancy: "available",
          workspaceId: "wks_1",
        },
        {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "app_slot",
          appSlotId: "aps_7777777777777777",
          label: "Accounting app",
          status: "ready",
          occupancy: "available",
        },
      ],
      nextCursor: null,
    },
  },
  {
    type: "enterprise.identity.logout_all.response",
    payload: { requestId: "req-15", loggedOut: true },
  },
] as const;

describe("generated enterprise outbound validation", () => {
  test("preserves enterprise server_info Feature Flags", () => {
    const message = envelope({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "srv_local",
        features: {
          enterpriseIdentityV1: true,
          enterpriseResourceAuthorizationV1: true,
          enterpriseBrowserProfilesV1: true,
          enterpriseAuditV1: true,
          enterpriseDistributedNodeV1: true,
        },
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(message)).toEqual({
      success: true,
      data: message,
    });
  });

  test("preserves owner fields in Agent and Workspace projections", () => {
    const owner = {
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      ownerPrincipalId: OWNER_ID,
      createdByPrincipalId: CREATOR_ID,
    };
    const agentMessage = envelope({
      type: "agent_status",
      payload: {
        agentId: "agent-1",
        status: "idle",
        info: {
          id: "agent-1",
          provider: "codex",
          cwd: "/workspace",
          ...owner,
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
        },
      },
    });
    const workspaceMessage = envelope({
      type: "fetch_workspaces_response",
      payload: {
        requestId: "req-workspaces",
        entries: [
          {
            id: "wks_1",
            ...owner,
            projectId: "prj_1",
            projectDisplayName: "Project",
            projectRootPath: "/workspace",
            projectKind: "git",
            workspaceKind: "local_checkout",
            name: "main",
            status: "done",
            activityAt: null,
          },
        ],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      },
    });

    for (const message of [agentMessage, workspaceMessage]) {
      const result = GeneratedWSOutboundMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject(message);
    }
  });

  test.each(enterpriseResponses)("accepts generated $type", (message) => {
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(message))).toEqual({
      success: true,
      data: envelope(message),
    });
  });

  test("accepts the enterprise Browser Profile request envelope", () => {
    const message = envelope({
      type: "browser.automation.execute.request",
      requestId: "req-browser",
      workspaceId: "wks_1",
      command: { command: "list_tabs", args: {} },
      enterpriseContext: ENTERPRISE_CONTEXT,
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(message)).toEqual({
      success: true,
      data: message,
    });
  });

  test("accepts opaque upload and Workspace correlation fields", () => {
    const message = envelope({
      type: "file.upload.response",
      payload: {
        requestId: "req-upload",
        uploadId: "upl_opaque_1",
        workspaceId: "wks_1",
        file: {
          type: "uploaded_file",
          id: "legacy-id",
          uploadId: "upl_opaque_1",
          workspaceId: "wks_1",
          fileName: "report.csv",
          mimeType: "text/csv",
          size: 12,
          path: "/legacy/path/report.csv",
        },
        error: null,
      },
    });

    expect(GeneratedWSOutboundMessageSchema.safeParse(message)).toEqual({
      success: true,
      data: message,
    });
  });

  test.each([
    {
      type: "enterprise.resource.status",
      payload: {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          localResourceId: BROWSER_PROFILE_ID,
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
  ])("accepts the generated $type projection event", (message) => {
    expect(GeneratedWSOutboundMessageSchema.safeParse(envelope(message))).toEqual({
      success: true,
      data: envelope(message),
    });
  });

  test.each([
    envelope({
      type: "enterprise.identity.get_current.response",
      payload: {
        requestId: "bad-principal",
        identity: {
          principalId: OWNER_ID,
          organizationId: ORGANIZATION_ID,
          principalType: "human",
          nodeId: NODE_ID,
          paseoServerId: "srv_local",
          navigation: [],
          allowedOperations: [],
        },
      },
    }),
    envelope({
      type: "browser.automation.execute.request",
      requestId: "bad-profile",
      command: { command: "list_tabs", args: {} },
      enterpriseContext: { ...ENTERPRISE_CONTEXT, browserProfileId: "aps_5555555555555555" },
    }),
  ])("rejects an invalid enterprise outbound message", (message) => {
    expect(GeneratedWSOutboundMessageSchema.safeParse(message).success).toBe(false);
  });
});
