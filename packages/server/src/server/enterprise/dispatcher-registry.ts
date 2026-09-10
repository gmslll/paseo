import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResponse,
  EnterpriseResponseContextConsumer,
  EnterpriseDispatcherLease,
  EnterpriseDispatcherManifest,
  EnterpriseSessionDispatcherFactoryRegistration,
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

/**
 * Combines per-session family registrations into the single registration slot
 * accepted by Session. Registrations remain opaque and are opened only after a
 * Session has a nominal authorization runtime; no authority is reconstructed
 * from structural context here.
 */
export function createEnterpriseSessionDispatcherRegistration(
  registrations: readonly EnterpriseSessionDispatcherFactoryRegistration[],
): EnterpriseSessionDispatcherFactoryRegistration | null {
  if (registrations.length === 0) return null;
  const operations: string[] = [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (!isValidManifest(registration.manifest)) return null;
    for (const operation of registration.manifest.operations) {
      if (seen.has(operation)) return null;
      seen.add(operation);
      operations.push(operation);
    }
  }
  const manifest: EnterpriseDispatcherManifest = Object.freeze({
    operations: Object.freeze(operations),
  });
  return Object.freeze({
    manifest,
    open(input: Parameters<EnterpriseSessionDispatcherFactoryRegistration["open"]>[0]) {
      const leases: EnterpriseDispatcherLease[] = [];
      try {
        for (const registration of registrations) leases.push(registration.open(input));
      } catch (error) {
        const rollbackErrors = closeLeasesCollectingErrors(leases);
        if (rollbackErrors.length > 0)
          // oxlint-disable-next-line preserve-caught-error -- retain primary and rollback failures.
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Enterprise dispatcher open failed",
            {
              cause: error,
            },
          );
        throw error;
      }
      const active = { value: true };
      const requestMap = new Map<string, EnterpriseSessionDispatcher>();
      for (let index = 0; index < leases.length; index += 1) {
        for (const requestType of registrations[index].manifest.operations)
          requestMap.set(requestType, leases[index].dispatcher);
      }
      const dispatcher: EnterpriseSessionDispatcher = Object.freeze({
        requestPolicyForType: (requestType: string) => {
          if (!active.value) return null;
          const delegate = requestMap.get(requestType);
          if (!delegate?.requestPolicyForType) return null;
          try {
            return delegate.requestPolicyForType(requestType);
          } catch {
            return null;
          }
        },
        handle: async ({
          sessionContext,
          message,
        }: {
          readonly sessionContext: EnterpriseDispatchContext;
          readonly message: SessionInboundMessage;
        }) => {
          if (!active.value) return false;
          const delegate = requestMap.get(message.type);
          if (!delegate) return false;
          try {
            const result = await delegate.handle({ sessionContext, message });
            return active.value && result !== false ? result : false;
          } catch {
            return false;
          }
        },
        consumeResponse: ({
          sessionContext,
          message,
          response,
        }: Parameters<EnterpriseResponseContextConsumer["consumeResponse"]>[0]) => {
          if (!active.value) return null;
          const delegate = requestMap.get(message.type);
          if (!delegate?.consumeResponse)
            return delegate?.requestPolicyForType?.(message.type) === "resources"
              ? null
              : { response, receiptClassification: "authority" as const };
          try {
            return delegate.consumeResponse({ sessionContext, message, response });
          } catch {
            return null;
          }
        },
      });
      return Object.freeze({
        dispatcher,
        close: async () => {
          if (!active.value) return;
          active.value = false;
          const errors: unknown[] = [];
          for (let index = leases.length - 1; index >= 0; index -= 1) {
            try {
              await leases[index].close();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1)
            throw new AggregateError(errors, "Enterprise dispatcher lease cleanup failed", {
              cause: errors[0],
            });
        },
      });
    },
  });
}

function isValidManifest(
  value: EnterpriseDispatcherManifest | undefined,
): value is EnterpriseDispatcherManifest {
  return Boolean(
    value &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.every((operation) => typeof operation === "string" && operation.length > 0),
  );
}

function closeLeasesCollectingErrors(leases: readonly EnterpriseDispatcherLease[]): unknown[] {
  const errors: unknown[] = [];
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      const result = leases[index].close();
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        void Promise.resolve(result).catch(() => undefined);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
