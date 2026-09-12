import type { PatAuthenticationPortResult } from "@/stores/enterprise/pat-login-form-model";
import { normalizeEnterpriseIdentityReason } from "@/stores/enterprise/display-policy";
import type {
  BossResourceContentReadInput,
  BossResourceContentReadResult,
  BossResourceStorePort,
} from "@/stores/enterprise/boss-resource-store";
import type { GrantEditorPort } from "./forms/grant-editor-form-model";
import type {
  BrowserBindingFormPort,
  BrowserBindingPortBindInput,
  BrowserBindingPortInput,
} from "./forms/browser-binding-form-model";
import {
  EnterpriseIdentityGetCurrentResponseSchema,
  EnterpriseBrowserBindProfileResponseSchema,
  EnterpriseBrowserListProfilesResponseSchema,
  type BrowserProfileBindingProjection,
  type BrowserProfileSummary,
  type CurrentIdentityProjection,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  EnterpriseIdentityLifecycle,
  EnterpriseIdentitySnapshot,
} from "@getpaseo/client/internal/enterprise-identity-lifecycle";

/**
 * UI-only seam. The root adapter supplies W3 lifecycle snapshots and W0/W2 typed ports;
 * The token is passed only as an invocation argument to the W3 adapter; it is not retained in
 * snapshots, wire state, or this UI seam. Handles and receipts never cross this boundary.
 */
export interface EnterpriseUiPort<TSessionGeneration extends string> {
  authenticatePat(input: {
    readonly serverId: string;
    readonly token: string;
    readonly signal: AbortSignal;
  }): Promise<PatAuthenticationPortResult<unknown>>;
  logoutCurrent(): Promise<void>;
  logoutAll(): Promise<void>;
  refreshScope(sessionGeneration: TSessionGeneration): Promise<void>;
}

export interface EnterprisePrincipalDirectoryPortInput<TGeneration extends string> {
  readonly requestId: string;
  readonly sessionGeneration: TGeneration;
  readonly signal: AbortSignal;
}

export interface EnterprisePrincipalDirectoryPort<TGeneration extends string> {
  listPrincipals(input: EnterprisePrincipalDirectoryPortInput<TGeneration>): Promise<unknown>;
}

export interface EnterpriseContentReaders<TGeneration extends string, TContent> {
  readonly workspace: (
    input: BossResourceContentReadInput<TGeneration>,
  ) => Promise<BossResourceContentReadResult>;
  readonly agent: (
    input: BossResourceContentReadInput<TGeneration>,
  ) => Promise<BossResourceContentReadResult>;
  readonly browserProfile: (
    input: BossResourceContentReadInput<TGeneration>,
  ) => Promise<BossResourceContentReadResult>;
  readonly appSlot: (
    input: BossResourceContentReadInput<TGeneration>,
  ) => Promise<BossResourceContentReadResult>;
  readonly contentType?: TContent;
}

export interface EnterpriseUiBundle<TGeneration extends string, TContent> {
  readonly lifecycle: EnterpriseIdentityLifecycle;
  readonly uiPort: EnterpriseUiPort<TGeneration>;
  readonly principalPort: EnterprisePrincipalDirectoryPort<TGeneration>;
  readonly resourcePort: BossResourceStorePort<TGeneration>;
  readonly grantPort: GrantEditorPort<TGeneration>;
  readonly browserPort: BrowserBindingFormPort<TGeneration>;
  readonly readIdentitySnapshot: () => EnterpriseIdentitySnapshot;
  readonly subscribeIdentity: (
    listener: (snapshot: EnterpriseIdentitySnapshot) => void,
  ) => () => void;
  /** Resource-specific readers remain host-injected; no generic content RPC is introduced here. */
  readonly contentReaders: EnterpriseContentReaders<TGeneration, TContent>;
}

export interface EnterpriseUiBundleOptions<TGeneration extends string, TContent> {
  readonly lifecycle: EnterpriseIdentityLifecycle;
  readonly daemonClient: DaemonClient;
  readonly serverId: string;
  readonly contentReaders: EnterpriseContentReaders<TGeneration, TContent>;
  readonly browserProfilesEnabled?: () => boolean;
  readonly hydrateBrowserProfileAuthorizations?: EnterpriseBrowserAuthorizationHydrator<TGeneration>;
}

export type EnterpriseBrowserAuthorizationHydrator<TGeneration extends string> = (input: {
  readonly serverId: string;
  readonly profiles: readonly BrowserProfileSummary[];
  readonly bindings: readonly BrowserProfileBindingProjection[];
  readonly lifecycleGeneration: TGeneration;
}) => Promise<void>;

