import path from "node:path";
import { randomUUID } from "node:crypto";
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
  type BrowserProfileLeaseGenerationStorage,
  type BrowserProfileLeaseManagerOptions,
} from "./lease-manager.js";
import { readSecureJsonFile, writeSecureJsonFile } from "./secure-json-file.js";
import type { EnterpriseAgentContextHandle } from "../../session/enterprise-agent-session-context-registry.js";
import type { BrowserProfileLeaseAuthorization } from "./lease-manager.js";

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
  "generationStorage" | "clock" | "isCurrentHandle" | "resolveAuthorization"
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
    createProfileId: input.createId ?? (() => `brp_${randomUUID().replaceAll("-", "")}`),
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
  }) => () => void;
  readonly runtimeForSession: (generation: string) => ProductionBrowserLeaseRuntime;
  readonly browserToolsRuntime: ProductionBrowserToolsRuntime;
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
      createProfileId: options.createId ?? (() => `brp_${randomUUID().replaceAll("-", "")}`),
    });
  const bindings = new BrowserProfileBindingRegistry({
    storage: new JsonFileBrowserProfileBindingStorage(
      path.join(browserRoot, "browser-profile-bindings.json"),
    ),
    profiles,
    quarantine: options.quarantine,
  });
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
  const leases = new BrowserProfileLeaseManager({
    ...options,
    isCurrentHandle: current,
    resolveAuthorization: resolve,
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
    invalidateHost: (hostClientId) => leases.invalidateHost(hostClientId),
    invalidateSession: (generation) => leases.invalidateSession(generation),
    bindSessionAuthority: (input) => {
      authorities.set(input.generation, input);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (authorities.get(input.generation) === input) authorities.delete(input.generation);
      };
    },
    runtimeForSession,
    browserToolsRuntime,
    close: async () => {
      if (closed) return;
      closed = true;
      authorities.clear();
      await leases.close();
    },
  };
}
