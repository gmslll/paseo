import {
  parseBrowserProfileRuntimeAuthorization,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";

export interface BrowserWorkspaceRegistration {
  browserId: string;
  workspaceId: string;
}

export interface BrowserWebContentsRegistration {
  browserId: string;
  hostWebContentsId: number;
  workspaceId?: string;
  profileAuthorization?: BrowserProfileRuntimeAuthorization;
}

export class PaseoBrowserWebviewRegistry {
  private readonly registrationsByWebContentsId = new Map<number, BrowserWebContentsRegistration>();
  private readonly webContentsIdsByHostAndBrowserId = new Map<string, number>();
  private readonly workspaceIdsByBrowserId = new Map<string, string>();
  private readonly activeBrowserIdsByHostWindow = new Map<number, Map<string, string>>();

  public registerWebContents(input: {
    webContentsId: number;
    browserId: string;
    hostWebContentsId: number;
    workspaceId?: string;
    profileAuthorization?: BrowserProfileRuntimeAuthorization;
  }): void {
    const snapshot = snapshotBrowserWebContentsRegistration(input);
    if (
      snapshot.profileAuthorization &&
      snapshot.workspaceId !== snapshot.profileAuthorization.workspaceId
    ) {
      throw new Error("Browser registration Workspace does not match its Profile authorization.");
    }
    for (const registration of this.registrationsByWebContentsId.values()) {
      if (
        registration.browserId === snapshot.browserId &&
        (registration.profileAuthorization !== undefined ||
          snapshot.profileAuthorization !== undefined) &&
        !browserRegistrationsShareRoute(registration, snapshot)
      ) {
        throw new Error("An existing Browser ID cannot change its host, Workspace, or Profile.");
      }
    }
    const hostBrowserKey = this.hostBrowserKey(snapshot.hostWebContentsId, snapshot.browserId);
    const replacedWebContentsId = this.webContentsIdsByHostAndBrowserId.get(hostBrowserKey);
    const existingRegistration = this.registrationsByWebContentsId.get(snapshot.webContentsId);
    if (
      replacedWebContentsId === snapshot.webContentsId &&
      existingRegistration?.browserId === snapshot.browserId &&
      existingRegistration.hostWebContentsId === snapshot.hostWebContentsId
    ) {
      return;
    }
    if (replacedWebContentsId !== undefined && replacedWebContentsId !== snapshot.webContentsId) {
      this.removeWebContents(replacedWebContentsId, { preserveActiveBrowser: true });
    }
    if (this.registrationsByWebContentsId.has(snapshot.webContentsId)) {
      this.removeWebContents(snapshot.webContentsId);
    }

    const registration = freezeBrowserWebContentsRegistration(snapshot);
    this.registrationsByWebContentsId.set(snapshot.webContentsId, registration);
    this.webContentsIdsByHostAndBrowserId.set(hostBrowserKey, snapshot.webContentsId);
    if (snapshot.workspaceId) {
      this.registerWorkspace({
        browserId: snapshot.browserId,
        workspaceId: snapshot.workspaceId,
      });
    }
  }

  public unregisterWebContents(webContentsId: number): void {
    if (!this.registrationsByWebContentsId.has(webContentsId)) {
      return;
    }

    this.removeWebContents(webContentsId);
  }

  public getBrowserIdForWebContents(webContentsId: number): string | null {
    return this.registrationsByWebContentsId.get(webContentsId)?.browserId ?? null;
  }

  public getRegistrationForWebContents(
    webContentsId: number,
  ): BrowserWebContentsRegistration | null {
    const registration = this.registrationsByWebContentsId.get(webContentsId);
    return registration ? freezeBrowserWebContentsRegistration(registration) : null;
  }

  public getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId: number,
    browserId: string,
  ): number | null {
    return (
      this.webContentsIdsByHostAndBrowserId.get(
        this.hostBrowserKey(hostWebContentsId, browserId),
      ) ?? null
    );
  }

  public listBrowserIds(): string[] {
    return Array.from(
      new Set(Array.from(this.registrationsByWebContentsId.values(), ({ browserId }) => browserId)),
    ).sort();
  }

  public registerWorkspace(input: BrowserWorkspaceRegistration): void {
    const existingWorkspaceId = this.workspaceIdsByBrowserId.get(input.browserId);
    if (existingWorkspaceId && existingWorkspaceId !== input.workspaceId) {
      throw new Error("An existing Browser ID cannot change its Workspace.");
    }
    this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
  }

  public unregisterBrowser(browserId: string): void {
    for (const [webContentsId, registration] of this.registrationsByWebContentsId) {
      if (registration.browserId === browserId) {
        this.registrationsByWebContentsId.delete(webContentsId);
        this.webContentsIdsByHostAndBrowserId.delete(
          this.hostBrowserKey(registration.hostWebContentsId, browserId),
        );
      }
    }
    this.workspaceIdsByBrowserId.delete(browserId);
    this.deleteActiveBrowserReferences(browserId);
  }

  public unregisterBrowserFromHost(hostWebContentsId: number, browserId: string): void {
    const webContentsId = this.getWebContentsIdForBrowserInHostWindow(hostWebContentsId, browserId);
    if (webContentsId !== null) {
      this.unregisterWebContents(webContentsId);
    }
  }

  public getWorkspaceId(browserId: string): string | null {
    return this.workspaceIdsByBrowserId.get(browserId) ?? null;
  }

  public hasBrowserInOtherHostWindow(hostWebContentsId: number, browserId: string): boolean {
    for (const registration of this.registrationsByWebContentsId.values()) {
      if (
        registration.browserId === browserId &&
        registration.hostWebContentsId !== hostWebContentsId
      ) {
        return true;
      }
    }
    return false;
  }

  public unregisterHostWebContents(hostWebContentsId: number): void {
    for (const [webContentsId, registration] of this.registrationsByWebContentsId) {
      if (registration.hostWebContentsId === hostWebContentsId) {
        this.unregisterWebContents(webContentsId);
      }
    }
    this.activeBrowserIdsByHostWindow.delete(hostWebContentsId);
  }

  public listBrowserIdsForWorkspace(workspaceId: string): string[] {
    return this.listBrowserIds().filter(
      (browserId) => this.workspaceIdsByBrowserId.get(browserId) === workspaceId,
    );
  }

  public listBrowserIdsForProfile(input: {
    hostWebContentsId: number;
    authorization: BrowserProfileRuntimeAuthorization;
  }): string[] {
    const route = snapshotBrowserProfileRoute(input);
    return Array.from(this.registrationsByWebContentsId.values())
      .filter(
        (registration) =>
          registration.hostWebContentsId === route.hostWebContentsId &&
          registration.profileAuthorization !== undefined &&
          browserProfileAuthorizationsEqual(registration.profileAuthorization, route.authorization),
      )
      .map((registration) => registration.browserId)
      .sort();
  }

  public getWebContentsIdForBrowserProfile(input: {
    hostWebContentsId: number;
    browserId: string;
    authorization: BrowserProfileRuntimeAuthorization;
  }): number | null {
    const route = snapshotBrowserProfileRoute(input, true);
    const contentsId = this.getWebContentsIdForBrowserInHostWindow(
      route.hostWebContentsId,
      route.browserId,
    );
    if (contentsId === null) {
      return null;
    }
    const registration = this.registrationsByWebContentsId.get(contentsId);
    return registration?.profileAuthorization &&
      browserProfileAuthorizationsEqual(registration.profileAuthorization, route.authorization)
      ? contentsId
      : null;
  }

  public unregisterProfile(input: {
    hostWebContentsId: number;
    authorization: BrowserProfileRuntimeAuthorization;
  }): number[] {
    const route = snapshotBrowserProfileRoute(input);
    const removedContentsIds: number[] = [];
    for (const [contentsId, registration] of this.registrationsByWebContentsId) {
      if (
        registration.hostWebContentsId === route.hostWebContentsId &&
        registration.profileAuthorization &&
        browserProfileAuthorizationsEqual(registration.profileAuthorization, route.authorization)
      ) {
        removedContentsIds.push(contentsId);
        this.removeWebContents(contentsId);
      }
    }
    return removedContentsIds;
  }

  public setWorkspaceActiveBrowser(input: {
    hostWebContentsId: number;
    workspaceId: string;
    browserId: string | null;
  }): void {
    if (input.browserId === null) {
      const activeBrowserIdsByWorkspace = this.activeBrowserIdsByHostWindow.get(
        input.hostWebContentsId,
      );
      if (!activeBrowserIdsByWorkspace) {
        return;
      }
      activeBrowserIdsByWorkspace.delete(input.workspaceId);
      if (activeBrowserIdsByWorkspace.size === 0) {
        this.activeBrowserIdsByHostWindow.delete(input.hostWebContentsId);
      }
      return;
    }
    if (this.hasBrowser(input.browserId)) {
      this.workspaceIdsByBrowserId.set(input.browserId, input.workspaceId);
    }
    const activeBrowserIdsByWorkspace =
      this.activeBrowserIdsByHostWindow.get(input.hostWebContentsId) ?? new Map<string, string>();
    activeBrowserIdsByWorkspace.delete(input.workspaceId);
    activeBrowserIdsByWorkspace.set(input.workspaceId, input.browserId);
    this.activeBrowserIdsByHostWindow.delete(input.hostWebContentsId);
    this.activeBrowserIdsByHostWindow.set(input.hostWebContentsId, activeBrowserIdsByWorkspace);
  }

  public getActiveBrowserIdForHostWindow(hostWebContentsId: number): string | null {
    return (
      Array.from(this.activeBrowserIdsByHostWindow.get(hostWebContentsId)?.values() ?? []).at(-1) ??
      null
    );
  }

  public getActiveBrowserIdForWorkspaceInHostWindow(
    hostWebContentsId: number,
    workspaceId: string,
  ): string | null {
    return this.activeBrowserIdsByHostWindow.get(hostWebContentsId)?.get(workspaceId) ?? null;
  }

  public getMostRecentActiveBrowserIdForWorkspace(workspaceId: string): string | null {
    const activeBrowserIdsByHostWindow = Array.from(this.activeBrowserIdsByHostWindow.values());
    for (let index = activeBrowserIdsByHostWindow.length - 1; index >= 0; index -= 1) {
      const browserId = activeBrowserIdsByHostWindow[index].get(workspaceId);
      if (browserId) {
        return browserId;
      }
    }
    return null;
  }

  private deleteActiveBrowserReferences(browserId: string): void {
    for (const [hostWebContentsId, activeBrowserIdsByWorkspace] of this
      .activeBrowserIdsByHostWindow) {
      for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspace) {
        if (activeBrowserId === browserId) {
          activeBrowserIdsByWorkspace.delete(workspaceId);
        }
      }
      if (activeBrowserIdsByWorkspace.size === 0) {
        this.activeBrowserIdsByHostWindow.delete(hostWebContentsId);
      }
    }
  }

  private deleteActiveBrowserReferencesInHostWindow(
    browserId: string,
    hostWebContentsId: number,
  ): void {
    const activeBrowserIdsByWorkspace = this.activeBrowserIdsByHostWindow.get(hostWebContentsId);
    if (!activeBrowserIdsByWorkspace) {
      return;
    }
    for (const [workspaceId, activeBrowserId] of activeBrowserIdsByWorkspace) {
      if (activeBrowserId === browserId) {
        activeBrowserIdsByWorkspace.delete(workspaceId);
      }
    }
    if (activeBrowserIdsByWorkspace.size === 0) {
      this.activeBrowserIdsByHostWindow.delete(hostWebContentsId);
    }
  }

  private removeWebContents(
    webContentsId: number,
    options: { preserveActiveBrowser?: boolean } = {},
  ): void {
    const registration = this.registrationsByWebContentsId.get(webContentsId);
    if (!registration) {
      return;
    }
    const { browserId, hostWebContentsId } = registration;

    this.registrationsByWebContentsId.delete(webContentsId);
    this.webContentsIdsByHostAndBrowserId.delete(this.hostBrowserKey(hostWebContentsId, browserId));

    if (
      !options.preserveActiveBrowser &&
      !this.hasBrowserInHostWindow(browserId, hostWebContentsId)
    ) {
      this.deleteActiveBrowserReferencesInHostWindow(browserId, hostWebContentsId);
    }
  }

  private hasBrowser(browserId: string): boolean {
    return Array.from(this.registrationsByWebContentsId.values()).some(
      (registration) => registration.browserId === browserId,
    );
  }

  private hasBrowserInHostWindow(browserId: string, hostWebContentsId: number): boolean {
    return this.webContentsIdsByHostAndBrowserId.has(
      this.hostBrowserKey(hostWebContentsId, browserId),
    );
  }

  private hostBrowserKey(hostWebContentsId: number, browserId: string): string {
    return `${hostWebContentsId}:${browserId}`;
  }
}

