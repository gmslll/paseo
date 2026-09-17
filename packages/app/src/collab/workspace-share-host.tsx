import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type {
  WorkspaceMember,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ShareWorkspaceSheet, type ShareWorkspacePort } from "./share-form-sheet";
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
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [viewerRole, setViewerRole] = useState<WorkspaceMemberRole | null>(null);
  const [revoked, setRevoked] = useState(false);

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
        return undefined;
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
        setViewerRole(null);
        setRevoked(false);
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
      onClose={handleClose}
      port={port}
    />
  );
}
