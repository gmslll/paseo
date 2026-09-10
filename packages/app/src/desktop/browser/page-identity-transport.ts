import {
  EnterpriseBrowserPageIdentityInvalidationRequestSchema,
  EnterpriseBrowserPageIdentityInvalidationResponseSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
  EnterpriseBrowserPageIdentityObservationResponseSchema,
  type EnterpriseBrowserPageIdentityInvalidationRequest,
  type EnterpriseBrowserPageIdentityInvalidationResponse,
  type EnterpriseBrowserPageIdentityObservationRequest,
  type EnterpriseBrowserPageIdentityObservationResponse,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { getDesktopHost } from "@/desktop/host";

const rendererTransportBrand = Symbol("BrowserPageIdentityRendererTransportPort");
const daemonHandlerBrand = Symbol("BrowserPageIdentityDaemonClientHandler");
const rendererTransports = new WeakSet<object>();
const daemonHandlers = new WeakSet<object>();

const ObservationPayloadSchema = EnterpriseBrowserPageIdentityObservationRequestSchema.omit({
  type: true,
  requestId: true,
});
const InvalidationPayloadSchema = EnterpriseBrowserPageIdentityInvalidationRequestSchema.omit({
  type: true,
  requestId: true,
});
const RendererRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    requestId: z.string().min(1),
    operation: z.literal("observe"),
    payload: ObservationPayloadSchema,
  }),
  z.strictObject({
    requestId: z.string().min(1),
    operation: z.literal("invalidate"),
    payload: InvalidationPayloadSchema,
  }),
  z.strictObject({
    requestId: z.string().min(1),
    operation: z.literal("fatal_teardown"),
  }),
]);

export type BrowserPageIdentityRendererRequest = z.infer<typeof RendererRequestSchema>;
export type BrowserPageIdentityRendererFailureCode =
  | "daemon_unavailable"
  | "daemon_request_failed"
  | "daemon_response_mismatch"
  | "handler_sealed"
  | "teardown_failed";
export type BrowserPageIdentityRendererResponse =
  | {
      readonly requestId: string;
      readonly operation: "observe" | "invalidate";
      readonly result:
        | { readonly ok: true; readonly acceptedRevision: string }
        | { readonly ok: false; readonly code: BrowserPageIdentityRendererFailureCode };
    }
  | {
      readonly requestId: string;
      readonly operation: "fatal_teardown";
      readonly result:
        | { readonly ok: true }
        | { readonly ok: false; readonly code: BrowserPageIdentityRendererFailureCode };
    };

export interface BrowserPageIdentityRendererTransportPort {
  readonly [rendererTransportBrand]: true;
  mount(handler: (request: unknown) => void): Promise<void>;
  dispose(): Promise<void>;
  respond(response: BrowserPageIdentityRendererResponse): void;
}

export interface BrowserPageIdentityDaemonClientPort {
  getConnectionState(): { readonly status: string };
  getLastServerInfoMessage(): {
    readonly features?: {
      readonly enterpriseBrowserPageIdentityObservationV1?: boolean;
      readonly enterpriseBrowserPageIdentityInvalidationV1?: boolean;
    };
  } | null;
  observeBrowserPageIdentity(
    input: Omit<EnterpriseBrowserPageIdentityObservationRequest, "type" | "requestId"> & {
      readonly requestId?: string;
    },
  ): Promise<EnterpriseBrowserPageIdentityObservationResponse>;
  invalidateBrowserPageIdentity(
    input: Omit<EnterpriseBrowserPageIdentityInvalidationRequest, "type" | "requestId"> & {
      readonly requestId?: string;
    },
  ): Promise<EnterpriseBrowserPageIdentityInvalidationResponse>;
  subscribeConnectionStatus(listener: (state: { readonly status: string }) => void): () => void;
  close(): Promise<void>;
}

