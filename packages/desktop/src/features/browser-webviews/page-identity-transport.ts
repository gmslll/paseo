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
const controllerBrand = Symbol("BrowserPageIdentityTransportController");
const routes = new WeakSet<object>();
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
  close(): Promise<void>;
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
  retired: boolean;
  fatalTeardownPromise: Promise<void> | null;
}

export function installBrowserPageIdentityTransportRoutes(input: {
  readonly ipcMain: BrowserPageIdentityTransportIpcMain;
  readonly timeoutMs?: number;
  readonly maxRouteHistory?: number;
  readonly maxRequestsPerRoute?: number;
  readonly createId?: () => string;
}): BrowserPageIdentityTransportController {
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
  const issuedRouteTickets = new Set<string>();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const isCurrentRecord = (record: RouteRecord): boolean =>
    !closed &&
    !record.retired &&
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
  };

  const drainRecord = async (record: RouteRecord): Promise<void> => {
    while (record.active.size > 0) {
      await Promise.allSettled(record.active);
    }
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
      rejectPending(record, new Error("Browser page identity transport sender disconnected."));
      retireRecord(record);
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
      retired: false,
      fatalTeardownPromise: null,
    };
    sender.once("destroyed", destroyListener);
    return record;
  };

  const mountHandler: BrowserPageIdentityTransportIpcHandler = async (event, ...args) => {
    if (closed || args.length !== 0 || event.sender.isDestroyed()) {
      throw new Error("Browser page identity transport cannot be mounted.");
    }
    const previous = currentRoutes.get(event.sender);
    if (previous) {
      sealRecord(previous);
      await drainRecord(previous);
      retireRecord(previous);
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
    return RouteTicketSchema.parse({ version: 1, routeId, routeGeneration });
  };

  const disposeHandler: BrowserPageIdentityTransportIpcHandler = async (event, ...args) => {
    if (args.length !== 1) throw new Error("Invalid Browser page identity route disposal.");
    const ticket = RouteTicketSchema.parse(args[0]);
    const record = currentRoutes.get(event.sender);
    if (
      !record ||
      record.routeId !== ticket.routeId ||
      record.routeGeneration !== ticket.routeGeneration
    ) {
      return;
    }
    sealRecord(record);
    await drainRecord(record);
    retireRecord(record);
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
    close: () => {
      if (!closePromise) {
        closed = true;
        input.ipcMain.removeHandler(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL);
        input.ipcMain.removeHandler(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL);
        input.ipcMain.removeListener(
          BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL,
          responseListener,
        );
        closePromise = (async () => {
          const error = new Error("Browser page identity transport controller closed.");
          for (const record of liveRoutes) rejectPending(record, error);
          await Promise.all([...liveRoutes].map(drainRecord));
          for (const record of liveRoutes) retireRecord(record);
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
