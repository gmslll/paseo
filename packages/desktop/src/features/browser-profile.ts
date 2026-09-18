import path from "node:path";

export const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";
const ENTERPRISE_BROWSER_PROFILE_ID_PATTERN = /^brp_[0-9a-f]{16}$/;
const ENTERPRISE_ORGANIZATION_ID_PATTERN = /^org_[0-9a-f]{16}$/;
const ENTERPRISE_NODE_ID_PATTERN = /^nod_[0-9a-f]{16}$/;
const ENTERPRISE_LEASE_ID_PATTERN =
  /^lea_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_BROWSER_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;
const MAX_LEGACY_BROWSER_PROFILES = 1000;

const PASEO_BROWSER_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "shadercache",
] as const;

interface BrowserProfileSession {
  clearStorageData(options: {
    storages: Array<(typeof PASEO_BROWSER_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface BrowserProfileGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
}

interface BrowserProfileWebContents extends BrowserProfileGuest {
  readonly session: object;
  getType(): string;
}

interface ListBrowserProfileGuestsInput {
  profileSession: object;
  webContents: BrowserProfileWebContents[];
}

interface ClearBrowserProfileInput {
  profileSessions: BrowserProfileSession[];
  listGuests(): BrowserProfileGuest[];
  logReloadError(guestId: number, error: unknown): void;
}

interface ElectronSessions {
  fromPartition(partition: string): BrowserProfileSession;
}

export interface BrowserProfileRuntimeAuthorization {
  organizationId: string;
  homeNodeId: string;
  workspaceId: string;
  browserProfileId: string;
  bindingRevision: string;
  lifecycleGeneration: string;
}

export interface BrowserProfileRuntimeSelector {
  organizationId: string;
  homeNodeId: string;
  workspaceId: string;
  browserProfileId: string;
  bindingRevision: string;
  lifecycleGeneration: string;
}

export interface BrowserProfileLeaseContext {
  browserProfileId: string;
  nodeId: string;
  leaseId: string;
  fencingToken: number;
  leaseRevision: string;
}

const RUNTIME_AUTHORIZATION_KEYS = [
  "bindingRevision",
  "browserProfileId",
  "homeNodeId",
  "lifecycleGeneration",
  "organizationId",
  "workspaceId",
] as const;
const RUNTIME_SELECTOR_KEYS = [
  "bindingRevision",
  "browserProfileId",
  "homeNodeId",
  "lifecycleGeneration",
  "organizationId",
  "workspaceId",
] as const;
const LEASE_CONTEXT_KEYS = [
  "browserProfileId",
  "fencingToken",
  "leaseId",
  "leaseRevision",
  "nodeId",
] as const;

export function getEnterpriseBrowserProfilePartition(browserProfileId: string): string {
  return `persist:paseo-enterprise-${parseBrowserProfileId(browserProfileId)}`;
}

export function getEnterpriseBrowserProfileDownloadRoot(
  trustedBaseRoot: string,
  browserProfileId: string,
): string {
  if (typeof trustedBaseRoot !== "string" || trustedBaseRoot.trim().length === 0) {
    throw new Error("Invalid trusted Browser Profile download root.");
  }
  return path.join(
    path.resolve(trustedBaseRoot),
    parseBrowserProfileId(browserProfileId),
    "downloads",
  );
}

export function parseBrowserProfileRuntimeAuthorization(
  input: unknown,
): BrowserProfileRuntimeAuthorization {
  const record = parseExactRecord(input, RUNTIME_AUTHORIZATION_KEYS, "runtime authorization");
  const authorization = {
    organizationId: parsePattern(
      record.organizationId,
      ENTERPRISE_ORGANIZATION_ID_PATTERN,
      "organization ID",
    ),
    homeNodeId: parsePattern(record.homeNodeId, ENTERPRISE_NODE_ID_PATTERN, "home node ID"),
    workspaceId: parseNonEmpty(record.workspaceId, "workspace ID"),
    browserProfileId: parseBrowserProfileId(record.browserProfileId),
    bindingRevision: parseNonEmpty(record.bindingRevision, "binding revision"),
    lifecycleGeneration: parseNonEmpty(record.lifecycleGeneration, "lifecycle generation"),
  };
  return deepFreezeClone(authorization);
}

export function parseBrowserProfileRuntimeNodeId(input: unknown): string {
  return parsePattern(input, ENTERPRISE_NODE_ID_PATTERN, "home node ID");
}

export function parseBrowserProfileRuntimeSelector(input: unknown): BrowserProfileRuntimeSelector {
  const record = parseExactRecord(input, RUNTIME_SELECTOR_KEYS, "runtime selector");
  return Object.freeze({
    organizationId: parsePattern(
      record.organizationId,
      ENTERPRISE_ORGANIZATION_ID_PATTERN,
      "organization ID",
    ),
    homeNodeId: parsePattern(record.homeNodeId, ENTERPRISE_NODE_ID_PATTERN, "home node ID"),
    workspaceId: parseNonEmpty(record.workspaceId, "workspace ID"),
    browserProfileId: parseBrowserProfileId(record.browserProfileId),
    bindingRevision: parseNonEmpty(record.bindingRevision, "binding revision"),
    lifecycleGeneration: parseNonEmpty(record.lifecycleGeneration, "lifecycle generation"),
  });
}

export function parseBrowserProfileLeaseContext(input: unknown): BrowserProfileLeaseContext {
  const record = parseExactRecord(input, LEASE_CONTEXT_KEYS, "lease context");
  if (
    typeof record.fencingToken !== "number" ||
    !Number.isSafeInteger(record.fencingToken) ||
    record.fencingToken < 0
  ) {
    throw new Error("Invalid Browser Profile fencing token.");
  }
  return Object.freeze({
    browserProfileId: parseBrowserProfileId(record.browserProfileId),
    nodeId: parsePattern(record.nodeId, ENTERPRISE_NODE_ID_PATTERN, "node ID"),
    leaseId: parsePattern(record.leaseId, ENTERPRISE_LEASE_ID_PATTERN, "lease ID"),
    fencingToken: record.fencingToken,
    leaseRevision: parseNonEmpty(record.leaseRevision, "lease revision"),
  });
}

export class BrowserProfileRuntimeAuthorizationRegistry {
  private readonly authorizations = new Map<string, BrowserProfileRuntimeAuthorization>();
  private readonly lifecycleByHost = new Map<number, string>();

  private readonly trustedNodeId: string;

  public constructor(trustedNodeId: string) {
    this.trustedNodeId = parsePattern(trustedNodeId, ENTERPRISE_NODE_ID_PATTERN, "trusted node ID");
  }

  public hydrateGeneration(
    hostWebContentsId: number,
    authorizations: readonly unknown[],
    lifecycleGeneration: string,
  ): readonly BrowserProfileRuntimeAuthorization[] {
    assertHostWebContentsId(hostWebContentsId);
    const parsed = authorizations.map((value) => {
      const authorization = parseBrowserProfileRuntimeAuthorization(value);
      if (
        authorization.lifecycleGeneration !== lifecycleGeneration ||
        authorization.homeNodeId !== this.trustedNodeId
      )
        throw new Error("Invalid Browser Profile generation.");
      return authorization;
    });
    const keys = parsed.map((authorization) =>
      runtimeAuthorizationKey(hostWebContentsId, authorization),
    );
    if (new Set(keys).size !== keys.length)
      throw new Error("Duplicate Browser Profile authorization.");
    const previous = [...this.authorizations.entries()].filter(([key]) =>
      key.startsWith(`[${hostWebContentsId},`),
    );
    const revoked = previous
      .filter(
        ([key, old]) =>
          !keys.includes(key) || !parsed.some((next) => runtimeAuthorizationsEqual(next, old)),
      )
      .map(([, old]) => old);
    for (const [key] of previous) this.authorizations.delete(key);
    this.lifecycleByHost.set(hostWebContentsId, lifecycleGeneration);
    for (const authorization of parsed)
      this.authorizations.set(
        runtimeAuthorizationKey(hostWebContentsId, authorization),
        authorization,
      );
    return Object.freeze(revoked.map(cloneRuntimeAuthorization));
  }

  public revokeGeneration(
    hostWebContentsId: number,
    lifecycleGeneration: string,
  ): readonly BrowserProfileRuntimeAuthorization[] {
    assertHostWebContentsId(hostWebContentsId);
    if (this.lifecycleByHost.get(hostWebContentsId) !== lifecycleGeneration)
      return Object.freeze([]);
    return Object.freeze(this.revokeHost(hostWebContentsId).map(cloneRuntimeAuthorization));
  }

  public hydrate(
    hostWebContentsId: number,
    input: unknown,
  ): {
    authorization: BrowserProfileRuntimeAuthorization;
    revoked: readonly BrowserProfileRuntimeAuthorization[];
  } {
    assertHostWebContentsId(hostWebContentsId);
    const authorization = parseBrowserProfileRuntimeAuthorization(input);
    if (authorization.homeNodeId !== this.trustedNodeId) {
      throw new Error("Browser Profile is not authorized for this Desktop node.");
    }
    const currentGeneration = this.lifecycleByHost.get(hostWebContentsId);
    const revoked: BrowserProfileRuntimeAuthorization[] =
      currentGeneration && currentGeneration !== authorization.lifecycleGeneration
        ? [...this.revokeHost(hostWebContentsId)]
        : [];
    this.lifecycleByHost.set(hostWebContentsId, authorization.lifecycleGeneration);
    const key = runtimeAuthorizationKey(hostWebContentsId, authorization);
    const existing = this.authorizations.get(key);
    if (existing && !runtimeAuthorizationsEqual(existing, authorization)) {
      revoked.push(existing);
    }
    this.authorizations.set(key, authorization);
    return Object.freeze({
      authorization: cloneRuntimeAuthorization(authorization),
      revoked: Object.freeze(revoked.map(cloneRuntimeAuthorization)),
    });
  }

  public resolve(input: {
    hostWebContentsId: number;
    organizationId: string;
    homeNodeId: string;
    workspaceId: string;
    browserProfileId: string;
  }): BrowserProfileRuntimeAuthorization | null {
    const values = parseExactRecord(
      input,
      ["browserProfileId", "homeNodeId", "hostWebContentsId", "organizationId", "workspaceId"],
      "runtime lookup",
    );
    assertHostWebContentsId(values.hostWebContentsId as number);
    const organizationId = parsePattern(
      values.organizationId,
      ENTERPRISE_ORGANIZATION_ID_PATTERN,
      "organization ID",
    );
    const homeNodeId = parsePattern(values.homeNodeId, ENTERPRISE_NODE_ID_PATTERN, "home node ID");
    if (homeNodeId !== this.trustedNodeId) {
      return null;
    }
    const workspaceId = parseNonEmpty(values.workspaceId, "workspace ID");
    const browserProfileId = parseBrowserProfileId(values.browserProfileId);
    const authorization = this.authorizations.get(
      runtimeAuthorizationKey(values.hostWebContentsId as number, {
        organizationId,
        homeNodeId,
        workspaceId,
        browserProfileId,
      }),
    );
    if (
      !authorization ||
      this.lifecycleByHost.get(values.hostWebContentsId as number) !==
        authorization.lifecycleGeneration
    ) {
      return null;
    }
    return cloneRuntimeAuthorization(authorization);
  }

  public resolveExact(
    hostWebContentsId: number,
    input: unknown,
  ): BrowserProfileRuntimeAuthorization | null {
    const selector = parseBrowserProfileRuntimeSelector(input);
    const authorization = this.resolve({
      hostWebContentsId,
      organizationId: selector.organizationId,
      homeNodeId: selector.homeNodeId,
      workspaceId: selector.workspaceId,
      browserProfileId: selector.browserProfileId,
    });
    return authorization &&
      authorization.bindingRevision === selector.bindingRevision &&
      authorization.lifecycleGeneration === selector.lifecycleGeneration
      ? authorization
      : null;
  }

  public resolveLease(input: {
    hostWebContentsId: number;
    organizationId: string;
    workspaceId: string;
    leaseContext: unknown;
  }): {
    authorization: BrowserProfileRuntimeAuthorization;
    leaseContext: BrowserProfileLeaseContext;
  } | null {
    const values = parseExactRecord(
      input,
      ["hostWebContentsId", "leaseContext", "organizationId", "workspaceId"],
      "lease lookup",
    );
    assertHostWebContentsId(values.hostWebContentsId as number);
    const organizationId = parsePattern(
      values.organizationId,
      ENTERPRISE_ORGANIZATION_ID_PATTERN,
      "organization ID",
    );
    const workspaceId = parseNonEmpty(values.workspaceId, "workspace ID");
    const leaseContext = parseBrowserProfileLeaseContext(values.leaseContext);
    const authorization = this.resolve({
      hostWebContentsId: values.hostWebContentsId as number,
      organizationId,
      homeNodeId: leaseContext.nodeId,
      workspaceId,
      browserProfileId: leaseContext.browserProfileId,
    });
    if (!authorization || authorization.homeNodeId !== leaseContext.nodeId) {
      return null;
    }
    return Object.freeze({
      authorization: cloneRuntimeAuthorization(authorization),
      leaseContext: deepFreezeClone(leaseContext),
    });
  }

  public hasBrowserProfile(browserProfileId: string): boolean {
    const normalizedProfileId = parseBrowserProfileId(browserProfileId);
    return Array.from(this.authorizations.values()).some(
      (authorization) => authorization.browserProfileId === normalizedProfileId,
    );
  }

  public revoke(
    hostWebContentsId: number,
    input: unknown,
  ): readonly BrowserProfileRuntimeAuthorization[] {
    assertHostWebContentsId(hostWebContentsId);
    const authorization = parseBrowserProfileRuntimeAuthorization(input);
    const key = runtimeAuthorizationKey(hostWebContentsId, authorization);
    const existing = this.authorizations.get(key);
    if (!existing || !runtimeAuthorizationsEqual(existing, authorization)) {
      return [];
    }
    this.authorizations.delete(key);
    if (!this.hasHostAuthorization(hostWebContentsId)) {
      this.lifecycleByHost.delete(hostWebContentsId);
    }
    return Object.freeze([cloneRuntimeAuthorization(existing)]);
  }

  public revokeHost(hostWebContentsId: number): readonly BrowserProfileRuntimeAuthorization[] {
    assertHostWebContentsId(hostWebContentsId);
    const revoked: BrowserProfileRuntimeAuthorization[] = [];
    const prefix = `[${hostWebContentsId},`;
    for (const [key, authorization] of this.authorizations) {
      if (key.startsWith(prefix)) {
        this.authorizations.delete(key);
        revoked.push(cloneRuntimeAuthorization(authorization));
      }
    }
    this.lifecycleByHost.delete(hostWebContentsId);
    return Object.freeze(revoked);
  }

  private hasHostAuthorization(hostWebContentsId: number): boolean {
    const prefix = `[${hostWebContentsId},`;
    return Array.from(this.authorizations.keys()).some((key) => key.startsWith(prefix));
  }
}

export function getPaseoBrowserProfileSession(sessions: ElectronSessions): BrowserProfileSession {
  return sessions.fromPartition(PASEO_BROWSER_PROFILE_PARTITION);
}

export function readLegacyPaseoBrowserIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const browserIds = new Set<string>();
  for (const value of input) {
    if (typeof value === "string" && LEGACY_BROWSER_ID_PATTERN.test(value)) {
      browserIds.add(value);
      if (browserIds.size >= MAX_LEGACY_BROWSER_PROFILES) {
        break;
      }
    }
  }
  return [...browserIds];
}

export function getPaseoBrowserProfileSessions(
  sessions: ElectronSessions,
  legacyBrowserIds: string[],
): [BrowserProfileSession, ...BrowserProfileSession[]] {
  return [
    getPaseoBrowserProfileSession(sessions),
    // COMPAT(browserProfile): added in v0.1.108; remove after 2027-01-15.
    ...legacyBrowserIds.map((browserId) =>
      sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${browserId}`),
    ),
  ];
}

export function getLegacyPaseoBrowserProfileSession(
  sessions: ElectronSessions,
  browserId: string,
): BrowserProfileSession | null {
  const [legacyBrowserId] = readLegacyPaseoBrowserIds([browserId]);
  return legacyBrowserId
    ? sessions.fromPartition(`${PASEO_BROWSER_PROFILE_PARTITION}-${legacyBrowserId}`)
    : null;
}

export function listPaseoBrowserProfileGuests(
  input: ListBrowserProfileGuestsInput,
): BrowserProfileGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      contents.session === input.profileSession,
  );
}

export async function clearPaseoBrowserProfile(input: ClearBrowserProfileInput): Promise<void> {
  await Promise.all(
    input.profileSessions.flatMap((profileSession) => [
      profileSession.clearStorageData({ storages: [...PASEO_BROWSER_STORAGE_TYPES] }),
      profileSession.clearCache(),
      profileSession.clearAuthCache(),
    ]),
  );

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}

function parseBrowserProfileId(input: unknown): string {
  return parsePattern(input, ENTERPRISE_BROWSER_PROFILE_ID_PATTERN, "browser Profile ID");
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

function parseExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Invalid Browser Profile ${label}.`);
  }
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    symbols = Object.getOwnPropertySymbols(input);
  } catch {
    throw new Error(`Invalid Browser Profile ${label}.`);
  }
  const keys = Object.keys(descriptors).sort();
  if (
    symbols.length > 0 ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Invalid Browser Profile ${label} fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`Invalid Browser Profile ${label} field ${key}.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function cloneRuntimeAuthorization(
  authorization: BrowserProfileRuntimeAuthorization,
): BrowserProfileRuntimeAuthorization {
  return deepFreezeClone({ ...authorization });
}

function deepFreezeClone<T extends object>(input: T): T {
  return Object.freeze({ ...input }) as T;
}

function assertHostWebContentsId(input: number): void {
  if (!Number.isSafeInteger(input) || input <= 0) {
    throw new Error("Invalid host WebContents ID.");
  }
}

function runtimeAuthorizationKey(
  hostWebContentsId: number,
  input: Pick<
    BrowserProfileRuntimeAuthorization,
    "organizationId" | "homeNodeId" | "workspaceId" | "browserProfileId"
  >,
): string {
  return JSON.stringify([
    hostWebContentsId,
    input.organizationId,
    input.homeNodeId,
    input.workspaceId,
    input.browserProfileId,
  ]);
}

function runtimeAuthorizationsEqual(
  left: BrowserProfileRuntimeAuthorization,
  right: BrowserProfileRuntimeAuthorization,
): boolean {
  return RUNTIME_AUTHORIZATION_KEYS.every((key) => left[key] === right[key]);
}
