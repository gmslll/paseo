import { webContents as allWebContents, type WebContents } from "electron";
import {
  getEnterpriseBrowserProfilePartition,
  PASEO_BROWSER_PROFILE_PARTITION,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { PaseoBrowserWebviewRegistry } from "./registry.js";
import {
  isBrowserPageIdentityPublisher,
  type BrowserPageIdentityExecutionHandle,
  type BrowserPageIdentityPublisher,
  type BrowserPageIdentityWebContents,
} from "./page-identity-publisher.js";

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};
export {
  createBrowserPageIdentityTransportPublisherPorts,
  installBrowserPageIdentityTransportRoutes,
  type BrowserPageIdentityTransportController,
  type BrowserPageIdentityTransportRoute,
} from "./page-identity-transport.js";

const browserRegistry = new PaseoBrowserWebviewRegistry();
let pageIdentityPublisher: BrowserPageIdentityPublisher | null = null;
let pageIdentityLifecycleQueue = Promise.resolve();

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface RegisteredBrowserWebContents
  extends BrowserWebContentsIdentity, BrowserPageIdentityWebContents {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  setBackgroundThrottling(allowed: boolean): void;
  once(event: "destroyed", listener: () => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
  profileAuthorization?: BrowserProfileRuntimeAuthorization;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserWebContentsIdentity;
  profileSession: object;
  findWebContents(webContentsId: number): RegisteredBrowserWebContents | null;
}

export function isPaseoBrowserWebviewAttach(input: {
  src?: string;
  partition?: string;
  profileAuthorization?: BrowserProfileRuntimeAuthorization;
}): boolean {
  return (
    isAllowedBrowserWebviewUrl(input.src) &&
    (input.profileAuthorization
      ? input.partition ===
        getEnterpriseBrowserProfilePartition(input.profileAuthorization.browserProfileId)
      : input.partition === PASEO_BROWSER_PROFILE_PARTITION)
  );
}

export function listRegisteredPaseoBrowserIds(): string[] {
  return browserRegistry.listBrowserIds();
}

export function getPaseoBrowserWebviewRegistry(): PaseoBrowserWebviewRegistry {
  return browserRegistry;
}

/** Root awaits this only with the W0 client publisher and capability gate wired together. */
export async function installPaseoBrowserPageIdentityPublisher(
  publisher: BrowserPageIdentityPublisher,
): Promise<() => Promise<void>> {
  if (!isBrowserPageIdentityPublisher(publisher)) {
    throw new Error("Invalid Browser page identity publisher.");
  }
  const previous = pageIdentityPublisher;
  pageIdentityPublisher = null;
  if (previous) await previous.close();
  await pageIdentityLifecycleQueue;
  pageIdentityPublisher = publisher;
  return async () => {
    if (pageIdentityPublisher !== publisher) return;
    pageIdentityPublisher = null;
    await publisher.close();
    await pageIdentityLifecycleQueue;
  };
}

export function preparePaseoBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  contents.setBackgroundThrottling(false);
  pageIdentityPublisher?.track(contents);
  contents.once("destroyed", () => {
    void invalidateWebContentsBeforeRelease(webContentsId).catch(() => {});
  });
}

export function registerAttachedPaseoBrowser(input: RegisterAttachedBrowserInput): boolean {
  if (pageIdentityPublisher) {
    throw new Error(
      "Enterprise Browser registration requires the awaitable page-identity barrier.",
    );
  }
  return registerAttachedPaseoBrowserNow(input);
}

/** Root awaits this path once the page-identity publisher is installed. */
export async function registerAttachedPaseoBrowserAfterPageIdentityBarrier(
  input: RegisterAttachedBrowserInput,
): Promise<boolean> {
  const guest = input.findWebContents(input.webContentsId);
  if (!isAttachedBrowserGuestCurrent(input, guest)) return false;
  const publisher = pageIdentityPublisher;
  if (!publisher) return registerAttachedPaseoBrowserNow(input);

  const replacedWebContentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    input.sender.id,
    input.browserId,
  );
  const invalidatedWebContentsIds = new Set([input.webContentsId]);
  if (replacedWebContentsId !== null) invalidatedWebContentsIds.add(replacedWebContentsId);
  const invalidation = Promise.all(
    [...invalidatedWebContentsIds].map((webContentsId) =>
      publisher.invalidateWebContents(webContentsId),
    ),
  );
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    if (pageIdentityPublisher !== publisher) return false;
    const currentGuest = input.findWebContents(input.webContentsId);
    if (!isAttachedBrowserGuestCurrent(input, currentGuest)) return false;
    browserRegistry.registerWebContents({
      webContentsId: input.webContentsId,
      browserId: input.browserId,
      hostWebContentsId: input.sender.id,
      workspaceId: input.workspaceId,
      ...(input.profileAuthorization ? { profileAuthorization: input.profileAuthorization } : {}),
    });
    publisher.track(currentGuest);
    try {
      await publisher.publishCurrent(currentGuest);
    } catch (error) {
      browserRegistry.unregisterWebContents(input.webContentsId);
      throw error;
    }
    return true;
  });
}