function abortError(): Error {
  return new Error("The enterprise request was aborted");
}

function requestWithSignal<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void request().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        return reject(error);
      },
    );
  });
}

function generationMatches<TGeneration extends string>(
  lifecycle: EnterpriseIdentityLifecycle,
  generation: TGeneration,
): boolean {
  const snapshot = lifecycle.readSnapshot();
  return snapshot.state === "signed_in" && String(snapshot.generation) === generation;
}

function hasSameFence(
  lifecycle: EnterpriseIdentityLifecycle,
  expected: {
    readonly serverId: string;
    readonly generation: string;
    readonly sessionBindingKey: string;
  },
): boolean {
  const snapshot = lifecycle.readSnapshot();
  return (
    snapshot.state === "signed_in" &&
    String(snapshot.generation) === expected.generation &&
    snapshot.sessionBindingKey === expected.sessionBindingKey &&
    snapshot.projection?.paseoServerId === expected.serverId
  );
}

/**
 * Build the production W6 adapter from root-owned W3 lifecycle/client instances.
 * PAT is an invocation-only argument to W3 and never appears in this bundle's state.
 */
export function createEnterpriseUiBundle<TGeneration extends string, TContent>(
  options: EnterpriseUiBundleOptions<TGeneration, TContent>,
): EnterpriseUiBundle<TGeneration, TContent> {
  const { lifecycle, daemonClient, serverId, contentReaders } = options;
  const browserProfilesEnabled = options.browserProfilesEnabled;
  const hydrateBrowserProfileAuthorizations = options.hydrateBrowserProfileAuthorizations;
  let hydratedProfiles: readonly BrowserProfileSummary[] = [];
  let hydratedBindings: readonly BrowserProfileBindingProjection[] = [];
  const request = <T>(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    requestId: string,
    signal: AbortSignal,
    generation: TGeneration,
  ) => {
    const start = lifecycle.readSnapshot();
    if (
      start.state !== "signed_in" ||
      String(start.generation) !== generation ||
      !start.sessionBindingKey ||
      start.projection?.paseoServerId !== serverId
    )
      return Promise.reject<T>(new Error("identity.generation_changed"));
    const fence = {
      serverId,
      generation: String(start.generation),
      sessionBindingKey: start.sessionBindingKey,
    };
    return requestWithSignal(
      signal,
      () => daemonClient.requestEnterprise(type, payload, requestId) as Promise<T>,
    ).then((response) => {
      if (!hasSameFence(lifecycle, fence)) throw new Error("identity.generation_changed");
      return response;
    });
  };

  const uiPort: EnterpriseUiPort<TGeneration> = {
    authenticatePat: async ({ serverId: requestedServerId, token, signal }) => {
      if (requestedServerId !== serverId) return { ok: false, reasonCode: "identity.unavailable" };
      try {
        const snapshot = await lifecycle.authenticateEnterpriseHost({
          serverId: requestedServerId,
          token,
          signal,
        });
        return { ok: true, value: snapshot };
      } catch (error) {
        return {
          ok: false,
          reasonCode: normalizeEnterpriseIdentityReason(
            error instanceof Error ? error.message : undefined,
          ),
        };
      }
    },
    logoutCurrent: () => lifecycle.logoutCurrent(serverId),
    logoutAll: () => lifecycle.logoutAll(),
    refreshScope: async (generation) => {
      const start = lifecycle.readSnapshot();
      if (
        start.state !== "signed_in" ||
        String(start.generation) !== generation ||
        !start.sessionBindingKey ||
        start.projection?.paseoServerId !== serverId
      )
        throw new Error("identity.generation_changed");
      const requestId = `identity-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await daemonClient.requestEnterprise(
        "enterprise.identity.get_current.request",
        { requestId },
        requestId,
      );
      const parsed = EnterpriseIdentityGetCurrentResponseSchema.shape.payload.safeParse(response);
      if (
        !parsed.success ||
        !hasSameFence(lifecycle, {
          serverId,
          generation: String(start.generation),
          sessionBindingKey: start.sessionBindingKey,
        }) ||
        parsed.data.identity.paseoServerId !== serverId
      ) {
        throw new Error("identity.invalid_response");
      }
      const startGeneration = start.generation;
      const startBinding = start.sessionBindingKey;
      if (!startGeneration || !startBinding) throw new Error("identity.generation_changed");
      await lifecycle.scopeRefreshed({
        serverId,
        generation: startGeneration,
        sessionBindingKey: startBinding,
        projection: parsed.data.identity as CurrentIdentityProjection,
      });
    },
  };

  const resourcePort: BossResourceStorePort<TGeneration> = {
    listOrganizationResources: ({ requestId, cursor, sessionGeneration, signal }) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      return request(
        "enterprise.organization.list_resources.request",
        { requestId, ...(cursor ? { cursor } : {}) },
        requestId,
        signal,
        sessionGeneration,
      );
    },
    readWorkspaceContent: contentReaders.workspace,
    readAgentContent: contentReaders.agent,
    readBrowserProfileContent: contentReaders.browserProfile,
    readAppSlotContent: contentReaders.appSlot,
  };

  const principalPort: EnterprisePrincipalDirectoryPort<TGeneration> = {
    listPrincipals: ({ requestId, sessionGeneration, signal }) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      return request(
        "enterprise.identity.list_principals.request",
        { requestId },
        requestId,
        signal,
        sessionGeneration,
      );
    },
  };

  const grantPort: GrantEditorPort<TGeneration> = {
    listGrants: ({ requestId, principalId, sessionGeneration, signal }) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      return request(
        "enterprise.access.list_grants.request",
        { requestId, principalId },
        requestId,
        signal,
        sessionGeneration,
      );
    },
    updateGrants: ({
      requestId,
      principalId,
      grants,
      expectedRevision,
      sessionGeneration,
      signal,
    }) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      return request(
        "enterprise.access.update_grants.request",
        { requestId, principalId, grants, expectedRevision },
        requestId,
        signal,
        sessionGeneration,
      );
    },
  };

  const browserPort: BrowserBindingFormPort<TGeneration> = {
    listProfiles: ({
      workspaceId,
      requestId,
      sessionGeneration,
      signal,
    }: BrowserBindingPortInput<TGeneration>) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      if (browserProfilesEnabled?.() !== true || !hydrateBrowserProfileAuthorizations)
        return Promise.reject(new Error("enterprise.browser.feature_unavailable"));
      return request(
        "enterprise.browser.list_profiles.request",
        { requestId, workspaceId },
        requestId,
        signal,
        sessionGeneration,
      ).then(async (response) => {
        const parsed = EnterpriseBrowserListProfilesResponseSchema.safeParse(response);
        if (parsed.success) {
          const nextProfiles = parsed.data.payload.profiles;
          const nextBindings = parsed.data.payload.bindings;
          await hydrateBrowserProfileAuthorizations({
            serverId,
            profiles: nextProfiles,
            bindings: nextBindings,
            lifecycleGeneration: sessionGeneration,
          });
          hydratedProfiles = nextProfiles;
          hydratedBindings = nextBindings;
        }
        return response;
      });
    },
    bindProfile: ({
      workspaceId,
      browserProfileId,
      requestId,
      sessionGeneration,
      signal,
    }: BrowserBindingPortBindInput<TGeneration>) => {
      if (!generationMatches(lifecycle, sessionGeneration))
        return Promise.reject(new Error("identity.generation_changed"));
      if (browserProfilesEnabled?.() !== true || !hydrateBrowserProfileAuthorizations)
        return Promise.reject(new Error("enterprise.browser.feature_unavailable"));
      return request(
        "enterprise.browser.bind_profile.request",
        { requestId, workspaceId, browserProfileId },
        requestId,
        signal,
        sessionGeneration,
      ).then(async (response) => {
        const parsed = EnterpriseBrowserBindProfileResponseSchema.safeParse(response);
        if (parsed.success) {
          const binding = parsed.data.payload.binding;
          const nextBindings = [
            ...hydratedBindings.filter(
              (candidate) => candidate.workspaceId !== binding.workspaceId,
            ),
            binding,
          ];
          await hydrateBrowserProfileAuthorizations({
            serverId,
            profiles: hydratedProfiles,
            bindings: nextBindings,
            lifecycleGeneration: sessionGeneration,
          });
          hydratedBindings = nextBindings;
        }
        return response;
      });
    },
  };

  return Object.freeze({
    lifecycle,
    uiPort,
    principalPort,
    resourcePort,
    grantPort,
    browserPort,
    contentReaders,
    readIdentitySnapshot: () => lifecycle.readSnapshot(),
    subscribeIdentity: (listener: (snapshot: EnterpriseIdentitySnapshot) => void) =>
      lifecycle.subscribe(listener),
  });
}
