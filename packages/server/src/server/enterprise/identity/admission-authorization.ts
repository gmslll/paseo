import {
  ConnectionContextSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  type ConnectionContext,
  type NodeContext,
  type PrincipalContext,
  createEnterpriseSessionBindingKey,
} from "@getpaseo/protocol/messages";

declare const issuerBrand: unique symbol;
declare const evidenceBrand: unique symbol;
declare const handleBrand: unique symbol;
export interface EnterpriseAdmissionAuthorizationIssuer {
  readonly [issuerBrand]: true;
}
export interface EnterpriseAdmissionAuthenticationEvidence {
  readonly [evidenceBrand]: true;
}
export interface EnterpriseAdmissionAuthorizationHandle {
  readonly [handleBrand]: true;
}
export interface ResolvedEnterpriseAdmissionAuthorization {
  readonly principal: Readonly<PrincipalContext>;
  readonly node: Readonly<NodeContext>;
  readonly clientId: string;
  readonly sessionBindingGeneration: string;
  readonly sessionBindingKey: string;
}

interface Snapshot {
  principal: PrincipalContext;
  node: NodeContext;
  connection: ConnectionContext;
}
interface RecordState {
  snapshot: Snapshot;
  credentialId: string;
  principalKey: string;
  admissionEpoch: number;
  credentialEpoch: number;
  principalEpoch: number;
  grantVersion: string;
  nodeKey: string;
  principalType: PrincipalContext["principalType"];
}
type HandleState = ResolvedEnterpriseAdmissionAuthorization &
  RecordState & { issuer: EnterpriseAdmissionAuthorizationIssuer; active: boolean };
interface IssuerState {
  mintSecret: object;
  auditCurrent: () => boolean;
  active: boolean;
  admissionEpoch: number;
  generation: number;
  credentialEpoch: Map<string, number>;
  principalEpoch: Map<string, number>;
  evidence: WeakMap<object, RecordState>;
  handles: WeakMap<object, HandleState>;
  slots: Map<string, HandleState>;
}
const states = new WeakMap<object, IssuerState>();

function snapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("cyclic input");
  seen.add(value);
  const source = value as object;
  const keys = Reflect.ownKeys(source);
  const stringKeys = keys.filter((key): key is string => typeof key === "string");
  if (stringKeys.length !== keys.length) throw new Error("symbol input");
  const output: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : Object.create(null);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(source, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value))
      throw new Error("invalid array");
    output.length = length.value;
  }
  for (const key of stringKeys) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("non-data input");
    if (Array.isArray(value) && !/^\d+$/.test(key)) throw new Error("non-dense array");
    (output as Record<string, unknown>)[key] = snapshot(descriptor.value, seen);
  }
  seen.delete(value);
  return Object.freeze(output);
}
export function snapshotEnterpriseConnectionContext(value: unknown): ConnectionContext | null {
  try {
    return snapshot(ConnectionContextSchema.parse(snapshot(value))) as ConnectionContext;
  } catch {
    return null;
  }
}
function getState(issuer: unknown): IssuerState | undefined {
  try {
    return states.get(issuer as object);
  } catch {
    return undefined;
  }
}
function safeAuditCurrent(state: IssuerState | undefined): boolean {
  if (!state?.active) return false;
  try {
    return state.auditCurrent();
  } catch {
    return false;
  }
}
function getEpoch(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}
function isCurrent(state: IssuerState, handle: HandleState): boolean {
  return (
    state.active &&
    handle.active &&
    handle.admissionEpoch === state.admissionEpoch &&
    handle.credentialEpoch === getEpoch(state.credentialEpoch, handle.credentialId) &&
    handle.principalEpoch === getEpoch(state.principalEpoch, handle.principalKey) &&
    state.slots.get(handle.sessionBindingKey) === handle
  );
}

