import type { EnterpriseWorkspaceOwnershipTransferTombstone } from "@getpaseo/protocol/messages";
import {
  AuthoritySessionBindingRecordSchema,
  type AuthoritySessionBindingRecord,
} from "../enterprise/access/authority-receipt-verifier.js";
import {
  consumeWorkspaceOwnershipTransferTombstoneContext,
  type WorkspaceOwnershipTransferTombstoneContext,
} from "../enterprise/access/enterprise-resource-handlers.js";
import type { EnterpriseAgentSessionContextRegistry } from "./enterprise-agent-session-context-registry.js";

declare const sessionHandleBrand: unique symbol;
declare const targetDeliveryBrand: unique symbol;

export interface WorkspaceOwnershipTransferSessionHandle {
  readonly [sessionHandleBrand]: never;
}

export interface WorkspaceOwnershipTransferTargetDelivery {
  readonly [targetDeliveryBrand]: never;
}

export interface WorkspaceOwnershipTransferTargetResult {
  readonly sealed: boolean;
  readonly delivered: boolean;
}

export interface WorkspaceOwnershipTransferFanoutResult {
  readonly claimed: boolean;
  readonly issuerSealed: boolean;
  readonly targetedSessions: number;
  readonly deliveredSessions: number;
}

interface FanoutOwner {
  readonly entries: Set<SessionEntry>;
  readonly emittedEventReceiptPairs: WorkspaceOwnershipTransferReplayLedger;
}

interface SessionEntry {
  readonly owner: FanoutOwner;
  readonly binding: AuthoritySessionBindingRecord;
  readonly deliver: (
    delivery: WorkspaceOwnershipTransferTargetDelivery,
  ) => WorkspaceOwnershipTransferTargetResult;
  readonly handle: WorkspaceOwnershipTransferSessionHandle;
  active: boolean;
}

interface TargetDeliveryState {
  readonly entry: SessionEntry;
  readonly message: EnterpriseWorkspaceOwnershipTransferTombstone;
}

const owners = new WeakMap<object, FanoutOwner>();
const sessionEntries = new WeakMap<object, SessionEntry>();
const targetDeliveries = new WeakMap<object, TargetDeliveryState>();
export const WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT = 4096;

export class WorkspaceOwnershipTransferReplayLedger {
  readonly #pairs = new Set<string>();

  get size(): number {
    return this.#pairs.size;
  }

  remember(pair: string): boolean {
    if (this.#pairs.has(pair)) return false;
    this.#pairs.add(pair);
    if (this.#pairs.size > WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT) {
      const oldestPair = this.#pairs.values().next().value;
      if (oldestPair !== undefined) this.#pairs.delete(oldestPair);
    }
    return true;
  }
}

const EMPTY_FANOUT_RESULT = Object.freeze({
  claimed: false,
  issuerSealed: false,
  targetedSessions: 0,
  deliveredSessions: 0,
});

function cloneBinding(input: AuthoritySessionBindingRecord): AuthoritySessionBindingRecord {
  const binding = AuthoritySessionBindingRecordSchema.parse(structuredClone(input));
  return Object.freeze(binding);
}

function sameBinding(
  left: AuthoritySessionBindingRecord,
  right: AuthoritySessionBindingRecord,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionBindingKey === right.sessionBindingKey &&
    left.sessionBindingGeneration === right.sessionBindingGeneration &&
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    left.nodeId === right.nodeId &&
    left.clientId === right.clientId
  );
}

function ownerFor(runtimeKey: EnterpriseAgentSessionContextRegistry): FanoutOwner {
  const existing = owners.get(runtimeKey);
  if (existing) return existing;
  const owner: FanoutOwner = {
    entries: new Set(),
    emittedEventReceiptPairs: new WorkspaceOwnershipTransferReplayLedger(),
  };
  owners.set(runtimeKey, owner);
  return owner;
}

export function registerWorkspaceOwnershipTransferSession(input: {
  readonly runtimeKey: EnterpriseAgentSessionContextRegistry;
  readonly binding: AuthoritySessionBindingRecord;
  readonly deliver: (
    delivery: WorkspaceOwnershipTransferTargetDelivery,
  ) => WorkspaceOwnershipTransferTargetResult;
}): WorkspaceOwnershipTransferSessionHandle {
  const owner = ownerFor(input.runtimeKey);
  const handle = Object.freeze(
    Object.create(null) as object,
  ) as WorkspaceOwnershipTransferSessionHandle;
  const entry: SessionEntry = {
    owner,
    binding: cloneBinding(input.binding),
    deliver: input.deliver,
    handle,
    active: true,
  };
  owner.entries.add(entry);
  sessionEntries.set(handle as object, entry);
  return handle;
}

