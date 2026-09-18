import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { EnterpriseUnsignedAccessGateForRegisteredHost } from "@/runtime/enterprise-workbench-host";
import { OpenProjectScreen } from "@/screens/open-project-screen";

export default function OpenProjectRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <EnterpriseUnsignedAccessGateForRegisteredHost>
        <OpenProjectScreen />
      </EnterpriseUnsignedAccessGateForRegisteredHost>
    </HostRouteBootstrapBoundary>
  );
}
