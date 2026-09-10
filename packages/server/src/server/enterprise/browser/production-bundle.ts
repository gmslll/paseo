import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AuditSink } from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  BrowserProfileRegistry,
  JsonFileBrowserProfileStorage,
  createNodeBrowserProfileCanonicalResolver,
  type BrowserProfileCanonicalResolver,
} from "./profile-registry.js";
import {
  BrowserProfileBindingRegistry,
  JsonFileBrowserProfileBindingStorage,
  type BrowserProfileBindingQuarantineSink,
} from "./binding-registry.js";
import {
  BrowserProfileLeaseManager,
  type BrowserLeaseScheduler,
  type BrowserProfileLeaseContextualWaitingNotice,
  type BrowserProfileLeaseGenerationStorage,
  type BrowserProfileLeaseManagerOptions,
  type BrowserProfileLeaseWaitingNotice,
} from "./lease-manager.js";
import { readSecureJsonFile, writeSecureJsonFile } from "./secure-json-file.js";
import type { EnterpriseAgentContextHandle } from "../../session/enterprise-agent-session-context-registry.js";
import type { BrowserProfileLeaseAuthorization } from "./lease-manager.js";
import {
  BrowserPageIdentityRegistry,
  createBrowserPageIdentityVerifier,
  type BrowserPageIdentityVerifier,
} from "../../browser-tools/page-identity-registry.js";
import {
  createBrowserPageIdentityInvalidationDispatcherRegistration,
  createBrowserPageIdentityObservationDispatcherRegistration,
} from "./page-identity-observation.js";
import type { EnterpriseSessionDispatcherFactoryRegistration } from "../../session/enterprise-dispatcher.js";

export class JsonFileBrowserProfileLeaseGenerationStorage implements BrowserProfileLeaseGenerationStorage {
  public constructor(private readonly filePath: string) {}
  public read(): Promise<unknown | null> {
    return readSecureJsonFile(this.filePath).then((value) => {
      if (value === null) return null;
      return z
        .object({
          version: z.literal(1),
          generation: z.number().int().nonnegative(),
          nextFencingToken: z.number().int().positive(),
        })
        .strict()
        .parse(value);
    });
  }
  public write(snapshot: object): Promise<void> {
    return writeSecureJsonFile(this.filePath, snapshot);
  }
}

export interface ProductionBrowserLeaseBundleOptions extends Omit<
  BrowserProfileLeaseManagerOptions,
  | "generationStorage"
  | "clock"
  | "isCurrentHandle"
  | "resolveAuthorization"
  | "onWaitingWithContext"
> {
  paseoHome: string;
  nodeId: string;
  downloadBaseRoot: string;
  auditSink: AuditSink;
  clock: BrowserLeaseScheduler;
  canonicalResolver?: BrowserProfileCanonicalResolver;
  quarantine?: BrowserProfileBindingQuarantineSink;
  createId?: () => string;
  profiles?: BrowserProfileRegistry;
}

declare const productionBrowserLeaseWaitingContextBrand: unique symbol;

/** Nominal, server-minted route identity; it contains no credential or filesystem authority. */
export interface ProductionBrowserLeaseWaitingContext {
  readonly [productionBrowserLeaseWaitingContextBrand]: never;
  readonly sessionId: string;
  readonly clientId: string;
  readonly sessionBindingGeneration: string;
}

export interface ProductionBrowserLeaseWaitingNotice extends BrowserProfileLeaseWaitingNotice {
  readonly context: ProductionBrowserLeaseWaitingContext;
}

const productionWaitingContexts = new WeakMap<
  object,
  (notice: ProductionBrowserLeaseWaitingNotice) => void | Promise<void>
>();

/**
 * W3 creates one context from its canonical Session callback and passes it as the dispatcher open
 * requestLifecycle. The production factory accepts it only for that exact open Session tuple.
 */
