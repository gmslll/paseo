import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  createBrowserProfileProjectionHydrator,
  isEnterpriseBrowserProfilesEnabled,
  isEnterpriseIdentityEnabled,
  isEnterpriseWorkbenchSignedIn,
} from "@/runtime/enterprise-workbench-assembly";
import {
  getHostRuntimeStore,
  useHostEnterpriseIdentityLifecycle,
  useHostEnterpriseIdentitySnapshot,
  useHosts,
  useHostRuntimeClient,
} from "@/runtime/host-runtime";
import {
  isAbortError,
  resolveUnsignedEnterpriseAccess,
  type UnsignedEnterpriseDiscovery,
} from "@/runtime/unsigned-enterprise-access";
import { useSessionStore } from "@/stores/session-store";
import { createBossResourceStore } from "@/stores/enterprise/boss-resource-store";
import { createPatLoginFormModel } from "@/stores/enterprise/pat-login-form-model";
import {
  EnterprisePasswordLoginForm,
  EnterprisePatLoginForm,
} from "@/components/enterprise/enterprise-identity-ui";
import { EnterpriseWorkbenchContainer } from "@/screens/enterprise/enterprise-workbench-screen";
import {
  createEnterpriseUiBundle,
  type EnterpriseContentReaders,
} from "@/screens/enterprise/enterprise-ui-port";
import { createGrantEditorFormModel } from "@/screens/enterprise/forms/grant-editor-form-model";
import { createBrowserBindingFormModel } from "@/screens/enterprise/forms/browser-binding-form-model";
import type {
  EnterpriseBrowserBindingFactory,
  EnterpriseGrantEditorFactory,
} from "@/screens/enterprise/enterprise-admin-controls";

const unavailableContentReaders: EnterpriseContentReaders<string, never> = {
  workspace: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  agent: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  browserProfile: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  appSlot: async () => Promise.reject(new Error("enterprise.content.unavailable")),
};

/** Root assembly for the host scoped enterprise workbench. Content readers stay unavailable until
 * each resource type has a production port; this component never invents a generic reader. */

function useManagedNodeDiscovery(serverId: string): UnsignedEnterpriseDiscovery {
  const [discovery, setDiscovery] = useState<UnsignedEnterpriseDiscovery>("pending");
  useEffect(() => {
    const controller = new AbortController();
    setDiscovery("pending");
    void getHostRuntimeStore()
      .discoverEnterpriseManagement(serverId, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setDiscovery(value !== null ? "managed" : "standalone");
        return undefined;
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isAbortError(error)) setDiscovery("pending");
      });
    return () => controller.abort();
  }, [serverId]);
  return discovery;
}

function useEnterprisePasswordAuthenticator(serverId: string) {
  return useCallback(
    async (username: string, password: string, signal: AbortSignal) => {
      try {
        const snapshot = await getHostRuntimeStore().authenticateEnterpriseHostWithPassword(
          serverId,
          { username, password, signal },
        );
        return { ok: true as const, value: snapshot };
      } catch (error) {
        return {
          ok: false as const,
          reasonCode:
            error instanceof Error && error.message === "identity.invalid_password"
              ? "identity.invalid_password"
              : "identity.unavailable",
        };
      }
    },
    [serverId],
  );
}

