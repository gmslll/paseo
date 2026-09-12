import type { BrowserProfileRuntimeAuthorization } from "../browser-profile.js";
import {
  BrowserProfileRuntimeAuthorizationRegistry,
  parseBrowserProfileRuntimeNodeId,
  parseBrowserProfileRuntimeSelector,
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

export class BrowserProfileAuthorizationRegistryRouter {
  private readonly registriesByNodeId = new Map<
    string,
    BrowserProfileRuntimeAuthorizationRegistry
  >();

  public constructor(
    private readonly createCleanup: (
      hostWebContentsId: number,
    ) => BrowserProfileAuthorizationCleanup,
  ) {}

  public async hydrate(input: {
    hostWebContentsId: number;
    homeNodeId: string;
    authorizations: readonly unknown[];
    lifecycleGeneration: string;
  }): Promise<readonly BrowserProfileRuntimeAuthorization[]> {
    const homeNodeId = parseBrowserProfileRuntimeNodeId(input.homeNodeId);
    const existing = this.registriesByNodeId.get(homeNodeId);
    const registry = existing ?? new BrowserProfileRuntimeAuthorizationRegistry(homeNodeId);
    const revoked = await createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: input.hostWebContentsId,
      cleanup: this.createCleanup(input.hostWebContentsId),
    }).hydrate(input.authorizations, input.lifecycleGeneration);
    if (!existing) this.registriesByNodeId.set(homeNodeId, registry);
    return revoked;
  }

  public async revoke(input: {
    hostWebContentsId: number;
    homeNodeId: string;
    lifecycleGeneration: string;
  }): Promise<readonly BrowserProfileRuntimeAuthorization[]> {
    const homeNodeId = parseBrowserProfileRuntimeNodeId(input.homeNodeId);
    const registry = this.registriesByNodeId.get(homeNodeId);
    if (!registry) return Object.freeze([]);
    return createBrowserProfileAuthorizationHandler({
      registry,
      hostWebContentsId: input.hostWebContentsId,
      cleanup: this.createCleanup(input.hostWebContentsId),
    }).revoke(input.lifecycleGeneration);
  }

  public resolveExact(
    hostWebContentsId: number,
    selectorInput: unknown,
  ): BrowserProfileRuntimeAuthorization | null {
    const selector = parseBrowserProfileRuntimeSelector(selectorInput);
    return (
      this.registriesByNodeId.get(selector.homeNodeId)?.resolveExact(hostWebContentsId, selector) ??
      null
    );
  }

  public async revokeHost(
    hostWebContentsId: number,
  ): Promise<readonly BrowserProfileRuntimeAuthorization[]> {
    const revoked = [...this.registriesByNodeId.values()].flatMap((registry) =>
      registry.revokeHost(hostWebContentsId),
    );
    await cleanupRevoked(revoked, this.createCleanup(hostWebContentsId));
    return Object.freeze(revoked);
  }
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
