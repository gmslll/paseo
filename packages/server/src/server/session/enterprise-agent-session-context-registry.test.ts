import { describe, expect, it } from "vitest";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import {
  createEnterpriseAgentSessionContextRegistry,
  type EnterpriseSessionContext,
} from "./enterprise-agent-session-context-registry.js";

function context(generation: string, principalId = "principal-a"): EnterpriseSessionContext {
  return {
    principal: {
      principalType: "user",
      principalId,
      organizationId: "org-a",
      displayName: principalId,
      navigation: { defaultRoute: "home" },
      grants: [],
      grantVersion: 1,
      operations: [],
    } as PrincipalContext,
    node: {
      nodeId: "node-a",
      organizationId: "org-a",
      mode: "standalone",
    } as NodeContext,
    sessionBindingGeneration: generation,
  };
}

describe("EnterpriseAgentSessionContextRegistry", () => {
  it("resolves an active handle and invalidates it on release", () => {
    const registry = createEnterpriseAgentSessionContextRegistry();
    const handle = registry.bind({ agentId: "agent-a", context: context("generation-a") });

    expect(registry.resolve("agent-a")).not.toBeNull();
    expect(handle.isCurrent()).toBe(true);

    registry.release({ agentId: "agent-a", sessionBindingGeneration: "generation-a" });

    expect(handle.isCurrent()).toBe(false);
    expect(registry.resolve("agent-a")).toBeNull();
  });

  it("does not let an old release remove a newer binding", () => {
    const registry = createEnterpriseAgentSessionContextRegistry();
    const oldHandle = registry.bind({ agentId: "agent-a", context: context("generation-a") });
    const newHandle = registry.bind({ agentId: "agent-a", context: context("generation-b") });

    registry.release({ agentId: "agent-a", sessionBindingGeneration: "generation-a" });

    expect(oldHandle.isCurrent()).toBe(false);
    expect(newHandle.isCurrent()).toBe(true);
    expect(registry.resolve("agent-a")?.context.sessionBindingGeneration).toBe("generation-b");
  });

  it("releases every binding belonging to one logical Session", () => {
    const registry = createEnterpriseAgentSessionContextRegistry();
    const first = registry.bind({ agentId: "agent-a", context: context("generation-a") });
    const second = registry.bind({
      agentId: "agent-b",
      context: context("generation-a", "principal-b"),
    });
    const retained = registry.bind({ agentId: "agent-c", context: context("generation-b") });

    registry.releaseSession("generation-a");

    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(false);
    expect(retained.isCurrent()).toBe(true);
    expect(registry.resolve("agent-c")).not.toBeNull();
  });
});
