import { describe, expect, test, vi } from "vitest";

const fromWebContentsId = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ webContents: { fromId: fromWebContentsId } }));

import {
  getEnterpriseBrowserProfilePartition,
  PASEO_BROWSER_PROFILE_PARTITION,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";
import {
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWebContentsForBootstrapDiscovery,
  getPaseoBrowserWebContentsForHostWindow,
  getPaseoBrowserWebviewRegistry,
  getPaseoBrowserWorkspaceId,
  createBrowserPageIdentityPublisherRegistry,
  installPaseoBrowserPageIdentityPublisher,
  installBrowserPageIdentityTransportRoutes,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  registerAttachedPaseoBrowser,
  registerAttachedPaseoBrowserAfterPageIdentityBarrier,
  unregisterPaseoBrowser,
  unregisterPaseoBrowserFromHost,
} from "./index.js";
import {
  BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL,
  BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL,
  BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL,
  type BrowserPageIdentityTransportIpcMain,
  type BrowserPageIdentityTransportIpcMainEvent,
  type BrowserPageIdentityTransportSender,
} from "./page-identity-transport.js";

interface TestTransportRequest {
  readonly version: 1;
  readonly routeId: string;
  readonly routeGeneration: string;
  readonly requestId: string;
  readonly operation: "observe" | "invalidate" | "fatal_teardown";
  readonly payload?: { readonly observationRevision?: string };
}

class FakeRenderer implements BrowserPageIdentityTransportSender {
  public onPageIdentityRequest: (request: TestTransportRequest) => void = () => {};
  private readonly destroyedListeners = new Set<() => void>();

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }

  public send(channel: string, payload: unknown): void {
    expect(channel).toBe(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL);
    this.onPageIdentityRequest(payload as TestTransportRequest);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.add(listener);
  }

  public removeListener(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListeners.delete(listener);
  }
}

type TestIpcHandler = (
  event: BrowserPageIdentityTransportIpcMainEvent,
  ...args: unknown[]
) => unknown;

class FakePageIdentityIpcMain implements BrowserPageIdentityTransportIpcMain {
  private readonly handlers = new Map<string, TestIpcHandler>();
  private readonly listeners = new Map<string, Set<TestIpcHandler>>();

  public handle(channel: string, handler: TestIpcHandler): void {
    this.handlers.set(channel, handler);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public on(channel: string, listener: TestIpcHandler): void {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  }

  public removeListener(channel: string, listener: TestIpcHandler): void {
    this.listeners.get(channel)?.delete(listener);
  }

  public async invoke(channel: string, sender: FakeRenderer): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
    return handler({ sender });
  }

  public emit(channel: string, sender: FakeRenderer, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({ sender }, payload);
  }
}

const enterpriseAuthorization: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: "nod_1111111111111111",
  workspaceId: "workspace-enterprise",
  browserProfileId: "brp_1111111111111111",
  bindingRevision: "binding-a",
  lifecycleGeneration: "lifecycle-a",
};

class FakeBrowserGuest {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  public readonly debugCommands: string[] = [];
  public readonly executedScripts: string[] = [];
  public readonly inputEvents: unknown[] = [];
  public readonly debugger = {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (command: string) => {
      this.debugCommands.push(command);
      return undefined;
    },
  };
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getURL(): string {
    return "https://shop.example/orders";
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    this.executedScripts.push(code);
    return undefined;
  }

  public sendInputEvent(event: unknown): void {
    this.inputEvents.push(event);
  }

