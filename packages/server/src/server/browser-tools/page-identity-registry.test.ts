import type {
  BrowserProfileRecord,
  EnterpriseBrowserPageIdentityInvalidationRequest,
  EnterpriseBrowserPageIdentityObservationRequest,
} from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import {
  BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS,
  BrowserPageIdentityRegistry,
  BrowserPageIdentityVerificationError,
  createAuthenticatedBrowserHostSession,
  isBrowserPageIdentityVerification,
} from "./page-identity-registry.js";

const PROFILE_ID = "brp_1111111111111111";
const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "nod_1111111111111111";
const BINDING_REVISION = "binding-1";
const LIFECYCLE_GENERATION = "session-1";

function profile(overrides: Partial<BrowserProfileRecord> = {}): BrowserProfileRecord {
  return {
    browserProfileId: PROFILE_ID,
    organizationId: "org_1111111111111111",
    homeNodeId: NODE_ID,
    businessIdentityId: "bid_1111111111111111",
    ownerPrincipalId: "usr_1111111111111111",
    platform: "generic",
    businessAccountKey: "account-a",
    label: "Account A",
    partitionKey: `persist:paseo-enterprise-${PROFILE_ID}`,
    downloadRoot: `/profiles/${PROFILE_ID}/downloads`,
    expectedIdentity: {
      hostnames: ["SHOP.EXAMPLE."],
      accountLabelHash: "sha256:account-a",
    },
    status: "ready",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function observation(
  overrides: Partial<EnterpriseBrowserPageIdentityObservationRequest> = {},
): EnterpriseBrowserPageIdentityObservationRequest {
  return {
    type: "enterprise.browser.page_identity.observe.request",
    requestId: "observe-1",
    browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
    hostname: "shop.example",
    accountLabelHash: "sha256:account-a",
    observationRevision: "observation-1",
    bindingRevision: BINDING_REVISION,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    ...overrides,
  };
}

function invalidation(
  overrides: Partial<EnterpriseBrowserPageIdentityInvalidationRequest> = {},
): EnterpriseBrowserPageIdentityInvalidationRequest {
  return {
    type: "enterprise.browser.page_identity.invalidate.request",
    requestId: "invalidate-1",
    browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
    observationRevision: "observation-1",
    bindingRevision: BINDING_REVISION,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    ...overrides,
  };
}

function fixture() {
  let currentProfile = profile();
  const registry = new BrowserPageIdentityRegistry({
    profiles: { get: async () => currentProfile },
  });
  const host = createAuthenticatedBrowserHostSession({
    clientId: "desktop-client-1",
    homeNodeId: NODE_ID,
    sessionBindingGeneration: "session-1",
  });
  registry.registerBrowser({
    host,
    browserId: BROWSER_ID,
    browserProfileId: PROFILE_ID,
    bindingRevision: BINDING_REVISION,
  });
  return {
    registry,
    host,
    setProfile: (next: BrowserProfileRecord) => {
      currentProfile = next;
    },
  };
}

describe("BrowserPageIdentityRegistry", () => {
  test("combines an authenticated provisional observation only with the matching later Browser registration", async () => {
    const registry = new BrowserPageIdentityRegistry({
      profiles: { get: async () => profile() },
    });
    const host = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: LIFECYCLE_GENERATION,
    });
    const target = {
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    };

    await expect(registry.observe(host, observation())).resolves.toBe("observation-1");
    await expect(registry.verify(target)).rejects.toMatchObject({
      reasonCode: "observation_unavailable",
    });

    registry.registerBrowser({ host, ...target });
    await expect(registry.verify(target)).resolves.toMatchObject({
      browserId: BROWSER_ID,
      observationRevision: "observation-1",
    });

    const mismatched = new BrowserPageIdentityRegistry({
      profiles: { get: async () => profile() },
    });
    const mismatchedHost = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-2",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: LIFECYCLE_GENERATION,
    });
    await mismatched.observe(mismatchedHost, observation());
    expect(() =>
      mismatched.registerBrowser({
        host: mismatchedHost,
        ...target,
        bindingRevision: "binding-rebound",
      }),
    ).toThrow(BrowserPageIdentityVerificationError);
    expect(() => mismatched.registerBrowser({ host: mismatchedHost, ...target })).toThrow(
      BrowserPageIdentityVerificationError,
    );
    await expect(mismatched.verify(target)).rejects.toMatchObject({
      reasonCode: "observation_unavailable",
    });
  });

  test("invalidates a provisional observation without ever making it verifiable", async () => {
    const registry = new BrowserPageIdentityRegistry({
      profiles: { get: async () => profile() },
    });
    const host = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: LIFECYCLE_GENERATION,
    });
    await registry.observe(host, observation());
    await expect(registry.invalidateObservation(host, invalidation())).resolves.toBe(
      "observation-1",
    );
    registry.registerBrowser({
      host,
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });
    await expect(
      registry.verify({
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
  });

  test("accepts only the authenticated host registration and issues a nominal matching proof", async () => {
    const { registry, host } = fixture();
    await expect(registry.observe(host, observation())).resolves.toBe("observation-1");

    const proof = await registry.verify({
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });

    expect(isBrowserPageIdentityVerification(proof)).toBe(true);
    expect(proof).toMatchObject({
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      hostClientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      observationRevision: "observation-1",
    });
    await expect(
      registry.recheck(proof, {
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
        hostClientId: "desktop-client-1",
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    await expect(
      registry.recheck(proof, {
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
        hostClientId: "desktop-client-1",
        hostSessionBindingGeneration: "session-1",
      }),
    ).resolves.toBeUndefined();
  });

  test("isolates two authenticated Sessions for the same client and tears down only the exact generation", async () => {
    const registry = new BrowserPageIdentityRegistry({
      profiles: { get: async () => profile() },
    });
    const oldHost = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-shared",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-old",
    });
    const newHost = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-shared",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-new",
    });
    const target = {
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    };
    registry.registerBrowser({ host: oldHost, ...target });
    registry.registerBrowser({ host: newHost, ...target });
    await registry.observe(
      oldHost,
      observation({
        lifecycleGeneration: "session-old",
        observationRevision: "observation-old",
      }),
    );
    await registry.observe(
      newHost,
      observation({
        lifecycleGeneration: "session-new",
        observationRevision: "observation-new",
      }),
    );

    const oldProof = await registry.verify({
      ...target,
      hostClientId: "desktop-client-shared",
      hostSessionBindingGeneration: "session-old",
    });
    const newProof = await registry.verify({
      ...target,
      hostClientId: "desktop-client-shared",
      hostSessionBindingGeneration: "session-new",
    });
    expect(oldProof.observationRevision).toBe("observation-old");
    expect(newProof.observationRevision).toBe("observation-new");

    registry.invalidateHostSession(structuredClone(oldHost));
    await expect(registry.recheck(oldProof)).resolves.toBeUndefined();
    registry.invalidateHostSession(oldHost);

    await expect(registry.recheck(oldProof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });
    await expect(registry.recheck(newProof)).resolves.toBeUndefined();
    await expect(
      registry.verify({
        ...target,
        hostClientId: "desktop-client-shared",
        hostSessionBindingGeneration: "session-new",
      }),
    ).resolves.toMatchObject({ observationRevision: "observation-new" });
  });

  test.each([
    ["hostname mismatch", { hostname: "other.example" }, "hostname_mismatch"],
    ["account mismatch", { accountLabelHash: "sha256:account-b" }, "account_label_mismatch"],
  ])("rejects %s", async (_label, overrides, reasonCode) => {
    const { registry, host } = fixture();
    await registry.observe(host, observation(overrides));
    await expect(
      registry.verify({
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).rejects.toMatchObject({ reasonCode });
  });

  test("rejects unavailable, superseded, rebound, replaced, destroyed, revoked, and disconnected evidence", async () => {
    const { registry, host } = fixture();
    const target = {
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    };
    await expect(registry.verify(target)).rejects.toMatchObject({
      reasonCode: "observation_unavailable",
    });

    await registry.observe(host, observation());
    const proof = await registry.verify(target);
    await registry.observe(host, observation({ observationRevision: "observation-new" }));
    await expect(registry.recheck(proof)).rejects.toBeInstanceOf(
      BrowserPageIdentityVerificationError,
    );
    await expect(registry.verify(target)).resolves.toMatchObject({
      observationRevision: "observation-new",
    });

    registry.registerBrowser({ ...target, host });
    await registry.observe(host, observation({ observationRevision: "observation-2" }));
    await expect(
      registry.observe(
        host,
        observation({ lifecycleGeneration: "session-rebound", observationRevision: "rebind" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "observation_rebound" });
    await expect(registry.verify(target)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });

    const invalidators = [
      (instance: ReturnType<typeof fixture>) =>
        instance.registry.invalidateBrowser(instance.host, BROWSER_ID),
      (instance: ReturnType<typeof fixture>) =>
        instance.registry.invalidateBinding(PROFILE_ID, BINDING_REVISION),
      (instance: ReturnType<typeof fixture>) => instance.registry.invalidateSession("session-1"),
      (instance: ReturnType<typeof fixture>) =>
        instance.registry.invalidateHostSession(instance.host),
    ];
    for (const [index, invalidate] of invalidators.entries()) {
      const instance = fixture();
      await instance.registry.observe(
        instance.host,
        observation({ observationRevision: `observation-invalidate-${index}` }),
      );
      invalidate(instance);
      await expect(instance.registry.verify(target)).rejects.toMatchObject({
        reasonCode: "observation_unavailable",
      });
    }
  });

  test("requires the authenticated Session generation and rejects historical revision replay", async () => {
    const wrongGeneration = fixture();
    await expect(
      wrongGeneration.registry.observe(
        wrongGeneration.host,
        observation({ lifecycleGeneration: "caller-generation" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "observation_rebound" });

    const reRegistered = fixture();
    await reRegistered.registry.observe(reRegistered.host, observation());
    reRegistered.registry.registerBrowser({
      host: reRegistered.host,
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: "binding-2",
    });
    reRegistered.registry.registerBrowser({
      host: reRegistered.host,
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });
    await reRegistered.registry.observe(
      reRegistered.host,
      observation({ observationRevision: "observation-after-registration" }),
    );
    await expect(
      reRegistered.registry.observe(reRegistered.host, observation()),
    ).rejects.toMatchObject({ reasonCode: "observation_replayed" });

    const { registry, host } = fixture();
    await registry.observe(host, observation({ observationRevision: "observation-1" }));
    await registry.observe(host, observation({ observationRevision: "observation-2" }));
    await expect(
      registry.observe(host, observation({ observationRevision: "observation-1" })),
    ).rejects.toMatchObject({ reasonCode: "observation_replayed" });
    await expect(
      registry.verify({
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_stale" });
  });

  test("invalidates only exact current evidence and cannot replay an old invalidation over new evidence", async () => {
    const { registry, host } = fixture();
    const target = {
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    };
    await registry.observe(host, observation());
    const firstProof = await registry.verify(target);

    await expect(registry.invalidateObservation(host, invalidation())).resolves.toBe(
      "observation-1",
    );
    await expect(registry.invalidateObservation(host, invalidation())).resolves.toBe(
      "observation-1",
    );
    await expect(registry.recheck(firstProof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });

    await registry.observe(host, observation({ observationRevision: "observation-2" }));
    const secondProof = await registry.verify(target);
    await expect(registry.invalidateObservation(host, invalidation())).rejects.toMatchObject({
      reasonCode: "observation_replayed",
    });
    await expect(
      registry.invalidateObservation(
        host,
        invalidation({
          lifecycleGeneration: "other-generation",
          observationRevision: "observation-2",
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "observation_rebound" });
    await expect(registry.recheck(secondProof)).resolves.toBeUndefined();

    await expect(
      registry.invalidateObservation(host, invalidation({ observationRevision: "observation-2" })),
    ).resolves.toBe("observation-2");
    await expect(registry.recheck(secondProof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });
  });

  test("rejects registration replacement, Profile mutation, observer failure, and structural authority", async () => {
    const { registry, host, setProfile } = fixture();
    await registry.observe(host, observation());
    const proof = await registry.verify({
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });

    registry.registerBrowser({
      host,
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: "binding-2",
    });
    await expect(registry.recheck(proof)).rejects.toBeInstanceOf(
      BrowserPageIdentityVerificationError,
    );

    registry.registerBrowser({
      host,
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });
    await registry.observe(host, observation({ observationRevision: "profile-change" }));
    const current = await registry.verify({
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: BINDING_REVISION,
    });
    setProfile(profile({ updatedAt: "2026-09-11T00:00:01.000Z" }));
    await expect(registry.recheck(current)).rejects.toBeInstanceOf(
      BrowserPageIdentityVerificationError,
    );

    await expect(
      Reflect.apply(registry.observe, registry, [
        {
          clientId: "desktop-client-1",
          homeNodeId: NODE_ID,
          sessionBindingGeneration: "session-1",
        },
        observation(),
      ]),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    expect(() =>
      Reflect.apply(createAuthenticatedBrowserHostSession, undefined, [
        {
          clientId: "desktop-client-1",
          homeNodeId: NODE_ID,
          sessionBindingGeneration: "session-1",
          path: "/tmp/profile",
          pat: "pso_u_secret",
        },
      ]),
    ).toThrow();
  });

  test("fails the exact host Session closed at the observation revision bound", async () => {
    const { registry, host } = fixture();
    for (
      let revision = 0;
      revision < BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.observationRevisionsPerHostSession;
      revision += 1
    ) {
      await registry.observe(
        host,
        observation({ observationRevision: `bounded-observation-${revision}` }),
      );
    }

    await expect(
      registry.observe(host, observation({ observationRevision: "over-capacity" })),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    expect(() =>
      registry.registerBrowser({
        host,
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toThrow(BrowserPageIdentityVerificationError);

    registry.invalidateSession(LIFECYCLE_GENERATION);
    expect(() =>
      registry.registerBrowser({
        host,
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toThrow(BrowserPageIdentityVerificationError);
    registry.invalidateHostSession(host);
    const nextHost = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: "session-2",
    });
    expect(
      registry.registerBrowser({
        host: nextHost,
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toMatch(/^browser-registration-/u);
  });

  test("bounds registration ledgers and retires them only with the host lifecycle", () => {
    const { registry, host } = fixture();
    for (
      let index = 1;
      index < BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.browserRegistrationsPerHostSession;
      index += 1
    ) {
      registry.registerBrowser({
        host,
        browserId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      });
    }

    expect(() =>
      registry.registerBrowser({
        host,
        browserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toThrow(BrowserPageIdentityVerificationError);
    expect(() =>
      registry.registerBrowser({
        host,
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toThrow(BrowserPageIdentityVerificationError);
  });

  test("bounds provisional Browser observations before server registration", async () => {
    const registry = new BrowserPageIdentityRegistry({
      profiles: { get: async () => profile() },
    });
    const host = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-provisional",
      homeNodeId: NODE_ID,
      sessionBindingGeneration: LIFECYCLE_GENERATION,
    });
    for (
      let index = 0;
      index < BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.browserRegistrationsPerHostSession;
      index += 1
    ) {
      await registry.observe(
        host,
        observation({
          browser: {
            browserId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
            browserProfileId: PROFILE_ID,
          },
          observationRevision: `provisional-observation-${index}`,
        }),
      );
    }
    await expect(
      registry.observe(
        host,
        observation({
          browser: {
            browserId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            browserProfileId: PROFILE_ID,
          },
          observationRevision: "provisional-over-capacity",
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    expect(() =>
      registry.registerBrowser({
        host,
        browserId: "00000000-0000-4000-8000-000000000000",
        browserProfileId: PROFILE_ID,
        bindingRevision: BINDING_REVISION,
      }),
    ).toThrow(BrowserPageIdentityVerificationError);
  });
});
