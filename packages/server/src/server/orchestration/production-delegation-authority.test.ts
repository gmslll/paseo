import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED,
  createProductionDirectDaemonTestHarness,
  type ProductionDirectDaemonTestHarness,
  type ProductionDirectSocket,
  type ProductionDirectTestPrincipal,
  type ProductionDirectWsEnvelope,
} from "../enterprise/audit/production-direct-daemon-test-helper.js";
import { createEnterpriseRuntimeOrchestrationAuthority } from "./enterprise-orchestration-authority.js";
import { formatOperationCompletion } from "./operation-service.js";
import { OperationStore } from "./operation-store.js";
import { OrchestrationError } from "./orchestration-error.js";

const ORGANIZATION = "org_4242424242424242";
const NODE = "nod_4242424242424242";
const ALICE = "usr_aaaaaaaaaaaaaaaa";
const BOB = "usr_bbbbbbbbbbbbbbbb";
const ALICE_WORKSPACE = "wks_aaaaaaaaaaaaaaaa";
const BOB_WORKSPACE = "wks_bbbbbbbbbbbbbbbb";
const ALICE_AGENT = "00000000-0000-4000-8000-0000000000a1";
const BOB_AGENT = "00000000-0000-4000-8000-0000000000b1";
const OPERATION_ID = "seeded-delegation";
const TIMESTAMP = "2026-09-16T00:00:00.000Z";

const selfGrants = [
  { action: "workspace.metadata.read" as const, selector: { kind: "self" as const } },
  { action: "workspace.content.read" as const, selector: { kind: "self" as const } },
  { action: "workspace.write" as const, selector: { kind: "self" as const } },
];

const principals: ProductionDirectTestPrincipal[] = [
  { principalId: ALICE, grantVersion: "grv_delegation_a", grants: selfGrants },
  { principalId: BOB, grantVersion: "grv_delegation_b", grants: selfGrants },
];

interface SeededOwner {
  principalId: string;
  workspaceId: string;
  agentId: string;
  name: string;
}

const owners: SeededOwner[] = [
  { principalId: ALICE, workspaceId: ALICE_WORKSPACE, agentId: ALICE_AGENT, name: "alice" },
  { principalId: BOB, workspaceId: BOB_WORKSPACE, agentId: BOB_AGENT, name: "bob" },
];

// Mirrors AgentStorage's directory naming for a POSIX cwd.
function agentDirectory(paseoHome: string, cwd: string): string {
  return path.join(paseoHome, "agents", cwd.replace(/^\/+/, "").replace(/\/+/g, "-"));
}

async function seedWorkspacesAndAgents(harness: ProductionDirectDaemonTestHarness): Promise<void> {
  const roots = new Map<string, string>();
  for (const owner of owners) {
    const input = path.join(harness.root, `${owner.name}-workspace`);
    await mkdir(input, { recursive: true, mode: 0o700 });
    roots.set(owner.name, await realpath(input));
  }
  const ownership = (owner: SeededOwner) => ({
    organizationId: ORGANIZATION,
    nodeId: NODE,
    ownerPrincipalId: owner.principalId,
    createdByPrincipalId: owner.principalId,
  });
  await mkdir(path.join(harness.paseoHome, "projects"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(harness.paseoHome, "projects", "workspaces.json"),
    JSON.stringify(
      owners.map((owner) => ({
        workspaceId: owner.workspaceId,
        ...ownership(owner),
        projectId: `project-${owner.name}`,
        cwd: roots.get(owner.name),
        kind: "directory",
        displayName: owner.name,
        title: null,
        branch: null,
        worktreeRoot: null,
        baseBranch: null,
        mainRepoRoot: null,
        isPaseoOwnedWorktree: false,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        archivedAt: null,
      })),
    ),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(harness.paseoHome, "projects", "projects.json"),
    JSON.stringify(
      owners.map((owner) => ({
        projectId: `project-${owner.name}`,
        rootPath: roots.get(owner.name),
        kind: "non_git",
        displayName: owner.name,
        projectKey: null,
        customName: null,
        customIconRevision: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        archivedAt: null,
      })),
    ),
    { mode: 0o600 },
  );
  for (const owner of owners) {
    const cwd = roots.get(owner.name)!;
    const directory = agentDirectory(harness.paseoHome, cwd);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(directory, `${owner.agentId}.json`),
      JSON.stringify({
        id: owner.agentId,
        provider: "claude",
        cwd,
        workspaceId: owner.workspaceId,
        ...ownership(owner),
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        title: `${owner.name} agent`,
        labels: {},
        lastStatus: "closed",
        archivedAt: null,
      }),
      { mode: 0o600 },
    );
  }
}

