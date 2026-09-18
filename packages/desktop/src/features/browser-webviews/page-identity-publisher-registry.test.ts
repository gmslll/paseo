import { describe, expect, test, vi } from "vitest";
import type { BrowserProfileRuntimeAuthorization } from "../browser-profile.js";
import { createBrowserPageIdentityPublisherRegistry } from "./page-identity-publisher-registry.js";
import {
  BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL,
  BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL,
  BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL,
  BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL,
  installBrowserPageIdentityTransportRoutes,
  type BrowserPageIdentityTransportIpcMain,
  type BrowserPageIdentityTransportIpcMainEvent,
  type BrowserPageIdentityTransportSender,
} from "./page-identity-transport.js";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

type IpcHandler = (event: BrowserPageIdentityTransportIpcMainEvent, ...args: unknown[]) => unknown;

class FakeIpcMain implements BrowserPageIdentityTransportIpcMain {
  private readonly handlers = new Map<string, IpcHandler>();
  private readonly listeners = new Map<string, Set<IpcHandler>>();

  public handle(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public on(channel: string, listener: IpcHandler): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  public removeListener(channel: string, listener: IpcHandler): void {
    this.listeners.get(channel)?.delete(listener);
  }

  public async invoke(channel: string, sender: FakeSender, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
    return handler({ sender }, ...args);
  }

  public emit(channel: string, sender: FakeSender, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({ sender }, payload);
  }
}

interface TransportRequest {
  readonly version: 1;
  readonly routeId: string;
  readonly routeGeneration: string;
  readonly requestId: string;
  readonly operation: "observe" | "invalidate" | "fatal_teardown";
  readonly payload?: { readonly observationRevision?: string };
}

class FakeSender implements BrowserPageIdentityTransportSender {
  public readonly requests: TransportRequest[] = [];
  public onRequest: (request: TransportRequest) => void = () => {};
  private readonly destroyedListeners = new Set<() => void>();
  private destroyed = false;

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public send(channel: string, payload: unknown): void {
    expect(channel).toBe(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL);
    const request = payload as TransportRequest;
    this.requests.push(request);
    this.onRequest(request);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.add(listener);
  }

  public removeListener(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.delete(listener);
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.destroyedListeners) listener();
  }
}

class FakeContents {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public constructor(
    public readonly id: number,
    private readonly url: string,
  ) {}

  public isDestroyed(): boolean {
    return false;
  }

  public getURL(): string {
    return this.url;
  }

  public on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
}

const authorizationA: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: "nod_1111111111111111",
  workspaceId: "workspace-a",
  browserProfileId: "brp_1111111111111111",
  bindingRevision: "binding-a",
  lifecycleGeneration: "lifecycle-a",
};

const authorizationB: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: "nod_1111111111111111",
  workspaceId: "workspace-b",
  browserProfileId: "brp_2222222222222222",
  bindingRevision: "binding-b",
  lifecycleGeneration: "lifecycle-b",
};

