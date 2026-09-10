import {
  createBrowserPageIdentityPublisher,
  type BrowserPageAccountLabelHashReader,
  type BrowserPageIdentityExecutionHandle,
  type BrowserPageIdentityPublisher,
  type BrowserPageIdentityWebContents,
} from "./page-identity-publisher.js";
import {
  createBrowserPageIdentityTransportPublisherPorts,
  createBrowserPageIdentityTransportRouteLifecyclePort,
  type BrowserPageIdentityTransportRoute,
  type BrowserPageIdentityTransportRouteLifecyclePort,
} from "./page-identity-transport.js";
import {
  isPaseoBrowserWebviewRegistry,
  type BrowserWebContentsRegistration,
  type PaseoBrowserWebviewRegistry,
} from "./registry.js";

const publisherRegistryBrand = Symbol("BrowserPageIdentityPublisherRegistry");
const publisherRegistries = new WeakSet<object>();

export interface BrowserPageIdentityPublisherRegistry {
  readonly [publisherRegistryBrand]: true;
  readonly routeLifecycle: BrowserPageIdentityTransportRouteLifecyclePort;
  track(contents: BrowserPageIdentityWebContents): void;
  publishCurrent(contents: BrowserPageIdentityWebContents): Promise<void>;
  invalidateWebContents(webContentsId: number): Promise<void>;
  invalidateBrowser(browserId: string): Promise<void>;
  invalidateHost(hostWebContentsId: number): Promise<void>;
  createExecutionHandle(webContentsId: number): BrowserPageIdentityExecutionHandle | null;
  assertExecutionCurrent(handle: BrowserPageIdentityExecutionHandle): void;
  isExecutionAllowed(webContentsId: number): boolean;
  close(): Promise<void>;
}

interface HostPublisherEntry {
  readonly hostWebContentsId: number;
  readonly route: BrowserPageIdentityTransportRoute;
  readonly publisher: BrowserPageIdentityPublisher;
}

interface ExecutionHandleOwner {
  readonly entry: HostPublisherEntry;
}

export function isBrowserPageIdentityPublisherRegistry(
  value: unknown,
): value is BrowserPageIdentityPublisherRegistry {
  return typeof value === "object" && value !== null && publisherRegistries.has(value);
}

/**
 * Routes Desktop-owned observations by the host ID from the trusted WebContents registration.
 * The host ID is never added to the renderer wire payload and the renderer never selects a route.
 */