function registerAttachedPaseoBrowserNow(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (!isAttachedBrowserGuestCurrent(input, guest)) return false;
  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
    workspaceId: input.workspaceId,
    ...(input.profileAuthorization ? { profileAuthorization: input.profileAuthorization } : {}),
  });
  return true;
}

function isAttachedBrowserGuestCurrent(
  input: RegisterAttachedBrowserInput,
  guest: RegisteredBrowserWebContents | null,
): guest is RegisteredBrowserWebContents {
  return Boolean(
    guest &&
    !guest.isDestroyed() &&
    guest.hostWebContents === input.sender &&
    guest.session === input.profileSession,
  );
}

export function getPaseoBrowserIdForWebContents(
  contents: BrowserWebContentsIdentity | null,
): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function getPaseoBrowserProfileAuthorizationForWebContents(
  contents: BrowserWebContentsIdentity | null,
): BrowserProfileRuntimeAuthorization | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getRegistrationForWebContents(contents.id)?.profileAuthorization ?? null;
}

export function unregisterPaseoBrowser(browserId: string): Promise<void> {
  const publisher = pageIdentityPublisher;
  if (!publisher) {
    browserRegistry.unregisterBrowser(browserId);
    return Promise.resolve();
  }
  const invalidation = publisher.invalidateBrowser(browserId);
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    browserRegistry.unregisterBrowser(browserId);
  });
}

export function unregisterPaseoBrowserFromHost(
  hostWebContentsId: number,
  browserId: string,
): Promise<void> {
  const publisher = pageIdentityPublisher;
  if (!publisher) {
    browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
    return Promise.resolve();
  }
  const invalidation = publisher.invalidateBrowser(browserId);
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
  });
}

export function unregisterPaseoBrowserHost(hostWebContentsId: number): Promise<void> {
  const publisher = pageIdentityPublisher;
  if (!publisher) {
    browserRegistry.unregisterHostWebContents(hostWebContentsId);
    return Promise.resolve();
  }
  const invalidation = publisher.invalidateHost(hostWebContentsId);
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    browserRegistry.unregisterHostWebContents(hostWebContentsId);
  });
}

export function getPaseoBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function listRegisteredPaseoBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry.listBrowserIdsForWorkspace(workspaceId);
}

export function listRegisteredPaseoBrowserIdsForProfile(input: {
  hostWebContentsId: number;
  authorization: BrowserProfileRuntimeAuthorization;
}): string[] {
  return browserRegistry.listBrowserIdsForProfile(input);
}

export function unregisterPaseoBrowserProfile(input: {
  hostWebContentsId: number;
  authorization: BrowserProfileRuntimeAuthorization;
}): Promise<number[]> {
  const browserIds = browserRegistry.listBrowserIdsForProfile(input);
  const publisher = pageIdentityPublisher;
  if (!publisher) return Promise.resolve(browserRegistry.unregisterProfile(input));
  const invalidation = Promise.all(
    browserIds.map((browserId) => publisher.invalidateBrowser(browserId)),
  );
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    return browserRegistry.unregisterProfile(input);
  });
}

function isPageIdentityExecutionAllowed(webContentsId: number): boolean {
  const registration = browserRegistry.getRegistrationForWebContents(webContentsId);
  if (!registration?.profileAuthorization) return true;
  return pageIdentityPublisher?.isExecutionAllowed(webContentsId) === true;
}

