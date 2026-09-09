import { describe, expect, test } from "vitest";

import type { EnterpriseWorkspaceAuthorizationRecord } from "@getpaseo/protocol/messages";
import { OwnerRegistry } from "./owner-registry.js";

const owner = {
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  ownerPrincipalId: "usr_0123456789abcdef",
  createdByPrincipalId: "usr_0123456789abcdef",
} as const;

function workspace(
  id: string,
  envelope: Partial<typeof owner> = owner,
): EnterpriseWorkspaceAuthorizationRecord {
  return { id, ...envelope };
}

describe("OwnerRegistry", () => {
  test("registers complete ownership and quarantines legacy or partial rows", () => {
    const registry = new OwnerRegistry();

    registry.registerWorkspace(workspace("wks_owned"));
    registry.registerWorkspace(workspace("wks_legacy", {}));
    registry.registerWorkspace(
      workspace("wks_partial", {
        organizationId: owner.organizationId,
        nodeId: owner.nodeId,
      }),
    );

    expect(registry.getWorkspace("wks_owned")).toEqual({
      workspaceId: "wks_owned",
      ...owner,
    });
    expect(registry.getWorkspace("wks_legacy")).toBeNull();
    expect(registry.getWorkspace("wks_partial")).toBeNull();
    expect(registry.quarantined()).toEqual([
      { kind: "workspace", id: "wks_legacy", reason: "legacy_owner_only" },
      { kind: "workspace", id: "wks_partial", reason: "partial_owner" },
    ]);
  });

  test("does not let a quarantined row be replaced by a partial update", () => {
    const registry = new OwnerRegistry();

    registry.registerWorkspace(
      workspace("wks_partial", { ownerPrincipalId: owner.ownerPrincipalId }),
    );

    expect(registry.getWorkspace("wks_partial")).toBeNull();
    expect(registry.quarantined()).toEqual([
      { kind: "workspace", id: "wks_partial", reason: "partial_owner" },
    ]);
  });
});
