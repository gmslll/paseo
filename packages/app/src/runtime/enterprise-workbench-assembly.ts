import type { EnterpriseIdentitySnapshot } from "@getpaseo/client/internal/enterprise-identity-lifecycle";
import {
  EnterpriseFeatureFlagsWireSchema,
  type BrowserProfileBindingProjection,
  type BrowserProfileSummary,
} from "@getpaseo/protocol/messages";

interface BrowserProfileProjectionHydrationInput {
  readonly serverId: string;
  readonly profiles: readonly BrowserProfileSummary[];
  readonly bindings: readonly BrowserProfileBindingProjection[];
  readonly lifecycleGeneration: string;
}

interface BrowserProfileProjectionRuntime {
  hydrateBrowserProfileAuthorizationsFromProjections(
    serverId: string,
    input: Omit<BrowserProfileProjectionHydrationInput, "serverId">,
  ): Promise<void>;
}

export function isEnterpriseWorkbenchSignedIn(
  snapshot: EnterpriseIdentitySnapshot | null,
): snapshot is EnterpriseIdentitySnapshot & {
  state: "signed_in";
  projection: NonNullable<EnterpriseIdentitySnapshot["projection"]>;
} {
  return (
    snapshot?.state === "signed_in" &&
    typeof snapshot.projection?.organizationId === "string" &&
    snapshot.projection.organizationId.length > 0
  );
}

export function isEnterpriseBrowserProfilesEnabled(capability: unknown): boolean {
  const parsed = EnterpriseFeatureFlagsWireSchema.safeParse(capability);
  return parsed.success && parsed.data.enterpriseBrowserProfilesV1 === true;
}

export function createBrowserProfileProjectionHydrator(
  runtime: BrowserProfileProjectionRuntime,
  serverId: string,
): (input: BrowserProfileProjectionHydrationInput) => Promise<void> {
  return (input) => {
    if (input.serverId !== serverId) {
      return Promise.reject(new Error("Browser profile hydration host does not match"));
    }
    return runtime.hydrateBrowserProfileAuthorizationsFromProjections(serverId, {
      profiles: input.profiles,
      bindings: input.bindings,
      lifecycleGeneration: input.lifecycleGeneration,
    });
  };
}
