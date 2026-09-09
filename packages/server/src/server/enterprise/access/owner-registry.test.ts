import { describe, expect, test } from "vitest";

import type {
  EnterpriseAgentAuthorizationRecord,
  EnterpriseWorkspaceAuthorizationRecord,
} from "./owner-registry.js";
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

  test("derives a legacy Agent owner from its canonical Workspace", () => {
    const registry = new OwnerRegistry();
    registry.registerWorkspace(workspace("wks_owned"));

    registry.registerAgent({ id: "agent_legacy", workspaceId: "wks_owned" });

    expect(registry.getAgent("agent_legacy")).toEqual({
      agentId: "agent_legacy",
      workspaceId: "wks_owned",
      ...owner,
    });
  });

  test.each([
    ["agent_missing_workspace", { id: "agent_missing_workspace" }, "missing_workspace"],
    ["agent_orphan", { id: "agent_orphan", workspaceId: "wks_unknown" }, "workspace_unavailable"],
    [
      "agent_partial_one",
      { id: "agent_partial", workspaceId: "wks_owned", organizationId: owner.organizationId },
      "partial_owner",
    ],
    [
      "agent_partial_two",
      {
        id: "agent_partial_two",
        workspaceId: "wks_owned",
        organizationId: owner.organizationId,
        nodeId: owner.nodeId,
      },
      "partial_owner",
    ],
    [
      "agent_partial_three",
      {
        id: "agent_partial_three",
        workspaceId: "wks_owned",
        organizationId: owner.organizationId,
        nodeId: owner.nodeId,
        ownerPrincipalId: owner.ownerPrincipalId,
      },
      "partial_owner",
    ],
    [
      "agent_mismatch",
      {
        id: "agent_mismatch",
        workspaceId: "wks_owned",
        organizationId: owner.organizationId,
        nodeId: owner.nodeId,
        ownerPrincipalId: "usr_fedcba9876543210",
        createdByPrincipalId: owner.createdByPrincipalId,
      },
      "owner_mismatch",
    ],
  ] satisfies readonly [
    string,
    EnterpriseAgentAuthorizationRecord,
    string,
  ][][] as readonly (readonly [string, EnterpriseAgentAuthorizationRecord, string])[])(
    "quarantines Agent row %s instead of trusting its owner",
    (_name, record, reason) => {
      const registry = new OwnerRegistry();
      registry.registerWorkspace(workspace("wks_owned"));

      registry.registerAgent(record);

      expect(registry.getAgent(record.id)).toBeNull();
      expect(registry.quarantined()).toContainEqual({ kind: "agent", id: record.id, reason });
    },
  );

  test("quarantines an Agent whose Workspace is itself quarantined", () => {
    const registry = new OwnerRegistry();
    registry.registerWorkspace(
      workspace("wks_quarantined", {
        organizationId: owner.organizationId,
        nodeId: owner.nodeId,
      }),
    );
    registry.registerAgent({ id: "agent_quarantined_workspace", workspaceId: "wks_quarantined" });

    expect(registry.getAgent("agent_quarantined_workspace")).toBeNull();
    expect(registry.quarantined()).toContainEqual({
      kind: "agent",
      id: "agent_quarantined_workspace",
      reason: "workspace_unavailable",
    });
  });

  test("accepts a complete Agent envelope only when it matches the Workspace", () => {
    const registry = new OwnerRegistry();
    registry.registerWorkspace(workspace("wks_owned"));
    registry.registerAgent({ id: "agent_owned", workspaceId: "wks_owned", ...owner });

    expect(registry.getAgent("agent_owned")).toEqual({
      agentId: "agent_owned",
      workspaceId: "wks_owned",
      ...owner,
    });
  });

  test("quarantines cached Agents when canonical Workspace ownership changes", () => {
    const registry = new OwnerRegistry();
    registry.registerWorkspace(workspace("wks_owned"));
    registry.registerAgent({ id: "agent_owned", workspaceId: "wks_owned", ...owner });

    registry.registerWorkspace({
      id: "wks_owned",
      ...owner,
      ownerPrincipalId: "usr_fedcba9876543210",
      createdByPrincipalId: "usr_fedcba9876543210",
    });

    expect(registry.getAgent("agent_owned")).toBeNull();
    expect(registry.quarantined()).toContainEqual({
      kind: "agent",
      id: "agent_owned",
      reason: "owner_mismatch",
    });
  });
});