export function EnterpriseUnsignedAccessGate({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const identitySnapshot = useHostEnterpriseIdentitySnapshot(serverId);
  const lifecycle = useHostEnterpriseIdentityLifecycle(serverId);
  const discovery = useManagedNodeDiscovery(serverId);
  const authenticatePassword = useEnterprisePasswordAuthenticator(serverId);
  const access = resolveUnsignedEnterpriseAccess({
    signedIn: isEnterpriseWorkbenchSignedIn(identitySnapshot),
    hasLifecycle: lifecycle !== null,
    discovery,
  });
  if (access === "children") return children;
  if (access === "pending") {
    return <View testID="enterprise-unsigned-access-gate-pending" />;
  }
  return (
    <SafeAreaView testID="enterprise-unsigned-access-gate">
      <EnterprisePasswordLoginForm authenticate={authenticatePassword} />
    </SafeAreaView>
  );
}

export function EnterpriseUnsignedAccessGateForRegisteredHost({
  children,
}: {
  children: ReactNode;
}) {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId;
  if (!serverId) return children;
  return (
    <EnterpriseUnsignedAccessGate serverId={serverId}>{children}</EnterpriseUnsignedAccessGate>
  );
}

export function EnterpriseWorkbenchHost({ serverId }: { serverId: string }) {
  const lifecycle = useHostEnterpriseIdentityLifecycle(serverId);
  const identitySnapshot = useHostEnterpriseIdentitySnapshot(serverId);
  const daemonClient = useHostRuntimeClient(serverId);
  const discovery = useManagedNodeDiscovery(serverId);
  const capability = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features ?? null,
  );
  const browserProfilesEnabled = useCallback(
    () => isEnterpriseBrowserProfilesEnabled(capability),
    [capability],
  );
  const hydrateBrowserProfileAuthorizations = useMemo(
    () => createBrowserProfileProjectionHydrator(getHostRuntimeStore(), serverId),
    [serverId],
  );
  const models = useMemo(() => {
    if (!lifecycle || !daemonClient) return null;
    void identitySnapshot?.generation;
    void identitySnapshot?.projection?.organizationId;
    return {
      lifecycle,
      daemonClient,
      serverId,
      contentReaders: unavailableContentReaders,
      browserProfilesEnabled,
      hydrateBrowserProfileAuthorizations,
    };
  }, [
    browserProfilesEnabled,
    daemonClient,
    hydrateBrowserProfileAuthorizations,
    identitySnapshot?.generation,
    identitySnapshot?.projection?.organizationId,
    lifecycle,
    serverId,
  ]);

  const bundle = useMemo(() => (models ? createEnterpriseUiBundle(models) : null), [models]);
  const isCurrentGeneration = useCallback(
    (generation: string) => {
      const snapshot = lifecycle?.readSnapshot();
      return snapshot?.state === "signed_in" && String(snapshot.generation) === generation;
    },
    [lifecycle],
  );
  const createGrantEditor = useCallback<EnterpriseGrantEditorFactory<string>>(
    (principalId) => {
      const snapshot = lifecycle?.readSnapshot();
      if (!bundle || !snapshot || snapshot.state !== "signed_in" || !snapshot.generation) {
        throw new Error("identity.generation_changed");
      }
      return createGrantEditorFormModel({
        principalId,
        sessionGeneration: String(snapshot.generation),
        port: bundle.grantPort,
        isCurrentSessionGeneration: isCurrentGeneration,
      });
    },
    [bundle, isCurrentGeneration, lifecycle],
  );
  const createBrowserBinding = useCallback<EnterpriseBrowserBindingFactory<string>>(
    (workspace) => {
      const snapshot = lifecycle?.readSnapshot();
      if (!bundle || !snapshot || snapshot.state !== "signed_in" || !snapshot.generation) {
        throw new Error("identity.generation_changed");
      }
      return createBrowserBindingFormModel({
        workspaceId: workspace.workspaceId,
        organizationId: workspace.organizationId,
        nodeId: workspace.nodeId,
        sessionGeneration: String(snapshot.generation),
        port: bundle.browserPort,
        isCurrentSessionGeneration: isCurrentGeneration,
      });
    },
    [bundle, isCurrentGeneration, lifecycle],
  );
  const authenticatePat = useCallback(
    (token: string, signal: AbortSignal) => {
      if (!bundle) {
        return Promise.reject(new Error("enterprise.identity.unavailable"));
      }
      return bundle.uiPort.authenticatePat({ serverId, token, signal });
    },
    [bundle, serverId],
  );
  const authenticatePassword = useEnterprisePasswordAuthenticator(serverId);
  const signedIn = isEnterpriseWorkbenchSignedIn(identitySnapshot);
  const bossStore = useMemo(
    () =>
      signedIn && models && bundle
        ? createBossResourceStore<never, string>({
            port: bundle.resourcePort,
            organizationId: identitySnapshot.projection.organizationId,
            createRequestId: () =>
              `enterprise-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            isCurrentOrganizationScope: (organizationId) =>
              models.lifecycle.readSnapshot().projection?.organizationId === organizationId,
            isCurrentSessionGeneration: (generation) => {
              const snapshot = models.lifecycle.readSnapshot();
              return snapshot.state === "signed_in" && snapshot.generation === generation;
            },
            cloneContent: () => {
              throw new Error("enterprise.content.unavailable");
            },
          })
        : null,
    [bundle, identitySnapshot, models, signedIn],
  );
  const patModel = useMemo(() => (models ? createPatLoginFormModel() : null), [models]);

  useEffect(() => () => bossStore?.dispose(), [bossStore]);
  const enterpriseIdentityAvailable =
    discovery === "managed" || isEnterpriseIdentityEnabled(capability);

  if (!lifecycle || discovery === "pending" || !enterpriseIdentityAvailable) return null;
  if (!signedIn) {
    return (
      <>
        <EnterprisePasswordLoginForm authenticate={authenticatePassword} />
        {patModel && bundle ? (
          <EnterprisePatLoginForm model={patModel} authenticate={authenticatePat} />
        ) : null}
      </>
    );
  }
  if (!models || !bundle || !patModel || !bossStore) return null;
  return (
    <EnterpriseWorkbenchContainer
      {...models}
      capability={capability}
      patModel={patModel}
      bossStore={bossStore}
      principalPort={bundle.principalPort}
      createGrantEditor={createGrantEditor}
      createBrowserBinding={createBrowserBinding}
      legacyContent={null}
      browserProfilesEnabled={browserProfilesEnabled}
      hydrateBrowserProfileAuthorizations={hydrateBrowserProfileAuthorizations}
    />
  );
}
