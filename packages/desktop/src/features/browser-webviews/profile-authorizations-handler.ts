import type { BrowserProfileRuntimeAuthorizationRegistry } from "../browser-profile.js";

export interface BrowserProfileAuthorizationCleanup {
  unregisterProfile(profileId: string): void | Promise<void>;
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
      const revoked = input.registry.hydrateGeneration(input.hostWebContentsId, authorizations, lifecycleGeneration);
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
  revoked: readonly { browserProfileId: string }[],
  cleanup: BrowserProfileAuthorizationCleanup,
): Promise<void> {
  const errors: unknown[] = [];
  for (const authorization of revoked) {
    try {
      await cleanup.unregisterProfile(authorization.browserProfileId);
      for (const guest of cleanup.findGuests(authorization.browserProfileId)) {
        try { await cleanup.destroyGuest(guest); await cleanup.cleanupGuest?.(guest); } catch (error) { errors.push(error); }
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Browser Profile authorization cleanup failed.", { cause: errors[0] });
}
