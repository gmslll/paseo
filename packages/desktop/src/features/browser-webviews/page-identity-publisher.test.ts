import type {
  EnterpriseBrowserPageIdentityInvalidationRequest,
  EnterpriseBrowserPageIdentityObservationRequest,
} from "@getpaseo/protocol/messages";
import { describe, expect, test, vi } from "vitest";
import type { BrowserProfileRuntimeAuthorization } from "../browser-profile.js";
import {
  createBrowserPageAccountLabelHashReader,
  createBrowserPageIdentityAuthorityTeardownPort,
  createBrowserPageIdentityPublisher,
} from "./page-identity-publisher.js";
import { PaseoBrowserWebviewRegistry } from "./registry.js";

const authorization: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: "nod_1111111111111111",
  workspaceId: "workspace-1",
  browserProfileId: "brp_1111111111111111",
  bindingRevision: "binding-1",
  lifecycleGeneration: "lifecycle-1",
};

type ObservationPayload = Omit<
  EnterpriseBrowserPageIdentityObservationRequest,
  "type" | "requestId"
>;
type InvalidationPayload = Omit<
  EnterpriseBrowserPageIdentityInvalidationRequest,
  "type" | "requestId"
>;

class FakeWebContents {
  public destroyed = false;
  private url = "https://shop.example/orders";
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  public constructor(public readonly id: number) {}
  public isDestroyed(): boolean {
    return this.destroyed;
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
  public emit(event: string, ...args: unknown[]): void {
    if (typeof args[1] === "string") this.url = args[1];
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function authorityTeardown(
  teardownAfterAuthorityTransportFailure: (error: Error) => Promise<void> | void = async () => {},
) {
  return createBrowserPageIdentityAuthorityTeardownPort({
    teardownAfterAuthorityTransportFailure,
  });
}

describe("Browser page identity publisher", () => {
  test("publishes only registry-derived browser/Profile/revision identity from the actual guest", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const published: ObservationPayload[] = [];
    const invalidated: InvalidationPayload[] = [];
    const contents = new FakeWebContents(7);
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async (payload) => published.push(payload),
      invalidate: async (payload) => invalidated.push(payload),
      accountLabelHashReader: createBrowserPageAccountLabelHashReader({
        read: async (actualContents, actualAuthorization) => {
          expect(actualContents).toBe(contents);
          expect(actualAuthorization).toEqual(authorization);
          return "sha256:account-a";
        },
      }),
      createObservationRevision: () => `observation-${published.length + 1}`,
    });

    publisher.track(contents);
    await publisher.publishCurrent(contents);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(true);

    expect(published).toEqual([
      {
        browser: {
          browserId: "11111111-1111-4111-8111-111111111111",
          browserProfileId: authorization.browserProfileId,
        },
        hostname: "shop.example",
        accountLabelHash: "sha256:account-a",
        observationRevision: "observation-1",
        bindingRevision: authorization.bindingRevision,
        lifecycleGeneration: authorization.lifecycleGeneration,
      },
    ]);
    expect(invalidated).toEqual([]);
    await publisher.close();
    expect(invalidated).toEqual([
      {
        browser: {
          browserId: "11111111-1111-4111-8111-111111111111",
          browserProfileId: authorization.browserProfileId,
        },
        observationRevision: "observation-1",
        bindingRevision: authorization.bindingRevision,
        lifecycleGeneration: authorization.lifecycleGeneration,
      },
    ]);
  });

  test("never publishes an uncommitted navigation target and suppresses stale replace/destroy work", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const published: ObservationPayload[] = [];
    const invalidated: InvalidationPayload[] = [];
    const hash = deferred<string>();
    const contents = new FakeWebContents(7);
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async (payload) => published.push(payload),
      invalidate: async (payload) => invalidated.push(payload),
      accountLabelHashReader: createBrowserPageAccountLabelHashReader({
        read: async () => hash.promise,
      }),
      createObservationRevision: (() => {
        let revision = 0;
        return () => `observation-${++revision}`;
      })(),
    });
    publisher.track(contents);

    contents.emit("did-start-navigation", {}, "https://other.example/account", false, true);
    await Promise.resolve();
    expect(published).toEqual([]);