export function createEnterpriseAdmissionAuthorizationIssuer(
  mintSecret: object,
  auditCurrent: () => boolean = () => true,
): EnterpriseAdmissionAuthorizationIssuer {
  const issuer = Object.freeze(Object.create(null)) as EnterpriseAdmissionAuthorizationIssuer;
  states.set(issuer as object, {
    mintSecret,
    auditCurrent,
    active: true,
    admissionEpoch: 0,
    generation: 0,
    credentialEpoch: new Map(),
    principalEpoch: new Map(),
    evidence: new WeakMap(),
    handles: new WeakMap(),
    slots: new Map(),
  });
  return issuer;
}
export function issueEnterpriseAdmissionEvidence(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  mintSecret: object,
  principal: PrincipalContext,
  node: NodeContext,
  connection: ConnectionContext,
): EnterpriseAdmissionAuthenticationEvidence | null {
  const state = getState(issuer);
  if (!state || !safeAuditCurrent(state) || state.mintSecret !== mintSecret) return null;
  try {
    const raw = snapshot({ principal, node, connection }) as Snapshot;
    const canonical: Snapshot = {
      principal: snapshot(PrincipalContextSchema.parse(raw.principal)) as PrincipalContext,
      node: snapshot(NodeContextSchema.parse(raw.node)) as NodeContext,
      connection: snapshot(ConnectionContextSchema.parse(raw.connection)) as ConnectionContext,
    };
    const evidence = Object.freeze(
      Object.create(null),
    ) as EnterpriseAdmissionAuthenticationEvidence;
    const credentialId = canonical.principal.credentialId;
    const principalKey = `${canonical.principal.organizationId}:${canonical.principal.principalId}`;
    const nodeKey = `${canonical.node.nodeId}:${canonical.node.paseoServerId}:${canonical.node.mode}`;
    state.evidence.set(evidence as object, {
      snapshot: canonical,
      credentialId,
      principalKey,
      admissionEpoch: state.admissionEpoch,
      credentialEpoch: getEpoch(state.credentialEpoch, credentialId),
      principalEpoch: getEpoch(state.principalEpoch, principalKey),
      grantVersion: canonical.principal.grantVersion,
      nodeKey,
      principalType: canonical.principal.principalType,
    });
    return evidence;
  } catch {
    return null;
  }
}
export function bindEnterpriseAdmissionSession(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  evidence: EnterpriseAdmissionAuthenticationEvidence,
  clientId: unknown,
): EnterpriseAdmissionAuthorizationHandle | null {
  const state = getState(issuer);
  if (!safeAuditCurrent(state)) return null;
  if (!evidence || (typeof evidence !== "object" && typeof evidence !== "function")) return null;
  const pending = state?.evidence.get(evidence as object);
  state?.evidence.delete(evidence as object);
  if (
    !state ||
    !pending ||
    !state.active ||
    !safeAuditCurrent(state) ||
    pending.admissionEpoch !== state.admissionEpoch ||
    pending.credentialEpoch !== getEpoch(state.credentialEpoch, pending.credentialId) ||
    pending.principalEpoch !== getEpoch(state.principalEpoch, pending.principalKey) ||
    typeof clientId !== "string" ||
    clientId.length === 0
  )
    return null;
  const key = createEnterpriseSessionBindingKey({
    organizationId: pending.snapshot.principal.organizationId,
    principalId: pending.snapshot.principal.principalId,
    credentialId: pending.credentialId,
    grantVersion: pending.grantVersion,
    clientId,
  });
  if (state.slots.has(key)) return null;
  const handle = Object.freeze(Object.create(null)) as EnterpriseAdmissionAuthorizationHandle;
  const resolved = Object.freeze({
    principal: pending.snapshot.principal,
    node: pending.snapshot.node,
    clientId,
    sessionBindingGeneration: `${++state.generation}`,
    sessionBindingKey: key,
  }) as ResolvedEnterpriseAdmissionAuthorization;
  const active: HandleState = {
    ...resolved,
    snapshot: pending.snapshot,
    credentialId: pending.credentialId,
    principalKey: pending.principalKey,
    admissionEpoch: pending.admissionEpoch,
    credentialEpoch: pending.credentialEpoch,
    principalEpoch: pending.principalEpoch,
    grantVersion: pending.grantVersion,
    nodeKey: pending.nodeKey,
    principalType: pending.principalType,
    issuer,
    active: true,
  };
  state.handles.set(handle as object, active);
  state.slots.set(key, active);
  return handle;
}
// oxlint-disable-next-line complexity -- replacement atomically validates opaque state and tuple
// oxlint-disable-next-line complexity -- exact replacement validates the full binding tuple.
export function replaceEnterpriseAdmissionSession(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  oldHandle: EnterpriseAdmissionAuthorizationHandle,
  evidence: EnterpriseAdmissionAuthenticationEvidence,
  clientId: unknown,
): EnterpriseAdmissionAuthorizationHandle | null {
  const state = getState(issuer);
  if (
    !oldHandle ||
    !evidence ||
    (typeof oldHandle !== "object" && typeof oldHandle !== "function") ||
    (typeof evidence !== "object" && typeof evidence !== "function")
  )
    return null;
  const old = state?.handles.get(oldHandle as object);
  const pending = state?.evidence.get(evidence as object);
  if (!state || !old || !pending || !isCurrent(state, old) || old.clientId !== clientId) {
    state?.evidence.delete(evidence as object);
    return null;
  }
  const key = createEnterpriseSessionBindingKey({
    organizationId: pending.snapshot.principal.organizationId,
    principalId: pending.snapshot.principal.principalId,
    credentialId: pending.credentialId,
    grantVersion: pending.grantVersion,
    clientId,
  });
  if (
    key !== old.sessionBindingKey ||
    pending.credentialId !== old.credentialId ||
    pending.principalKey !== old.principalKey ||
    pending.grantVersion !== old.grantVersion ||
    pending.nodeKey !== old.nodeKey ||
    pending.principalType !== old.principalType
  ) {
    state.evidence.delete(evidence as object);
    return null;
  }
  state.slots.delete(old.sessionBindingKey);
  const next = bindEnterpriseAdmissionSession(issuer, evidence, clientId);
  if (!next) {
    state.slots.set(old.sessionBindingKey, old);
    return null;
  }
  old.active = false;
  state.slots.delete(old.sessionBindingKey);
  state.slots.set(key, state.handles.get(next as object)!);
  return next;
}
export function releaseEnterpriseAdmissionSession(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  handle: EnterpriseAdmissionAuthorizationHandle,
): boolean {
  const state = getState(issuer);
  if (!handle || (typeof handle !== "object" && typeof handle !== "function")) return false;
  const value = state?.handles.get(handle as object);
  if (!state || !value || !value.active) return false;
  value.active = false;
  if (state.slots.get(value.sessionBindingKey) === value)
    state.slots.delete(value.sessionBindingKey);
  return true;
}
export function resolveCurrentEnterpriseAdmissionAuthorization(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  handle: unknown,
): ResolvedEnterpriseAdmissionAuthorization | null {
  try {
    const state = getState(issuer);
    const value = state?.handles.get(handle as object);
    if (!state || !value || !safeAuditCurrent(state) || !isCurrent(state, value)) return null;
    return Object.freeze({
      principal: value.principal,
      node: value.node,
      clientId: value.clientId,
      sessionBindingGeneration: value.sessionBindingGeneration,
      sessionBindingKey: value.sessionBindingKey,
    });
  } catch {
    return null;
  }
}
export function isCurrentEnterpriseAdmissionAuthorization(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  handle: unknown,
): boolean {
  return resolveCurrentEnterpriseAdmissionAuthorization(issuer, handle) !== null;
}
export function invalidateEnterpriseAdmissionAuthorization(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
): void {
  const state = getState(issuer);
  if (!state) return;
  state.admissionEpoch++;
  for (const value of state.slots.values()) value.active = false;
  state.slots.clear();
}
export function invalidateEnterpriseCredential(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  credentialId: string,
): void {
  const state = getState(issuer);
  if (!state) return;
  state.credentialEpoch.set(credentialId, getEpoch(state.credentialEpoch, credentialId) + 1);
  for (const value of state.slots.values())
    if (value.credentialId === credentialId) {
      value.active = false;
      state.slots.delete(value.sessionBindingKey);
    }
}
export function invalidateEnterprisePrincipal(
  issuer: EnterpriseAdmissionAuthorizationIssuer,
  organizationId: string,
  principalId: string,
): void {
  const state = getState(issuer);
  if (!state) return;
  const key = `${organizationId}:${principalId}`;
  state.principalEpoch.set(key, getEpoch(state.principalEpoch, key) + 1);
  for (const value of state.slots.values())
    if (value.principalKey === key) {
      value.active = false;
      state.slots.delete(value.sessionBindingKey);
    }
}