function invalidateWebContentsBeforeRelease(webContentsId: number): Promise<void> {
  const publisher = pageIdentityPublisher;
  if (!publisher) {
    browserRegistry.unregisterWebContents(webContentsId);
    return Promise.resolve();
  }
  const invalidation = publisher.invalidateWebContents(webContentsId);
  return enqueuePageIdentityLifecycle(async () => {
    await invalidation;
    browserRegistry.unregisterWebContents(webContentsId);
  });
}

function enqueuePageIdentityLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = pageIdentityLifecycleQueue.then(operation);
  pageIdentityLifecycleQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function setWorkspaceActivePaseoBrowserId(input: {
  hostWebContentsId: number;
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActivePaseoBrowserId(workspaceId: string): string | null {
  return browserRegistry.getMostRecentActiveBrowserIdForWorkspace(workspaceId);
}

export function getWorkspaceActivePaseoBrowserIdForHostWindow(
  workspaceId: string,
  hostWebContentsId: number,
): string | null {
  return browserRegistry.getActiveBrowserIdForWorkspaceInHostWindow(hostWebContentsId, workspaceId);
}

export function getPaseoBrowserWebContentsForHostWindow(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return guardPageIdentityExecution(contentsId, contents);
  }
  if (!contents || contents.isDestroyed()) {
    void invalidateWebContentsBeforeRelease(contentsId).catch(() => {});
  }
  return null;
}

export function getPaseoBrowserWebContentsForProfile(input: {
  browserId: string;
  hostWebContentsId: number;
  authorization: BrowserProfileRuntimeAuthorization;
}): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserProfile(input);
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return guardPageIdentityExecution(contentsId, contents);
  }
  if (!contents || contents.isDestroyed()) {
    void invalidateWebContentsBeforeRelease(contentsId).catch(() => {});
  }
  return null;
}

export function getActivePaseoBrowserWebContentsForHostWindow(
  hostWebContentsId: number,
): WebContents | null {
  const browserId = browserRegistry.getActiveBrowserIdForHostWindow(hostWebContentsId);
  if (!browserId) {
    return null;
  }
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return guardPageIdentityExecution(contentsId, contents);
  }
  if (!contents || contents.isDestroyed()) {
    void invalidateWebContentsBeforeRelease(contentsId).catch(() => {});
  }
  return null;
}

/**
 * Bootstrap-only view used by list_tabs/new_tab discovery. An enterprise guest remains hidden
 * until its server observation is acknowledged, but this view intentionally carries no action
 * handle. W1 must not use it for any other Browser command.
 */
export function getPaseoBrowserWebContentsForBootstrapDiscovery(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) return null;
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed() && isPageIdentityExecutionAllowed(contentsId)) {
    return contents;
  }
  if (!contents || contents.isDestroyed()) {
    void invalidateWebContentsBeforeRelease(contentsId).catch(() => {});
  }
  return null;
}

const guardedWebContentsMethods = new Set<PropertyKey>([
  "canGoBack",
  "canGoForward",
  "capturePage",
  "executeJavaScript",
  "focus",
  "getTitle",
  "getURL",
  "goBack",
  "goForward",
  "invalidate",
  "isLoading",
  "loadURL",
  "openDevTools",
  "reload",
  "sendInputEvent",
]);

function guardPageIdentityExecution(
  webContentsId: number,
  contents: WebContents,
): WebContents | null {
  const registration = browserRegistry.getRegistrationForWebContents(webContentsId);
  if (!registration?.profileAuthorization) return contents;
  const publisher = pageIdentityPublisher;
  const handle = publisher?.createExecutionHandle(webContentsId);
  if (!publisher || !handle) return null;
  return createGuardedWebContents(contents, publisher, handle);
}

function createGuardedWebContents(
  contents: WebContents,
  publisher: BrowserPageIdentityPublisher,
  handle: BrowserPageIdentityExecutionHandle,
): WebContents {
  const guardedDebugger = new Proxy(contents.debugger, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "sendCommand" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        publisher.assertExecutionCurrent(handle);
        return Reflect.apply(value, target, args);
      };
    },
  });
  return new Proxy(contents, {
    get(target, property) {
      if (property === "debugger") return guardedDebugger;
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!guardedWebContentsMethods.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        publisher.assertExecutionCurrent(handle);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function preventUnsafeBrowserWebviewNavigation(
  event: { preventDefault: () => void },
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
  }
}

export function registerBrowserWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-redirect", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
}
