import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentCompletionReason } from "../agent/agent-completion-watch.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import type { DeliveryInjection } from "./delivery-worker.js";
import {
  OperationService,
  formatOperationCompletion,
  type DelegationItem,
  type DelegationUserMessage,
  type OrchestrationAgentPort,
} from "./operation-service.js";
import { OperationStore } from "./operation-store.js";
import {
  standaloneOrchestrationAuthority,
  type OrchestrationAuthority,
} from "./orchestration-authority.js";
import { OrchestrationError } from "./orchestration-error.js";

const REQUESTER = "parent-agent";

let directory: string;
let clock: number;
let cleanups: Array<() => Promise<void>>;

type WatchInput = Parameters<OrchestrationAgentPort["watchCompletion"]>[0];

class FakeAgents implements OrchestrationAgentPort {
  readonly existing = new Set<string>();
  readonly created: Array<{ agentId: string; requesterAgentId: string; messageId: string }> = [];
  readonly prompted: Array<{ agentId: string; prompt: string; messageId: string }> = [];
  readonly injected: DeliveryInjection[] = [];
  readonly lastMessages = new Map<string, string>();
  failNextDispatch: string | null = null;
  private readonly watchers = new Map<string, WatchInput>();
  private userMessageListener: ((message: DelegationUserMessage) => void) | null = null;

  async agentExists(agentId: string): Promise<boolean> {
    return this.existing.has(agentId);
  }

  async createAgent(input: { agentId: string; requesterAgentId: string; messageId: string }) {
    this.failIfRequested();
    this.existing.add(input.agentId);
    this.created.push({
      agentId: input.agentId,
      requesterAgentId: input.requesterAgentId,
      messageId: input.messageId,
    });
  }

  async promptAgent(input: { agentId: string; prompt: string; messageId: string }) {
    this.failIfRequested();
    this.prompted.push({
      agentId: input.agentId,
      prompt: input.prompt,
      messageId: input.messageId,
    });
  }

  watchCompletion(input: WatchInput) {
    this.watchers.set(input.agentId, input);
    return {
      attached: this.existing.has(input.agentId),
      stop: () => {
        this.watchers.delete(input.agentId);
      },
    };
  }

  async lastAssistantMessage(agentId: string): Promise<string | null> {
    return this.lastMessages.get(agentId) ?? null;
  }

  subscribeUserMessages(listener: (message: DelegationUserMessage) => void): () => void {
    this.userMessageListener = listener;
    return () => {
      this.userMessageListener = null;
    };
  }

  async prepare(): Promise<"ready"> {
    return "ready";
  }

  async deliver(injection: DeliveryInjection): Promise<void> {
    this.injected.push(injection);
  }

  async hasDelivered(injection: DeliveryInjection): Promise<boolean> {
    return this.injected.some(
      (candidate) =>
        candidate.messageId === injection.messageId || candidate.prompt.includes(injection.marker),
    );
  }

  finish(agentId: string, reason: AgentCompletionReason = "finished"): void {
    const watcher = this.watchers.get(agentId);
    if (!watcher) throw new Error(`${agentId} is not watched`);
    this.watchers.delete(agentId);
    watcher.onCompletion(reason);
  }

  requestPermission(agentId: string, requestId: string): void {
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: "claude",
      name: "Bash",
      kind: "tool",
      description: "Run a command",
      input: { command: "ls" },
    };
    this.watchers.get(agentId)?.onPermissionRequested(request);
  }

  isWatching(agentId: string): boolean {
    return this.watchers.has(agentId);
  }

  emitUserMessage(message: DelegationUserMessage): void {
    this.userMessageListener?.(message);
  }

  private failIfRequested(): void {
    const failure = this.failNextDispatch;
    this.failNextDispatch = null;
    if (failure) throw new Error(failure);
  }
}

function createItem(title: string): DelegationItem {
  return {
    kind: "create",
    title,
    workspaceId: "workspace-1",
    spec: { provider: "claude/claude-test-model", initialPrompt: `work on ${title}` },
  };
}

function openStore(): OperationStore {
  return OperationStore.open({
    path: path.join(directory, "operations.sqlite3"),
    formatCompletion: formatOperationCompletion,
    now: () => clock,
  });
}

