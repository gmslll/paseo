import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCompletionReason,
  AgentCompletionWatch,
} from "../agent/agent-completion-watch.js";
import { formatFinishNotificationBody, isSystemInjectedEnvelope } from "../agent/agent-prompt.js";
import type { AgentPermissionRequest } from "../agent/agent-sdk-types.js";
import { DeliveryWorker, type DeliveryTarget } from "./delivery-worker.js";
import type {
  AcceptOperationResult,
  ClaimedOperationItem,
  ListOperationsFilter,
  OperationItemKey,
  OperationItemOutcome,
  OperationKey,
  OperationKind,
  OperationRecord,
  OperationStore,
} from "./operation-store.js";
import type {
  OrchestrationAuditEvent,
  OrchestrationAuthority,
  OrchestrationTarget,
} from "./orchestration-authority.js";
import { OrchestrationError } from "./orchestration-error.js";

// Accepts Agent-to-Agent delegations into the outbox, dispatches their items one at a time, watches
// the delegated Agents, and hands completions to the delivery worker (ADR-0042).

export const OPERATION_DEADLINE_DEFAULT_SECONDS = 24 * 60 * 60;
export const OPERATION_DEADLINE_MIN_SECONDS = 60;
export const OPERATION_DEADLINE_MAX_SECONDS = 7 * 24 * 60 * 60;

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DEADLINE_SWEEP_INTERVAL_MS = 15_000;
const CLOSED_OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DelegationItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    title: z.string(),
    workspaceId: z.string(),
    spec: z.unknown(),
  }),
  z.object({
    kind: z.literal("prompt"),
    title: z.string(),
    agentId: z.string(),
    prompt: z.string(),
    sessionMode: z.string().optional(),
  }),
]);

export type DelegationItem = z.infer<typeof DelegationItemSchema>;

export interface DelegationUserMessage {
  agentId: string;
  clientMessageId?: string;
  text: string;
}

export interface OrchestrationAgentPort extends DeliveryTarget {
  agentExists(agentId: string): Promise<boolean>;
  /** Creates the Agent under the pre-assigned ID and starts its first turn. */
  createAgent(input: {
    agentId: string;
    requesterAgentId: string;
    spec: unknown;
    messageId: string;
  }): Promise<void>;
  promptAgent(input: {
    agentId: string;
    prompt: string;
    sessionMode?: string;
    messageId: string;
  }): Promise<void>;
  watchCompletion(input: {
    agentId: string;
    onPermissionRequested: (request: AgentPermissionRequest) => void;
    onCompletion: (reason: AgentCompletionReason) => void;
  }): AgentCompletionWatch;
  lastAssistantMessage(agentId: string): Promise<string | null>;
  subscribeUserMessages(listener: (message: DelegationUserMessage) => void): () => void;
}

/** Operation reads and cancel exposed to connected clients. */
export type OrchestrationOperationControl = Pick<
  OperationService,
  "listOperations" | "getOperation" | "cancel"
>;

export interface OperationServiceOptions {
  store: OperationStore;
  bootId: string;
  agents: OrchestrationAgentPort;
  authority: OrchestrationAuthority;
  logger: Logger;
  now?: () => number;
  deliveryRetryDelayMs?: number;
}

export interface AcceptDelegationInput {
  requesterAgentId: string;
  operationId?: string;
  deadlineSeconds?: number;
  items: readonly DelegationItem[];
}

type ItemTarget = OperationItemKey & { readonly targetAgentId: string };

const OUTCOME_BY_REASON: Record<AgentCompletionReason, OperationItemOutcome> = {
  finished: "finished",
  errored: "errored",
  "was closed": "closed",
};

const OUTCOME_STATUS: Record<OperationItemOutcome, string> = {
  finished: "finished",
  errored: "errored",
  closed: "was closed",
  timed_out: "did not finish before the operation deadline",
  canceled: "was canceled",
  failed: "failed to start",
  interrupted: "was interrupted by a daemon restart",
  authorization_revoked: "lost authorization",
};

export function itemMessageId(key: OperationItemKey): string {
  return `op:${key.operationId}:i:${key.itemIndex}`;
}

