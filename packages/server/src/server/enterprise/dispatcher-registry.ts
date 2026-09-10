import type { SessionOutboundMessage } from "../messages.js";
import type {
  EnterpriseDispatchResponse,
  EnterpriseResponseContextConsumer,
  EnterpriseSessionDispatcher,
} from "../session/enterprise-dispatcher.js";

export type EnterpriseFeatureFamily =
  | "identity"
  | "resourceAuthorization"
  | "browserProfiles"
  | "audit";

export interface EnterpriseDispatcherRegistration {
  readonly family: EnterpriseFeatureFamily;
  readonly requestTypes: readonly string[];
  readonly dispatcher: EnterpriseSessionDispatcher;
}

export type EnterpriseFeatureAdvertisement = Readonly<
  Partial<
    Record<
      | "enterpriseIdentityV1"
      | "enterpriseResourceAuthorizationV1"
      | "enterpriseBrowserProfilesV1"
      | "enterpriseAuditV1",
      true
    >
  >
>;

const familyFlags: Readonly<Record<EnterpriseFeatureFamily, keyof EnterpriseFeatureAdvertisement>> =
  Object.freeze({
    identity: "enterpriseIdentityV1",
    resourceAuthorization: "enterpriseResourceAuthorizationV1",
    browserProfiles: "enterpriseBrowserProfilesV1",
    audit: "enterpriseAuditV1",
  });

const requiredRequests: Readonly<Record<EnterpriseFeatureFamily, readonly string[]>> =
  Object.freeze({
    identity: Object.freeze([
      "enterprise.identity.get_current.request",
      "enterprise.identity.list_principals.request",
      "enterprise.identity.logout_all.request",
    ]),
    resourceAuthorization: Object.freeze([
      "enterprise.access.list_grants.request",
      "enterprise.access.update_grants.request",
      "enterprise.organization.list_resources.request",
      "enterprise.placement.resolve_workspace.request",
    ]),
    browserProfiles: Object.freeze([
      "enterprise.browser.list_profiles.request",
      "enterprise.browser.bind_profile.request",
      "enterprise.resource.acquire_lease.request",
      "enterprise.resource.renew_lease.request",
      "enterprise.resource.release_lease.request",
    ]),
    audit: Object.freeze(["enterprise.audit.list_events.request"]),
  });

export interface EnterpriseDispatcherRegistry extends EnterpriseSessionDispatcher {
  readonly features: EnterpriseFeatureAdvertisement;
  readonly registeredRequestTypes: readonly string[];
}

export function createEnterpriseDispatcherRegistry(
  registrations: readonly EnterpriseDispatcherRegistration[],
): EnterpriseDispatcherRegistry {
  const requestMap = new Map<string, EnterpriseSessionDispatcher>();
  const familyComplete = new Map<EnterpriseFeatureFamily, boolean>();
  const seenFamilies = new Set<EnterpriseFeatureFamily>();
  for (const family of Object.keys(familyFlags) as EnterpriseFeatureFamily[]) {
    familyComplete.set(family, false);
  }
  for (const registration of registrations) {
    if (!familyFlags[registration.family] || registration.requestTypes.length === 0) {
      throw new Error("Invalid enterprise dispatcher registration");
    }
    if (seenFamilies.has(registration.family)) {
      throw new Error(`Duplicate enterprise dispatcher family: ${registration.family}`);
    }
    seenFamilies.add(registration.family);
    for (const requestType of registration.requestTypes) {
      if (!requestType || requestMap.has(requestType)) {
        throw new Error(`Duplicate enterprise dispatcher request: ${requestType}`);
      }
      requestMap.set(requestType, registration.dispatcher);
    }
    const registered = new Set(
      registrations
        .filter((candidate) => candidate.family === registration.family)
        .flatMap((candidate) => candidate.requestTypes),
    );
    familyComplete.set(
      registration.family,
      requiredRequests[registration.family].every((requestType) => registered.has(requestType)),
    );
  }
  const features = Object.freeze({
    ...(familyComplete.get("identity") === true ? { enterpriseIdentityV1: true as const } : {}),
    ...(familyComplete.get("resourceAuthorization") === true
      ? { enterpriseResourceAuthorizationV1: true as const }
      : {}),
    ...(familyComplete.get("browserProfiles") === true
      ? { enterpriseBrowserProfilesV1: true as const }
      : {}),
    ...(familyComplete.get("audit") === true ? { enterpriseAuditV1: true as const } : {}),
  }) satisfies EnterpriseFeatureAdvertisement;
  const registeredRequestTypes = Object.freeze([...requestMap.keys()].sort());
  const registry: EnterpriseDispatcherRegistry = {
    features,
    registeredRequestTypes,
    requestPolicyForType: (requestType) => {
      const dispatcher = requestMap.get(requestType);
      if (!dispatcher?.requestPolicyForType) return null;
      try {
        return dispatcher.requestPolicyForType(requestType);
      } catch {
        return null;
      }
    },
    handle: async ({ sessionContext, message }): Promise<SessionOutboundMessage | false> => {
      const dispatcher = requestMap.get(message.type);
      if (!dispatcher) return false;
      const result = await dispatcher.handle({ sessionContext, message });
      return result === false ? false : result;
    },
    consumeResponse: ((input): EnterpriseDispatchResponse | null => {
      const { sessionContext, message, response } = input;
      const dispatcher = requestMap.get(input.message.type);
      if (!dispatcher?.consumeResponse) {
        return {
          response,
          receiptClassification: "authority",
        };
      }
      return dispatcher.consumeResponse({ sessionContext, message, response });
    }) satisfies EnterpriseResponseContextConsumer["consumeResponse"],
  };
  return Object.freeze(registry);
}
