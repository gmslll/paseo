import type {
  BrowserProfileRuntimeAuthorization,
  BrowserProfileRuntimeAuthorizationRegistry,
} from "../browser-profile.js";

export const HYDRATE_BROWSER_PROFILE_AUTHORIZATIONS_CHANNEL =
  "paseo:browser-profile:hydrate-authorizations" as const;
export const REVOKE_BROWSER_PROFILE_GENERATION_CHANNEL =
  "paseo:browser-profile:revoke-generation" as const;

export interface BrowserProfileAuthorizationBridge {
  hydrate(input: {
    authorizations: readonly BrowserProfileRuntimeAuthorization[];
    lifecycleGeneration: string;
  }): Promise<readonly BrowserProfileRuntimeAuthorization[]>;
  revoke(input: { lifecycleGeneration: string }): Promise<readonly BrowserProfileRuntimeAuthorization[]>;
}

export function createBrowserProfileAuthorizationBridge(input: {
  registry: BrowserProfileRuntimeAuthorizationRegistry;
  hostWebContentsId: number;
}): BrowserProfileAuthorizationBridge {
  return {
    async hydrate(request) {
      return input.registry.hydrateGeneration(
        input.hostWebContentsId,
        request.authorizations,
        request.lifecycleGeneration,
      );
    },
    async revoke(request) {
      return input.registry.revokeGeneration(input.hostWebContentsId, request.lifecycleGeneration);
    },
  };
}
