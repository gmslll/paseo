import type {
  EnterpriseBrowserPageIdentityInvalidationRequest,
  EnterpriseBrowserPageIdentityInvalidationResponse,
  EnterpriseBrowserPageIdentityObservationRequest,
  EnterpriseBrowserPageIdentityObservationResponse,
} from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import {
  createBrowserPageIdentityRendererTransportPort,
  mountBrowserPageIdentityDaemonClientHandler,
  type BrowserPageIdentityDaemonClientPort,
  type BrowserPageIdentityRendererRequest,
  type BrowserPageIdentityRendererResponse,
} from "./page-identity-transport";

type ObservationInput = Omit<
  EnterpriseBrowserPageIdentityObservationRequest,
  "type" | "requestId"
> & { requestId?: string };
type InvalidationInput = Omit<
  EnterpriseBrowserPageIdentityInvalidationRequest,
  "type" | "requestId"
> & { requestId?: string };

const observation = {
  browser: {
    browserId: "11111111-1111-4111-8111-111111111111",
    browserProfileId: "brp_1111111111111111",
  },
  hostname: "shop.example",
  accountLabelHash: "sha256:account-a",
  observationRevision: "observation-1",
  bindingRevision: "binding-1",
  lifecycleGeneration: "lifecycle-1",
} as const;

class FakeRendererBridge {
  public handler: ((request: unknown) => void) | null = null;
  public readonly responses: BrowserPageIdentityRendererResponse[] = [];
  public mountCount = 0;
  public disposeCount = 0;

  public mount = async (handler: (request: unknown) => void): Promise<void> => {
    this.mountCount += 1;
    this.handler = handler;
  };

  public dispose = async (): Promise<void> => {
    this.disposeCount += 1;
    this.handler = null;
  };

  public respond = (response: BrowserPageIdentityRendererResponse): void => {
    this.responses.push(response);
  };

  public receive(request: BrowserPageIdentityRendererRequest): void {
    this.handler?.(request);
  }
}

class FakeDaemonClient implements BrowserPageIdentityDaemonClientPort {
  public connectionStatus = "connected";
  public observationResponse: EnterpriseBrowserPageIdentityObservationResponse | null = null;
  public invalidationResponse: EnterpriseBrowserPageIdentityInvalidationResponse | null = null;
  public readonly observations: ObservationInput[] = [];
  public readonly invalidations: InvalidationInput[] = [];
  public closeCount = 0;
  public closePromise: Promise<void> = Promise.resolve();
  private readonly connectionListeners = new Set<(state: { readonly status: string }) => void>();

  public getConnectionState(): { readonly status: string } {
    return { status: this.connectionStatus };
  }

  public getLastServerInfoMessage(): ReturnType<
    BrowserPageIdentityDaemonClientPort["getLastServerInfoMessage"]
  > {
    return {
      features: {
        enterpriseBrowserPageIdentityObservationV1: true,
        enterpriseBrowserPageIdentityInvalidationV1: true,
      },
    };
  }

  public observeBrowserPageIdentity(
    input: ObservationInput,
  ): Promise<EnterpriseBrowserPageIdentityObservationResponse> {
    this.observations.push(input);
    return Promise.resolve(
      this.observationResponse ?? {
        type: "enterprise.browser.page_identity.observe.response",
        payload: {
          requestId: input.requestId!,
          acceptedRevision: input.observationRevision,
        },
      },
    );
  }

  public invalidateBrowserPageIdentity(
    input: InvalidationInput,
  ): Promise<EnterpriseBrowserPageIdentityInvalidationResponse> {
    this.invalidations.push(input);
    return Promise.resolve(
      this.invalidationResponse ?? {
        type: "enterprise.browser.page_identity.invalidate.response",
        payload: {
          requestId: input.requestId!,
          acceptedRevision: input.observationRevision,
        },
      },
    );
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
    await this.closePromise;
  }

