import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";
import type { ProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import { resolveCurrentProductionRuntimeAuthority } from "./production-runtime-authority.js";
import { isCurrentProductionAuthorizationRuntimeForAuthoritySources } from "./production-authorization-runtime.js";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import type { EnterpriseContentAgentProductionSource } from "../runtime/enterprise-content-read.js";
import { createEnterpriseWorkspaceContentReadSource } from "../runtime/enterprise-content-read.js";
import { isCurrentProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  EnterpriseWorkspaceContentReadRequestSchema,
  GlobalResourceRefSchema,
  EnterpriseWorkspaceContentReadResponseSchema,
  type GlobalResourceRef,
} from "@getpaseo/protocol/messages";
import { productionAuditCapabilityIssuer } from "../audit/production-audit-runtime.js";

export interface EnterpriseContentReadFactoryInput {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly audit: ProductionAuditCapability;
  readonly agents: EnterpriseContentAgentProductionSource;
}
export interface Pending {
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
  void currentAudit;
  void EnterpriseWorkspaceContentReadRequestSchema;
  void EnterpriseWorkspaceContentReadResponseSchema;
  void equal;
  void deepFreeze;
  if (!isCurrentProductionAuthorizationRuntimeProvider(provider) || !audit || !agents) return null;
  return {
    manifest: { operations: ["enterprise.workspace.content.read.request"] },
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
      if (!source) throw new Error("workspace source unavailable");
      let closed = false;
      let closePromise: Promise<void> | null = null;
      const reservations = new Set<string>();
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
            type === "enterprise.workspace.content.read.request" ? ("resources" as const) : null,
          handle: async ({ sessionContext, message }): Promise<false> => {
            const parsed = EnterpriseWorkspaceContentReadRequestSchema.safeParse(message);
            if (
              !parsed.success ||
              !current(sessionContext) ||
              reservations.has(parsed.data.requestId)
            )
              return false;
            reservations.add(parsed.data.requestId);
            try {
              const authority = resolveCurrentProductionRuntimeAuthority(runtime, provider);
              if (!authority) return false;
              const workspace = await authority.resourceAuthorization.assertWorkspace(
                sessionContext.enterpriseContext.principal,
                "workspace.content.read",
                parsed.data.resource.localResourceId,
              );
              if (!resolveCurrentProductionRuntimeAuthority(runtime, provider)) return false;
              const canonical = GlobalResourceRefSchema.parse({
                organizationId: workspace.organizationId,
                nodeId: workspace.nodeId,
                resourceKind: "workspace",
                localResourceId: workspace.workspaceId,
              });
              if (!equal(parsed.data.resource, canonical)) return false;
              return false;
            } finally {
              reservations.delete(parsed.data.requestId);
            }
          },
        },
        close: async () => {
          if (closePromise) return closePromise;
          closed = true;
          reservations.clear();
          closePromise = source.close();
          return closePromise;
        },
      };
    },
  };
}
