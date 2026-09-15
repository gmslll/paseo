import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_CHAIN_DEPTH,
  OperationStore,
  type AcceptOperationInput,
  type OperationRecord,
} from "./operation-store.js";
import { OrchestrationError } from "./orchestration-error.js";

const BOOT_A = "boot-a";
const BOOT_B = "boot-b";
const BOOT_C = "boot-c";
const HOUR_MS = 60 * 60 * 1000;

let directory: string;
let clock: number;

function formatCompletion(operation: OperationRecord): string {
  return operation.items.map((item) => `${item.targetAgentId}:${item.outcome}`).join(",");
}

function openStore(): OperationStore {
  return OperationStore.open({
    path: path.join(directory, "orchestration", "operations.sqlite3"),
    formatCompletion,
    now: () => clock,
  });
}

function operationInput(
  overrides: Partial<AcceptOperationInput> & { targets?: readonly string[] } = {},
): AcceptOperationInput {
  const { targets = ["child-a"], ...rest } = overrides;
  return {
    requesterAgentId: "parent",
    operationId: "op-1",
    kind: targets.length > 1 ? "agent_create_many" : "agent_create",
    fingerprint: "fingerprint-1",
    authority: { mode: "standalone" },
    deadlineAt: clock + HOUR_MS,
    items: targets.map((targetAgentId) => ({
      targetAgentId,
      command: { kind: "create", title: targetAgentId },
    })),
    ...rest,
  };
}

function errorCodeOf(action: () => unknown): string | null {
  try {
    action();
  } catch (error) {
    return error instanceof OrchestrationError ? error.code : String(error);
  }
  return null;
}

function claimAndStart(store: OperationStore, bootId: string) {
  const claim = store.claimNextItem(bootId);
  if (!claim) throw new Error("expected a pending item");
  expect(store.markItemRunning({ ...claim, bootId })).toBe(true);
  return claim;
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "paseo-operation-store-"));
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("OperationStore acceptance", () => {
  it("replays an operation with the same fingerprint after a restart and rejects a different one", () => {
    const store = openStore();
    const accepted = store.accept(operationInput({ targets: ["child-a", "child-b"] }));
    expect(accepted.replayed).toBe(false);
    expect(accepted.operation.items.map((item) => item.state)).toEqual(["pending", "pending"]);
    store.close();

    const restarted = openStore();
    const replayed = restarted.accept(operationInput({ targets: ["child-a", "child-b"] }));
    expect(replayed.replayed).toBe(true);
    expect(replayed.operation.createdAt).toBe(accepted.operation.createdAt);
    expect(
      errorCodeOf(() => restarted.accept(operationInput({ fingerprint: "fingerprint-2" }))),
    ).toBe("OPERATION_ID_CONFLICT");
    expect(restarted.accept(operationInput({ requesterAgentId: "other-parent" })).replayed).toBe(
      false,
    );
    restarted.close();
  });

  it("stops a delegation chain at depth 32 until a person prompts the requester", () => {
    const store = openStore();
    let requester = "agent-0";
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
      const child = `agent-${depth + 1}`;
      store.accept(
        operationInput({
          requesterAgentId: requester,
          operationId: `op-${depth}`,
          targets: [child],
        }),
      );
      expect(store.claimNextItem(BOOT_A)?.targetAgentId).toBe(child);
      requester = child;
    }

    expect(store.getChainDepth("agent-32")).toBe(32);
    const deepOperation = operationInput({ requesterAgentId: "agent-32", operationId: "op-deep" });
    expect(errorCodeOf(() => store.accept(deepOperation))).toBe("CHAIN_DEPTH_EXCEEDED");
    expect(store.getOperation(deepOperation)).toBeNull();

    store.resetChainDepth("agent-32");
    expect(store.accept(deepOperation).operation.chainDepth).toBe(1);
    store.close();
  });
});

