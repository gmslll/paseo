import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { OutboundAuthorizationContext } from "@getpaseo/protocol/messages";
import type { OutboundAuthorityReceiptPolicy } from "../enterprise/access/event-action-map.js";
import type { EnterpriseSessionContext } from "../enterprise/identity/session-context.js";

/** The server-bound context supplied to an enterprise RPC handler. */
export interface EnterpriseDispatchContext {
  readonly sessionId: string;
  readonly clientId: string;
  /** Server-retained credential identifier; raw credentials never cross this seam. */
  readonly credentialId: string;
  readonly sessionBindingGeneration: string;
  readonly enterpriseContext: EnterpriseSessionContext;
}

export type EnterpriseReceiptClassification =
  | "authority"
  | "resources"
  | "identity_self"
  | "transport_control";

export type EnterpriseContentReadRequestType =
  | "enterprise.workspace.content.read.request"
  | "enterprise.agent.content.read.request"
  | "enterprise.browser_profile.content.read.request"
  | "enterprise.app_slot.content.read.request";
export type EnterpriseContentReadResponseType =
  | "enterprise.workspace.content.read.response"
  | "enterprise.agent.content.read.response"
  | "enterprise.browser_profile.content.read.response"
  | "enterprise.app_slot.content.read.response";
export interface EnterpriseContentReadPolicy {
  readonly requestType: EnterpriseContentReadRequestType;
  readonly responseType: EnterpriseContentReadResponseType;
  readonly action: "workspace.content.read" | "browser.use" | "app.use";
  readonly featureFlag:
    | "enterpriseWorkspaceContentReadV1"
    | "enterpriseAgentContentReadV1"
    | "enterpriseBrowserProfileContentReadV1"
    | "enterpriseAppSlotContentReadV1";
}
export const ENTERPRISE_CONTENT_READ_MANIFEST: readonly EnterpriseContentReadPolicy[] =
  Object.freeze([
    Object.freeze({
      requestType: "enterprise.workspace.content.read.request",
      responseType: "enterprise.workspace.content.read.response",
      action: "workspace.content.read",
      featureFlag: "enterpriseWorkspaceContentReadV1",
    }),
    Object.freeze({
      requestType: "enterprise.agent.content.read.request",
      responseType: "enterprise.agent.content.read.response",
      action: "workspace.content.read",
      featureFlag: "enterpriseAgentContentReadV1",
    }),
    Object.freeze({
      requestType: "enterprise.browser_profile.content.read.request",
      responseType: "enterprise.browser_profile.content.read.response",
      action: "browser.use",
      featureFlag: "enterpriseBrowserProfileContentReadV1",
    }),
    Object.freeze({
      requestType: "enterprise.app_slot.content.read.request",
      responseType: "enterprise.app_slot.content.read.response",
      action: "app.use",
      featureFlag: "enterpriseAppSlotContentReadV1",
    }),
  ]);

export function resolveEnterpriseContentReadPolicy(
  requestType: string,
): EnterpriseContentReadPolicy | null {
  return (
    ENTERPRISE_CONTENT_READ_MANIFEST.find((policy) => policy.requestType === requestType) ?? null
  );
}
export interface EnterpriseDispatchResponse {
  readonly response: SessionOutboundMessage;
  readonly authorizationContext?: OutboundAuthorizationContext;
  readonly receiptClassification: EnterpriseReceiptClassification;
}
export type EnterpriseDispatchResult = SessionOutboundMessage | false;
export interface EnterpriseResponseContextConsumer {
  consumeResponse(input: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
    readonly response: SessionOutboundMessage;
  }): EnterpriseDispatchResponse | null;
}
export type EnterpriseIdentityRequestType =
  | "enterprise.identity.get_current.request"
  | "enterprise.identity.logout_all.request";
export type EnterpriseIdentityResponseType =
  | "enterprise.identity.get_current.response"
  | "enterprise.identity.logout_all.response";
export interface EnterpriseIdentitySelfPolicyDescriptor {
  readonly requestTypes: readonly EnterpriseIdentityRequestType[];
  readonly responseTypes: readonly EnterpriseIdentityResponseType[];
  readonly requiresCurrentSessionBinding: true;
}
export const ENTERPRISE_IDENTITY_SELF_POLICY: EnterpriseIdentitySelfPolicyDescriptor =
  Object.freeze({
    requestTypes: Object.freeze([
      "enterprise.identity.get_current.request",
      "enterprise.identity.logout_all.request",
    ] as const),
    responseTypes: Object.freeze([
      "enterprise.identity.get_current.response",
      "enterprise.identity.logout_all.response",
    ] as const),
    requiresCurrentSessionBinding: true,
  });
export function registerEnterpriseIdentitySelfPolicy(
  dispatcher: EnterpriseSessionDispatcher,
): EnterpriseSessionDispatcher {
  return {
    handle: async (input) => {
      const result = await dispatcher.handle(input);
      if (result === false) return false;
      return isIdentitySelfResponse(result) ? result : false;
    },
  };
}
export function isIdentitySelfRequest(message: SessionInboundMessage): boolean {
  return (
    message.type === "enterprise.identity.get_current.request" ||
    message.type === "enterprise.identity.logout_all.request"
  );
}
export function isEnterpriseResourceRequest(message: SessionInboundMessage): boolean {
  return (
    message.type === "enterprise.organization.list_resources.request" ||
    message.type === "enterprise.placement.resolve_workspace.request" ||
    resolveEnterpriseContentReadPolicy(message.type) !== null
  );
}

