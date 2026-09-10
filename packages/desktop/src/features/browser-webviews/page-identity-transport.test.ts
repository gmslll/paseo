import { describe, expect, test, vi } from "vitest";
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

const invalidation = {
  browser: observation.browser,
  observationRevision: observation.observationRevision,
  bindingRevision: observation.bindingRevision,
  lifecycleGeneration: observation.lifecycleGeneration,
} as const;

interface SentMessage {
  readonly channel: string;
  readonly payload: unknown;
}

class FakeSender implements BrowserPageIdentityTransportSender {
  public readonly sent: SentMessage[] = [];
  private destroyed = false;
  private readonly destroyedListeners = new Set<() => void>();

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("sender destroyed");
    this.sent.push({ channel, payload });
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    const once = (): void => {
      this.destroyedListeners.delete(once);
      listener();
    };
    this.destroyedListeners.add(once);
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

function deterministicIds(...ids: string[]): () => string {
  return () => {
    const id = ids.shift();
    if (!id) throw new Error("Test ID sequence exhausted");
    return id;
  };
}

function sentPayload(sender: FakeSender, index: number): Record<string, unknown> {
  const message = sender.sent[index];
  expect(message?.channel).toBe(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL);
  expect(message?.payload).toBeTypeOf("object");
  return message!.payload as Record<string, unknown>;
}

describe("Browser page identity renderer transport routes", () => {
  test("binds main-generated routes to the exact sender and correlates canonical operations", async () => {
    const ipcMain = new FakeIpcMain();
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      createId: deterministicIds(
        "route-a",
        "generation-a",
        "request-observe",
        "request-invalidate",
      ),
    });
    const sender = new FakeSender(41);
    const sameIdImpostor = new FakeSender(41);

    expect(await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, sender)).toEqual({
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
    });
    const route = controller.getRoute(sender);
    expect(route).not.toBeNull();
    expect(controller.getRoute(sameIdImpostor)).toBeNull();

    const observe = route!.observe(observation);
    expect(sentPayload(sender, 0)).toEqual({
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-observe",
      operation: "observe",
      payload: observation,
    });
    ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sameIdImpostor, {
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-observe",
      operation: "observe",
      result: { ok: true, acceptedRevision: "observation-1" },
    });
    await Promise.resolve();
    expect(route!.isCurrent()).toBe(true);
    ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-observe",
      operation: "observe",
      result: { ok: true, acceptedRevision: "observation-1" },
    });
    await observe;

    const invalidate = route!.invalidate(invalidation);
    ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-invalidate",
      operation: "invalidate",
      result: { ok: true, acceptedRevision: "observation-1" },
    });
    await invalidate;
    expect(sentPayload(sender, 1)).toMatchObject({
      operation: "invalidate",
      payload: invalidation,
    });

    await controller.close();
  });

  test("ignores stale route/generation responses and rejects authority-shaped renderer output", async () => {
    vi.useFakeTimers();
    try {
      const ipcMain = new FakeIpcMain();
      const controller = installBrowserPageIdentityTransportRoutes({
        ipcMain,
        timeoutMs: 25,
        createId: deterministicIds(
          "route-old",
          "generation-old",
          "route-new",
          "generation-new",
          "request-new",
        ),
      });
      const sender = new FakeSender(42);
      const oldTicket = await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, sender);
      await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL, sender, oldTicket);
      await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, sender);
      const route = controller.getRoute(sender)!;
      const pending = route.observe(observation);

      ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
        version: 1,
        routeId: "route-old",
        routeGeneration: "generation-old",
        requestId: "request-new",
        operation: "observe",
        result: { ok: true, acceptedRevision: "observation-1" },
      });
      ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
        version: 1,
        routeId: "route-new",
        routeGeneration: "generation-new",
        requestId: "request-new",
        operation: "observe",
        hostname: "renderer.example",
        result: { ok: true, acceptedRevision: "observation-1" },
      });
      const rejected = expect(pending).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(25);

      await rejected;
      expect(route.isCurrent()).toBe(false);
      await controller.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("seals synchronously, drains in-flight work, and acknowledges fatal teardown only after renderer ack", async () => {
    const ipcMain = new FakeIpcMain();
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      createId: deterministicIds("route-a", "generation-a", "request-observe", "request-teardown"),
    });
    const sender = new FakeSender(43);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, sender);
    const route = controller.getRoute(sender)!;
    const observe = route.observe(observation);

    route.seal();
    await expect(route.invalidate(invalidation)).rejects.toThrow(/sealed/i);
    const drained = vi.fn();
    void route.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-observe",
      operation: "observe",
      result: { ok: true, acceptedRevision: "observation-1" },
    });
    await observe;
    await route.drain();
    await Promise.resolve();
    expect(drained).toHaveBeenCalledOnce();

    const teardown = route.fatalTeardown();
    await Promise.resolve();
    expect(sentPayload(sender, 1)).toMatchObject({
      operation: "fatal_teardown",
      requestId: "request-teardown",
    });
    const acknowledged = vi.fn();
    void teardown.then(acknowledged);
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, sender, {
      version: 1,
      routeId: "route-a",
      routeGeneration: "generation-a",
      requestId: "request-teardown",
      operation: "fatal_teardown",
      result: { ok: true },
    });
    await teardown;
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(controller.getRoute(sender)).toBeNull();
    await controller.close();
  });

  test("fails pending work immediately when the bound sender disconnects", async () => {
    const ipcMain = new FakeIpcMain();
    const controller = installBrowserPageIdentityTransportRoutes({
      ipcMain,
      createId: deterministicIds("route-a", "generation-a", "request-observe"),
    });
    const sender = new FakeSender(44);
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, sender);
    const route = controller.getRoute(sender)!;
    const pending = route.observe(observation);

    sender.destroy();

    await expect(pending).rejects.toThrow(/disconnected/i);
    await route.drain();
    expect(controller.getRoute(sender)).toBeNull();
    await controller.close();
  });
});