export interface BrowserPageIdentityDaemonClientHandler {
  readonly [daemonHandlerBrand]: true;
  ready(): Promise<void>;
  seal(): void;
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

export function createBrowserPageIdentityRendererTransportPort(
  rawPort: unknown,
): BrowserPageIdentityRendererTransportPort {
  const record = readExactStableRecord(
    rawPort,
    ["dispose", "mount", "respond"],
    "Browser page identity renderer transport",
  );
  if (
    typeof record.mount !== "function" ||
    typeof record.dispose !== "function" ||
    typeof record.respond !== "function"
  ) {
    throw new Error("Invalid Browser page identity renderer transport methods.");
  }
  const mount = record.mount;
  const dispose = record.dispose;
  const respond = record.respond;
  const port: BrowserPageIdentityRendererTransportPort = Object.freeze({
    [rendererTransportBrand]: true as const,
    mount: (handler: (request: unknown) => void) =>
      Promise.resolve(Reflect.apply(mount, rawPort, [handler])),
    dispose: () => Promise.resolve(Reflect.apply(dispose, rawPort, [])),
    respond: (response: BrowserPageIdentityRendererResponse) => {
      Reflect.apply(respond, rawPort, [response]);
    },
  });
  rendererTransports.add(port);
  return port;
}

export function mountBrowserPageIdentityDaemonClientHandler(input: {
  readonly client: BrowserPageIdentityDaemonClientPort;
  readonly bridge?: BrowserPageIdentityRendererTransportPort;
  readonly maxRequestHistory?: number;
}): BrowserPageIdentityDaemonClientHandler {
  const bridge = input.bridge ?? resolveDesktopRendererTransport();
  if (!bridge || !rendererTransports.has(bridge)) {
    throw new Error("Browser page identity renderer transport is unavailable.");
  }
  const client = input.client;
  assertDaemonClientPort(client);
  if (!hasPageIdentityCapabilities(client)) {
    throw new Error("Browser page identity daemon capabilities are unavailable.");
  }
  if (client.getConnectionState().status !== "connected") {
    throw new Error("Browser page identity daemon connection is unavailable.");
  }
  const maxRequestHistory = readBoundedInteger(
    input.maxRequestHistory ?? 4_096,
    1,
    65_536,
    "request history limit",
  );

  let sealed = false;
  let mounted = false;
  let unsubscribeConnection: (() => void) | null = null;
  let closePromise: Promise<void> | null = null;
  let disposePromise: Promise<void> | null = null;
  let disconnectPromise: Promise<void> | null = null;
  let fatalRequested = false;
  const seenRequestIds = new Set<string>();
  const dataOperations = new Set<Promise<void>>();
  const controlOperations = new Set<Promise<void>>();

  const seal = (): void => {
    sealed = true;
  };
  const drainSet = async (operations: Set<Promise<void>>): Promise<void> => {
    while (operations.size > 0) await Promise.allSettled(operations);
  };
  const closeExactClient = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => client.close());
    return closePromise;
  };
  const respond = (response: BrowserPageIdentityRendererResponse): void => {
    try {
      bridge.respond(response);
    } catch {
      seal();
      void closeExactClient().catch(() => undefined);
    }
  };
  const failure = (
    request: BrowserPageIdentityRendererRequest,
    code: BrowserPageIdentityRendererFailureCode,
  ): BrowserPageIdentityRendererResponse => ({
    requestId: request.requestId,
    operation: request.operation,
    result: { ok: false, code },
  });
  const track = (operations: Set<Promise<void>>, operation: Promise<void>): void => {
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
  };
  const current = (): boolean =>
    !sealed &&
    client.getConnectionState().status === "connected" &&
    hasPageIdentityCapabilities(client);

  const handleRevisionRequest = (
    request: Extract<BrowserPageIdentityRendererRequest, { operation: "observe" | "invalidate" }>,
  ): void => {
    if (!current()) {
      respond(failure(request, sealed ? "handler_sealed" : "daemon_unavailable"));
      return;
    }
    const operation = (async (): Promise<void> => {
      let rawResponse: unknown;
      try {
        rawResponse =
          request.operation === "observe"
            ? await client.observeBrowserPageIdentity({
                ...request.payload,
                requestId: request.requestId,
              })
            : await client.invalidateBrowserPageIdentity({
                ...request.payload,
                requestId: request.requestId,
              });
      } catch {
        respond(failure(request, "daemon_request_failed"));
        return;
      }
      if (!current()) {
        respond(failure(request, sealed ? "handler_sealed" : "daemon_unavailable"));
        return;
      }
      const response =
        request.operation === "observe"
          ? EnterpriseBrowserPageIdentityObservationResponseSchema.safeParse(rawResponse)
          : EnterpriseBrowserPageIdentityInvalidationResponseSchema.safeParse(rawResponse);
      if (
        !response.success ||
        response.data.payload.requestId !== request.requestId ||
        response.data.payload.acceptedRevision !== request.payload.observationRevision
      ) {
        respond(failure(request, "daemon_response_mismatch"));
        return;
      }
      respond({
        requestId: request.requestId,
        operation: request.operation,
        result: {
          ok: true,
          acceptedRevision: response.data.payload.acceptedRevision,
        },
      });
    })();
    track(dataOperations, operation);
  };

  const handleFatalTeardown = (
    request: Extract<BrowserPageIdentityRendererRequest, { operation: "fatal_teardown" }>,
  ): void => {
    fatalRequested = true;
    seal();
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    const operation = (async (): Promise<void> => {
      try {
        await closeExactClient();
        await drainSet(dataOperations);
      } catch {
        respond(failure(request, "teardown_failed"));
        return;
      }
      respond({
        requestId: request.requestId,
        operation: "fatal_teardown",
        result: { ok: true },
      });
    })();
    track(controlOperations, operation);
  };

  const handleRequest = (rawRequest: unknown): void => {
    const parsed = RendererRequestSchema.safeParse(rawRequest);
    if (!parsed.success) return;
    const request = parsed.data;
    if (seenRequestIds.has(request.requestId) || seenRequestIds.size >= maxRequestHistory) {
      seal();
      respond(failure(request, "handler_sealed"));
      return;
    }
    seenRequestIds.add(request.requestId);
    if (request.operation === "fatal_teardown") {
      handleFatalTeardown(request);
      return;
    }
    handleRevisionRequest(request);
  };

  const closeAfterDisconnect = (): void => {
    if (disconnectPromise || fatalRequested) return;
    seal();
    unsubscribeConnection?.();
    unsubscribeConnection = null;
    disconnectPromise = (async () => {
      await closeExactClient().catch(() => undefined);
      await drainSet(dataOperations);
      if (mounted) {
        await bridge.dispose().catch(() => undefined);
        mounted = false;
      }
    })();
    track(controlOperations, disconnectPromise);
  };

  const readyPromise = bridge.mount(handleRequest).then(async () => {
    mounted = true;
    if (sealed) {
      await bridge.dispose().catch(() => undefined);
      mounted = false;
      return undefined;
    }
    if (
      !hasPageIdentityCapabilities(client) ||
      client.getConnectionState().status !== "connected"
    ) {
      seal();
      await closeExactClient().catch(() => undefined);
      await bridge.dispose().catch(() => undefined);
      mounted = false;
      throw new Error("Browser page identity daemon connection changed during mount.");
    }
    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status !== "connected") closeAfterDisconnect();
    });
    unsubscribeConnection = unsubscribe;
    if (sealed) {
      unsubscribeConnection();
      unsubscribeConnection = null;
    }
    return undefined;
  });
  void readyPromise.catch(() => undefined);

  const handler: BrowserPageIdentityDaemonClientHandler = Object.freeze({
    [daemonHandlerBrand]: true as const,
    ready: () => readyPromise,
    seal,
    drain: async () => {
      await readyPromise.catch(() => undefined);
      await drainSet(dataOperations);
      await drainSet(controlOperations);
    },
    dispose: () => {
      seal();
      unsubscribeConnection?.();
      unsubscribeConnection = null;
      if (!disposePromise) {
        disposePromise = (async () => {
          await readyPromise.catch(() => undefined);
          await drainSet(dataOperations);
          await drainSet(controlOperations);
          if (mounted) {
            await bridge.dispose();
            mounted = false;
          }
        })();
      }
      return disposePromise;
    },
  });
  daemonHandlers.add(handler);
  return handler;
}

