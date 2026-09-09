import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BrowserProfileRecordSchema, type BrowserProfileRecord } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const StrictExpectedBrowserIdentitySchema = z
  .object({
    hostnames: z.array(z.string().min(1)).min(1),
    accountLabelHash: z.string().min(1).optional(),
  })
  .strict();

const StrictBrowserProfileRecordSchema = BrowserProfileRecordSchema.extend({
  expectedIdentity: StrictExpectedBrowserIdentitySchema.optional(),
}).strict();

const BrowserProfileRegistrySnapshotSchema = z
  .object({
    version: z.literal(1),
    records: z.array(StrictBrowserProfileRecordSchema),
  })
  .strict();

const CreateBrowserProfileInputSchema = BrowserProfileRecordSchema.pick({
  organizationId: true,
  homeNodeId: true,
  businessIdentityId: true,
  ownerPrincipalId: true,
  platform: true,
  businessAccountKey: true,
  label: true,
  credentialRef: true,
  expectedIdentity: true,
  status: true,
})
  .extend({
    businessAccountKey: z.string().trim().min(1),
    label: z.string().trim().min(1),
    expectedIdentity: StrictExpectedBrowserIdentitySchema.optional(),
  })
  .strict();

const UpdateBrowserProfileInputSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    credentialRef: z.string().min(1).nullable().optional(),
    expectedIdentity: StrictExpectedBrowserIdentitySchema.nullable().optional(),
    status: BrowserProfileRecordSchema.shape.status.optional(),
  })
  .strict();

export type BrowserProfileRegistrySnapshot = z.infer<typeof BrowserProfileRegistrySnapshotSchema>;
export type CreateBrowserProfileInput = z.input<typeof CreateBrowserProfileInputSchema>;
export type UpdateBrowserProfileInput = z.input<typeof UpdateBrowserProfileInputSchema>;

export interface BrowserProfileStorage {
  read(): Promise<unknown | null>;
  write(snapshot: BrowserProfileRegistrySnapshot): Promise<void>;
}

export interface BrowserProfileCanonicalResolver {
  resolve(input: { browserProfileId: string; homeNodeId: string }): {
    partitionKey: string;
    downloadRoot: string;
  };
}

export interface BrowserProfileRegistryOptions {
  storage: BrowserProfileStorage;
  canonicalResolver: BrowserProfileCanonicalResolver;
  createProfileId?: () => string;
  now?: () => string;
}

export class BrowserProfileRegistryCorruptError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserProfileRegistryCorruptError";
  }
}

export class JsonFileBrowserProfileStorage implements BrowserProfileStorage {
  public constructor(private readonly filePath: string) {}

