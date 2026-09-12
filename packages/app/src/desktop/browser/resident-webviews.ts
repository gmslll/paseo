import {
  getDesktopHost,
  type DesktopAttachedBrowserRegistration,
  type DesktopBrowserBridge,
} from "@/desktop/host";
import type { BrowserViewport } from "@/desktop/browser/store";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";

const RESIDENT_BROWSER_HOST_ID = "paseo-browser-resident-webviews";
const BROWSER_ID_ATTRIBUTE = "data-paseo-browser-id";
const BROWSER_SURFACE_ATTRIBUTE = "data-paseo-browser-surface";
const PROFILE_WORKSPACE_ATTRIBUTE = "data-paseo-workspace-id";
const PROFILE_ORGANIZATION_ATTRIBUTE = "data-paseo-organization-id";
const PROFILE_HOME_NODE_ATTRIBUTE = "data-paseo-home-node-id";
const PROFILE_ID_ATTRIBUTE = "data-paseo-browser-profile-id";
const PROFILE_BINDING_ATTRIBUTE = "data-paseo-binding-revision";
const PROFILE_LIFECYCLE_ATTRIBUTE = "data-paseo-lifecycle-generation";
const ENTERPRISE_BROWSER_PROFILE_ID_PATTERN = /^brp_[0-9a-f]{16}$/;
const ENTERPRISE_ORGANIZATION_ID_PATTERN = /^org_[0-9a-f]{16}$/;
const ENTERPRISE_NODE_ID_PATTERN = /^nod_[0-9a-f]{16}$/;
const RESIDENT_VIEWPORT_WIDTH = 1280;
const RESIDENT_VIEWPORT_HEIGHT = 800;

const residentWebviewsByBrowserId = new Map<string, HTMLElement>();
const residentSurfacesByBrowserId = new Map<string, HTMLElement>();
const residentWebviewSizesByBrowserId = new Map<string, { width: number; height: number }>();
const browserProfilesByBrowserId = new Map<string, BrowserProfileAuthorizationResult>();

interface BrowserWebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
}

interface BrowserWebviewIdentity {
  browserId: string;
  workspaceId: string;
  profile?: BrowserProfileRuntimeSelector;
}

export interface BrowserProfileRuntimeAuthorization {
  organizationId: string;
  homeNodeId: string;
  workspaceId: string;
  browserProfileId: string;
  bindingRevision: string;
  lifecycleGeneration: string;
}

export type BrowserProfileRuntimeSelector = Pick<
  BrowserProfileRuntimeAuthorization,
  | "organizationId"
  | "homeNodeId"
  | "workspaceId"
  | "browserProfileId"
  | "bindingRevision"
  | "lifecycleGeneration"
>;

export interface BrowserProfileAuthorizationResult {
  authorization: BrowserProfileRuntimeAuthorization;
  partition: string;
}

export interface BrowserWebviewProfileHost {
  profilePartition: string;
  registerAttachedBrowser(
    input: DesktopAttachedBrowserRegistration & { profile?: BrowserProfileRuntimeSelector },
  ): Promise<void>;
}

function isAttachedBrowserBridge(browser: DesktopBrowserBridge | undefined): boolean {
  return (
    browser !== undefined &&
    typeof browser.profilePartition === "string" &&
    browser.profilePartition.startsWith("persist:") &&
    typeof browser.registerAttachedBrowser === "function"
  );
}

function getBrowserBridge(override?: BrowserWebviewProfileHost): BrowserWebviewProfileHost {
  if (override) {
    return override;
  }
  const browser = getDesktopHost()?.browser;
  if (!isAttachedBrowserBridge(browser)) {
    throw new Error("Electron browser profile bridge is unavailable");
  }
  return browser as BrowserWebviewProfileHost;
}

function registerBrowserWhenAttached(
  webview: BrowserWebviewElement,
  identity: BrowserWebviewIdentity,
  browser: BrowserWebviewProfileHost,
): void {
  // Reparenting a webview can replace its guest WebContents without replacing
  // this DOM element, so every attachment needs a fresh main-process registration.
  webview.addEventListener("did-attach", () => {
    const webContentsId = webview.getWebContentsId();
    void browser
      .registerAttachedBrowser({
        browserId: identity.browserId,
        workspaceId: identity.workspaceId,
        webContentsId,
        ...(identity.profile ? { profile: identity.profile } : {}),
      })
      .catch((error) => {
        console.error("[browser-webview] attached registration failed", error);
      });
  });
}

