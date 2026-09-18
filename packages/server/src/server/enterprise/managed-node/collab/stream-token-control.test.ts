import { describe, expect, test } from "vitest";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";
import {
  COLLAB_STREAM_TOKEN_UNAVAILABLE,
  createCollabStreamTokenControl,
} from "./stream-token-control.js";

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

describe("collab stream token control", () => {
  test("issues a token for a member of an active Workspace", async () => {
    const control = createCollabStreamTokenControl({
      catalog: { current: () => catalog() },
      managementBaseUrl: "https://management.test:17443",
      async issue(change) {
        expect(change.workspaceUid).toBe(WORKSPACE_UID);
        expect(change.actorPrincipalId).toBe(OWNER);
        expect(change.clientId).toBe("client-1");
        return { token: "pst_v1.token", expiresAt: "2026-09-18T00:05:00.000Z" };
      },
    });

    expect(
      await control.issue({
        workspaceId: "ws-1",
        actorPrincipalId: OWNER,
        clientId: "client-1",
      }),
    ).toEqual({
      token: "pst_v1.token",
      expiresAt: "2026-09-18T00:05:00.000Z",
      managementBaseUrl: "https://management.test:17443",
    });
  });

  test("an unknown Workspace cannot mint a stream token", async () => {
    const control = createCollabStreamTokenControl({
      catalog: { current: () => catalog() },
      managementBaseUrl: "https://management.test:17443",
      async issue() {
        throw new Error("should not issue");
      },
    });

    await expect(
      control.issue({
        workspaceId: "missing",
        actorPrincipalId: OWNER,
        clientId: "client-1",
      }),
    ).rejects.toThrow(COLLAB_STREAM_TOKEN_UNAVAILABLE);
  });
});