export function createBrowserPageIdentityPublisherRegistry(input: {
  readonly registry: PaseoBrowserWebviewRegistry;
  readonly accountLabelHashReader?: BrowserPageAccountLabelHashReader;
  readonly createObservationRevision?: () => string;
  readonly onError?: (error: Error) => void;
}): BrowserPageIdentityPublisherRegistry {
  const record = readExactStableRecord(
    input,
    ["accountLabelHashReader", "createObservationRevision", "onError", "registry"],
    "Browser page identity publisher registry",
    true,
  );
  if (!isPaseoBrowserWebviewRegistry(record.registry)) {
    throw new Error("Invalid Browser WebContents registry.");
  }
  if (
    record.createObservationRevision !== undefined &&
    typeof record.createObservationRevision !== "function"
  ) {
    throw new Error("Invalid Browser observation revision factory.");
  }
  if (record.onError !== undefined && typeof record.onError !== "function") {
    throw new Error("Invalid Browser page identity error sink.");
  }
  const registry = record.registry as PaseoBrowserWebviewRegistry;
  const accountLabelHashReader = record.accountLabelHashReader as
    | BrowserPageAccountLabelHashReader
    | undefined;
  const createObservationRevision = record.createObservationRevision as (() => string) | undefined;
  const onError = record.onError as ((error: Error) => void) | undefined;
  const entriesByHost = new Map<number, HostPublisherEntry>();
  const ownersByWebContents = new Map<number, HostPublisherEntry>();
  const executionHandleOwners = new WeakMap<object, ExecutionHandleOwner>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const removeEntry = (entry: HostPublisherEntry): boolean => {
    if (entriesByHost.get(entry.hostWebContentsId) !== entry) return false;
    entriesByHost.delete(entry.hostWebContentsId);
    for (const [webContentsId, owner] of ownersByWebContents) {
      if (owner === entry) ownersByWebContents.delete(webContentsId);
    }
    return true;
  };

  const entryForRegistration = (
    registration: BrowserWebContentsRegistration,
  ): HostPublisherEntry | null => {
    const entry = entriesByHost.get(registration.hostWebContentsId);
    return entry?.route.isCurrent() === true ? entry : null;
  };

  const registrationForProfileContents = (
    webContentsId: number,
  ): BrowserWebContentsRegistration | null => {
    const registration = registry.getRegistrationForWebContents(webContentsId);
    return registration?.profileAuthorization ? registration : null;
  };

  const requireEntry = (registration: BrowserWebContentsRegistration): HostPublisherEntry => {
    const entry = entryForRegistration(registration);
    if (!entry) throw new Error("Browser page identity host route is unavailable.");
    return entry;
  };

  let publisherRegistry!: BrowserPageIdentityPublisherRegistry;
  const routeLifecycle = createBrowserPageIdentityTransportRouteLifecyclePort({
    mounted: (route) => {
      if (closed || entriesByHost.has(route.hostWebContentsId)) {
        throw new Error("Browser page identity host route cannot be mounted.");
      }
      const ports = createBrowserPageIdentityTransportPublisherPorts(route);
      const publisher = createBrowserPageIdentityPublisher({
        registry,
        publish: ports.publish,
        invalidate: ports.invalidate,
        authorityTeardown: ports.authorityTeardown,
        ...(accountLabelHashReader ? { accountLabelHashReader } : {}),
        ...(createObservationRevision ? { createObservationRevision } : {}),
        ...(onError ? { onError } : {}),
      });
      entriesByHost.set(route.hostWebContentsId, {
        hostWebContentsId: route.hostWebContentsId,
        route,
        publisher,
      });
    },
    retiring: async (route) => {
      const entry = entriesByHost.get(route.hostWebContentsId);
      if (!entry || entry.route !== route || !removeEntry(entry)) return;
      await entry.publisher.close();
    },
    retired: (route) => {
      const entry = entriesByHost.get(route.hostWebContentsId);
      if (!entry || entry.route !== route || !removeEntry(entry)) return;
      void entry.publisher.close();
    },
  });

  publisherRegistry = Object.freeze({
    [publisherRegistryBrand]: true as const,
    routeLifecycle,
    track: (contents: BrowserPageIdentityWebContents) => {
      if (closed || contents.isDestroyed()) return;
      const registration = registrationForProfileContents(contents.id);
      if (!registration) return;
      const entry = entryForRegistration(registration);
      if (!entry) return;
      ownersByWebContents.set(contents.id, entry);
      entry.publisher.track(contents);
    },
    publishCurrent: async (contents: BrowserPageIdentityWebContents) => {
      if (closed) throw new Error("Browser page identity publisher registry is closed.");
      const registration = registrationForProfileContents(contents.id);
      if (!registration) return;
      const entry = requireEntry(registration);
      ownersByWebContents.set(contents.id, entry);
      entry.publisher.track(contents);
      await entry.publisher.publishCurrent(contents);
      if (
        entriesByHost.get(entry.hostWebContentsId) !== entry ||
        !entry.route.isCurrent() ||
        !sameRegistration(registration, registry.getRegistrationForWebContents(contents.id))
      ) {
        throw new Error("Browser page identity host route changed during observation.");
      }
    },
    invalidateWebContents: async (webContentsId: number) => {
      const registration = registrationForProfileContents(webContentsId);
      const entry =
        ownersByWebContents.get(webContentsId) ??
        (registration ? entryForRegistration(registration) : null);
      ownersByWebContents.delete(webContentsId);
      if (entry) await entry.publisher.invalidateWebContents(webContentsId);
    },
    invalidateBrowser: async (browserId: string) => {
      await Promise.all(
        [...entriesByHost.values()].map((entry) => entry.publisher.invalidateBrowser(browserId)),
      );
      for (const [webContentsId] of ownersByWebContents) {
        if (registry.getRegistrationForWebContents(webContentsId)?.browserId === browserId) {
          ownersByWebContents.delete(webContentsId);
        }
      }
    },
    invalidateHost: async (hostWebContentsId: number) => {
      const entry = entriesByHost.get(hostWebContentsId);
      if (entry) await entry.publisher.invalidateHost(hostWebContentsId);
      for (const [webContentsId, owner] of ownersByWebContents) {
        if (owner.hostWebContentsId === hostWebContentsId) {
          ownersByWebContents.delete(webContentsId);
        }
      }
    },
    createExecutionHandle: (webContentsId: number) => {
      if (closed) return null;
      const registration = registrationForProfileContents(webContentsId);
      if (!registration) return null;
      const entry = entryForRegistration(registration);
      if (!entry || ownersByWebContents.get(webContentsId) !== entry) return null;
      const handle = entry.publisher.createExecutionHandle(webContentsId);
      if (handle) executionHandleOwners.set(handle, { entry });
      return handle;
    },
    assertExecutionCurrent: (handle: BrowserPageIdentityExecutionHandle) => {
      const owner =
        typeof handle === "object" && handle !== null
          ? executionHandleOwners.get(handle)
          : undefined;
      if (
        closed ||
        !owner ||
        entriesByHost.get(owner.entry.hostWebContentsId) !== owner.entry ||
        !owner.entry.route.isCurrent()
      ) {
        throw new Error("Browser page identity execution handle is no longer current.");
      }
      owner.entry.publisher.assertExecutionCurrent(handle);
    },
    isExecutionAllowed: (webContentsId: number) => {
      if (closed) return false;
      const registration = registrationForProfileContents(webContentsId);
      if (!registration) return false;
      const entry = entryForRegistration(registration);
      return (
        entry !== null &&
        ownersByWebContents.get(webContentsId) === entry &&
        entry.publisher.isExecutionAllowed(webContentsId)
      );
    },
    close: () => {
      if (!closePromise) {
        closed = true;
        const entries = [...entriesByHost.values()];
        entriesByHost.clear();
        ownersByWebContents.clear();
        closePromise = Promise.allSettled(entries.map((entry) => entry.publisher.close())).then(
          () => undefined,
        );
      }
      return closePromise;
    },
  });
  publisherRegistries.add(publisherRegistry);
  return publisherRegistry;
}

function sameRegistration(
  left: BrowserWebContentsRegistration,
  right: BrowserWebContentsRegistration | null,
): boolean {
  return right !== null && right.registrationRevision === left.registrationRevision;
}

function readExactStableRecord(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
  optional = false,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an invalid prototype.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    (!optional && keys.length !== allowedKeys.length)
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (optional) continue;
      throw new Error(`${label}.${key} is required.`);
    }
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}
