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
  const readProfile = captureDataFunction(input, "readProfile");
  const onClose = captureDataOptionalFunction(input, "onClose");
  let closed = false;
  const source = Object.freeze({
    [sourceBrand]: true as const,
    read: async ({ profile, selector, cursor, limit }) => {
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

// oxlint-disable-next-line no-explicit-any -- captured descriptor is narrowed by the caller contract
function captureDataFunction(input: object, key: string): (...args: any[]) => any {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new Error(`Invalid ${key}`);
  return descriptor.value;
}
function captureDataOptionalFunction(input: object, key: string): (() => void) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
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
  const workspaceFs =
    input.workspaceFs ?? new DarwinWorkspaceFileSystem({ addonPath: input.addonPath });
  if (!workspaceFs.releaseReady) return null;
  const cursorRecords = new Map<
    string,
    {
      profileId: string;
      organizationId: string;
      nodeId: string;
      view: string;
      offset: number;
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
        const names = (await workspaceFs.listRoot(root))
          .filter((name) => !name.includes("/"))
          .sort();
        let start = 0;
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
          start = record.offset;
        }
        const selected = names.slice(start, start + limit);
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
            start + selected.length < names.length
              ? issueCursor(cursorRecords, profile, view, start + selected.length)
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
      offset: number;
      expiresAt: number;
    }
  >,
  profile: AuthorizedBrowserProfile,
  view: string,
  offset: number,
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
      offset,
      expiresAt: Date.now() + 60_000,
    });
    return token;
  }
  throw new Error("Cursor allocation collision.");
}
