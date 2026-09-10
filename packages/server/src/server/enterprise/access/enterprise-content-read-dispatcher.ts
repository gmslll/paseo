// oxlint-disable no-nested-ternary
import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";
import type { ProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import { resolveCurrentProductionRuntimeAuthority } from "./production-runtime-authority.js";
import { isCurrentProductionAuthorizationRuntimeForAuthoritySources } from "./production-authorization-runtime.js";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { EnterpriseContentAgentProductionSource } from "../runtime/enterprise-content-read.js";
import {
  createEnterpriseWorkspaceContentReadSource,
  createEnterpriseAppSlotContentReadSource,
  createEnterpriseAgentContentReadSource,
} from "../runtime/enterprise-content-read.js";
import { isCurrentProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResponse,
} from "../../session/enterprise-dispatcher.js";
import {
  EnterpriseWorkspaceContentReadRequestSchema,
  GlobalResourceRefSchema,
  EnterpriseWorkspaceContentSelectorSchema,
  EnterpriseWorkspaceContentReadResponseSchema,
  EnterpriseAppSlotContentReadRequestSchema,
  EnterpriseAppSlotContentReadResponseSchema,
  EnterpriseAppSlotContentSelectorSchema,
  EnterpriseAgentContentReadRequestSchema,
  EnterpriseAgentContentReadResponseSchema,
  EnterpriseAgentContentSelectorSchema,
  type GlobalResourceRef,
} from "@getpaseo/protocol/messages";
import { productionAuditCapabilityIssuer } from "../audit/production-audit-runtime.js";

export interface EnterpriseContentReadFactoryInput {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly audit: ProductionAuditCapability;
  readonly agents: EnterpriseContentAgentProductionSource;
}
interface Pending {
  readonly context: EnterpriseDispatchContext;
  message: SessionInboundMessage;
  response: SessionOutboundMessage;
  resource: GlobalResourceRef;
}
function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
function deepFreeze<T>(value: T): T {
  if (isObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const child = Reflect.get(value, key);
      if (isObject(child)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  const ak = Reflect.ownKeys(a),
    bk = Reflect.ownKeys(b);
  return (
    ak.length === bk.length &&
    ak.every((k) => bk.includes(k) && equal(Reflect.get(a, k), Reflect.get(b, k)))
  );
}
function requestIdOf(
  workspace: ReturnType<typeof EnterpriseWorkspaceContentReadRequestSchema.safeParse>,
  app: ReturnType<typeof EnterpriseAppSlotContentReadRequestSchema.safeParse>,
  agent: ReturnType<typeof EnterpriseAgentContentReadRequestSchema.safeParse>,
): string {
  if (workspace.success) return workspace.data.requestId;
  if (app.success) return app.data.requestId;
  if (agent.success) return agent.data.requestId;
  return "";
}

export function createEnterpriseContentReadDispatcherRegistration(
  input: EnterpriseContentReadFactoryInput,
): EnterpriseSessionDispatcherFactoryRegistration | null {
  const { provider, audit, agents } = input;
  let currentAudit: ProductionAuditCapability;
  try {
    currentAudit = productionAuditCapabilityIssuer.requireCurrent(audit);
  } catch {
    return null;
  }
  if (!isCurrentProductionAuthorizationRuntimeProvider(provider) || !audit || !agents) return null;
  return {
    manifest: {
      operations: [
        "enterprise.workspace.content.read.request",
        "enterprise.app_slot.content.read.request",
        "enterprise.agent.content.read.request",
      ],
    },
    open(openInput) {
      if (!openInput.authorizationRuntime || !openInput.filesRuntime)
        throw new Error("content runtime unavailable");
      if (!resolveCurrentProductionRuntimeAuthority(openInput.authorizationRuntime, provider))
        throw new Error("content runtime is not current");
      const runtime = openInput.authorizationRuntime;
      const source = createEnterpriseWorkspaceContentReadSource({
        filesRuntime: openInput.filesRuntime,
        agents,
      });
      const appSlotSource = createEnterpriseAppSlotContentReadSource();
      const agentSource = createEnterpriseAgentContentReadSource(agents);
      if (!agentSource) throw new Error("agent source unavailable");
      if (!source) throw new Error("workspace source unavailable");
      let closed = false;
      let closePromise: Promise<void> | null = null;
      const reservations = new Set<string>();
      const issued = new WeakMap<object, Pending>();
      const pending = new Set<Pending>();
      const issuePending = (
        context: EnterpriseDispatchContext,
        message: SessionInboundMessage,
        response: SessionOutboundMessage,
        resource: GlobalResourceRef,
      ): SessionOutboundMessage => {
        const capability: Pending = Object.freeze({ context, message, response, resource });
        issued.set(response, capability);
        pending.add(capability);
        return response;
      };
      const current = (ctx: {
        sessionId: string;
        clientId: string;
        credentialId: string;
        sessionBindingGeneration: string;
        enterpriseContext: unknown;
      }) =>
        !closed &&
        productionAuditCapabilityIssuer.current(currentAudit) &&
        isCurrentProductionAuthorizationRuntimeProvider(provider) &&
        ctx.sessionId === openInput.sessionId &&
        ctx.clientId === openInput.clientId &&
        ctx.credentialId === openInput.context.principal.credentialId &&
        ctx.sessionBindingGeneration === openInput.context.sessionBindingGeneration &&
        ctx.enterpriseContext === openInput.context &&
        isCurrentProductionAuthorizationRuntimeForAuthoritySources(
          runtime,
          provider.grantStore,
          provider.owners,
        );
      return {
        dispatcher: {
          requestPolicyForType: (type: string) =>
            type === "enterprise.workspace.content.read.request" ||
            type === "enterprise.app_slot.content.read.request" ||
            type === "enterprise.agent.content.read.request"
              ? ("resources" as const)
              : null,
          // oxlint-disable-next-line complexity
          handle: async ({ sessionContext, message }): Promise<SessionOutboundMessage | false> => {
            const parsed = EnterpriseWorkspaceContentReadRequestSchema.safeParse(message);
            const parsedApp = EnterpriseAppSlotContentReadRequestSchema.safeParse(message);
            const parsedAgent = EnterpriseAgentContentReadRequestSchema.safeParse(message);
            const requestId = requestIdOf(parsed, parsedApp, parsedAgent);
            if (
              (!parsed.success && !parsedApp.success) ||
              !current(sessionContext) ||
              reservations.has(requestId)
            )
              return false;
            reservations.add(requestId);
            try {
              if (!parsed.success && parsedApp.success) {
                const authority = resolveCurrentProductionRuntimeAuthority(runtime, provider);
                if (!authority) return false;
                const principal = sessionContext.enterpriseContext.principal;
                const slot = await authority.resourceAuthorization.assertAppSlot(
                  principal,
                  "app.use",
                  parsedApp.data.resource.localResourceId,
                );
                if (!current(sessionContext)) return false;
                const canonical = GlobalResourceRefSchema.parse({
                  organizationId: slot.organizationId,
                  nodeId: slot.nodeId,
                  resourceKind: "app_slot",
                  localResourceId: slot.appSlotId,
                });
                if (!equal(parsedApp.data.resource, canonical)) return false;
                const selector = EnterpriseAppSlotContentSelectorSchema.parse(
                  parsedApp.data.selector,
                );
                const page = await appSlotSource.read({
                  resource: slot,
                  selector,
                  page: parsedApp.data.page,
                });
                if (!current(sessionContext)) return false;
                await currentAudit.append(
                  {
                    organizationId: principal.organizationId,
                    actorPrincipalId: principal.principalId,
                    actorCredentialId: principal.credentialId,
                    sessionId: sessionContext.sessionId,
                    action: "app.use",
                    resource: { kind: "app_slot", id: slot.appSlotId },
                    outcome: "allowed",
                  },
                  { durability: "required" },
                );
                if (!current(sessionContext)) return false;
                const response = deepFreeze(
                  EnterpriseAppSlotContentReadResponseSchema.parse({
                    type: "enterprise.app_slot.content.read.response",
                    payload: { requestId, resource: canonical, selector, page },
                  }),
                );
                return issuePending(sessionContext, message, response, canonical);
              }
              if (!parsed.success && parsedAgent.success) {
                const authority = resolveCurrentProductionRuntimeAuthority(runtime, provider);
                if (!authority) return false;
                const principal = sessionContext.enterpriseContext.principal;
                const agent = await authority.resourceAuthorization.assertAgent(
                  principal,
                  "workspace.content.read",
                  parsedAgent.data.resource.localResourceId,
                );
                if (!current(sessionContext)) return false;
                const canonical = GlobalResourceRefSchema.parse({
                  organizationId: agent.organizationId,
                  nodeId: agent.nodeId,
                  resourceKind: "agent",
                  localResourceId: agent.agentId,
                });
                if (!equal(parsedAgent.data.resource, canonical)) return false;
                const selector = EnterpriseAgentContentSelectorSchema.parse(
                  parsedAgent.data.selector,
                );
                const page = await agentSource.read({
                  resource: agent,
                  selector,
                  page: parsedAgent.data.page,
                });
                if (!current(sessionContext)) return false;
                await currentAudit.append(
                  {
                    organizationId: principal.organizationId,
                    actorPrincipalId: principal.principalId,
                    actorCredentialId: principal.credentialId,
                    sessionId: sessionContext.sessionId,
                    action: "workspace.content.read",
                    resource: { kind: "agent", id: agent.agentId },
                    workspaceId: agent.workspaceId,
                    outcome: "allowed",
                  },
                  { durability: "required" },
                );
                if (!current(sessionContext)) return false;
                const response = deepFreeze(
                  EnterpriseAgentContentReadResponseSchema.parse({
                    type: "enterprise.agent.content.read.response",
                    payload: { requestId, resource: canonical, selector, page },
                  }),
                );
                return issuePending(sessionContext, message, response, canonical);
              }
              if (!parsed.success) return false;
              const authority = resolveCurrentProductionRuntimeAuthority(runtime, provider);
              if (!authority) return false;
              const workspace = await authority.resourceAuthorization.assertWorkspace(
                sessionContext.enterpriseContext.principal,
                "workspace.content.read",
                parsed.data.resource.localResourceId,
              );
              if (!current(sessionContext)) return false;
              const canonical = GlobalResourceRefSchema.parse({
                organizationId: workspace.organizationId,
                nodeId: workspace.nodeId,
                resourceKind: "workspace",
                localResourceId: workspace.workspaceId,
              });
              if (!equal(parsed.data.resource, canonical)) return false;
              const selector = EnterpriseWorkspaceContentSelectorSchema.parse(parsed.data.selector);
              const page = await source.read({
                resource: workspace,
                selector,
                page: parsed.data.page,
              });
              if (!current(sessionContext)) return false;
              const principal = sessionContext.enterpriseContext.principal;
              await currentAudit.append(
                {
                  organizationId: principal.organizationId,
                  actorPrincipalId: principal.principalId,
                  actorCredentialId: principal.credentialId,
                  sessionId: sessionContext.sessionId,
                  action: "workspace.content.read",
                  resource: { kind: "workspace", id: workspace.workspaceId },
                  workspaceId: workspace.workspaceId,
                  outcome: "allowed",
                },
                { durability: "required" },
              );
              if (!current(sessionContext)) return false;
              const response = deepFreeze(
                EnterpriseWorkspaceContentReadResponseSchema.parse({
                  type: "enterprise.workspace.content.read.response",
                  payload: {
                    requestId: parsed.data.requestId,
                    resource: canonical,
                    selector,
                    page,
                  },
                }),
              );
              return issuePending(sessionContext, message, response, canonical);
            } catch {
              return false;
            } finally {
              reservations.delete(requestId);
            }
          },
          // oxlint-disable-next-line complexity
          consumeResponse: ({
            sessionContext,
            message,
            response,
          }): EnterpriseDispatchResponse | null => {
            if (!isObject(response)) return null;
            const capability = issued.get(response);
            if (!capability) return null;
            issued.delete(response);
            pending.delete(capability);
            try {
              const workspaceRequest =
                EnterpriseWorkspaceContentReadRequestSchema.safeParse(message);
              const appRequest = EnterpriseAppSlotContentReadRequestSchema.safeParse(message);
              const agentRequest = EnterpriseAgentContentReadRequestSchema.safeParse(message);
              if (!workspaceRequest.success && !appRequest.success && !agentRequest.success)
                return null;
              const request = workspaceRequest.success
                ? workspaceRequest.data
                : appRequest.success
                  ? appRequest.data
                  : agentRequest.success
                    ? agentRequest.data
                    : null;
              if (!request) return null;
              const workspaceResponse =
                EnterpriseWorkspaceContentReadResponseSchema.safeParse(response);
              const appResponse = EnterpriseAppSlotContentReadResponseSchema.safeParse(response);
              const agentResponse = EnterpriseAgentContentReadResponseSchema.safeParse(response);
              if (!workspaceResponse.success && !appResponse.success && !agentResponse.success)
                return null;
              const parsedResponse = workspaceResponse.success
                ? workspaceResponse.data
                : appResponse.success
                  ? appResponse.data
                  : agentResponse.success
                    ? agentResponse.data
                    : null;
              if (!parsedResponse) return null;
              if (capability.context !== sessionContext) return null;
              if (capability.message !== message) return null;
              if (capability.response !== response) return null;
              if (!current(sessionContext)) return null;
              if (parsedResponse.payload.requestId !== request.requestId) return null;
              if (!equal(parsedResponse.payload.resource, capability.resource)) return null;
              if (!equal(parsedResponse.payload.selector, request.selector)) return null;
              return {
                response: capability.response,
                authorizationContext: {
                  kind: "resources",
                  resources: [capability.resource],
                },
                receiptClassification: "resources",
              };
            } catch {
              return null;
            }
          },
        },
        close: async () => {
          if (closePromise) return closePromise;
          closed = true;
          reservations.clear();
          for (const item of pending) if (isObject(item.response)) issued.delete(item.response);
          pending.clear();
          closePromise = Promise.allSettled([source.close(), appSlotSource.close()]).then(
            (results) => {
              const errors = results.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
              );
              if (errors.length > 0)
                throw new AggregateError(errors, "content source close failed", {
                  cause: errors[0],
                });
              return undefined;
            },
          );
          return closePromise;
        },
      };
    },
  };
}
