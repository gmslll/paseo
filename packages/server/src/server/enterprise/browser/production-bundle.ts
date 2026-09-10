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
  "generationStorage" | "clock"
> {
  paseoHome: string;
  nodeId: string;
  downloadBaseRoot: string;
  auditSink: AuditSink;
  clock: BrowserLeaseScheduler;
  canonicalResolver?: BrowserProfileCanonicalResolver;
  quarantine?: BrowserProfileBindingQuarantineSink;
  createId?: () => string;
}

export interface ProductionBrowserLeaseBundle {
  readonly profiles: BrowserProfileRegistry;
  readonly bindings: BrowserProfileBindingRegistry;
  readonly leases: BrowserProfileLeaseManager;
  readonly close: () => Promise<void>;
  readonly invalidateHost: (hostClientId: string) => Promise<void>;
  readonly invalidateSession: (generation: string) => Promise<void>;
}

/** Builds the non-memory W4 runtime at the canonical paseoHome paths. */
export function createProductionBrowserLeaseBundle(
  options: ProductionBrowserLeaseBundleOptions,
): ProductionBrowserLeaseBundle {
  const root = path.join(options.paseoHome, "enterprise");
  const browserRoot = path.join(root, "browser");
  const profiles = new BrowserProfileRegistry({
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
  const leases = new BrowserProfileLeaseManager({
    ...options,
    generationStorage: new JsonFileBrowserProfileLeaseGenerationStorage(
      path.join(browserRoot, "lease-generation.json"),
    ),
    clock: options.clock,
  });
  let closed = false;
  return {
    profiles,
    bindings,
    leases,
    invalidateHost: (hostClientId) => leases.invalidateHost(hostClientId),
    invalidateSession: (generation) => leases.invalidateSession(generation),
    close: async () => {
      if (closed) return;
      closed = true;
      await leases.close();
    },
  };
}
