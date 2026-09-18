import { type ReactElement } from "react";
import { Alert } from "@/components/ui/alert";
import { useHostFeature } from "@/runtime/host-features";
import { useCollabCopy } from "./copy";
import { projectQueuedTurnBanner, type QueuedTurnView } from "./views";

export function QueuedTurnBanner({
  serverId,
  queuedTurns,
  viewerPrincipalId,
}: {
  serverId: string;
  queuedTurns: readonly QueuedTurnView[] | undefined;
  viewerPrincipalId: string;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "enterpriseCollaborationV1");
  const copy = useCollabCopy();
  if (!supported) return null;
  const banner = projectQueuedTurnBanner({ queuedTurns, viewerPrincipalId, copy });
  if (!banner) return null;
  return <Alert testID="collab-queued-banner" variant="info" title={banner.title} />;
}
