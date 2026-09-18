import { describe, expect, it } from "vitest";
import { createEnterpriseResidueResetAdapter } from "./enterprise-residue-reset";

describe("enterprise residue reset adapter", () => {
  it("clears generation A before activating B", () => {
    const cleared: string[] = [];
    const adapter = createEnterpriseResidueResetAdapter({
      reset: (scope) => cleared.push(`${scope.serverId}:${scope.lifecycleGeneration}`),
    });
    adapter.activate({ serverId: "server-a", lifecycleGeneration: "generation-a" });
    adapter.activate({ serverId: "server-b", lifecycleGeneration: "generation-b" });
    expect(cleared).toEqual(["server-a:generation-a"]);
    expect(adapter.getActiveScope()).toEqual({
      serverId: "server-b",
      lifecycleGeneration: "generation-b",
    });
  });

  it("never forwards secrets or clears a legacy scope", () => {
    const scopes: unknown[] = [];
    const adapter = createEnterpriseResidueResetAdapter({ reset: (scope) => scopes.push(scope) });
    adapter.activate({ serverId: "server-a", lifecycleGeneration: "generation-a" });
    adapter.reset({ serverId: "server-a", lifecycleGeneration: "generation-a" });
    expect(JSON.stringify(scopes)).not.toMatch(/PAT|token|handle|clientGeneration|legacy/);
    expect(adapter.getActiveScope()).toBeNull();
  });
});
