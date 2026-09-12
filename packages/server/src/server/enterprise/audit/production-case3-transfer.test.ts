import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createProductionDirectDaemonTestHarness,
  type ProductionDirectTestPrincipal,
  type ProductionDirectWsEnvelope,
} from "./production-direct-daemon-test-helper.js";

const organizationId = "org_3333333333333333";
const nodeId = "nod_3333333333333333";
const workspaceId = "wks_3333333333333333";
const agentId = "00000000-0000-4000-8000-000000000333";
const principalA = "usr_aaaaaaaaaaaaaaaa";
const principalB = "usr_bbbbbbbbbbbbbbbb";

async function waitFor(
  socket: { on: Function; off: Function; send: Function },
  predicate: (value: ProductionDirectWsEnvelope) => boolean,
): Promise<ProductionDirectWsEnvelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("case3 response timeout")), 10_000);
    const onMessage = (data: Buffer) => {
      let value: ProductionDirectWsEnvelope;
      try {
        value = JSON.parse(data.toString()) as ProductionDirectWsEnvelope;
      } catch {
        return;
      }
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(value);
    };
    socket.on("message", onMessage);
  });
}

describe.runIf(process.platform === "darwin")("production Case3 workspace transfer", () => {
  // oxlint-disable-next-line complexity
  test("transfers workspace ownership with CAS and persists across restart", async () => {
    const grants = (
      action:
        | "workspace.manage"
        | "workspace.content.read"
        | "workspace.metadata.read"
        | "workspace.write",
    ) =>
      action === "workspace.manage"
        ? { action, selector: { kind: "organization" as const, organizationId } }
        : { action, selector: { kind: "self" as const } };
    const principals: ProductionDirectTestPrincipal[] = [
      {
        principalId: principalA,
        grantVersion: "grv_case3_a",
        grants: [
          grants("workspace.manage"),
          grants("workspace.metadata.read"),
          grants("workspace.content.read"),
          grants("workspace.write"),
        ],
      },
      {
        principalId: principalB,
        grantVersion: "grv_case3_b",
        grants: [
          { action: "workspace.manage", selector: { kind: "self" as const } },
          grants("workspace.metadata.read"),
          grants("workspace.content.read"),
          grants("workspace.write"),
        ],
      },
    ];
    const loggerChunks: string[] = [];
    const harness = await createProductionDirectDaemonTestHarness({
      name: "case3-transfer",
      serverId: "srv_case3",
      organizationId,
      nodeId,
      principals,
      loggerChunks,
    });
    try {
      await mkdir(path.join(harness.paseoHome, "projects"), { recursive: true });
      const workspaceInput = path.join(harness.root, "workspace-case3");
      await mkdir(workspaceInput, { recursive: true, mode: 0o700 });
      const workspaceRoot = await realpath(workspaceInput);
      await writeFile(
        path.join(harness.paseoHome, "projects", "workspaces.json"),
        JSON.stringify([
          {
            workspaceId,
            organizationId,
            nodeId,
            ownerPrincipalId: principalA,
            createdByPrincipalId: principalA,
            projectId: "project-case3",
            cwd: workspaceRoot,
            kind: "directory",
            displayName: "Case3",
            title: null,
            branch: null,
            worktreeRoot: null,
            baseBranch: null,
            mainRepoRoot: null,
            isPaseoOwnedWorktree: false,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            archivedAt: null,
          },
        ]),
      );
      await writeFile(
        path.join(harness.paseoHome, "projects", "projects.json"),
        JSON.stringify([
          {
            projectId: "project-case3",
            rootPath: workspaceRoot,
            kind: "non_git",
            displayName: "Case3",
            projectKey: null,
            customName: null,
            customIconRevision: null,
            createdAt: "2026-09-11T00:00:00.000Z",
            updatedAt: "2026-09-11T00:00:00.000Z",
            archivedAt: null,
          },
        ]),
      );
      await harness.start();
      const issuedA = await harness.issuePersonalAccessToken(principalA);
      const a = await harness.connectAndHello({ token: issuedA.token, clientId: "case3-a" });
      const a2 = await harness.connectAndHello({ token: issuedA.token, clientId: "case3-a2" });
      const issuedB = await harness.issuePersonalAccessToken(principalB);
      const persistedWorkspace = JSON.parse(
        await readFile(path.join(harness.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(persistedWorkspace[0]).toMatchObject({
        workspaceId,
        ownerPrincipalId: principalA,
        createdByPrincipalId: principalA,
        cwd: workspaceRoot,
        nodeId,
        archivedAt: null,
      });
      const contentRequest = (requestId: string) => ({
        type: "enterprise.workspace.content.read.request",
        requestId,
        resource: {
          organizationId,
          nodeId,
          resourceKind: "workspace" as const,
          localResourceId: workspaceId,
        },
        selector: { kind: "workspace" as const, view: "timeline" as const },
        page: { limit: 20 },
      });
      expect(a.serverInfo.message?.payload?.features?.enterpriseWorkspaceOwnershipTransferV1).toBe(
        true,
      );
      const placement = waitFor(
        a.socket,
        (v) => v.message?.payload?.requestId === "case3-placement",
      );
      a.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "enterprise.placement.resolve_workspace.request",
            requestId: "case3-placement",
            workspaceId,
          },
        }),
      );
      const placementResult = await placement;
      if (placementResult.message?.type === "rpc_error") {
        throw new Error(
          `case3 placement rpc_error: ${JSON.stringify(placementResult.message.payload)}`,
        );
      }
      const resources = waitFor(
        a.socket,
        (v) => v.message?.payload?.requestId === "case3-resources",
      );
      a.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "enterprise.organization.list_resources.request",
            requestId: "case3-resources",
            resourceKinds: ["workspace"],
            limit: 20,
          },
        }),
      );
      const resourcesResult = await resources;
      if (resourcesResult.message?.type === "rpc_error") {
        throw new Error(
          `case3 resources rpc_error: ${JSON.stringify(resourcesResult.message.payload)}\n${loggerChunks.slice(-20).join("")}`,
        );
      }
      expect(resourcesResult.message?.payload?.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resourceKind: "workspace",
            workspaceId,
            organizationId,
            nodeId,
            ownerPrincipalId: principalA,
          }),
        ]),
      );
      const subscribedWorkspaces = waitFor(
        a.socket,
        (v) =>
          v.message?.payload?.requestId === "case3-subscribe" ||
          v.payload?.requestId === "case3-subscribe",
      );
      a.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fetch_workspaces_request",
            requestId: "case3-subscribe",
            page: { limit: 20 },
            subscribe: { subscriptionId: "case3-workspace-subscription" },
          },
        }),
      );
      const subscribed = await subscribedWorkspaces;
      const subscribedMessage = subscribed.message ?? subscribed;
      expect(subscribedMessage.type).toBe("fetch_workspaces_response");
      expect(subscribedMessage.payload?.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: workspaceId })]),
      );
      const tombstoneForA = (socket: { on: Function; off: Function; send: Function }) =>
        waitFor(
          socket,
          (v) =>
            v.type === "enterprise.workspace.ownership.transfer.tombstone" ||
            v.message?.type === "enterprise.workspace.ownership.transfer.tombstone",
        );
      const aTombstone = tombstoneForA(a.socket).catch((error) => {
        throw new Error(
          `case3 A tombstone: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const a2Tombstone = tombstoneForA(a2.socket).catch((error) => {
        throw new Error(
          `case3 A2 tombstone: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const transfer = waitFor(a.socket, (v) => v.message?.payload?.requestId === "case3-transfer");
      a.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "enterprise.resource.ownership.transfer.request",
            requestId: "case3-transfer",
            resource: {
              resourceKind: "workspace",
              localResourceId: workspaceId,
              organizationId,
              nodeId,
            },
            expectedOwnerPrincipalId: principalA,
            expectedRevision: "0",
            newPrincipalId: principalB,
          },
        }),
      );
      const result = await transfer;
      if (result.type === "rpc_error" || result.message?.type === "rpc_error") {
        throw new Error(
          `case3 transfer rpc_error: ${JSON.stringify(result.message?.payload ?? result.payload)}`,
        );
      }
      expect(result.message?.payload).toMatchObject({
        ownerPrincipalId: principalB,
        revision: "1",
        receiptId: expect.any(String),
      });
      const receiptId = result.message?.payload?.receiptId;
      const transferEvents = (await harness.runtime.audit.snapshotEvents()).filter(
        (event) =>
          event.action === "enterprise.resource.ownership.transfer" && event.outcome === "allowed",
      );
      expect(transferEvents).toHaveLength(1);
      expect(transferEvents[0]).toMatchObject({
        metadata: { phase: "intent", revision: "1", newOwnerPrincipalId: principalB },
      });
      expect(transferEvents[0]?.eventId).toBe(receiptId);
      const tombstoneA = await aTombstone;
      const tombstoneA2 = await a2Tombstone;
      for (const tombstone of [tombstoneA, tombstoneA2]) {
        expect(tombstone.message?.payload ?? tombstone.payload).toMatchObject({
          eventId: expect.any(String),
          resource: { localResourceId: workspaceId },
          oldPrincipalId: principalA,
          newRevision: "1",
          transferReceiptId: receiptId,
        });
      }
      const oldAContent = waitFor(
        a.socket,
        (v) =>
          (v.type === "rpc_error" && v.payload?.requestId === "case3-old-a-content") ||
          (v.message?.type === "rpc_error" &&
            v.message.payload?.requestId === "case3-old-a-content"),
      );
      a.socket.send(
        JSON.stringify({ type: "session", message: contentRequest("case3-old-a-content") }),
      );
      const oldAContentResult = await oldAContent;
      expect(oldAContentResult.payload ?? oldAContentResult.message?.payload).toMatchObject({
        requestId: "case3-old-a-content",
        code: expect.stringMatching(/^(access_denied|unavailable)$/),
      });
      const oldAPlacement = waitFor(
        a.socket,
        (v) =>
          (v.type === "rpc_error" && v.payload?.requestId === "case3-old-a-placement") ||
          (v.message?.type === "rpc_error" &&
            v.message.payload?.requestId === "case3-old-a-placement"),
      );
      a.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "enterprise.placement.resolve_workspace.request",
            requestId: "case3-old-a-placement",
            workspaceId,
          },
        }),
      );
      const oldAPlacementResult = await oldAPlacement;
      expect(oldAPlacementResult.payload ?? oldAPlacementResult.message?.payload).toMatchObject({
        requestId: "case3-old-a-placement",
        code: expect.stringMatching(/^(access_denied|unavailable)$/),
      });
      const b = await harness.connectAndHello({ token: issuedB.token, clientId: "case3-b" });
      const bPlacement = waitFor(
        b.socket,
        (v) => v.message?.payload?.requestId === "case3-b-placement",
      );
      b.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "enterprise.placement.resolve_workspace.request",
            requestId: "case3-b-placement",
            workspaceId,
          },
        }),
      );
      const bPlacementResult = await bPlacement;
      expect(bPlacementResult.message?.payload).toMatchObject({
        requestId: "case3-b-placement",
        resource: { localResourceId: workspaceId },
      });
      const afterContent = waitFor(
        b.socket,
        (v) =>
          v.message?.type === "enterprise.workspace.content.read.response" &&
          v.message.payload?.requestId === "case3-after-content",
      );
      b.socket.send(
        JSON.stringify({ type: "session", message: contentRequest("case3-after-content") }),
      );
      const afterContentResult = await afterContent;
      expect(afterContentResult.message?.payload).toMatchObject({
        requestId: "case3-after-content",
        resource: { localResourceId: workspaceId },
      });
      const aLateFrames: ProductionDirectWsEnvelope[] = [];
      const onAFrame = (data: Buffer) => {
        try {
          aLateFrames.push(JSON.parse(data.toString()) as ProductionDirectWsEnvelope);
        } catch {
          // Ignore non-JSON frames.
        }
      };
      a.socket.on("message", onAFrame);
      const bTitle = waitFor(b.socket, (v) => v.message?.payload?.requestId === "case3-b-title");
      b.socket.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "workspace.title.set.request",
            requestId: "case3-b-title",
            workspaceId,
            title: "Case3 transferred title",
          },
        }),
      );
      const bTitleResult = await bTitle;
      expect(bTitleResult.message?.type).toBe("workspace.title.set.response");
      expect(bTitleResult.message?.payload).toMatchObject({
        requestId: "case3-b-title",
        accepted: true,
        title: "Case3 transferred title",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      a.socket.off("message", onAFrame);
      expect(
        aLateFrames.some(
          (frame) =>
            frame.message?.type === "workspace_update" &&
            frame.message.payload?.kind === "upsert" &&
            frame.message.payload.workspace?.id === workspaceId,
        ),
      ).toBe(false);
      const transferDenied = async (
        requestId: string,
        resource: Record<string, unknown>,
        expectedRevision = "0",
      ) => {
        const denied = waitFor(
          b.socket,
          (v) =>
            (v.type === "rpc_error" && v.payload?.requestId === requestId) ||
            (v.message?.type === "rpc_error" && v.message.payload?.requestId === requestId),
        );
        b.socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "enterprise.resource.ownership.transfer.request",
              requestId,
              resource,
              expectedOwnerPrincipalId: principalB,
              expectedRevision,
              newPrincipalId: principalA,
            },
          }),
        );
        const value = await denied;
        expect(value.payload ?? value.message?.payload).toMatchObject({
          requestId,
          code: expect.stringMatching(/^(access_denied|unavailable)$/),
        });
      };
      const transferEventCount = transferEvents.length;
      await transferDenied("case3-replay", {
        resourceKind: "workspace",
        localResourceId: workspaceId,
        organizationId,
        nodeId,
      });
      await transferDenied(
        "case3-guess",
        {
          resourceKind: "workspace",
          localResourceId: "wks_3333333333333334",
          organizationId,
          nodeId,
        },
        "9",
      );
      await transferDenied("case3-agent", {
        resourceKind: "agent",
        localResourceId: agentId,
        organizationId,
        nodeId,
      });
      expect(
        (await harness.runtime.audit.snapshotEvents()).filter(
          (event) =>
            event.action === "enterprise.resource.ownership.transfer" &&
            event.outcome === "allowed",
        ),
      ).toHaveLength(transferEventCount);
      await harness.stop();
      await harness.reopen();
      const persisted = JSON.parse(
        await readFile(path.join(harness.paseoHome, "projects", "workspaces.json"), "utf8"),
      ) as Array<Record<string, unknown>>;
      expect(persisted[0]).toMatchObject({ ownerPrincipalId: principalB });
      const reopenedA = await harness.connectAndHello({
        token: (await harness.issuePersonalAccessToken(principalA)).token,
        clientId: "case3-a-reopen",
      });
      const reopenedB = await harness.connectAndHello({
        token: (await harness.issuePersonalAccessToken(principalB)).token,
        clientId: "case3-b-reopen",
      });
      const reopenedADenial = waitFor(
        reopenedA.socket,
        (v) =>
          (v.type === "rpc_error" && v.payload?.requestId === "case3-reopen-a") ||
          (v.message?.type === "rpc_error" && v.message.payload?.requestId === "case3-reopen-a"),
      );
      reopenedA.socket.send(
        JSON.stringify({ type: "session", message: contentRequest("case3-reopen-a") }),
      );
      expect(
        (await reopenedADenial).payload ?? (await reopenedADenial).message?.payload,
      ).toMatchObject({
        requestId: "case3-reopen-a",
        code: expect.stringMatching(/^(access_denied|unavailable)$/),
      });
      const reopenedBContent = waitFor(
        reopenedB.socket,
        (v) =>
          v.message?.type === "enterprise.workspace.content.read.response" &&
          v.message.payload?.requestId === "case3-reopen-b",
      );
      reopenedB.socket.send(
        JSON.stringify({ type: "session", message: contentRequest("case3-reopen-b") }),
      );
      await reopenedBContent;
      reopenedA.socket.close();
      reopenedB.socket.close();
    } finally {
      await harness.close();
    }
  }, 60_000);
});
