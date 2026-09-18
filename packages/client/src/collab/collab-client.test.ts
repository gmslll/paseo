import { describe, expect, test } from "vitest";

import { CollabClient } from "./collab-client.js";
import { CollabReplica, type CollabReplicaScope } from "./collab-replica.js";
import type { WorkspaceMember } from "@getpaseo/protocol/enterprise-collaboration";

const SCOPE: CollabReplicaScope = {
  organizationId: "org_1111111111111111",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  workspaceUid: "cws_0123456789abcdef",
};

describe("collab client", () => {
  test("share refreshes members from the plane", async () => {
    const members: WorkspaceMember[] = [{ principalId: SCOPE.principalId, role: "owner" }];
    const replica = new CollabReplica();
    const client = new CollabClient(
      replica,
      {
        list: async () => members,
        upsert: async (_workspaceUid, principalId, role) => {
          members.push({ principalId, role });
        },
        remove: async () => undefined,
      },
      { beat: async () => [] },
    );

    await client.share(SCOPE, "usr_bbbbbbbbbbbbbbbb", "editor");

    expect(replica.snapshot(SCOPE)?.members).toEqual([
      { principalId: SCOPE.principalId, role: "owner" },
      { principalId: "usr_bbbbbbbbbbbbbbbb", role: "editor" },
    ]);
  });

  test("a revoke event clears the replica and further shares fail", async () => {
    const replica = new CollabReplica();
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "editor" }]);
    const client = new CollabClient(
      replica,
      {
        list: async () => [{ principalId: SCOPE.principalId, role: "editor" }],
        upsert: async () => undefined,
        remove: async () => undefined,
      },
      { beat: async () => [] },
    );

    client.handleRevoked(SCOPE, "membership_removed");

    expect(replica.snapshot(SCOPE)?.revoked).toBe(true);
    await expect(client.share(SCOPE, "usr_bbbbbbbbbbbbbbbb", "viewer")).rejects.toThrow(/revoked/);
  });

  test("logout forgets every Workspace for that Principal", async () => {
    const replica = new CollabReplica();
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "owner" }]);
    const client = new CollabClient(
      replica,
      {
        list: async () => [],
        upsert: async () => undefined,
        remove: async () => undefined,
      },
      { beat: async () => [] },
    );

    client.logout(SCOPE.organizationId, SCOPE.principalId);

    expect(replica.snapshot(SCOPE)).toBeNull();
  });
});
