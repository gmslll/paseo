import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ShareWorkspaceSheet, type ShareWorkspacePort } from "./share-form-sheet";
import { useCollabPresence } from "./use-collab-presence";
import { useCollabViewer } from "./use-collab-viewer";

export function WorkspaceShareHost({
  serverId,
  workspaceId,
  visible,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  visible: boolean;
  onClose: () => void;
}): ReactElement | null {
  const client = useHostRuntimeClient(serverId);
  const viewer = useCollabViewer(serverId);
  const presence = useCollabPresence({
    serverId,
    workspaceId,
    focusAgentId: null,
    displayName: viewer.displayName,
    enabled: visible,
  });
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [viewerRole, setViewerRole] = useState<WorkspaceMemberRole | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [collaborationEnabled, setCollaborationEnabled] = useState(false);
  const [canEnable, setCanEnable] = useState(false);

  useEffect(() => {
    if (!visible || !client) return;
    let cancelled = false;
    void client
      .listCollabMembers({ workspaceId })
      .then((payload) => {
        if (cancelled) return undefined;
        setMembers(payload.members);
        setViewerRole(payload.viewerRole);
        setRevoked(payload.revoked);
        setCollaborationEnabled(payload.collaborationEnabled === true);
        setCanEnable(payload.canEnable === true);
        return undefined;
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
        setViewerRole(null);
        setRevoked(false);
        setCollaborationEnabled(false);
        setCanEnable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, visible, workspaceId]);

  const port = useMemo<ShareWorkspacePort>(
    () => ({
      async share(principalId, role) {
        if (!client) throw new Error("Host disconnected");
        const payload = await client.setCollabMember({ workspaceId, principalId, role });
        setMembers(payload.members);
        return payload.members;
      },
      async unshare(principalId) {
        if (!client) throw new Error("Host disconnected");
        const payload = await client.removeCollabMember({ workspaceId, principalId });
        setMembers(payload.members);
        return payload.members;
      },
      async enable() {
        if (!client) throw new Error("Host disconnected");
        const payload = await client.enableCollabWorkspace({ workspaceId });
        setMembers(payload.members);
        setViewerRole(payload.viewerRole);
        setCollaborationEnabled(true);
        setCanEnable(false);
        return { members: payload.members, viewerRole: payload.viewerRole };
      },
    }),
    [client, workspaceId],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!viewer.supported) return null;

  return (
    <ShareWorkspaceSheet
      visible={visible}
      serverId={serverId}
      viewerPrincipalId={viewer.principalId}
      viewerRole={viewerRole}
      members={members}
      revoked={revoked}
      collaborationEnabled={collaborationEnabled}
      canEnable={canEnable}
      presenceEntries={presence.entries}
      presenceNow={presence.now}
      onClose={handleClose}
      port={port}
    />
  );
}
