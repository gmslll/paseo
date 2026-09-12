import type {
  EnterpriseDispatcherManifest,
  EnterpriseDispatcherLease,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../../session/enterprise-dispatcher.js";
import {
  isEnterpriseAgentContextCurrentForSession,
  type EnterpriseAgentContextHandle,
  type EnterpriseAgentSessionContextRegistry,
  type EnterpriseSessionContext,
} from "../../session/enterprise-agent-session-context-registry.js";
import type { AuthorizedAgent, ResourceAuthorization } from "@getpaseo/protocol/messages";
import {
  resolveAuthoritativeAgent,
  resolveCurrentProductionRuntimeAuthority,
} from "../access/production-runtime-authority.js";
import type { ProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import {
  isProductionBrowserLeaseWaitingContextForSession,
  type ProductionBrowserLeaseBundle,
  type ProductionBrowserLeaseWaitingContext,
} from "./production-bundle.js";
import {
  EnterpriseBrowserLeaseHandler,
  type EnterpriseBrowserLeaseAuthorityPort,
  type EnterpriseBrowserLeaseHandlerOptions,
  type EnterpriseBrowserLeasePort,
  type EnterpriseBrowserProfileBindingPort,
  type EnterpriseBrowserProfileReadPort,
} from "./handlers.js";

export function isStableBrowserProfileBinding(
  first: {
    organizationId: string;
    nodeId: string;
    workspaceId: string;
    browserProfileId: string;
    boundAt: string;
  },
  second: {
    organizationId: string;
    nodeId: string;
    workspaceId: string;
    browserProfileId: string;
    boundAt: string;
  } | null,
): boolean {
  return (
    !!second &&
    first.organizationId === second.organizationId &&
    first.nodeId === second.nodeId &&
    first.workspaceId === second.workspaceId &&
    first.browserProfileId === second.browserProfileId &&
    first.boundAt === second.boundAt
  );
}

const sessionRuntimeBrand = Symbol("EnterpriseBrowserLeaseSessionRuntime");

export const ENTERPRISE_BROWSER_LEASE_OPERATIONS = Object.freeze([
  "enterprise.browser.list_profiles.request",
  "enterprise.browser.bind_profile.request",
  "enterprise.resource.acquire_lease.request",
  "enterprise.resource.renew_lease.request",
  "enterprise.resource.release_lease.request",
] as const);

export interface EnterpriseBrowserLeaseSessionRuntime {
  readonly [sessionRuntimeBrand]: "EnterpriseBrowserLeaseSessionRuntime";
  readonly profiles: EnterpriseBrowserProfileReadPort;
  readonly bindings: EnterpriseBrowserProfileBindingPort;
  readonly leases: EnterpriseBrowserLeasePort;
  readonly leaseTtlMs: number;
}

export type EnterpriseBrowserLeaseSessionRuntimeInput = Omit<
  EnterpriseBrowserLeaseSessionRuntime,
  typeof sessionRuntimeBrand
>;

export interface EnterpriseBrowserLeaseDispatcherFactoryOptions {
  readonly runtime: EnterpriseBrowserLeaseSessionRuntime;
  readonly authority: EnterpriseBrowserLeaseAuthorityPort;
  readonly isCurrentAuthorizationRuntime?: (authorizationRuntime: unknown) => boolean;
  readonly authorityForSessionRuntime?: (input: {
    readonly sessionId: string;
    readonly clientId: string;
    readonly authorizationRuntime: unknown;
    readonly requestLifecycle: unknown;
    readonly context: EnterpriseSessionContext;
  }) => EnterpriseBrowserLeaseAuthorityPort | null;
}

const MANIFEST: EnterpriseDispatcherManifest = Object.freeze({
  operations: ENTERPRISE_BROWSER_LEASE_OPERATIONS,
});

export function createEnterpriseBrowserLeaseSessionRuntime(
  input: EnterpriseBrowserLeaseSessionRuntimeInput,
): EnterpriseBrowserLeaseSessionRuntime {
  const captured = captureRuntimePorts(input);
  if (!captured) throw new Error("Enterprise browser lease session runtime is incomplete.");
  return Object.freeze({
    ...captured,
    [sessionRuntimeBrand]: "EnterpriseBrowserLeaseSessionRuntime" as const,
  });
}

/**
 * Creates the per-session registration only when all W4-owned typed dependencies
 * are present. The integration layer can omit the registration when it returns null.
 */
export function createEnterpriseBrowserLeaseDispatcherRegistration(
  options: EnterpriseBrowserLeaseDispatcherFactoryOptions | null | undefined,
): EnterpriseSessionDispatcherFactoryRegistration | null {
  const captured = captureFactoryOptions(options);
  if (!captured) return null;
  return Object.freeze({
    manifest: MANIFEST,
    open(input: {
      readonly sessionId: string;
      readonly clientId: string;
      readonly context: EnterpriseSessionContext;
      readonly authorizationRuntime?: unknown;
      readonly requestLifecycle?: unknown;
    }): EnterpriseDispatcherLease {
      assertOpenInput(input);
      const authority = captured.authorityForSessionRuntime
        ? captured.authorityForSessionRuntime({
            sessionId: input.sessionId,
            clientId: input.clientId,
            authorizationRuntime: input.authorizationRuntime,
            requestLifecycle: input.requestLifecycle,
            context: input.context,
          })
        : captured.options.authority;
      if (!authority) throw new Error("Enterprise browser session authority is unavailable.");
      const dispatcher = new EnterpriseBrowserLeaseHandler({
        ...captured.options,
        authority,
        isCurrentSession: (context) => {
          const matchesOpenSession =
            context.sessionId === input.sessionId &&
            context.clientId === input.clientId &&
            context.credentialId === input.context.principal.credentialId &&
            context.sessionBindingGeneration === input.context.sessionBindingGeneration &&
            context.enterpriseContext === input.context;
          if (!matchesOpenSession) return false;
          return captured.isCurrentAuthorizationRuntime
            ? captured.isCurrentAuthorizationRuntime(input.authorizationRuntime)
            : true;
        },
      });
      return Object.freeze({
        dispatcher,
        close: () => dispatcher.close(),
      });
    },
  });
}

export function createProductionBrowserLeaseDispatcherRegistration(input: {
  provider: ProductionAuthorizationRuntimeProvider;
  registry: EnterpriseAgentSessionContextRegistry;
  bundle: ProductionBrowserLeaseBundle;
  runtime: EnterpriseBrowserLeaseSessionRuntime;
}): EnterpriseSessionDispatcherFactoryRegistration | null {
  const provider = input.provider;
  const unbindByGeneration = new Map<string, { readonly unbind: () => void }>();
  const base = createEnterpriseBrowserLeaseDispatcherRegistration({
    runtime: input.runtime,
    authority: createUnavailableAuthority(),
    isCurrentAuthorizationRuntime: (authorizationRuntime) =>
      resolveCurrentProductionRuntimeAuthority(authorizationRuntime, provider) !== null,
    authorityForSessionRuntime: ({
      sessionId,
      clientId,
      authorizationRuntime,
      requestLifecycle,
      context: sessionContext,
    }) => {
      const authority = resolveCurrentProductionRuntimeAuthority(authorizationRuntime, provider);
      if (!authority) return null;
      let waitingContext: ProductionBrowserLeaseWaitingContext | undefined;
      if (requestLifecycle !== undefined) {
        if (
          !isProductionBrowserLeaseWaitingContextForSession(requestLifecycle, {
            sessionId,
            clientId,
            sessionBindingGeneration: sessionContext.sessionBindingGeneration,
          })
        ) {
          return null;
        }
        waitingContext = requestLifecycle;
      }
      const boundAgentHandles = new WeakSet<object>();
      const isCurrentHandle: EnterpriseBrowserLeaseAuthorityPort["isCurrentHandle"] = (handle) =>
        boundAgentHandles.has(handle) &&
        isCurrentProductionAgentHandle({
          provider,
          authorizationRuntime,
          resourceAuthorization: authority.resourceAuthorization,
          registry: input.registry,
          handle,
          sessionContext,
        });
      const releaseAgentHandle: EnterpriseBrowserLeaseAuthorityPort["releaseAgentHandle"] = (
        handle,
      ) => releaseExactBoundAgentHandle(input.registry, boundAgentHandles, handle);
      const resolvedAuthority: EnterpriseBrowserLeaseAuthorityPort = {
        assertWorkspace: (principalContext, action, workspaceId) =>
          authority.resourceAuthorization.assertWorkspace(principalContext, action, workspaceId),
        assertBrowserProfile: (principalContext, action, profileId) =>
          authority.resourceAuthorization.assertBrowserProfile(principalContext, action, profileId),
        resolveAgentHandle: async ({ sessionContext: requestContext, agentId }) => {
          let handle: EnterpriseAgentContextHandle | null = null;
          let succeeded = false;
          try {
            if (!sameSessionContext(requestContext, sessionContext)) return null;
            const before = resolveCurrentProductionAgent({
              provider,
              authorizationRuntime,
              resourceAuthorization: authority.resourceAuthorization,
              sessionContext: requestContext,
              agentId,
            });
            if (!before) return null;
            const authorized = await authority.resourceAuthorization.assertAgent(
              requestContext.principal,
              "browser.use",
              agentId,
            );
            const afterAuthorization = resolveCurrentProductionAgent({
              provider,
              authorizationRuntime,
              resourceAuthorization: authority.resourceAuthorization,
              sessionContext: requestContext,
              agentId,
            });
            if (
              !afterAuthorization ||
              !sameAuthorizedAgent(before, afterAuthorization) ||
              !sameAuthorizedAgent(afterAuthorization, authorized)
            ) {
              return null;
            }
            const existing = input.registry.resolve(agentId);
            if (
              existing &&
              boundAgentHandles.has(existing) &&
              isCurrentProductionAgentHandle({
                provider,
                authorizationRuntime,
                resourceAuthorization: authority.resourceAuthorization,
                registry: input.registry,
                handle: existing,
                sessionContext,
              })
            ) {
              succeeded = true;
              return existing;
            }
            handle = input.registry.bind({ agentId, context: requestContext });
            boundAgentHandles.add(handle);
            if (
              !isCurrentProductionAgentHandle({
                provider,
                authorizationRuntime,
                resourceAuthorization: authority.resourceAuthorization,
                registry: input.registry,
                handle,
                sessionContext,
              })
            ) {
              return null;
            }
            succeeded = true;
            return handle;
          } catch {
            return null;
          } finally {
            if (handle && !succeeded) releaseAgentHandle(handle);
          }
        },
        releaseAgentHandle,
        isCurrentHandle,
        resolveLeaseAuthorization: async (handle) => {
          if (!isCurrentHandle(handle)) throw new Error("Stale agent handle.");
          const agent = resolveAuthoritativeAgent(authority.owners, handle.agentId);
          if (!agent) throw new Error("Agent is not authoritative.");
          const workspace = await authority.resourceAuthorization.assertWorkspace(
            handle.context.principal,
            "workspace.metadata.read",
            agent.workspaceId,
          );
          const binding = await input.bundle.bindings.resolveForAgent({ workspace, agent });
          if (!binding) throw new Error("Binding unavailable.");
          const profile = await authority.resourceAuthorization.assertBrowserProfile(
            handle.context.principal,
            "browser.use",
            binding.browserProfileId,
          );
          const currentBinding = await input.bundle.bindings.resolveForAgent({ workspace, agent });
          const currentAgent = resolveCurrentProductionAgent({
            provider,
            authorizationRuntime,
            resourceAuthorization: authority.resourceAuthorization,
            sessionContext: handle.context,
            agentId: handle.agentId,
          });
          if (
            !isCurrentHandle(handle) ||
            !currentAgent ||
            !sameAuthorizedAgent(agent, currentAgent) ||
            !currentBinding ||
            binding.organizationId !== workspace.organizationId ||
            binding.nodeId !== workspace.nodeId ||
            binding.workspaceId !== workspace.workspaceId ||
            binding.workspaceId !== agent.workspaceId ||
            binding.browserProfileId !== profile.browserProfileId ||
            !isStableBrowserProfileBinding(binding, currentBinding)
          )
            throw new Error("Binding changed while resolving authorization.");
          return { workspace, agent, profile, bindingRevision: binding.boundAt };
        },
      };
      const unbind = input.bundle.bindSessionAuthority({
        generation: sessionContext.sessionBindingGeneration,
        isCurrentHandle: resolvedAuthority.isCurrentHandle,
        resolveAuthorization: resolvedAuthority.resolveLeaseAuthorization,
        waitingContext,
      });
      unbindByGeneration.set(sessionContext.sessionBindingGeneration, { unbind });
      return resolvedAuthority;
    },
  });
  if (!base) return null;
  return Object.freeze({
    manifest: base.manifest,
    open(openInput: Parameters<EnterpriseSessionDispatcherFactoryRegistration["open"]>[0]) {
      let lease: EnterpriseDispatcherLease;
      try {
        lease = base.open(openInput);
      } catch (error) {
        const failedEntry = unbindByGeneration.get(openInput.context.sessionBindingGeneration);
        failedEntry?.unbind();
        if (
          failedEntry &&
          unbindByGeneration.get(openInput.context.sessionBindingGeneration) === failedEntry
        ) {
          unbindByGeneration.delete(openInput.context.sessionBindingGeneration);
        }
        throw error;
      }
      const ownEntry = unbindByGeneration.get(openInput.context.sessionBindingGeneration);
      let closePromise: Promise<void> | null = null;
      return Object.freeze({
        dispatcher: lease.dispatcher,
        close: async () => {
          closePromise ??= (async () => {
            const generation = openInput.context.sessionBindingGeneration;
            const errors: unknown[] = [];
            try {
              await lease.close();
            } catch (error) {
              errors.push(error);
            }
            if (ownEntry) {
              try {
                if (unbindByGeneration.get(generation) === ownEntry)
                  unbindByGeneration.delete(generation);
                ownEntry.unbind();
              } catch (error) {
                errors.push(error);
              }
            }
            try {
              await input.bundle.invalidateSession(generation);
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) {
              throw new AggregateError(errors, "Enterprise browser lease close failed.", {
                cause: errors[0],
              });
            }
          })();
          return closePromise;
        },
      });
    },
  });
}

function resolveCurrentProductionAgent(input: {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly authorizationRuntime: unknown;
  readonly resourceAuthorization: ResourceAuthorization;
  readonly sessionContext: EnterpriseSessionContext;
  readonly agentId: string;
}): AuthorizedAgent | null {
  const current = resolveCurrentProductionRuntimeAuthority(
    input.authorizationRuntime,
    input.provider,
  );
  if (!current || current.resourceAuthorization !== input.resourceAuthorization) return null;
  const agent = resolveAuthoritativeAgent(current.owners, input.agentId);
  if (
    !agent ||
    agent.agentId !== input.agentId ||
    agent.organizationId !== input.sessionContext.principal.organizationId ||
    agent.nodeId !== input.sessionContext.node.nodeId
  ) {
    return null;
  }
  return agent;
}

function isCurrentProductionAgentHandle(input: {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly authorizationRuntime: unknown;
  readonly resourceAuthorization: ResourceAuthorization;
  readonly registry: EnterpriseAgentSessionContextRegistry;
  readonly handle: EnterpriseAgentContextHandle;
  readonly sessionContext: EnterpriseSessionContext;
}): boolean {
  try {
    if (
      !input.registry.isCurrentHandle(input.handle) ||
      !isEnterpriseAgentContextCurrentForSession(input.handle, input.sessionContext)
    ) {
      return false;
    }
    return (
      resolveCurrentProductionAgent({
        provider: input.provider,
        authorizationRuntime: input.authorizationRuntime,
        resourceAuthorization: input.resourceAuthorization,
        sessionContext: input.handle.context,
        agentId: input.handle.agentId,
      }) !== null
    );
  } catch {
    return false;
  }
}

function releaseExactBoundAgentHandle(
  registry: EnterpriseAgentSessionContextRegistry,
  boundHandles: WeakSet<object>,
  handle: EnterpriseAgentContextHandle,
): void {
  if (!boundHandles.delete(handle)) return;
  try {
    if (registry.resolve(handle.agentId) !== handle || !registry.isCurrentHandle(handle)) return;
    registry.release({
      agentId: handle.agentId,
      sessionBindingGeneration: handle.context.sessionBindingGeneration,
    });
  } catch {
    // The handle is no longer trusted; never broaden cleanup beyond the exact current binding.
  }
}

function sameSessionContext(
  left: EnterpriseSessionContext,
  right: EnterpriseSessionContext,
): boolean {
  return (
    left.sessionBindingGeneration === right.sessionBindingGeneration &&
    left.principal.organizationId === right.principal.organizationId &&
    left.principal.principalType === right.principal.principalType &&
    left.principal.principalId === right.principal.principalId &&
    left.principal.credentialId === right.principal.credentialId &&
    left.principal.grantVersion === right.principal.grantVersion &&
    left.node.nodeId === right.node.nodeId &&
    left.node.paseoServerId === right.node.paseoServerId &&
    left.node.mode === right.node.mode
  );
}

function sameAuthorizedAgent(left: AuthorizedAgent, right: AuthorizedAgent): boolean {
  return (
    left.agentId === right.agentId &&
    left.workspaceId === right.workspaceId &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function createUnavailableAuthority(): EnterpriseBrowserLeaseAuthorityPort {
  const fail = async (): Promise<never> => {
    throw new Error("Production authority is unavailable.");
  };
  return {
    assertWorkspace: fail,
    assertBrowserProfile: fail,
    resolveAgentHandle: () => null,
    releaseAgentHandle: () => undefined,
    isCurrentHandle: () => false,
    resolveLeaseAuthorization: fail,
  };
}

function captureFactoryOptions(
  options: EnterpriseBrowserLeaseDispatcherFactoryOptions | null | undefined,
): {
  readonly options: EnterpriseBrowserLeaseHandlerOptions;
  readonly authorityForSessionRuntime?: EnterpriseBrowserLeaseDispatcherFactoryOptions["authorityForSessionRuntime"];
  readonly isCurrentAuthorizationRuntime?: EnterpriseBrowserLeaseDispatcherFactoryOptions["isCurrentAuthorizationRuntime"];
} | null {
  try {
    if (!options) return null;
    const runtime = options.runtime;
    if (runtime[sessionRuntimeBrand] !== "EnterpriseBrowserLeaseSessionRuntime") return null;
    const authority = options.authority;
    const authorityForSessionRuntime = options.authorityForSessionRuntime;
    const isCurrentAuthorizationRuntime = options.isCurrentAuthorizationRuntime;
    const authorityAssertWorkspace = authority.assertWorkspace;
    const authorityAssertProfile = authority.assertBrowserProfile;
    const authorityResolveHandle = authority.resolveAgentHandle;
    const authorityReleaseHandle = authority.releaseAgentHandle;
    const authorityIsCurrent = authority.isCurrentHandle;
    const authorityResolveLease = authority.resolveLeaseAuthorization;
    if (
      typeof authorityAssertWorkspace !== "function" ||
      typeof authorityAssertProfile !== "function" ||
      typeof authorityResolveHandle !== "function" ||
      typeof authorityReleaseHandle !== "function" ||
      typeof authorityIsCurrent !== "function" ||
      typeof authorityResolveLease !== "function"
    ) {
      return null;
    }
    const capturedAuthority: EnterpriseBrowserLeaseAuthorityPort = Object.freeze({
      assertWorkspace: authorityAssertWorkspace.bind(authority),
      assertBrowserProfile: authorityAssertProfile.bind(authority),
      resolveAgentHandle: authorityResolveHandle.bind(authority),
      releaseAgentHandle: authorityReleaseHandle.bind(authority),
      isCurrentHandle: authorityIsCurrent.bind(authority),
      resolveLeaseAuthorization: authorityResolveLease.bind(authority),
    });
    if (
      authorityForSessionRuntime !== undefined &&
      typeof authorityForSessionRuntime !== "function"
    ) {
      return null;
    }
    if (
      isCurrentAuthorizationRuntime !== undefined &&
      typeof isCurrentAuthorizationRuntime !== "function"
    ) {
      return null;
    }
    return Object.freeze({
      authorityForSessionRuntime,
      isCurrentAuthorizationRuntime,
      options: Object.freeze({
        ...runtime,
        authority: capturedAuthority,
      }),
    });
  } catch {
    return null;
  }
}

function captureRuntimePorts(
  input: EnterpriseBrowserLeaseSessionRuntimeInput | null | undefined,
): Omit<EnterpriseBrowserLeaseSessionRuntime, typeof sessionRuntimeBrand> | null {
  try {
    if (!input) return null;
    const profiles = input.profiles;
    const bindings = input.bindings;
    const leases = input.leases;
    const leaseTtlMs = input.leaseTtlMs;
    const profileList = profiles.list;
    const profileGet = profiles.get;
    const bindingList = bindings.list;
    const bindingBind = bindings.bind;
    const leaseAcquire = leases.acquire;
    const leaseRenew = leases.renew;
    const leaseRelease = leases.releaseLease;
    if (
      !Number.isSafeInteger(leaseTtlMs) ||
      leaseTtlMs <= 0 ||
      typeof profileList !== "function" ||
      typeof profileGet !== "function" ||
      typeof bindingList !== "function" ||
      typeof bindingBind !== "function" ||
      typeof leaseAcquire !== "function" ||
      typeof leaseRenew !== "function" ||
      typeof leaseRelease !== "function"
    ) {
      return null;
    }
    return Object.freeze({
      profiles: Object.freeze({
        list: profileList.bind(profiles),
        get: profileGet.bind(profiles),
      }),
      bindings: Object.freeze({
        list: bindingList.bind(bindings),
        bind: bindingBind.bind(bindings),
      }),
      leases: Object.freeze({
        acquire: leaseAcquire.bind(leases),
        renew: leaseRenew.bind(leases),
        releaseLease: leaseRelease.bind(leases),
      }),
      leaseTtlMs,
    });
  } catch {
    return null;
  }
}

function assertOpenInput(input: {
  readonly sessionId: string;
  readonly clientId: string;
  readonly context: EnterpriseSessionContext;
}): void {
  if (!input || typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new Error("Enterprise browser lease sessionId is required.");
  }
  if (typeof input.clientId !== "string" || input.clientId.length === 0) {
    throw new Error("Enterprise browser lease clientId is required.");
  }
  if (!input.context || typeof input.context !== "object") {
    throw new Error("Enterprise browser lease session context is required.");
  }
}
