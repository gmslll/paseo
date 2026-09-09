import { describe, expect, test } from "vitest";
import {
  BrowserProfileRuntimeAuthorizationRegistry,
  clearPaseoBrowserProfile,
  getEnterpriseBrowserProfileDownloadRoot,
  getEnterpriseBrowserProfilePartition,
  getLegacyPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  parseBrowserProfileLeaseContext,
  parseBrowserProfileRuntimeAuthorization,
  parseBrowserProfileRuntimeSelector,
  readLegacyPaseoBrowserIds,
} from "./browser-profile.js";

const PROFILE_A = "brp_1111111111111111";
const PROFILE_B = "brp_2222222222222222";
const NODE_ID = "nod_1111111111111111";
const RUNTIME_AUTHORIZATION = {
  organizationId: "org_1111111111111111",
  homeNodeId: NODE_ID,
  workspaceId: "workspace-a",
  browserProfileId: PROFILE_A,
  bindingRevision: "binding-a",
  lifecycleGeneration: "lifecycle-a",
};
const LEASE_CONTEXT = {
  browserProfileId: PROFILE_A,
  nodeId: NODE_ID,
  leaseId: "lea_11111111-1111-4111-8111-111111111111",
  fencingToken: 7,
  leaseRevision: "lease-revision-a",
};

class FakeProfileSession {
  public readonly storageClears: unknown[] = [];
  public cacheClears = 0;
  public authClears = 0;
  public storageClear: Promise<void> = Promise.resolve();

  public clearStorageData(options: unknown): Promise<void> {
    this.storageClears.push(options);
    return this.storageClear;
  }

  public clearCache(): Promise<void> {
    this.cacheClears += 1;
    return Promise.resolve();
  }

  public clearAuthCache(): Promise<void> {
    this.authClears += 1;
    return Promise.resolve();
  }
}

class FakeLiveGuest {
  public reloads = 0;

  public constructor(
    public readonly id: number,
    private readonly destroyed = false,
    private readonly reloadError: Error | null = null,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public reload(): void {
    if (this.reloadError) {
      throw this.reloadError;
    }
    this.reloads += 1;
  }
}

class FakeWebContents extends FakeLiveGuest {
  public constructor(
    id: number,
    public readonly session: object,
    private readonly type: string,
    destroyed = false,
  ) {
    super(id, destroyed);
  }

  public getType(): string {
    return this.type;
  }
}

describe("listPaseoBrowserProfileGuests", () => {
  test("returns every live webview and popup in the shared profile", () => {
    const profileSession = {};
    const firstWindowGuest = new FakeWebContents(1, profileSession, "webview");
    const secondWindowGuest = new FakeWebContents(2, profileSession, "webview");
    const foreignProfileGuest = new FakeWebContents(3, {}, "webview");
    const popupWindow = new FakeWebContents(4, profileSession, "window");
    const destroyedGuest = new FakeWebContents(5, profileSession, "webview", true);

    const guests = listPaseoBrowserProfileGuests({
      profileSession,
      webContents: [
        firstWindowGuest,
        secondWindowGuest,
        foreignProfileGuest,
        popupWindow,
        destroyedGuest,
      ],
    });

    expect(guests).toEqual([firstWindowGuest, secondWindowGuest, popupWindow]);
  });
});

describe("legacy browser profiles", () => {
  test("accepts only unique saved browser ids and resolves their old partitions", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const fallbackId = "1700000000000-abcd";
    const browserIds = readLegacyPaseoBrowserIds([uuid, fallbackId, uuid, "not-a-browser-id", 123]);
    const partitions: string[] = [];
    const sessions = getPaseoBrowserProfileSessions(
      {
        fromPartition: (partition) => {
          partitions.push(partition);
          return new FakeProfileSession();
        },
      },
      browserIds,
    );

    expect(partitions).toEqual([
      "persist:paseo-browser",
      `persist:paseo-browser-${uuid}`,
      `persist:paseo-browser-${fallbackId}`,
    ]);
    expect(sessions).toHaveLength(3);
  });

  test("resolves one valid legacy profile for tab-close cleanup", () => {
    const partitions: string[] = [];
    const sessions = {
      fromPartition: (partition: string) => {
        partitions.push(partition);
        return new FakeProfileSession();
      },
    };

    expect(getLegacyPaseoBrowserProfileSession(sessions, "1700000000000-abcd")).not.toBeNull();
    expect(getLegacyPaseoBrowserProfileSession(sessions, "invalid")).toBeNull();
    expect(partitions).toEqual(["persist:paseo-browser-1700000000000-abcd"]);
  });
});

