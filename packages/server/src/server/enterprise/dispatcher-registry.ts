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

export interface EnterpriseFeatureAdvertisement {
  readonly enterpriseIdentityV1: boolean;
  readonly enterpriseResourceAuthorizationV1: boolean;
  readonly enterpriseBrowserProfilesV1: boolean;
  readonly enterpriseAuditV1: boolean;
}

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
    enterpriseIdentityV1: familyComplete.get("identity") === true,
    enterpriseResourceAuthorizationV1: familyComplete.get("resourceAuthorization") === true,
    enterpriseBrowserProfilesV1: familyComplete.get("browserProfiles") === true,
    enterpriseAuditV1: familyComplete.get("audit") === true,
  });
  const registeredRequestTypes = Object.freeze([...requestMap.keys()].sort());
  const registry: EnterpriseDispatcherRegistry = {
    features,
    registeredRequestTypes,
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