  public on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    for (const listener of this.listeners.get("destroyed") ?? []) listener();
    this.destroyedListener?.();
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function installTestPageIdentityAssembly(input: {
  renderer: FakeRenderer;
  additionalRenderers?: readonly FakeRenderer[];
  publish: () => Promise<void>;
  invalidate: () => Promise<void>;
  createObservationRevision?: () => string;
}) {
  const ipcMain = new FakePageIdentityIpcMain();
  const publisher = createBrowserPageIdentityPublisherRegistry({
    registry: getPaseoBrowserWebviewRegistry(),
    ...(input.createObservationRevision
      ? { createObservationRevision: input.createObservationRevision }
      : {}),
  });
  let transportId = 0;
  const controller = installBrowserPageIdentityTransportRoutes({
    ipcMain,
    routeLifecycle: publisher.routeLifecycle,
    createId: () => `index-transport-${++transportId}`,
  });
  const renderers = [input.renderer, ...(input.additionalRenderers ?? [])];
  for (const renderer of renderers) {
    renderer.onPageIdentityRequest = (request) => {
      void Promise.resolve()
        .then(async () => {
          if (request.operation === "observe") await input.publish();
          if (request.operation === "invalidate") await input.invalidate();
          return request.operation === "fatal_teardown"
            ? { ok: true as const }
            : {
                ok: true as const,
                acceptedRevision: request.payload?.observationRevision,
              };
        })
        .then((result) => {
          ipcMain.emit(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, renderer, {
            version: 1,
            routeId: request.routeId,
            routeGeneration: request.routeGeneration,
            requestId: request.requestId,
            operation: request.operation,
            result,
          });
          return undefined;
        });
    };
    await ipcMain.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL, renderer);
  }
  const disposePublisher = await installPaseoBrowserPageIdentityPublisher(publisher);
  return {
    publisher,
    dispose: async () => {
      await disposePublisher();
      await controller.close();
    },
  };
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:paseo-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isPaseoBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("accepts an enterprise WebView only on its derived Profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: getEnterpriseBrowserProfilePartition(enterpriseAuthorization.browserProfileId),
        profileAuthorization: enterpriseAuthorization,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
        profileAuthorization: enterpriseAuthorization,
      }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getPaseoBrowserWorkspaceId("browser-a")).toBe("workspace-a");
    unregisterPaseoBrowser("browser-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-owner",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-profile",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("registers only the exact enterprise Profile session and host tuple", () => {
    const renderer = new FakeRenderer(7);
    const profileSession = {};
    const guest = new FakeBrowserGuest(307, renderer, profileSession);

    expect(
      registerAttachedPaseoBrowser({
        browserId: "browser-enterprise",
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        profileAuthorization: enterpriseAuthorization,
        findWebContents: () => guest,
      }),
    ).toBe(true);
    expect(() =>
      registerAttachedPaseoBrowser({
        browserId: "browser-enterprise",
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: 308,
        sender: renderer,
        profileSession,
        profileAuthorization: {
          ...enterpriseAuthorization,
          browserProfileId: "brp_2222222222222222",
        },
        findWebContents: () => new FakeBrowserGuest(308, renderer, profileSession),
      }),
    ).toThrow(/cannot change/i);
    unregisterPaseoBrowser("browser-enterprise");
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(1);
    const secondRenderer = new FakeRenderer(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedPaseoBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedPaseoBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-second");
    unregisterPaseoBrowser("browser-first");
    unregisterPaseoBrowser("browser-second");
  });

  test("unregisters the same browser only from its requesting host with the publisher registry enabled", async () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(11);
    const secondRenderer = new FakeRenderer(22);
    const firstGuest = new FakeBrowserGuest(501, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(502, secondRenderer, profileSession);
    const assembly = await installTestPageIdentityAssembly({
      renderer: firstRenderer,
      additionalRenderers: [secondRenderer],
      publish: async () => {},
      invalidate: async () => {},
    });
    try {
      for (const [renderer, guest] of [
        [firstRenderer, firstGuest],
        [secondRenderer, secondGuest],
      ] as const) {
        await expect(
          registerAttachedPaseoBrowserAfterPageIdentityBarrier({
            browserId: "browser-shared-hosts",
            workspaceId: "workspace-shared",
            webContentsId: guest.id,
            sender: renderer,
            profileSession,
            findWebContents: () => guest,
          }),
        ).resolves.toBe(true);
      }

      await unregisterPaseoBrowserFromHost(firstRenderer.id, "browser-shared-hosts");

      expect(getPaseoBrowserIdForWebContents(firstGuest)).toBeNull();
      expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-shared-hosts");
      expect(getPaseoBrowserWorkspaceId("browser-shared-hosts")).toBe("workspace-shared");
    } finally {
      await unregisterPaseoBrowser("browser-shared-hosts");
      await assembly.dispose();
    }
  });

  test("prepares throttling once and removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(31);
    const guest = new FakeBrowserGuest(601, renderer, profileSession);
    preparePaseoBrowserWebContents(guest);
    registerAttachedPaseoBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });

  test("exposes an observed guest for bootstrap discovery and revokes guarded action primitives on navigation", async () => {
    const profileSession = {};
    const renderer = new FakeRenderer(35);
    const browserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const guest = new FakeBrowserGuest(635, renderer, profileSession);
    fromWebContentsId.mockImplementation((webContentsId) =>
      webContentsId === guest.id ? guest : null,
    );
    const observationAck = deferred<void>();
    const assembly = await installTestPageIdentityAssembly({
      renderer,
      publish: async () => observationAck.promise,
      invalidate: async () => undefined,
    });
    const { dispose } = assembly;
    try {
      preparePaseoBrowserWebContents(guest);
      const attach = registerAttachedPaseoBrowserAfterPageIdentityBarrier({
        browserId,
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        profileAuthorization: enterpriseAuthorization,
        findWebContents: () => guest,
      });
      await vi.waitFor(() => expect(getPaseoBrowserIdForWebContents(guest)).toBe(browserId));
      expect(getPaseoBrowserWebContentsForBootstrapDiscovery(browserId, renderer.id)).toBeNull();
      expect(getPaseoBrowserWebContentsForHostWindow(browserId, renderer.id)).toBeNull();

      observationAck.resolve();
      await expect(attach).resolves.toBe(true);
      expect(getPaseoBrowserWebContentsForBootstrapDiscovery(browserId, renderer.id)).toBe(guest);
      const guarded = getPaseoBrowserWebContentsForHostWindow(browserId, renderer.id);
      expect(guarded).not.toBeNull();
      expect(guarded).not.toBe(guest);
      if (!guarded) throw new Error("Expected guarded Browser WebContents.");

      const actionReady = deferred<void>();
      const fill = actionReady.promise.then(() => guarded.executeJavaScript("fill()"));
      const click = actionReady.promise.then(() =>
        guarded.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed" }),
      );
      const input = actionReady.promise.then(() =>
        guarded.sendInputEvent({ type: "keyDown", keyCode: "Enter" }),
      );
      guest.emit("did-start-navigation", {}, "https://other.example", false, true);
      actionReady.resolve();

      await expect(fill).rejects.toThrow(/no longer current/u);
      await expect(click).rejects.toThrow(/no longer current/u);
      await expect(input).rejects.toThrow(/no longer current/u);
      expect(guest.executedScripts).toEqual([]);
      expect(guest.debugCommands).toEqual([]);
      expect(guest.inputEvents).toEqual([]);
    } finally {
      await dispose();
      await unregisterPaseoBrowser(browserId);
      fromWebContentsId.mockReset();
    }
  });

  test("holds replacement and release behind remote invalidation while the local gate closes immediately", async () => {
    const profileSession = {};
    const renderer = new FakeRenderer(41);
    const browserId = "11111111-1111-4111-8111-111111111111";
    const oldGuest = new FakeBrowserGuest(701, renderer, profileSession);
    const newGuest = new FakeBrowserGuest(702, renderer, profileSession);
    const guests = new Map([
      [oldGuest.id, oldGuest],
      [newGuest.id, newGuest],
    ]);
    expect(
      registerAttachedPaseoBrowser({
        browserId,
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: oldGuest.id,
        sender: renderer,
        profileSession,
        profileAuthorization: enterpriseAuthorization,
        findWebContents: (id) => guests.get(id) ?? null,
      }),
    ).toBe(true);
    const invalidations: Array<ReturnType<typeof deferred<void>>> = [];
    let revision = 0;
    const assembly = await installTestPageIdentityAssembly({
      renderer,
      publish: async () => {},
      invalidate: async () => {
        const barrier = deferred<void>();
        invalidations.push(barrier);
        await barrier.promise;
      },
      createObservationRevision: () => `observation-${++revision}`,
    });
    const { dispose, publisher } = assembly;
    try {
      publisher.track(oldGuest);
      await publisher.publishCurrent(oldGuest);
      expect(publisher.isExecutionAllowed(oldGuest.id)).toBe(true);
      preparePaseoBrowserWebContents(newGuest);

      expect(() =>
        registerAttachedPaseoBrowser({
          browserId,
          workspaceId: enterpriseAuthorization.workspaceId,
          webContentsId: newGuest.id,
          sender: renderer,
          profileSession,
          profileAuthorization: enterpriseAuthorization,
          findWebContents: (id) => guests.get(id) ?? null,
        }),
      ).toThrow(/awaitable page-identity barrier/u);
      const replacement = registerAttachedPaseoBrowserAfterPageIdentityBarrier({
        browserId,
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: newGuest.id,
        sender: renderer,
        profileSession,
        profileAuthorization: enterpriseAuthorization,
        findWebContents: (id) => guests.get(id) ?? null,
      });
      expect(publisher.isExecutionAllowed(oldGuest.id)).toBe(false);
      expect(getPaseoBrowserIdForWebContents(oldGuest)).toBe(browserId);
      expect(getPaseoBrowserIdForWebContents(newGuest)).toBeNull();
      await vi.waitFor(() => expect(invalidations).toHaveLength(1));
      invalidations[0].resolve();
      await expect(replacement).resolves.toBe(true);
      expect(getPaseoBrowserIdForWebContents(oldGuest)).toBeNull();
      expect(getPaseoBrowserIdForWebContents(newGuest)).toBe(browserId);
      expect(publisher.isExecutionAllowed(newGuest.id)).toBe(true);

      const release = unregisterPaseoBrowserFromHost(renderer.id, browserId);
      expect(publisher.isExecutionAllowed(newGuest.id)).toBe(false);
      expect(getPaseoBrowserIdForWebContents(newGuest)).toBe(browserId);
      await vi.waitFor(() => expect(invalidations).toHaveLength(2));
      invalidations[1].resolve();
      await release;
      expect(getPaseoBrowserIdForWebContents(newGuest)).toBeNull();
    } finally {
      for (const invalidation of invalidations) invalidation.resolve();
      await dispose();
    }
  });
});