    const pending = publisher.publishCurrent(contents);
    registry.unregisterWebContents(7);
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: { ...authorization, lifecycleGeneration: "lifecycle-2" },
    });
    hash.resolve("sha256:old-account");
    await pending;
    expect(published).toHaveLength(0);

    const destroyedHash = deferred<string>();
    const secondPublisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async (payload) => published.push(payload),
      invalidate: async (payload) => invalidated.push(payload),
      accountLabelHashReader: createBrowserPageAccountLabelHashReader({
        read: async () => destroyedHash.promise,
      }),
    });
    const pendingDestroyed = secondPublisher.publishCurrent(contents);
    contents.destroyed = true;
    await secondPublisher.invalidateWebContents(contents.id);
    destroyedHash.resolve("sha256:new-account");
    await pendingDestroyed;
    expect(published).toHaveLength(0);
    await publisher.close();
    await secondPublisher.close();
  });

  test("serializes exact invalidation across navigation, replacement, destroy, unregister, revoke, and host teardown", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    const browserId = "11111111-1111-4111-8111-111111111111";
    registry.registerWebContents({
      webContentsId: 7,
      browserId,
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const events: string[] = [];
    const published: ObservationPayload[] = [];
    const invalidated: InvalidationPayload[] = [];
    let revision = 0;
    const contents = new FakeWebContents(7);
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async (payload) => {
        published.push(payload);
        events.push(`observe:${payload.observationRevision}`);
      },
      invalidate: async (payload) => {
        invalidated.push(payload);
        events.push(`invalidate:${payload.observationRevision}`);
      },
      createObservationRevision: () => `observation-${++revision}`,
    });
    publisher.track(contents);
    await publisher.publishCurrent(contents);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(true);

    contents.emit("did-start-navigation", {}, "https://frame.example", false, false);
    await Promise.resolve();
    expect(invalidated).toHaveLength(0);
    contents.emit("did-start-navigation", {}, "https://other.example/account", false, true);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    await vi.waitFor(() => expect(invalidated).toHaveLength(1));
    expect(published).toHaveLength(1);
    expect(invalidated[0]).toEqual({
      browser: { browserId, browserProfileId: authorization.browserProfileId },
      observationRevision: "observation-1",
      bindingRevision: authorization.bindingRevision,
      lifecycleGeneration: authorization.lifecycleGeneration,
    });

    contents.emit("did-navigate", {}, "https://other.example/account");
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(publisher.isExecutionAllowed(contents.id)).toBe(true);
    contents.emit("did-navigate-in-page", {}, "https://ignored.example", false);
    await Promise.resolve();
    expect(published).toHaveLength(2);
    contents.emit("did-navigate-in-page", {}, "https://other.example/orders", true);
    await vi.waitFor(() => expect(published).toHaveLength(3));
    expect(events).toEqual([
      "observe:observation-1",
      "invalidate:observation-1",
      "observe:observation-2",
      "invalidate:observation-2",
      "observe:observation-3",
    ]);

    contents.destroyed = true;
    contents.emit("destroyed");
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    await vi.waitFor(() => expect(invalidated).toHaveLength(3));
    expect(invalidated.at(-1)?.observationRevision).toBe("observation-3");

    const unregisterContents = new FakeWebContents(8);
    registry.registerWebContents({
      webContentsId: 8,
      browserId: "22222222-2222-4222-8222-222222222222",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    publisher.track(unregisterContents);
    await publisher.publishCurrent(unregisterContents);
    await publisher.invalidateBrowser("22222222-2222-4222-8222-222222222222");
    expect(invalidated.at(-1)?.observationRevision).toBe("observation-4");

    const hostContents = new FakeWebContents(9);
    registry.registerWebContents({
      webContentsId: 9,
      browserId: "33333333-3333-4333-8333-333333333333",
      hostWebContentsId: 4,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    publisher.track(hostContents);
    await publisher.publishCurrent(hostContents);
    await publisher.invalidateHost(4);
    expect(invalidated.at(-1)?.observationRevision).toBe("observation-5");
    await publisher.close();
  });

  test("revokes nominal execution handles synchronously before a deferred action can mutate the page", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const contents = new FakeWebContents(7);
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async () => undefined,
      invalidate: async () => undefined,
    });
    publisher.track(contents);
    expect(publisher.createExecutionHandle(contents.id)).toBeNull();
    await publisher.publishCurrent(contents);
    const handle = publisher.createExecutionHandle(contents.id);
    expect(handle).not.toBeNull();
    if (!handle) throw new Error("Expected current Browser page identity execution handle.");
    expect(() => publisher.assertExecutionCurrent(handle)).not.toThrow();
    expect(() => publisher.assertExecutionCurrent({} as never)).toThrow(/no longer current/u);

    const actionability = deferred<void>();
    const pageMutation = vi.fn();
    const deferredAction = (async () => {
      await actionability.promise;
      publisher.assertExecutionCurrent(handle);
      pageMutation();
    })();
    contents.emit("did-start-navigation", {}, "https://other.example/account", false, true);
    actionability.resolve();

    await expect(deferredAction).rejects.toThrow(/no longer current/u);
    expect(pageMutation).not.toHaveBeenCalled();
    await publisher.close();
  });

  test("keeps future observations absent after an invalidation transport failure", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const published: ObservationPayload[] = [];
    const errors: Error[] = [];
    const teardown = vi.fn(async () => {});
    const contents = new FakeWebContents(7);
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(teardown),
      publish: async (payload) => published.push(payload),
      invalidate: async () => {
        throw new Error("invalidate transport failed");
      },
      onError: (error) => errors.push(error),
    });
    await publisher.publishCurrent(contents);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(true);
    await expect(publisher.invalidateWebContents(contents.id)).rejects.toThrow(
      "invalidate transport failed",
    );

    await publisher.publishCurrent(contents);
    expect(published).toHaveLength(1);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledWith(
      expect.objectContaining({ message: "invalidate transport failed" }),
    );
    expect(errors).toEqual([expect.objectContaining({ message: "invalidate transport failed" })]);
    await expect(Promise.all([publisher.close(), publisher.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("tears down once when an observation response is ambiguous and never publishes again", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    const publish = vi.fn(async () => {
      throw new Error("observe response lost");
    });
    const teardown = vi.fn(async () => {});
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(teardown),
      publish,
      invalidate: async () => undefined,
    });
    const contents = new FakeWebContents(7);

    await expect(publisher.publishCurrent(contents)).rejects.toThrow("observe response lost");
    await publisher.publishCurrent(contents);
    await publisher.invalidateWebContents(contents.id).catch(() => {});

    expect(publish).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(publisher.isExecutionAllowed(contents.id)).toBe(false);
    await expect(Promise.all([publisher.close(), publisher.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test("reader throws publish a hashless current observation and structural readers are rejected", async () => {
    const registry = new PaseoBrowserWebviewRegistry();
    registry.registerWebContents({
      webContentsId: 7,
      browserId: "11111111-1111-4111-8111-111111111111",
      hostWebContentsId: 3,
      workspaceId: "workspace-1",
      profileAuthorization: authorization,
    });
    expect(() =>
      createBrowserPageIdentityPublisher({
        registry,
        authorityTeardown: authorityTeardown(),
        publish: async () => undefined,
        invalidate: async () => undefined,
        accountLabelHashReader: { read: async () => "caller" } as never,
      }),
    ).toThrow();
    expect(() =>
      createBrowserPageIdentityPublisher({
        registry,
        authorityTeardown: {
          teardownAfterAuthorityTransportFailure: async () => undefined,
        } as never,
        publish: async () => undefined,
        invalidate: async () => undefined,
      }),
    ).toThrow();
    expect(() =>
      createBrowserPageIdentityAuthorityTeardownPort(
        Object.defineProperty({}, "teardownAfterAuthorityTransportFailure", {
          enumerable: true,
          get: () => async () => undefined,
        }) as never,
      ),
    ).toThrow();

    const published: ObservationPayload[] = [];
    const errors: Error[] = [];
    const publisher = createBrowserPageIdentityPublisher({
      registry,
      authorityTeardown: authorityTeardown(),
      publish: async (payload) => published.push(payload),
      invalidate: async () => undefined,
      accountLabelHashReader: createBrowserPageAccountLabelHashReader({
        read: async () => {
          throw new Error("page read failed");
        },
      }),
      onError: (error) => errors.push(error),
    });
    await publisher.publishCurrent(new FakeWebContents(7));
    expect(published).toHaveLength(1);
    expect(published[0]).not.toHaveProperty("accountLabelHash");
    expect(errors).toHaveLength(1);
    await publisher.close();
  });
});
