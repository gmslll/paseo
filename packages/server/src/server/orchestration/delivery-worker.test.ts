import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  DeliveryWorker,
  buildDeliveryInjection,
  deliveryMessageId,
  type DeliveryInjection,
  type DeliveryTarget,
} from "./delivery-worker.js";
import { OperationStore, type AcceptOperationInput } from "./operation-store.js";
import {
  standaloneOrchestrationAuthority,
  type OrchestrationAuditEvent,
  type OrchestrationAuthority,
} from "./orchestration-authority.js";

const REQUESTER = "requester-agent";
const RETRY_DELAY_MS = 5_000;

let directory: string;
let clock: number;

// The requester timeline outlives daemon boots, like a provider transcript does.
class RequesterTimeline implements DeliveryTarget {
  readonly injected: DeliveryInjection[] = [];
  readonly unavailable = new Set<string>();
  failuresBeforeInjection = 0;

  async prepare(injection: DeliveryInjection): Promise<"ready" | "requester_unavailable"> {
    return this.unavailable.has(injection.requesterAgentId) ? "requester_unavailable" : "ready";
  }

  async deliver(injection: DeliveryInjection): Promise<void> {
    if (this.failuresBeforeInjection > 0) {
      this.failuresBeforeInjection -= 1;
      throw new Error("requester failed to load");
    }
    this.injected.push(injection);
  }

  async hasDelivered(injection: DeliveryInjection): Promise<boolean> {
    return this.injected.some(
      (candidate) =>
        candidate.messageId === injection.messageId || candidate.prompt.includes(injection.marker),
    );
  }

  countOf(messageId: string): number {
    return this.injected.filter((injection) => injection.messageId === messageId).length;
  }
}

function openStore(): OperationStore {
  return OperationStore.open({
    path: path.join(directory, "operations.sqlite3"),
    formatCompletion: (operation) =>
      operation.items.map((item) => `${item.targetAgentId} ${item.outcome}`).join("\n"),
    now: () => clock,
  });
}

function createWorker(input: {
  store: OperationStore;
  bootId: string;
  timeline: RequesterTimeline;
  authority?: OrchestrationAuthority;
}): DeliveryWorker {
  return new DeliveryWorker({
    store: input.store,
    bootId: input.bootId,
    target: input.timeline,
    authority: input.authority ?? standaloneOrchestrationAuthority,
    logger: createTestLogger(),
    now: () => clock,
    retryDelayMs: RETRY_DELAY_MS,
  });
}

function acceptRunningOperation(store: OperationStore, bootId: string): AcceptOperationInput {
  const input: AcceptOperationInput = {
    requesterAgentId: REQUESTER,
    operationId: "op-1",
    kind: "agent_create",
    fingerprint: "fingerprint",
    authority: { mode: "standalone" },
    deadlineAt: clock + 60_000,
    items: [{ targetAgentId: "child-agent", command: { kind: "create" } }],
  };
  store.accept(input);
  const claim = store.claimNextItem(bootId)!;
  store.markItemRunning({ ...claim, bootId });
  return input;
}

function finishOperation(store: OperationStore, bootId: string): string {
  const key = acceptRunningOperation(store, bootId);
  store.settleItem({ ...key, itemIndex: 0, outcome: "finished", lastMessage: "done" });
  return deliveryMessageId({ ...key, deliverySeq: 1 });
}

type CrashPhase = "claimed" | "prepared" | "started before injection" | "started after injection";

