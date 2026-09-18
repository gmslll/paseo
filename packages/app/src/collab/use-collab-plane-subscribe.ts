import { useEffect, useRef } from "react";
import {
  CollabSubscriptionCreatedSchema,
  CollabSubscriptionEventSchema,
} from "@getpaseo/protocol/enterprise-collaboration";
import { z } from "zod";
import { useHostEnterpriseIdentitySnapshot, useHostRuntimeClient } from "@/runtime/host-runtime";
import { getOrCreateClientId } from "@/utils/client-id";
import { appCollabReplica } from "./replica-host";
import { useCollabViewer } from "./use-collab-viewer";
import { useCollabWorkspaceAccess } from "./use-collab-workspace-access";

const START_OFFSET = "00000000000000000000";
const EventsBodySchema = z.object({
  events: z.array(CollabSubscriptionEventSchema),
});

interface PlaneSubscribeScope {
  readonly workspaceId: string;
  readonly workspaceUid: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly daemon: {
    issueCollabStreamToken: (input: {
      workspaceId: string;
      clientId: string;
    }) => Promise<{ token: string; managementBaseUrl: string }>;
  };
  readonly isCancelled: () => boolean;
  readonly onRevoked: (reason: string) => void;
}

async function subscribeToCollabPlane(scope: PlaneSubscribeScope): Promise<void> {
  const clientId = await getOrCreateClientId();
  if (scope.isCancelled()) return;
  const issued = await scope.daemon.issueCollabStreamToken({
    workspaceId: scope.workspaceId,
    clientId,
  });
  if (scope.isCancelled()) return;
  const opened = await fetch(new URL("/v1/ds/subscriptions", issued.managementBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      containerId: scope.workspaceUid,
      cursors: { meta: START_OFFSET },
    }),
  });
  if (!opened.ok) return;
  const created = CollabSubscriptionCreatedSchema.parse(await opened.json());
  for (;;) {
    if (scope.isCancelled()) return;
    const polled = await fetch(
      new URL(
        `/v1/ds/subscriptions/${created.subscriptionId}?live=long-poll`,
        issued.managementBaseUrl,
      ),
      {
        headers: {
          authorization: `Bearer ${issued.token}`,
          accept: "application/json",
        },
      },
    );
    if (scope.isCancelled()) return;
    if (!polled.ok) return;
    const body = EventsBodySchema.parse(await polled.json());
    for (const event of body.events) {
      appCollabReplica.apply(
        {
          organizationId: scope.organizationId,
          principalId: scope.principalId,
          workspaceUid: scope.workspaceUid,
        },
        event,
      );
      if (event.type === "revoked") {
        scope.onRevoked(event.reason);
        return;
      }
    }
  }
}

/**
 * Subscribes to the plane as this Principal (ADR-0032). Hermes cannot apply Loro `data` updates;
 * it uses presence and `revoked` so a membership drop lands immediately instead of on the next poll.
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
