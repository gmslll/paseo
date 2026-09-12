import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with PASEO_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";
export const HYDRATE_BROWSER_PROFILE_AUTHORIZATIONS_CHANNEL =
  "paseo:browser-profile:hydrate-authorizations";
export const REVOKE_BROWSER_PROFILE_GENERATION_CHANNEL = "paseo:browser-profile:revoke-generation";
const BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL = "paseo:browser:page-identity:mount";
const BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL = "paseo:browser:page-identity:dispose";
const BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL = "paseo:browser:page-identity:request";
const BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL = "paseo:browser:page-identity:response";

type EventHandler = (payload: unknown) => void;

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--paseo-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
  profile?: {
    organizationId: string;
    homeNodeId: string;
    workspaceId: string;
    browserProfileId: string;
    bindingRevision: string;
    lifecycleGeneration: string;
  };
}

interface BrowserPageIdentityTransportTicket {
  readonly version: 1;
  readonly routeId: string;
  readonly routeGeneration: string;
}

interface MountedBrowserPageIdentityTransport {
  readonly ticket: BrowserPageIdentityTransportTicket;
  readonly listener: (_event: Electron.IpcRendererEvent, payload: unknown) => void;
}

const BROWSER_PAGE_IDENTITY_FAILURE_CODES = new Set([
  "daemon_unavailable",
  "daemon_request_failed",
  "daemon_response_mismatch",
  "handler_sealed",
  "teardown_failed",
]);
let mountedBrowserPageIdentityTransport: MountedBrowserPageIdentityTransport | null = null;
let mountingBrowserPageIdentityTransport = false;

function readExactPageIdentityRecord(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some(
      (key) =>
        typeof key !== "string" || (!requiredKeys.includes(key) && !optionalKeys.includes(key)),
    )
  ) {
    return null;
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      return null;
    }
    record[key] = descriptor.value;
  }
  return record;
}

function readPageIdentityString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function parseBrowserPageIdentityTransportTicket(
  input: unknown,
): BrowserPageIdentityTransportTicket | null {
  const record = readExactPageIdentityRecord(input, ["routeGeneration", "routeId", "version"]);
  const routeId = readPageIdentityString(record?.routeId);
  const routeGeneration = readPageIdentityString(record?.routeGeneration);
  return record?.version === 1 && routeId && routeGeneration
    ? Object.freeze({ version: 1, routeId, routeGeneration })
    : null;
}

function parseBrowserPageIdentityBrowser(input: unknown): Readonly<Record<string, string>> | null {
  const record = readExactPageIdentityRecord(input, ["browserId", "browserProfileId"]);
  const browserId = readPageIdentityString(record?.browserId);
  const browserProfileId = readPageIdentityString(record?.browserProfileId);
  return browserId && browserProfileId ? Object.freeze({ browserId, browserProfileId }) : null;
}

function parseBrowserPageIdentityPayload(
  operation: "observe" | "invalidate",
  input: unknown,
): Readonly<Record<string, unknown>> | null {
  const record =
    operation === "observe"
      ? readExactPageIdentityRecord(
          input,
          ["bindingRevision", "browser", "hostname", "lifecycleGeneration", "observationRevision"],
          ["accountLabelHash"],
        )
      : readExactPageIdentityRecord(input, [
          "bindingRevision",
          "browser",
          "lifecycleGeneration",
          "observationRevision",
        ]);
  if (!record) return null;
  const browser = parseBrowserPageIdentityBrowser(record.browser);
  const bindingRevision = readPageIdentityString(record.bindingRevision);
  const lifecycleGeneration = readPageIdentityString(record.lifecycleGeneration);
  const observationRevision = readPageIdentityString(record.observationRevision);
  const hostname = operation === "observe" ? readPageIdentityString(record.hostname) : null;
  const accountLabelHash =
    operation === "observe" && record.accountLabelHash !== undefined
      ? readPageIdentityString(record.accountLabelHash)
      : null;
  if (
    !browser ||
    !bindingRevision ||
    !lifecycleGeneration ||
    !observationRevision ||
    (operation === "observe" && !hostname) ||
    (record.accountLabelHash !== undefined && !accountLabelHash)
  ) {
    return null;
  }
  return Object.freeze({
    browser,
    ...(hostname ? { hostname } : {}),
    ...(accountLabelHash ? { accountLabelHash } : {}),
    observationRevision,
    bindingRevision,
    lifecycleGeneration,
  });
}

function parseBrowserPageIdentityTransportRequest(
  ticket: BrowserPageIdentityTransportTicket,
  input: unknown,
): Readonly<Record<string, unknown>> | null {
  const base = readExactPageIdentityRecord(
    input,
    ["operation", "requestId", "routeGeneration", "routeId", "version"],
    ["payload"],
  );
  const requestId = readPageIdentityString(base?.requestId);
  if (
    base?.version !== 1 ||
    base.routeId !== ticket.routeId ||
    base.routeGeneration !== ticket.routeGeneration ||
    !requestId
  ) {
    return null;
  }
  if (base.operation === "fatal_teardown") {
    return base.payload === undefined
      ? Object.freeze({ requestId, operation: "fatal_teardown" })
      : null;
  }
  if (base.operation !== "observe" && base.operation !== "invalidate") return null;
  const payload = parseBrowserPageIdentityPayload(base.operation, base.payload);
  return payload ? Object.freeze({ requestId, operation: base.operation, payload }) : null;
}

