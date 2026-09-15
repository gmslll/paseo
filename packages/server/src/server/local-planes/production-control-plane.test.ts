import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED,
  createProductionDirectDaemonTestHarness,
  type ProductionDirectTestPrincipal,
} from "../enterprise/audit/production-direct-daemon-test-helper.js";
import {
  nextSessionLine,
  upgradeControlPlane,
  writeSessionLine,
} from "./control-plane-test-client.js";
import { readDaemonManifest } from "./daemon-manifest.js";
import { resolveLocalPlanePaths } from "./plane-paths.js";

const ORGANIZATION = "org_5151515151515151";
const NODE = "nod_5151515151515151";
const PRINCIPAL = "usr_cccccccccccccccc";

const principals: ProductionDirectTestPrincipal[] = [
  {
    principalId: PRINCIPAL,
    grantVersion: "grv_control_plane",
    grants: [
      { action: "workspace.metadata.read", selector: { kind: "self" } },
      { action: "workspace.content.read", selector: { kind: "self" } },
      { action: "workspace.write", selector: { kind: "self" } },
    ],
  },
];

describe.runIf(PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED)(
  "production control plane admission",
  () => {
    test("requires both the local token and a PAT, then serves the Principal's Session", async () => {
      const harness = await createProductionDirectDaemonTestHarness({
        name: "control-plane",
        serverId: "srv_control_plane",
        organizationId: ORGANIZATION,
        nodeId: NODE,
        principals,
      });
      try {
        await harness.start();
        const paths = resolveLocalPlanePaths({ paseoHome: harness.paseoHome });
        const manifest = await readDaemonManifest(paths.manifestPath);
        const controlPath = manifest?.planes.control?.path;
        expect(controlPath).toBe(paths.endpoints.control.path);
        const token = (await readFile(paths.tokenPath, "utf8")).trim();
        const pat = (await harness.issuePersonalAccessToken(PRINCIPAL)).token;
        const upgradeHeaders = { connection: "Upgrade", upgrade: "paseo-ndjson/1" };

        const tokenOnly = await upgradeControlPlane(controlPath!, {
          ...upgradeHeaders,
          "x-paseo-local-token": token,
        });
        const wrongPat = await upgradeControlPlane(controlPath!, {
          ...upgradeHeaders,
          "x-paseo-local-token": token,
          authorization: "Bearer pat_not_issued",
        });
        const patOnly = await upgradeControlPlane(controlPath!, {
          ...upgradeHeaders,
          authorization: `Bearer ${pat}`,
        });
        expect([tokenOnly.status, wrongPat.status, patOnly.status]).toEqual([401, 401, 401]);

        const session = await upgradeControlPlane(controlPath!, {
          ...upgradeHeaders,
          "x-paseo-local-token": token,
          authorization: `Bearer ${pat}`,
        });
        expect(session.status).toBe(101);
        const serverInfo = nextSessionLine(
          session,
          (line) => line.message?.payload?.status === "server_info",
        );
        writeSessionLine(session, {
          type: "hello",
          clientId: "production-control-plane",
          clientType: "cli",
          protocolVersion: 1,
        });
        const features = (await serverInfo).message?.payload?.features as
          | Record<string, unknown>
          | undefined;
        expect(features).toMatchObject({ enterpriseIdentityV1: true, localPlanes: true });

        const agents = nextSessionLine(
          session,
          (line) => line.message?.payload?.requestId === "control-agents",
        );
        writeSessionLine(session, {
          type: "session",
          message: { type: "fetch_agents_request", requestId: "control-agents" },
        });
        expect(await agents).toMatchObject({
          message: { type: "fetch_agents_response", payload: { entries: [] } },
        });
        session.socket?.destroy();
      } finally {
        await harness.close();
      }
    }, 180_000);
  },
);
