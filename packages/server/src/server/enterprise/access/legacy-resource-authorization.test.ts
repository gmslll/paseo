import { describe, expect, test } from "vitest";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
} from "./production-runtime-test-fixture.js";
import {
  createEnterpriseLegacyResourceAuthorization,
  isEnterpriseLegacyResourceAuthorization,
} from "./legacy-resource-authorization.js";

describe.runIf(process.platform === "darwin")("legacy resource authorization", () => {
  test("binds the real runtime and fails closed after release", async () => {
    const fixture = await createProductionRuntimeFixture("legacy");
    try {
      const authorization = createEnterpriseLegacyResourceAuthorization({
        authorizationRuntime: fixture.runtime,
      });
      expect(authorization).not.toBeNull();
      expect(isEnterpriseLegacyResourceAuthorization(authorization)).toBe(true);
      expect(authorization?.isCurrent()).toBe(true);
      await fixture.runtime.release();
      expect(authorization?.isCurrent()).toBe(false);
      expect(
        await authorization?.assertWorkspace("workspace.metadata.read", "wks_missing"),
      ).toBeNull();
      expect(await authorization?.filterAgents([])).toEqual([]);
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("filters canonical workspace and agent rows", async () => {
    const fixture = await createProductionRuntimeFixture("legacy-filter", {
      grants: [
        {
          action: "workspace.metadata.read",
          selector: { kind: "workspace", workspaceIds: ["wks_0123456789abcdef"] },
        },
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: ["wks_0123456789abcdef"] },
        },
      ],
    });
    try {
      fixture.provider.owners.registerAgent({
        id: "agt_0123456789abcdef",
        organizationId: fixture.context.enterpriseContext.principal.organizationId,
        nodeId: fixture.context.enterpriseContext.node.nodeId,
        ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        workspaceId: "wks_0123456789abcdef",
      });
      const authorization = createEnterpriseLegacyResourceAuthorization({
        authorizationRuntime: fixture.runtime,
      });
      if (!authorization) throw new Error("authorization");
      expect(
        authorization.filterWorkspaces([
          {
            id: "wks_0123456789abcdef",
            organizationId: fixture.context.enterpriseContext.principal.organizationId,
            nodeId: fixture.context.enterpriseContext.node.nodeId,
            ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
            createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
          },
          {
            id: "wks_foreign",
            organizationId: "org_ffffffffffffffff",
            nodeId: fixture.context.enterpriseContext.node.nodeId,
            ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
            createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
          },
          { id: "wks_quarantine" },
        ]),
      ).toHaveLength(1);
      expect(
        await authorization.assertWorkspace("workspace.content.read", "wks_0123456789abcdef"),
      ).not.toBeNull();
      expect(
        await authorization.assertAgent("workspace.content.read", "agt_0123456789abcdef"),
      ).not.toBeNull();
      expect(
        (
          await authorization.filterAgents([
            {
              id: "agt_0123456789abcdef",
              organizationId: fixture.context.enterpriseContext.principal.organizationId,
              nodeId: fixture.context.enterpriseContext.node.nodeId,
              ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
              createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
              workspaceId: "wks_0123456789abcdef",
            },
          ])
        ).length,
      ).toBe(1);
      expect(
        (
          await authorization.filterAgents([
            {
              id: "agt_0123456789abcdef",
              organizationId: "org_ffffffffffffffff",
              nodeId: fixture.context.enterpriseContext.node.nodeId,
              ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
              createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
              workspaceId: "wks_0123456789abcdef",
            },
          ])
        ).length,
      ).toBe(0);
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("rejects structural and accessor inputs without touching getter", () => {
    let touched = false;
    const value = Object.create({ authorizationRuntime: null });
    expect(createEnterpriseLegacyResourceAuthorization(value)).toBeNull();
    const accessor = Object.defineProperty({}, "authorizationRuntime", {
      enumerable: true,
      get: () => {
        touched = true;
        return null;
      },
    });
    expect(createEnterpriseLegacyResourceAuthorization(accessor)).toBeNull();
    expect(touched).toBe(false);
    const symbolExtra = { authorizationRuntime: null, [Symbol("extra")]: true };
    expect(createEnterpriseLegacyResourceAuthorization(symbolExtra)).toBeNull();
  });

  test("fails closed when release races async assertions", async () => {
    const fixture = await createProductionRuntimeFixture("legacy-race");
    try {
      const agent = {
        id: "agt_0123456789abcdef",
        organizationId: fixture.context.enterpriseContext.principal.organizationId,
        nodeId: fixture.context.enterpriseContext.node.nodeId,
        ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        workspaceId: "wks_0123456789abcdef",
      };
      fixture.provider.owners.registerAgent(agent);
      const authorization = createEnterpriseLegacyResourceAuthorization({
        authorizationRuntime: fixture.runtime,
      });
      if (!authorization) throw new Error("authorization");
      await expect(
        authorization.assertAgent("workspace.content.read", agent.id),
      ).resolves.not.toBeNull();
      const pendingWorkspace = authorization.assertWorkspace(
        "workspace.content.read",
        "wks_0123456789abcdef",
      );
      const pendingAgents = authorization.filterAgents([agent]);
      await fixture.runtime.release();
      await expect(pendingWorkspace).resolves.toBeNull();
      await expect(pendingAgents).resolves.toEqual([]);
    } finally {
      await closeProductionRuntimeFixture();
    }
  });
});
