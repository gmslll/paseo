import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

export const COLLAB_TIMELINE_UNAVAILABLE = "Collaborative timeline is unavailable on this daemon";

export interface CollabSessionDocument {
  readonly epoch: string;
  readonly rows: Record<string, { seq: number; timestamp: string; item: unknown; turnId?: string }>;
  readonly stream: { turnId: string | null; text: string } | null;
}

export interface CollabTimelineControl {
  get(workspaceId: string, agentId: string): CollabSessionDocument;
}

export function createCollabTimelineControl(input: {
  catalog: Pick<ManagedWorkspaceCatalog, "current">;
  read: (
    workspaceUid: string,
    localWorkspaceId: string,
    agentId: string,
  ) => CollabSessionDocument | null;
}): CollabTimelineControl {
  return {
    get(workspaceId, agentId) {
      const catalog = input.catalog.current();
      const entry = catalog?.workspaces.find(
        (workspace) => workspace.localWorkspaceId === workspaceId,
      );
      if (!entry || entry.state !== "active") throw new Error(COLLAB_TIMELINE_UNAVAILABLE);
      const document = input.read(entry.workspaceUid, workspaceId, agentId);
      if (!document) throw new Error(COLLAB_TIMELINE_UNAVAILABLE);
      return document;
    },
  };
}
