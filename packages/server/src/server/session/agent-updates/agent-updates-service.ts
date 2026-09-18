import type pino from "pino";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { resolveEffectiveThinkingOptionId, toAgentPayload } from "../../agent/agent-projections.js";

type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
type AgentUpdatesFilter = NonNullable<
  Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"]
>;

interface AgentUpdatesSubscriptionState {
  subscriptionId: string;
  syncEnabled?: boolean;
  filter?: AgentUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<
    string,
    { payload: AgentUpdatePayload; workspaceId: string | undefined }
  >;
  excludedWorkspaceIds: Set<string>;
}

export interface AgentUpdatePublicationScope {
  readonly agentId: string;
  readonly workspaceId: string;
}

/**
 * Owns the single per-client `agent_update` subscription: when a client subscribes
 * via `fetch_agents_request`, every later agent lifecycle change (live forward,
 * stored-record archive/detach, delete) is filtered against the subscription's
 * filter and either emitted or — while the initial snapshot is still being built —
 * buffered and replayed on flush. Keeping the mutable subscription state, the
 * bootstrap buffer, the provider-visibility gate, and the filter predicate behind
 * one interface stops the rest of session.ts from poking the subscription shape or
 * hand-rolling `agent_update` payloads, and the (previously untested) filter/buffer/
 * flush branches become exercisable through injected fakes.
 *
 * The snapshot listing path applies the SAME filter via the pure
 * `matchesAgentUpdatesFilter` so a subscription's initial page and its live updates
 * stay consistent.
 */
export interface AgentUpdatesService {
  beginSubscription(input: {
    subscriptionId: string;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
  }): void;
  flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): Promise<void>;
  clearSubscription(subscriptionId: string): void;
  /** Invalidate one transferred workspace without disturbing other subscribed workspaces. */
  invalidateWorkspace(workspaceId: string): void;
  hasSubscription(): boolean;
  includesLiveAgent(agent: ManagedAgent): Promise<boolean>;
  forwardLiveAgent(agent: ManagedAgent): Promise<void>;
  emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload>;
  removeAgent(agentId: string): Promise<void>;
  /** Seal event ingress synchronously, then drain every accepted publication. */
  sealAndDrain(): Promise<void>;
  dispose(): void;
}

export interface AgentUpdatesServiceDeps {
  authorizeAgentId?: (agentId: string) => Promise<AgentUpdatePublicationScope | null>;
  emit(
    message: SessionOutboundMessage,
    scope?: AgentUpdatePublicationScope,
  ): void | Promise<unknown>;
  enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload>;
  buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload;
  isProviderVisibleToClient(provider: string): boolean;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void>;
  sequenceAgentUpdate<T extends AgentUpdatePayload>(
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
    includeSequence: boolean,
  ): T;
  logger: pino.Logger;
}

function agentThinkingOptionMatchesFilter(
  agent: AgentSnapshotPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.thinkingOptionId === undefined) {
    return true;
  }
  const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
    configuredThinkingOptionId: filter.thinkingOptionId ?? null,
  });
  const resolvedThinkingOptionId =
    agent.effectiveThinkingOptionId ??
    resolveEffectiveThinkingOptionId({
      runtimeInfo: agent.runtimeInfo,
      configuredThinkingOptionId: agent.thinkingOptionId ?? null,
    });
  return resolvedThinkingOptionId === expectedThinkingOptionId;
}

function matchesAgentStructuralFilter(
  agent: AgentSnapshotPayload,
  project: ProjectPlacementPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.statuses && filter.statuses.length > 0) {
    const statuses = new Set(filter.statuses);
    if (!statuses.has(agent.status)) {
      return false;
    }
  }

  if (typeof filter.requiresAttention === "boolean") {
    const requiresAttention = agent.requiresAttention ?? false;
    if (requiresAttention !== filter.requiresAttention) {
      return false;
    }
  }

  if (filter.projectKeys && filter.projectKeys.length > 0) {
    const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
    if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
      return false;
    }
  }
  return true;
}

/**
 * Pure predicate shared by the live subscription stream and the snapshot listing
 * pager: does an agent (with its resolved project placement) satisfy a
 * `fetch_agents` filter?
 */
export function matchesAgentUpdatesFilter(input: {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  filter?: AgentUpdatesFilter;
}): boolean {
  const { agent, project, filter } = input;

  if (filter?.labels) {
    const matchesLabels = Object.entries(filter.labels).every(
      ([key, value]) => agent.labels[key] === value,
    );
    if (!matchesLabels) {
      return false;
    }
  }

  const includeArchived = filter?.includeArchived ?? false;
  if (!includeArchived && agent.archivedAt) {
    return false;
  }

  if (filter && !agentThinkingOptionMatchesFilter(agent, filter)) {
    return false;
  }

  if (filter && !matchesAgentStructuralFilter(agent, project, filter)) {
    return false;
  }

  return true;
}

