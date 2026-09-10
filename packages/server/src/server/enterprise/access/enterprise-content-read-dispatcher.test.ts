import { describe, expect, test } from "vitest";
import { createEnterpriseContentReadDispatcherRegistration } from "./enterprise-content-read-dispatcher.js";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
} from "./production-runtime-test-fixture.js";

describe.runIf(process.platform === "darwin")("content dispatcher lifecycle", () => {
  test("opens, handles false, and closes source once", async () => {
    const fixture = await createProductionRuntimeFixture("content");
    try {
      const agents = {
        listAgents: async () => [],
        getAgent: async () => null,
        getTimelineRows: async () => [],
      };
      const filesRuntime = { list: async () => [], cleanup: async () => {} };
      const registration = createEnterpriseContentReadDispatcherRegistration({
        provider: fixture.provider,
        audit: fixture.audit,
        agents,
      });
      expect(registration?.manifest.operations).toEqual([
        "enterprise.workspace.content.read.request",
      ]);
      const registrationReady = registration;
      if (!registrationReady) throw new Error("registration");
      const lease = registrationReady.open({
        sessionId: "s",
        clientId: "c",
        context: fixture.context,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      expect(
        await lease.dispatcher.handle({
          sessionContext: fixture.context,
          message: {
            type: "enterprise.workspace.content.read.request",
            requestId: "r",
            resource: {
              organizationId: fixture.context.enterpriseContext.principal.organizationId,
              nodeId: fixture.context.enterpriseContext.node.nodeId,
              resourceKind: "workspace",
              localResourceId: "w",
            },
            selector: { kind: "workspace", view: "files" },
            page: { limit: 1 },
          },
        }),
      ).toBe(false);
      await lease.close();
      await lease.close();
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });
});