function snapshotBrowserWebContentsRegistration(input: unknown): {
  webContentsId: number;
  browserId: string;
  hostWebContentsId: number;
  workspaceId?: string;
  profileAuthorization?: BrowserProfileRuntimeAuthorization;
} {
  const record = readStableRecord(
    input,
    ["browserId", "hostWebContentsId", "profileAuthorization", "webContentsId", "workspaceId"],
    ["browserId", "hostWebContentsId", "webContentsId"],
    "Browser WebContents registration",
  );
  const webContentsId = parsePositiveSafeInteger(record.webContentsId, "WebContents ID");
  const hostWebContentsId = parsePositiveSafeInteger(
    record.hostWebContentsId,
    "host WebContents ID",
  );
  const browserId = parseNonEmptyString(record.browserId, "Browser ID");
  const workspaceId =
    record.workspaceId === undefined
      ? undefined
      : parseNonEmptyString(record.workspaceId, "Workspace ID");
  const profileAuthorization =
    record.profileAuthorization === undefined
      ? undefined
      : parseBrowserProfileRuntimeAuthorization(record.profileAuthorization);
  return {
    webContentsId,
    browserId,
    hostWebContentsId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(profileAuthorization ? { profileAuthorization } : {}),
  };
}

function snapshotBrowserProfileRoute(input: unknown): {
  hostWebContentsId: number;
  authorization: BrowserProfileRuntimeAuthorization;
};
function snapshotBrowserProfileRoute(
  input: unknown,
  includeBrowserId: true,
): {
  hostWebContentsId: number;
  browserId: string;
  authorization: BrowserProfileRuntimeAuthorization;
};
function snapshotBrowserProfileRoute(
  input: unknown,
  includeBrowserId = false,
):
  | {
      hostWebContentsId: number;
      browserId: string;
      authorization: BrowserProfileRuntimeAuthorization;
    }
  | {
      hostWebContentsId: number;
      authorization: BrowserProfileRuntimeAuthorization;
    } {
  const allowedKeys = includeBrowserId
    ? ["authorization", "browserId", "hostWebContentsId"]
    : ["authorization", "hostWebContentsId"];
  const record = readStableRecord(input, allowedKeys, allowedKeys, "Browser Profile route");
  const common = {
    hostWebContentsId: parsePositiveSafeInteger(record.hostWebContentsId, "host WebContents ID"),
    authorization: parseBrowserProfileRuntimeAuthorization(record.authorization),
  };
  return includeBrowserId
    ? { ...common, browserId: parseNonEmptyString(record.browserId, "Browser ID") }
    : common;
}

