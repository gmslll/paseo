import type { AuthorizedBrowserProfile } from "@getpaseo/protocol/messages";

export interface EnterpriseBrowserProfileContentSelector {
  readonly kind: "browser_profile";
  readonly view: "state" | "artifacts";
}

export interface EnterpriseBrowserProfileContentPage {
  readonly items: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
}

export interface EnterpriseBrowserProfileContentReadSource {
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
    readonly browserProfileId: string;
    readonly view: EnterpriseBrowserProfileContentSelector["view"];
    readonly cursor?: string;
    readonly limit: number;
  }) => Promise<EnterpriseBrowserProfileContentPage>;
}): EnterpriseBrowserProfileContentReadSource {
  return Object.freeze({
    read: ({ profile, selector, cursor, limit }) =>
      input.readProfile({
        browserProfileId: profile.browserProfileId,
        view: selector.view,
        cursor,
        limit,
      }),
  });
}
