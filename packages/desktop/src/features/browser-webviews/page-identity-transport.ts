import { randomUUID } from "node:crypto";
import {
  EnterpriseBrowserPageIdentityInvalidationRequestSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  createBrowserPageIdentityAuthorityTeardownPort,
  type BrowserPageIdentityAuthorityTeardownPort,
  type BrowserPageIdentityInvalidationPayload,
  type BrowserPageIdentityObservationPayload,
} from "./page-identity-publisher.js";

export const BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL = "paseo:browser:page-identity:mount";
export const BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL =
  "paseo:browser:page-identity:dispose";
export const BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL =
  "paseo:browser:page-identity:request";
export const BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL =
  "paseo:browser:page-identity:response";

const routeBrand = Symbol("BrowserPageIdentityTransportRoute");
const routeLifecycleBrand = Symbol("BrowserPageIdentityTransportRouteLifecyclePort");
const controllerBrand = Symbol("BrowserPageIdentityTransportController");
const routes = new WeakSet<object>();
const routeLifecyclePorts = new WeakSet<object>();
const controllers = new WeakSet<object>();

const ObservationPayloadSchema = EnterpriseBrowserPageIdentityObservationRequestSchema.omit({
  type: true,
  requestId: true,
});
const InvalidationPayloadSchema = EnterpriseBrowserPageIdentityInvalidationRequestSchema.omit({
  type: true,
  requestId: true,
});
const RouteTicketSchema = z.strictObject({
  version: z.literal(1),
  routeId: z.string().min(1),
  routeGeneration: z.string().min(1),
});
const FailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "daemon_unavailable",
    "daemon_request_failed",
    "daemon_response_mismatch",
    "handler_sealed",
    "teardown_failed",
  ]),
});
const RevisionSuccessSchema = z.strictObject({
  ok: z.literal(true),
  acceptedRevision: z.string().min(1),
});
const TeardownSuccessSchema = z.strictObject({ ok: z.literal(true) });
const TransportResponseSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    version: z.literal(1),
    routeId: z.string().min(1),
    routeGeneration: z.string().min(1),
    requestId: z.string().min(1),
    operation: z.literal("observe"),
    result: z.union([RevisionSuccessSchema, FailureSchema]),
  }),
  z.strictObject({
    version: z.literal(1),
    routeId: z.string().min(1),
    routeGeneration: z.string().min(1),
    requestId: z.string().min(1),
    operation: z.literal("invalidate"),
    result: z.union([RevisionSuccessSchema, FailureSchema]),
  }),
  z.strictObject({
    version: z.literal(1),
    routeId: z.string().min(1),
    routeGeneration: z.string().min(1),
    requestId: z.string().min(1),
    operation: z.literal("fatal_teardown"),
    result: z.union([TeardownSuccessSchema, FailureSchema]),
  }),
]);

type TransportOperation = "observe" | "invalidate" | "fatal_teardown";
type TransportResponse = z.infer<typeof TransportResponseSchema>;

export interface BrowserPageIdentityTransportSender {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

export interface BrowserPageIdentityTransportIpcMainEvent {
  readonly sender: BrowserPageIdentityTransportSender;
}

type BrowserPageIdentityTransportIpcHandler = (
  event: BrowserPageIdentityTransportIpcMainEvent,
  ...args: unknown[]
) => unknown;

export interface BrowserPageIdentityTransportIpcMain {
  handle(channel: string, handler: BrowserPageIdentityTransportIpcHandler): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: BrowserPageIdentityTransportIpcHandler): void;
  removeListener(channel: string, listener: BrowserPageIdentityTransportIpcHandler): void;
}

export interface BrowserPageIdentityTransportRoute {
  readonly [routeBrand]: true;
  readonly hostWebContentsId: number;
  observe(payload: BrowserPageIdentityObservationPayload): Promise<void>;
  invalidate(payload: BrowserPageIdentityInvalidationPayload): Promise<void>;
  seal(): void;
  drain(): Promise<void>;
  fatalTeardown(): Promise<void>;
  isCurrent(): boolean;
}

