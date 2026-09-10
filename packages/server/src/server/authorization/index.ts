import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  type DaemonPermission,
  type EnterpriseAction,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  INBOUND_PERMISSION,
  type PermissionRequirement,
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

export { DAEMON_PERMISSIONS, type DaemonPermission };

const daemonPermissionSet: ReadonlySet<string> = new Set(DAEMON_PERMISSIONS);

export function isDaemonPermission(value: string): value is DaemonPermission {
  return daemonPermissionSet.has(value);
}

export function parseDaemonPermissions(values: readonly string[]): DaemonPermission[] {
  const permissions = [...new Set(values)];
  if (!permissions.every(isDaemonPermission)) throw new Error("Invalid daemon permission");
  return permissions;
}

export const OWNER_PERMISSIONS: readonly DaemonPermission[] = DAEMON_PERMISSIONS;

/** Derive only enterprise coarse permissions from a canonical principal grant snapshot. */
export function deriveEnterpriseSessionPermissions(
  principal: PrincipalContext,
): readonly DaemonPermission[] {
  if (principal.principalType === "break_glass_owner") return OWNER_PERMISSIONS;
  const actions = new Set(principal.grants.map((grant) => grant.action));
  const permissions = new Set<DaemonPermission>();
  const readActions: readonly EnterpriseAction[] = [
    "workspace.metadata.read",
    "workspace.content.read",
    "provider.history.read",
    "audit.read",
    "identity.manage",
  ];
  if (readActions.some((a) => actions.has(a))) permissions.add("workspace.read");
  const writeActions: readonly EnterpriseAction[] = [
    "workspace.write",
    "provider.history.import",
    "workspace.script.execute",
    "browser.profile.manage",
    "identity.manage",
  ];
  if (writeActions.some((a) => actions.has(a))) permissions.add("workspace.write");
  if (actions.has("workspace.manage")) permissions.add("workspace.manage");
  const pairedActions: readonly EnterpriseAction[] = [
    "browser.use",
    "app.use",
    "terminal.use",
    "workspace.script.configure",
    "workspace.editor.open",
  ];
  if (pairedActions.some((a) => actions.has(a))) {
    permissions.add("workspace.read");
    permissions.add("workspace.write");
  }
  return Object.freeze([...permissions]);
}

declare const inboundDaemonAuthorizationDecisionBrand: unique symbol;
declare const consumedInboundDaemonAuthorizationDecisionBrand: unique symbol;
declare const activeInboundDaemonAuthorizationBrand: unique symbol;
declare const activeDaemonPermissionBrand: unique symbol;

export interface InboundDaemonAuthorizationDecision {
  readonly [inboundDaemonAuthorizationDecisionBrand]: true;
}

export interface ConsumedInboundDaemonAuthorizationDecision {
  readonly [consumedInboundDaemonAuthorizationDecisionBrand]: true;
  readonly requestType: SessionInboundMessage["type"];
  readonly daemonPermission: PermissionRequirement;
}

export interface ActiveInboundDaemonAuthorization {
  readonly [activeInboundDaemonAuthorizationBrand]: true;
}

export interface ActiveDaemonPermission {
  readonly [activeDaemonPermissionBrand]: true;
}

interface SessionAuthorizationState {
  readonly permissions: ReadonlySet<DaemonPermission>;
  readonly generation: number;
}

interface InboundDaemonAuthorizationDecisionState {
  readonly issuer: SessionAuthorization;
  readonly message: SessionInboundMessage;
  readonly requestType: SessionInboundMessage["type"];
  readonly daemonPermission: PermissionRequirement;
  readonly generation: number;
}

const sessionAuthorizationStates = new WeakMap<object, SessionAuthorizationState>();
const inboundDaemonAuthorizationDecisionStates = new WeakMap<
  object,
  InboundDaemonAuthorizationDecisionState
>();
const consumedInboundDaemonAuthorizationDecisionStates = new WeakMap<
  object,
  InboundDaemonAuthorizationDecisionState
>();
const activeInboundDaemonAuthorizationStates = new WeakMap<
  object,
  InboundDaemonAuthorizationDecisionState
>();
const activeDaemonPermissionStates = new WeakMap<
  object,
  {
    readonly issuer: SessionAuthorization;
    readonly permission: DaemonPermission;
    readonly generation: number;
  }
>();

export class SessionAuthorization {
  constructor(permissions: readonly DaemonPermission[]) {
    sessionAuthorizationStates.set(this, {
      permissions: new Set(permissions),
      generation: 0,
    });
  }

  allowsInbound(message: SessionInboundMessage): boolean {
    const requirement = inboundPermissionRequirement(message);
    const authorization = sessionAuthorizationStates.get(this);
    return (
      authorization !== undefined &&
      requirement !== undefined &&
      allowsRequirement(authorization.permissions, requirement)
    );
  }

