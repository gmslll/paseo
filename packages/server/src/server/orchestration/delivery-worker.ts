import type { Logger } from "pino";

import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { OrchestrationAuditEvent, OrchestrationAuthority } from "./orchestration-authority.js";
import type {
  ClaimedDelivery,
  DeliveryKey,
  OperationRecord,
  OperationStore,
} from "./operation-store.js";

// Delivers queued checkpoints and completions to requester Agents (ADR-0042). A delivery moves
// claimed -> prepared -> started -> consumed. Only "started" can leave the requester unsure whether
// the prompt landed, so an uncertain delivery searches the requester timeline before injecting again.

export const DELIVERY_RETRY_DELAY_MS = 5_000;
/** An uncertain delivery gets one more injection before it is recorded as uncertain. */
export const MAX_DELIVERY_ATTEMPTS = 2;

export interface DeliveryInjection {
  readonly requesterAgentId: string;
  readonly messageId: string;
  /** Written into the prompt so replayed provider history still identifies the delivery. */
  readonly marker: string;
  readonly prompt: string;
}

export interface DeliveryTarget {
  prepare(injection: DeliveryInjection): Promise<"ready" | "requester_unavailable">;
  deliver(injection: DeliveryInjection): Promise<void>;
  hasDelivered(injection: DeliveryInjection): Promise<boolean>;
}

export interface DeliveryWorkerOptions {
  store: OperationStore;
  bootId: string;
  target: DeliveryTarget;
  authority: OrchestrationAuthority;
  logger: Logger;
  now?: () => number;
  retryDelayMs?: number;
}

export function deliveryMessageId(key: DeliveryKey): string {
  return `op:${key.operationId}:d:${key.deliverySeq}`;
}

export function buildDeliveryInjection(delivery: ClaimedDelivery): DeliveryInjection {
  const messageId = deliveryMessageId(delivery);
  const marker = `[paseo-delivery ${messageId}]`;
  return {
    requesterAgentId: delivery.requesterAgentId,
    messageId,
    marker,
    prompt: formatSystemNotificationPrompt(`${marker}\n${delivery.body}`),
  };
}

export class DeliveryWorker {
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private stopped = false;

  constructor(private readonly options: DeliveryWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? DELIVERY_RETRY_DELAY_MS;
  }

  /** Drains every due delivery. A kick during a drain runs one more pass before resolving. */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    this.draining = this.drainUntilQuiet()
      .catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Delegation delivery worker failed");
      })
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    await this.draining;
  }

  private async drainUntilQuiet(): Promise<void> {
    do {
      this.drainAgain = false;
      await this.drain();
    } while (this.drainAgain && !this.stopped);
  }

  private async drain(): Promise<void> {
    let claim = this.claimNext();
    while (claim) {
      await this.process(claim);
      claim = this.claimNext();
    }
  }

  private claimNext(): ClaimedDelivery | null {
    return this.stopped ? null : this.options.store.claimNextDelivery(this.options.bootId);
  }

  private async process(claim: ClaimedDelivery): Promise<void> {
    const { store, bootId } = this.options;
    const operation = store.getOperation(claim);
    if (!operation) return;
    if (!this.options.authority.isCurrent(operation.authority)) {
      store.abandonDelivery(claim, bootId, "AUTHORIZATION_REVOKED");
      const revoked = store.finishRevoked(operation);
      if (operation.status === "running") {
        this.record(revoked, "orchestration.operation.finished", {
          status: revoked.status,
          errorCode: "AUTHORIZATION_REVOKED",
        });
      }
      return;
    }
    const injection = buildDeliveryInjection(claim);
    try {
      if (claim.uncertain && !(await this.resolveUncertain(operation, claim, injection))) return;
      if ((await this.options.target.prepare(injection)) === "requester_unavailable") {
        store.abandonDelivery(claim, bootId, "REQUESTER_UNAVAILABLE");
        return;
      }
      if (!store.markDeliveryPrepared(claim, bootId) || !store.markDeliveryStarted(claim, bootId)) {
        return;
      }
      await this.options.target.deliver(injection);
      if (store.markDeliveryConsumed(claim, bootId)) {
        this.recordDelivery(operation, claim, "orchestration.delivery.consumed");
      }
    } catch (error) {
      this.options.logger.warn(
        {
          err: error,
          requesterAgentId: claim.requesterAgentId,
          operationId: claim.operationId,
          deliverySeq: claim.deliverySeq,
        },
        "Delegation delivery failed; retrying",
      );
      store.retryDeliveryLater(claim, {
        bootId,
        errorCode: "DELIVERY_FAILED",
        nextAttemptAt: this.now() + this.retryDelayMs,
      });
      this.scheduleRetry();
    }
  }

  /** Returns true when the delivery should be injected (again). */
  private async resolveUncertain(
    operation: OperationRecord,
    claim: ClaimedDelivery,
    injection: DeliveryInjection,
  ): Promise<boolean> {
    const { store, bootId } = this.options;
    if (await this.options.target.hasDelivered(injection)) {
      if (store.markDeliveryConsumed(claim, bootId)) {
        this.recordDelivery(operation, claim, "orchestration.delivery.consumed");
      }
      return false;
    }
    if (claim.attempts >= MAX_DELIVERY_ATTEMPTS) {
      if (store.abandonDelivery(claim, bootId, "DELIVERY_EXECUTION_UNCERTAIN")) {
        this.recordDelivery(operation, claim, "orchestration.delivery.uncertain");
      }
      return false;
    }
    return true;
  }

  private recordDelivery(
    operation: OperationRecord,
    claim: ClaimedDelivery,
    action: OrchestrationAuditEvent["action"],
  ): void {
    this.record(operation, action, { deliverySeq: String(claim.deliverySeq), kind: claim.kind });
  }

  private record(
    operation: OperationRecord,
    action: OrchestrationAuditEvent["action"],
    metadata: Record<string, string>,
  ): void {
    void this.options.authority
      .record?.({
        action,
        authority: operation.authority,
        requesterAgentId: operation.requesterAgentId,
        operationId: operation.operationId,
        metadata,
      })
      ?.catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Failed to audit a delegation delivery");
      });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.kick();
    }, this.retryDelayMs);
    timer.unref();
    this.retryTimers.add(timer);
  }
}