function nextIds(): () => string {
  let sequence = 0;
  return () => `transport-${++sequence}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function acceptRequests(ipcMain: FakeIpcMain, sender: FakeSender): void {
  sender.onRequest = (request) => {
    queueMicrotask(() => {
      const response = {
        version: 1,
        routeId: request.routeId,
        routeGeneration: request.routeGeneration,
        requestId: request.requestId,
        operation: request.operation,
        result:
          request.operation === "fatal_teardown"
            ? { ok: true }
            : { ok: true, acceptedRevision: request.payload?.observationRevision },
      };
      ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, response);
    });
  };
}

function hasRequest(sender: FakeSender, operation: TransportRequest["operation"]): boolean {
  return sender.requests.some((request) => request.operation === operation);
}

function registerEnterpriseContents(input: {
  registry: PaseoBrowserWebviewRegistry;
  contents: FakeContents;
  sender: FakeSender;
  browserId: string;
  authorization: BrowserProfileRuntimeAuthorization;
}): void {
  input.registry.registerWebContents({
    webContentsId: input.contents.id,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
    workspaceId: input.authorization.workspaceId,
    profileAuthorization: input.authorization,
  });
}

describe("route-aware Browser page identity publisher registry", () => {
  test("routes two hosts without wire authority and closes controller plus registry concurrently", async () => {
    const ipcMain = new FakeIpcMain();
    const browserRegistry = new PaseoBrowserWebviewRegistry();
    let revision = 0;
    const publisher = createBrowserPageIdentityPublisherRegistry({
      registry: browserRegistry,
      createObservationRevision: () => `observation-${++revision}`,
    });
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      routeLifecycle: publisher.routeLifecycle,
      createId: nextIds(),
    });
    const hostA = new FakeSender(41);
    const hostB = new FakeSender(42);
    const contentsA = new FakeContents(141, "https://a.example/orders");
    const contentsB = new FakeContents(142, "https://b.example/orders");
    acceptRequests(ipcMain, hostA);
    acceptRequests(ipcMain, hostB);
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsA,
      sender: hostA,
      browserId: "11111111-1111-4111-8111-111111111111",
      authorization: authorizationA,
    });
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsB,
      sender: hostB,
      browserId: "22222222-2222-4222-8222-222222222222",
      authorization: authorizationB,
    });

    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostA);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostB);
    publisher.track(contentsA);
    publisher.track(contentsB);
    await Promise.all([publisher.publishCurrent(contentsA), publisher.publishCurrent(contentsB)]);

    expect(hostA.requests).toHaveLength(1);
    expect(hostB.requests).toHaveLength(1);
    expect(hostA.requests[0].payload).toMatchObject({ hostname: "a.example" });
    expect(hostB.requests[0].payload).toMatchObject({ hostname: "b.example" });
    expect(hostA.requests[0].payload).not.toHaveProperty("hostWebContentsId");
    expect(hostB.requests[0].payload).not.toHaveProperty("hostWebContentsId");
    expect(publisher.isExecutionAllowed(contentsA.id)).toBe(true);
    expect(publisher.isExecutionAllowed(contentsB.id)).toBe(true);

    const controllerClose = controller.close();
    const publisherClose = publisher.close();
    await Promise.all([controllerClose, publisherClose]);
  });

  test("serializes concurrent remounts without orphaning a host publisher or invalidating twice", async () => {
    const ipcMain = new FakeIpcMain();
    const browserRegistry = new PaseoBrowserWebviewRegistry();
    const publisher = createBrowserPageIdentityPublisherRegistry({ registry: browserRegistry });
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      routeLifecycle: publisher.routeLifecycle,
      createId: nextIds(),
    });
    const hostA = new FakeSender(51);
    const hostB = new FakeSender(52);
    const contentsA = new FakeContents(151, "https://a.example");
    const contentsB = new FakeContents(152, "https://b.example");
    acceptRequests(ipcMain, hostA);
    acceptRequests(ipcMain, hostB);
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsA,
      sender: hostA,
      browserId: "33333333-3333-4333-8333-333333333333",
      authorization: authorizationA,
    });
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsB,
      sender: hostB,
      browserId: "44444444-4444-4444-8444-444444444444",
      authorization: authorizationB,
    });
    const oldTicket = await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostA);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostB);
    publisher.track(contentsA);
    publisher.track(contentsB);
    await Promise.all([publisher.publishCurrent(contentsA), publisher.publishCurrent(contentsB)]);
    const handleA = publisher.createExecutionHandle(contentsA.id)!;
    const handleB = publisher.createExecutionHandle(contentsB.id)!;
    const invalidationBarrier = deferred<void>();
    hostA.onRequest = (request) => {
      if (request.operation === "invalidate") {
        void invalidationBarrier.promise.then(() => {
          ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, hostA, {
            version: 1,
            routeId: request.routeId,
            routeGeneration: request.routeGeneration,
            requestId: request.requestId,
            operation: request.operation,
            result: { ok: true, acceptedRevision: request.payload?.observationRevision },
          });
          return undefined;
        });
      }
    };

    const supersededReplacement = ipcMain.invoke(
      BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL,
      hostA,
    );
    const supersededRejection = expect(supersededReplacement).rejects.toThrow(/superseded/u);
    const latestReplacement = ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostA);
    expect(() => publisher.assertExecutionCurrent(handleA)).toThrow(/no longer current/u);
    expect(() => publisher.assertExecutionCurrent(handleB)).not.toThrow();
    const replacementDone = vi.fn();
    void latestReplacement.then(replacementDone);
    await vi.waitFor(() => expect(hasRequest(hostA, "invalidate")).toBe(true));
    expect(replacementDone).not.toHaveBeenCalled();
    invalidationBarrier.resolve();
    await supersededRejection;
    const newTicket = await latestReplacement;
    expect(newTicket).not.toEqual(oldTicket);
    expect(hostA.requests.filter((request) => request.operation === "invalidate")).toHaveLength(1);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL, hostA, oldTicket);
    expect(controller.getRoute(hostA)).not.toBeNull();
    expect(publisher.isExecutionAllowed(contentsB.id)).toBe(true);

    acceptRequests(ipcMain, hostA);
    publisher.track(contentsA);
    await publisher.publishCurrent(contentsA);
    expect(publisher.isExecutionAllowed(contentsA.id)).toBe(true);
    await controller.close();
    await publisher.close();
  });

  test("controller close supersedes a remount waiting on its old-route retirement", async () => {
    const ipcMain = new FakeIpcMain();
    const browserRegistry = new PaseoBrowserWebviewRegistry();
    const publisher = createBrowserPageIdentityPublisherRegistry({ registry: browserRegistry });
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      routeLifecycle: publisher.routeLifecycle,
      createId: nextIds(),
    });
    const host = new FakeSender(56);
    const contents = new FakeContents(156, "https://close.example");
    acceptRequests(ipcMain, host);
    registerEnterpriseContents({
      registry: browserRegistry,
      contents,
      sender: host,
      browserId: "99999999-9999-4999-8999-999999999999",
      authorization: authorizationA,
    });
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, host);
    publisher.track(contents);
    await publisher.publishCurrent(contents);
    const invalidationBarrier = deferred<void>();
    host.onRequest = (request) => {
      if (request.operation !== "invalidate") return;
      void invalidationBarrier.promise.then(() => {
        ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, host, {
          version: 1,
          routeId: request.routeId,
          routeGeneration: request.routeGeneration,
          requestId: request.requestId,
          operation: request.operation,
          result: { ok: true, acceptedRevision: request.payload?.observationRevision },
        });
        return undefined;
      });
    };

    const remount = ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, host);
    const remountRejection = expect(remount).rejects.toThrow(/superseded/u);
    await vi.waitFor(() => expect(hasRequest(host, "invalidate")).toBe(true));
    const close = controller.close();
    expect(controller.getRoute(host)).toBeNull();
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    invalidationBarrier.resolve();

    await remountRejection;
    await close;
    expect(controller.getRoute(host)).toBeNull();
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    await expect(publisher.publishCurrent(contents)).rejects.toThrow(/route is unavailable/u);
    expect(host.requests.filter((request) => request.operation === "invalidate")).toHaveLength(1);
    await publisher.close();
  });

  test("retires one host only after its invalidate barrier and leaves the other host current", async () => {
    const ipcMain = new FakeIpcMain();
    const browserRegistry = new PaseoBrowserWebviewRegistry();
    const publisher = createBrowserPageIdentityPublisherRegistry({ registry: browserRegistry });
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      routeLifecycle: publisher.routeLifecycle,
      createId: nextIds(),
    });
    const hostA = new FakeSender(61);
    const hostB = new FakeSender(62);
    const contentsA = new FakeContents(161, "https://a.example");
    const contentsB = new FakeContents(162, "https://b.example");
    acceptRequests(ipcMain, hostA);
    acceptRequests(ipcMain, hostB);
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsA,
      sender: hostA,
      browserId: "55555555-5555-4555-8555-555555555555",
      authorization: authorizationA,
    });
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsB,
      sender: hostB,
      browserId: "66666666-6666-4666-8666-666666666666",
      authorization: authorizationB,
    });
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostA);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostB);
    publisher.track(contentsA);
    publisher.track(contentsB);
    await Promise.all([publisher.publishCurrent(contentsA), publisher.publishCurrent(contentsB)]);
    const invalidationBarrier = deferred<void>();
    hostA.onRequest = (request) => {
      if (request.operation !== "invalidate") return;
      void invalidationBarrier.promise.then(() => {
        ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, hostA, {
          version: 1,
          routeId: request.routeId,
          routeGeneration: request.routeGeneration,
          requestId: request.requestId,
          operation: request.operation,
          result: { ok: true, acceptedRevision: request.payload?.observationRevision },
        });
        return undefined;
      });
    };

    const retirement = controller.retireRoute(hostA);
    expect(controller.getRoute(hostA)).toBeNull();
    expect(controller.getRoute(hostB)).not.toBeNull();
    expect(publisher.isExecutionAllowed(contentsA.id)).toBe(false);
    expect(publisher.isExecutionAllowed(contentsB.id)).toBe(true);
    const retired = vi.fn();
    void retirement.then(retired);
    await vi.waitFor(() => expect(hasRequest(hostA, "invalidate")).toBe(true));
    expect(retired).not.toHaveBeenCalled();
    invalidationBarrier.resolve();
    await retirement;
    expect(controller.getRoute(hostA)).toBeNull();
    expect(controller.getRoute(hostB)).not.toBeNull();

    await controller.close();
    await publisher.close();
  });

  test("contains a fatal transport failure to its exact host route", async () => {
    const ipcMain = new FakeIpcMain();
    const browserRegistry = new PaseoBrowserWebviewRegistry();
    const publisher = createBrowserPageIdentityPublisherRegistry({ registry: browserRegistry });
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      routeLifecycle: publisher.routeLifecycle,
      createId: nextIds(),
    });
    const hostA = new FakeSender(71);
    const hostB = new FakeSender(72);
    const contentsA = new FakeContents(171, "https://a.example");
    const contentsB = new FakeContents(172, "https://b.example");
    acceptRequests(ipcMain, hostA);
    acceptRequests(ipcMain, hostB);
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsA,
      sender: hostA,
      browserId: "77777777-7777-4777-8777-777777777777",
      authorization: authorizationA,
    });
    registerEnterpriseContents({
      registry: browserRegistry,
      contents: contentsB,
      sender: hostB,
      browserId: "88888888-8888-4888-8888-888888888888",
      authorization: authorizationB,
    });
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostA);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, hostB);
    publisher.track(contentsA);
    publisher.track(contentsB);
    await Promise.all([publisher.publishCurrent(contentsA), publisher.publishCurrent(contentsB)]);
    const handleB = publisher.createExecutionHandle(contentsB.id)!;
    let rejectNextObservation = true;
    hostA.onRequest = (request) => {
      queueMicrotask(() => {
        const failedObservation = request.operation === "observe" && rejectNextObservation;
        if (failedObservation) rejectNextObservation = false;
        let result:
          | { readonly ok: true; readonly acceptedRevision?: string }
          | { readonly ok: false; readonly code: "daemon_request_failed" } = {
          ok: true,
          acceptedRevision: request.payload?.observationRevision,
        };
        if (request.operation === "fatal_teardown") result = { ok: true };
        if (failedObservation) result = { ok: false, code: "daemon_request_failed" };
        ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, hostA, {
          version: 1,
          routeId: request.routeId,
          routeGeneration: request.routeGeneration,
          requestId: request.requestId,
          operation: request.operation,
          result,
        });
      });
    };

    await expect(publisher.publishCurrent(contentsA)).rejects.toThrow(/rejected the revision/u);
    expect(controller.getRoute(hostA)).toBeNull();
    expect(publisher.isExecutionAllowed(contentsA.id)).toBe(false);
    expect(controller.getRoute(hostB)).not.toBeNull();
    expect(() => publisher.assertExecutionCurrent(handleB)).not.toThrow();
    expect(publisher.isExecutionAllowed(contentsB.id)).toBe(true);

    await controller.close();
    await publisher.close();
  });
});