// A delegation Alice's Agent already finished and delivered, so the daemon has nothing to run.
function seedFinishedOperation(paseoHome: string): void {
  const store = OperationStore.open({
    path: path.join(paseoHome, "orchestration", "operations.sqlite3"),
    formatCompletion: formatOperationCompletion,
  });
  try {
    const key = { requesterAgentId: ALICE_AGENT, operationId: OPERATION_ID };
    store.accept({
      ...key,
      kind: "agent_prompt",
      fingerprint: "seeded",
      deadlineAt: Date.now() + 60 * 60 * 1000,
      authority: {
        mode: "enterprise",
        principal: {
          principalType: "human",
          principalId: ALICE,
          organizationId: ORGANIZATION,
          credentialId: `agent-delegation:${ALICE_AGENT}`,
          grantVersion: "grv_delegation_a",
          grants: selfGrants,
        },
      },
      items: [
        {
          targetAgentId: ALICE_AGENT,
          command: {
            kind: "prompt",
            title: "alice agent",
            agentId: ALICE_AGENT,
            prompt: "summarize",
          },
        },
      ],
    });
    const claim = store.claimNextItem("seed")!;
    store.markItemRunning({ ...claim, bootId: "seed" });
    store.settleItem({ ...key, itemIndex: 0, outcome: "finished", lastMessage: "done" });
    const delivery = store.claimNextDelivery("seed")!;
    store.markDeliveryConsumed(delivery, "seed");
  } finally {
    store.close();
  }
}

function sendSessionRequest(
  client: ProductionDirectSocket,
  message: { type: string; requestId: string } & Record<string, unknown>,
): Promise<NonNullable<ProductionDirectWsEnvelope["message"]>> {
  const { socket } = client;
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      let envelope: ProductionDirectWsEnvelope;
      try {
        envelope = JSON.parse(data.toString()) as ProductionDirectWsEnvelope;
      } catch {
        return;
      }
      if (!envelope.message || envelope.message.payload?.requestId !== message.requestId) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(envelope.message);
    };
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`${message.type} timed out`));
    }, 10_000);
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "session", message }));
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

describe.runIf(PRODUCTION_DIRECT_DAEMON_TEST_SUPPORTED)("production delegation authority", () => {
  test("delegates as the Workspace owner and answers operation RPCs only for visible requesters", async () => {
    const harness = await createProductionDirectDaemonTestHarness({
      name: "delegation-authority",
      serverId: "srv_delegation",
      organizationId: ORGANIZATION,
      nodeId: NODE,
      principals,
    });
    try {
      await seedWorkspacesAndAgents(harness);
      seedFinishedOperation(harness.paseoHome);
      await harness.start();
      const alice = await harness.connectAndHello({
        token: (await harness.issuePersonalAccessToken(ALICE)).token,
        clientId: "delegation-alice",
      });
      const bob = await harness.connectAndHello({
        token: (await harness.issuePersonalAccessToken(BOB)).token,
        clientId: "delegation-bob",
      });
      const features = alice.serverInfo.message?.payload?.features as Record<string, unknown>;
      expect(features.orchestrationOutbox).toBe(true);

      const listed = await sendSessionRequest(alice, {
        type: "orchestration.operation.list.request",
        requestId: "alice-list",
        requesterAgentId: ALICE_AGENT,
      });
      expect(listed).toMatchObject({
        type: "orchestration.operation.list.response",
        payload: {
          operations: [
            expect.objectContaining({
              requesterAgentId: ALICE_AGENT,
              operationId: OPERATION_ID,
              status: "finished",
            }),
          ],
        },
      });
      expect(JSON.stringify(listed)).not.toContain("summarize");

      const unscoped = await sendSessionRequest(alice, {
        type: "orchestration.operation.list.request",
        requestId: "alice-unscoped",
      });
      expect(unscoped.type).toBe("rpc_error");

      const foreign = await sendSessionRequest(bob, {
        type: "orchestration.operation.get.request",
        requestId: "bob-get",
        requesterAgentId: ALICE_AGENT,
        operationId: OPERATION_ID,
      });
      expect(foreign).toMatchObject({
        type: "rpc_error",
        payload: { requestType: "orchestration.operation.get.request" },
      });

      const canceled = await sendSessionRequest(alice, {
        type: "orchestration.operation.cancel.request",
        requestId: "alice-cancel",
        requesterAgentId: ALICE_AGENT,
        operationId: OPERATION_ID,
      });
      expect(canceled).toMatchObject({
        type: "orchestration.operation.cancel.response",
        payload: { operation: { operationId: OPERATION_ID, status: "finished" } },
      });

      const authority = createEnterpriseRuntimeOrchestrationAuthority(harness.runtime);
      expect(authority).not.toBeNull();
      expect(
        await authority!.authorizeAccept({
          requesterAgentId: ALICE_AGENT,
          targets: [{ kind: "create", workspaceId: ALICE_WORKSPACE }],
        }),
      ).toMatchObject({
        mode: "enterprise",
        principal: { principalId: ALICE, grantVersion: "grv_delegation_a" },
      });
      const denial = await rejectionOf(
        authority!.authorizeAccept({
          requesterAgentId: ALICE_AGENT,
          targets: [{ kind: "create", workspaceId: BOB_WORKSPACE }],
        }),
      );
      expect(denial).toBeInstanceOf(OrchestrationError);
      expect((denial as OrchestrationError).code).toBe("AUTHORIZATION_DENIED");
      const denials = (await harness.runtime.audit.snapshotEvents()).filter(
        (event) => event.action === "orchestration.operation.denied",
      );
      expect(denials).toEqual([
        expect.objectContaining({
          actorPrincipalId: ALICE,
          outcome: "denied",
          resource: { kind: "workspace", id: BOB_WORKSPACE },
          workspaceId: BOB_WORKSPACE,
        }),
      ]);
    } finally {
      await harness.close();
    }
  }, 180_000);
});