function resolveDesktopRendererTransport(): BrowserPageIdentityRendererTransportPort | null {
  const browser = getDesktopHost()?.browser;
  if (!browser) return null;
  const rawPort = Reflect.get(browser, "pageIdentityTransport");
  if (rawPort === undefined) return null;
  try {
    return createBrowserPageIdentityRendererTransportPort(rawPort);
  } catch {
    return null;
  }
}

function hasPageIdentityCapabilities(client: BrowserPageIdentityDaemonClientPort): boolean {
  const features = client.getLastServerInfoMessage()?.features;
  return (
    features?.enterpriseBrowserPageIdentityObservationV1 === true &&
    features.enterpriseBrowserPageIdentityInvalidationV1 === true
  );
}

function assertDaemonClientPort(client: BrowserPageIdentityDaemonClientPort): void {
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.getConnectionState !== "function" ||
    typeof client.getLastServerInfoMessage !== "function" ||
    typeof client.observeBrowserPageIdentity !== "function" ||
    typeof client.invalidateBrowserPageIdentity !== "function" ||
    typeof client.subscribeConnectionStatus !== "function" ||
    typeof client.close !== "function"
  ) {
    throw new Error("Invalid Browser page identity DaemonClient port.");
  }
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
    keys.length !== allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      descriptor.get ||
      descriptor.set ||
      !("value" in descriptor)
    ) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
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