export interface BrowserPageIdentityTransportController {
  readonly [controllerBrand]: true;
  getRoute(sender: BrowserPageIdentityTransportSender): BrowserPageIdentityTransportRoute | null;
  retireRoute(sender: BrowserPageIdentityTransportSender): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserPageIdentityTransportRouteLifecyclePort {
  readonly [routeLifecycleBrand]: true;
  mounted(route: BrowserPageIdentityTransportRoute): Promise<void> | void;
  retiring(route: BrowserPageIdentityTransportRoute): Promise<void> | void;
  retired(route: BrowserPageIdentityTransportRoute): void;
}

export interface BrowserPageIdentityTransportPublisherPorts {
  readonly publish: (payload: BrowserPageIdentityObservationPayload) => Promise<void>;
  readonly invalidate: (payload: BrowserPageIdentityInvalidationPayload) => Promise<void>;
  readonly authorityTeardown: BrowserPageIdentityAuthorityTeardownPort;
}

interface PendingRequest {
  readonly operation: TransportOperation;
  readonly resolve: (response: TransportResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface RouteRecord {
  readonly sender: BrowserPageIdentityTransportSender;
  readonly routeId: string;
  readonly routeGeneration: string;
  readonly destroyListener: () => void;
  readonly issuedRequestIds: Set<string>;
  readonly pending: Map<string, PendingRequest>;
  readonly active: Set<Promise<unknown>>;
  readonly route: BrowserPageIdentityTransportRoute;
  accepting: boolean;
  retiring: boolean;
  retired: boolean;
  retirementPromise: Promise<void> | null;
  fatalTeardownPromise: Promise<void> | null;
}

export function createBrowserPageIdentityTransportRouteLifecyclePort(input: {
  readonly mounted: (route: BrowserPageIdentityTransportRoute) => Promise<void> | void;
  readonly retiring: (route: BrowserPageIdentityTransportRoute) => Promise<void> | void;
  readonly retired: (route: BrowserPageIdentityTransportRoute) => void;
}): BrowserPageIdentityTransportRouteLifecyclePort {
  const record = readExactStableRecord(
    input,
    ["mounted", "retired", "retiring"],
    "Browser page identity transport route lifecycle port",
  );
  if (
    typeof record.mounted !== "function" ||
    typeof record.retiring !== "function" ||
    typeof record.retired !== "function"
  ) {
    throw new Error("Invalid Browser page identity transport route lifecycle port.");
  }
  const mounted = record.mounted as BrowserPageIdentityTransportRouteLifecyclePort["mounted"];
  const retiring = record.retiring as BrowserPageIdentityTransportRouteLifecyclePort["retiring"];
  const retired = record.retired as BrowserPageIdentityTransportRouteLifecyclePort["retired"];
  const port = Object.freeze({
    [routeLifecycleBrand]: true as const,
    mounted: (route: BrowserPageIdentityTransportRoute) =>
      Reflect.apply(mounted, undefined, [route]),
    retiring: (route: BrowserPageIdentityTransportRoute) =>
      Reflect.apply(retiring, undefined, [route]),
    retired: (route: BrowserPageIdentityTransportRoute) =>
      Reflect.apply(retired, undefined, [route]),
  });
  routeLifecyclePorts.add(port);
  return port;
}

export function installBrowserPageIdentityTransportRoutes(input: {
  readonly ipcMain: BrowserPageIdentityTransportIpcMain;
  readonly routeLifecycle: BrowserPageIdentityTransportRouteLifecyclePort;
  readonly timeoutMs?: number;
  readonly maxRouteHistory?: number;
  readonly maxRequestsPerRoute?: number;
  readonly createId?: () => string;
}): BrowserPageIdentityTransportController {
  if (
    typeof input.routeLifecycle !== "object" ||
    input.routeLifecycle === null ||
    !routeLifecyclePorts.has(input.routeLifecycle)
  ) {
    throw new Error("Invalid Browser page identity transport route lifecycle port.");
  }
  const routeLifecycle = input.routeLifecycle;
  const timeoutMs = readBoundedInteger(input.timeoutMs ?? 5_000, 1, 30_000, "transport timeout");
  const maxRouteHistory = readBoundedInteger(
    input.maxRouteHistory ?? 4_096,
    1,
    65_536,
    "route history limit",
  );
  const maxRequestsPerRoute = readBoundedInteger(
    input.maxRequestsPerRoute ?? 4_096,
    1,
    65_536,
    "request history limit",
  );
  const createId = input.createId ?? randomUUID;
  if (typeof createId !== "function") throw new Error("Invalid Browser page identity ID factory.");

  const currentRoutes = new WeakMap<BrowserPageIdentityTransportSender, RouteRecord>();
  const liveRoutes = new Set<RouteRecord>();
  const routeMutationQueues = new WeakMap<BrowserPageIdentityTransportSender, Promise<void>>();
  const activeRouteMutations = new Set<Promise<void>>();
  const latestMountRequests = new WeakMap<BrowserPageIdentityTransportSender, object>();
  const issuedRouteTickets = new Set<string>();
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const isCurrentRecord = (record: RouteRecord): boolean =>
    !closed &&
    !closing &&
    !record.retired &&
    !record.retiring &&
    record.accepting &&
    !record.sender.isDestroyed() &&
    currentRoutes.get(record.sender) === record;

  const sealRecord = (record: RouteRecord): void => {
    record.accepting = false;
  };

  const rejectPending = (record: RouteRecord, error: Error): void => {
    sealRecord(record);
    for (const [requestId, pending] of record.pending) {
      record.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  };

  const retireRecord = (record: RouteRecord): void => {
    if (record.retired) return;
    record.retired = true;
    record.accepting = false;
    if (currentRoutes.get(record.sender) === record) currentRoutes.delete(record.sender);
    liveRoutes.delete(record);
    record.sender.removeListener("destroyed", record.destroyListener);
    routeLifecycle.retired(record.route);
  };

  const drainRecord = async (record: RouteRecord): Promise<void> => {
    while (record.active.size > 0) {
      await Promise.allSettled(record.active);
    }
  };

  const retireRecordAfterBarrier = (
    record: RouteRecord,
    disconnectedError?: Error,
  ): Promise<void> => {
    if (record.retirementPromise) return record.retirementPromise;
    if (record.retired) return Promise.resolve();
    record.retiring = true;
    let lifecycleRetirement: Promise<void>;
    try {
      lifecycleRetirement = Promise.resolve(routeLifecycle.retiring(record.route));
    } catch (error) {
      lifecycleRetirement = Promise.reject(error);
    }
    if (disconnectedError) rejectPending(record, disconnectedError);
    record.retirementPromise = (async () => {
      let lifecycleError: unknown;
      try {
        await lifecycleRetirement;
      } catch (error) {
        lifecycleError = error;
      }
      sealRecord(record);
      await drainRecord(record);
      retireRecord(record);
      if (lifecycleError) throw lifecycleError;
    })();
    return record.retirementPromise;
  };

  const enqueueRouteMutation = <T>(
    sender: BrowserPageIdentityTransportSender,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = routeMutationQueues.get(sender);
    let result: Promise<T>;
    if (previous) {
      result = previous.then(operation);
    } else {
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    }
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    routeMutationQueues.set(sender, settled);
    activeRouteMutations.add(settled);
    void settled.then(() => {
      activeRouteMutations.delete(settled);
      if (routeMutationQueues.get(sender) === settled) routeMutationQueues.delete(sender);
      return undefined;
    });
    return result;
  };

  const nextUniqueId = (label: string, used: ReadonlySet<string>): string => {
    const id = createId();
    if (typeof id !== "string" || id.length === 0 || id.trim() !== id || used.has(id)) {
      throw new Error(`Invalid or reused Browser page identity ${label}.`);
    }
    return id;
  };

  const issueRequest = (
    record: RouteRecord,
    operation: TransportOperation,
    payload?: BrowserPageIdentityObservationPayload | BrowserPageIdentityInvalidationPayload,
    allowSealed = false,
  ): Promise<TransportResponse> => {
    if (
      closed ||
      record.retired ||
      record.sender.isDestroyed() ||
      currentRoutes.get(record.sender) !== record ||
      (!allowSealed && !record.accepting)
    ) {
      return Promise.reject(new Error("Browser page identity transport route is sealed."));
    }
    if (record.issuedRequestIds.size >= maxRequestsPerRoute) {
      sealRecord(record);
      return Promise.reject(new Error("Browser page identity request history is exhausted."));
    }
    let requestId: string;
    try {
      requestId = nextUniqueId("request ID", record.issuedRequestIds);
    } catch (error) {
      sealRecord(record);
      return Promise.reject(toError(error));
    }
    record.issuedRequestIds.add(requestId);

    const responsePromise = new Promise<TransportResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = record.pending.get(requestId);
        if (!pending) return;
        record.pending.delete(requestId);
        sealRecord(record);
        reject(new Error("Browser page identity transport request timed out."));
      }, timeoutMs);
      record.pending.set(requestId, { operation, resolve, reject, timeout });
      try {
        record.sender.send(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL, {
          version: 1,
          routeId: record.routeId,
          routeGeneration: record.routeGeneration,
          requestId,
          operation,
          ...(payload ? { payload } : {}),
        });
      } catch (error) {
        record.pending.delete(requestId);
        clearTimeout(timeout);
        sealRecord(record);
        reject(toError(error));
      }
    });
    record.active.add(responsePromise);
    void responsePromise.then(
      () => record.active.delete(responsePromise),
      () => record.active.delete(responsePromise),
    );
    return responsePromise;
  };