  public subscribeConnectionStatus(
    listener: (state: { readonly status: string }) => void,
  ): () => void {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  public setConnectionStatus(status: string): void {
    this.connectionStatus = status;
    for (const listener of this.connectionListeners) listener(this.getConnectionState());
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function observeRequest(
  requestId = "transport-observe",
): Extract<BrowserPageIdentityRendererRequest, { operation: "observe" }> {
  return { requestId, operation: "observe", payload: observation };
}

function invalidateRequest(
  requestId = "transport-invalidate",
): Extract<BrowserPageIdentityRendererRequest, { operation: "invalidate" }> {
  return {
    requestId,
    operation: "invalidate",
    payload: {
      browser: observation.browser,
      observationRevision: observation.observationRevision,
      bindingRevision: observation.bindingRevision,
      lifecycleGeneration: observation.lifecycleGeneration,
    },
  };
}

describe("Browser page identity DaemonClient renderer handler", () => {
  test("forwards only main-provided canonical payloads and returns a strict correlated revision", async () => {
    const rawBridge = new FakeRendererBridge();
    const bridge = createBrowserPageIdentityRendererTransportPort({
      mount: rawBridge.mount,
      dispose: rawBridge.dispose,
      respond: rawBridge.respond,
    });
    const client = new FakeDaemonClient();
    const handler = mountBrowserPageIdentityDaemonClientHandler({ client, bridge });
    await handler.ready();

    rawBridge.receive(observeRequest());
    await handler.drain();
    rawBridge.receive(invalidateRequest());
    await handler.drain();

    expect(client.observations).toEqual([{ ...observation, requestId: "transport-observe" }]);
    expect(client.invalidations).toEqual([
      {
        ...invalidateRequest().payload,
        requestId: "transport-invalidate",
      },
    ]);
    expect(rawBridge.responses).toEqual([
      {
        requestId: "transport-observe",
        operation: "observe",
        result: { ok: true, acceptedRevision: "observation-1" },
      },
      {
        requestId: "transport-invalidate",
        operation: "invalidate",
        result: { ok: true, acceptedRevision: "observation-1" },
      },
    ]);
    const rendererOutput = JSON.stringify(rawBridge.responses);
    expect(rendererOutput).not.toMatch(
      /hostname|accountLabelHash|browserId|browserProfileId|path|PAT/,
    );
    await handler.dispose();
  });

  test("fails closed before mount when either server capability is absent", () => {
    const rawBridge = new FakeRendererBridge();
    const bridge = createBrowserPageIdentityRendererTransportPort({
      mount: rawBridge.mount,
      dispose: rawBridge.dispose,
      respond: rawBridge.respond,
    });
    const client = new FakeDaemonClient();
    client.getLastServerInfoMessage = () => ({
      features: { enterpriseBrowserPageIdentityObservationV1: true },
    });

    expect(() => mountBrowserPageIdentityDaemonClientHandler({ client, bridge })).toThrow(
      /capabilit/i,
    );
    expect(rawBridge.mountCount).toBe(0);
  });

  test("fails closed when the controlled preload bridge is absent", () => {
    const client = new FakeDaemonClient();

    expect(() => mountBrowserPageIdentityDaemonClientHandler({ client })).toThrow(
      /transport is unavailable/i,
    );
    expect(client.observations).toEqual([]);
    expect(client.invalidations).toEqual([]);
  });

  test("rejects mismatched daemon correlation and closes the exact client before fatal ack", async () => {
    const rawBridge = new FakeRendererBridge();
    const bridge = createBrowserPageIdentityRendererTransportPort({
      mount: rawBridge.mount,
      dispose: rawBridge.dispose,
      respond: rawBridge.respond,
    });
    const client = new FakeDaemonClient();
    client.observationResponse = {
      type: "enterprise.browser.page_identity.observe.response",
      payload: { requestId: "wrong-request", acceptedRevision: "observation-old" },
    };
    const handler = mountBrowserPageIdentityDaemonClientHandler({ client, bridge });
    await handler.ready();

    rawBridge.receive(observeRequest());
    await handler.drain();
    expect(rawBridge.responses).toEqual([
      {
        requestId: "transport-observe",
        operation: "observe",
        result: { ok: false, code: "daemon_response_mismatch" },
      },
    ]);

    const close = deferred<void>();
    client.closePromise = close.promise;
    rawBridge.receive({ requestId: "transport-teardown", operation: "fatal_teardown" });
    await Promise.resolve();
    expect(client.closeCount).toBe(1);
    expect(rawBridge.responses).toHaveLength(1);
    close.resolve();
    await handler.drain();
    expect(rawBridge.responses[1]).toEqual({
      requestId: "transport-teardown",
      operation: "fatal_teardown",
      result: { ok: true },
    });
    await handler.dispose();
  });

  test("seals synchronously across dispose and disconnect so deferred work cannot publish success", async () => {
    const rawBridge = new FakeRendererBridge();
    const bridge = createBrowserPageIdentityRendererTransportPort({
      mount: rawBridge.mount,
      dispose: rawBridge.dispose,
      respond: rawBridge.respond,
    });
    const client = new FakeDaemonClient();
    const response = deferred<EnterpriseBrowserPageIdentityObservationResponse>();
    client.observeBrowserPageIdentity = (input) => {
      client.observations.push(input);
      return response.promise;
    };
    const handler = mountBrowserPageIdentityDaemonClientHandler({ client, bridge });
    await handler.ready();
    rawBridge.receive(observeRequest("deferred-observe"));

    handler.seal();
    rawBridge.receive(observeRequest("post-seal"));
    expect(client.observations).toHaveLength(1);
    const disposal = handler.dispose();
    response.resolve({
      type: "enterprise.browser.page_identity.observe.response",
      payload: { requestId: "deferred-observe", acceptedRevision: "observation-1" },
    });
    await disposal;
    expect(rawBridge.responses).toEqual([
      {
        requestId: "post-seal",
        operation: "observe",
        result: { ok: false, code: "handler_sealed" },
      },
      {
        requestId: "deferred-observe",
        operation: "observe",
        result: { ok: false, code: "handler_sealed" },
      },
    ]);
    expect(rawBridge.disposeCount).toBe(1);

    const disconnectedBridge = new FakeRendererBridge();
    const disconnectedClient = new FakeDaemonClient();
    const disconnectedHandler = mountBrowserPageIdentityDaemonClientHandler({
      client: disconnectedClient,
      bridge: createBrowserPageIdentityRendererTransportPort({
        mount: disconnectedBridge.mount,
        dispose: disconnectedBridge.dispose,
        respond: disconnectedBridge.respond,
      }),
    });
    await disconnectedHandler.ready();
    disconnectedClient.setConnectionStatus("disconnected");
    await disconnectedHandler.drain();
    expect(disconnectedClient.closeCount).toBe(1);
    expect(disconnectedBridge.disposeCount).toBe(1);
  });
});
