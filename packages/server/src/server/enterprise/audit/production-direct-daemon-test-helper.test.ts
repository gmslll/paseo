import { stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { EnterpriseAdmission } from "../identity/admission.js";
import { IdentityRegistry } from "../identity/registry.js";
import {
  createProductionDirectDaemonTestHarness,
  PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED,
  type ProductionDirectDaemonTestHarness,
} from "./production-direct-daemon-test-helper.js";
import { productionAuditCapabilityIssuer } from "./production-audit-runtime.js";

describe.runIf(PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED)(
  "production direct daemon test helper",
  () => {
    test("builds production ports and reopens one isolated home with the issued PAT", async () => {
      let harness: ProductionDirectDaemonTestHarness | undefined;
      try {
        harness = await createProductionDirectDaemonTestHarness({
          name: "direct-helper-smoke",
          serverId: "srv_direct_helper",
          organizationId: "org_0123456789abcdef",
          nodeId: "nod_0123456789abcdef",
          principals: [
            {
              principalId: "usr_0123456789abcdef",
              grantVersion: "grv_direct_helper",
              grants: [
                {
                  action: "audit.read",
                  selector: {
                    kind: "organization",
                    organizationId: "org_0123456789abcdef",
                  },
                },
              ],
            },
          ],
        });
        expect(harness.paseoHome).toBe(path.join(harness.root, ".paseo"));
        expect(harness.nativeAddons.directory.startsWith(harness.root)).toBe(true);
        expect(path.dirname(harness.nativeAddons.audit)).toBe(harness.nativeAddons.directory);
        expect(path.dirname(harness.nativeAddons.workspace)).toBe(harness.nativeAddons.directory);
        expect((await stat(harness.nativeAddons.audit)).isFile()).toBe(true);
        expect((await stat(harness.nativeAddons.workspace)).isFile()).toBe(true);

        const issued = await harness.issuePersonalAccessToken("usr_0123456789abcdef");
        await harness.start();
        const firstRuntime = harness.runtime;
        expect(firstRuntime.admission).toBeInstanceOf(EnterpriseAdmission);
        expect((firstRuntime.admission as EnterpriseAdmission).registry).toBeInstanceOf(
          IdentityRegistry,
        );
        expect(productionAuditCapabilityIssuer.current(firstRuntime.audit)).toBe(true);
        expect(firstRuntime.principalSource?.isCurrent()).toBe(true);
        expect(harness.daemon.getListenTarget()).toMatchObject({
          type: "tcp",
          port: expect.any(Number),
        });
        const firstHome = harness.paseoHome;
        const first = await harness.connectAndHello({
          token: issued.token,
          clientId: "direct-helper-first",
        });
        expect(first.serverInfo).toMatchObject({
          type: "session",
          message: { payload: { status: "server_info" } },
        });

        await harness.reopen();
        expect(harness.paseoHome).toBe(firstHome);
        expect(productionAuditCapabilityIssuer.current(firstRuntime.audit)).toBe(false);
        expect(harness.runtime.admission).toBeInstanceOf(EnterpriseAdmission);
        const reopened = await harness.connectAndHello({
          token: issued.token,
          clientId: "direct-helper-reopened",
        });
        expect(reopened.serverInfo).toMatchObject({
          type: "session",
          message: { payload: { status: "server_info" } },
        });
      } finally {
        await harness?.close();
      }
    }, 120_000);
  },
);