  const requireRevisionResponse = async (
    record: RouteRecord,
    operation: "observe" | "invalidate",
    expectedRevision: string,
    payload: BrowserPageIdentityObservationPayload | BrowserPageIdentityInvalidationPayload,
  ): Promise<void> => {
    try {
      const response = await issueRequest(record, operation, payload);
      if (
        response.operation !== operation ||
        !response.result.ok ||
        response.result.acceptedRevision !== expectedRevision
      ) {
        throw new Error("Browser page identity transport rejected the revision.");
      }
    } catch (error) {
      sealRecord(record);
      throw error;
    }
  };

  const createRoute = (
    sender: BrowserPageIdentityTransportSender,
    routeId: string,
    routeGeneration: string,
  ): RouteRecord => {
    let record!: RouteRecord;
    const destroyListener = (): void => {
      void retireRecordAfterBarrier(
        record,
        new Error("Browser page identity transport sender disconnected."),
      ).catch(() => {});
    };
    const route: BrowserPageIdentityTransportRoute = Object.freeze({
      [routeBrand]: true as const,
      hostWebContentsId: sender.id,
      observe: (payload: BrowserPageIdentityObservationPayload) => {
        const canonical = ObservationPayloadSchema.parse(payload);
        return requireRevisionResponse(record, "observe", canonical.observationRevision, canonical);
      },
      invalidate: (payload: BrowserPageIdentityInvalidationPayload) => {
        const canonical = InvalidationPayloadSchema.parse(payload);
        return requireRevisionResponse(
          record,
          "invalidate",
          canonical.observationRevision,
          canonical,
        );
      },
      seal: () => sealRecord(record),
      drain: () => drainRecord(record),
      fatalTeardown: () => {
        if (!record.fatalTeardownPromise) {
          sealRecord(record);
          record.fatalTeardownPromise = (async () => {
            await drainRecord(record);
            try {
              const response = await issueRequest(record, "fatal_teardown", undefined, true);
              if (response.operation !== "fatal_teardown" || !response.result.ok) {
                throw new Error("Browser page identity authority teardown was rejected.");
              }
            } finally {
              retireRecord(record);
            }
          })();
        }
        return record.fatalTeardownPromise;
      },
      isCurrent: () => isCurrentRecord(record),
    });
    routes.add(route);
    record = {
      sender,
      routeId,
      routeGeneration,
      destroyListener,
      issuedRequestIds: new Set(),
      pending: new Map(),
      active: new Set(),
      route,
      accepting: true,
      retiring: false,
      retired: false,
      retirementPromise: null,
      fatalTeardownPromise: null,
    };
    sender.once("destroyed", destroyListener);
    return record;
  };

