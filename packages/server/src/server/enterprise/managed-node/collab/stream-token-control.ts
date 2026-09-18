import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

export const COLLAB_STREAM_TOKEN_UNAVAILABLE =
  "Collaborative stream tokens are unavailable on this daemon";

export interface CollabStreamToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly managementBaseUrl: string;
}

export interface CollabStreamTokenControl {
  issue(input: {
    workspaceId: string;
    actorPrincipalId: string;
    clientId: string;
  }): Promise<CollabStreamToken>;
}

export function createCollabStreamTokenControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  managementBaseUrl: string;
  issue: (change: {
    actorPrincipalId: string;
    clientId: string;
    workspaceUid: string;
  }) => Promise<{ token: string; expiresAt: string }>;
}): CollabStreamTokenControl {
  return {
    async issue(request) {
      const catalog = input.catalog.current();
      const entry = catalog?.workspaces.find(
        (workspace) => workspace.localWorkspaceId === request.workspaceId,
      );
      if (!entry || entry.state !== "active") throw new Error(COLLAB_STREAM_TOKEN_UNAVAILABLE);
      const member = entry.members.some((item) => item.principalId === request.actorPrincipalId);
      if (!member) throw new Error(COLLAB_STREAM_TOKEN_UNAVAILABLE);
      const issued = await input.issue({
        actorPrincipalId: request.actorPrincipalId,
        clientId: request.clientId,
        workspaceUid: entry.workspaceUid,
      });
      return {
        token: issued.token,
        expiresAt: issued.expiresAt,
        managementBaseUrl: input.managementBaseUrl,
      };
    },
  };
}