// Replays what a killed worker had written before it died.
function runOldBootUntil(input: {
  store: OperationStore;
  timeline: RequesterTimeline;
  phase: CrashPhase;
  bootId: string;
}): void {
  const claim = input.store.claimNextDelivery(input.bootId)!;
  if (input.phase === "claimed") return;
  input.store.markDeliveryPrepared(claim, input.bootId);
  if (input.phase === "prepared") return;
  input.store.markDeliveryStarted(claim, input.bootId);
  if (input.phase === "started after injection") {
    input.timeline.injected.push(buildDeliveryInjection(claim));
  }
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "paseo-delivery-worker-"));
  clock = 5_000_000;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("DeliveryWorker", () => {
  it("injects a completion once as a system prompt carrying its message id and marker", async () => {
    const store = openStore();
    const timeline = new RequesterTimeline();
    const messageId = finishOperation(store, "boot-a");
    const worker = createWorker({ store, bootId: "boot-a", timeline });

    await worker.kick();
    await worker.kick();

    expect(timeline.injected).toHaveLength(1);
    const [injection] = timeline.injected;
    expect(injection?.messageId).toBe(messageId);
    expect(injection?.prompt).toBe(
      `<paseo-system>\n[paseo-delivery ${messageId}]\nchild-agent finished\n</paseo-system>`,
    );
    expect(
      store.getOperation({ requesterAgentId: REQUESTER, operationId: "op-1" })?.deliveries,
    ).toEqual([expect.objectContaining({ phase: "consumed", attempts: 1 })]);
    await worker.stop();
    store.close();
  });

  it.each<CrashPhase>([
    "claimed",
    "prepared",
    "started before injection",
    "started after injection",
  ])("shows exactly one completion when the worker dies after %s", async (phase) => {
    const oldStore = openStore();
    const timeline = new RequesterTimeline();
    const messageId = finishOperation(oldStore, "boot-a");
    runOldBootUntil({ store: oldStore, timeline, phase, bootId: "boot-a" });
    oldStore.close();

    const store = openStore();
    store.recoverBoot("boot-b");
    const worker = createWorker({ store, bootId: "boot-b", timeline });
    await worker.kick();

    expect(timeline.countOf(messageId)).toBe(1);
    expect(store.claimNextDelivery("boot-b")).toBeNull();
    await worker.stop();
    store.close();
  });

  it("records an uncertain delivery after its retry also dies before reaching the requester", async () => {
    const timeline = new RequesterTimeline();
    const firstBoot = openStore();
    finishOperation(firstBoot, "boot-a");
    runOldBootUntil({
      store: firstBoot,
      timeline,
      phase: "started before injection",
      bootId: "boot-a",
    });
    firstBoot.close();

    const secondBoot = openStore();
    secondBoot.recoverBoot("boot-b");
    runOldBootUntil({
      store: secondBoot,
      timeline,
      phase: "started before injection",
      bootId: "boot-b",
    });
    secondBoot.close();

    const store = openStore();
    store.recoverBoot("boot-c");
    const worker = createWorker({ store, bootId: "boot-c", timeline });
    await worker.kick();

    expect(timeline.injected).toEqual([]);
    expect(
      store.getOperation({ requesterAgentId: REQUESTER, operationId: "op-1" })?.deliveries,
    ).toEqual([
      expect.objectContaining({
        phase: "abandoned",
        attempts: 2,
        errorCode: "DELIVERY_EXECUTION_UNCERTAIN",
      }),
    ]);
    await worker.stop();
    store.close();
  });

  it("retries a failed injection after the delay and still delivers once", async () => {
    const store = openStore();
    const timeline = new RequesterTimeline();
    timeline.failuresBeforeInjection = 1;
    const messageId = finishOperation(store, "boot-a");
    const worker = createWorker({ store, bootId: "boot-a", timeline });

    await worker.kick();
    expect(timeline.injected).toEqual([]);

    clock += RETRY_DELAY_MS;
    await worker.kick();
    expect(timeline.countOf(messageId)).toBe(1);
    await worker.stop();
    store.close();
  });

  it("abandons a delivery to an archived requester without injecting", async () => {
    const store = openStore();
    const timeline = new RequesterTimeline();
    timeline.unavailable.add(REQUESTER);
    finishOperation(store, "boot-a");
    const worker = createWorker({ store, bootId: "boot-a", timeline });

    await worker.kick();

    expect(timeline.injected).toEqual([]);
    expect(
      store.getOperation({ requesterAgentId: REQUESTER, operationId: "op-1" })?.deliveries,
    ).toEqual([
      expect.objectContaining({ phase: "abandoned", errorCode: "REQUESTER_UNAVAILABLE" }),
    ]);
    await worker.stop();
    store.close();
  });

  it("finishes the operation and injects nothing once the requester authority is revoked", async () => {
    const store = openStore();
    const timeline = new RequesterTimeline();
    const key = acceptRunningOperation(store, "boot-a");
    store.enqueueCheckpoint({
      ...key,
      dedupeKey: "permission:0:request-1",
      body: "needs permission",
    });
    const revoked: OrchestrationAuthority = {
      ...standaloneOrchestrationAuthority,
      isCurrent: () => false,
    };
    const worker = createWorker({ store, bootId: "boot-a", timeline, authority: revoked });

    await worker.kick();

    expect(timeline.injected).toEqual([]);
    const operation = store.getOperation(key)!;
    expect(operation).toMatchObject({ status: "finished", errorCode: "AUTHORIZATION_REVOKED" });
    expect(operation.items.map((item) => item.outcome)).toEqual(["authorization_revoked"]);
    expect(operation.deliveries.map((delivery) => [delivery.phase, delivery.errorCode])).toEqual([
      ["abandoned", "AUTHORIZATION_REVOKED"],
    ]);
    await worker.stop();
    store.close();
  });
});

describe("DeliveryWorker audit", () => {
  function recordingAuthority(events: OrchestrationAuditEvent[]): OrchestrationAuthority {
    return {
      ...standaloneOrchestrationAuthority,
      record: async (event) => {
        events.push(event);
      },
    };
  }

  it("records each consumed delivery once and an uncertain delivery it gives up on", async () => {
    const timeline = new RequesterTimeline();
    const events: OrchestrationAuditEvent[] = [];
    const firstBoot = openStore();
    finishOperation(firstBoot, "boot-a");
    runOldBootUntil({
      store: firstBoot,
      timeline,
      phase: "started before injection",
      bootId: "boot-a",
    });
    firstBoot.close();
    const secondBoot = openStore();
    secondBoot.recoverBoot("boot-b");
    runOldBootUntil({
      store: secondBoot,
      timeline,
      phase: "started before injection",
      bootId: "boot-b",
    });
    secondBoot.close();

    const store = openStore();
    store.recoverBoot("boot-c");
    const key = { requesterAgentId: REQUESTER, operationId: "op-2" };
    store.accept({
      ...key,
      kind: "agent_create",
      fingerprint: "fingerprint-2",
      authority: { mode: "standalone" },
      deadlineAt: clock + 60_000,
      items: [{ targetAgentId: "child-two", command: { kind: "create" } }],
    });
    const claim = store.claimNextItem("boot-c")!;
    store.markItemRunning({ ...claim, bootId: "boot-c" });
    store.settleItem({ ...key, itemIndex: 0, outcome: "finished" });
    const worker = createWorker({
      store,
      bootId: "boot-c",
      timeline,
      authority: recordingAuthority(events),
    });
    await worker.kick();

    expect(events.map((event) => [event.action, event.operationId, event.metadata])).toEqual([
      ["orchestration.delivery.uncertain", "op-1", { deliverySeq: "1", kind: "completion" }],
      ["orchestration.delivery.consumed", "op-2", { deliverySeq: "1", kind: "completion" }],
    ]);
    await worker.stop();
    store.close();
  });
});