function parseBrowserPageIdentityTransportResponse(
  input: unknown,
): Readonly<Record<string, unknown>> | null {
  const response = readExactPageIdentityRecord(input, ["operation", "requestId", "result"]);
  const requestId = readPageIdentityString(response?.requestId);
  if (
    !requestId ||
    (response?.operation !== "observe" &&
      response?.operation !== "invalidate" &&
      response?.operation !== "fatal_teardown")
  ) {
    return null;
  }
  const result = readExactPageIdentityRecord(response.result, ["ok"], ["acceptedRevision", "code"]);
  if (!result) return null;
  if (result.ok === false) {
    const code = readPageIdentityString(result.code);
    if (
      !code ||
      !BROWSER_PAGE_IDENTITY_FAILURE_CODES.has(code) ||
      result.acceptedRevision !== undefined
    ) {
      return null;
    }
    return Object.freeze({
      requestId,
      operation: response.operation,
      result: Object.freeze({ ok: false, code }),
    });
  }
  if (result.ok !== true || result.code !== undefined) return null;
  if (response.operation === "fatal_teardown") {
    return result.acceptedRevision === undefined
      ? Object.freeze({
          requestId,
          operation: response.operation,
          result: Object.freeze({ ok: true }),
        })
      : null;
  }
  const acceptedRevision = readPageIdentityString(result.acceptedRevision);
  return acceptedRevision
    ? Object.freeze({
        requestId,
        operation: response.operation,
        result: Object.freeze({ ok: true, acceptedRevision }),
      })
    : null;
}

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`paseo:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`paseo:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("paseo:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("paseo:window:minimize"),
      close: () => ipcRenderer.invoke("paseo:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("paseo:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("paseo:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("paseo:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("paseo:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("paseo:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("paseo:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("paseo:opener:openUrl", url),
  },
  editor: {
    listTargets: () => ipcRenderer.invoke("paseo:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("paseo:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    hydrateBrowserProfileAuthorizations: (input: {
      homeNodeId: string;
      authorizations: unknown[];
      lifecycleGeneration: string;
    }) => ipcRenderer.invoke(HYDRATE_BROWSER_PROFILE_AUTHORIZATIONS_CHANNEL, input),
    revokeBrowserProfileGeneration: (input: { homeNodeId: string; lifecycleGeneration: string }) =>
      ipcRenderer.invoke(REVOKE_BROWSER_PROFILE_GENERATION_CHANNEL, input),
    pageIdentityTransport: {
      mount: async (handler: (request: unknown) => void): Promise<void> => {
        if (
          typeof handler !== "function" ||
          mountingBrowserPageIdentityTransport ||
          mountedBrowserPageIdentityTransport
        ) {
          throw new Error("Browser page identity transport is already mounted or invalid.");
        }
        mountingBrowserPageIdentityTransport = true;
        const pendingRequests: unknown[] = [];
        let ticket: BrowserPageIdentityTransportTicket | null = null;
        const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
          if (!ticket) {
            if (pendingRequests.length < 16) pendingRequests.push(payload);
            return;
          }
          const request = parseBrowserPageIdentityTransportRequest(ticket, payload);
          if (request) handler(request);
        };
        ipcRenderer.on(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL, listener);
        try {
          ticket = parseBrowserPageIdentityTransportTicket(
            await ipcRenderer.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_MOUNT_CHANNEL),
          );
          if (!ticket) throw new Error("Invalid Browser page identity transport ticket.");
          mountedBrowserPageIdentityTransport = { ticket, listener };
          for (const payload of pendingRequests) {
            const request = parseBrowserPageIdentityTransportRequest(ticket, payload);
            if (request) handler(request);
          }
        } catch (error) {
          ipcRenderer.removeListener(BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL, listener);
          throw error;
        } finally {
          mountingBrowserPageIdentityTransport = false;
        }
      },
      dispose: async (): Promise<void> => {
        const mounted = mountedBrowserPageIdentityTransport;
        mountedBrowserPageIdentityTransport = null;
        if (!mounted) return;
        ipcRenderer.removeListener(
          BROWSER_PAGE_IDENTITY_TRANSPORT_REQUEST_CHANNEL,
          mounted.listener,
        );
        await ipcRenderer.invoke(BROWSER_PAGE_IDENTITY_TRANSPORT_DISPOSE_CHANNEL, mounted.ticket);
      },
      respond: (rawResponse: unknown): void => {
        const mounted = mountedBrowserPageIdentityTransport;
        const response = parseBrowserPageIdentityTransportResponse(rawResponse);
        if (!mounted || !response) {
          throw new Error("Invalid Browser page identity transport response.");
        }
        ipcRenderer.send(BROWSER_PAGE_IDENTITY_TRANSPORT_RESPONSE_CHANNEL, {
          version: 1,
          routeId: mounted.ticket.routeId,
          routeGeneration: mounted.ticket.routeGeneration,
          ...response,
        });
      },
    },
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("paseo:browser:set-shortcut-policy", input),
    profilePartition: PASEO_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("paseo:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("paseo:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("paseo:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("paseo:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
  },
});
