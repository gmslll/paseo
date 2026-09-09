import {
  CurrentIdentityProjectionSchema,
  EnterpriseResourceStatusProjectionSchema,
  normalizeEnterpriseDisplayStrings,
  type CurrentIdentityProjection,
  type EnterpriseResourceStatusProjection,
  type GlobalResourceRef,
} from "@getpaseo/protocol/messages";

export const ENTERPRISE_NAVIGATION_DISPLAY_ALLOWLIST = [
  "workspaces",
  "organization",
  "identity",
  "browser_profiles",
  "audit",
] as const;

export const ENTERPRISE_OPERATION_DISPLAY_ALLOWLIST = [
  "workspace.create",
  "organization.resources.view",
  "identity.principals.view",
  "access.grants.view",
  "access.grants.manage",
  "browser.profiles.view",
  "browser.profiles.bind",
  "audit.events.view",
  "identity.logout_all",
] as const;

export const RESOURCE_STATUS_OPERATION_DISPLAY_ALLOWLIST = ["open"] as const;
export const RESOURCE_STATUS_REASON_DISPLAY_ALLOWLIST = ["capacity_wait"] as const;
export const ENTERPRISE_IDENTITY_REASON_DISPLAY_ALLOWLIST = [
  "identity.invalid_token",
  "identity.host_upgrade_required",
  "identity.unavailable",
  "identity.logout_failed",
  "identity.authentication_incomplete",
  "identity.logout_incomplete",
  "identity.mutation_in_progress",
  "identity.credential_revoked",
  "identity.token_required",
  "identity.authentication_pending",
  "identity.form_closed",
] as const;

export type EnterpriseNavigationDisplay = (typeof ENTERPRISE_NAVIGATION_DISPLAY_ALLOWLIST)[number];
export type EnterpriseOperationDisplay = (typeof ENTERPRISE_OPERATION_DISPLAY_ALLOWLIST)[number];
export type ResourceStatusOperationDisplay =
  (typeof RESOURCE_STATUS_OPERATION_DISPLAY_ALLOWLIST)[number];
export type ResourceStatusReasonDisplay = (typeof RESOURCE_STATUS_REASON_DISPLAY_ALLOWLIST)[number];
export type EnterpriseIdentityReasonDisplay =
  (typeof ENTERPRISE_IDENTITY_REASON_DISPLAY_ALLOWLIST)[number];

export interface IdentityDisplayPolicy {
  readonly navigation: readonly EnterpriseNavigationDisplay[];
  readonly allowedOperations: readonly EnterpriseOperationDisplay[];
}

export function getIdentityDisplayPolicyFromParsed(
  identity: CurrentIdentityProjection,
): IdentityDisplayPolicy {
  return Object.freeze({
    navigation: Object.freeze(
      normalizeEnterpriseDisplayStrings(
        identity.navigation,
        ENTERPRISE_NAVIGATION_DISPLAY_ALLOWLIST,
      ) as EnterpriseNavigationDisplay[],
    ),
    allowedOperations: Object.freeze(
      normalizeEnterpriseDisplayStrings(
        identity.allowedOperations,
        ENTERPRISE_OPERATION_DISPLAY_ALLOWLIST,
      ) as EnterpriseOperationDisplay[],
    ),
  });
}

export function getIdentityDisplayPolicy(projection: unknown): IdentityDisplayPolicy | undefined {
  const parsed = CurrentIdentityProjectionSchema.safeParse(projection);
  if (!parsed.success) return undefined;
  return getIdentityDisplayPolicyFromParsed(parsed.data);
}

export function normalizeEnterpriseIdentityReason(
  reasonCode: unknown,
  fallback: EnterpriseIdentityReasonDisplay = "identity.unavailable",
): EnterpriseIdentityReasonDisplay {
  if (typeof reasonCode !== "string") return fallback;
  return (
    (normalizeEnterpriseDisplayStrings(
      [reasonCode],
      ENTERPRISE_IDENTITY_REASON_DISPLAY_ALLOWLIST,
    )[0] as EnterpriseIdentityReasonDisplay | undefined) ?? fallback
  );
}

export type ResourceStatusDisplayTone = "success" | "warning" | "error" | "muted";

export interface ResourceStatusDisplayPolicy {
  readonly resource: GlobalResourceRef;
  readonly status: EnterpriseResourceStatusProjection["status"];
  readonly tone: ResourceStatusDisplayTone;
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly label?: string;
  readonly allowedOperations: readonly ResourceStatusOperationDisplay[];
  readonly queue?: EnterpriseResourceStatusProjection["queue"];
  readonly reasonCode?: ResourceStatusReasonDisplay;
}

const RESOURCE_STATUS_TONES: Record<
  EnterpriseResourceStatusProjection["status"],
  ResourceStatusDisplayTone
> = {
  ready: "success",
  resource_waiting: "warning",
  login_required: "warning",
  mfa_required: "warning",
  risk_control: "error",
  disabled: "muted",
};

function cloneGlobalResourceRef(resource: GlobalResourceRef): GlobalResourceRef {
  switch (resource.resourceKind) {
    case "workspace":
    case "agent":
    case "browser_profile":
    case "app_slot":
      return Object.freeze({
        organizationId: resource.organizationId,
        nodeId: resource.nodeId,
        resourceKind: resource.resourceKind,
        localResourceId: resource.localResourceId,
      });
  }
}

export function getResourceStatusDisplayPolicy(
  projection: unknown,
): ResourceStatusDisplayPolicy | undefined {
  const parsed = EnterpriseResourceStatusProjectionSchema.safeParse(projection);
  if (!parsed.success) return undefined;
  const statusProjection: EnterpriseResourceStatusProjection = parsed.data;
  const reasonCode = statusProjection.reasonCode
    ? (normalizeEnterpriseDisplayStrings(
        [statusProjection.reasonCode],
        RESOURCE_STATUS_REASON_DISPLAY_ALLOWLIST,
      )[0] as ResourceStatusReasonDisplay | undefined)
    : undefined;

  const queue = statusProjection.queue
    ? Object.freeze({
        queuedAt: statusProjection.queue.queuedAt,
        ...(statusProjection.queue.position ? { position: statusProjection.queue.position } : {}),
      })
    : undefined;

  return Object.freeze({
    resource: cloneGlobalResourceRef(statusProjection.resource),
    status: statusProjection.status,
    tone: RESOURCE_STATUS_TONES[statusProjection.status],
    ...(statusProjection.workspaceId ? { workspaceId: statusProjection.workspaceId } : {}),
    ...(statusProjection.agentId ? { agentId: statusProjection.agentId } : {}),
    ...(statusProjection.label ? { label: statusProjection.label } : {}),
    allowedOperations: Object.freeze(
      normalizeEnterpriseDisplayStrings(
        statusProjection.allowedOperations,
        RESOURCE_STATUS_OPERATION_DISPLAY_ALLOWLIST,
      ) as ResourceStatusOperationDisplay[],
    ),
    ...(queue ? { queue } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  });
}