  const mountHandler: BrowserPageIdentityTransportIpcHandler = async (event, ...args) => {
    if (closing || closed || args.length !== 0 || event.sender.isDestroyed()) {
      throw new Error("Browser page identity transport cannot be mounted.");
    }
    const mountRequest = Object.freeze({});
    latestMountRequests.set(event.sender, mountRequest);
    const result = enqueueRouteMutation(event.sender, async () => {
      const previous = currentRoutes.get(event.sender);
      if (previous) await retireRecordAfterBarrier(previous);
      if (
        latestMountRequests.get(event.sender) !== mountRequest ||
        closing ||
        closed ||
        event.sender.isDestroyed()
      ) {
        throw new Error("Browser page identity transport mount was superseded.");
      }
      if (issuedRouteTickets.size >= maxRouteHistory) {
        throw new Error("Browser page identity route history is exhausted.");
      }
      const routeId = nextUniqueId("route ID", new Set());
      const routeGeneration = nextUniqueId("route generation", new Set([routeId]));
      const ticketKey = `${routeId}\u0000${routeGeneration}`;
      if (issuedRouteTickets.has(ticketKey)) {
        throw new Error("Browser page identity route ticket was reused.");
      }
      issuedRouteTickets.add(ticketKey);
      const record = createRoute(event.sender, routeId, routeGeneration);
      currentRoutes.set(event.sender, record);
      liveRoutes.add(record);
      try {
        await routeLifecycle.mounted(record.route);
        if (
          latestMountRequests.get(event.sender) !== mountRequest ||
          closing ||
          closed ||
          event.sender.isDestroyed()
        ) {
          throw new Error("Browser page identity transport mount was superseded.");
        }
      } catch (error) {
        await retireRecordAfterBarrier(record);
        throw error;
      }
      return RouteTicketSchema.parse({ version: 1, routeId, routeGeneration });
    });
    return result.finally(() => {
      if (latestMountRequests.get(event.sender) === mountRequest) {
        latestMountRequests.delete(event.sender);
      }
    });
  };