describe("enterprise browser profiles", () => {
  test("derives one opaque persistent partition and download root per validated Profile", () => {
    expect(getEnterpriseBrowserProfilePartition(PROFILE_A)).toBe(
      "persist:paseo-enterprise-brp_1111111111111111",
    );
    expect(getEnterpriseBrowserProfilePartition(PROFILE_B)).toBe(
      "persist:paseo-enterprise-brp_2222222222222222",
    );
    expect(getEnterpriseBrowserProfileDownloadRoot("/trusted/profiles", PROFILE_A)).toBe(
      "/trusted/profiles/brp_1111111111111111/downloads",
    );
    expect(() => getEnterpriseBrowserProfilePartition("brp_../escape")).toThrow(/invalid/i);
  });

  test.each([
    { ...RUNTIME_AUTHORIZATION, partition: "persist:caller-controlled" },
    { ...RUNTIME_AUTHORIZATION, downloadRoot: "/caller-controlled" },
    { ...RUNTIME_AUTHORIZATION, processId: 123 },
    { ...RUNTIME_AUTHORIZATION, browserProfileId: "brp_fake" },
  ])("rejects structural or caller-owned authority fields", (input) => {
    expect(() => parseBrowserProfileRuntimeAuthorization(input)).toThrow(/invalid/i);
  });

  test("binds authorization to host, Workspace, Profile, revision, and lifecycle", () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const hydrated = registry.hydrate(41, RUNTIME_AUTHORIZATION);

    expect(hydrated.revoked).toEqual([]);
    expect(
      registry.resolve({
        hostWebContentsId: 41,
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_A,
      }),
    ).toEqual(RUNTIME_AUTHORIZATION);
    expect(
      registry.resolve({
        hostWebContentsId: 42,
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_A,
      }),
    ).toBeNull();
    expect(
      registry.resolve({
        hostWebContentsId: 41,
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_B,
      }),
    ).toBeNull();
    expect(
      registry.resolveExact(41, {
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_A,
        bindingRevision: RUNTIME_AUTHORIZATION.bindingRevision,
        lifecycleGeneration: RUNTIME_AUTHORIZATION.lifecycleGeneration,
      }),
    ).toEqual(RUNTIME_AUTHORIZATION);
    expect(
      registry.resolveExact(41, {
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_A,
        bindingRevision: "stale-binding",
        lifecycleGeneration: RUNTIME_AUTHORIZATION.lifecycleGeneration,
      }),
    ).toBeNull();
    expect(
      registry.resolveLease({
        hostWebContentsId: 41,
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        leaseContext: LEASE_CONTEXT,
      }),
    ).toEqual({ authorization: RUNTIME_AUTHORIZATION, leaseContext: LEASE_CONTEXT });
  });

  test("requires a trusted Desktop node and returns detached frozen authorization values", () => {
    expect(() => new BrowserProfileRuntimeAuthorizationRegistry(undefined as never)).toThrow(
      /trusted node/i,
    );
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const mutable = { ...RUNTIME_AUTHORIZATION };
    const hydrated = registry.hydrate(41, mutable);
    mutable.bindingRevision = "mutated";

    const resolved = registry.resolve({
      hostWebContentsId: 41,
      organizationId: RUNTIME_AUTHORIZATION.organizationId,
      homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
      workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
      browserProfileId: PROFILE_A,
    });
    expect(resolved).toEqual(RUNTIME_AUTHORIZATION);
    expect(Object.isFrozen(hydrated)).toBe(true);
    expect(Object.isFrozen(hydrated.authorization)).toBe(true);
    expect(Object.isFrozen(hydrated.revoked)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved).not.toBe(hydrated.authorization);
  });

  test("rejects accessor and Proxy authorization objects without invoking their values", () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const accessor = { ...RUNTIME_AUTHORIZATION } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessor, "workspaceId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "workspace-a";
      },
    });
    const proxy = new Proxy(
      { ...RUNTIME_AUTHORIZATION },
      {
        ownKeys: () => {
          throw new Error("proxy trap");
        },
      },
    );

    expect(() => registry.hydrate(41, accessor)).toThrow(/invalid/i);
    expect(() => registry.hydrate(41, proxy)).toThrow(/invalid/i);
    expect(reads).toBe(0);
  });

  test.each([
    { ...LEASE_CONTEXT, partition: "persist:caller-controlled" },
    { ...LEASE_CONTEXT, processId: 12 },
    { ...LEASE_CONTEXT, fencingToken: Number.NaN },
    { ...LEASE_CONTEXT, fencingToken: Number.MAX_SAFE_INTEGER + 1 },
    { ...LEASE_CONTEXT, leaseId: "caller-lease" },
  ])("rejects malformed or caller-owned lease context fields", (input) => {
    expect(() => parseBrowserProfileLeaseContext(input)).toThrow(/invalid/i);
  });

  test("requires exact runtime selectors", () => {
    expect(() =>
      parseBrowserProfileRuntimeSelector({
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: PROFILE_A,
        bindingRevision: RUNTIME_AUTHORIZATION.bindingRevision,
        lifecycleGeneration: RUNTIME_AUTHORIZATION.lifecycleGeneration,
        partition: "persist:caller-controlled",
      }),
    ).toThrow(/invalid/i);
  });

  test("a lifecycle replacement revokes every old Profile route for the host", () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    registry.hydrate(41, RUNTIME_AUTHORIZATION);
    registry.hydrate(41, {
      ...RUNTIME_AUTHORIZATION,
      workspaceId: "workspace-b",
      browserProfileId: PROFILE_B,
    });

    const replacement = registry.hydrate(41, {
      ...RUNTIME_AUTHORIZATION,
      lifecycleGeneration: "lifecycle-b",
    });

    expect(replacement.revoked).toHaveLength(2);
    expect(
      registry.resolve({
        hostWebContentsId: 41,
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: "workspace-b",
        browserProfileId: PROFILE_B,
      }),
    ).toBeNull();
  });

  test("keeps same-host local IDs separated across organizations and survives rebinding", () => {
    const registry = new BrowserProfileRuntimeAuthorizationRegistry(NODE_ID);
    const otherOrganization = {
      ...RUNTIME_AUTHORIZATION,
      organizationId: "org_2222222222222222",
      bindingRevision: "binding-other-organization",
    };
    registry.hydrate(41, RUNTIME_AUTHORIZATION);
    registry.hydrate(41, otherOrganization);

    expect(
      registry.resolveExact(41, {
        organizationId: otherOrganization.organizationId,
        homeNodeId: otherOrganization.homeNodeId,
        workspaceId: otherOrganization.workspaceId,
        browserProfileId: otherOrganization.browserProfileId,
        bindingRevision: otherOrganization.bindingRevision,
        lifecycleGeneration: otherOrganization.lifecycleGeneration,
      }),
    ).toEqual(otherOrganization);

    const rebound = {
      ...RUNTIME_AUTHORIZATION,
      bindingRevision: "binding-rebound",
    };
    const result = registry.hydrate(41, rebound);
    expect(result.revoked).toEqual([RUNTIME_AUTHORIZATION]);
    expect(
      registry.resolveExact(41, {
        organizationId: RUNTIME_AUTHORIZATION.organizationId,
        homeNodeId: RUNTIME_AUTHORIZATION.homeNodeId,
        workspaceId: RUNTIME_AUTHORIZATION.workspaceId,
        browserProfileId: RUNTIME_AUTHORIZATION.browserProfileId,
        bindingRevision: RUNTIME_AUTHORIZATION.bindingRevision,
        lifecycleGeneration: RUNTIME_AUTHORIZATION.lifecycleGeneration,
      }),
    ).toBeNull();
    expect(
      registry.resolveExact(41, {
        organizationId: otherOrganization.organizationId,
        homeNodeId: otherOrganization.homeNodeId,
        workspaceId: otherOrganization.workspaceId,
        browserProfileId: otherOrganization.browserProfileId,
        bindingRevision: otherOrganization.bindingRevision,
        lifecycleGeneration: otherOrganization.lifecycleGeneration,
      }),
    ).toEqual(otherOrganization);
  });
});

