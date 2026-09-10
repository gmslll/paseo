import { describe, expect, it, vi } from "vitest";
import type { EnterpriseDispatchContext } from "../session/enterprise-dispatcher.js";
import {
  createEnterpriseDispatcherRegistry,
  createEnterpriseSessionDispatcherRegistration,
} from "./dispatcher-registry.js";

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
    expect(registry.features.enterpriseAuditV1).toBeUndefined();
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

  it("advertises exactly the complete registered families", () => {
    const dispatcher = { handle: () => false };
    const registrations = [
      {
        family: "identity" as const,
        requestTypes: [
          "enterprise.identity.get_current.request",
          "enterprise.identity.list_principals.request",
          "enterprise.identity.logout_all.request",
        ],
        dispatcher,
      },
      {
        family: "resourceAuthorization" as const,
        requestTypes: [
          "enterprise.access.list_grants.request",
          "enterprise.access.update_grants.request",
          "enterprise.organization.list_resources.request",
          "enterprise.placement.resolve_workspace.request",
        ],
        dispatcher,
      },
      {
        family: "browserProfiles" as const,
        requestTypes: [
          "enterprise.browser.list_profiles.request",
          "enterprise.browser.bind_profile.request",
          "enterprise.resource.acquire_lease.request",
          "enterprise.resource.renew_lease.request",
          "enterprise.resource.release_lease.request",
        ],
        dispatcher,
      },
      {
        family: "audit" as const,
        requestTypes: ["enterprise.audit.list_events.request"],
        dispatcher,
      },
    ] as const;
    const registry = createEnterpriseDispatcherRegistry(registrations);
    expect(registry.features).toEqual({
      enterpriseIdentityV1: true,
      enterpriseResourceAuthorizationV1: true,
      enterpriseBrowserProfilesV1: true,
      enterpriseAuditV1: true,
    });
    expect("enterpriseDistributedNodeV1" in registry.features).toBe(false);
  });

  it("opens each family per session and routes through one composite lease", async () => {
    const closeIdentity = vi.fn();
    const closeResources = vi.fn();
    const identityResponse = {
      type: "enterprise.identity.get_current.response",
      payload: { requestId: "req_identity" },
    } as never;
    const resourceResponse = {
      type: "enterprise.organization.list_resources.response",
      payload: { requestId: "req_resources", principals: [], resources: [], nextCursor: null },
    } as never;
    const registration = createEnterpriseSessionDispatcherRegistration([
      {
        manifest: { operations: [request.type] },
        open: vi.fn(() => ({
          dispatcher: { handle: () => identityResponse },
          close: closeIdentity,
        })),
      },
      {
        manifest: { operations: ["enterprise.organization.list_resources.request"] },
        open: vi.fn(() => ({
          dispatcher: {
            handle: () => resourceResponse,
            requestPolicyForType: () => "resources" as const,
            consumeResponse: ({ response: messageResponse }: { response: never }) => ({
              response: messageResponse,
              receiptClassification: "resources" as const,
              authorizationContext: {
                kind: "resources",
                organizationId: "org",
                principals: [],
                resources: [],
                nextCursor: null,
              },
            }),
          },
          close: closeResources,
        })),
      },
    ]);
    expect(registration).not.toBeNull();
    const lease = registration?.open({
      sessionId: "session",
      clientId: "client",
      context,
      authorizationRuntime: {},
    });
    await expect(
      lease?.dispatcher.handle({ sessionContext: context, message: request }),
    ).resolves.toBe(identityResponse);
    await expect(
      lease?.dispatcher.handle({
        sessionContext: context,
        message: {
          type: "enterprise.organization.list_resources.request",
          requestId: "req_resources",
        } as never,
      }),
    ).resolves.toBe(resourceResponse);
    expect(
      lease?.dispatcher.requestPolicyForType?.("enterprise.organization.list_resources.request"),
    ).toBe("resources");
    const consumed = lease?.dispatcher.consumeResponse?.({
      sessionContext: context,
      message: {
        type: "enterprise.organization.list_resources.request",
        requestId: "req_resources",
      } as never,
      response: resourceResponse,
    });
    expect(consumed?.receiptClassification).toBe("resources");
    await lease?.close();
    await lease?.close();
    expect(closeIdentity).toHaveBeenCalledTimes(1);
    expect(closeResources).toHaveBeenCalledTimes(1);
    await expect(
      lease?.dispatcher.handle({ sessionContext: context, message: request }),
    ).resolves.toBe(false);
  });

  it("rolls back already opened leases when a later family fails", () => {
    const close = vi.fn();
    const registration = createEnterpriseSessionDispatcherRegistration([
      {
        manifest: { operations: ["a.request"] },
        open: () => ({ dispatcher: { handle: () => false }, close }),
      },
      {
        manifest: { operations: ["b.request"] },
        open: () => {
          throw new Error("open failed");
        },
      },
    ]);
    expect(registration).not.toBeNull();
    expect(() => registration?.open({ sessionId: "s", clientId: "c", context })).toThrow(
      "open failed",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate operations in a composite manifest", () => {
    expect(
      createEnterpriseSessionDispatcherRegistration([
        {
          manifest: { operations: ["same.request"] },
          open: () => ({ dispatcher: { handle: () => false }, close: () => undefined }),
        },
        {
          manifest: { operations: ["same.request"] },
          open: () => ({ dispatcher: { handle: () => false }, close: () => undefined }),
        },
      ]),
    ).toBeNull();
  });
});
