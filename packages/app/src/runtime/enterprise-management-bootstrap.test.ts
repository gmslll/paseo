import { describe, expect, it, vi } from "vitest";
import type { HostConnection } from "@/types/host-connection";
import { fetchEnterpriseManagementBootstrap } from "./enterprise-management-bootstrap";

const connection: HostConnection = {
  id: "direct:localhost:6767",
  type: "directTcp",
  endpoint: "localhost:6767",
};

describe("fetchEnterpriseManagementBootstrap", () => {
  it("returns the managed-node projection", async () => {
    const request = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toBe("http://localhost:6767/api/enterprise/bootstrap");
      return new Response(
        JSON.stringify({
          mode: "managed",
          managementBaseUrl: "https://management.test:17443",
          nodeId: "nod_aaaaaaaaaaaaaaaa",
          paseoServerId: "srv_managed_local",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", request);

    await expect(fetchEnterpriseManagementBootstrap(connection)).resolves.toEqual({
      mode: "managed",
      managementBaseUrl: "https://management.test:17443",
      nodeId: "nod_aaaaaaaaaaaaaaaa",
      paseoServerId: "srv_managed_local",
    });

    vi.unstubAllGlobals();
  });

  it("treats a standalone node as absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })),
    );

    await expect(fetchEnterpriseManagementBootstrap(connection)).resolves.toBeNull();

    vi.unstubAllGlobals();
  });
});
