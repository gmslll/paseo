import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createProductionEnterpriseBrowserProfileContentReadSource } from "./content-source.js";
const executeFile = promisify(execFile);
import { createEnterpriseBrowserProfileContentReadSource } from "./content-source.js";
import {
  BrowserPageIdentityRegistry,
  createAuthenticatedBrowserHostSession,
  createBrowserPageIdentityVerifier,
} from "../../browser-tools/page-identity-registry.js";

const profile = {
  browserProfileId: "brp_0123456789abcdef",
  organizationId: "org",
  homeNodeId: "node",
  ownerPrincipalId: "p",
  platform: "darwin",
  businessIdentityId: "id",
  businessAccountKey: "acct",
  label: "Profile",
  status: "active",
  partitionKey: "persist:paseo-enterprise-brp_0123456789abcdef",
  downloadRoot: "/tmp/profile",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as const;

function productionProfile(downloadRoot: string) {
  return {
    browserProfileId: "brp_1111111111111111",
    organizationId: "org_1111111111111111",
    homeNodeId: "nod_1111111111111111",
    ownerPrincipalId: "usr_1111111111111111",
    platform: "generic" as const,
    businessIdentityId: "bid_1111111111111111",
    businessAccountKey: "account-a",
    label: "Profile",
    status: "ready" as const,
    partitionKey: "persist:paseo-enterprise-brp_1111111111111111",
    downloadRoot,
    expectedIdentity: { hostnames: ["shop.example"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function createObservedProductionPageIdentity(downloadRoot: string) {
  const canonicalProfile = productionProfile(downloadRoot);
  const registry = new BrowserPageIdentityRegistry({
    profiles: { get: async () => canonicalProfile },
  });
  const host = createAuthenticatedBrowserHostSession({
    clientId: "desktop-client-1",
    homeNodeId: canonicalProfile.homeNodeId,
    sessionBindingGeneration: "session-1",
  });
  registry.registerBrowser({
    host,
    browserId: "11111111-1111-4111-8111-111111111111",
    browserProfileId: canonicalProfile.browserProfileId,
    bindingRevision: "binding-1",
  });
  await registry.observe(host, {
    type: "enterprise.browser.page_identity.observe.request",
    requestId: "observe-production",
    browser: {
      browserId: "11111111-1111-4111-8111-111111111111",
      browserProfileId: canonicalProfile.browserProfileId,
    },
    hostname: "shop.example",
    observationRevision: "observation-production",
    bindingRevision: "binding-1",
    lifecycleGeneration: "session-1",
  });
  return {
    canonicalProfile,
    host,
    registry,
    verifier: createBrowserPageIdentityVerifier(registry),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("browser profile content source", () => {
  test("keeps the production source absent without nominal page identity", () => {
    expect(
      createProductionEnterpriseBrowserProfileContentReadSource({ addonPath: "not-opened.node" }),
    ).toBeNull();
  });

  test("returns a strict state page", async () => {
    const source = createEnterpriseBrowserProfileContentReadSource({
      readProfile: async () => ({
        items: [
          {
            itemId: "state",
            occurredAt: profile.updatedAt,
            kind: "state",
            label: "ok",
            status: "active",
          },
        ],
        nextCursor: null,
      }),
    });
    await expect(
      source.read({ profile, selector: { kind: "browser_profile", view: "state" }, limit: 10 }),
    ).resolves.toEqual({
      items: [
        {
          itemId: "state",
          occurredAt: profile.updatedAt,
          kind: "state",
          label: "ok",
          status: "active",
        },
      ],
      nextCursor: null,
    });
  });

  test("returns a two-file artifact page with cursor", async () => {
    const source = createEnterpriseBrowserProfileContentReadSource({
      readProfile: async ({ cursor }) =>
        cursor
          ? {
              items: [
                {
                  itemId: "b",
                  occurredAt: profile.updatedAt,
                  kind: "artifact",
                  reference: "b",
                  label: "b",
                  size: 2,
                },
              ],
              nextCursor: null,
            }
          : {
              items: [
                {
                  itemId: "a",
                  occurredAt: profile.updatedAt,
                  kind: "artifact",
                  reference: "a",
                  label: "a",
                  size: 1,
                },
              ],
              nextCursor: "next",
            },
    });
    const first = await source.read({
      profile,
      selector: { kind: "browser_profile", view: "artifacts" },
      limit: 1,
    });
    expect(first.nextCursor).toBe("next");
    await expect(
      source.read({
        profile,
        selector: { kind: "browser_profile", view: "artifacts" },
        cursor: first.nextCursor ?? undefined,
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [{ reference: "b" }] });
  });

  test("rechecks nominal page identity and the canonical Profile root before invoking a read", async () => {
    const canonicalProfile = {
      browserProfileId: "brp_1111111111111111",
      organizationId: "org_1111111111111111",
      homeNodeId: "nod_1111111111111111",
      ownerPrincipalId: "usr_1111111111111111",
      platform: "generic" as const,
      businessIdentityId: "bid_1111111111111111",
      businessAccountKey: "account-a",
      label: "Profile",
      status: "ready" as const,
      partitionKey: "persist:paseo-enterprise-brp_1111111111111111",
      downloadRoot: "/canonical/profile/downloads",
      expectedIdentity: {
        hostnames: ["shop.example"],
        accountLabelHash: "sha256:account-a",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let profileReadThrows = false;
    const pageIdentity = new BrowserPageIdentityRegistry({
      profiles: {
        get: async () => {
          if (profileReadThrows) throw new Error("profile read failed");
          return canonicalProfile;
        },
      },
    });
    const host = createAuthenticatedBrowserHostSession({
      clientId: "desktop-client-1",
      homeNodeId: canonicalProfile.homeNodeId,
      sessionBindingGeneration: "session-1",
    });
    const browserId = "11111111-1111-4111-8111-111111111111";
    pageIdentity.registerBrowser({
      host,
      browserId,
      browserProfileId: canonicalProfile.browserProfileId,
      bindingRevision: "binding-1",
    });
    await pageIdentity.observe(host, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-mismatch",
      browser: { browserId, browserProfileId: canonicalProfile.browserProfileId },
      hostname: "wrong.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-mismatch",
      bindingRevision: "binding-1",
      lifecycleGeneration: "session-1",
    });
    const reads: string[] = [];
    const source = createEnterpriseBrowserProfileContentReadSource({
      pageIdentity: createBrowserPageIdentityVerifier(pageIdentity),
      readProfile: async ({ profile: verifiedProfile }) => {
        reads.push(verifiedProfile.downloadRoot);
        return {
          items: [
            {
              itemId: "state",
              occurredAt: verifiedProfile.updatedAt,
              kind: "state",
              label: verifiedProfile.label,
              status: verifiedProfile.status,
            },
          ],
          nextCursor: null,
        };
      },
    });

    await expect(
      source.read({
        profile: canonicalProfile,
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      }),
    ).rejects.toMatchObject({ reasonCode: "hostname_mismatch" });
    expect(reads).toEqual([]);

    await pageIdentity.observe(host, {
      type: "enterprise.browser.page_identity.observe.request",
      requestId: "observe-match",
      browser: { browserId, browserProfileId: canonicalProfile.browserProfileId },
      hostname: "shop.example",
      accountLabelHash: "sha256:account-a",
      observationRevision: "observation-match",
      bindingRevision: "binding-1",
      lifecycleGeneration: "session-1",
    });
    await expect(
      source.read({
        profile: canonicalProfile,
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [{ kind: "state" }] });
    expect(reads).toEqual([canonicalProfile.downloadRoot]);

    await expect(
      source.read({
        profile: { ...canonicalProfile, downloadRoot: "/caller/path" },
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      }),
    ).rejects.toMatchObject({ reasonCode: "profile_changed" });
    pageIdentity.invalidateBrowser(host, browserId);
    await expect(
      source.read({
        profile: canonicalProfile,
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    profileReadThrows = true;
    await expect(
      source.read({
        profile: canonicalProfile,
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      }),
    ).rejects.toMatchObject({ reasonCode: "observation_unavailable" });
    expect(reads).toEqual([canonicalProfile.downloadRoot]);
  });

  test.each(["invalidate", "rebind"] as const)(
    "suppresses a completed content read after a concurrent page identity %s",
    async (race) => {
      const pageIdentity = await createObservedProductionPageIdentity("/canonical/downloads");
      const readStarted = deferred<void>();
      const readResult = deferred<{
        items: readonly [
          {
            itemId: string;
            occurredAt: string;
            kind: "state";
            label: string;
            status: "ready";
          },
        ];
        nextCursor: null;
      }>();
      const source = createEnterpriseBrowserProfileContentReadSource({
        pageIdentity: pageIdentity.verifier,
        readProfile: async () => {
          readStarted.resolve();
          return readResult.promise;
        },
      });
      const pending = source.read({
        profile: pageIdentity.canonicalProfile,
        selector: { kind: "browser_profile", view: "state" },
        limit: 1,
      });
      await readStarted.promise;

      if (race === "invalidate") {
        await pageIdentity.registry.invalidateObservation(pageIdentity.host, {
          type: "enterprise.browser.page_identity.invalidate.request",
          requestId: "invalidate-during-read",
          browser: {
            browserId: "11111111-1111-4111-8111-111111111111",
            browserProfileId: pageIdentity.canonicalProfile.browserProfileId,
          },
          observationRevision: "observation-production",
          bindingRevision: "binding-1",
          lifecycleGeneration: "session-1",
        });
      } else {
        pageIdentity.registry.registerBrowser({
          host: pageIdentity.host,
          browserId: "11111111-1111-4111-8111-111111111111",
          browserProfileId: pageIdentity.canonicalProfile.browserProfileId,
          bindingRevision: "binding-2",
        });
      }
      readResult.resolve({
        items: [
          {
            itemId: "stale-state",
            occurredAt: pageIdentity.canonicalProfile.updatedAt,
            kind: "state",
            label: "must-not-return",
            status: "ready",
          },
        ],
        nextCursor: null,
      });

      await expect(pending).rejects.toMatchObject({ reasonCode: "observation_stale" });
    },
  );

  test.runIf(process.platform === "darwin")(
    "reads native production state and closes",
    async () => {
      const buildDirectory = await mkdtemp(path.join(tmpdir(), "paseo-browser-content-native-"));
      const addonPath = path.join(buildDirectory, "darwin-workspace-fs.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("../runtime/native/build-darwin-workspace-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
      const downloadRoot = await realpath(
        await mkdtemp(path.join(tmpdir(), "paseo-browser-content-root-")),
      );
      try {
        const page = await createObservedProductionPageIdentity(downloadRoot);
        const source = createProductionEnterpriseBrowserProfileContentReadSource({
          addonPath,
          pageIdentity: page.verifier,
        });
        expect(source).not.toBeNull();
        if (!source) return;
        await expect(
          source.read({
            profile: page.canonicalProfile,
            selector: { kind: "browser_profile", view: "state" },
            limit: 1,
          }),
        ).resolves.toMatchObject({ items: [{ kind: "state", label: "Profile" }] });
        await source.close?.();
        await expect(
          source.read({
            profile: page.canonicalProfile,
            selector: { kind: "browser_profile", view: "state" },
            limit: 1,
          }),
        ).rejects.toThrow();
      } finally {
        await rm(downloadRoot, { recursive: true, force: true });
        await rm(buildDirectory, { recursive: true, force: true });
      }
    },
  );

  test.runIf(process.platform === "darwin")("filters native artifacts", async () => {
    const buildDirectory = await mkdtemp(path.join(tmpdir(), "paseo-browser-content-native-"));
    const addonPath = path.join(buildDirectory, "darwin-workspace-fs.node");
    await executeFile(process.execPath, [
      fileURLToPath(new URL("../runtime/native/build-darwin-workspace-fs.mjs", import.meta.url)),
      "--output",
      addonPath,
    ]);
    const downloadRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "paseo-browser-content-root-")),
    );
    try {
      await writeFile(path.join(downloadRoot, "b.txt"), "b");
      await writeFile(path.join(downloadRoot, "a.txt"), "a");
      await mkdir(path.join(downloadRoot, "dir"));
      await symlink("a.txt", path.join(downloadRoot, "link"));
      const page = await createObservedProductionPageIdentity(downloadRoot);
      const source = createProductionEnterpriseBrowserProfileContentReadSource({
        addonPath,
        pageIdentity: page.verifier,
      });
      if (!source) throw new Error("native source unavailable");
      const first = await source.read({
        profile: page.canonicalProfile,
        selector: { kind: "browser_profile", view: "artifacts" },
        limit: 1,
      });
      expect(first.items.map((item) => item.reference)).toEqual(["a.txt"]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.nextCursor).not.toBe("1");
      await writeFile(path.join(downloadRoot, "aa.txt"), "aa");
      const second = await source.read({
        profile: page.canonicalProfile,
        selector: { kind: "browser_profile", view: "artifacts" },
        cursor: first.nextCursor ?? undefined,
        limit: 1,
      });
      expect(second.items.map((item) => item.reference)).toEqual(["b.txt"]);
      expect(second.nextCursor).toBeNull();
      await expect(
        source.read({
          profile: page.canonicalProfile,
          selector: { kind: "browser_profile", view: "artifacts" },
          cursor: first.nextCursor ?? undefined,
          limit: 1,
        }),
      ).rejects.toThrow();
      await source.close?.();
    } finally {
      await rm(downloadRoot, { recursive: true, force: true });
      await rm(buildDirectory, { recursive: true, force: true });
    }
  });

  test("rejects extra and accessor source options", () => {
    const readProfile = async () => ({ items: [], nextCursor: null });
    const invoke = (value: unknown) =>
      Reflect.apply(createEnterpriseBrowserProfileContentReadSource, undefined, [value]);
    expect(() => invoke({ readProfile, extra: true })).toThrow();
    expect(() =>
      invoke(Object.defineProperty({ readProfile }, "onClose", { get: () => undefined })),
    ).toThrow();
    expect(() =>
      Reflect.apply(createProductionEnterpriseBrowserProfileContentReadSource, undefined, [
        { addonPath: "x", extra: true },
      ]),
    ).toThrow();
    expect(() =>
      Reflect.apply(createProductionEnterpriseBrowserProfileContentReadSource, undefined, [
        Object.defineProperty({ addonPath: "x" }, "workspaceFs", { get: () => undefined }),
      ]),
    ).toThrow();
    expect(() =>
      Reflect.apply(createProductionEnterpriseBrowserProfileContentReadSource, undefined, [
        { addonPath: "x", workspaceFs: {} },
      ]),
    ).toThrow();
  });
});
