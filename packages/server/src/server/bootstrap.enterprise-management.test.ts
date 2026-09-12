import { describe, expect, test } from "vitest";

import { resolveEnterpriseManagementBootstrap } from "./bootstrap.js";

describe("enterprise management bootstrap projection", () => {
  test("exposes only the managed node routing metadata", () => {
    expect(
      resolveEnterpriseManagementBootstrap(
        {
          enabled: true,
          organizationId: "org_0123456789abcdef",
          nodeId: "nod_0123456789abcdef",
          managementMode: "managed",
          legacyRecords: "owner_only",
          management: {
            baseUrl: "https://management.test:17443",
            caCertificatePath: "/private/management-ca.pem",
            relationshipPath: "/private/relationship.json",
          },
        },
        "server-a",
      ),
    ).toEqual({
      mode: "managed",
      managementBaseUrl: "https://management.test:17443",
      nodeId: "nod_0123456789abcdef",
      paseoServerId: "server-a",
    });
    expect(
      JSON.stringify(
        resolveEnterpriseManagementBootstrap(
          {
            enabled: true,
            organizationId: "org_0123456789abcdef",
            nodeId: "nod_0123456789abcdef",
            managementMode: "managed",
            legacyRecords: "owner_only",
            management: {
              baseUrl: "https://management.test:17443",
              caCertificatePath: "/private/management-ca.pem",
              relationshipPath: "/private/relationship.json",
            },
          },
          "server-a",
        ),
      ),
    ).not.toContain("private");
  });

  test("does not advertise standalone or disabled runtimes", () => {
    expect(
      resolveEnterpriseManagementBootstrap(
        {
          enabled: true,
          organizationId: "org_0123456789abcdef",
          nodeId: "nod_0123456789abcdef",
          managementMode: "standalone",
          legacyRecords: "owner_only",
        },
        "server-a",
      ),
    ).toBeNull();
    expect(resolveEnterpriseManagementBootstrap({ enabled: false }, "server-a")).toBeNull();
  });
});
