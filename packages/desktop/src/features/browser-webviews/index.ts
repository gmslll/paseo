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

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new PaseoBrowserWebviewRegistry();

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
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

export function preparePaseoBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  contents.setBackgroundThrottling(false);
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
  });
}

export function registerAttachedPaseoBrowser(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.hostWebContents !== input.sender ||
    guest.session !== input.profileSession
  ) {
    return false;
  }

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
    workspaceId: input.workspaceId,
    ...(input.profileAuthorization ? { profileAuthorization: input.profileAuthorization } : {}),
  });
  return true;
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

export function unregisterPaseoBrowser(browserId: string): void {
  browserRegistry.unregisterBrowser(browserId);
}

export function unregisterPaseoBrowserFromHost(hostWebContentsId: number, browserId: string): void {
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
}

export function unregisterPaseoBrowserHost(hostWebContentsId: number): void {
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
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
}): number[] {
  return browserRegistry.unregisterProfile(input);
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
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
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
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
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
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
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
