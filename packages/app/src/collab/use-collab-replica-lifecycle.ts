import { useEffect, useRef } from "react";
import { useHostEnterpriseIdentitySnapshot } from "@/runtime/host-runtime";
import { appCollabReplica } from "./replica-host";

/** Drops this Principal's replica on logout so a later sign-in cannot read it (ADR-0036). */
export function useCollabReplicaLifecycle(serverId: string): void {
  const identity = useHostEnterpriseIdentitySnapshot(serverId);
  const last = useRef<{ organizationId: string; principalId: string } | null>(null);

  useEffect(() => {
    if (identity?.state === "signed_in") {
      const organizationId = identity.scope?.organizationId ?? identity.projection?.organizationId;
      const principalId = identity.projection?.principalId ?? identity.scope?.principalId;
      if (organizationId && principalId) {
        last.current = { organizationId, principalId };
      }
      return;
    }
    const remembered = last.current;
    if (remembered && (identity?.state === "signed_out" || identity?.state === "unavailable")) {
      appCollabReplica.clearPrincipal(remembered.organizationId, remembered.principalId);
      last.current = null;
    }
  }, [identity]);
}
