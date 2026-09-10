import { describe, expect, it, vi } from "vitest";
import type { EnterpriseDispatchContext } from "../session/enterprise-dispatcher.js";
import { createEnterpriseDispatcherRegistry } from "./dispatcher-registry.js";

const context = {} as EnterpriseDispatchContext;
const request = { type: "enterprise.identity.get_current.request", requestId: "req_1" } as never;
const response = {
  type: "enterprise.identity.get_current.response",
  payload: { requestId: "req_1", identity: {} },
} as never;

describe("enterprise dispatcher registry", () => {
  it("routes registered requests and leaves unknown requests unavailable", async () => {
    const handle = vi.fn().mockResolvedValue(response);
    const registry = createEnterpriseDispatcherRegistry([
      {
        family: "identity",
        requestTypes: [
          request.type,
          "enterprise.identity.list_principals.request",
          "enterprise.identity.logout_all.request",
        ],
        dispatcher: { handle },
      },
    ]);
    await expect(registry.handle({ sessionContext: context, message: request })).resolves.toBe(
      response,
    );
    await expect(
      registry.handle({
        sessionContext: context,
        message: { type: "enterprise.audit.list_events.request", requestId: "req_2" } as never,
      }),
    ).resolves.toBe(false);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(registry.features.enterpriseIdentityV1).toBe(true);
    expect(registry.features.enterpriseAuditV1).toBe(false);
  });

  it("forwards a registered dispatcher's policy classification", () => {
    const registry = createEnterpriseDispatcherRegistry([
      {
        family: "resourceAuthorization",
        requestTypes: [
          "enterprise.organization.list_resources.request",
          "enterprise.placement.resolve_workspace.request",
          "enterprise.access.list_grants.request",
          "enterprise.access.update_grants.request",
        ],
        dispatcher: {
          handle: () => false,
          requestPolicyForType: (type) =>
            type === "enterprise.organization.list_resources.request" ? "resources" : null,
        },
      },
    ]);
    expect(registry.requestPolicyForType?.("enterprise.organization.list_resources.request")).toBe(
      "resources",
    );
    expect(registry.requestPolicyForType?.("enterprise.placement.resolve_workspace.request")).toBe(
      null,
    );
  });

  it("rejects duplicate request or family registrations", () => {
    const dispatcher = { handle: () => false };
    expect(() =>
      createEnterpriseDispatcherRegistry([
        { family: "identity", requestTypes: [request.type], dispatcher },
        {
          family: "identity",
          requestTypes: ["enterprise.identity.logout_all.request"],
          dispatcher,
        },
      ]),
    ).toThrow();
    expect(() =>
      createEnterpriseDispatcherRegistry([
        { family: "identity", requestTypes: [request.type], dispatcher },
        { family: "audit", requestTypes: [request.type], dispatcher },
      ]),
    ).toThrow();
  });
});