  authorizeInbound(message: SessionInboundMessage): InboundDaemonAuthorizationDecision | null {
    const authorization = sessionAuthorizationStates.get(this);
    if (!authorization) return null;
    const requestType = inboundMessageType(message);
    if (requestType === undefined) return null;
    const requirement = requiredPermissionForInbound(requestType);
    if (!allowsRequirement(authorization.permissions, requirement)) {
      return null;
    }
    const decision = Object.freeze(
      Object.create(null) as object,
    ) as unknown as InboundDaemonAuthorizationDecision;
    inboundDaemonAuthorizationDecisionStates.set(decision, {
      issuer: this,
      message,
      requestType,
      daemonPermission: clonePermissionRequirement(requirement),
      generation: authorization.generation,
    });
    return decision;
  }

  allowsOutbound(message: SessionOutboundMessage): boolean {
    return allowsRequirement(
      sessionAuthorizationState(this).permissions,
      requiredPermissionForOutbound(message),
    );
  }

  replacePermissions(permissions: readonly DaemonPermission[]): void {
    const current = sessionAuthorizationState(this);
    sessionAuthorizationStates.set(this, {
      permissions: new Set(permissions),
      generation: current.generation + 1,
    });
  }

  listPermissions(): DaemonPermission[] {
    return [...sessionAuthorizationState(this).permissions];
  }

  allowsPermission(permission: DaemonPermission): boolean {
    return sessionAuthorizationState(this).permissions.has(permission);
  }
}

export function isSessionAuthorization(value: unknown): value is SessionAuthorization {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    sessionAuthorizationStates.has(value)
  );
}

export function consumeInboundDaemonAuthorizationDecision(
  authorization: SessionAuthorization,
  message: SessionInboundMessage,
  decision: InboundDaemonAuthorizationDecision,
): ConsumedInboundDaemonAuthorizationDecision | null {
  if ((typeof decision !== "object" && typeof decision !== "function") || decision === null) {
    return null;
  }
  const issued = inboundDaemonAuthorizationDecisionStates.get(decision);
  if (!issued) return null;
  inboundDaemonAuthorizationDecisionStates.delete(decision);
  const requestType = inboundMessageType(message);
  const current = sessionAuthorizationStates.get(authorization);
  if (
    !current ||
    issued.issuer !== authorization ||
    issued.message !== message ||
    issued.requestType !== requestType ||
    issued.generation !== current.generation ||
    !allowsRequirement(current.permissions, issued.daemonPermission)
  ) {
    return null;
  }
  const consumed = Object.freeze({
    requestType: issued.requestType,
    daemonPermission: clonePermissionRequirement(issued.daemonPermission),
  }) as unknown as ConsumedInboundDaemonAuthorizationDecision;
  consumedInboundDaemonAuthorizationDecisionStates.set(consumed, issued);
  return consumed;
}

export function consumeCurrentInboundDaemonAuthorizationDecision(
  authorization: SessionAuthorization,
  message: SessionInboundMessage,
  requestType: string | null,
  decision: ConsumedInboundDaemonAuthorizationDecision,
): boolean {
  if ((typeof decision !== "object" && typeof decision !== "function") || decision === null) {
    return false;
  }
  const consumed = consumedInboundDaemonAuthorizationDecisionStates.get(decision);
  if (!consumed) return false;
  consumedInboundDaemonAuthorizationDecisionStates.delete(decision);
  const current = sessionAuthorizationStates.get(authorization);
  return (
    current !== undefined &&
    consumed.issuer === authorization &&
    consumed.message === message &&
    consumed.requestType === requestType &&
    consumed.generation === current.generation &&
    allowsRequirement(current.permissions, consumed.daemonPermission)
  );
}

/**
 * Converts the second-stage one-use decision into a request-lifetime proof.
 * The proof exposes no generation or permission data and can only be checked
 * against the exact SessionAuthorization that issued the original decision.
 */
export function activateCurrentInboundDaemonAuthorizationDecision(
  authorization: SessionAuthorization,
  message: SessionInboundMessage,
  requestType: string | null,
  decision: ConsumedInboundDaemonAuthorizationDecision,
): ActiveInboundDaemonAuthorization | null {
  if ((typeof decision !== "object" && typeof decision !== "function") || decision === null) {
    return null;
  }
  const consumed = consumedInboundDaemonAuthorizationDecisionStates.get(decision);
  if (!consumed) return null;
  consumedInboundDaemonAuthorizationDecisionStates.delete(decision);
  const current = sessionAuthorizationStates.get(authorization);
  if (
    !current ||
    consumed.issuer !== authorization ||
    consumed.message !== message ||
    consumed.requestType !== requestType ||
    consumed.generation !== current.generation ||
    !allowsRequirement(current.permissions, consumed.daemonPermission)
  ) {
    return null;
  }
  const active = Object.freeze(
    Object.create(null) as object,
  ) as unknown as ActiveInboundDaemonAuthorization;
  activeInboundDaemonAuthorizationStates.set(active, consumed);
  return active;
}

