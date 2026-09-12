import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import {
  EnterpriseBrowserPageIdentityInvalidationRequestSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
  type EnterpriseBrowserPageIdentityInvalidationRequest,
  type EnterpriseBrowserPageIdentityObservationRequest,
} from "@getpaseo/protocol/messages";
import type { BrowserProfileRuntimeAuthorization } from "../browser-profile.js";
import {
  isPaseoBrowserWebviewRegistry,
  type BrowserWebContentsRegistration,
  type PaseoBrowserWebviewRegistry,
} from "./registry.js";

const accountReaderBrand = Symbol("BrowserPageAccountLabelHashReader");
const authorityTeardownBrand = Symbol("BrowserPageIdentityAuthorityTeardownPort");
const executionHandleBrand = Symbol("BrowserPageIdentityExecutionHandle");
const publisherBrand = Symbol("BrowserPageIdentityPublisher");
const accountReaders = new WeakSet<object>();
const authorityTeardownPorts = new WeakSet<object>();
const executionHandleRecords = new WeakMap<object, BrowserPageIdentityExecutionHandleRecord>();
const publishers = new WeakSet<object>();
const ObservationPayloadSchema = EnterpriseBrowserPageIdentityObservationRequestSchema.omit({
  type: true,
  requestId: true,
});
const InvalidationPayloadSchema = EnterpriseBrowserPageIdentityInvalidationRequestSchema.omit({
  type: true,
  requestId: true,
});

export type BrowserPageIdentityObservationPayload = Omit<
  EnterpriseBrowserPageIdentityObservationRequest,
  "type" | "requestId"
>;
export type BrowserPageIdentityInvalidationPayload = Omit<
  EnterpriseBrowserPageIdentityInvalidationRequest,
  "type" | "requestId"
>;

export interface BrowserPageIdentityWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BrowserPageAccountLabelHashReader {
  readonly [accountReaderBrand]: true;
  read(
    contents: BrowserPageIdentityWebContents,
    authorization: BrowserProfileRuntimeAuthorization,
  ): Promise<string | undefined>;
}

export interface BrowserPageIdentityAuthorityTeardownPort {
  readonly [authorityTeardownBrand]: true;
  teardownAfterAuthorityTransportFailure(error: Error): Promise<void> | void;
}

export interface BrowserPageIdentityExecutionHandle {
  readonly [executionHandleBrand]: true;
}

export interface BrowserPageIdentityPublisher {
  readonly [publisherBrand]: true;
  track(contents: BrowserPageIdentityWebContents): void;
  publishCurrent(contents: BrowserPageIdentityWebContents): Promise<void>;
  invalidateWebContents(webContentsId: number): Promise<void>;
  invalidateBrowser(browserId: string): Promise<void>;
  invalidateHost(hostWebContentsId: number): Promise<void>;
  createExecutionHandle(webContentsId: number): BrowserPageIdentityExecutionHandle | null;
  assertExecutionCurrent(handle: BrowserPageIdentityExecutionHandle): void;
  isExecutionAllowed(webContentsId: number): boolean;
  close(): Promise<void>;
}

interface TrackedContents {
  readonly contents: BrowserPageIdentityWebContents;
  readonly listeners: ReadonlyMap<string, (...args: unknown[]) => void>;
  epoch: number;
  executionAllowed: boolean;
  currentIdentity: PublishedPageIdentity | null;
}

interface PublishedPageIdentity {
  readonly registration: BrowserWebContentsRegistration;
  readonly invalidation: BrowserPageIdentityInvalidationPayload;
}

interface BrowserPageIdentityExecutionHandleRecord {
  readonly publisher: BrowserPageIdentityPublisher;
  readonly state: TrackedContents;
  readonly epoch: number;
  readonly identity: PublishedPageIdentity;
}

export function createBrowserPageAccountLabelHashReader(input: {
  readonly read: (
    contents: BrowserPageIdentityWebContents,
    authorization: BrowserProfileRuntimeAuthorization,
  ) => Promise<string | undefined>;
}): BrowserPageAccountLabelHashReader {
  const record = readExactStableRecord(input, ["read"], "Browser account label hash reader");
  if (typeof record.read !== "function") throw new Error("Invalid Browser account hash reader.");
  const read = record.read as BrowserPageAccountLabelHashReader["read"];
  const reader = Object.freeze({
    [accountReaderBrand]: true as const,
    read: (
      contents: BrowserPageIdentityWebContents,
      authorization: BrowserProfileRuntimeAuthorization,
    ) => Reflect.apply(read, undefined, [contents, authorization]),
  });
  accountReaders.add(reader);
  return reader;
}

