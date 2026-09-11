import { describe, expect, test } from "vitest";
import {
  createEnterpriseAgentEventPreauthorization,
  isEnterpriseAgentEventPreauthorization,
} from "./agent-event-preauthorization.js";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
} from "./production-runtime-test-fixture.js";

describe("agent event preauthorization factory", () => {
  test.runIf(process.platform === "darwin")(
    "uses real production runtime and fails after release/no grant",
    async () => {
      const fixture = await createProductionRuntimeFixture("agent-preauth");
      try {
        fixture.provider.owners.registerAgent({
          id: "agent-preauth",
          workspaceId: "wks_0123456789abcdef",
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
          createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        });
        const port = createEnterpriseAgentEventPreauthorization({
          authorizationRuntime: fixture.runtime,
        });
        expect(port).not.toBeNull();
        expect(isEnterpriseAgentEventPreauthorization(port)).toBe(true);
        if (!port) throw new Error("expected production preauthorization");
        expect(port.allowsAgentEvent("agent-preauth")).toBe(true);
        await fixture.runtime.release();
        expect(port.allowsAgentEvent("agent-preauth")).toBe(false);
      } finally {
        await closeProductionRuntimeFixture();
      }
      const noGrant = await createProductionRuntimeFixture("agent-preauth-empty", { grants: [] });
      try {
        noGrant.provider.owners.registerAgent({
          id: "agent-preauth",
          workspaceId: "wks_0123456789abcdef",
          organizationId: noGrant.context.enterpriseContext.principal.organizationId,
          nodeId: noGrant.context.enterpriseContext.node.nodeId,
          ownerPrincipalId: noGrant.context.enterpriseContext.principal.principalId,
          createdByPrincipalId: noGrant.context.enterpriseContext.principal.principalId,
        });
        const noGrantPort = createEnterpriseAgentEventPreauthorization({
          authorizationRuntime: noGrant.runtime,
        });
        expect(noGrantPort).not.toBeNull();
        if (!noGrantPort) throw new Error("expected no-grant port");
        expect(noGrantPort.allowsAgentEvent("agent-preauth")).toBe(false);
      } finally {
        await noGrant.runtime.release();
        await closeProductionRuntimeFixture();
      }
    },
  );
  test("rejects structural, accessor, null-prototype, and extra-key inputs", () => {
    expect(isEnterpriseAgentEventPreauthorization({ allowsAgentEvent: () => true })).toBe(false);
    expect(
      createEnterpriseAgentEventPreauthorization({ authorizationRuntime: {} as never }),
    ).toBeNull();
    let touched = false;
    const accessor = Object.defineProperty({}, "authorizationRuntime", {
      enumerable: true,
      get: () => {
        touched = true;
        return {};
      },
    });
    expect(createEnterpriseAgentEventPreauthorization(accessor as never)).toBeNull();
    expect(touched).toBe(false);
    const nullProto = Object.create(null);
    nullProto.authorizationRuntime = {};
    expect(createEnterpriseAgentEventPreauthorization(nullProto)).toBeNull();
    expect(
      createEnterpriseAgentEventPreauthorization({
        authorizationRuntime: {},
        extra: true,
      } as never),
    ).toBeNull();
  });
});