export function createProductionBrowserLeaseWaitingContext(input: {
  readonly sessionId: string;
  readonly clientId: string;
  readonly sessionBindingGeneration: string;
  readonly onWaiting: (notice: ProductionBrowserLeaseWaitingNotice) => void | Promise<void>;
}): ProductionBrowserLeaseWaitingContext {
  const sessionId = input.sessionId;
  const clientId = input.clientId;
  const sessionBindingGeneration = input.sessionBindingGeneration;
  const onWaiting = input.onWaiting;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    typeof sessionBindingGeneration !== "string" ||
    sessionBindingGeneration.length === 0 ||
    typeof onWaiting !== "function"
  ) {
    throw new Error("Production Browser lease waiting context is invalid.");
  }
  const context = Object.freeze({
    sessionId,
    clientId,
    sessionBindingGeneration,
  }) as ProductionBrowserLeaseWaitingContext;
  productionWaitingContexts.set(context, onWaiting);
  return context;
}

export function isProductionBrowserLeaseWaitingContext(
  value: unknown,
): value is ProductionBrowserLeaseWaitingContext {
  return typeof value === "object" && value !== null && productionWaitingContexts.has(value);
}

export function isProductionBrowserLeaseWaitingContextForSession(
  value: unknown,
  session: {
    readonly sessionId: string;
    readonly clientId: string;
    readonly sessionBindingGeneration: string;
  },
): value is ProductionBrowserLeaseWaitingContext {
  if (typeof value !== "object" || value === null) return false;
  return (
    productionWaitingContexts.has(value) &&
    Reflect.get(value, "sessionId") === session.sessionId &&
    Reflect.get(value, "clientId") === session.clientId &&
    Reflect.get(value, "sessionBindingGeneration") === session.sessionBindingGeneration
  );
}

export async function prepareProductionBrowserProfileRegistry(input: {
  paseoHome: string;
  nodeId: string;
  downloadBaseRoot: string;
  canonicalResolver?: BrowserProfileCanonicalResolver;
  createId?: () => string;
}): Promise<BrowserProfileRegistry> {
  const registry = new BrowserProfileRegistry({
    storage: new JsonFileBrowserProfileStorage(
      path.join(input.paseoHome, "enterprise", "browser", "browser-profiles.json"),
    ),
    canonicalResolver:
      input.canonicalResolver ??
      createNodeBrowserProfileCanonicalResolver({
        nodeId: input.nodeId,
        downloadBaseRoot: input.downloadBaseRoot,
      }),
    createProfileId: input.createId ?? (() => `brp_${randomBytes(8).toString("hex")}`),
  });
  await registry.initialize();
  return registry;
}

export interface ProductionBrowserLeaseBundle {
  readonly profiles: BrowserProfileRegistry;
  readonly bindings: BrowserProfileBindingRegistry;
  readonly leases: BrowserProfileLeaseManager;
  readonly close: () => Promise<void>;
  readonly invalidateHost: (hostClientId: string) => Promise<void>;
  readonly invalidateSession: (generation: string) => Promise<void>;
  readonly bindSessionAuthority: (input: {
    generation: string;
    isCurrentHandle: (handle: EnterpriseAgentContextHandle) => boolean;
    resolveAuthorization: (
      handle: EnterpriseAgentContextHandle,
      profileId: string,
    ) => BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
    waitingContext?: ProductionBrowserLeaseWaitingContext;
  }) => () => void;
  readonly runtimeForSession: (generation: string) => ProductionBrowserLeaseRuntime;
  readonly browserToolsRuntime: ProductionBrowserToolsRuntime;
  /** W4 seams; root computes both flags from the actual manifests and complete W1/W2/Desktop chain. */
  readonly pageIdentity: BrowserPageIdentityRegistry;
  readonly pageIdentityVerifier: BrowserPageIdentityVerifier;
  readonly pageIdentityObservationRegistration: EnterpriseSessionDispatcherFactoryRegistration;
  readonly pageIdentityInvalidationRegistration: EnterpriseSessionDispatcherFactoryRegistration;
}