export function isActiveInboundDaemonAuthorizationCurrent(
  authorization: SessionAuthorization,
  active: ActiveInboundDaemonAuthorization,
  requestType: string,
  daemonPermission: PermissionRequirement,
): boolean {
  if ((typeof active !== "object" && typeof active !== "function") || active === null) {
    return false;
  }
  const issued = activeInboundDaemonAuthorizationStates.get(active);
  const current = sessionAuthorizationStates.get(authorization);
  return Boolean(
    issued &&
    current &&
    issued.issuer === authorization &&
    issued.requestType === requestType &&
    issued.generation === current.generation &&
    samePermissionRequirement(issued.daemonPermission, daemonPermission) &&
    allowsRequirement(current.permissions, issued.daemonPermission),
  );
}

export function closeActiveInboundDaemonAuthorization(
  authorization: SessionAuthorization,
  active: ActiveInboundDaemonAuthorization,
): void {
  if ((typeof active !== "object" && typeof active !== "function") || active === null) return;
  const issued = activeInboundDaemonAuthorizationStates.get(active);
  if (issued?.issuer === authorization) activeInboundDaemonAuthorizationStates.delete(active);
}

export function issueActiveDaemonPermission(
  authorization: SessionAuthorization,
  permission: DaemonPermission,
): ActiveDaemonPermission | null {
  const current = sessionAuthorizationStates.get(authorization);
  if (!current?.permissions.has(permission)) return null;
  const handle = Object.freeze(Object.create(null)) as ActiveDaemonPermission;
  activeDaemonPermissionStates.set(handle as object, {
    issuer: authorization,
    permission,
    generation: current.generation,
  });
  return handle;
}

export function isActiveDaemonPermissionCurrent(
  authorization: SessionAuthorization,
  handle: ActiveDaemonPermission,
  permission: DaemonPermission,
): boolean {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    return false;
  }
  const issued = activeDaemonPermissionStates.get(handle as object);
  const current = sessionAuthorizationStates.get(authorization);
  return Boolean(
    issued &&
    current &&
    issued.issuer === authorization &&
    issued.permission === permission &&
    issued.generation === current.generation &&
    current.permissions.has(permission),
  );
}

export function closeActiveDaemonPermission(
  authorization: SessionAuthorization,
  handle: ActiveDaemonPermission,
): boolean {
  if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
    return false;
  }
  const issued = activeDaemonPermissionStates.get(handle as object);
  if (issued?.issuer !== authorization) return false;
  activeDaemonPermissionStates.delete(handle as object);
  return true;
}

function sessionAuthorizationState(authorization: SessionAuthorization): SessionAuthorizationState {
  const state = sessionAuthorizationStates.get(authorization);
  if (!state) throw new Error("Invalid SessionAuthorization receiver");
  return state;
}

function inboundPermissionRequirement(
  message: SessionInboundMessage,
): PermissionRequirement | undefined {
  const requestType = inboundMessageType(message);
  return requestType === undefined ? undefined : requiredPermissionForInbound(requestType);
}

function inboundMessageType(
  message: SessionInboundMessage,
): SessionInboundMessage["type"] | undefined {
  try {
    if (typeof message !== "object" || message === null || !("type" in message)) return undefined;
    const requestType: unknown = message.type;
    if (typeof requestType !== "string" || !Object.hasOwn(INBOUND_PERMISSION, requestType)) {
      return undefined;
    }
    return requestType as SessionInboundMessage["type"];
  } catch {
    return undefined;
  }
}

function allowsRequirement(
  permissions: ReadonlySet<DaemonPermission>,
  requirement: PermissionRequirement,
): boolean {
  if (requirement === null) return true;
  if (typeof requirement === "string") return permissions.has(requirement);
  return requirement.some((permission) => permissions.has(permission));
}

function clonePermissionRequirement(requirement: PermissionRequirement): PermissionRequirement {
  return typeof requirement === "object" && requirement !== null
    ? Object.freeze([...requirement])
    : requirement;
}

function samePermissionRequirement(
  left: PermissionRequirement,
  right: PermissionRequirement,
): boolean {
  if (left === null || right === null) return left === right;
  const leftValues = typeof left === "string" ? [left] : [...left];
  const rightValues = typeof right === "string" ? [right] : [...right];
  if (new Set(leftValues).size !== leftValues.length) return false;
  if (new Set(rightValues).size !== rightValues.length) return false;
  return [...leftValues].sort().join("\0") === [...rightValues].sort().join("\0");
}

const LEGACY_HUB_EXECUTION_SCOPE = "hub.execution.*";

export function permissionsForLegacyHubScopes(
  scopes: readonly string[],
): readonly DaemonPermission[] {
  // COMPAT(semanticHubPermissions): added in v0.7, remove after Hub enrollment uses permissions.
  return scopes.includes(LEGACY_HUB_EXECUTION_SCOPE) ? ["hub.execute"] : [];
}
