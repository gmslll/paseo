import {
  EnterpriseAuditListEventsRequestSchema,
  EnterpriseAuditListEventsResponseSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  RpcErrorMessageSchema,
  type AuditEvent,
  type EnterpriseAuditListEventsRequest,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type {
  EnterpriseDispatchContext,
  EnterpriseSessionDispatcher,
} from "../../session/enterprise-dispatcher.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./production-audit-runtime.js";

const DEFAULT_AUDIT_PAGE_SIZE = 100;
const AUDIT_EVENTS_UNAVAILABLE = "Audit events unavailable";
const AUDIT_EVENTS_UNAVAILABLE_CODE = "resource_not_visible";

export interface EnterpriseAuditHandlerOptions {
  readonly audit: ProductionAuditCapability;
}

interface AuditRequestSnapshot {
  readonly request: EnterpriseAuditListEventsRequest;
  readonly principal: PrincipalContext;
  readonly node: Readonly<EnterpriseDispatchContext["enterpriseContext"]["node"]>;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function assertSafeQueryString(value: string, subject: string): void {
  if (value.length > 256 || hasControlCharacter(value)) {
    throw new Error(`invalid audit ${subject}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotRequest(
  message: EnterpriseAuditListEventsRequest,
  sessionContext: EnterpriseDispatchContext,
): AuditRequestSnapshot {
  const request = EnterpriseAuditListEventsRequestSchema.strict().parse(structuredClone(message));
  const principal = PrincipalContextSchema.parse(
    structuredClone(sessionContext.enterpriseContext.principal),
  );
  const node = NodeContextSchema.strict().parse(
    structuredClone(sessionContext.enterpriseContext.node),
  );
  if (
    sessionContext.credentialId !== principal.credentialId ||
    sessionContext.sessionBindingGeneration !==
      sessionContext.enterpriseContext.sessionBindingGeneration
  ) {
    throw new Error("invalid audit session binding");
  }
  assertSafeQueryString(request.requestId, "request id");
  if (request.workspaceId !== undefined) {
    assertSafeQueryString(request.workspaceId, "workspace id");
  }
  if (request.cursor !== undefined) assertSafeQueryString(request.cursor, "cursor");
  if (request.resource !== undefined) {
    assertSafeQueryString(request.resource.kind, "resource kind");
    assertSafeQueryString(request.resource.id, "resource id");
  }
  return deepFreeze({ request, principal, node });
}

function hasOrganizationAuditGrant(principal: PrincipalContext): boolean {
  return principal.grants.some(
    (grant) =>
      grant.action === "audit.read" &&
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === principal.organizationId,
  );
}

function eventMatchesRequest(event: Readonly<AuditEvent>, snapshot: AuditRequestSnapshot): boolean {
  if (
    event.organizationId !== snapshot.principal.organizationId ||
    event.nodeId !== snapshot.node.nodeId
  ) {
    return false;
  }
  const { resource, workspaceId } = snapshot.request;
  if (workspaceId !== undefined && event.workspaceId !== workspaceId) return false;
  if (
    resource !== undefined &&
    (event.resource.kind !== resource.kind || event.resource.id !== resource.id)
  ) {
    return false;
  }
  return true;
}

function unavailable(requestId: string): SessionOutboundMessage {
  return deepFreeze(
    RpcErrorMessageSchema.strict().parse({
      type: "rpc_error",
      payload: {
        requestId,
        requestType: "enterprise.audit.list_events.request",
        error: AUDIT_EVENTS_UNAVAILABLE,
        code: AUDIT_EVENTS_UNAVAILABLE_CODE,
      },
    }),
  );
}

function listResponse(
  snapshot: AuditRequestSnapshot,
  storedEvents: readonly AuditEvent[],
): SessionOutboundMessage {
  const events = storedEvents.filter((event) => eventMatchesRequest(event, snapshot)).toReversed();
  let start = 0;
  if (snapshot.request.cursor !== undefined) {
    const cursorIndex = events.findIndex((event) => event.eventId === snapshot.request.cursor);
    if (cursorIndex < 0) return unavailable(snapshot.request.requestId);
    start = cursorIndex + 1;
  }
  const limit = snapshot.request.limit ?? DEFAULT_AUDIT_PAGE_SIZE;
  const page = events.slice(start, start + limit);
  const lastEvent = page.at(-1);
  const nextCursor = start + page.length < events.length && lastEvent ? lastEvent.eventId : null;
  return deepFreeze(
    EnterpriseAuditListEventsResponseSchema.strict().parse({
      type: "enterprise.audit.list_events.response",
      payload: {
        requestId: snapshot.request.requestId,
        events: page,
        nextCursor,
      },
    }),
  );
}

export function createEnterpriseAuditDispatcher(
  options: EnterpriseAuditHandlerOptions,
): EnterpriseSessionDispatcher {
  let audit: ProductionAuditCapability;
  try {
    audit = productionAuditCapabilityIssuer.requireCurrent(options.audit);
  } catch (error) {
    throw new Error("current production audit capability required by audit handler", {
      cause: error,
    });
  }
  const snapshotEvents = audit.snapshotEvents.bind(audit);
  const auditNode = audit.node;

  return Object.freeze({
    async handle({
      sessionContext,
      message,
    }: Parameters<EnterpriseSessionDispatcher["handle"]>[0]): Promise<
      SessionOutboundMessage | false
    > {
      if (message.type !== "enterprise.audit.list_events.request") return false;
      let snapshot: AuditRequestSnapshot;
      try {
        snapshot = snapshotRequest(message, sessionContext);
      } catch {
        return false;
      }
      if (
        !productionAuditCapabilityIssuer.current(audit) ||
        !hasOrganizationAuditGrant(snapshot.principal) ||
        snapshot.node.nodeId !== auditNode.nodeId ||
        snapshot.node.paseoServerId !== auditNode.paseoServerId ||
        snapshot.node.mode !== auditNode.mode
      ) {
        return unavailable(snapshot.request.requestId);
      }

      let events: readonly AuditEvent[];
      try {
        events = await snapshotEvents();
      } catch {
        return unavailable(snapshot.request.requestId);
      }
      if (!productionAuditCapabilityIssuer.current(audit)) {
        return unavailable(snapshot.request.requestId);
      }
      return listResponse(snapshot, events);
    },
  });
}
