import { randomUUID } from "node:crypto";
import { z } from "zod";

import { openDaemonDatabase, transaction, type SqliteDatabase } from "../sqlite/open-database.js";
import {
  FrozenOrchestrationAuthoritySchema,
  type FrozenOrchestrationAuthority,
} from "./orchestration-authority.js";
import { OrchestrationError } from "./orchestration-error.js";

// Durable delegation outbox (ADR-0042). Every state change is one BEGIN IMMEDIATE transaction, so a
// crash leaves each operation, item, and delivery in exactly one phase the next boot can recover.
// Rows written by an earlier boot are fenced by boot id: once a new boot recovers them, late writes
// from the old worker match nothing.

export const OPERATION_STORE_SCHEMA_VERSION = 1;
export const MAX_CHAIN_DEPTH = 32;

export const OperationKindSchema = z.enum([
  "agent_create",
  "agent_create_many",
  "agent_prompt",
  "agent_prompt_many",
]);
export const OperationStatusSchema = z.enum(["running", "finished", "canceled"]);
export const OperationItemStateSchema = z.enum(["pending", "materializing", "running", "settled"]);
export const OperationItemOutcomeSchema = z.enum([
  "finished",
  "errored",
  "closed",
  "timed_out",
  "canceled",
  "failed",
  "interrupted",
  "authorization_revoked",
]);
export const DeliveryKindSchema = z.enum(["checkpoint", "completion"]);
export const DeliveryPhaseSchema = z.enum([
  "ready",
  "claimed",
  "prepared",
  "started",
  "uncertain",
  "consumed",
  "abandoned",
]);

export type OperationKind = z.infer<typeof OperationKindSchema>;
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export type OperationItemState = z.infer<typeof OperationItemStateSchema>;
export type OperationItemOutcome = z.infer<typeof OperationItemOutcomeSchema>;
export type DeliveryKind = z.infer<typeof DeliveryKindSchema>;
export type DeliveryPhase = z.infer<typeof DeliveryPhaseSchema>;

export interface OperationKey {
  readonly requesterAgentId: string;
  readonly operationId: string;
}

export interface OperationItemKey extends OperationKey {
  readonly itemIndex: number;
}

export interface DeliveryKey extends OperationKey {
  readonly deliverySeq: number;
}

export interface OperationItemRecord extends OperationItemKey {
  readonly targetAgentId: string;
  readonly command: unknown;
  readonly state: OperationItemState;
  readonly outcome: OperationItemOutcome | null;
  readonly errorMessage: string | null;
  readonly lastMessage: string | null;
  readonly settledAt: number | null;
}

export interface DeliveryRecord extends DeliveryKey {
  readonly kind: DeliveryKind;
  readonly dedupeKey: string;
  readonly body: string;
  readonly phase: DeliveryPhase;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly consumedAt: number | null;
}

export interface OperationRecord extends OperationKey {
  readonly kind: OperationKind;
  readonly fingerprint: string;
  readonly authority: FrozenOrchestrationAuthority;
  readonly chainDepth: number;
  readonly status: OperationStatus;
  readonly errorCode: string | null;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly finishedAt: number | null;
  readonly items: readonly OperationItemRecord[];
  readonly deliveries: readonly DeliveryRecord[];
}

export interface AcceptOperationInput extends OperationKey {
  readonly kind: OperationKind;
  readonly fingerprint: string;
  readonly authority: FrozenOrchestrationAuthority;
  readonly deadlineAt: number;
  readonly items: ReadonlyArray<{ readonly targetAgentId: string; readonly command: unknown }>;
}

export interface AcceptOperationResult {
  readonly replayed: boolean;
  readonly operation: OperationRecord;
}

export interface ClaimedOperationItem extends OperationItemKey {
  readonly targetAgentId: string;
  readonly command: unknown;
  readonly claimToken: string;
}

export interface StaleOperationItem extends OperationItemKey {
  readonly state: "materializing" | "running";
  readonly targetAgentId: string;
  readonly command: unknown;
}

