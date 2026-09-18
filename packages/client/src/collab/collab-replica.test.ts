import { describe, expect, test } from "vitest";

import { CollabReplica, type CollabReplicaScope } from "./collab-replica.js";

const SCOPE: CollabReplicaScope = {
  organizationId: "org_1111111111111111",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  workspaceUid: "cws_0123456789abcdef",
};

const OTHER: CollabReplicaScope = {
  ...SCOPE,
  principalId: "usr_bbbbbbbbbbbbbbbb",
};

describe("collab replica", () => {
  test("keeps two Principals' copies of the same Workspace apart", () => {
    const replica = new CollabReplica();
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "owner" }]);
    replica.replaceMembers(OTHER, [{ principalId: OTHER.principalId, role: "editor" }]);

    expect(replica.snapshot(SCOPE)?.members).toEqual([
      { principalId: SCOPE.principalId, role: "owner" },
    ]);
    expect(replica.snapshot(OTHER)?.members).toEqual([
      { principalId: OTHER.principalId, role: "editor" },
    ]);
  });

  test("a revoke drops members, presence, and stored segments", () => {
    const replica = new CollabReplica();
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "editor" }]);
    replica.apply(SCOPE, {
      type: "presence",
      containerId: SCOPE.workspaceUid,
      entries: [
        {
          kind: "principal",
          principalId: SCOPE.principalId,
          clientId: "client-1",
          focusAgentId: null,
          heartbeatAt: "2026-09-17T00:00:00.000Z",
        },
      ],
    });
    replica.apply(SCOPE, {
      type: "data",
      containerId: SCOPE.workspaceUid,
      segment: "s:agent-1",
      offset: "00000000000000000001",
      update: "row",
    });

    replica.apply(SCOPE, {
      type: "revoked",
      containerId: SCOPE.workspaceUid,
      reason: "membership_removed",
    });

    const snapshot = replica.snapshot(SCOPE);
    expect(snapshot?.revoked).toBe(true);
    expect(snapshot?.revokeReason).toBe("membership_removed");
    expect(snapshot?.members).toEqual([]);
    expect(snapshot?.presence).toEqual([]);
    expect(snapshot?.segments).toEqual({});
  });

  test("events after a revoke do not rebuild the copy", () => {
    const replica = new CollabReplica();
    replica.apply(SCOPE, {
      type: "revoked",
      containerId: SCOPE.workspaceUid,
      reason: "membership_removed",
    });
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "editor" }]);
    replica.apply(SCOPE, {
      type: "data",
      containerId: SCOPE.workspaceUid,
      segment: "meta",
      offset: "00000000000000000002",
      update: "secret",
    });

    expect(replica.snapshot(SCOPE)?.members).toEqual([]);
    expect(replica.snapshot(SCOPE)?.segments).toEqual({});
  });

  test("logout drops every Workspace for that Principal and leaves the other", () => {
    const replica = new CollabReplica();
    replica.replaceMembers(SCOPE, [{ principalId: SCOPE.principalId, role: "owner" }]);
    replica.replaceMembers(OTHER, [{ principalId: OTHER.principalId, role: "viewer" }]);

    replica.clearPrincipal(SCOPE.organizationId, SCOPE.principalId);

    expect(replica.snapshot(SCOPE)).toBeNull();
    expect(replica.snapshot(OTHER)?.members).toHaveLength(1);
  });
});
