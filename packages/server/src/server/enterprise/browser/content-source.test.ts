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

describe("browser profile content source", () => {
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
        const source = createProductionEnterpriseBrowserProfileContentReadSource({ addonPath });
        expect(source).not.toBeNull();
        if (!source) return;
        await expect(
          source.read({
            profile: { ...profile, downloadRoot },
            selector: { kind: "browser_profile", view: "state" },
            limit: 1,
          }),
        ).resolves.toMatchObject({ items: [{ kind: "state", label: "Profile" }] });
        await source.close?.();
        await expect(
          source.read({
            profile: { ...profile, downloadRoot },
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
      const source = createProductionEnterpriseBrowserProfileContentReadSource({ addonPath });
      if (!source) throw new Error("native source unavailable");
      const first = await source.read({
        profile: { ...profile, downloadRoot },
        selector: { kind: "browser_profile", view: "artifacts" },
        limit: 1,
      });
      expect(first.items.map((item) => item.reference)).toEqual(["a.txt"]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.nextCursor).not.toBe("1");
      await writeFile(path.join(downloadRoot, "aa.txt"), "aa");
      const second = await source.read({
        profile: { ...profile, downloadRoot },
        selector: { kind: "browser_profile", view: "artifacts" },
        cursor: first.nextCursor ?? undefined,
        limit: 1,
      });
      expect(second.items.map((item) => item.reference)).toEqual(["b.txt"]);
      expect(second.nextCursor).toBeNull();
      await expect(
        source.read({
          profile: { ...profile, downloadRoot },
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