function agentUpdateTargetId(update: AgentUpdatePayload): string {
  return update.kind === "remove" ? update.agentId : update.agent.id;
}

export function createAgentUpdatesService(deps: AgentUpdatesServiceDeps): AgentUpdatesService {
  let subscription: AgentUpdatesSubscriptionState | null = null;
  let sealed = false;
  const liveAgentUpdateTails = new Map<string, Promise<void>>();
  const activeFlushes = new Set<Promise<void>>();
  const sequence = <T extends AgentUpdatePayload>(
    sub: AgentUpdatesSubscriptionState,
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
  ) => deps.sequenceAgentUpdate(payload, agent, project, agentId, sub.syncEnabled === true);

  function bufferOrEmit(
    sub: AgentUpdatesSubscriptionState,
    payload: AgentUpdatePayload,
    scope?: AgentUpdatePublicationScope,
  ): void | Promise<unknown> {
    if (sealed || subscription !== sub) return;
    const workspaceId =
      scope?.workspaceId ?? (payload.kind === "upsert" ? payload.agent.workspaceId : undefined);
    if (workspaceId && sub.excludedWorkspaceIds.has(workspaceId)) return;
    if (payload.kind === "upsert" && !deps.isProviderVisibleToClient(payload.agent.provider)) {
      return;
    }
    if (sub.isBootstrapping) {
      sub.pendingUpdatesByAgentId.set(agentUpdateTargetId(payload), { payload, workspaceId });
      return;
    }

    return deps.emit(
      {
        type: "agent_update",
        payload,
      },
      scope,
    );
  }

  async function currentScope(
    agentId: string,
  ): Promise<AgentUpdatePublicationScope | null | undefined> {
    if (sealed) return null;
    if (!deps.authorizeAgentId) return undefined;
    const scope = await deps.authorizeAgentId(agentId);
    if (
      sealed ||
      !scope ||
      scope.agentId !== agentId ||
      typeof scope.workspaceId !== "string" ||
      scope.workspaceId.length === 0
    ) {
      return null;
    }
    return scope;
  }

  function logPublicationFailure(error: unknown, agentId?: string): void {
    deps.logger.error(
      { err: error, ...(agentId ? { agentId } : {}) },
      "Failed to emit agent update",
    );
  }

  function beginSubscription(input: {
    subscriptionId: string;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
  }): void {
    if (sealed) return;
    subscription = {
      subscriptionId: input.subscriptionId,
      syncEnabled: input.syncEnabled,
      filter: input.filter,
      isBootstrapping: true,
      pendingUpdatesByAgentId: new Map(),
      excludedWorkspaceIds: new Set(),
    };
  }

  function flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): Promise<void> {
    const activeSubscription = subscription;
    if (
      sealed ||
      !activeSubscription ||
      activeSubscription.subscriptionId !== subscriptionId ||
      !activeSubscription.isBootstrapping
    ) {
      return Promise.resolve();
    }

    activeSubscription.isBootstrapping = false;
    const pending = Array.from(activeSubscription.pendingUpdatesByAgentId.values());
    activeSubscription.pendingUpdatesByAgentId.clear();

    if (!deps.authorizeAgentId) {
      for (const { payload, workspaceId } of pending) {
        if (workspaceId && activeSubscription.excludedWorkspaceIds.has(workspaceId)) continue;
        if (shouldSkipBufferedUpsert(payload, options)) continue;
        if (sealed || subscription !== activeSubscription) break;
        bufferOrEmit(activeSubscription, payload);
      }
      return Promise.resolve();
    }

    const flush = (async () => {
      for (const { payload, workspaceId } of pending) {
        if (workspaceId && activeSubscription.excludedWorkspaceIds.has(workspaceId)) continue;
        if (shouldSkipBufferedUpsert(payload, options)) continue;
        const agentId = agentUpdateTargetId(payload);
        try {
          const scope = await currentScope(agentId);
          if (
            scope === null ||
            sealed ||
            subscription !== activeSubscription ||
            (scope && activeSubscription.excludedWorkspaceIds.has(scope.workspaceId))
          )
            continue;
          await bufferOrEmit(activeSubscription, payload, scope);
        } catch (error) {
          logPublicationFailure(error, agentId);
        }
      }
    })();
    activeFlushes.add(flush);
    void flush.then(
      () => activeFlushes.delete(flush),
      () => activeFlushes.delete(flush),
    );
    return flush;
  }

  function shouldSkipBufferedUpsert(
    payload: AgentUpdatePayload,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): boolean {
    if (payload.kind !== "upsert") return false;
    const snapshotUpdatedAt = options?.snapshotUpdatedAtByAgentId?.get(payload.agent.id);
    if (typeof snapshotUpdatedAt !== "number") return false;
    const updateUpdatedAt = Date.parse(payload.agent.updatedAt);
    return !Number.isNaN(updateUpdatedAt) && updateUpdatedAt < snapshotUpdatedAt;
  }

  function clearSubscription(subscriptionId: string): void {
    if (subscription && subscription.subscriptionId === subscriptionId) {
      subscription = null;
    }
  }

  function invalidateWorkspace(workspaceId: string): void {
    const activeSubscription = subscription;
    if (sealed || !activeSubscription || activeSubscription.excludedWorkspaceIds.has(workspaceId)) {
      return;
    }
    activeSubscription.excludedWorkspaceIds.add(workspaceId);
    for (const [agentId, pending] of activeSubscription.pendingUpdatesByAgentId) {
      if (pending.workspaceId === workspaceId) {
        activeSubscription.pendingUpdatesByAgentId.delete(agentId);
      }
    }
  }

  function hasSubscription(): boolean {
    return subscription !== null;
  }

  // oxlint-disable-next-line complexity -- every async projection boundary rechecks the transferred-workspace fence.
  async function includesLiveAgent(agent: ManagedAgent): Promise<boolean> {
    const activeSubscription = subscription;
    if (sealed || !activeSubscription) return false;

    let scope = await currentScope(agent.id);
    if (scope === null) return false;
    if (scope && activeSubscription.excludedWorkspaceIds.has(scope.workspaceId)) return false;
    const payload = await deps.enrichAgentPayload(toAgentPayload(agent));
    scope = await currentScope(agent.id);
    if (
      scope === null ||
      subscription !== activeSubscription ||
      (scope && activeSubscription.excludedWorkspaceIds.has(scope.workspaceId)) ||
      !deps.isProviderVisibleToClient(payload.provider) ||
      (scope && payload.workspaceId !== scope.workspaceId)
    ) {
      return false;
    }
    const workspaceId = scope?.workspaceId ?? payload.workspaceId;
    const project = workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(workspaceId)
      : null;
    scope = await currentScope(agent.id);
    return (
      scope !== null &&
      (!scope || payload.workspaceId === scope.workspaceId) &&
      (!scope || !activeSubscription.excludedWorkspaceIds.has(scope.workspaceId)) &&
      subscription === activeSubscription &&
      project !== null &&
      matchesAgentUpdatesFilter({
        agent: payload,
        project,
        filter: activeSubscription.filter,
      })
    );
  }

  async function emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload> {
    const payload = deps.buildStoredAgentPayload(record);
    await enqueueAgentUpdate(payload.id, async () => {
      const sub = subscription;
      if (sealed || !sub) return;
      let scope = await currentScope(payload.id);
      if (
        scope === null ||
        (scope &&
          (payload.workspaceId !== scope.workspaceId ||
            sub.excludedWorkspaceIds.has(scope.workspaceId)))
      )
        return;
      const workspaceId = scope?.workspaceId ?? payload.workspaceId;
      const project = workspaceId
        ? await deps.buildProjectPlacementForWorkspaceId(workspaceId)
        : null;
      scope = await currentScope(payload.id);
      if (
        scope === null ||
        sealed ||
        subscription !== sub ||
        (scope && sub.excludedWorkspaceIds.has(scope.workspaceId)) ||
        (scope && payload.workspaceId !== scope.workspaceId)
      ) {
        return;
      }
      if (!project) {
        await bufferOrEmit(
          sub,
          sequence(sub, { kind: "remove", agentId: payload.id }, null, null, payload.id),
          scope,
        );
        return;
      }

      const matches = matchesAgentUpdatesFilter({
        agent: payload,
        project,
        filter: sub.filter,
      });
      await bufferOrEmit(
        sub,
        sequence(
          sub,
          matches
            ? {
                kind: "upsert",
                agent: payload,
                project,
              }
            : {
                kind: "remove",
                agentId: payload.id,
              },
          payload,
          project,
          payload.id,
        ),
        scope,
      );
    });
    return payload;
  }

  async function emitLiveAgentUpdate(payload: AgentSnapshotPayload): Promise<void> {
    const sub = subscription;
    let scope = await currentScope(payload.id);
    if (scope === null) return;
    if (scope && sub?.excludedWorkspaceIds.has(scope.workspaceId)) return;
    payload = await deps.enrichAgentPayload(payload);
    scope = await currentScope(payload.id);
    if (
      scope === null ||
      (scope &&
        (payload.workspaceId !== scope.workspaceId ||
          sub?.excludedWorkspaceIds.has(scope.workspaceId)))
    )
      return;
    if (sub) await emitSubscribedLiveAgentUpdate(sub, payload, scope);

    // A lifecycle change updates exactly the canonical owning workspace, never
    // every workspace sharing its cwd.
    scope = await currentScope(payload.id);
    const workspaceId = scope?.workspaceId ?? payload.workspaceId;
    if (scope !== null && !sealed && workspaceId && !sub?.excludedWorkspaceIds.has(workspaceId)) {
      await deps.emitWorkspaceUpdateForWorkspaceId(workspaceId);
    }
  }

  async function emitSubscribedLiveAgentUpdate(
    sub: AgentUpdatesSubscriptionState,
    payload: AgentSnapshotPayload,
    initialScope: AgentUpdatePublicationScope | undefined,
  ): Promise<void> {
    const workspaceId = initialScope?.workspaceId ?? payload.workspaceId;
    const project = workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(workspaceId)
      : null;
    const scope = await currentScope(payload.id);
    if (
      scope === null ||
      sealed ||
      subscription !== sub ||
      (scope && sub.excludedWorkspaceIds.has(scope.workspaceId)) ||
      (scope && payload.workspaceId !== scope.workspaceId)
    ) {
      return;
    }
    if (!project) {
      await bufferOrEmit(
        sub,
        sequence(sub, { kind: "remove", agentId: payload.id }, null, null, payload.id),
        scope,
      );
      return;
    }
    const matches = matchesAgentUpdatesFilter({ agent: payload, project, filter: sub.filter });
    const update: AgentUpdatePayload = matches
      ? { kind: "upsert", agent: payload, project }
      : { kind: "remove", agentId: payload.id };
    await bufferOrEmit(sub, sequence(sub, update, payload, project, payload.id), scope);
  }

  function enqueueAgentUpdate(
    agentId: string,
    emitUpdate: () => void | Promise<void>,
  ): Promise<void> {
    if (sealed) return Promise.resolve();
    const previous = liveAgentUpdateTails.get(agentId) ?? Promise.resolve();
    const attempted = previous.then(async () => {
      if (sealed) return;
      return emitUpdate();
    });
    const next = attempted.catch((error) => {
      logPublicationFailure(error, agentId);
    });
    liveAgentUpdateTails.set(agentId, next);
    void next.then(
      () => {
        if (liveAgentUpdateTails.get(agentId) === next) liveAgentUpdateTails.delete(agentId);
        return undefined;
      },
      () => {
        if (liveAgentUpdateTails.get(agentId) === next) liveAgentUpdateTails.delete(agentId);
        return undefined;
      },
    );
    return next;
  }

  function forwardLiveAgent(agent: ManagedAgent): Promise<void> {
    if (!subscription) {
      return enqueueAgentUpdate(agent.id, async () => {
        const scope = await currentScope(agent.id);
        const workspaceId = scope?.workspaceId ?? agent.workspaceId;
        if (scope !== null && !sealed && workspaceId) {
          await deps.emitWorkspaceUpdateForWorkspaceId(workspaceId);
        }
      });
    }
    const payload = toAgentPayload(agent);
    return enqueueAgentUpdate(payload.id, () => emitLiveAgentUpdate(payload));
  }

  function removeAgent(agentId: string): Promise<void> {
    return enqueueAgentUpdate(agentId, async () => {
      const sub = subscription;
      if (!sub) return;
      const scope = await currentScope(agentId);
      if (scope === null || sealed || subscription !== sub) return;
      await bufferOrEmit(
        sub,
        sequence(sub, { kind: "remove", agentId }, null, null, agentId),
        scope,
      );
    });
  }

  async function sealAndDrain(): Promise<void> {
    sealed = true;
    subscription = null;
    while (liveAgentUpdateTails.size > 0 || activeFlushes.size > 0) {
      await Promise.allSettled([...liveAgentUpdateTails.values(), ...activeFlushes]);
    }
  }

  function dispose(): void {
    sealed = true;
    subscription = null;
  }

  return {
    beginSubscription,
    flushBootstrapped,
    clearSubscription,
    invalidateWorkspace,
    hasSubscription,
    includesLiveAgent,
    forwardLiveAgent,
    emitStoredRecord,
    removeAgent,
    sealAndDrain,
    dispose,
  };
}
