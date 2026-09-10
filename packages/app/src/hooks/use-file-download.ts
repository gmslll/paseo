import { useCallback, useMemo } from "react";
import { useHostEnterpriseIdentitySnapshot, useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useHostFeature } from "@/runtime/host-features";

interface UseFileDownloadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that downloads a single workspace file by its
 * workspace-relative path. Shared by the file explorer tree and the git diff
 * pane so both surfaces download through the same host token + download-store
 * pipeline instead of duplicating the plumbing.
 */
export function useFileDownload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileDownloadParams): (input: { fileName: string; path: string }) => void {
  const daemons = useHosts();
  const enterpriseIdentitySnapshot = useHostEnterpriseIdentitySnapshot(serverId);
  const enterpriseScopeGeneration = enterpriseIdentitySnapshot?.generation;
  const enterpriseResourceAuthorizationEnabled = useHostFeature(
    serverId,
    "enterpriseResourceAuthorizationV1",
  );
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const normalizedWorkspaceId = useMemo(() => workspaceId?.trim() || null, [workspaceId]);
  const workspaceScopeId = useMemo(
    () => normalizedWorkspaceId || normalizedWorkspaceRoot,
    [normalizedWorkspaceId, normalizedWorkspaceRoot],
  );
  const { requestFileDownloadToken, requestEnterpriseFileDownload } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const startDownload = useDownloadStore((state) => state.startDownload);

  return useCallback(
    ({ fileName, path }) => {
      if (!workspaceScopeId) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: workspaceScopeId,
        fileName,
        path,
        daemonProfile,
        ...(enterpriseResourceAuthorizationEnabled
          ? {
              enterpriseScopeGeneration,
              enterpriseFileDownload: ({ relativePath, scopeGeneration }) =>
                requestEnterpriseFileDownload({ relativePath, scopeGeneration }),
            }
          : {}),
        requestFileDownloadToken: (targetPath) => requestFileDownloadToken(targetPath),
      });
    },
    [
      daemonProfile,
      enterpriseScopeGeneration,
      enterpriseResourceAuthorizationEnabled,
      requestEnterpriseFileDownload,
      requestFileDownloadToken,
      serverId,
      startDownload,
      workspaceScopeId,
    ],
  );
}