  public async read(): Promise<unknown | null> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch (error) {
      throw new BrowserProfileRegistryCorruptError(
        "Browser Profile registry contains invalid JSON.",
        { cause: error },
      );
    }
  }

  public write(snapshot: BrowserProfileRegistrySnapshot): Promise<void> {
    return writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function createNodeBrowserProfileCanonicalResolver(input: {
  nodeId: string;
  downloadBaseRoot: string;
}): BrowserProfileCanonicalResolver {
  const downloadBaseRoot = path.resolve(input.downloadBaseRoot);
  return {
    resolve(profile) {
      if (profile.homeNodeId !== input.nodeId) {
        throw new Error("Browser Profile is not homed on this node.");
      }
      const browserProfileId = BrowserProfileRecordSchema.shape.browserProfileId.parse(
        profile.browserProfileId,
      );
      return {
        partitionKey: `persist:paseo-enterprise-${browserProfileId}`,
        downloadRoot: path.join(downloadBaseRoot, browserProfileId, "downloads"),
      };
    },
  };
}

export class BrowserProfileRegistry {
  private readonly storage: BrowserProfileStorage;
  private readonly canonicalResolver: BrowserProfileCanonicalResolver;
  private readonly createProfileId: () => string;
  private readonly now: () => string;
  private readonly records = new Map<string, BrowserProfileRecord>();
  private initialization: Promise<void> | null = null;
  private corruptError: BrowserProfileRegistryCorruptError | null = null;
  private initialized = false;
  private mutationTail: Promise<void> = Promise.resolve();

  public constructor(options: BrowserProfileRegistryOptions) {
    this.storage = options.storage;
    this.canonicalResolver = options.canonicalResolver;
    this.createProfileId =
      options.createProfileId ?? (() => `brp_${randomBytes(8).toString("hex")}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async initialize(): Promise<void> {
    if (this.corruptError) {
      throw this.corruptError;
    }
    if (this.initialized) {
      return;
    }
    this.initialization ??= this.load();
    try {
      await this.initialization;
    } finally {
      if (!this.initialized && !this.corruptError) {
        this.initialization = null;
      }
    }
  }

  public async list(): Promise<BrowserProfileRecord[]> {
    await this.initialize();
    return Array.from(this.records.values(), cloneBrowserProfileRecord).sort((a, b) =>
      a.browserProfileId.localeCompare(b.browserProfileId),
    );
  }

  public async get(browserProfileId: string): Promise<BrowserProfileRecord | null> {
    await this.initialize();
    const record = this.records.get(browserProfileId);
    return record ? cloneBrowserProfileRecord(record) : null;
  }

  public create(input: CreateBrowserProfileInput): Promise<BrowserProfileRecord> {
    return this.mutate(async () => {
      const parsed = CreateBrowserProfileInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid Browser Profile create input: ${parsed.error.issues[0]?.message}`);
      }
      const browserProfileId = BrowserProfileRecordSchema.shape.browserProfileId.parse(
        this.createProfileId(),
      );
      const uniqueKey = getBrowserProfileUniqueKey(parsed.data);
      if (
        Array.from(this.records.values()).some(
          (record) => getBrowserProfileUniqueKey(record) === uniqueKey,
        )
      ) {
        throw new Error("A Browser Profile already exists for this organization account owner.");
      }
      if (this.records.has(browserProfileId)) {
        throw new Error(`Browser Profile ${browserProfileId} already exists.`);
      }
      const canonical = this.canonicalResolver.resolve({
        browserProfileId,
        homeNodeId: parsed.data.homeNodeId,
      });
      const timestamp = this.now();
      const record = StrictBrowserProfileRecordSchema.parse({
        ...parsed.data,
        browserProfileId,
        ...canonical,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const next = new Map(this.records).set(browserProfileId, record);
      await this.persist(next);
      this.records.set(browserProfileId, record);
      return cloneBrowserProfileRecord(record);
    });
  }

  public update(
    browserProfileId: string,
    input: UpdateBrowserProfileInput,
  ): Promise<BrowserProfileRecord> {
    return this.mutate(async () => {
      const parsed = UpdateBrowserProfileInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`Invalid Browser Profile update input: ${parsed.error.issues[0]?.message}`);
      }
      const existing = this.records.get(browserProfileId);
      if (!existing) {
        throw new Error(`Browser Profile ${browserProfileId} was not found.`);
      }
      const nextRecord = cloneBrowserProfileRecord(existing);
      if (parsed.data.label !== undefined) {
        nextRecord.label = parsed.data.label;
      }
      if (parsed.data.status !== undefined) {
        nextRecord.status = parsed.data.status;
      }
      if (parsed.data.credentialRef !== undefined) {
        if (parsed.data.credentialRef === null) {
          delete nextRecord.credentialRef;
        } else {
          nextRecord.credentialRef = parsed.data.credentialRef;
        }
      }
      if (parsed.data.expectedIdentity !== undefined) {
        if (parsed.data.expectedIdentity === null) {
          delete nextRecord.expectedIdentity;
        } else {
          nextRecord.expectedIdentity = parsed.data.expectedIdentity;
        }
      }
      nextRecord.updatedAt = this.now();
      const validated = StrictBrowserProfileRecordSchema.parse(nextRecord);
      this.assertCanonicalRuntimePaths(validated);
      const next = new Map(this.records).set(browserProfileId, validated);
      await this.persist(next);
      this.records.set(browserProfileId, validated);
      return cloneBrowserProfileRecord(validated);
    });
  }

  private async load(): Promise<void> {
    let raw: unknown | null;
    try {
      raw = await this.storage.read();
    } catch (error) {
      if (error instanceof BrowserProfileRegistryCorruptError) {
        this.corruptError = error;
      }
      throw error;
    }

    try {
      const snapshot = BrowserProfileRegistrySnapshotSchema.parse(
        raw ?? { version: 1, records: [] },
      );
      const records = new Map<string, BrowserProfileRecord>();
      const uniqueKeys = new Set<string>();
      for (const record of snapshot.records) {
        if (records.has(record.browserProfileId)) {
          throw new Error(`Duplicate Browser Profile id ${record.browserProfileId}.`);
        }
        const uniqueKey = getBrowserProfileUniqueKey(record);
        if (uniqueKeys.has(uniqueKey)) {
          throw new Error("Duplicate Browser Profile organization account owner key.");
        }
        this.assertCanonicalRuntimePaths(record);
        records.set(record.browserProfileId, record);
        uniqueKeys.add(uniqueKey);
      }
      this.records.clear();
      for (const [browserProfileId, record] of records) {
        this.records.set(browserProfileId, record);
      }
      this.initialized = true;
    } catch (error) {
      this.corruptError = new BrowserProfileRegistryCorruptError(
        "Browser Profile registry is corrupt and was not loaded.",
        { cause: error },
      );
      throw this.corruptError;
    }
  }

  private assertCanonicalRuntimePaths(record: BrowserProfileRecord): void {
    const canonical = this.canonicalResolver.resolve({
      browserProfileId: record.browserProfileId,
      homeNodeId: record.homeNodeId,
    });
    if (
      record.partitionKey !== canonical.partitionKey ||
      record.downloadRoot !== canonical.downloadRoot
    ) {
      throw new Error(
        `Browser Profile ${record.browserProfileId} has non-canonical runtime paths.`,
      );
    }
  }

  private async persist(records: ReadonlyMap<string, BrowserProfileRecord>): Promise<void> {
    await this.storage.write({
      version: 1,
      records: Array.from(records.values(), cloneBrowserProfileRecord),
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(async () => {
      await this.initialize();
      return operation();
    });
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function cloneBrowserProfileRecord(record: BrowserProfileRecord): BrowserProfileRecord {
  return StrictBrowserProfileRecordSchema.parse(record);
}

function getBrowserProfileUniqueKey(
  record: Pick<
    BrowserProfileRecord,
    "organizationId" | "platform" | "businessAccountKey" | "ownerPrincipalId"
  >,
): string {
  return JSON.stringify([
    record.organizationId,
    record.platform,
    record.businessAccountKey,
    record.ownerPrincipalId,
  ]);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