  const disposeHandler: BrowserPageIdentityTransportIpcHandler = async (event, ...args) => {
    if (args.length !== 1) throw new Error("Invalid Browser page identity route disposal.");
    const ticket = RouteTicketSchema.parse(args[0]);
    await enqueueRouteMutation(event.sender, async () => {
      const record = currentRoutes.get(event.sender);
      if (
        !record ||
        record.routeId !== ticket.routeId ||
        record.routeGeneration !== ticket.routeGeneration
      ) {
        return;
      }
      await retireRecordAfterBarrier(record);
    });
  };

  const responseListener: BrowserPageIdentityTransportIpcHandler = (event, ...args) => {
    if (args.length !== 1) return;
    const parsed = TransportResponseSchema.safeParse(args[0]);
    if (!parsed.success) return;
    const response = parsed.data;
    const record = currentRoutes.get(event.sender);
    if (
      !record ||
      record.routeId !== response.routeId ||
      record.routeGeneration !== response.routeGeneration
    ) {
      return;
    }
    const pending = record.pending.get(response.requestId);
    if (!pending || pending.operation !== response.operation) return;
    record.pending.delete(response.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(response);
  };

  input.ipcMain.handle(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, mountHandler);
  input.ipcMain.handle(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL, disposeHandler);
  input.ipcMain.on(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, responseListener);

  const controller: BrowserPageIdentityTransportController = Object.freeze({
    [controllerBrand]: true as const,
    getRoute: (sender: BrowserPageIdentityTransportSender) => {
      const record = currentRoutes.get(sender);
      return record && isCurrentRecord(record) ? record.route : null;
    },
    retireRoute: (sender: BrowserPageIdentityTransportSender) =>
      enqueueRouteMutation(sender, async () => {
        const record = currentRoutes.get(sender);
        if (record) await retireRecordAfterBarrier(record);
      }),
    close: () => {
      if (!closePromise) {
        closing = true;
        input.ipcMain.removeHandler(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL);
        input.ipcMain.removeHandler(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL);
        closePromise = (async () => {
          while (activeRouteMutations.size > 0) {
            await Promise.allSettled(activeRouteMutations);
          }
          await Promise.all([...liveRoutes].map((record) => retireRecordAfterBarrier(record)));
          input.ipcMain.removeListener(
            BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL,
            responseListener,
          );
          closed = true;
        })();
      }
      return closePromise;
    },
  });
  controllers.add(controller);
  return controller;
}

export function createBrowserPageIdentityTransportPublisherPorts(
  route: BrowserPageIdentityTransportRoute,
): BrowserPageIdentityTransportPublisherPorts {
  if (typeof route !== "object" || route === null || !routes.has(route) || !route.isCurrent()) {
    throw new Error("Browser page identity transport route is unavailable.");
  }
  return Object.freeze({
    publish: (payload: BrowserPageIdentityObservationPayload) => route.observe(payload),
    invalidate: (payload: BrowserPageIdentityInvalidationPayload) => route.invalidate(payload),
    authorityTeardown: createBrowserPageIdentityAuthorityTeardownPort({
      teardownAfterAuthorityTransportFailure: () => route.fatalTeardown(),
    }),
  });
}

function readBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid Browser page identity ${label}.`);
  }
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readExactStableRecord(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
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
    keys.length !== allowedKeys.length
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}
