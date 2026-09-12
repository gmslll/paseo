import { describe, expect, it, vi } from "vitest";
import {
  BrowserProfileRuntimeAuthorizationRegistry,
  getEnterpriseBrowserProfilePartition,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";
import {
  BrowserProfileAuthorizationRegistryRouter,
  createBrowserProfileAuthorizationHandler,
} from "./profile-authorizations-handler.js";

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
    const destroyGuest = vi.fn(() => {
      throw new Error("destroy failed");
    });
    const cleanupGuest = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const unregisterError = new Error("unregister failed");
    const handler = createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: 43,
      cleanup: {
        unregisterProfile: () => {
          throw unregisterError;
        },
        findGuests: () => ["guest"],
        destroyGuest,
        cleanupGuest,
      },
    });
    await handler.hydrate([baseAuthorization], "generation-a");
    let caught: unknown;
    try {
      await handler.revoke("generation-a");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (caught instanceof AggregateError) {
      expect(caught.cause).toBe(unregisterError);
      expect(caught.errors).toHaveLength(3);
    }
    expect(destroyGuest).toHaveBeenCalledWith("guest");
    expect(cleanupGuest).toHaveBeenCalledWith("guest");
    expect(registry.revokeGeneration(43, "generation-a")).toEqual([]);
    expect(getEnterpriseBrowserProfilePartition(baseAuthorization.browserProfileId)).toBe(
      "persist:paseo-enterprise-brp_1111111111111111",
    );
  });
});

describe("browser profile authorization registry router", () => {
  it("treats revoke before hydration as an installed no-op", async () => {
    const createCleanup = vi.fn(() => ({
      unregisterProfile: vi.fn(),
      findGuests: () => [],
      destroyGuest: vi.fn(),
    }));
    const router = new BrowserProfileAuthorizationRegistryRouter(createCleanup);

    await expect(
      router.revoke({
        hostWebContentsId: 51,
        homeNodeId: NODE_ID,
        lifecycleGeneration: "generation-a",
      }),
    ).resolves.toEqual([]);
    expect(createCleanup).not.toHaveBeenCalled();
  });

  it("isolates remote node generations in one desktop host", async () => {
    const nodeB = "nod_2222222222222222";
    const unregisterProfile = vi.fn();
    const router = new BrowserProfileAuthorizationRegistryRouter(() => ({
      unregisterProfile,
      findGuests: () => [],
      destroyGuest: vi.fn(),
    }));
    const authorizationA = baseAuthorization;
    const authorizationB = { ...baseAuthorization, homeNodeId: nodeB };

    await router.hydrate({
      hostWebContentsId: 52,
      homeNodeId: NODE_ID,
      authorizations: [authorizationA],
      lifecycleGeneration: "generation-a",
    });
    await router.hydrate({
      hostWebContentsId: 52,
      homeNodeId: nodeB,
      authorizations: [authorizationB],
      lifecycleGeneration: "generation-a",
    });

    expect(router.resolveExact(52, authorizationA)).toEqual(authorizationA);
    expect(router.resolveExact(52, authorizationB)).toEqual(authorizationB);
    await router.revoke({
      hostWebContentsId: 52,
      homeNodeId: NODE_ID,
      lifecycleGeneration: "generation-a",
    });
    expect(router.resolveExact(52, authorizationA)).toBeNull();
    expect(router.resolveExact(52, authorizationB)).toEqual(authorizationB);
    expect(unregisterProfile).toHaveBeenCalledTimes(1);
    expect(unregisterProfile).toHaveBeenCalledWith(authorizationA);

    await router.revokeHost(52);
    expect(router.resolveExact(52, authorizationB)).toBeNull();
    expect(unregisterProfile).toHaveBeenCalledTimes(2);
    expect(unregisterProfile).toHaveBeenLastCalledWith(authorizationB);
  });

  it("rejects a node claim that does not match the authorization set", async () => {
    const router = new BrowserProfileAuthorizationRegistryRouter(() => ({
      unregisterProfile: vi.fn(),
      findGuests: () => [],
      destroyGuest: vi.fn(),
    }));

    await expect(
      router.hydrate({
        hostWebContentsId: 53,
        homeNodeId: "nod_2222222222222222",
        authorizations: [baseAuthorization],
        lifecycleGeneration: "generation-a",
      }),
    ).rejects.toThrow("generation");
    expect(router.resolveExact(53, baseAuthorization)).toBeNull();
  });
});
