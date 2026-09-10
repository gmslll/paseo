import { describe, expect, test } from "vitest";
import type { EnterpriseWorkspaceFilesRuntime } from "../runtime/workspace-files-runtime.js";
import { EnterpriseWorkspaceContentReadResponseSchema } from "@getpaseo/protocol/messages";
import { createEnterpriseContentReadDispatcherRegistration } from "./enterprise-content-read-dispatcher.js";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
} from "./production-runtime-test-fixture.js";

describe.runIf(process.platform === "darwin")("content dispatcher lifecycle", () => {
  test("reads canonical workspace content and consumes once", async () => {
    const fixture = await createProductionRuntimeFixture("content");
    try {
      const agents = {
        listAgents: async () => [],
        getAgent: async () => null,
        getTimelineRows: async () => [],
      };
      let cleanupCount = 0;
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => [
          {
            kind: "file" as const,
            relativePath: "README.md",
            name: "README.md",
            dev: 1,
            ino: 2,
            size: 12,
            mtimeMs: 1_000,
          },
        ],
        openRead: unused,
        write: unused,
        create: unused,
        rename: unused,
        copy: unused,
        delete: unused,
        watch: unused,
        issueDownloadToken: unused,
        createUploadStore: () => {
          throw new Error("unused");
        },
        cleanup: async () => {
          cleanupCount += 1;
        },
      };
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
        sessionId: fixture.context.sessionId,
        clientId: fixture.context.clientId,
        context: fixture.context.enterpriseContext,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      const message = {
        type: "enterprise.workspace.content.read.request",
        requestId: "r-content",
        resource: {
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          resourceKind: "workspace",
          localResourceId: "wks_0123456789abcdef",
        },
        selector: { kind: "workspace", view: "files" },
        page: { limit: 1 },
      } as const;
      const response = await lease.dispatcher.handle({ sessionContext: fixture.context, message });
      expect(response).not.toBe(false);
      if (response === false) throw new Error("response");
      const parsed = EnterpriseWorkspaceContentReadResponseSchema.parse(response);
      expect(Object.isFrozen(response)).toBe(true);
      expect(parsed.payload.requestId).toBe("r-content");
      expect(parsed.payload.resource.localResourceId).toBe("wks_0123456789abcdef");
      expect(parsed.payload.selector).toEqual({ kind: "workspace", view: "files" });
      expect(parsed.payload.page.items).toHaveLength(1);
      expect(parsed.payload.page.items[0]).toMatchObject({
        kind: "file",
        reference: "README.md",
        label: "README.md",
      });
      const consumed = lease.dispatcher.consumeResponse?.({
        sessionContext: fixture.context,
        message,
        response,
      });
      expect(consumed?.authorizationContext).toEqual({
        kind: "resources",
        resources: [parsed.payload.resource],
      });
      expect(
        lease.dispatcher.consumeResponse?.({ sessionContext: fixture.context, message, response }),
      ).toBeNull();
      const events = await fixture.audit.snapshotEvents();
      expect(
        events.some(
          (event) =>
            event.action === "workspace.content.read" &&
            event.outcome === "allowed" &&
            event.sessionId === fixture.context.sessionId &&
            event.workspaceId === "wks_0123456789abcdef" &&
            event.actorPrincipalId === fixture.context.enterpriseContext.principal.principalId,
        ),
      ).toBe(true);
      await lease.close();
      await lease.close();
      expect(cleanupCount).toBe(1);
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });
});
