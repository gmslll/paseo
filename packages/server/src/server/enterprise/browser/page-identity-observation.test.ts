import type { BrowserProfileRecord } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import {
  BrowserPageIdentityRegistry,
  createAuthenticatedBrowserHostSession,
} from "../../browser-tools/page-identity-registry.js";
import {
  createBrowserPageIdentityInvalidationDispatcherRegistration,
  createBrowserPageIdentityObservationDispatcherRegistration,
} from "./page-identity-observation.js";

const PROFILE_ID = "brp_1111111111111111";
const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "nod_1111111111111111";

const profile: BrowserProfileRecord = {
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
  expectedIdentity: { hostnames: ["shop.example"] },
  status: "ready",
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
};

function sessionContext() {
  return {
    principal: {
      organizationId: profile.organizationId,
      principalType: "human" as const,
      principalId: profile.ownerPrincipalId,
      grants: [],
      credentialId: "credential-1",
      grantVersion: "grant-1",
    },
    node: { nodeId: NODE_ID, paseoServerId: "server-1", mode: "managed" as const },
    sessionBindingGeneration: "session-1",
  };
}

describe("browser page identity observation dispatcher", () => {
  test("injects authenticated Session identity into strict observation and invalidation handlers", async () => {
    const registry = new BrowserPageIdentityRegistry({ profiles: { get: async () => profile } });
    registry.registerBrowser({
      host: createAuthenticatedBrowserHostSession({
        clientId: "desktop-client-1",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-1",
      }),
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: "binding-1",
    });
    const registration = createBrowserPageIdentityObservationDispatcherRegistration({ registry });
    expect(registration?.manifest.operations).toEqual([
      "enterprise.browser.page_identity.observe.request",
    ]);
    const invalidationRegistration = createBrowserPageIdentityInvalidationDispatcherRegistration({
      registry,
    });
    expect(invalidationRegistration?.manifest.operations).toEqual([
      "enterprise.browser.page_identity.invalidate.request",
    ]);
    const context = sessionContext();
    const lease = registration!.open({
      sessionId: "session-id-1",
      clientId: "desktop-client-1",
      context,
    });
    const invalidationLease = invalidationRegistration!.open({
      sessionId: "session-id-1",
      clientId: "desktop-client-1",
      context,
    });
    expect(
      lease.dispatcher.requestPolicyForType?.("enterprise.browser.page_identity.observe.request"),
    ).toBe("transport_control");
    expect(
      lease.dispatcher.requestPolicyForType?.(
        "enterprise.browser.page_identity.invalidate.request",
      ),
    ).toBeNull();
    expect(
      invalidationLease.dispatcher.requestPolicyForType?.(
        "enterprise.browser.page_identity.invalidate.request",
      ),
    ).toBe("transport_control");
    expect(
      invalidationLease.dispatcher.requestPolicyForType?.(
        "enterprise.browser.page_identity.observe.request",
      ),
    ).toBeNull();
    expect(invalidationLease.dispatcher.requestPolicyForType?.("browser.list")).toBeNull();
    const dispatchContext = {
      sessionId: "session-id-1",
      clientId: "desktop-client-1",
      credentialId: "credential-1",
      sessionBindingGeneration: "session-1",
      enterpriseContext: context,
    };

    await expect(
      lease.dispatcher.handle({
        sessionContext: dispatchContext,
        message: {
          type: "enterprise.browser.page_identity.observe.request",
          requestId: "observe-1",
          browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
          hostname: "shop.example",
          observationRevision: "observation-1",
          bindingRevision: "binding-1",
          lifecycleGeneration: "session-1",
        },
      }),
    ).resolves.toEqual({
      type: "enterprise.browser.page_identity.observe.response",
      payload: { requestId: "observe-1", acceptedRevision: "observation-1" },
    });
    const proof = await registry.verify({
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: "binding-1",
    });
    expect(proof).toMatchObject({ hostClientId: "desktop-client-1", homeNodeId: NODE_ID });
    await expect(
      invalidationLease.dispatcher.handle({
        sessionContext: dispatchContext,
        message: {
          type: "enterprise.browser.page_identity.invalidate.request",
          requestId: "invalidate-1",
          browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
          observationRevision: "observation-1",
          bindingRevision: "binding-1",
          lifecycleGeneration: "session-1",
        },
      }),
    ).resolves.toEqual({
      type: "enterprise.browser.page_identity.invalidate.response",
      payload: { requestId: "invalidate-1", acceptedRevision: "observation-1" },
    });
    await expect(registry.recheck(proof)).rejects.toMatchObject({
      reasonCode: "observation_stale",
    });

    await lease.close();
    await invalidationLease.close();
    await expect(
      registry.verify({
        browserId: BROWSER_ID,
        browserProfileId: PROFILE_ID,
        bindingRevision: "binding-1",
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
  });

  test("rejects stale Session tuples, structural registry imposters, and rebound wire identity", async () => {
    expect(
      createBrowserPageIdentityObservationDispatcherRegistration({
        registry: { observe: async () => "caller" } as never,
      }),
    ).toBeNull();
    expect(
      createBrowserPageIdentityInvalidationDispatcherRegistration({
        registry: { invalidateObservation: async () => "caller" } as never,
      }),
    ).toBeNull();

    const registry = new BrowserPageIdentityRegistry({ profiles: { get: async () => profile } });
    registry.registerBrowser({
      host: createAuthenticatedBrowserHostSession({
        clientId: "desktop-client-1",
        homeNodeId: NODE_ID,
        sessionBindingGeneration: "session-1",
      }),
      browserId: BROWSER_ID,
      browserProfileId: PROFILE_ID,
      bindingRevision: "binding-1",
    });
    const context = sessionContext();
    const lease = createBrowserPageIdentityObservationDispatcherRegistration({ registry })!.open({
      sessionId: "session-id-1",
      clientId: "desktop-client-1",
      context,
    });
    const invalidationLease = createBrowserPageIdentityInvalidationDispatcherRegistration({
      registry,
    })!.open({
      sessionId: "session-id-1",
      clientId: "desktop-client-1",
      context,
    });
    const message = {
      type: "enterprise.browser.page_identity.observe.request" as const,
      requestId: "observe-1",
      browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
      hostname: "shop.example",
      observationRevision: "observation-1",
      bindingRevision: "binding-rebound",
      lifecycleGeneration: "session-1",
    };

    await expect(
      lease.dispatcher.handle({
        sessionContext: {
          sessionId: "session-id-1",
          clientId: "other-client",
          credentialId: "credential-1",
          sessionBindingGeneration: "session-1",
          enterpriseContext: context,
        },
        message,
      }),
    ).resolves.toBe(false);
    await expect(
      lease.dispatcher.handle({
        sessionContext: {
          sessionId: "session-id-1",
          clientId: "desktop-client-1",
          credentialId: "credential-1",
          sessionBindingGeneration: "session-1",
          enterpriseContext: context,
        },
        message,
      }),
    ).resolves.toBe(false);
    await expect(
      invalidationLease.dispatcher.handle({
        sessionContext: {
          sessionId: "session-id-1",
          clientId: "other-client",
          credentialId: "credential-1",
          sessionBindingGeneration: "session-1",
          enterpriseContext: context,
        },
        message: {
          type: "enterprise.browser.page_identity.invalidate.request",
          requestId: "invalidate-1",
          browser: { browserId: BROWSER_ID, browserProfileId: PROFILE_ID },
          observationRevision: "observation-1",
          bindingRevision: "binding-1",
          lifecycleGeneration: "session-1",
        },
      }),
    ).resolves.toBe(false);
  });
});
