import { useEffect, useMemo } from "react";
import {
  useHostEnterpriseIdentityLifecycle,
  useHostEnterpriseIdentitySnapshot,
  useHostRuntimeClient,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { createBossResourceStore } from "@/stores/enterprise/boss-resource-store";
import { createPatLoginFormModel } from "@/stores/enterprise/pat-login-form-model";
import { EnterpriseWorkbenchContainer } from "./enterprise-workbench-screen";
import { createEnterpriseUiBundle, type EnterpriseContentReaders } from "./enterprise-ui-port";

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

  const bossStore = useMemo(
    () =>
      models
        ? createBossResourceStore<never, string>({
            port: createEnterpriseUiBundle(models).resourcePort,
            organizationId:
              models.lifecycle.readSnapshot().projection?.organizationId ?? "org_unavailable",
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
    [models],
  );
  const patModel = useMemo(() => (models ? createPatLoginFormModel() : null), [models]);

  useEffect(() => () => bossStore?.dispose(), [bossStore]);

  if (!models || !bossStore || !patModel) return null;
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
