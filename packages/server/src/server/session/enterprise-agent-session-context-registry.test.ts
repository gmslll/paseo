import { describe, expect, it } from "vitest";
import {
  createEnterpriseAgentSessionContextRegistry,
  isEnterpriseAgentContextCurrentForSession,
  type EnterpriseSessionContext,
} from "./enterprise-agent-session-context-registry.js";
function context(
  generation: string,
  principalId = "usr_aaaaaaaaaaaaaaaa",
): EnterpriseSessionContext {
  return {
    principal: {
      principalType: "human",
      principalId,
      organizationId: "org_aaaaaaaaaaaaaaaa",
      grants: [
        {
          action: "workspace.content.read",
          selector: { kind: "workspace", workspaceIds: ["wks_aaaaaaaaaaaaaaaa"] },
        },
      ],
      credentialId: "cred_a",
      grantVersion: "grant-v1",
    },
    node: { nodeId: "nod_aaaaaaaaaaaaaaaa", paseoServerId: "server-a", mode: "standalone" },
    sessionBindingGeneration: generation,
  };
}
describe("EnterpriseAgentSessionContextRegistry", () => {
  it("stable resolve and release", () => {
    const r = createEnterpriseAgentSessionContextRegistry();
    const h = r.bind({ agentId: "agent-a", context: context("gen-a") });
    expect(r.resolve("agent-a")).toBe(h);
    expect(r.isCurrentHandle(h)).toBe(true);
    r.release({ agentId: "agent-a", sessionBindingGeneration: "gen-a" });
    expect(r.isCurrentHandle(h)).toBe(false);
  });
  it.each([
    "sessionBindingGeneration",
    "organizationId",
    "principalId",
    "principalType",
    "credentialId",
    "grantVersion",
    "nodeId",
    "paseoServerId",
    "mode",
  ])("exact helper rejects %s", (field) => {
    const r = createEnterpriseAgentSessionContextRegistry();
    const base = context("gen-a");
    const h = r.bind({ agentId: "agent-a", context: base });
    expect(isEnterpriseAgentContextCurrentForSession(h, base)).toBe(true);
    const changed = structuredClone(base) as EnterpriseSessionContext;
    if (field === "sessionBindingGeneration") changed.sessionBindingGeneration = "gen-b";
    else if (field === "organizationId") changed.principal.organizationId = "org_bbbbbbbbbbbbbbbb";
    else if (field === "principalId") changed.principal.principalId = "usr_bbbbbbbbbbbbbbbb";
    else if (field === "principalType")
      (changed.principal as { principalType: string }).principalType = "service";
    else if (field === "credentialId") changed.principal.credentialId = "cred-b";
    else if (field === "grantVersion") changed.principal.grantVersion = "grant-v2";
    else if (field === "nodeId") changed.node.nodeId = "nod_bbbbbbbbbbbbbbbb";
    else if (field === "paseoServerId") changed.node.paseoServerId = "server-b";
    else changed.node.mode = "managed";
    expect(isEnterpriseAgentContextCurrentForSession(h, changed)).toBe(false);
    r.release({ agentId: "agent-a", sessionBindingGeneration: "gen-a" });
    expect(isEnterpriseAgentContextCurrentForSession(h, base)).toBe(false);
  });
  it("rejects structural, foreign, throwing and replaced handles", () => {
    const r = createEnterpriseAgentSessionContextRegistry();
    const other = createEnterpriseAgentSessionContextRegistry();
    const h = r.bind({ agentId: "agent-a", context: context("gen-a") });
    const foreign = other.bind({ agentId: "agent-a", context: context("gen-a") });
    expect(r.isCurrentHandle(foreign)).toBe(false);
    expect(r.isCurrentHandle({} as never)).toBe(false);
    expect(
      r.isCurrentHandle({
        get agentId() {
          throw new Error("fake");
        },
      } as never),
    ).toBe(false);
    const newer = r.bind({ agentId: "agent-a", context: context("gen-b", "usr_bbbbbbbbbbbbbbbb") });
    expect(r.isCurrentHandle(h)).toBe(false);
    expect(r.isCurrentHandle(newer)).toBe(true);
  });
  it("deep clones caller context and releases by generation", () => {
    const r = createEnterpriseAgentSessionContextRegistry();
    const original = context("gen-a");
    const h = r.bind({ agentId: "agent-a", context: original });
    original.principal.grants[0].selector.workspaceIds.push("wks_bbbbbbbbbbbbbbbb");
    expect(h.context.principal.grants).toHaveLength(1);
    expect(h.context.principal.grants[0].selector).toEqual({
      kind: "workspace",
      workspaceIds: ["wks_aaaaaaaaaaaaaaaa"],
    });
    expect(Object.isFrozen(h.context.principal.grants[0].selector)).toBe(true);
    expect(Object.isFrozen(h.context.principal.grants[0].selector.workspaceIds)).toBe(true);
    expect(() =>
      h.context.principal.grants[0].selector.workspaceIds.push("wks_cccccccccccccccc"),
    ).toThrow();
    const b = r.bind({ agentId: "agent-b", context: context("gen-a", "usr_bbbbbbbbbbbbbbbb") });
    r.releaseSession("gen-a");
    expect(r.isCurrentHandle(h)).toBe(false);
    expect(r.isCurrentHandle(b)).toBe(false);
  });
  it("rejects invalid agent/context/generation", () => {
    const r = createEnterpriseAgentSessionContextRegistry();
    expect(() => r.bind({ agentId: "", context: context("gen-a") })).toThrow();
    expect(() => r.bind({ agentId: "agent-a", context: context("") })).toThrow();
    expect(() =>
      r.bind({
        agentId: "agent-a",
        context: {
          ...context("gen-a"),
          principal: { ...context("gen-a").principal, principalType: "user" } as never,
        },
      }),
    ).toThrow();
  });
});
