import {
  EnterpriseBrowserProfileContentItemSchema,
  EnterpriseBrowserProfileContentSelectorSchema,
  type AuthorizedBrowserProfile,
  type EnterpriseBrowserProfileContentItem,
  type EnterpriseBrowserProfileContentSelector,
} from "@getpaseo/protocol/messages";
import { DarwinWorkspaceFileSystem } from "../runtime/darwin-workspace-fs.js";
import { randomBytes } from "node:crypto";
const sourceBrand = Symbol("EnterpriseBrowserProfileContentReadSource");
const sources = new WeakSet<object>();

export interface EnterpriseBrowserProfileContentPage {
  readonly items: readonly EnterpriseBrowserProfileContentItem[];
  readonly nextCursor: string | null;
}

export interface EnterpriseBrowserProfileContentReadSource {
  readonly [sourceBrand]: true;
  read(input: {
    readonly profile: AuthorizedBrowserProfile;
    readonly selector: EnterpriseBrowserProfileContentSelector;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<EnterpriseBrowserProfileContentPage>;
  close?(): Promise<void> | void;
}
type BrowserContentReadInput = Parameters<EnterpriseBrowserProfileContentReadSource["read"]>[0];
type ReadProfile = (
  input: Parameters<
    NonNullable<
      Parameters<typeof createEnterpriseBrowserProfileContentReadSource>[0]["readProfile"]
    >
  >[0],
) => Promise<EnterpriseBrowserProfileContentPage>;
export function isEnterpriseBrowserProfileContentReadSource(
  value: unknown,
): value is EnterpriseBrowserProfileContentReadSource {
  return typeof value === "object" && value !== null && sources.has(value);
}

export function createEnterpriseBrowserProfileContentReadSource(input: {
  readonly readProfile: (input: {
    readonly profile: AuthorizedBrowserProfile;
    readonly browserProfileId: string;
    readonly view: EnterpriseBrowserProfileContentSelector["view"];
    readonly cursor?: string;
    readonly limit: number;
  }) => Promise<EnterpriseBrowserProfileContentPage>;
  readonly onClose?: () => void;
}): EnterpriseBrowserProfileContentReadSource {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Invalid source options.");
  if (Reflect.ownKeys(input).some((key) => key !== "readProfile" && key !== "onClose"))
    throw new Error("Invalid source options.");
  const readProfile = captureDataFunction(input, "readProfile");
  const onClose = captureDataOptionalFunction(input, "onClose");
  let closed = false;
  const source = Object.freeze({
    [sourceBrand]: true as const,
    read: async ({ profile, selector, cursor, limit }: BrowserContentReadInput) => {
      if (closed) throw new Error("Browser profile content source is closed.");
      const parsedSelector = EnterpriseBrowserProfileContentSelectorSchema.parse(selector);
      const page = await readProfile({
        profile,
        browserProfileId: profile.browserProfileId,
        view: parsedSelector.view,
        cursor,
        limit,
      });
      if (closed) throw new Error("Browser profile content source is closed.");
      return {
        items: page.items.map((item) => EnterpriseBrowserProfileContentItemSchema.parse(item)),
        nextCursor: page.nextCursor,
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      onClose?.();
    },
  });
  sources.add(source);
  return source;
}

function isReadProfile(value: unknown): value is ReadProfile {
  return typeof value === "function";
}
function captureDataFunction(input: object, key: string): ReadProfile {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new Error(`Invalid ${key}`);
  if (!isReadProfile(descriptor.value)) throw new Error(`Invalid ${key}`);
  return descriptor.value;
}
function captureDataOptionalFunction(input: object, key: string): (() => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable) throw new Error(`Invalid ${key}`);
  if (
    !("value" in descriptor) ||
    (descriptor.value !== undefined && typeof descriptor.value !== "function")
  )
    throw new Error(`Invalid ${key}`);
  return descriptor.value;
}

export function createProductionEnterpriseBrowserProfileContentReadSource(input: {
  readonly workspaceFs?: DarwinWorkspaceFileSystem;
  readonly addonPath?: string;
}): EnterpriseBrowserProfileContentReadSource | null {
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null)
    throw new Error("Invalid production source options.");
  if (Reflect.ownKeys(input).some((key) => key !== "workspaceFs" && key !== "addonPath"))
    throw new Error("Invalid production source options.");
  const workspaceDescriptor = Object.getOwnPropertyDescriptor(input, "workspaceFs");
  const addonDescriptor = Object.getOwnPropertyDescriptor(input, "addonPath");
  if (workspaceDescriptor && !("value" in workspaceDescriptor))
    throw new Error("Invalid workspaceFs.");
  if (addonDescriptor && !("value" in addonDescriptor)) throw new Error("Invalid addonPath.");
  if (workspaceDescriptor?.value && addonDescriptor?.value)
    throw new Error("Choose workspaceFs or addonPath.");
  if (
    addonDescriptor?.value !== undefined &&
    (typeof addonDescriptor.value !== "string" || addonDescriptor.value.length === 0)
  )
    throw new Error("Invalid addonPath.");
  const workspaceFs =
    input.workspaceFs ?? new DarwinWorkspaceFileSystem({ addonPath: input.addonPath });
  if (input.workspaceFs && !(input.workspaceFs instanceof DarwinWorkspaceFileSystem))
    throw new Error("Invalid workspaceFs.");
  if (!workspaceFs.releaseReady) return null;
  const cursorRecords = new Map<
    string,
    {
      profileId: string;
      organizationId: string;
      nodeId: string;
      view: string;
      remainingNames: readonly string[];
      expiresAt: number;
    }
  >();
  return createEnterpriseBrowserProfileContentReadSource({
    readProfile: async ({ profile, view, cursor, limit }) => {
      const root = await workspaceFs.openWorkspaceRoot(profile.downloadRoot);
      try {
        if (view === "state") {
          return {
            items: [
              {
                itemId: profile.browserProfileId,
                occurredAt: profile.updatedAt,
                kind: "state",
                label: profile.label,
                status: profile.status,
              },
            ],
            nextCursor: null,
          };
        }
        let snapshot: readonly string[] | null = null;
        if (cursor) {
          const record = cursorRecords.get(cursor);
          cursorRecords.delete(cursor);
          if (
            !record ||
            record.expiresAt < Date.now() ||
            record.profileId !== profile.browserProfileId ||
            record.organizationId !== profile.organizationId ||
            record.nodeId !== profile.homeNodeId ||
            record.view !== view
          )
            throw new Error("Invalid cursor.");
          snapshot = record.remainingNames;
        }
        let validNames = snapshot;
        if (!validNames) {
          const names = (await workspaceFs.listRoot(root))
            .filter((name) => !name.includes("/"))
            .sort();
          const filtered: string[] = [];
          for (const name of names) {
            try {
              if ((await workspaceFs.stat(root, [name])).kind === "file") filtered.push(name);
            } catch (error) {
              if (!["ENOENT", "ELOOP"].includes((error as { code?: string }).code ?? ""))
                throw error;
            }
          }
          validNames = filtered;
        }
        const selected = validNames.slice(0, limit);
        const items = [];
        for (const name of selected) {
          try {
            const stat = await workspaceFs.stat(root, [name]);
            if (stat.kind !== "file") continue;
            items.push({
              itemId: name,
              occurredAt: new Date(stat.mtimeMs).toISOString(),
              kind: "artifact" as const,
              reference: name,
              label: name,
              size: stat.size,
            });
          } catch (error) {
            if (["ENOENT", "ELOOP"].includes((error as { code?: string }).code ?? "")) continue;
            throw error;
          }
        }
        return {
          items,
          nextCursor:
            selected.length < validNames.length
              ? issueCursor(cursorRecords, profile, view, validNames.slice(selected.length))
              : null,
        };
      } finally {
        await root.close();
      }
    },
    onClose: () => cursorRecords.clear(),
  });
}

function issueCursor(
  records: Map<
    string,
    {
      profileId: string;
      organizationId: string;
      nodeId: string;
      view: string;
      remainingNames: readonly string[];
      expiresAt: number;
    }
  >,
  profile: AuthorizedBrowserProfile,
  view: string,
  remainingNames: readonly string[],
): string {
  if (records.size >= 1024) throw new Error("Cursor ledger is full.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = randomBytes(32).toString("base64url");
    if (records.has(token)) continue;
    records.set(token, {
      profileId: profile.browserProfileId,
      organizationId: profile.organizationId,
      nodeId: profile.homeNodeId,
      view,
      remainingNames: Object.freeze([...remainingNames]),
      expiresAt: Date.now() + 60_000,
    });
    return token;
  }
  throw new Error("Cursor allocation collision.");
}
