import { cpus, freemem, totalmem } from "node:os";

import type {
  ManagedAuditInput,
  ManagedNodeHeartbeat,
  ManagedPlacementRegistration,
} from "@getpaseo/protocol/enterprise-management";
import type { AuditEvent } from "@getpaseo/protocol/messages";

import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { ManagedNodeControlPlaneClient } from "./management-client.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_POLICY_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_AUDIT_UPLOAD_INTERVAL_MS = 5_000;
const MAX_AUDIT_BATCH = 1_000;

interface ManagedNodeLifecycleTimer {
  unref?(): void;
}

interface ManagedNodeLifecycleScheduler {
  setInterval(callback: () => void, intervalMs: number): ManagedNodeLifecycleTimer;
  clearInterval(timer: ManagedNodeLifecycleTimer): void;
}

const defaultScheduler: ManagedNodeLifecycleScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

export interface ManagedNodeLifecycleOptions {
  readonly client: ManagedNodeControlPlaneClient;
  readonly audit: Pick<ProductionAuditCapability, "flush" | "snapshotEvents">;
  readonly refreshPolicy: () => Promise<void>;
  readonly heartbeat: () => ManagedNodeHeartbeat | Promise<ManagedNodeHeartbeat>;
  readonly heartbeatIntervalMs?: number;
  readonly policyRefreshIntervalMs?: number;
  readonly auditUploadIntervalMs?: number;
  readonly scheduler?: ManagedNodeLifecycleScheduler;
  readonly onError?: (
    operation: "heartbeat" | "policy" | "audit" | "placements",
    error: unknown,
  ) => void;
}

export type ManagedPlacementSnapshotSource = () =>
  | readonly ManagedPlacementRegistration[]
  | Promise<readonly ManagedPlacementRegistration[]>;