export interface ProductionBrowserToolsRuntime {
  readonly isCurrentHandle: (handle: EnterpriseAgentContextHandle) => boolean;
  readonly resolveAuthorization: (
    handle: EnterpriseAgentContextHandle,
  ) => BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
  readonly leases: BrowserProfileLeaseManager;
  readonly leaseTtlMs: number;
}

export interface ProductionBrowserLeaseRuntime {
  readonly isCurrentHandle: (handle: EnterpriseAgentContextHandle) => boolean;
  readonly resolveAuthorization: (
    handle: EnterpriseAgentContextHandle,
    profileId: string,
  ) => BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
  readonly leases: BrowserProfileLeaseManager;
  readonly leaseTtlMs: number;
}

interface SessionAuthority {
  readonly isCurrentHandle: (handle: EnterpriseAgentContextHandle) => boolean;
  readonly resolveAuthorization: (
    handle: EnterpriseAgentContextHandle,
    profileId: string,
  ) => BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
  readonly waitingContext?: ProductionBrowserLeaseWaitingContext;
}

/** Builds the non-memory W4 runtime at the canonical paseoHome paths. */
export function createProductionBrowserLeaseBundle(
  options: ProductionBrowserLeaseBundleOptions,
): ProductionBrowserLeaseBundle {
  const root = path.join(options.paseoHome, "enterprise");
  const browserRoot = path.join(root, "browser");
  const profiles =
    options.profiles ??
    new BrowserProfileRegistry({
      storage: new JsonFileBrowserProfileStorage(path.join(browserRoot, "browser-profiles.json")),
      canonicalResolver:
        options.canonicalResolver ??
        createNodeBrowserProfileCanonicalResolver({
          nodeId: options.nodeId,
          downloadBaseRoot: options.downloadBaseRoot,
        }),
      createProfileId: options.createId ?? (() => `brp_${randomBytes(8).toString("hex")}`),
    });
  const bindings = new BrowserProfileBindingRegistry({
    storage: new JsonFileBrowserProfileBindingStorage(
      path.join(browserRoot, "browser-profile-bindings.json"),
    ),
    profiles,
    quarantine: options.quarantine,
  });
  const pageIdentity = new BrowserPageIdentityRegistry({ profiles });
  const pageIdentityVerifier = createBrowserPageIdentityVerifier(pageIdentity);
  const pageIdentityObservationRegistration =
    createBrowserPageIdentityObservationDispatcherRegistration({ registry: pageIdentity });
  const pageIdentityInvalidationRegistration =
    createBrowserPageIdentityInvalidationDispatcherRegistration({ registry: pageIdentity });
  if (!pageIdentityObservationRegistration || !pageIdentityInvalidationRegistration) {
    throw new Error("Production Browser page identity registrations are unavailable.");
  }
  const authorities = new Map<string, SessionAuthority>();
  const current = (handle: EnterpriseAgentContextHandle): boolean =>
    [...authorities.values()].some((authority) => authority.isCurrentHandle(handle));
  const resolve = (handle: EnterpriseAgentContextHandle, profileId: string) => {
    for (const authority of authorities.values()) {
      if (authority.isCurrentHandle(handle))
        return authority.resolveAuthorization(handle, profileId);
    }
    throw new Error("No current browser authority for session.");
  };
  const legacyOnWaiting = options.onWaiting;
  const leases = new BrowserProfileLeaseManager({
    ...options,
    isCurrentHandle: current,
    resolveAuthorization: resolve,
    onWaitingWithContext: async (notice) => {
      const generation = notice.context.context.sessionBindingGeneration;
      const authority = authorities.get(generation);
      if (!authority || !authority.isCurrentHandle(notice.context)) {
        throw new Error("Browser lease waiting Session is stale.");
      }
      if (authority.waitingContext) {
        await notifyProductionBrowserLeaseWaitingContext(authority.waitingContext, notice);
      } else {
        await legacyOnWaiting?.(legacyWaitingNotice(notice));
      }
      if (authorities.get(generation) !== authority || !authority.isCurrentHandle(notice.context)) {
        throw new Error("Browser lease waiting Session changed during notification.");
      }
    },
    generationStorage: new JsonFileBrowserProfileLeaseGenerationStorage(
      path.join(browserRoot, "lease-generation.json"),
    ),
    clock: options.clock,
  });
  let closed = false;
  const runtimeForSession = (generation: string): ProductionBrowserLeaseRuntime => ({
    isCurrentHandle: (handle) => {
      const authority = authorities.get(generation);
      return authority?.isCurrentHandle(handle) === true;
    },
    resolveAuthorization: (handle, profileId) => {
      const authority = authorities.get(generation);
      if (!authority || !authority.isCurrentHandle(handle))
        throw new Error("Browser session authority is stale.");
      return authority.resolveAuthorization(handle, profileId);
    },
    leases,
    leaseTtlMs: options.maxLeaseTtlMs,
  });
  const browserToolsRuntime: ProductionBrowserToolsRuntime = {
    isCurrentHandle: (handle) => {
      const generation = handle.context.sessionBindingGeneration;
      return runtimeForSession(generation).isCurrentHandle(handle);
    },
    resolveAuthorization: (handle) => {
      const generation = handle.context.sessionBindingGeneration;
      const authority = authorities.get(generation);
      if (!authority || !authority.isCurrentHandle(handle))
        throw new Error("Browser session authority is stale.");
      return authority.resolveAuthorization(handle, "");
    },
    leases,
    leaseTtlMs: options.maxLeaseTtlMs,
  };
  return {
    profiles,
    bindings,
    leases,
    pageIdentity,
    pageIdentityVerifier,
    pageIdentityObservationRegistration,
    pageIdentityInvalidationRegistration,
    invalidateHost: (hostClientId) => {
      pageIdentity.invalidateHost(hostClientId);
      return leases.invalidateHost(hostClientId);
    },
    invalidateSession: (generation) => {
      pageIdentity.invalidateSession(generation);
      return leases.invalidateSession(generation);
    },
    bindSessionAuthority: (input) => {
      if (
        input.waitingContext !== undefined &&
        (!isProductionBrowserLeaseWaitingContext(input.waitingContext) ||
          input.waitingContext.sessionBindingGeneration !== input.generation)
      ) {
        throw new Error("Browser lease waiting context does not match the Session generation.");
      }
      const authority: SessionAuthority = Object.freeze({
        isCurrentHandle: input.isCurrentHandle,
        resolveAuthorization: input.resolveAuthorization,
        waitingContext: input.waitingContext,
      });
      authorities.set(input.generation, authority);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        pageIdentity.invalidateSession(input.generation);
        if (authorities.get(input.generation) === authority) authorities.delete(input.generation);
      };
    },
    runtimeForSession,
    browserToolsRuntime,
    close: async () => {
      if (closed) return;
      closed = true;
      authorities.clear();
      pageIdentity.close();
      await leases.close();
    },
  };
}

async function notifyProductionBrowserLeaseWaitingContext(
  context: ProductionBrowserLeaseWaitingContext,
  notice: BrowserProfileLeaseContextualWaitingNotice,
): Promise<void> {
  const onWaiting = productionWaitingContexts.get(context);
  if (!onWaiting) throw new Error("Browser lease waiting context is unavailable.");
  await onWaiting(
    Object.freeze({
      ...legacyWaitingNotice(notice),
      context,
    }),
  );
}

function legacyWaitingNotice(
  notice: BrowserProfileLeaseWaitingNotice,
): BrowserProfileLeaseWaitingNotice {
  return {
    requestId: notice.requestId,
    agentId: notice.agentId,
    workspaceId: notice.workspaceId,
    resourceId: notice.resourceId,
    mode: notice.mode,
    position: notice.position,
  };
}