async function startService(input: {
  agents: FakeAgents;
  bootId: string;
  authority?: OrchestrationAuthority;
}): Promise<{ service: OperationService; store: OperationStore }> {
  const store = openStore();
  const service = new OperationService({
    store,
    bootId: input.bootId,
    agents: input.agents,
    authority: input.authority ?? standaloneOrchestrationAuthority,
    logger: createTestLogger(),
    now: () => clock,
  });
  await service.start();
  cleanups.push(async () => {
    await service.stop();
    store.close();
  });
  return { service, store };
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return error instanceof OrchestrationError ? error.code : String(error);
  }
  return null;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "paseo-operation-service-"));
  clock = 10_000_000;
  cleanups = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  rmSync(directory, { recursive: true, force: true });
});

describe("OperationService delegation", () => {
  it("creates fan-out Agents, relays a permission checkpoint, and delivers one completion", async () => {
    const agents = new FakeAgents();
    const { service } = await startService({ agents, bootId: "boot-a" });

    const accepted = await service.accept({
      requesterAgentId: REQUESTER,
      operationId: "fan-out",
      items: [createItem("alpha"), createItem("beta")],
    });
    const dispatched = await service.waitForDispatch(accepted.operation);
    expect(dispatched.items.map((item) => item.state)).toEqual(["running", "running"]);
    expect(agents.created.map((created) => [created.messageId, created.requesterAgentId])).toEqual([
      ["op:fan-out:i:0", REQUESTER],
      ["op:fan-out:i:1", REQUESTER],
    ]);
    const [alpha, beta] = dispatched.items.map((item) => item.targetAgentId);

    agents.requestPermission(alpha!, "request-1");
    agents.lastMessages.set(alpha!, "alpha done");
    agents.finish(alpha!);
    await service.whenIdle();
    expect(agents.injected.map((injection) => injection.messageId)).toEqual(["op:fan-out:d:1"]);
    expect(agents.injected[0]?.prompt).toContain(`Agent ${alpha} (alpha) needs permission.`);

    agents.finish(beta!, "errored");
    await service.whenIdle();
    expect(agents.injected.map((injection) => injection.messageId)).toEqual([
      "op:fan-out:d:1",
      "op:fan-out:d:2",
    ]);
    const completion = agents.injected[1]?.prompt ?? "";
    expect(completion).toContain("Operation fan-out finished for 2 Agents.");
    expect(completion).toContain(
      `Agent ${alpha} (alpha) finished.\n\n<agent-response>\nalpha done\n</agent-response>`,
    );
    expect(completion).toContain(`Agent ${beta} (beta) errored.`);
  });

  it("replays the same command without a second Agent and rejects a different command", async () => {
    const agents = new FakeAgents();
    const { service } = await startService({ agents, bootId: "boot-a" });
    const request = {
      requesterAgentId: REQUESTER,
      operationId: "same-op",
      items: [createItem("alpha")],
    };

    const accepted = await service.accept(request);
    await service.waitForDispatch(accepted.operation);
    const replayed = await service.accept({ ...request, items: [createItem("alpha")] });

    expect(replayed.replayed).toBe(true);
    expect(replayed.operation.items[0]?.targetAgentId).toBe(
      accepted.operation.items[0]?.targetAgentId,
    );
    expect(agents.created).toHaveLength(1);
    expect(await rejectionCode(service.accept({ ...request, items: [createItem("gamma")] }))).toBe(
      "OPERATION_ID_CONFLICT",
    );
    expect(await rejectionCode(service.accept({ ...request, deadlineSeconds: 59 }))).toBe(
      "INVALID_OPERATION",
    );
  });

  it("creates nothing when the requester may not reach a target", async () => {
    const agents = new FakeAgents();
    const denying: OrchestrationAuthority = {
      authorizeAccept: async () => {
        throw new OrchestrationError("AUTHORIZATION_DENIED", "Workspace unavailable");
      },
      isCurrent: () => true,
    };
    const { service, store } = await startService({ agents, bootId: "boot-a", authority: denying });

    expect(
      await rejectionCode(
        service.accept({ requesterAgentId: REQUESTER, items: [createItem("alpha")] }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
    await service.whenIdle();
    expect(store.listOperations({ limit: 10 })).toEqual([]);
    expect(agents.created).toEqual([]);
  });

  it("counts prompted turns in the chain until a person prompts the Agent", async () => {
    const agents = new FakeAgents();
    agents.existing.add("worker");
    const { service, store } = await startService({ agents, bootId: "boot-a" });

    const accepted = await service.accept({
      requesterAgentId: REQUESTER,
      operationId: "prompt-worker",
      items: [{ kind: "prompt", title: "Worker", agentId: "worker", prompt: "continue" }],
    });
    await service.waitForDispatch(accepted.operation);
    expect(agents.prompted).toEqual([
      { agentId: "worker", prompt: "continue", messageId: "op:prompt-worker:i:0" },
    ]);
    expect(store.getChainDepth("worker")).toBe(1);

    agents.emitUserMessage({
      agentId: "worker",
      clientMessageId: "op:prompt-worker:i:0",
      text: "continue",
    });
    agents.emitUserMessage({
      agentId: "worker",
      text: formatSystemNotificationPrompt("Agent child finished."),
    });
    expect(store.getChainDepth("worker")).toBe(1);

    agents.emitUserMessage({ agentId: "worker", clientMessageId: "client-1", text: "hi" });
    expect(store.getChainDepth("worker")).toBe(0);
  });
});

describe("OperationService lifecycle", () => {
  it("reports a failed dispatch as the completion", async () => {
    const agents = new FakeAgents();
    agents.failNextDispatch = "provider unavailable";
    const { service } = await startService({ agents, bootId: "boot-a" });

    const accepted = await service.accept({
      requesterAgentId: REQUESTER,
      items: [createItem("alpha")],
    });
    const dispatched = await service.waitForDispatch(accepted.operation);
    expect(dispatched.items[0]).toMatchObject({
      state: "settled",
      outcome: "failed",
      errorMessage: "provider unavailable",
    });

    await service.whenIdle();
    expect(agents.injected).toHaveLength(1);
    expect(agents.injected[0]?.prompt).toContain("(alpha) failed to start: provider unavailable.");
  });

  it("recreates a never-created Agent under the same ID and reports started work as interrupted", async () => {
    const agents = new FakeAgents();
    const oldBoot = openStore();
    const key = { requesterAgentId: REQUESTER, operationId: "restart-op" };
    oldBoot.accept({
      ...key,
      kind: "agent_create_many",
      fingerprint: "fingerprint",
      authority: { mode: "standalone" },
      deadlineAt: clock + 60 * 60 * 1000,
      items: [
        { targetAgentId: "started-agent", command: createItem("started") },
        { targetAgentId: "unborn-agent", command: createItem("unborn") },
      ],
    });
    const startedClaim = oldBoot.claimNextItem("boot-a")!;
    agents.existing.add("started-agent");
    oldBoot.markItemRunning({ ...startedClaim, bootId: "boot-a" });
    oldBoot.claimNextItem("boot-a");
    oldBoot.close();

    const { service } = await startService({ agents, bootId: "boot-b" });
    const dispatched = await service.waitForDispatch(key);
    expect(dispatched.items.map((item) => [item.targetAgentId, item.state, item.outcome])).toEqual([
      ["started-agent", "settled", "interrupted"],
      ["unborn-agent", "running", null],
    ]);
    expect(agents.created.map((created) => created.agentId)).toEqual(["unborn-agent"]);

    agents.finish("unborn-agent");
    await service.whenIdle();
    expect(agents.injected).toHaveLength(1);
    expect(agents.injected[0]?.prompt).toContain(
      "Agent started-agent (started) was interrupted by a daemon restart.",
    );
    expect(agents.injected[0]?.prompt).toContain("Agent unborn-agent (unborn) finished.");
  });

  it("times out unfinished work at the deadline and stops watching it", async () => {
    const agents = new FakeAgents();
    const { service } = await startService({ agents, bootId: "boot-a" });
    const accepted = await service.accept({
      requesterAgentId: REQUESTER,
      deadlineSeconds: 60,
      items: [createItem("slow")],
    });
    const [item] = (await service.waitForDispatch(accepted.operation)).items;

    clock += 60_000;
    await service.expireDeadlines();
    await service.whenIdle();

    expect(agents.isWatching(item!.targetAgentId)).toBe(false);
    expect(service.getOperation(accepted.operation)?.items[0]?.outcome).toBe("timed_out");
    expect(agents.injected[0]?.prompt).toContain(
      "(slow) did not finish before the operation deadline.",
    );
  });

  it("cancels without a completion and ignores the Agent finishing afterwards", async () => {
    const agents = new FakeAgents();
    const { service } = await startService({ agents, bootId: "boot-a" });
    const accepted = await service.accept({
      requesterAgentId: REQUESTER,
      items: [createItem("alpha")],
    });
    const [item] = (await service.waitForDispatch(accepted.operation)).items;

    const canceled = service.cancel(accepted.operation);
    await service.whenIdle();

    expect(canceled.status).toBe("canceled");
    expect(agents.isWatching(item!.targetAgentId)).toBe(false);
    expect(agents.injected).toEqual([]);
  });
});