function browserProfileResultsEqual(
  left: BrowserProfileAuthorizationResult,
  right: BrowserProfileAuthorizationResult,
): boolean {
  return (
    left.partition === right.partition &&
    left.authorization.organizationId === right.authorization.organizationId &&
    left.authorization.homeNodeId === right.authorization.homeNodeId &&
    left.authorization.workspaceId === right.authorization.workspaceId &&
    left.authorization.browserProfileId === right.authorization.browserProfileId &&
    left.authorization.bindingRevision === right.authorization.bindingRevision &&
    left.authorization.lifecycleGeneration === right.authorization.lifecycleGeneration
  );
}

function rememberBrowserProfile(
  browserId: string,
  profile: BrowserProfileAuthorizationResult,
): void {
  const snapshot = parseBrowserProfileAuthorizationResult(profile);
  const existing = browserProfilesByBrowserId.get(browserId);
  if (existing && !browserProfileResultsEqual(existing, snapshot)) {
    throw new Error("An existing Browser ID cannot change its Workspace or Profile binding.");
  }
  browserProfilesByBrowserId.set(browserId, snapshot);
}

export function getBrowserWebviewProfile(
  browserId: string,
): BrowserProfileAuthorizationResult | null {
  const profile = browserProfilesByBrowserId.get(browserId);
  return profile ? parseBrowserProfileAuthorizationResult(profile) : null;
}

export function inheritBrowserWebviewProfile(sourceBrowserId: string, browserId: string): void {
  const profile = browserProfilesByBrowserId.get(sourceBrowserId);
  if (profile) {
    rememberBrowserProfile(browserId, profile);
  }
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function applyResidentHostParkingStyle(host: HTMLElement): void {
  // The host is permanent. Individual browser surfaces switch between their
  // pane bounds and the proven paintable 1x1 parking geometry.
  host.removeAttribute("aria-hidden");
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.overflow = "visible";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.display = "block";
  host.style.zIndex = String(WEB_SURFACE_PLANE.browser);
  host.style.clipPath = "";
  host.style.visibility = "visible";
  host.style.transform = "";
}

function applyParkedBrowserSurfaceStyle(surface: HTMLElement): void {
  surface.setAttribute("aria-hidden", "true");
  surface.style.position = "fixed";
  surface.style.left = "0";
  surface.style.top = "0";
  surface.style.width = "1px";
  surface.style.height = "1px";
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = "none";
  surface.style.display = "block";
  surface.style.visibility = "visible";
  surface.style.transform = "";
}

function getBrowserSurface(browserId: string, ownerDocument: Document): HTMLElement {
  const existing = residentSurfacesByBrowserId.get(browserId);
  if (existing?.isConnected) {
    return existing;
  }
  const surface = ownerDocument.createElement("div");
  surface.setAttribute(BROWSER_SURFACE_ATTRIBUTE, browserId);
  applyParkedBrowserSurfaceStyle(surface);
  getResidentBrowserHost(ownerDocument).appendChild(surface);
  residentSurfacesByBrowserId.set(browserId, surface);
  return surface;
}

function getResidentBrowserHost(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(RESIDENT_BROWSER_HOST_ID);
  if (existing) {
    applyResidentHostParkingStyle(existing);
    return existing;
  }

  const host = ownerDocument.createElement("div");
  host.id = RESIDENT_BROWSER_HOST_ID;
  applyResidentHostParkingStyle(host);
  ownerDocument.body.appendChild(host);
  return host;
}

function findBrowserWebview(browserId: string, ownerDocument: Document): HTMLElement | null {
  for (const element of ownerDocument.querySelectorAll(`[${BROWSER_ID_ATTRIBUTE}]`)) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (element.getAttribute(BROWSER_ID_ATTRIBUTE) === browserId) {
      return element;
    }
  }
  return null;
}

