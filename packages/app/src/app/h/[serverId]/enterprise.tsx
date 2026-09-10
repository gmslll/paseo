import { useHostRouteServerId } from "@/navigation/host-route-context";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { EnterpriseWorkbenchHost } from "@/screens/enterprise/enterprise-workbench-host";

export default function EnterpriseHostRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) return null;
  return (
    <HostRouteBootstrapBoundary>
      <EnterpriseWorkbenchHost serverId={serverId} />
    </HostRouteBootstrapBoundary>
  );
}
