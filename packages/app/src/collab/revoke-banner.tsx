import { type ReactElement } from "react";
import { Alert } from "@/components/ui/alert";
import { useHostFeature } from "@/runtime/host-features";
import { useCollabCopy } from "./copy";
import { projectRevokeBanner } from "./views";

export function RevokeBanner({
  serverId,
  revoked,
  reason,
}: {
  serverId: string;
  revoked: boolean;
  reason: string | null;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const copy = useCollabCopy();
  if (!supported) return null;
  const banner = projectRevokeBanner({ revoked, reason, copy });
  if (!banner) return null;
  return (
    <Alert
      testID="collab-revoke-banner"
      variant="error"
      title={banner.title}
      description={banner.description}
    />
  );
}