describe("OperationStore items", () => {
  it("materializes fan-out items one claim at a time and keeps target ids across a restart", () => {
    const store = openStore();
    store.accept(operationInput({ targets: ["child-a", "child-b"] }));

    const first = claimAndStart(store, BOOT_A);
    const second = store.claimNextItem(BOOT_A);
    expect(second?.targetAgentId).toBe("child-b");
    expect(store.claimNextItem(BOOT_A)).toBeNull();
    expect(
      store.markItemRunning({ ...second!, claimToken: first.claimToken, bootId: BOOT_A }),
    ).toBe(false);
    store.close();

    const restarted = openStore();
    const stale = restarted.listStaleItems(BOOT_B);
    expect(stale.map((item) => [item.itemIndex, item.state, item.targetAgentId])).toEqual([
      [0, "running", "child-a"],
      [1, "materializing", "child-b"],
    ]);
    expect(restarted.listStaleItems(BOOT_A).map((item) => item.itemIndex)).toEqual([]);

    expect(restarted.resetItemToPending(stale[1]!)).toBe(true);
    const retried = restarted.claimNextItem(BOOT_B);
    expect(retried?.targetAgentId).toBe("child-b");
    expect(retried?.claimToken).not.toBe(second?.claimToken);
    restarted.close();
  });

  it("finishes an operation with exactly one completion and deduplicates checkpoints", () => {
    const store = openStore();
    const key = operationInput({ targets: ["child-a", "child-b"] });
    store.accept(key);
    claimAndStart(store, BOOT_A);
    claimAndStart(store, BOOT_A);

    const checkpoint = { ...key, dedupeKey: "permission:0:request-1", body: "needs permission" };
    expect(store.enqueueCheckpoint(checkpoint)).toBe(true);
    expect(store.enqueueCheckpoint(checkpoint)).toBe(false);

    expect(
      store.settleItem({ ...key, itemIndex: 0, outcome: "finished", lastMessage: "done" }),
    ).toEqual({ settled: true, operationFinished: false });
    expect(store.settleItem({ ...key, itemIndex: 0, outcome: "errored" })).toEqual({
      settled: false,
      operationFinished: false,
    });
    expect(store.settleItem({ ...key, itemIndex: 1, outcome: "errored" })).toEqual({
      settled: true,
      operationFinished: true,
    });

    const operation = store.getOperation(key)!;
    expect(operation.status).toBe("finished");
    expect(operation.items.map((item) => [item.outcome, item.lastMessage])).toEqual([
      ["finished", "done"],
      ["errored", null],
    ]);
    expect(operation.deliveries.map((delivery) => [delivery.kind, delivery.body])).toEqual([
      ["checkpoint", "needs permission"],
      ["completion", "child-a:finished,child-b:errored"],
    ]);
    expect(store.enqueueCheckpoint({ ...checkpoint, dedupeKey: "permission:1:request-2" })).toBe(
      false,
    );
    store.close();
  });

  it("lists unsettled items once the operation deadline passes", () => {
    const store = openStore();
    const key = operationInput({ targets: ["child-a", "child-b"], deadlineAt: clock + 60_000 });
    store.accept(key);
    claimAndStart(store, BOOT_A);
    store.settleItem({ ...key, itemIndex: 0, outcome: "finished" });

    expect(store.listExpiredItems()).toEqual([]);
    clock += 60_000;
    expect(store.listExpiredItems().map((item) => [item.itemIndex, item.state])).toEqual([
      [1, "pending"],
    ]);
    store.close();
  });
});

describe("OperationStore closing", () => {
  it("cancels without a completion and abandons queued checkpoints", () => {
    const store = openStore();
    const key = operationInput({ targets: ["child-a", "child-b"] });
    store.accept(key);
    claimAndStart(store, BOOT_A);
    store.enqueueCheckpoint({
      ...key,
      dedupeKey: "permission:0:request-1",
      body: "needs permission",
    });

    const canceled = store.cancel(key);
    expect(canceled.status).toBe("canceled");
    expect(canceled.items.map((item) => item.outcome)).toEqual(["canceled", "canceled"]);
    expect(canceled.deliveries.map((delivery) => [delivery.kind, delivery.phase])).toEqual([
      ["checkpoint", "abandoned"],
    ]);
    expect(store.claimNextDelivery(BOOT_A)).toBeNull();
    expect(store.claimNextItem(BOOT_A)).toBeNull();
    expect(errorCodeOf(() => store.cancel({ ...key, operationId: "missing" }))).toBe(
      "OPERATION_NOT_FOUND",
    );
    store.close();
  });

  it("finishes a revoked operation without injecting anything", () => {
    const store = openStore();
    const key = operationInput();
    store.accept(key);
    claimAndStart(store, BOOT_A);

    const revoked = store.finishRevoked(key);
    expect(revoked.status).toBe("finished");
    expect(revoked.errorCode).toBe("AUTHORIZATION_REVOKED");
    expect(revoked.items.map((item) => item.outcome)).toEqual(["authorization_revoked"]);
    expect(revoked.deliveries).toEqual([]);
    expect(store.settleItem({ ...key, itemIndex: 0, outcome: "finished" }).settled).toBe(false);
    store.close();
  });

  it("prunes closed operations only after their deliveries are done", () => {
    const store = openStore();
    const key = operationInput();
    store.accept(key);
    claimAndStart(store, BOOT_A);
    store.settleItem({ ...key, itemIndex: 0, outcome: "finished" });
    clock += HOUR_MS;

    expect(store.pruneClosedOperations(clock)).toBe(0);
    const delivery = store.claimNextDelivery(BOOT_A)!;
    store.markDeliveryConsumed(delivery, BOOT_A);
    expect(store.pruneClosedOperations(clock)).toBe(1);
    expect(store.getOperation(key)).toBeNull();
    store.close();
  });
});

