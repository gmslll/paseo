import { describe, expect, it, vi } from "vitest";
import {
  BrowserProfileRuntimeAuthorizationRegistry,
  getEnterpriseBrowserProfilePartition,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";
import { createBrowserProfileAuthorizationHandler } from "./profile-authorizations-handler.js";

const NODE_ID = "nod_1111111111111111";
const baseAuthorization: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: NODE_ID,
  workspaceId: "workspace-enterprise",
  browserProfileId: "brp_1111111111111111",
  bindingRevision: "binding-a",
  lifecycleGeneration: "generation-a",
};

function authorization(profileId: string, generation = baseAuthorization.lifecycleGeneration) {
  return { ...baseAuthorization, browserProfileId: profileId, lifecycleGeneration: generation };
}

describe("browser profile authorization handler", () => {
  it("reconciles profiles and cleans only revoked guests", async () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const unregisterProfile = vi.fn();
    const destroyGuest = vi.fn();
    const cleanup = {
      unregisterProfile,
      findGuests: (profileId: string) =>
        profileId === baseAuthorization.browserProfileId ? ["guest-a"] : ["guest-b"],
      destroyGuest,
    };
    const handler = createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: 41,
      cleanup,
    });

    await handler.hydrate(
      [baseAuthorization, authorization("brp_2222222222222222")],
      "generation-a",
    );
    const revoked = await handler.hydrate([authorization("brp_2222222222222222")], "generation-a");

    expect(revoked).toHaveLength(1);
    expect(unregisterProfile).toHaveBeenCalledWith(baseAuthorization);
    expect(destroyGuest).toHaveBeenCalledWith("guest-a");
    expect(destroyGuest).not.toHaveBeenCalledWith("guest-b");
  });

  it("rejects late generations without touching guests", async () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const unregisterProfile = vi.fn();
    const handler = createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: 42,
      cleanup: { unregisterProfile, findGuests: () => [], destroyGuest: vi.fn() },
    });
    await handler.hydrate([baseAuthorization], "generation-a");
    expect(await handler.revoke("generation-old")).toEqual([]);
    expect(unregisterProfile).not.toHaveBeenCalled();
  });

  it("keeps registry revoked and aggregates cleanup failures", async () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const handler = createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: 43,
      cleanup: {
        unregisterProfile: () => {
          throw new Error("unregister failed");
        },
        findGuests: () => ["guest"],
        destroyGuest: vi.fn(),
      },
    });
    await handler.hydrate([baseAuthorization], "generation-a");
    await expect(handler.revoke("generation-a")).rejects.toBeInstanceOf(AggregateError);
    expect(registry.revokeGeneration(43, "generation-a")).toEqual([]);
    expect(getEnterpriseBrowserProfilePartition(baseAuthorization.browserProfileId)).toBe(
      "persist:paseo-enterprise-brp_1111111111111111",
    );
  });
});