export function isEnterpriseResponsePair(
  request: SessionInboundMessage,
  response: SessionOutboundMessage,
): boolean {
  const policy = resolveEnterpriseContentReadPolicy(request.type);
  if (!policy) return true;
  const responseType = typeof response.type === "string" ? response.type : "";
  if (responseType !== policy.responseType) return false;
  const requestValue = request as unknown as {
    readonly requestId?: unknown;
    readonly resource?: unknown;
    readonly selector?: unknown;
  };
  const payload = (
    response as unknown as {
      readonly payload?: {
        readonly requestId?: unknown;
        readonly resource?: unknown;
        readonly selector?: unknown;
      };
    }
  ).payload;
  const requestId = requestValue.requestId;
  const requestResource = requestValue.resource;
  const responseResource = payload?.resource;
  const requestSelector = requestValue.selector;
  const responseSelector = payload?.selector;
  const sameResource = sameResourceRef(requestResource, responseResource);
  const sameSelector = sameContentSelector(requestSelector, responseSelector);
  return (
    typeof requestId === "string" &&
    payload !== undefined &&
    payload.requestId === requestId &&
    sameResource &&
    sameSelector
  );
}

function sameResourceRef(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return (
    left.resourceKind === right.resourceKind &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.localResourceId === right.localResourceId
  );
}

function sameContentSelector(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return left.kind === right.kind && left.view === right.view;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
export function isIdentitySelfResponse(message: SessionOutboundMessage): boolean {
  return (
    message.type === "enterprise.identity.get_current.response" ||
    message.type === "enterprise.identity.logout_all.response"
  );
}
export function resolveEnterpriseReceiptPolicy(
  requestType: string,
): OutboundAuthorityReceiptPolicy | null {
  if (requestType === "enterprise.organization.list_resources.request") {
    return {
      event: "enterprise.organization.list_resources.response",
      requestType: "enterprise.organization.list_resources.request",
      daemonPermission: null,
      enterpriseActions: ["workspace.metadata.read"],
      emission: "terminal",
    };
  }
  if (requestType === "enterprise.placement.resolve_workspace.request") {
    return {
      event: "enterprise.placement.resolve_workspace.response",
      requestType: "enterprise.placement.resolve_workspace.request",
      daemonPermission: null,
      enterpriseActions: ["workspace.metadata.read"],
      emission: "terminal",
    };
  }
  if (requestType === "enterprise.identity.get_current.request") {
    return {
      event: "enterprise.identity.get_current.response",
      requestType: "enterprise.identity.get_current.request",
      daemonPermission: null,
      enterpriseActions: [],
      emission: "terminal",
    };
  }
  if (requestType === "enterprise.identity.logout_all.request") {
    return {
      event: "enterprise.identity.logout_all.response",
      requestType: "enterprise.identity.logout_all.request",
      daemonPermission: null,
      enterpriseActions: [],
      emission: "terminal",
    };
  }
  return null;
}

/** W3 routing seam; domain policy and handlers remain owned by their workstreams. */
export interface EnterpriseSessionDispatcher {
  readonly requestPolicyForType?: (type: string) => EnterpriseReceiptClassification | null;
  handle(input: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
  }): Promise<EnterpriseDispatchResult> | EnterpriseDispatchResult;
  readonly consumeResponse?: EnterpriseResponseContextConsumer["consumeResponse"];
}
export interface EnterpriseSessionDispatcherFactory {
  create(input: {
    readonly sessionId: string;
    readonly clientId: string;
    readonly context: EnterpriseSessionContext;
    readonly runtime?: unknown;
    readonly filesRuntime?: unknown;
  }): EnterpriseSessionDispatcher;
  dispose?(dispatcher: EnterpriseSessionDispatcher): Promise<void> | void;
}
export interface EnterpriseDispatcherManifest {
  readonly operations: readonly string[];
}
export interface EnterpriseDispatcherLease {
  readonly dispatcher: EnterpriseSessionDispatcher;
  /** Internal composite-routing seam for consumers that require the exact issuing dispatcher. */
  readonly dispatcherForOperation?: (operation: string) => EnterpriseSessionDispatcher | null;
  readonly close: () => Promise<void> | void;
}
export interface EnterpriseSessionDispatcherFactoryRegistration {
  readonly manifest: EnterpriseDispatcherManifest;
  open(input: {
    readonly sessionId: string;
    readonly clientId: string;
    readonly context: EnterpriseSessionContext;
    readonly authorizationRuntime?: unknown;
    readonly filesRuntime?: unknown;
    readonly requestLifecycle?: unknown;
  }): EnterpriseDispatcherLease;
}
/** Opaque W1 admission-to-Session invalidation signal; no domain policy lives here. */
export interface CredentialInvalidationSink {
  invalidate(input: {
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
  }): Promise<void> | void;
}

export const ENTERPRISE_UNAVAILABLE_ERROR = "Enterprise operation unavailable";

export function isEnterpriseRequest(message: SessionInboundMessage): boolean {
  return message.type.startsWith("enterprise.") && message.type.endsWith(".request");
}

export async function dispatchEnterpriseRequest(
  dispatcher: EnterpriseSessionDispatcher | null,
  sessionContext: EnterpriseDispatchContext,
  message: SessionInboundMessage,
): Promise<SessionOutboundMessage | false> {
  if (!dispatcher) return false;
  return await dispatcher.handle({ sessionContext, message });
}
