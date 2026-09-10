import path from "node:path";
import {
  AppSlotRecordSchema,
  NodeContextSchema,
  OrganizationIdSchema,
  type AppSlotRecord,
  type NodeContext,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import { readSecureJsonFile, writeSecureJsonFile } from "../browser/secure-json-file.js";

const StrictAppSlotRecordSchema = AppSlotRecordSchema.strict();
const AppSlotRegistrySnapshotSchema = z
  .object({
    version: z.literal(1),
    records: z.array(StrictAppSlotRecordSchema),
  })
  .strict();
const OPTION_KEYS = new Set(["paseoHome", "organizationId", "node"]);
const EMPTY_SNAPSHOT: AppSlotRegistrySnapshot = deepFreeze(
  AppSlotRegistrySnapshotSchema.parse({ version: 1, records: [] }),
);

export type AppSlotRegistrySnapshot = z.infer<typeof AppSlotRegistrySnapshotSchema>;

export interface ProductionAppSlotRegistryOptions {
  readonly paseoHome: string;
  readonly organizationId: string;
  readonly node: NodeContext;
}

declare const productionAppSlotRegistryBrand: unique symbol;

/** W5-owned durable registry passed to W2 before it creates the sole authorization provider. */
export interface ProductionAppSlotRegistry {
  readonly [productionAppSlotRegistryBrand]: never;
  initialize(): Promise<void>;
  get(appSlotId: string): Promise<AppSlotRecord | null>;
  list(): Promise<readonly AppSlotRecord[]>;
  current(): boolean;
  close(): Promise<void>;
}

type RegistryState =
  | { readonly status: "new" }
  | { readonly status: "initializing" }
  | { readonly status: "ready" }
  | { readonly status: "closing" | "closed" }
  | { readonly status: "failed"; readonly error: ProductionAppSlotRegistryCorruptError };

interface CapturedOptions {
  readonly filePath: string;
  readonly organizationId: string;
  readonly node: NodeContext;
}

const issuedRegistries = new WeakSet<object>();

export class ProductionAppSlotRegistryCorruptError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductionAppSlotRegistryCorruptError";
  }
}

export function createProductionAppSlotRegistry(input: unknown): ProductionAppSlotRegistry | null {
  try {
    const options = captureOptions(input);
    if (!options) return null;
    const registry = new FileBackedProductionAppSlotRegistry(options);
    issuedRegistries.add(registry.publicPort);
    return registry.publicPort;
  } catch {
    return null;
  }
}

export function isCurrentProductionAppSlotRegistry(
  value: unknown,
): value is ProductionAppSlotRegistry {
  try {
    return (
      isObject(value) &&
      issuedRegistries.has(value) &&
      (value as ProductionAppSlotRegistry).current()
    );
  } catch {
    return false;
  }
}

class FileBackedProductionAppSlotRegistry {
  public readonly publicPort: ProductionAppSlotRegistry;
  private readonly filePath: string;
  private readonly organizationId: string;
  private readonly node: NodeContext;
  private readonly records = new Map<string, AppSlotRecord>();
  private state: RegistryState = Object.freeze({ status: "new" });
  private initializePromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  public constructor(options: CapturedOptions) {
    this.filePath = options.filePath;
    this.organizationId = options.organizationId;
    this.node = options.node;
    this.publicPort = Object.freeze({
      initialize: () => this.initialize(),
      get: (appSlotId: string) => this.get(appSlotId),
      list: () => this.list(),
      current: () => this.current(),
      close: () => this.close(),
    }) as ProductionAppSlotRegistry;
  }

  private initialize(): Promise<void> {
    if (this.state.status === "ready") return Promise.resolve();
    if (this.state.status === "failed") return Promise.reject(this.state.error);
    if (this.state.status === "closing" || this.state.status === "closed") {
      return Promise.reject(new Error("Production App Slot registry is closed."));
    }
    if (this.initializePromise) return this.initializePromise;
    this.state = Object.freeze({ status: "initializing" });
    this.initializePromise = this.load();
    return this.initializePromise;
  }

  private async get(appSlotId: string): Promise<AppSlotRecord | null> {
    const parsedId = AppSlotRecordSchema.shape.appSlotId.safeParse(appSlotId);
    if (!parsedId.success) return null;
    await this.initialize();
    this.assertReady();
    const record = this.records.get(parsedId.data);
    return record ? cloneRecord(record) : null;
  }