describe("clearPaseoBrowserProfile", () => {
  test("clears site data, HTTP cache, and auth before reloading live guests", async () => {
    const profile = new FakeProfileSession();
    const legacyProfile = new FakeProfileSession();
    let finishStorageClear: (() => void) | null = null;
    profile.storageClear = new Promise((resolve) => {
      finishStorageClear = resolve;
    });
    const firstGuest = new FakeLiveGuest(1);
    const secondGuest = new FakeLiveGuest(2);

    const clearing = clearPaseoBrowserProfile({
      profileSessions: [profile, legacyProfile],
      listGuests: () => [firstGuest, secondGuest],
      logReloadError: () => {},
    });

    expect(firstGuest.reloads).toBe(0);
    expect(secondGuest.reloads).toBe(0);
    finishStorageClear?.();
    await clearing;

    expect(profile.storageClears).toEqual([
      {
        storages: [
          "cookies",
          "filesystem",
          "indexdb",
          "localstorage",
          "serviceworkers",
          "cachestorage",
          "shadercache",
        ],
      },
    ]);
    expect(profile.cacheClears).toBe(1);
    expect(profile.authClears).toBe(1);
    expect(legacyProfile.storageClears).toEqual(profile.storageClears);
    expect(legacyProfile.cacheClears).toBe(1);
    expect(legacyProfile.authClears).toBe(1);
    expect(firstGuest.reloads).toBe(1);
    expect(secondGuest.reloads).toBe(1);
  });

  test("skips destroyed guests and logs individual reload failures", async () => {
    const profile = new FakeProfileSession();
    const destroyedGuest = new FakeLiveGuest(1, true);
    const reloadError = new Error("guest disappeared");
    const failedGuest = new FakeLiveGuest(2, false, reloadError);
    const reloadErrors: Array<{ guestId: number; error: unknown }> = [];

    await clearPaseoBrowserProfile({
      profileSessions: [profile],
      listGuests: () => [destroyedGuest, failedGuest],
      logReloadError: (guestId, error) => reloadErrors.push({ guestId, error }),
    });

    expect(destroyedGuest.reloads).toBe(0);
    expect(failedGuest.reloads).toBe(0);
    expect(reloadErrors).toEqual([{ guestId: 2, error: reloadError }]);
  });

  test("propagates clear failures without reloading guests", async () => {
    const profile = new FakeProfileSession();
    const clearError = new Error("profile locked");
    profile.storageClear = Promise.reject(clearError);
    const guest = new FakeLiveGuest(1);

    await expect(
      clearPaseoBrowserProfile({
        profileSessions: [profile],
        listGuests: () => [guest],
        logReloadError: () => {},
      }),
    ).rejects.toBe(clearError);
    expect(guest.reloads).toBe(0);
  });
});
