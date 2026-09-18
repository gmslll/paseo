import { useHostEnterpriseIdentitySnapshot } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

export function useCollabViewer(serverId: string): {
  supported: boolean;
  principalId: string;
  displayName?: string;
} {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const identity = useHostEnterpriseIdentitySnapshot(serverId);
  const principalId =
    identity?.state === "signed_in" && identity.projection
      ? identity.projection.principalId
      : "owner";
  const displayName =
    identity?.state === "signed_in" ? identity.projection?.displayName : undefined;
  return { supported, principalId, displayName };
}