export interface SettleOperationItemInput extends OperationItemKey {
  readonly outcome: OperationItemOutcome;
  readonly errorMessage?: string | null;
  readonly lastMessage?: string | null;
}

export interface SettleOperationItemResult {
  readonly settled: boolean;
  readonly operationFinished: boolean;
}

export interface ClaimedDelivery extends DeliveryKey {
  readonly kind: DeliveryKind;
  readonly body: string;
  readonly attempts: number;
  /** The delivery may already have reached the requester during an earlier attempt. */
  readonly uncertain: boolean;
}

export interface ListOperationsFilter {
  readonly requesterAgentId?: string;
  readonly status?: OperationStatus;
  readonly limit: number;
}

export interface OperationStoreOptions {
  path: string;
  /** Formats the completion body when the last item of an operation settles. */
  formatCompletion: (operation: OperationRecord) => string;
  now?: () => number;
}

interface OperationRow {
  requester_agent_id: string;
  operation_id: string;
  kind: string;
  fingerprint: string;
  authority: string;
  chain_depth: number;
  status: string;
  error_code: string | null;
  created_at: number;
  deadline_at: number;
  finished_at: number | null;
}

interface ItemRow {
  requester_agent_id: string;
  operation_id: string;
  item_index: number;
  target_agent_id: string;
  command: string;
  state: string;
  outcome: string | null;
  error_message: string | null;
  last_message: string | null;
  settled_at: number | null;
}

interface DeliveryRow {
  requester_agent_id: string;
  operation_id: string;
  delivery_seq: number;
  kind: string;
  dedupe_key: string;
  body: string;
  phase: string;
  attempts: number;
  error_code: string | null;
  created_at: number;
  consumed_at: number | null;
}

interface CloseOperationInput {
  status: Exclude<OperationStatus, "running">;
  outcome: OperationItemOutcome;
  errorCode: string | null;
  message: string;
}

