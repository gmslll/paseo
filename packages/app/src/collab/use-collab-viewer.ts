import { useHostEnterpriseIdentitySnapshot } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";

export function useCollabViewer(serverId: string): {
  supported: boolean;
  principalId: string;
} {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const identity = useHostEnterpriseIdentitySnapshot(serverId);
  const principalId =
    identity?.state === "signed_in" && identity.projection
      ? identity.projection.principalId
      : "owner";
  return { supported, principalId };
}