function dimensionsForBrowser(browserId: string | null): { width: number; height: number } {
  if (!browserId) {
    return { width: RESIDENT_VIEWPORT_WIDTH, height: RESIDENT_VIEWPORT_HEIGHT };
  }
  return (
    residentWebviewSizesByBrowserId.get(browserId) ?? {
      width: RESIDENT_VIEWPORT_WIDTH,
      height: RESIDENT_VIEWPORT_HEIGHT,
    }
  );
}

function applyResidentWebviewStyle(webview: HTMLElement, browserId: string | null): void {
  const dimensions = dimensionsForBrowser(browserId);
  webview.style.display = "inline-flex";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${dimensions.width}px`;
  webview.style.height = `${dimensions.height}px`;
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.position = "absolute";
  webview.style.left = "0";
  webview.style.top = "0";
  webview.style.marginTop = "0";
  webview.style.zIndex = "0";
}

function clearResidentWebviewParkingStyle(webview: HTMLElement): void {
  webview.style.position = "";
  webview.style.left = "";
  webview.style.top = "";
  webview.style.marginTop = "";
  webview.style.zIndex = "";
}

export function rememberBrowserWebviewSize(input: {
  browserId: string;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId || input.width <= 0 || input.height <= 0) {
    return null;
  }
  const dimensions = {
    width: Math.max(1, Math.round(input.width)),
    height: Math.max(1, Math.round(input.height)),
  };
  residentWebviewSizesByBrowserId.set(browserId, dimensions);
  return dimensions;
}

function applyBrowserWebviewDimensions(
  webview: HTMLElement,
  dimensions: { width: number; height: number },
): void {
  webview.style.display = "flex";
  webview.style.border = "0";
  webview.style.background = "transparent";
  webview.style.flex = "0 0 auto";
  webview.style.width = `${Math.max(1, Math.round(dimensions.width))}px`;
  webview.style.height = `${Math.max(1, Math.round(dimensions.height))}px`;
}

export function applyInactiveBrowserWebviewViewport(
  browserId: string,
  webview: HTMLElement,
  viewport: BrowserViewport,
): void {
  if (viewport.mode === "fixed") {
    rememberBrowserWebviewSize({ browserId, width: viewport.width, height: viewport.height });
  }
  applyResidentWebviewStyle(webview, trimNonEmpty(browserId));
}

export function presentBrowserWebview(
  browserId: string,
  webview: HTMLElement,
  anchor: HTMLElement,
  clip: HTMLElement,
  viewport: BrowserViewport,
): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  if (webview.parentElement !== surface) {
    surface.appendChild(webview);
  }
  const anchorBounds = anchor.getBoundingClientRect();
  const clipBounds = clip.getBoundingClientRect();
  const left = Math.max(anchorBounds.left, clipBounds.left);
  const top = Math.max(anchorBounds.top, clipBounds.top);
  const right = Math.min(
    anchorBounds.left + anchorBounds.width,
    clipBounds.left + clipBounds.width,
  );
  const bottom = Math.min(
    anchorBounds.top + anchorBounds.height,
    clipBounds.top + clipBounds.height,
  );
  const surfaceLeft = Math.ceil(left);
  const surfaceTop = Math.ceil(top);
  const surfaceRight = Math.floor(right);
  const surfaceBottom = Math.floor(bottom);
  const hasVisibleArea = surfaceRight > surfaceLeft && surfaceBottom > surfaceTop;
  surface.setAttribute("aria-hidden", "false");
  surface.style.position = "fixed";
  surface.style.left = `${surfaceLeft}px`;
  surface.style.top = `${surfaceTop}px`;
  surface.style.width = `${Math.max(0, surfaceRight - surfaceLeft)}px`;
  surface.style.height = `${Math.max(0, surfaceBottom - surfaceTop)}px`;
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = hasVisibleArea ? "auto" : "none";
  surface.style.display = "flex";
  surface.style.visibility = "visible";
  clearResidentWebviewParkingStyle(webview);
  applyBrowserWebviewDimensions(
    webview,
    viewport.mode === "responsive"
      ? { width: anchorBounds.width, height: anchorBounds.height }
      : viewport,
  );
  webview.style.position = "absolute";
  webview.style.left = `${Math.round(anchorBounds.left - surfaceLeft)}px`;
  webview.style.top = `${Math.round(anchorBounds.top - surfaceTop)}px`;
}

export function prepareBrowserWebview(
  webview: HTMLElement,
  input: {
    browserId: string;
    workspaceId: string;
    initialUrl?: string | null;
    profile?: BrowserProfileAuthorizationResult;
    profileHost?: BrowserWebviewProfileHost;
  },
): void {
  const browser = getBrowserBridge(input.profileHost);
  const profileInput = input.profile;
  if (profileInput) {
    rememberBrowserProfile(input.browserId, profileInput);
  }
  const profile = browserProfilesByBrowserId.get(input.browserId);
  if (profile && profile.authorization.workspaceId !== input.workspaceId) {
    throw new Error("Browser Profile authorization does not match the Browser Workspace.");
  }
  webview.setAttribute(BROWSER_ID_ATTRIBUTE, input.browserId);
  webview.setAttribute("partition", profile?.partition ?? browser.profilePartition);
  if (profile) {
    webview.setAttribute(PROFILE_ORGANIZATION_ATTRIBUTE, profile.authorization.organizationId);
    webview.setAttribute(PROFILE_HOME_NODE_ATTRIBUTE, profile.authorization.homeNodeId);
    webview.setAttribute(PROFILE_WORKSPACE_ATTRIBUTE, profile.authorization.workspaceId);
    webview.setAttribute(PROFILE_ID_ATTRIBUTE, profile.authorization.browserProfileId);
    webview.setAttribute(PROFILE_BINDING_ATTRIBUTE, profile.authorization.bindingRevision);
    webview.setAttribute(PROFILE_LIFECYCLE_ATTRIBUTE, profile.authorization.lifecycleGeneration);
  }
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  if (input.initialUrl) {
    (webview as BrowserWebviewElement).src = input.initialUrl;
  }
  registerBrowserWhenAttached(
    webview as BrowserWebviewElement,
    {
      browserId: input.browserId,
      workspaceId: input.workspaceId,
      ...(profile
        ? {
            profile: {
              organizationId: profile.authorization.organizationId,
              homeNodeId: profile.authorization.homeNodeId,
              workspaceId: profile.authorization.workspaceId,
              browserProfileId: profile.authorization.browserProfileId,
              bindingRevision: profile.authorization.bindingRevision,
              lifecycleGeneration: profile.authorization.lifecycleGeneration,
            },
          }
        : {}),
    },
    browser,
  );
}

export function ensureResidentBrowserWebview(input: {
  browserId: string;
  workspaceId: string;
  url: string;
  profile?: BrowserProfileAuthorizationResult;
  profileHost?: BrowserWebviewProfileHost;
}): HTMLElement | null {
  const browserId = trimNonEmpty(input.browserId);
  if (!browserId) {
    return null;
  }
  const profileInput = input.profile;
  if (profileInput) {
    rememberBrowserProfile(browserId, profileInput);
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return null;
  }

  const resident = residentWebviewsByBrowserId.get(browserId) ?? null;
  if (resident?.isConnected) {
    releaseResidentBrowserWebview(browserId, resident);
    return resident;
  }

  const existing = findBrowserWebview(browserId, ownerDocument);
  if (existing) {
    if (existing.parentElement?.id === RESIDENT_BROWSER_HOST_ID) {
      releaseResidentBrowserWebview(browserId, existing);
    }
    return existing;
  }

  const webview = ownerDocument.createElement("webview") as BrowserWebviewElement;
  prepareBrowserWebview(webview, {
    browserId,
    workspaceId: input.workspaceId,
    initialUrl: input.url,
    ...(profileInput ? { profile: browserProfilesByBrowserId.get(browserId)! } : {}),
    profileHost: input.profileHost,
  });
  releaseResidentBrowserWebview(browserId, webview);
  return webview;
}

export function parseBrowserProfileAuthorizationResult(
  input: unknown,
): BrowserProfileAuthorizationResult {
  const result = readExactStableRecord(
    input,
    ["authorization", "partition"],
    "Browser Profile authorization result",
  );
  const authorizationInput = readExactStableRecord(
    result.authorization,
    [
      "bindingRevision",
      "browserProfileId",
      "homeNodeId",
      "lifecycleGeneration",
      "organizationId",
      "workspaceId",
    ],
    "Browser Profile runtime authorization",
  );
  const authorization = Object.freeze({
    organizationId: parsePattern(
      authorizationInput.organizationId,
      ENTERPRISE_ORGANIZATION_ID_PATTERN,
      "organization ID",
    ),
    homeNodeId: parsePattern(
      authorizationInput.homeNodeId,
      ENTERPRISE_NODE_ID_PATTERN,
      "home node ID",
    ),
    workspaceId: parseNonEmpty(authorizationInput.workspaceId, "Workspace ID"),
    browserProfileId: parsePattern(
      authorizationInput.browserProfileId,
      ENTERPRISE_BROWSER_PROFILE_ID_PATTERN,
      "Browser Profile ID",
    ),
    bindingRevision: parseNonEmpty(authorizationInput.bindingRevision, "binding revision"),
    lifecycleGeneration: parseNonEmpty(
      authorizationInput.lifecycleGeneration,
      "lifecycle generation",
    ),
  });
  const partition = parseNonEmpty(result.partition, "Browser Profile partition");
  if (partition !== `persist:paseo-enterprise-${authorization.browserProfileId}`) {
    throw new Error("Browser Profile partition does not match its authorized Profile.");
  }
  return Object.freeze({ authorization, partition });
}

function readExactStableRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid ${label}.`);
  }
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    symbols = Object.getOwnPropertySymbols(input);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  const keys = Object.keys(descriptors).sort();
  if (
    symbols.length > 0 ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Invalid ${label} fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`Invalid ${label} field ${key}.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function parsePattern(input: unknown, pattern: RegExp, label: string): string {
  if (typeof input !== "string" || !pattern.test(input)) {
    throw new Error(`Invalid ${label}.`);
  }
  return input;
}

function parseNonEmpty(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input) {
    throw new Error(`Invalid ${label}.`);
  }
  return input;
}

export function getResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (resident?.isConnected) {
    return resident;
  }
  const ownerDocument = readDocument();
  return ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
}

export function takeResidentBrowserWebview(browserId: string): HTMLElement | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }

  const webview = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  if (!webview) {
    return null;
  }

  return webview;
}

export function releaseResidentBrowserWebview(browserId: string, webview: HTMLElement): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    webview.remove();
    return;
  }
  const ownerDocument = readDocument();
  if (!ownerDocument) {
    return;
  }

  residentWebviewsByBrowserId.set(normalizedBrowserId, webview);
  applyResidentWebviewStyle(webview, normalizedBrowserId);
  const surface = getBrowserSurface(normalizedBrowserId, ownerDocument);
  applyParkedBrowserSurfaceStyle(surface);
  if (webview.parentElement !== surface) {
    surface.appendChild(webview);
  }
}

export function resizeResidentBrowserWebview(input: {
  browserId: string;
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const normalizedBrowserId = trimNonEmpty(input.browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  const dimensions = rememberBrowserWebviewSize(input);
  if (!dimensions) {
    return null;
  }

  const ownerDocument = readDocument();
  const webview = ownerDocument ? findBrowserWebview(normalizedBrowserId, ownerDocument) : null;
  if (webview) {
    applyBrowserWebviewDimensions(webview, dimensions);
  }

  return dimensions;
}

export function removeResidentBrowserWebview(browserId: string): void {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return;
  }

  const resident = residentWebviewsByBrowserId.get(normalizedBrowserId) ?? null;
  const surface = residentSurfacesByBrowserId.get(normalizedBrowserId) ?? null;
  residentWebviewsByBrowserId.delete(normalizedBrowserId);
  residentSurfacesByBrowserId.delete(normalizedBrowserId);
  residentWebviewSizesByBrowserId.delete(normalizedBrowserId);
  browserProfilesByBrowserId.delete(normalizedBrowserId);
  resident?.remove();
  surface?.remove();
}

export function clearResidentBrowserWebviewsForTests(): void {
  for (const webview of residentWebviewsByBrowserId.values()) {
    webview.remove();
  }
  residentWebviewsByBrowserId.clear();
  residentSurfacesByBrowserId.clear();
  residentWebviewSizesByBrowserId.clear();
  browserProfilesByBrowserId.clear();
  readDocument()?.getElementById(RESIDENT_BROWSER_HOST_ID)?.remove();
}
