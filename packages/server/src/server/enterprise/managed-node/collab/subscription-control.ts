import type { CollabSubscriptionEvent } from "@getpaseo/protocol/enterprise-collaboration";
import { ManagementPlaneRequestError } from "../management-client.js";
import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";
import { COLLAB_STREAM_TOKEN_UNAVAILABLE } from "./stream-token-control.js";

export const COLLAB_SUBSCRIPTION_UNAVAILABLE =
  "Collaborative subscriptions are unavailable on this daemon";
export const SUBSCRIPTION_START_OFFSET = "00000000000000000000";

export interface CollabSubscriptionPollInput {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly clientId: string;
  readonly subscriptionId?: string;
}

export interface CollabSubscriptionPollResult {
  readonly subscriptionId: string;
  readonly events: readonly CollabSubscriptionEvent[];
}

export interface CollabSubscriptionControl {
  poll(input: CollabSubscriptionPollInput): Promise<CollabSubscriptionPollResult>;
}

export function createCollabSubscriptionControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  issue: (change: {
    actorPrincipalId: string;
    clientId: string;
    workspaceUid: string;
  }) => Promise<{ token: string; expiresAt: string }>;
  open: (token: string, containerId: string) => Promise<{ subscriptionId: string }>;
  read: (token: string, subscriptionId: string) => Promise<{ events: CollabSubscriptionEvent[] }>;
}): CollabSubscriptionControl {
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();

  function tokenKey(principalId: string, clientId: string): string {
    return `${principalId}\0${clientId}`;
  }

  function requireActive(workspaceId: string) {
    const catalog = input.catalog.current();
    const entry = catalog?.workspaces.find(
      (workspace) => workspace.localWorkspaceId === workspaceId,
    );
    if (!entry || entry.state !== "active") throw new Error(COLLAB_SUBSCRIPTION_UNAVAILABLE);
    return entry;
  }

  async function tokenFor(
    actorPrincipalId: string,
    clientId: string,
    workspaceUid: string,
  ): Promise<string> {
    const key = tokenKey(actorPrincipalId, clientId);
    const cached = tokens.get(key);
    if (cached && cached.expiresAtMs - Date.now() > 30_000) return cached.token;
    const issued = await input.issue({ actorPrincipalId, clientId, workspaceUid });
    tokens.set(key, { token: issued.token, expiresAtMs: Date.parse(issued.expiresAt) });
    return issued.token;
  }

  async function openAndRead(
    token: string,
    containerId: string,
    subscriptionId: string | undefined,
  ): Promise<CollabSubscriptionPollResult> {
    const opened = subscriptionId ?? (await input.open(token, containerId)).subscriptionId;
    const read = await input.read(token, opened);
    return { subscriptionId: opened, events: read.events };
  }

  return {
    async poll(request) {
      const entry = requireActive(request.workspaceId);
      if (!entry.members.some((member) => member.principalId === request.actorPrincipalId)) {
        throw new Error(COLLAB_STREAM_TOKEN_UNAVAILABLE);
      }
      const token = await tokenFor(request.actorPrincipalId, request.clientId, entry.workspaceUid);
      try {
        return await openAndRead(token, entry.workspaceUid, request.subscriptionId);
      } catch (error) {
        if (!(error instanceof ManagementPlaneRequestError) || error.status < 400) throw error;
        tokens.delete(tokenKey(request.actorPrincipalId, request.clientId));
        const next = await tokenFor(request.actorPrincipalId, request.clientId, entry.workspaceUid);
        return await openAndRead(next, entry.workspaceUid, undefined);
      }
    },
  };
}
