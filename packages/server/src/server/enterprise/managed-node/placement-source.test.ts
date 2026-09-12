import { describe, expect, test } from "vitest";

import { createManagedPlacementSnapshotSource } from "./placement-source.js";

const ORGANIZATION_ID = "org_0123456789abcdef";
const NODE_ID = "nod_0123456789abcdef";
const OWNER_ID = "usr_0123456789abcdef";

describe("managed placement snapshot source", () => {
  test("pages canonical Workspace and Agent resources and adds Browser Profiles", async () => {
    const cursors: Array<string | undefined> = [];
    const organizationResources = {
      async list(input: { readonly cursor?: string }) {
        cursors.push(input.cursor);
        if (!input.cursor) {
          return {
            principals: [],
            resources: [workspaceProjection()],
            nextCursor: "workspace-a",
          };
        }
        return { principals: [], resources: [agentProjection()], nextCursor: null };
      },
    };
    const source = createManagedPlacementSnapshotSource({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      organizationResources: organizationResources as never,
      browserProfiles: {
        list: async () => [
          {
            browserProfileId: "brp_0123456789abcdef",
            organizationId: ORGANIZATION_ID,
            homeNodeId: NODE_ID,
            businessIdentityId: "bid_0123456789abcdef",
            ownerPrincipalId: OWNER_ID,
            platform: "generic",
            businessAccountKey: "account-a",
            label: "Browser A",
            partitionKey: "persist:a",
            downloadRoot: "/tmp/a",
            status: "ready",
            createdAt: "2026-09-12T00:00:00.000Z",
            updatedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
      } as never,
    });

    await expect(source()).resolves.toEqual([
      {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "agent",
          localResourceId: "agent-a",
        },
        ownerPrincipalId: OWNER_ID,
      },
      {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "browser_profile",
          localResourceId: "brp_0123456789abcdef",
        },
        ownerPrincipalId: OWNER_ID,
      },
      {
        resource: {
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          resourceKind: "workspace",
          localResourceId: "workspace-a",
        },
        ownerPrincipalId: OWNER_ID,
      },
    ]);
    expect(cursors).toEqual([undefined, "workspace-a"]);
  });

  test("rejects a foreign or non-advancing snapshot", async () => {
    const source = createManagedPlacementSnapshotSource({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      organizationResources: {
        list: async () => ({
          principals: [],
          resources: [{ ...workspaceProjection(), nodeId: "nod_abcdef0123456789" }],
          nextCursor: null,
        }),
      } as never,
      browserProfiles: { list: async () => [] } as never,
    });
    await expect(source()).rejects.toThrow("foreign resource");

    const stalled = createManagedPlacementSnapshotSource({
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      organizationResources: {
        list: async () => ({ principals: [], resources: [], nextCursor: "same" }),
      } as never,
      browserProfiles: { list: async () => [] } as never,
    });
    await expect(stalled()).rejects.toThrow("cursor did not advance");
  });
});

function workspaceProjection() {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    resourceKind: "workspace" as const,
    workspaceId: "workspace-a",
    ownerPrincipalId: OWNER_ID,
    label: "Workspace A",
    status: "ready",
    updatedAt: "2026-09-12T00:00:00.000Z",
  };
}

function agentProjection() {
  return {
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    resourceKind: "agent" as const,
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerPrincipalId: OWNER_ID,
    label: "Agent A",
    status: "ready",
    provider: "codex",
    model: null,
    startedAt: "2026-09-12T00:00:00.000Z",
    lastActivityAt: "2026-09-12T00:00:00.000Z",
    durationMs: 0,
  };
}