export function formatOperationCompletion(operation: OperationRecord): string {
  const sections = operation.items.map((item) => {
    const parsed = DelegationItemSchema.safeParse(item.command);
    const outcome = item.outcome ?? "failed";
    const status =
      outcome === "failed" && item.errorMessage
        ? `${OUTCOME_STATUS.failed}: ${item.errorMessage}`
        : OUTCOME_STATUS[outcome];
    return formatFinishNotificationBody({
      childAgentId: item.targetAgentId,
      title: parsed.success ? parsed.data.title : item.targetAgentId,
      status,
      lastAssistantMessage: item.lastMessage,
    });
  });
  if (sections.length === 1) return sections[0] ?? "";
  return [
    `Operation ${operation.operationId} finished for ${sections.length} Agents.`,
    ...sections,
  ].join("\n\n");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A prompt target's title is looked up at accept time, so renaming it must not break a retry. */
function fingerprintedItem(item: DelegationItem): unknown {
  return item.kind === "prompt" ? Object.assign({}, item, { title: undefined }) : item;
}

function operationKind(items: readonly DelegationItem[]): OperationKind {
  const kinds = new Set(items.map((item) => item.kind));
  if (kinds.size !== 1) {
    throw new OrchestrationError(
      "INVALID_OPERATION",
      "An operation needs one or more items of the same kind",
    );
  }
  const many = items.length > 1;
  if (kinds.has("create")) return many ? "agent_create_many" : "agent_create";
  return many ? "agent_prompt_many" : "agent_prompt";
}

function resolveDeadlineSeconds(value: number | undefined): number {
  const seconds = value ?? OPERATION_DEADLINE_DEFAULT_SECONDS;
  if (
    !Number.isInteger(seconds) ||
    seconds < OPERATION_DEADLINE_MIN_SECONDS ||
    seconds > OPERATION_DEADLINE_MAX_SECONDS
  ) {
    throw new OrchestrationError(
      "INVALID_OPERATION",
      `deadlineSeconds must be an integer from ${OPERATION_DEADLINE_MIN_SECONDS} to ${OPERATION_DEADLINE_MAX_SECONDS}`,
    );
  }
  return seconds;
}

function toTarget(item: DelegationItem): OrchestrationTarget {
  return item.kind === "create"
    ? { kind: "create", workspaceId: item.workspaceId }
    : { kind: "prompt", agentId: item.agentId };
}

function itemWatchKey(item: OperationItemKey): string {
  return JSON.stringify([item.requesterAgentId, item.operationId, item.itemIndex]);
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OperationService {
  private readonly worker: DeliveryWorker;
  private readonly now: () => number;
  private readonly watches = new Map<string, AgentCompletionWatch>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly dispatchWaiters = new Set<() => void>();
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private unsubscribeUserMessages: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: OperationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.worker = new DeliveryWorker({
      store: options.store,
      bootId: options.bootId,
      target: options.agents,
      authority: options.authority,
      logger: options.logger,
      now: this.now,
      retryDelayMs: options.deliveryRetryDelayMs,
    });
  }

  /** Recovers what an earlier boot left in flight, then starts dispatching and delivering. */
  async start(): Promise<void> {
    const { store, bootId, agents } = this.options;
    store.recoverBoot(bootId);
    store.pruneClosedOperations(this.now() - CLOSED_OPERATION_RETENTION_MS);
    this.unsubscribeUserMessages = agents.subscribeUserMessages((message) =>
      this.resetChainForPerson(message),
    );
    await this.recoverStaleItems();
    await this.expireDeadlines();
    this.sweepTimer = setInterval(() => {
      this.track(this.expireDeadlines());
    }, DEADLINE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    void this.pump();
    void this.worker.kick();
  }

  /**
   * Stops watching delegated Agents before shutdown closes them, so a restart reports those items
   * as interrupted instead of closed. The synchronous part runs on the first call.
   */
  stop(): Promise<void> {
    this.stopping ??= this.stopInternal();
    return this.stopping;
  }

  async accept(input: AcceptDelegationInput): Promise<AcceptOperationResult> {
    if (this.stopping) throw new Error("Delegation service is stopping");
    const operationId = input.operationId ?? randomUUID();
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new OrchestrationError(
        "INVALID_OPERATION",
        "operationId must be 1-128 letters, digits, dots, dashes, or underscores",
      );
    }
    const kind = operationKind(input.items);
    const deadlineSeconds = resolveDeadlineSeconds(input.deadlineSeconds);
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ kind, deadlineSeconds, items: input.items.map(fingerprintedItem) }))
      .digest("hex");
    const key = { requesterAgentId: input.requesterAgentId, operationId };
    const existing = this.options.store.getOperation(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new OrchestrationError(
          "OPERATION_ID_CONFLICT",
          `Operation ${operationId} was already accepted with a different command`,
        );
      }
      return { replayed: true, operation: existing };
    }
    const authority = await this.options.authority.authorizeAccept({
      requesterAgentId: input.requesterAgentId,
      targets: input.items.map(toTarget),
    });
    const result = this.options.store.accept({
      ...key,
      kind,
      fingerprint,
      authority,
      deadlineAt: this.now() + deadlineSeconds * 1000,
      items: input.items.map((item) => ({
        targetAgentId: item.kind === "prompt" ? item.agentId : randomUUID(),
        command: item,
      })),
    });
    if (!result.replayed) {
      this.recordAudit(result.operation, "orchestration.operation.accepted", {
        kind,
        items: String(input.items.length),
      });
      void this.pump();
    }
    return result;
  }

  /** Resolves once no item of the operation is waiting to be created or prompted. */
  async waitForDispatch(key: OperationKey): Promise<OperationRecord> {
    for (;;) {
      let release: (() => void) | null = null;
      const dispatched = new Promise<void>((resolve) => {
        release = resolve;
        this.dispatchWaiters.add(resolve);
      });
      const operation = this.requireOperation(key);
      const waiting = operation.items.some(
        (item) => item.state === "pending" || item.state === "materializing",
      );
      if (!waiting || this.stopping) {
        if (release) this.dispatchWaiters.delete(release);
        return operation;
      }
      await dispatched;
    }
  }

  /** Checks a delegation that runs outside the outbox, such as a blocking prompt. */
  async authorize(input: {
    requesterAgentId: string;
    targets: readonly OrchestrationTarget[];
  }): Promise<void> {
    await this.options.authority.authorizeAccept(input);
  }

  getOperation(key: OperationKey): OperationRecord | null {
    return this.options.store.getOperation(key);
  }

  listOperations(filter: ListOperationsFilter): OperationRecord[] {
    return this.options.store.listOperations(filter);
  }

  cancel(key: OperationKey): OperationRecord {
    const operation = this.requireOperation(key);
    for (const item of operation.items) {
      this.stopWatch(item);
    }
    const canceled = this.options.store.cancel(key);
    if (operation.status === "running") {
      this.recordAudit(canceled, "orchestration.operation.finished", { status: canceled.status });
    }
    return canceled;
  }

  /** Settles unsettled items of operations whose deadline has passed. */
  async expireDeadlines(): Promise<void> {
    for (const item of this.options.store.listExpiredItems()) {
      this.stopWatch(item);
      await this.settle(item, { outcome: "timed_out" });
    }
  }

  /** Resolves once dispatch, bookkeeping, and due deliveries have nothing left to do. */
  async whenIdle(): Promise<void> {
    do {
      await this.pumping;
      await Promise.allSettled(this.inflight);
      await this.worker.kick();
    } while (this.pumping || this.inflight.size > 0);
  }

  private async stopInternal(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.unsubscribeUserMessages?.();
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    this.notifyDispatchWaiters();
    await this.pumping;
    await Promise.allSettled(this.inflight);
    await this.worker.stop();
  }

  private pump(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = this.pumpUntilQuiet()
      .catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Delegation dispatcher failed");
      })
      .finally(() => {
        this.pumping = null;
        this.notifyDispatchWaiters();
      });
    return this.pumping;
  }

  private async pumpUntilQuiet(): Promise<void> {
    do {
      this.pumpAgain = false;
      let claim = this.claimNextItem();
      while (claim) {
        await this.materialize(claim);
        this.notifyDispatchWaiters();
        claim = this.claimNextItem();
      }
    } while (this.pumpAgain && !this.stopping);
  }

  private claimNextItem(): ClaimedOperationItem | null {
    return this.stopping ? null : this.options.store.claimNextItem(this.options.bootId);
  }

  private async materialize(claim: ClaimedOperationItem): Promise<void> {
    const { store, bootId, agents, authority } = this.options;
    const operation = store.getOperation(claim);
    if (operation?.status !== "running") return;
    if (!authority.isCurrent(operation.authority)) {
      const revoked = store.finishRevoked(claim);
      this.recordAudit(revoked, "orchestration.operation.finished", {
        status: revoked.status,
        errorCode: "AUTHORIZATION_REVOKED",
      });
      return;
    }
    const item = DelegationItemSchema.parse(claim.command);
    const messageId = itemMessageId(claim);
    try {
      if (item.kind === "create") {
        if (await agents.agentExists(claim.targetAgentId)) {
          throw new Error(`Agent ${claim.targetAgentId} already exists`);
        }
        await agents.createAgent({
          agentId: claim.targetAgentId,
          requesterAgentId: claim.requesterAgentId,
          spec: item.spec,
          messageId,
        });
      } else {
        await agents.promptAgent({
          agentId: claim.targetAgentId,
          prompt: item.prompt,
          sessionMode: item.sessionMode,
          messageId,
        });
      }
    } catch (error) {
      await this.settle(claim, { outcome: "failed", errorMessage: errorMessageOf(error) });
      return;
    }
    if (store.markItemRunning({ ...claim, bootId })) {
      this.watchItem(claim, item.title);
    }
  }

  private watchItem(item: ItemTarget, title: string): void {
    const watchKey = itemWatchKey(item);
    let completed = false;
    const watch = this.options.agents.watchCompletion({
      agentId: item.targetAgentId,
      onPermissionRequested: (request) => {
        this.track(this.checkpoint(item, title, request));
      },
      onCompletion: (reason) => {
        completed = true;
        this.watches.delete(watchKey);
        this.track(this.settle(item, { outcome: OUTCOME_BY_REASON[reason] }));
      },
    });
    if (!watch.attached) {
      this.track(this.settle(item, { outcome: "closed" }));
    } else if (!completed) {
      this.watches.set(watchKey, watch);
    }
  }

  private async settle(
    item: ItemTarget,
    input: { outcome: OperationItemOutcome; errorMessage?: string },
  ): Promise<void> {
    const lastMessage =
      input.outcome === "failed"
        ? null
        : await this.options.agents.lastAssistantMessage(item.targetAgentId);
    const result = this.options.store.settleItem({
      requesterAgentId: item.requesterAgentId,
      operationId: item.operationId,
      itemIndex: item.itemIndex,
      outcome: input.outcome,
      errorMessage: input.errorMessage ?? null,
      lastMessage,
    });
    if (!result.operationFinished) return;
    const finished = this.options.store.getOperation(item);
    if (finished) {
      this.recordAudit(finished, "orchestration.operation.finished", { status: finished.status });
    }
    void this.worker.kick();
  }

  private async checkpoint(
    item: ItemTarget,
    title: string,
    request: AgentPermissionRequest,
  ): Promise<void> {
    const lastAssistantMessage = await this.options.agents.lastAssistantMessage(item.targetAgentId);
    const queued = this.options.store.enqueueCheckpoint({
      requesterAgentId: item.requesterAgentId,
      operationId: item.operationId,
      dedupeKey: `permission:${item.itemIndex}:${request.id}`,
      body: formatFinishNotificationBody({
        childAgentId: item.targetAgentId,
        title,
        status: "needs permission",
        lastAssistantMessage,
        permissionRequest: request,
      }),
    });
    if (queued) void this.worker.kick();
  }

  /**
   * An Agent a creation never reached is created again under the same ID. Anything that already
   * started ran in a provider process the restart killed, so it is reported as interrupted.
   */
  private async recoverStaleItems(): Promise<void> {
    const { store, bootId, agents } = this.options;
    for (const item of store.listStaleItems(bootId)) {
      const command = DelegationItemSchema.safeParse(item.command);
      const neverCreated =
        item.state === "materializing" &&
        command.success &&
        command.data.kind === "create" &&
        !(await agents.agentExists(item.targetAgentId));
      if (neverCreated) {
        store.resetItemToPending(item);
      } else {
        await this.settle(item, { outcome: "interrupted" });
      }
    }
  }

  /** A prompt from a person starts a new delegation chain for that Agent. */
  private resetChainForPerson(message: DelegationUserMessage): void {
    if (message.clientMessageId?.startsWith("op:") || isSystemInjectedEnvelope(message.text)) {
      return;
    }
    try {
      this.options.store.resetChainDepth(message.agentId);
    } catch (error) {
      this.options.logger.error(
        { err: error, agentId: message.agentId },
        "Failed to reset delegation chain depth",
      );
    }
  }

  private recordAudit(
    operation: OperationRecord,
    action: OrchestrationAuditEvent["action"],
    metadata: Record<string, string>,
  ): void {
    const record = this.options.authority.record?.({
      action,
      authority: operation.authority,
      requesterAgentId: operation.requesterAgentId,
      operationId: operation.operationId,
      metadata,
    });
    if (record) this.track(record);
  }

  private track(promise: Promise<void>): void {
    const tracked: Promise<void> = promise
      .catch((error: unknown) => {
        this.options.logger.error({ err: error }, "Delegation bookkeeping failed");
      })
      .finally(() => {
        this.inflight.delete(tracked);
      });
    this.inflight.add(tracked);
  }

  private stopWatch(item: OperationItemKey): void {
    const watchKey = itemWatchKey(item);
    this.watches.get(watchKey)?.stop();
    this.watches.delete(watchKey);
  }

  private notifyDispatchWaiters(): void {
    const waiters = [...this.dispatchWaiters];
    this.dispatchWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private requireOperation(key: OperationKey): OperationRecord {
    const operation = this.options.store.getOperation(key);
    if (!operation) {
      throw new OrchestrationError("OPERATION_NOT_FOUND", `Operation ${key.operationId} not found`);
    }
    return operation;
  }
}