const OPERATION_KEY = "requester_agent_id = ? AND operation_id = ?";
const ITEM_KEY = `${OPERATION_KEY} AND item_index = ?`;
const DELIVERY_KEY = `${OPERATION_KEY} AND delivery_seq = ?`;
const COMPLETION_DEDUPE_KEY = "completion";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS operations (
  requester_agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  authority TEXT NOT NULL,
  chain_depth INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (requester_agent_id, operation_id)
);
CREATE INDEX IF NOT EXISTS operations_by_status ON operations (status, deadline_at);
CREATE TABLE IF NOT EXISTS operation_items (
  requester_agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  target_agent_id TEXT NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL,
  claim_token TEXT,
  claim_boot_id TEXT,
  outcome TEXT,
  error_message TEXT,
  last_message TEXT,
  settled_at INTEGER,
  PRIMARY KEY (requester_agent_id, operation_id, item_index),
  FOREIGN KEY (requester_agent_id, operation_id)
    REFERENCES operations (requester_agent_id, operation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS operation_items_by_state ON operation_items (state);
CREATE TABLE IF NOT EXISTS deliveries (
  requester_agent_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  delivery_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  body TEXT NOT NULL,
  phase TEXT NOT NULL,
  claimed_from TEXT,
  boot_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (requester_agent_id, operation_id, delivery_seq),
  UNIQUE (requester_agent_id, operation_id, dedupe_key),
  FOREIGN KEY (requester_agent_id, operation_id)
    REFERENCES operations (requester_agent_id, operation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS deliveries_by_phase ON deliveries (phase, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS turn_chain_depth (
  agent_id TEXT PRIMARY KEY,
  depth INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function migrateOperationStore(database: SqliteDatabase, fromVersion: number): void {
  if (fromVersion < 1) {
    database.exec(SCHEMA_V1);
  }
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}

function toItemRecord(row: ItemRow): OperationItemRecord {
  return {
    requesterAgentId: row.requester_agent_id,
    operationId: row.operation_id,
    itemIndex: row.item_index,
    targetAgentId: row.target_agent_id,
    command: JSON.parse(row.command) as unknown,
    state: OperationItemStateSchema.parse(row.state),
    outcome: row.outcome === null ? null : OperationItemOutcomeSchema.parse(row.outcome),
    errorMessage: row.error_message,
    lastMessage: row.last_message,
    settledAt: row.settled_at,
  };
}

function toDeliveryRecord(row: DeliveryRow): DeliveryRecord {
  return {
    requesterAgentId: row.requester_agent_id,
    operationId: row.operation_id,
    deliverySeq: row.delivery_seq,
    kind: DeliveryKindSchema.parse(row.kind),
    dedupeKey: row.dedupe_key,
    body: row.body,
    phase: DeliveryPhaseSchema.parse(row.phase),
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

export class OperationStore {
  private readonly formatCompletion: OperationStoreOptions["formatCompletion"];
  private readonly now: () => number;

  private constructor(
    private readonly database: SqliteDatabase,
    options: OperationStoreOptions,
  ) {
    this.formatCompletion = options.formatCompletion;
    this.now = options.now ?? Date.now;
  }

  static open(options: OperationStoreOptions): OperationStore {
    const database = openDaemonDatabase({
      path: options.path,
      schemaVersion: OPERATION_STORE_SCHEMA_VERSION,
      migrate: migrateOperationStore,
    });
    return new OperationStore(database, options);
  }

  close(): void {
    this.database.close();
  }

  accept(input: AcceptOperationInput): AcceptOperationResult {
    if (input.items.length === 0) {
      throw new OrchestrationError("INVALID_OPERATION", "An operation needs at least one item");
    }
    return transaction(this.database, () => {
      const existing = this.selectOperationRow(input);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new OrchestrationError(
            "OPERATION_ID_CONFLICT",
            `Operation ${input.operationId} was already accepted with a different command`,
          );
        }
        return { replayed: true, operation: this.readOperation(existing) };
      }
      const requesterDepth = this.readChainDepth(input.requesterAgentId);
      if (requesterDepth >= MAX_CHAIN_DEPTH) {
        throw new OrchestrationError(
          "CHAIN_DEPTH_EXCEEDED",
          `Delegation chain depth ${requesterDepth} reached the limit of ${MAX_CHAIN_DEPTH}`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO operations (requester_agent_id, operation_id, kind, fingerprint, authority,
             chain_depth, status, created_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          input.requesterAgentId,
          input.operationId,
          input.kind,
          input.fingerprint,
          JSON.stringify(FrozenOrchestrationAuthoritySchema.parse(input.authority)),
          requesterDepth + 1,
          this.now(),
          input.deadlineAt,
        );
      const insertItem = this.database.prepare(
        `INSERT INTO operation_items (requester_agent_id, operation_id, item_index, target_agent_id,
           command, state)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      );
      input.items.forEach((item, itemIndex) => {
        insertItem.run(
          input.requesterAgentId,
          input.operationId,
          itemIndex,
          item.targetAgentId,
          JSON.stringify(item.command),
        );
      });
      return { replayed: false, operation: this.requireOperation(input) };
    });
  }

  getOperation(key: OperationKey): OperationRecord | null {
    const row = this.selectOperationRow(key);
    return row ? this.readOperation(row) : null;
  }

  listOperations(filter: ListOperationsFilter): OperationRecord[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filter.requesterAgentId !== undefined) {
      clauses.push("requester_agent_id = ?");
      parameters.push(filter.requesterAgentId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT * FROM operations ${where}
         ORDER BY created_at DESC, requester_agent_id, operation_id LIMIT ?`,
      )
      .all(...parameters, filter.limit) as OperationRow[];
    return rows.map((row) => this.readOperation(row));
  }

  /**
   * Claims the oldest pending item and records the chain depth its turn will run at, before the
   * caller creates or prompts the target Agent.
   */
  claimNextItem(bootId: string): ClaimedOperationItem | null {
    return transaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT i.*, o.chain_depth AS operation_chain_depth
           FROM operation_items i
           JOIN operations o
             ON o.requester_agent_id = i.requester_agent_id AND o.operation_id = i.operation_id
           WHERE i.state = 'pending' AND o.status = 'running' AND o.deadline_at > ?
           ORDER BY o.created_at, i.requester_agent_id, i.operation_id, i.item_index
           LIMIT 1`,
        )
        .get(this.now()) as (ItemRow & { operation_chain_depth: number }) | undefined;
      if (!row) return null;
      const claimToken = randomUUID();
      this.database
        .prepare(
          `UPDATE operation_items SET state = 'materializing', claim_token = ?, claim_boot_id = ?
           WHERE ${ITEM_KEY} AND state = 'pending'`,
        )
        .run(claimToken, bootId, row.requester_agent_id, row.operation_id, row.item_index);
      this.writeChainDepth(row.target_agent_id, row.operation_chain_depth);
      return {
        requesterAgentId: row.requester_agent_id,
        operationId: row.operation_id,
        itemIndex: row.item_index,
        targetAgentId: row.target_agent_id,
        command: JSON.parse(row.command) as unknown,
        claimToken,
      };
    });
  }

  markItemRunning(input: OperationItemKey & { claimToken: string; bootId: string }): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE operation_items SET state = 'running', claim_boot_id = ?
           WHERE ${ITEM_KEY} AND state = 'materializing' AND claim_token = ?`,
        )
        .run(
          input.bootId,
          input.requesterAgentId,
          input.operationId,
          input.itemIndex,
          input.claimToken,
        ),
    );
  }

  /** Returns an item whose materialization never reached its target to the pending queue. */
  resetItemToPending(key: OperationItemKey): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE operation_items SET state = 'pending', claim_token = NULL, claim_boot_id = NULL
           WHERE ${ITEM_KEY} AND state = 'materializing'`,
        )
        .run(key.requesterAgentId, key.operationId, key.itemIndex),
    );
  }

  /** Items an earlier boot claimed or started and never settled. */
  listStaleItems(bootId: string): StaleOperationItem[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM operation_items
         WHERE state IN ('materializing', 'running') AND (claim_boot_id IS NULL OR claim_boot_id != ?)
         ORDER BY requester_agent_id, operation_id, item_index`,
      )
      .all(bootId) as ItemRow[];
    return rows.map((row) => {
      const item = toItemRecord(row);
      return {
        requesterAgentId: item.requesterAgentId,
        operationId: item.operationId,
        itemIndex: item.itemIndex,
        state: item.state === "running" ? "running" : "materializing",
        targetAgentId: item.targetAgentId,
        command: item.command,
      };
    });
  }

  /** Unsettled items of running operations whose deadline has passed. */
  listExpiredItems(): OperationItemRecord[] {
    const rows = this.database
      .prepare(
        `SELECT i.* FROM operation_items i
         JOIN operations o
           ON o.requester_agent_id = i.requester_agent_id AND o.operation_id = i.operation_id
         WHERE o.status = 'running' AND o.deadline_at <= ? AND i.state != 'settled'
         ORDER BY i.requester_agent_id, i.operation_id, i.item_index`,
      )
      .all(this.now()) as ItemRow[];
    return rows.map(toItemRecord);
  }

  /**
   * Settles one item. When it was the last unsettled item, the operation finishes and exactly one
   * completion delivery is queued in the same transaction.
   */
  settleItem(input: SettleOperationItemInput): SettleOperationItemResult {
    return transaction(this.database, () => {
      const settled = changed(
        this.database
          .prepare(
            `UPDATE operation_items
             SET state = 'settled', outcome = ?, error_message = ?, last_message = ?, settled_at = ?,
                 claim_token = NULL
             WHERE ${ITEM_KEY} AND state != 'settled'`,
          )
          .run(
            input.outcome,
            input.errorMessage ?? null,
            input.lastMessage ?? null,
            this.now(),
            input.requesterAgentId,
            input.operationId,
            input.itemIndex,
          ),
      );
      if (!settled) return { settled: false, operationFinished: false };
      return { settled: true, operationFinished: this.finishOperationIfSettled(input) };
    });
  }

  /** Queues a checkpoint once per dedupe key while the operation is running. */
  enqueueCheckpoint(input: OperationKey & { dedupeKey: string; body: string }): boolean {
    return transaction(this.database, () => {
      if (this.selectOperationRow(input)?.status !== "running") return false;
      return this.insertDelivery(input, {
        kind: "checkpoint",
        dedupeKey: input.dedupeKey,
        body: input.body,
      });
    });
  }

  /** Cancels a running operation. The requester asked for it, so no completion is delivered. */
  cancel(key: OperationKey): OperationRecord {
    return this.closeOperation(key, {
      status: "canceled",
      outcome: "canceled",
      errorCode: "CANCELED",
      message: "Canceled by the requester",
    });
  }

  /** Finishes an operation whose requester lost authority. Nothing more is injected. */
  finishRevoked(key: OperationKey): OperationRecord {
    return this.closeOperation(key, {
      status: "finished",
      outcome: "authorization_revoked",
      errorCode: "AUTHORIZATION_REVOKED",
      message: "The requester no longer has access to this delegation",
    });
  }

  claimNextDelivery(bootId: string): ClaimedDelivery | null {
    return transaction(this.database, () => {
      const row = this.database
        .prepare(
          `SELECT * FROM deliveries
           WHERE phase IN ('ready', 'uncertain') AND next_attempt_at <= ?
           ORDER BY created_at, requester_agent_id, operation_id, delivery_seq
           LIMIT 1`,
        )
        .get(this.now()) as DeliveryRow | undefined;
      if (!row) return null;
      this.database
        .prepare(
          `UPDATE deliveries SET phase = 'claimed', claimed_from = ?, boot_id = ?
           WHERE ${DELIVERY_KEY} AND phase = ?`,
        )
        .run(
          row.phase,
          bootId,
          row.requester_agent_id,
          row.operation_id,
          row.delivery_seq,
          row.phase,
        );
      return {
        requesterAgentId: row.requester_agent_id,
        operationId: row.operation_id,
        deliverySeq: row.delivery_seq,
        kind: DeliveryKindSchema.parse(row.kind),
        body: row.body,
        attempts: row.attempts,
        uncertain: row.phase === "uncertain",
      };
    });
  }

  markDeliveryPrepared(key: DeliveryKey, bootId: string): boolean {
    return this.transitionDelivery(key, bootId, "phase = 'claimed'", "phase = 'prepared'");
  }

  /** Records that the injection is about to run. From here a crash makes the delivery uncertain. */
  markDeliveryStarted(key: DeliveryKey, bootId: string): boolean {
    return this.transitionDelivery(
      key,
      bootId,
      "phase = 'prepared'",
      "phase = 'started', attempts = attempts + 1",
    );
  }

  markDeliveryConsumed(key: DeliveryKey, bootId: string): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE deliveries SET phase = 'consumed', consumed_at = ?, error_code = NULL
           WHERE ${DELIVERY_KEY} AND boot_id = ? AND phase IN ('claimed', 'prepared', 'started')`,
        )
        .run(this.now(), key.requesterAgentId, key.operationId, key.deliverySeq, bootId),
    );
  }

  abandonDelivery(key: DeliveryKey, bootId: string, errorCode: string): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE deliveries SET phase = 'abandoned', error_code = ?
           WHERE ${DELIVERY_KEY} AND boot_id = ? AND phase IN ('claimed', 'prepared', 'started')`,
        )
        .run(errorCode, key.requesterAgentId, key.operationId, key.deliverySeq, bootId),
    );
  }

  /**
   * Puts a claimed delivery back in the queue after a failed attempt. A delivery that started keeps
   * its uncertainty, so the next attempt looks for it in the requester timeline first.
   */
  retryDeliveryLater(
    key: DeliveryKey,
    input: { bootId: string; errorCode: string; nextAttemptAt: number },
  ): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE deliveries
           SET phase = CASE WHEN phase = 'started' THEN 'uncertain' ELSE COALESCE(claimed_from, 'ready') END,
               boot_id = NULL, error_code = ?, next_attempt_at = ?
           WHERE ${DELIVERY_KEY} AND boot_id = ? AND phase IN ('claimed', 'prepared', 'started')`,
        )
        .run(
          input.errorCode,
          input.nextAttemptAt,
          key.requesterAgentId,
          key.operationId,
          key.deliverySeq,
          input.bootId,
        ),
    );
  }

  /**
   * Recovers deliveries an earlier boot left in flight: claims return to their queue and started
   * injections become uncertain.
   */
  recoverBoot(bootId: string): { requeued: number; uncertain: number } {
    return transaction(this.database, () => {
      const requeued = this.database
        .prepare(
          `UPDATE deliveries SET phase = COALESCE(claimed_from, 'ready'), boot_id = NULL
           WHERE phase IN ('claimed', 'prepared') AND (boot_id IS NULL OR boot_id != ?)`,
        )
        .run(bootId);
      const uncertain = this.database
        .prepare(
          `UPDATE deliveries SET phase = 'uncertain', boot_id = NULL
           WHERE phase = 'started' AND (boot_id IS NULL OR boot_id != ?)`,
        )
        .run(bootId);
      return { requeued: Number(requeued.changes), uncertain: Number(uncertain.changes) };
    });
  }

  getChainDepth(agentId: string): number {
    return this.readChainDepth(agentId);
  }

  /** A prompt from a person starts a new chain. */
  resetChainDepth(agentId: string): void {
    this.database.prepare("DELETE FROM turn_chain_depth WHERE agent_id = ?").run(agentId);
  }

  /** Deletes closed operations older than `before` whose deliveries are all done. */
  pruneClosedOperations(before: number): number {
    const result = this.database
      .prepare(
        `DELETE FROM operations
         WHERE status != 'running' AND finished_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM deliveries d
             WHERE d.requester_agent_id = operations.requester_agent_id
               AND d.operation_id = operations.operation_id
               AND d.phase NOT IN ('consumed', 'abandoned')
           )`,
      )
      .run(before);
    return Number(result.changes);
  }

  private closeOperation(key: OperationKey, input: CloseOperationInput): OperationRecord {
    return transaction(this.database, () => {
      const row = this.selectOperationRow(key);
      if (!row) {
        throw new OrchestrationError(
          "OPERATION_NOT_FOUND",
          `Operation ${key.operationId} not found`,
        );
      }
      if (row.status !== "running") return this.readOperation(row);
      const now = this.now();
      this.database
        .prepare(
          `UPDATE operation_items
           SET state = 'settled', outcome = ?, error_message = ?, settled_at = ?, claim_token = NULL
           WHERE ${OPERATION_KEY} AND state != 'settled'`,
        )
        .run(input.outcome, input.message, now, key.requesterAgentId, key.operationId);
      this.database
        .prepare(
          `UPDATE operations SET status = ?, error_code = ?, finished_at = ?
           WHERE ${OPERATION_KEY}`,
        )
        .run(input.status, input.errorCode, now, key.requesterAgentId, key.operationId);
      this.database
        .prepare(
          `UPDATE deliveries SET phase = 'abandoned', error_code = ?
           WHERE ${OPERATION_KEY} AND phase IN ('ready', 'uncertain')`,
        )
        .run(input.errorCode, key.requesterAgentId, key.operationId);
      return this.requireOperation(key);
    });
  }

  private finishOperationIfSettled(key: OperationKey): boolean {
    const remaining = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM operation_items WHERE ${OPERATION_KEY} AND state != 'settled'`,
      )
      .get(key.requesterAgentId, key.operationId) as { count: number };
    if (remaining.count > 0) return false;
    const finished = changed(
      this.database
        .prepare(
          `UPDATE operations SET status = 'finished', finished_at = ?
           WHERE ${OPERATION_KEY} AND status = 'running'`,
        )
        .run(this.now(), key.requesterAgentId, key.operationId),
    );
    if (!finished) return false;
    this.insertDelivery(key, {
      kind: "completion",
      dedupeKey: COMPLETION_DEDUPE_KEY,
      body: this.formatCompletion(this.requireOperation(key)),
    });
    return true;
  }

  private insertDelivery(
    key: OperationKey,
    input: { kind: DeliveryKind; dedupeKey: string; body: string },
  ): boolean {
    const next = this.database
      .prepare(
        `SELECT COALESCE(MAX(delivery_seq), 0) + 1 AS seq FROM deliveries WHERE ${OPERATION_KEY}`,
      )
      .get(key.requesterAgentId, key.operationId) as { seq: number };
    const now = this.now();
    return changed(
      this.database
        .prepare(
          `INSERT OR IGNORE INTO deliveries (requester_agent_id, operation_id, delivery_seq, kind,
             dedupe_key, body, phase, created_at, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        )
        .run(
          key.requesterAgentId,
          key.operationId,
          next.seq,
          input.kind,
          input.dedupeKey,
          input.body,
          now,
          now,
        ),
    );
  }

  private transitionDelivery(
    key: DeliveryKey,
    bootId: string,
    fromClause: string,
    setClause: string,
  ): boolean {
    return changed(
      this.database
        .prepare(
          `UPDATE deliveries SET ${setClause} WHERE ${DELIVERY_KEY} AND boot_id = ? AND ${fromClause}`,
        )
        .run(key.requesterAgentId, key.operationId, key.deliverySeq, bootId),
    );
  }

  private readChainDepth(agentId: string): number {
    const row = this.database
      .prepare("SELECT depth FROM turn_chain_depth WHERE agent_id = ?")
      .get(agentId) as { depth: number } | undefined;
    return row?.depth ?? 0;
  }

  private writeChainDepth(agentId: string, depth: number): void {
    this.database
      .prepare(
        `INSERT INTO turn_chain_depth (agent_id, depth, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET depth = excluded.depth, updated_at = excluded.updated_at`,
      )
      .run(agentId, depth, this.now());
  }

  private selectOperationRow(key: OperationKey): OperationRow | undefined {
    return this.database
      .prepare(`SELECT * FROM operations WHERE ${OPERATION_KEY}`)
      .get(key.requesterAgentId, key.operationId) as OperationRow | undefined;
  }

  private requireOperation(key: OperationKey): OperationRecord {
    const row = this.selectOperationRow(key);
    if (!row) {
      throw new OrchestrationError("OPERATION_NOT_FOUND", `Operation ${key.operationId} not found`);
    }
    return this.readOperation(row);
  }

  private readOperation(row: OperationRow): OperationRecord {
    const items = this.database
      .prepare(`SELECT * FROM operation_items WHERE ${OPERATION_KEY} ORDER BY item_index`)
      .all(row.requester_agent_id, row.operation_id) as ItemRow[];
    const deliveries = this.database
      .prepare(`SELECT * FROM deliveries WHERE ${OPERATION_KEY} ORDER BY delivery_seq`)
      .all(row.requester_agent_id, row.operation_id) as DeliveryRow[];
    return {
      requesterAgentId: row.requester_agent_id,
      operationId: row.operation_id,
      kind: OperationKindSchema.parse(row.kind),
      fingerprint: row.fingerprint,
      authority: FrozenOrchestrationAuthoritySchema.parse(JSON.parse(row.authority)),
      chainDepth: row.chain_depth,
      status: OperationStatusSchema.parse(row.status),
      errorCode: row.error_code,
      createdAt: row.created_at,
      deadlineAt: row.deadline_at,
      finishedAt: row.finished_at,
      items: items.map(toItemRecord),
      deliveries: deliveries.map(toDeliveryRecord),
    };
  }
}