  private async list(): Promise<readonly AppSlotRecord[]> {
    await this.initialize();
    this.assertReady();
    return Object.freeze(
      Array.from(this.records.values(), cloneRecord).sort((left, right) =>
        left.appSlotId.localeCompare(right.appSlotId),
      ),
    );
  }

  private current(): boolean {
    return this.state.status === "ready";
  }

  private close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state.status === "closed") return Promise.resolve();
    this.state = Object.freeze({ status: "closing" });
    const initializing = this.initializePromise;
    this.closePromise = (async () => {
      if (initializing) {
        try {
          await initializing;
        } catch {
          // The registry is sealed already; initialization failure cannot publish state.
        }
      }
      this.records.clear();
      this.state = Object.freeze({ status: "closed" });
    })();
    return this.closePromise;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readSecureJsonFile(this.filePath);
      this.assertInitializing();
      if (raw === null) {
        await writeSecureJsonFile(this.filePath, EMPTY_SNAPSHOT);
        this.assertInitializing();
      }
      const snapshot = AppSlotRegistrySnapshotSchema.parse(raw ?? EMPTY_SNAPSHOT);
      const next = validateSnapshot(snapshot, this.organizationId, this.node.nodeId);
      this.assertInitializing();
      this.records.clear();
      for (const [appSlotId, record] of next) this.records.set(appSlotId, record);
      this.state = Object.freeze({ status: "ready" });
    } catch (error) {
      if (this.state.status === "closing" || this.state.status === "closed") throw error;
      const failure =
        error instanceof ProductionAppSlotRegistryCorruptError
          ? error
          : new ProductionAppSlotRegistryCorruptError(
              "Production App Slot registry is corrupt or unavailable.",
              { cause: error },
            );
      this.records.clear();
      this.state = Object.freeze({ status: "failed", error: failure });
      throw failure;
    }
  }

  private assertInitializing(): void {
    if (this.state.status !== "initializing") {
      throw new Error("Production App Slot registry initialization was invalidated.");
    }
  }

  private assertReady(): void {
    if (this.state.status !== "ready") {
      throw new Error("Production App Slot registry is unavailable.");
    }
  }
}

function validateSnapshot(
  snapshot: AppSlotRegistrySnapshot,
  organizationId: string,
  nodeId: string,
): ReadonlyMap<string, AppSlotRecord> {
  const records = new Map<string, AppSlotRecord>();
  const identities = new Set<string>();
  for (const rawRecord of snapshot.records) {
    const record = cloneRecord(rawRecord);
    if (record.organizationId !== organizationId || record.nodeId !== nodeId) {
      throw new ProductionAppSlotRegistryCorruptError(
        `App Slot ${record.appSlotId} is not owned by this organization and node.`,
      );
    }
    if (records.has(record.appSlotId)) {
      throw new ProductionAppSlotRegistryCorruptError(`Duplicate App Slot id ${record.appSlotId}.`);
    }
    const identity = JSON.stringify([
      record.organizationId,
      record.nodeId,
      record.businessIdentityId ?? null,
      record.appBundleId,
      record.accountBindingKey,
    ]);
    if (identities.has(identity)) {
      throw new ProductionAppSlotRegistryCorruptError("Duplicate App Slot account binding.");
    }
    records.set(record.appSlotId, record);
    identities.add(identity);
  }
  return records;
}

function cloneRecord(record: AppSlotRecord): AppSlotRecord {
  return deepFreeze(StrictAppSlotRecordSchema.parse(structuredClone(record)));
}

function captureOptions(value: unknown): CapturedOptions | null {
  const record = captureExactRecord(value, OPTION_KEYS);
  if (!record || typeof record.paseoHome !== "string") return null;
  const paseoHome = canonicalAbsolutePath(record.paseoHome);
  const organizationId = OrganizationIdSchema.parse(record.organizationId);
  const node = deepFreeze(NodeContextSchema.strict().parse(snapshotPlainData(record.node)));
  if (node.mode !== "standalone") return null;
  return Object.freeze({
    filePath: path.join(paseoHome, "enterprise", "app-slots.json"),
    organizationId,
    node,
  });
}

function canonicalAbsolutePath(value: string): string {
  if (
    value.length === 0 ||
    hasControlCharacter(value) ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new Error("Production App Slot paseoHome must be a canonical absolute path.");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function captureExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return null;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotPlainData(value: unknown): unknown {
  if (!isObject(value)) return value;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Production App Slot option object is invalid.");
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("Production App Slot option key is invalid.");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      throw new Error("Production App Slot option descriptor is invalid.");
    result[key] = descriptor.value;
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