export function createBrowserPageIdentityAuthorityTeardownPort(input: {
  readonly teardownAfterAuthorityTransportFailure: (error: Error) => Promise<void> | void;
}): BrowserPageIdentityAuthorityTeardownPort {
  const record = readExactStableRecord(
    input,
    ["teardownAfterAuthorityTransportFailure"],
    "Browser page identity authority teardown port",
  );
  if (typeof record.teardownAfterAuthorityTransportFailure !== "function") {
    throw new Error("Invalid Browser page identity authority teardown port.");
  }
  const teardown = record.teardownAfterAuthorityTransportFailure as (
    error: Error,
  ) => Promise<void> | void;
  const port = Object.freeze({
    [authorityTeardownBrand]: true as const,
    teardownAfterAuthorityTransportFailure: (error: Error) =>
      Reflect.apply(teardown, undefined, [error]),
  });
  authorityTeardownPorts.add(port);
  return port;
}

export function isBrowserPageIdentityPublisher(
  value: unknown,
): value is BrowserPageIdentityPublisher {
  return typeof value === "object" && value !== null && publishers.has(value);
}

export function createBrowserPageIdentityPublisher(input: {
  readonly registry: PaseoBrowserWebviewRegistry;
  readonly publish: (payload: BrowserPageIdentityObservationPayload) => Promise<void> | void;
  readonly invalidate: (payload: BrowserPageIdentityInvalidationPayload) => Promise<void> | void;
  readonly authorityTeardown: BrowserPageIdentityAuthorityTeardownPort;
  readonly accountLabelHashReader?: BrowserPageAccountLabelHashReader;
  readonly createObservationRevision?: () => string;
  readonly onError?: (error: Error) => void;
}): BrowserPageIdentityPublisher {
  const record = readExactStableRecord(
    input,
    [
      "accountLabelHashReader",
      "authorityTeardown",
      "createObservationRevision",
      "invalidate",
      "onError",
      "publish",
      "registry",
    ],
    "Browser page identity publisher",
    true,
  );
  if (
    !isPaseoBrowserWebviewRegistry(record.registry) ||
    typeof record.publish !== "function" ||
    typeof record.invalidate !== "function" ||
    typeof record.authorityTeardown !== "object" ||
    record.authorityTeardown === null ||
    !authorityTeardownPorts.has(record.authorityTeardown)
  ) {
    throw new Error("Invalid Browser page identity publisher ports.");
  }
  if (
    record.accountLabelHashReader !== undefined &&
    (typeof record.accountLabelHashReader !== "object" ||
      record.accountLabelHashReader === null ||
      !accountReaders.has(record.accountLabelHashReader))
  ) {
    throw new Error("Invalid Browser account label hash reader.");
  }
  if (
    record.createObservationRevision !== undefined &&
    typeof record.createObservationRevision !== "function"
  ) {
    throw new Error("Invalid Browser observation revision factory.");
  }
  if (record.onError !== undefined && typeof record.onError !== "function") {
    throw new Error("Invalid Browser page identity error sink.");
  }
  const registry = record.registry as PaseoBrowserWebviewRegistry;
  const publish = record.publish as (
    payload: BrowserPageIdentityObservationPayload,
  ) => Promise<void> | void;
  const invalidateRemote = record.invalidate as (
    payload: BrowserPageIdentityInvalidationPayload,
  ) => Promise<void> | void;
  const authorityTeardown = record.authorityTeardown as BrowserPageIdentityAuthorityTeardownPort;
  const reader = record.accountLabelHashReader as BrowserPageAccountLabelHashReader | undefined;
  const createRevision =
    (record.createObservationRevision as (() => string) | undefined) ??
    (() => `page-${randomUUID()}`);
  const onError = (record.onError as ((error: Error) => void) | undefined) ?? (() => {});
  const tracked = new Map<number, TrackedContents>();
  let closed = false;
  let transportQueue = Promise.resolve();
  let fatalTransportFailure: Error | null = null;
  let authorityTeardownPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  const reportError = (error: unknown): void => {
    try {
      onError(toError(error));
    } catch {
      // An error sink cannot restore page-identity authority.
    }
  };
  const enqueueTransport = (operation: () => Promise<void>): Promise<void> => {
    const result = transportQueue.then(operation);
    transportQueue = result.catch(reportError);
    return result;
  };
  const teardownAuthority = async (failure: unknown): Promise<void> => {
    fatalTransportFailure ??= toError(failure);
    if (!authorityTeardownPromise) {
      authorityTeardownPromise = Promise.resolve().then(() =>
        authorityTeardown.teardownAfterAuthorityTransportFailure(fatalTransportFailure!),
      );
    }
    try {
      await authorityTeardownPromise;
    } catch (error) {
      reportError(error);
    }
  };
  const invalidateState = (state: TrackedContents, detach: boolean): Promise<void> => {
    state.epoch += 1;
    state.executionAllowed = false;
    if (detach) {
      for (const [event, listener] of state.listeners) {
        state.contents.removeListener(event, listener);
      }
      if (tracked.get(state.contents.id) === state) tracked.delete(state.contents.id);
    }
    return enqueueTransport(async () => {
      const current = state.currentIdentity;
      if (fatalTransportFailure) throw fatalTransportFailure;
      if (!current) return;
      try {
        await invalidateRemote(current.invalidation);
      } catch (error) {
        await teardownAuthority(error);
        throw error;
      }
      if (state.currentIdentity === current) state.currentIdentity = null;
    });
  };
  const invalidateWebContents = (webContentsId: number): Promise<void> => {
    if (fatalTransportFailure) return Promise.reject(fatalTransportFailure);
    const state = tracked.get(webContentsId);
    return state ? invalidateState(state, true) : transportQueue;
  };
  const ensureTracked = (contents: BrowserPageIdentityWebContents): TrackedContents => {
    const existing = tracked.get(contents.id);
    if (existing?.contents === contents) return existing;
    if (existing) void invalidateState(existing, true).catch(() => {});
    const state: TrackedContents = {
      contents,
      listeners: new Map(),
      epoch: 0,
      executionAllowed: false,
      currentIdentity: null,
    };
    tracked.set(contents.id, state);
    return state;
  };
  const publishObserved = async (
    contents: BrowserPageIdentityWebContents,
    url: string,
    epoch: number,
  ): Promise<void> => {
    if (closed || fatalTransportFailure || contents.isDestroyed()) return;
    const registration = registry.getRegistrationForWebContents(contents.id);
    const authorization = registration?.profileAuthorization;
    if (!registration || !authorization) return;
    let accountLabelHash: string | undefined;
    if (reader) {
      try {
        accountLabelHash = await reader.read(contents, authorization);
      } catch (error) {
        reportError(error);
      }
    }
    const state = tracked.get(contents.id);
    if (
      closed ||
      contents.isDestroyed() ||
      !state ||
      state.contents !== contents ||
      state.epoch !== epoch ||
      !sameRegistration(registration, registry.getRegistrationForWebContents(contents.id))
    ) {
      return;
    }
    const observationRevision = createRevision();
    const payload = ObservationPayloadSchema.parse({
      browser: {
        browserId: registration.browserId,
        browserProfileId: authorization.browserProfileId,
      },
      hostname: hostnameFromUrl(url),
      ...(accountLabelHash !== undefined ? { accountLabelHash } : {}),
      observationRevision,
      bindingRevision: authorization.bindingRevision,
      lifecycleGeneration: authorization.lifecycleGeneration,
    });
    const invalidation = InvalidationPayloadSchema.parse({
      browser: payload.browser,
      bindingRevision: payload.bindingRevision,
      lifecycleGeneration: payload.lifecycleGeneration,
      observationRevision: payload.observationRevision,
    });
    await enqueueTransport(async () => {
      if (
        closed ||
        fatalTransportFailure ||
        contents.isDestroyed() ||
        tracked.get(contents.id) !== state ||
        state.epoch !== epoch ||
        !sameRegistration(registration, registry.getRegistrationForWebContents(contents.id))
      ) {
        return;
      }
      const previous = state.currentIdentity;
      if (previous) {
        try {
          await invalidateRemote(previous.invalidation);
        } catch (error) {
          await teardownAuthority(error);
          throw error;
        }
        if (state.currentIdentity === previous) state.currentIdentity = null;
      }
      try {
        await publish(payload);
      } catch (error) {
        await teardownAuthority(error);
        throw error;
      }
      state.currentIdentity = Object.freeze({ registration, invalidation });
      state.executionAllowed = true;
    });
  };
  const schedule = (contents: BrowserPageIdentityWebContents, url: string): Promise<void> => {
    const state = ensureTracked(contents);
    state.executionAllowed = false;
    const epoch = ++state.epoch;
    return publishObserved(contents, url, epoch);
  };
  const track = (contents: BrowserPageIdentityWebContents): void => {
    if (closed || contents.isDestroyed()) return;
    const state = ensureTracked(contents);
    if (state.listeners.size > 0) return;
    const listeners = state.listeners as Map<string, (...args: unknown[]) => void>;
    const add = (event: string, listener: (...args: unknown[]) => void): void => {
      listeners.set(event, listener);
      contents.on(event, listener);
    };
    add("did-start-navigation", (...args) => {
      if (args[3] !== true) return;
      void invalidateState(ensureTracked(contents), false).catch(() => {});
    });
    const publishCommitted = (...args: unknown[]): void => {
      const url = args.find((value) => typeof value === "string");
      void schedule(contents, typeof url === "string" ? url : contents.getURL()).catch(reportError);
    };
    add("did-navigate", publishCommitted);
    add("did-navigate-in-page", (...args) => {
      if (args[2] === true) publishCommitted(...args);
    });
    add("destroyed", () => void invalidateWebContents(contents.id).catch(() => {}));
  };

  const publisher: BrowserPageIdentityPublisher = Object.freeze({
    [publisherBrand]: true as const,
    track,
    publishCurrent: (contents: BrowserPageIdentityWebContents) =>
      schedule(contents, contents.getURL()),
    invalidateWebContents,
    invalidateBrowser: async (browserId: string) => {
      if (fatalTransportFailure) throw fatalTransportFailure;
      const invalidations: Promise<void>[] = [];
      for (const [webContentsId, state] of tracked) {
        const registration = registry.getRegistrationForWebContents(webContentsId);
        if (
          registration?.browserId === browserId ||
          state.currentIdentity?.registration.browserId === browserId
        ) {
          invalidations.push(invalidateState(state, true));
        }
      }
      await Promise.all(invalidations);
    },
    invalidateHost: async (hostWebContentsId: number) => {
      if (fatalTransportFailure) throw fatalTransportFailure;
      const invalidations: Promise<void>[] = [];
      for (const [webContentsId, state] of tracked) {
        const registration = registry.getRegistrationForWebContents(webContentsId);
        if (
          registration?.hostWebContentsId === hostWebContentsId ||
          state.currentIdentity?.registration.hostWebContentsId === hostWebContentsId
        ) {
          invalidations.push(invalidateState(state, true));
        }
      }
      await Promise.all(invalidations);
    },
    createExecutionHandle: (webContentsId: number) => {
      if (closed || fatalTransportFailure) return null;
      const state = tracked.get(webContentsId);
      if (!state?.executionAllowed || !state.currentIdentity) return null;
      if (
        !sameRegistration(
          state.currentIdentity.registration,
          registry.getRegistrationForWebContents(webContentsId),
        )
      ) {
        return null;
      }
      const handle = Object.freeze({ [executionHandleBrand]: true as const });
      executionHandleRecords.set(handle, {
        publisher,
        state,
        epoch: state.epoch,
        identity: state.currentIdentity,
      });
      return handle;
    },
    assertExecutionCurrent: (handle: BrowserPageIdentityExecutionHandle) => {
      const proof =
        typeof handle === "object" && handle !== null
          ? executionHandleRecords.get(handle)
          : undefined;
      if (
        !proof ||
        proof.publisher !== publisher ||
        closed ||
        fatalTransportFailure ||
        !proof.state.executionAllowed ||
        proof.state.epoch !== proof.epoch ||
        proof.state.currentIdentity !== proof.identity ||
        tracked.get(proof.state.contents.id) !== proof.state ||
        proof.state.contents.isDestroyed() ||
        !sameRegistration(
          proof.identity.registration,
          registry.getRegistrationForWebContents(proof.state.contents.id),
        )
      ) {
        throw new Error("Browser page identity execution is no longer current.");
      }
    },
    isExecutionAllowed: (webContentsId: number) => {
      if (closed || fatalTransportFailure) return false;
      const state = tracked.get(webContentsId);
      if (!state?.executionAllowed || !state.currentIdentity) return false;
      return sameRegistration(
        state.currentIdentity.registration,
        registry.getRegistrationForWebContents(webContentsId),
      );
    },
    close: () => {
      if (!closePromise) {
        closed = true;
        closePromise = (async () => {
          await Promise.allSettled(
            [...tracked.values()].map((state) => invalidateState(state, true)),
          );
          await transportQueue;
        })();
      }
      return closePromise;
    },
  });
  publishers.add(publisher);
  return publisher;
}

function sameRegistration(
  left: BrowserWebContentsRegistration,
  right: BrowserWebContentsRegistration | null,
): boolean {
  return right !== null && right.registrationRevision === left.registrationRevision;
}

function hostnameFromUrl(value: string): string {
  const hostname = new URL(value).hostname;
  const ascii = domainToASCII(hostname.toLowerCase());
  if (!ascii) throw new Error("Browser page URL has no observable hostname.");
  return ascii;
}

function readExactStableRecord(
  input: unknown,
  allowedKeys: readonly string[],
  label: string,
  optional = false,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an invalid prototype.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    (!optional && keys.length !== allowedKeys.length)
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      if (optional) continue;
      throw new Error(`${label}.${key} is required.`);
    }
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