export function unregisterWorkspaceOwnershipTransferSession(
  handle: WorkspaceOwnershipTransferSessionHandle | null,
): void {
  if (!handle) return;
  const entry = sessionEntries.get(handle as object);
  if (!entry) return;
  sessionEntries.delete(handle as object);
  entry.active = false;
  entry.owner.entries.delete(entry);
}

function claimContext(
  dispatcher: unknown,
  contextualResponse: unknown,
): WorkspaceOwnershipTransferTombstoneContext | null {
  return consumeWorkspaceOwnershipTransferTombstoneContext(dispatcher, contextualResponse);
}

function targetMatches(
  entry: SessionEntry,
  context: WorkspaceOwnershipTransferTombstoneContext,
): boolean {
  const { payload } = context.message;
  return (
    entry.active &&
    entry.owner.entries.has(entry) &&
    entry.binding.organizationId === payload.resource.organizationId &&
    entry.binding.nodeId === payload.resource.nodeId &&
    entry.binding.principalId === payload.oldPrincipalId
  );
}

function createTargetDelivery(
  entry: SessionEntry,
  message: EnterpriseWorkspaceOwnershipTransferTombstone,
): WorkspaceOwnershipTransferTargetDelivery {
  const delivery = Object.freeze(
    Object.create(null) as object,
  ) as WorkspaceOwnershipTransferTargetDelivery;
  targetDeliveries.set(delivery as object, { entry, message });
  return delivery;
}

/**
 * The W2 authority is consumed once here. Target delivery uses W3-only, single-use
 * tokens and never reuses the nominal context as resource authorization.
 */
export function claimAndFanoutWorkspaceOwnershipTransferTombstone(input: {
  readonly issuerHandle: WorkspaceOwnershipTransferSessionHandle | null;
  readonly dispatcher: unknown;
  readonly contextualResponse: unknown;
}): WorkspaceOwnershipTransferFanoutResult {
  const context = claimContext(input.dispatcher, input.contextualResponse);
  if (!context) return EMPTY_FANOUT_RESULT;

  const issuer = input.issuerHandle ? sessionEntries.get(input.issuerHandle as object) : undefined;
  if (
    !issuer ||
    !issuer.active ||
    !issuer.owner.entries.has(issuer) ||
    !sameBinding(issuer.binding, context.issuerBinding)
  ) {
    return Object.freeze({ ...EMPTY_FANOUT_RESULT, claimed: true });
  }

  const { payload } = context.message;
  const eventReceiptPair = JSON.stringify([payload.eventId, payload.transferReceiptId]);
  if (!issuer.owner.emittedEventReceiptPairs.remember(eventReceiptPair)) {
    return Object.freeze({ ...EMPTY_FANOUT_RESULT, claimed: true });
  }

  let issuerSealed = false;
  let targetedSessions = 0;
  let deliveredSessions = 0;
  // Snapshot the entry set so a target cleanup cannot skip a later target.
  for (const target of Array.from(issuer.owner.entries)) {
    if (!targetMatches(target, context)) continue;
    targetedSessions += 1;
    const delivery = createTargetDelivery(target, context.message);
    let result: WorkspaceOwnershipTransferTargetResult;
    try {
      result = target.deliver(delivery);
    } catch {
      targetDeliveries.delete(delivery as object);
      continue;
    }
    targetDeliveries.delete(delivery as object);
    if (target === issuer && result.sealed) issuerSealed = true;
    if (result.delivered) deliveredSessions += 1;
  }
  return Object.freeze({ claimed: true, issuerSealed, targetedSessions, deliveredSessions });
}

/** Burns one helper-issued target token and returns its message only for the exact binding. */
export function consumeWorkspaceOwnershipTransferTargetDelivery(
  delivery: WorkspaceOwnershipTransferTargetDelivery,
  currentBinding: AuthoritySessionBindingRecord,
): EnterpriseWorkspaceOwnershipTransferTombstone | null {
  const state = targetDeliveries.get(delivery as object);
  if (!state) return null;
  targetDeliveries.delete(delivery as object);
  let binding: AuthoritySessionBindingRecord;
  try {
    binding = cloneBinding(currentBinding);
  } catch {
    return null;
  }
  return state.entry.active &&
    state.entry.owner.entries.has(state.entry) &&
    sameBinding(state.entry.binding, binding)
    ? state.message
    : null;
}