describe("OperationStore deliveries", () => {
  function finishedOperation(store: OperationStore) {
    const key = operationInput();
    store.accept(key);
    claimAndStart(store, BOOT_A);
    store.settleItem({ ...key, itemIndex: 0, outcome: "finished" });
    return key;
  }

  it("makes a started delivery uncertain after a restart and fences the old boot", () => {
    const store = openStore();
    finishedOperation(store);
    const delivery = store.claimNextDelivery(BOOT_A)!;
    expect(delivery.uncertain).toBe(false);
    expect(store.markDeliveryPrepared(delivery, BOOT_A)).toBe(true);
    expect(store.markDeliveryStarted(delivery, BOOT_A)).toBe(true);

    const restarted = openStore();
    expect(restarted.recoverBoot(BOOT_B)).toEqual({ requeued: 0, uncertain: 1 });
    expect(store.markDeliveryConsumed(delivery, BOOT_A)).toBe(false);

    const retry = restarted.claimNextDelivery(BOOT_B)!;
    expect(retry).toMatchObject({
      deliverySeq: delivery.deliverySeq,
      uncertain: true,
      attempts: 1,
    });
    expect(restarted.markDeliveryConsumed(retry, BOOT_B)).toBe(true);
    expect(restarted.claimNextDelivery(BOOT_B)).toBeNull();
    store.close();
    restarted.close();
  });

  it("returns claimed deliveries to the queue they were claimed from", () => {
    const store = openStore();
    finishedOperation(store);
    const firstClaim = store.claimNextDelivery(BOOT_A)!;
    store.markDeliveryPrepared(firstClaim, BOOT_A);
    store.close();

    const secondBoot = openStore();
    expect(secondBoot.recoverBoot(BOOT_B)).toEqual({ requeued: 1, uncertain: 0 });
    const secondClaim = secondBoot.claimNextDelivery(BOOT_B)!;
    expect(secondClaim.uncertain).toBe(false);
    secondBoot.markDeliveryPrepared(secondClaim, BOOT_B);
    secondBoot.markDeliveryStarted(secondClaim, BOOT_B);
    secondBoot.close();

    const thirdBoot = openStore();
    thirdBoot.recoverBoot(BOOT_C);
    const uncertainClaim = thirdBoot.claimNextDelivery(BOOT_C)!;
    expect(uncertainClaim).toMatchObject({ uncertain: true, attempts: 1 });
    thirdBoot.close();

    const fourthBoot = openStore();
    expect(fourthBoot.recoverBoot("boot-d")).toEqual({ requeued: 1, uncertain: 0 });
    expect(fourthBoot.claimNextDelivery("boot-d")).toMatchObject({ uncertain: true, attempts: 1 });
    fourthBoot.close();
  });

  it("retries a failed attempt later and keeps a started attempt uncertain", () => {
    const store = openStore();
    finishedOperation(store);
    const claim = store.claimNextDelivery(BOOT_A)!;
    store.markDeliveryPrepared(claim, BOOT_A);
    store.markDeliveryStarted(claim, BOOT_A);
    expect(
      store.retryDeliveryLater(claim, {
        bootId: BOOT_A,
        errorCode: "DELIVERY_FAILED",
        nextAttemptAt: clock + 5_000,
      }),
    ).toBe(true);

    expect(store.claimNextDelivery(BOOT_A)).toBeNull();
    clock += 5_000;
    expect(store.claimNextDelivery(BOOT_A)).toMatchObject({ uncertain: true, attempts: 1 });
    store.close();
  });
});
