import type {
  BrowserProfileRuntimeAuthorization,
  BrowserProfileRuntimeAuthorizationRegistry,
} from "../browser-profile.js";

export interface BrowserProfileAuthorizationCleanup {
  unregisterProfile(authorization: BrowserProfileRuntimeAuthorization): void | Promise<void>;
  findGuests(profileId: string): readonly unknown[];
  destroyGuest(guest: unknown): void | Promise<void>;
  cleanupGuest?(guest: unknown): void | Promise<void>;
}

export function createBrowserProfileAuthorizationHandler(input: {
  registry: BrowserProfileRuntimeAuthorizationRegistry;
  hostWebContentsId: number;
  cleanup: BrowserProfileAuthorizationCleanup;
}) {
  return {
    async hydrate(authorizations: readonly unknown[], lifecycleGeneration: string) {
      const revoked = input.registry.hydrateGeneration(
        input.hostWebContentsId,
        authorizations,
        lifecycleGeneration,
      );
      await cleanupRevoked(revoked, input.cleanup);
      return revoked;
    },
    async revoke(lifecycleGeneration: string) {
      const revoked = input.registry.revokeGeneration(input.hostWebContentsId, lifecycleGeneration);
      await cleanupRevoked(revoked, input.cleanup);
      return revoked;
    },
  };
}

async function cleanupRevoked(
  revoked: readonly BrowserProfileRuntimeAuthorization[],
  cleanup: BrowserProfileAuthorizationCleanup,
): Promise<void> {
  const errors: unknown[] = [];
  for (const authorization of revoked) {
    try {
      await cleanup.unregisterProfile(authorization);
    } catch (error) {
      errors.push(error);
    }
    let guests: readonly unknown[] = [];
    try {
      guests = cleanup.findGuests(authorization.browserProfileId);
    } catch (error) {
      errors.push(error);
    }
    for (const guest of guests) {
      try {
        await cleanup.destroyGuest(guest);
      } catch (error) {
        errors.push(error);
      }
      try {
        await cleanup.cleanupGuest?.(guest);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, "Browser Profile authorization cleanup failed.", {
      cause: errors[0],
    });
}
