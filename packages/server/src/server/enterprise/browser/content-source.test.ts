import { describe, expect, test } from "vitest";
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
});
