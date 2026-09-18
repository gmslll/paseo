import { describe, expect, test } from "vitest";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";
import { ManagementPlaneRequestError } from "../management-client.js";
import {
  COLLAB_SUBSCRIPTION_UNAVAILABLE,
  createCollabSubscriptionControl,
} from "./subscription-control.js";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const WORKSPACE_UID = "cws_0123456789abcdef";

function catalog(): WorkspaceCatalog {
  return {
    version: 1,
    nodeId: "nod_0123456789abcdef",
    organizationId: "org_1111111111111111",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    workspaces: [
      {
        workspaceUid: WORKSPACE_UID,
        localWorkspaceId: "ws-1",
        ownerPrincipalId: OWNER,
        members: [{ principalId: OWNER, role: "owner" }],
        state: "active",
        cachedAt: "2026-09-17T00:00:00.000Z",
        remoteMissingAt: null,
      },
    ],
  };
}

describe("collab subscription control", () => {
  test("opens a subscription and returns plane events", async () => {
    const control = createCollabSubscriptionControl({
      catalog: { current: () => catalog() },
      async issue() {
        return { token: "pst_v1.token", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async open(token, containerId) {
        expect(token).toBe("pst_v1.token");
        expect(containerId).toBe(WORKSPACE_UID);
        return { subscriptionId: "sub_0123456789abcdef" };
      },
      async read(token, subscriptionId) {
        expect(token).toBe("pst_v1.token");
        expect(subscriptionId).toBe("sub_0123456789abcdef");
        return {
          events: [{ type: "revoked", containerId: WORKSPACE_UID, reason: "membership_removed" }],
        };
      },
    });

    expect(
      await control.poll({
        workspaceId: "ws-1",
        actorPrincipalId: OWNER,
        clientId: "client-1",
      }),
    ).toEqual({
      subscriptionId: "sub_0123456789abcdef",
      events: [{ type: "revoked", containerId: WORKSPACE_UID, reason: "membership_removed" }],
    });
  });

  test("reopens after the plane refuses the cached subscription", async () => {
    let opens = 0;
    const control = createCollabSubscriptionControl({
      catalog: { current: () => catalog() },
      async issue() {
        return { token: "pst_v1.token", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      async open() {
        opens += 1;
        return { subscriptionId: "sub_aaaaaaaaaaaaaaaa" };
      },
      async read(_token, subscriptionId) {
        if (subscriptionId === "sub_old_expired_____") {
          throw new ManagementPlaneRequestError(403, "forbidden", "stream authorization denied");
        }
        return { events: [] };
      },
    });

    expect(
      await control.poll({
        workspaceId: "ws-1",
        actorPrincipalId: OWNER,
        clientId: "client-1",
        subscriptionId: "sub_old_expired_____",
      }),
    ).toEqual({ subscriptionId: "sub_aaaaaaaaaaaaaaaa", events: [] });
    expect(opens).toBe(1);
  });

  test("an unknown Workspace cannot subscribe", async () => {
    const control = createCollabSubscriptionControl({
      catalog: { current: () => catalog() },
      async issue() {
        throw new Error("should not issue");
      },
      async open() {
        throw new Error("should not open");
      },
      async read() {
        throw new Error("should not read");
      },
    });

    await expect(
      control.poll({
        workspaceId: "missing",
        actorPrincipalId: OWNER,
        clientId: "client-1",
      }),
    ).rejects.toThrow(COLLAB_SUBSCRIPTION_UNAVAILABLE);
  });
});