function freezeBrowserWebContentsRegistration(
  input: BrowserWebContentsRegistration,
): BrowserWebContentsRegistration {
  return Object.freeze({
    browserId: input.browserId,
    hostWebContentsId: input.hostWebContentsId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.profileAuthorization
      ? {
          profileAuthorization: parseBrowserProfileRuntimeAuthorization(input.profileAuthorization),
        }
      : {}),
  });
}

function readStableRecord(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    symbols = Object.getOwnPropertySymbols(input);
  } catch {
    throw new Error(`${label} cannot be inspected.`);
  }
  const keys = Object.keys(descriptors);
  if (
    symbols.length > 0 ||
    keys.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function parsePositiveSafeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return input as number;
}

function parseNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.trim() !== input) {
    throw new Error(`Invalid ${label}.`);
  }
  return input;
}

function browserRegistrationsShareRoute(
  existing: BrowserWebContentsRegistration,
  next: {
    hostWebContentsId: number;
    workspaceId?: string;
    profileAuthorization?: BrowserProfileRuntimeAuthorization;
  },
): boolean {
  if (
    existing.hostWebContentsId !== next.hostWebContentsId ||
    existing.workspaceId !== next.workspaceId
  ) {
    return false;
  }
  if (!existing.profileAuthorization || !next.profileAuthorization) {
    return existing.profileAuthorization === next.profileAuthorization;
  }
  return browserProfileAuthorizationsEqual(
    existing.profileAuthorization,
    next.profileAuthorization,
  );
}

function browserProfileAuthorizationsEqual(
  left: BrowserProfileRuntimeAuthorization,
  right: BrowserProfileRuntimeAuthorization,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.homeNodeId === right.homeNodeId &&
    left.workspaceId === right.workspaceId &&
    left.browserProfileId === right.browserProfileId &&
    left.bindingRevision === right.bindingRevision &&
    left.lifecycleGeneration === right.lifecycleGeneration
  );
}
