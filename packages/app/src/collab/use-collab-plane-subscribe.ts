import { useEffect, useRef } from "react";
import { CollabSubscriptionEventSchema } from "@getpaseo/protocol/enterprise-collaboration";
import { useHostEnterpriseIdentitySnapshot, useHostRuntimeClient } from "@/runtime/host-runtime";
import { getOrCreateClientId } from "@/utils/client-id";
import { appCollabReplica } from "./replica-host";
import { useCollabViewer } from "./use-collab-viewer";
import { useCollabWorkspaceAccess } from "./use-collab-workspace-access";

interface PlaneSubscribeScope {
  readonly workspaceId: string;
  readonly workspaceUid: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly daemon: {
    pollCollabSubscription: (input: {
      workspaceId: string;
      clientId: string;
      subscriptionId?: string;
    }) => Promise<{ subscriptionId: string; events: unknown[] }>;
  };
  readonly isCancelled: () => boolean;
  readonly onRevoked: (reason: string) => void;
}

async function subscribeToCollabPlane(scope: PlaneSubscribeScope): Promise<void> {
  const clientId = await getOrCreateClientId();
  if (scope.isCancelled()) return;
  let subscriptionId: string | undefined;
  for (;;) {
    if (scope.isCancelled()) return;
    const payload = await scope.daemon.pollCollabSubscription({
      workspaceId: scope.workspaceId,
      clientId,
      ...(subscriptionId ? { subscriptionId } : {}),
    });
    if (scope.isCancelled()) return;
    subscriptionId = payload.subscriptionId;
    for (const raw of payload.events) {
      const event = CollabSubscriptionEventSchema.safeParse(raw);
      if (!event.success) continue;
      appCollabReplica.apply(
        {
          organizationId: scope.organizationId,
          principalId: scope.principalId,
          workspaceUid: scope.workspaceUid,
        },
        event.data,
      );
      if (event.data.type === "revoked") {
        scope.onRevoked(event.data.reason);
        return;
      }
    }
  }
}

/**
 * Subscribes through the node (ADR-0032). The App never dials the management plane: phones and
 * browsers do not have the node's CA pin, so the daemon holds the stream token and long-polls.
 */
export function useCollabPlaneSubscribe(input: {
  serverId: string;
  workspaceId: string | undefined;
  onRevoked?: (reason: string) => void;
}): void {
  const client = useHostRuntimeClient(input.serverId);
  const viewer = useCollabViewer(input.serverId);
  const access = useCollabWorkspaceAccess(input.serverId, input.workspaceId);
  const identity = useHostEnterpriseIdentitySnapshot(input.serverId);
  const organizationId =
    identity?.state === "signed_in"
      ? (identity.scope?.organizationId ?? identity.projection?.organizationId)
      : undefined;
  const onRevokedRef = useRef(input.onRevoked);
  onRevokedRef.current = input.onRevoked;
  const enabled =
    access.collaborationEnabled &&
    Boolean(client) &&
    Boolean(access.workspaceUid) &&
    Boolean(organizationId) &&
    viewer.principalId !== "owner";

  useEffect(() => {
    const workspaceId = input.workspaceId;
    const workspaceUid = access.workspaceUid;
    const scopeOrganizationId = organizationId;
    if (!enabled || !client || !workspaceId || !workspaceUid || !scopeOrganizationId) {
      return;
    }
    let cancelled = false;
    void subscribeToCollabPlane({
      workspaceId,
      workspaceUid,
      organizationId: scopeOrganizationId,
      principalId: viewer.principalId,
      daemon: client,
      isCancelled: () => cancelled,
      onRevoked: (reason) => {
        onRevokedRef.current?.(reason);
      },
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    access.collaborationEnabled,
    access.workspaceUid,
    client,
    enabled,
    input.workspaceId,
    organizationId,
    viewer.principalId,
  ]);
}
