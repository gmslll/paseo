import {
  EnterpriseBrowserProfileContentItemSchema,
  EnterpriseBrowserProfileContentSelectorSchema,
  type AuthorizedBrowserProfile,
  type EnterpriseBrowserProfileContentItem,
  type EnterpriseBrowserProfileContentSelector,
} from "@getpaseo/protocol/messages";
import { DarwinWorkspaceFileSystem } from "../runtime/darwin-workspace-fs.js";
const sourceBrand = Symbol("EnterpriseBrowserProfileContentReadSource");

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

export function createEnterpriseBrowserProfileContentReadSource(input: {
  readonly readProfile: (input: {
    readonly profile: AuthorizedBrowserProfile;
    readonly browserProfileId: string;
    readonly view: EnterpriseBrowserProfileContentSelector["view"];
    readonly cursor?: string;
    readonly limit: number;
  }) => Promise<EnterpriseBrowserProfileContentPage>;
}): EnterpriseBrowserProfileContentReadSource {
  let closed = false;
  return Object.freeze({
    [sourceBrand]: true as const,
    read: async ({ profile, selector, cursor, limit }) => {
      if (closed) throw new Error("Browser profile content source is closed.");
      const parsedSelector = EnterpriseBrowserProfileContentSelectorSchema.parse(selector);
      const page = await input.readProfile({
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
      closed = true;
    },
  });
}

export function createProductionEnterpriseBrowserProfileContentReadSource(input: {
  readonly workspaceFs?: DarwinWorkspaceFileSystem;
  readonly addonPath?: string;
}): EnterpriseBrowserProfileContentReadSource | null {
  const workspaceFs =
    input.workspaceFs ?? new DarwinWorkspaceFileSystem({ addonPath: input.addonPath });
  if (!workspaceFs.releaseReady) return null;
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
        const names = (await workspaceFs.listRoot(root)).filter((name) => !name.includes("/"));
        const start = cursor ? Number(cursor) : 0;
        const selected = names.slice(start, start + limit);
        const items = await Promise.all(
          selected.map(async (name) => {
            const stat = await workspaceFs.stat(root, [name]);
            return {
              itemId: name,
              occurredAt: new Date(stat.mtimeMs).toISOString(),
              kind: "artifact",
              reference: name,
              label: name,
              size: stat.size,
            };
          }),
        );
        return {
          items,
          nextCursor:
            start + selected.length < names.length ? String(start + selected.length) : null,
        };
      } finally {
        await root.close();
      }
    },
  });
}
