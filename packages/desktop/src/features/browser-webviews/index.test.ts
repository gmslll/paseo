import { describe, expect, test } from "vitest";
import {
  getEnterpriseBrowserProfilePartition,
  PASEO_BROWSER_PROFILE_PARTITION,
  type BrowserProfileRuntimeAuthorization,
} from "../browser-profile.js";
import {
  getPaseoBrowserIdForWebContents,
  getPaseoBrowserWorkspaceId,
  isPaseoBrowserWebviewAttach,
  preparePaseoBrowserWebContents,
  registerAttachedPaseoBrowser,
  unregisterPaseoBrowser,
  unregisterPaseoBrowserFromHost,
} from "./index.js";

class FakeRenderer {
  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return false;
  }
}

const enterpriseAuthorization: BrowserProfileRuntimeAuthorization = {
  organizationId: "org_1111111111111111",
  homeNodeId: "nod_1111111111111111",
  workspaceId: "workspace-enterprise",
  browserProfileId: "brp_1111111111111111",
  bindingRevision: "binding-a",
  lifecycleGeneration: "lifecycle-a",
};

class FakeBrowserGuest {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(
    public readonly id: number,
    public readonly hostWebContents: FakeRenderer,
    public readonly session: object,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("browser webview attachment", () => {
  test("accepts only allowed URLs on the shared profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: "persist:paseo-browser-tab-a",
      }),
    ).toBe(false);
    expect(
      isPaseoBrowserWebviewAttach({ src: "https://example.com", partition: "persist:foreign" }),
    ).toBe(false);
  });

  test("accepts an enterprise WebView only on its derived Profile partition", () => {
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: getEnterpriseBrowserProfilePartition(enterpriseAuthorization.browserProfileId),
        profileAuthorization: enterpriseAuthorization,
      }),
    ).toBe(true);
    expect(
      isPaseoBrowserWebviewAttach({
        src: "https://example.com",
        partition: PASEO_BROWSER_PROFILE_PARTITION,
        profileAuthorization: enterpriseAuthorization,
      }),
    ).toBe(false);
  });

  test("binds explicit browser identity to the renderer that hosts the guest", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(101, renderer, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-a",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(true);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-a");
    expect(getPaseoBrowserWorkspaceId("browser-a")).toBe("workspace-a");
    unregisterPaseoBrowser("browser-a");
  });

  test("rejects a guest hosted by another renderer", () => {
    const profileSession = {};
    const owner = new FakeRenderer(1);
    const claimant = new FakeRenderer(2);
    const guest = new FakeBrowserGuest(201, owner, profileSession);

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-owner",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: claimant,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("rejects a guest outside the shared profile", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(1);
    const guest = new FakeBrowserGuest(301, renderer, {});

    const registered = registerAttachedPaseoBrowser({
      browserId: "browser-rejected-profile",
      workspaceId: "workspace-a",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(registered).toBe(false);
    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
  });

  test("registers only the exact enterprise Profile session and host tuple", () => {
    const renderer = new FakeRenderer(7);
    const profileSession = {};
    const guest = new FakeBrowserGuest(307, renderer, profileSession);

    expect(
      registerAttachedPaseoBrowser({
        browserId: "browser-enterprise",
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        profileAuthorization: enterpriseAuthorization,
        findWebContents: () => guest,
      }),
    ).toBe(true);
    expect(() =>
      registerAttachedPaseoBrowser({
        browserId: "browser-enterprise",
        workspaceId: enterpriseAuthorization.workspaceId,
        webContentsId: 308,
        sender: renderer,
        profileSession,
        profileAuthorization: {
          ...enterpriseAuthorization,
          browserProfileId: "brp_2222222222222222",
        },
        findWebContents: () => new FakeBrowserGuest(308, renderer, profileSession),
      }),
    ).toThrow(/cannot change/i);
    unregisterPaseoBrowser("browser-enterprise");
  });

  test("concurrent windows cannot swap browser identities", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(1);
    const secondRenderer = new FakeRenderer(2);
    const firstGuest = new FakeBrowserGuest(401, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(402, secondRenderer, profileSession);
    const guests = new Map([
      [firstGuest.id, firstGuest],
      [secondGuest.id, secondGuest],
    ]);

    registerAttachedPaseoBrowser({
      browserId: "browser-second",
      workspaceId: "workspace-second",
      webContentsId: secondGuest.id,
      sender: secondRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });
    registerAttachedPaseoBrowser({
      browserId: "browser-first",
      workspaceId: "workspace-first",
      webContentsId: firstGuest.id,
      sender: firstRenderer,
      profileSession,
      findWebContents: (id) => guests.get(id) ?? null,
    });

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBe("browser-first");
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-second");
    unregisterPaseoBrowser("browser-first");
    unregisterPaseoBrowser("browser-second");
  });

  test("unregisters the same browser only from its requesting host", () => {
    const profileSession = {};
    const firstRenderer = new FakeRenderer(11);
    const secondRenderer = new FakeRenderer(22);
    const firstGuest = new FakeBrowserGuest(501, firstRenderer, profileSession);
    const secondGuest = new FakeBrowserGuest(502, secondRenderer, profileSession);

    for (const [renderer, guest] of [
      [firstRenderer, firstGuest],
      [secondRenderer, secondGuest],
    ] as const) {
      registerAttachedPaseoBrowser({
        browserId: "browser-shared-hosts",
        workspaceId: "workspace-shared",
        webContentsId: guest.id,
        sender: renderer,
        profileSession,
        findWebContents: () => guest,
      });
    }

    unregisterPaseoBrowserFromHost(firstRenderer.id, "browser-shared-hosts");

    expect(getPaseoBrowserIdForWebContents(firstGuest)).toBeNull();
    expect(getPaseoBrowserIdForWebContents(secondGuest)).toBe("browser-shared-hosts");
    expect(getPaseoBrowserWorkspaceId("browser-shared-hosts")).toBe("workspace-shared");
    unregisterPaseoBrowser("browser-shared-hosts");
  });

  test("prepares throttling once and removes registration when the guest is destroyed", () => {
    const profileSession = {};
    const renderer = new FakeRenderer(31);
    const guest = new FakeBrowserGuest(601, renderer, profileSession);
    preparePaseoBrowserWebContents(guest);
    registerAttachedPaseoBrowser({
      browserId: "browser-cleanup",
      workspaceId: "workspace-cleanup",
      webContentsId: guest.id,
      sender: renderer,
      profileSession,
      findWebContents: () => guest,
    });

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
    expect(getPaseoBrowserIdForWebContents(guest)).toBe("browser-cleanup");

    guest.destroy();

    expect(getPaseoBrowserIdForWebContents(guest)).toBeNull();
    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });
});
