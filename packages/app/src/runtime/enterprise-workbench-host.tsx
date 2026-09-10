import { useCallback, useEffect, useMemo } from "react";
import { isEnterpriseWorkbenchSignedIn } from "@/runtime/enterprise-workbench-assembly";
import {
  useHostEnterpriseIdentityLifecycle,
  useHostEnterpriseIdentitySnapshot,
  useHostRuntimeClient,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { createBossResourceStore } from "@/stores/enterprise/boss-resource-store";
import { createPatLoginFormModel } from "@/stores/enterprise/pat-login-form-model";
import { EnterprisePatLoginForm } from "@/components/enterprise/enterprise-identity-ui";
import { EnterpriseWorkbenchContainer } from "@/screens/enterprise/enterprise-workbench-screen";
import {
  createEnterpriseUiBundle,
  type EnterpriseContentReaders,
} from "@/screens/enterprise/enterprise-ui-port";

const unavailableContentReaders: EnterpriseContentReaders<string, never> = {
  workspace: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  agent: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  browserProfile: async () => Promise.reject(new Error("enterprise.content.unavailable")),
  appSlot: async () => Promise.reject(new Error("enterprise.content.unavailable")),
};

/** Root assembly for the host scoped enterprise workbench. Content readers stay unavailable until
 * each resource type has a production port; this component never invents a generic reader. */

export function EnterpriseWorkbenchHost({ serverId }: { serverId: string }) {
  const lifecycle = useHostEnterpriseIdentityLifecycle(serverId);
  const identitySnapshot = useHostEnterpriseIdentitySnapshot(serverId);
  const daemonClient = useHostRuntimeClient(serverId);
  const capability = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features ?? null,
  );
  const models = useMemo(() => {
    if (!lifecycle || !daemonClient) return null;
    void identitySnapshot?.generation;
    void identitySnapshot?.projection?.organizationId;
    return { lifecycle, daemonClient, serverId, contentReaders: unavailableContentReaders };
  }, [
    daemonClient,
    identitySnapshot?.generation,
    identitySnapshot?.projection?.organizationId,
    lifecycle,
    serverId,
  ]);

  const bundle = useMemo(() => (models ? createEnterpriseUiBundle(models) : null), [models]);
  const authenticatePat = useCallback(
    (token: string, signal: AbortSignal) => {
      if (!bundle) {
        return Promise.reject(new Error("enterprise.identity.unavailable"));
      }
      return bundle.uiPort.authenticatePat({ serverId, token, signal });
    },
    [bundle, serverId],
  );
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

  if (!models || !bundle || !patModel) return null;
  if (!signedIn) {
    return <EnterprisePatLoginForm model={patModel} authenticate={authenticatePat} />;
  }
  if (!bossStore) return null;
  return (
    <EnterpriseWorkbenchContainer
      {...models}
      capability={capability}
      patModel={patModel}
      bossStore={bossStore}
      legacyContent={null}
    />
  );
}
