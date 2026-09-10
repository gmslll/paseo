import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnterpriseWorkspaceFilesRuntime } from "../runtime/workspace-files-runtime.js";
import { EnterpriseWorkspaceContentReadResponseSchema } from "@getpaseo/protocol/messages";
import { createProductionAppSlotRegistry } from "../runtime/production-app-slot-registry.js";
import { createEnterpriseContentReadDispatcherRegistration } from "./enterprise-content-read-dispatcher.js";
import {
  closeProductionRuntimeFixture,
  createProductionRuntimeFixture,
  node as fixtureNode,
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
      let listCount = 0;
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => {
          listCount += 1;
          return [
            {
              kind: "file" as const,
              relativePath: "README.md",
              name: "README.md",
              dev: 1,
              ino: 2,
              size: 12,
              mtimeMs: 1_000,
            },
          ];
        },
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
        "enterprise.app_slot.content.read.request",
        "enterprise.agent.content.read.request",
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
      const message2 = { ...message, requestId: "r-burn", resource: { ...message.resource } };
      const response2 = await lease.dispatcher.handle({
        sessionContext: fixture.context,
        message: message2,
      });
      expect(response2).not.toBe(false);
      if (response2 === false) throw new Error("response2");
      const clonedMessage2 = { ...message2, resource: { ...message2.resource } };
      expect(
        lease.dispatcher.consumeResponse?.({
          sessionContext: fixture.context,
          message: clonedMessage2,
          response: response2,
        }),
      ).toBeNull();
      expect(
        lease.dispatcher.consumeResponse?.({
          sessionContext: fixture.context,
          message: message2,
          response: response2,
        }),
      ).toBeNull();
      const successListCount = listCount;
      const successAuditCount = (await fixture.audit.snapshotEvents()).filter(
        (event) => event.action === "workspace.content.read",
      ).length;
      const foreignOrgMessage = {
        ...message,
        requestId: "r-foreign-org",
        resource: { ...message.resource, organizationId: "org_ffffffffffffffff" },
      };
      expect(
        await lease.dispatcher.handle({
          sessionContext: fixture.context,
          message: foreignOrgMessage,
        }),
      ).toBe(false);
      const missingWorkspaceMessage = {
        ...message,
        requestId: "r-missing-workspace",
        resource: { ...message.resource, localResourceId: "wks_ffffffffffffffff" },
      };
      expect(
        await lease.dispatcher.handle({
          sessionContext: fixture.context,
          message: missingWorkspaceMessage,
        }),
      ).toBe(false);
      expect(listCount).toBe(successListCount);
      expect(
        (await fixture.audit.snapshotEvents()).filter(
          (event) => event.action === "workspace.content.read",
        ),
      ).toHaveLength(successAuditCount);
      await lease.close();
      await lease.close();
      expect(cleanupCount).toBe(1);
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("denies workspace content without a grant", async () => {
    const fixture = await createProductionRuntimeFixture("content-no-grant", { grants: [] });
    try {
      let listCount = 0;
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => {
          listCount += 1;
          return [];
        },
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
        cleanup: async () => {},
      };
      const registration = createEnterpriseContentReadDispatcherRegistration({
        provider: fixture.provider,
        audit: fixture.audit,
        agents: {
          listAgents: async () => [],
          getAgent: async () => null,
          getTimelineRows: async () => [],
        },
      });
      if (!registration) throw new Error("registration");
      const lease = registration.open({
        sessionId: fixture.context.sessionId,
        clientId: fixture.context.clientId,
        context: fixture.context.enterpriseContext,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      const response = await lease.dispatcher.handle({
        sessionContext: fixture.context,
        message: {
          type: "enterprise.workspace.content.read.request",
          requestId: "r-no-grant",
          resource: {
            organizationId: fixture.context.enterpriseContext.principal.organizationId,
            nodeId: fixture.context.enterpriseContext.node.nodeId,
            resourceKind: "workspace",
            localResourceId: "wks_0123456789abcdef",
          },
          selector: { kind: "workspace", view: "files" },
          page: { limit: 1 },
        },
      });
      expect(response).toBe(false);
      expect(listCount).toBe(0);
      expect(
        (await fixture.audit.snapshotEvents()).some(
          (event) => event.action === "workspace.content.read" && event.outcome === "allowed",
        ),
      ).toBe(false);
      await lease.close();
      await lease.close();
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("closes an in-flight workspace read and rejects reentry", async () => {
    const fixture = await createProductionRuntimeFixture("content-close-race");
    try {
      let listCount = 0;
      let listEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        listEntered = resolve;
      });
      let releaseList!: () => void;
      const listReady = new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      let cleanupCount = 0;
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => {
          listCount += 1;
          listEntered();
          await listReady;
          return [];
        },
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
        agents: {
          listAgents: async () => [],
          getAgent: async () => null,
          getTimelineRows: async () => [],
        },
      });
      if (!registration) throw new Error("registration");
      const lease = registration.open({
        sessionId: fixture.context.sessionId,
        clientId: fixture.context.clientId,
        context: fixture.context.enterpriseContext,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      const message = {
        type: "enterprise.workspace.content.read.request" as const,
        requestId: "r-close-race",
        resource: {
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          resourceKind: "workspace" as const,
          localResourceId: "wks_0123456789abcdef",
        },
        selector: { kind: "workspace" as const, view: "files" as const },
        page: { limit: 1 },
      };
      const first = lease.dispatcher.handle({ sessionContext: fixture.context, message });
      await entered;
      expect(await lease.dispatcher.handle({ sessionContext: fixture.context, message })).toBe(
        false,
      );
      expect(listCount).toBe(1);
      const closing = lease.close();
      releaseList();
      await expect(first).resolves.toBe(false);
      await closing;
      await lease.close();
      expect(cleanupCount).toBe(1);
      expect(
        (await fixture.audit.snapshotEvents()).some(
          (event) => event.action === "workspace.content.read" && event.outcome === "allowed",
        ),
      ).toBe(false);
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });

  test("reads an authorized app slot", async () => {
    const appSlotId = "aps_0123456789abcdef";
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-app-slot-"));
    await mkdir(path.join(tempHome, "enterprise"), { recursive: true, mode: 0o700 });
    const appSlot = {
      appSlotId,
      organizationId: "org_0123456789abcdef",
      nodeId: fixtureNode.nodeId,
      appBundleId: "com.example.app",
      accountBindingKey: "account",
      ownerPrincipalId: "usr_0123456789abcdef",
      concurrency: 1,
      status: "ready" as const,
    };
    await writeFile(
      path.join(tempHome, "enterprise", "app-slots.json"),
      JSON.stringify({ version: 1, records: [appSlot] }),
      { mode: 0o600 },
    );
    const registry = createProductionAppSlotRegistry({
      paseoHome: tempHome,
      organizationId: appSlot.organizationId,
      node: fixtureNode,
    });
    if (!registry) throw new Error("registry");
    await registry.initialize();
    const fixture = await createProductionRuntimeFixture("content-app-slot", {
      grants: [
        {
          action: "app.use",
          selector: { kind: "organization", organizationId: "org_0123456789abcdef" },
        },
      ],
      appSlots: registry,
    });
    try {
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => [],
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
        cleanup: async () => {},
      };
      const registration = createEnterpriseContentReadDispatcherRegistration({
        provider: fixture.provider,
        audit: fixture.audit,
        agents: {
          listAgents: async () => [],
          getAgent: async () => null,
          getTimelineRows: async () => [],
        },
      });
      if (!registration) throw new Error("registration");
      const lease = registration.open({
        sessionId: fixture.context.sessionId,
        clientId: fixture.context.clientId,
        context: fixture.context.enterpriseContext,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      const message = {
        type: "enterprise.app_slot.content.read.request" as const,
        requestId: "r-app",
        resource: {
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          resourceKind: "app_slot" as const,
          localResourceId: appSlotId,
        },
        selector: { kind: "app_slot" as const, view: "state" as const },
        page: { limit: 1 },
      };
      const response = await lease.dispatcher.handle({ sessionContext: fixture.context, message });
      expect(response).not.toBe(false);
      if (response === false) throw new Error("response");
      expect(
        lease.dispatcher.consumeResponse?.({ sessionContext: fixture.context, message, response }),
      ).not.toBeNull();
      expect(
        lease.dispatcher.consumeResponse?.({ sessionContext: fixture.context, message, response }),
      ).toBeNull();
      expect(
        (await fixture.audit.snapshotEvents()).some(
          (event) => event.action === "app.use" && event.outcome === "allowed",
        ),
      ).toBe(true);
      const allowedAuditCount = (await fixture.audit.snapshotEvents()).filter(
        (event) => event.action === "app.use" && event.outcome === "allowed",
      ).length;
      expect(
        await lease.dispatcher.handle({
          sessionContext: fixture.context,
          message: {
            ...message,
            requestId: "r-app-foreign",
            resource: { ...message.resource, organizationId: "org_ffffffffffffffff" },
          },
        }),
      ).toBe(false);
      expect(
        await lease.dispatcher.handle({
          sessionContext: fixture.context,
          message: {
            ...message,
            requestId: "r-app-missing",
            resource: { ...message.resource, localResourceId: "aps_ffffffffffffffff" },
          },
        }),
      ).toBe(false);
      expect(
        (await fixture.audit.snapshotEvents()).filter(
          (event) => event.action === "app.use" && event.outcome === "allowed",
        ),
      ).toHaveLength(allowedAuditCount);
      await lease.close();
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
      await registry.close();
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  test("reads an authorized agent and consumes once", async () => {
    const fixture = await createProductionRuntimeFixture("content-agent");
    try {
      const agentId = "agt_0123456789abcdef";
      fixture.provider.owners.registerAgent({
        id: agentId,
        workspaceId: "wks_0123456789abcdef",
        ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        organizationId: fixture.context.enterpriseContext.principal.organizationId,
        nodeId: fixture.context.enterpriseContext.node.nodeId,
        createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
      });
      const agent = {
        id: agentId,
        workspaceId: "wks_0123456789abcdef",
        enterpriseOwnership: {
          workspaceId: "wks_0123456789abcdef",
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          ownerPrincipalId: fixture.context.enterpriseContext.principal.principalId,
          createdByPrincipalId: fixture.context.enterpriseContext.principal.principalId,
        },
      };
      const registration = createEnterpriseContentReadDispatcherRegistration({
        provider: fixture.provider,
        audit: fixture.audit,
        agents: {
          listAgents: () => [agent] as never,
          getAgent: () => agent as never,
          getTimelineRows: async () => [],
        },
      });
      if (!registration) throw new Error("registration");
      const unused = async (..._args: never[]): Promise<never> => {
        throw new Error("unused");
      };
      const filesRuntime: EnterpriseWorkspaceFilesRuntime = {
        stat: unused,
        list: async () => [],
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
        cleanup: async () => {},
      };
      const lease = registration.open({
        sessionId: fixture.context.sessionId,
        clientId: fixture.context.clientId,
        context: fixture.context.enterpriseContext,
        authorizationRuntime: fixture.runtime,
        filesRuntime,
      });
      const message = {
        type: "enterprise.agent.content.read.request" as const,
        requestId: "r-agent",
        resource: {
          organizationId: fixture.context.enterpriseContext.principal.organizationId,
          nodeId: fixture.context.enterpriseContext.node.nodeId,
          resourceKind: "agent" as const,
          localResourceId: agentId,
        },
        selector: { kind: "agent" as const, view: "transcript" as const },
        page: { limit: 1 },
      };
      const response = await lease.dispatcher.handle({ sessionContext: fixture.context, message });
      expect(response).not.toBe(false);
      if (response === false) throw new Error("response");
      expect(Object.isFrozen(response)).toBe(true);
      expect(
        lease.dispatcher.consumeResponse?.({ sessionContext: fixture.context, message, response }),
      ).not.toBeNull();
      expect(
        lease.dispatcher.consumeResponse?.({ sessionContext: fixture.context, message, response }),
      ).toBeNull();
      expect(
        (await fixture.audit.snapshotEvents()).some(
          (event) => event.action === "workspace.content.read" && event.outcome === "allowed",
        ),
      ).toBe(true);
      await lease.close();
      await fixture.runtime.release();
    } finally {
      await closeProductionRuntimeFixture();
    }
  });
});