/** Owns the remote-control lifecycle for one enrolled daemon identity. */
export class ManagedNodeLifecycle {
  private readonly scheduler: ManagedNodeLifecycleScheduler;
  private readonly intervals: Readonly<Record<"heartbeat" | "policy" | "audit", number>>;
  private readonly timers: ManagedNodeLifecycleTimer[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private readyPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private placementSource: ManagedPlacementSnapshotSource | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: ManagedNodeLifecycleOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.intervals = Object.freeze({
      heartbeat: parseInterval(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS),
      policy: parseInterval(options.policyRefreshIntervalMs, DEFAULT_POLICY_REFRESH_INTERVAL_MS),
      audit: parseInterval(options.auditUploadIntervalMs, DEFAULT_AUDIT_UPLOAD_INTERVAL_MS),
    });
  }

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("managed node lifecycle is closed"));
    this.readyPromise ??= this.start();
    return this.readyPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const timer of this.timers.splice(0)) this.scheduler.clearInterval(timer);
    this.closePromise = this.operationTail.then(async () => {
      const heartbeat = await this.options.heartbeat();
      try {
        await this.options.client.shutdown({
          bootId: heartbeat.bootId,
          paseoServerId: heartbeat.paseoServerId,
        });
      } catch (error) {
        this.options.onError?.("heartbeat", error);
      }
      return undefined;
    });
    return this.closePromise;
  }

  async installPlacementSource(source: ManagedPlacementSnapshotSource): Promise<void> {
    if (typeof source !== "function") throw new Error("managed placement source is invalid");
    await this.ready();
    if (this.closed) throw new Error("managed node lifecycle is closed");
    if (this.placementSource) throw new Error("managed placement source is already installed");
    this.placementSource = source;
    const synchronization = this.operationTail.then(async () => {
      if (this.closed) throw new Error("managed node lifecycle is closed");
      await this.synchronizePlacements();
      return undefined;
    });
    this.operationTail = synchronization.then(
      () => undefined,
      () => undefined,
    );
    try {
      await synchronization;
    } catch (error) {
      this.placementSource = null;
      throw error;
    }
    if (this.closed) throw new Error("managed node lifecycle is closed");
    this.arm("placements", () => this.synchronizePlacements());
  }

  private async start(): Promise<void> {
    await this.options.refreshPolicy();
    await this.sendHeartbeat();
    await this.uploadAudit();
    if (this.closed) throw new Error("managed node lifecycle closed during startup");
    this.started = true;
    this.arm("policy", () => this.options.refreshPolicy());
    this.arm("heartbeat", () => this.sendHeartbeat());
    this.arm("audit", () => this.uploadAudit());
  }

  private arm(
    operation: "heartbeat" | "policy" | "audit" | "placements",
    operationTask: () => Promise<void>,
  ): void {
    const timer = this.scheduler.setInterval(
      () => {
        if (this.closed || !this.started) return;
        const task = this.operationTail.then(() =>
          this.runScheduledOperation(operation, operationTask),
        );
        this.operationTail = task.then(
          () => undefined,
          () => undefined,
        );
      },
      operation === "placements" ? this.intervals.heartbeat : this.intervals[operation],
    );
    timer.unref?.();
    this.timers.push(timer);
  }

  private async runScheduledOperation(
    operation: "heartbeat" | "policy" | "audit" | "placements",
    operationTask: () => Promise<void>,
  ): Promise<void> {
    if (this.closed) return;
    try {
      await operationTask();
    } catch (error) {
      this.options.onError?.(operation, error);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    await this.options.client.heartbeat(await this.options.heartbeat());
  }

  private async uploadAudit(): Promise<void> {
    await this.options.audit.flush();
    const state = await this.options.client.auditState();
    const events = [...(await this.options.audit.snapshotEvents())].sort(
      (left, right) => left.nodeEventSeq - right.nodeEventSeq,
    );
    let cursor = state.lastSequence;
    let index = events.findIndex((event) => event.nodeEventSeq > cursor);
    if (index < 0) return;
    while (index < events.length) {
      const batch: ManagedAuditInput[] = [];
      while (index < events.length && batch.length < MAX_AUDIT_BATCH) {
        const event = events[index++]!;
        if (event.nodeEventSeq !== cursor + batch.length + 1) {
          throw new Error("local audit sequence gap");
        }
        batch.push(toManagedAuditInput(event));
      }
      const result = await this.options.client.uploadAudit(batch);
      if (result.gaps.length > 0 || result.lastSequence !== cursor + batch.length) {
        throw new Error("management audit sequence gap");
      }
      cursor = result.lastSequence;
    }
  }

  private async synchronizePlacements(): Promise<void> {
    const source = this.placementSource;
    if (!source) return;
    await this.options.client.synchronizePlacements(await source());
  }
}

export function defaultManagedNodeCapacity(
  input: {
    readonly activeAgents?: number;
    readonly activeBrowserProfiles?: number;
  } = {},
) {
  return Object.freeze({
    cpuLogical: Math.max(1, cpus().length),
    memoryTotalBytes: totalmem(),
    memoryAvailableBytes: freemem(),
    activeAgents: input.activeAgents ?? 0,
    activeBrowserProfiles: input.activeBrowserProfiles ?? 0,
  });
}

function toManagedAuditInput(event: AuditEvent): ManagedAuditInput {
  return {
    eventId: event.eventId,
    nodeId: event.nodeId,
    nodeEventSeq: event.nodeEventSeq,
    occurredAt: event.occurredAt,
    action: event.action,
    outcome: event.outcome,
    actorPrincipalId: event.actorPrincipalId,
    resourceKind: event.resource.kind,
    resourceId: event.resource.id,
    metadata: Object.freeze({
      ...event.metadata,
      ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
    }),
  };
}

function parseInterval(value: number | undefined, fallback: number): number {
  const interval = value ?? fallback;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 300_000) {
    throw new Error("invalid managed node lifecycle interval");
  }
  return interval;
}
