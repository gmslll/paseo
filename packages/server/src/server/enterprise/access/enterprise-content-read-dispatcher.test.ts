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
        audit: undefined as never,
        agents,
      });
      expect(registration?.manifest.operations).toEqual([
        "enterprise.workspace.content.read.request",
      ]);
      const lease = registration?.open({
        sessionId: "s",
        clientId: "c",
        context: {} as never,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      expect(
        await lease?.dispatcher.handle({ sessionContext: {} as never, message: {} as never }),
      ).toBe(false);
      await lease?.close();
      await lease?.close();
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });
});
