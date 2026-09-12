import { describe, expect, it } from "vitest";
import {
  createBrowserProfileProjectionHydrator,
  isEnterpriseBrowserProfilesEnabled,
  isEnterpriseWorkbenchSignedIn,
} from "./enterprise-workbench-assembly";
import { normalizeHostSectionSlug } from "@/utils/host-routes";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";

const projection = { organizationId: "org-acme" } as never;

describe("enterprise workbench host assembly", () => {
  it("mounts through the host settings section route", () => {
    expect(normalizeHostSectionSlug("enterprise")).toBe("enterprise");
    expect(en.settings.hostSections.enterprise).toBe("Enterprise");
    expect(zhCN.settings.hostSections.enterprise).toBe("企业");
  });
  it("does not allocate signed-out enterprise stores", () => {
    expect(
      isEnterpriseWorkbenchSignedIn({
        state: "signed_out",
        target: "enterprise_host",
        generation: "generation-1" as never,
        projection: undefined,
      }),
    ).toBe(false);
  });

  it("requires a real signed-in organization projection", () => {
    expect(
      isEnterpriseWorkbenchSignedIn({
        state: "signed_in",
        target: "enterprise_host",
        generation: "generation-1" as never,
        projection,
      }),
    ).toBe(true);
    expect(
      isEnterpriseWorkbenchSignedIn({
        state: "signed_in",
        target: "enterprise_host",
        generation: "generation-1" as never,
        projection: undefined,
      }),
    ).toBe(false);
  });

  it("routes browser profile projections to the exact enabled host", async () => {
    expect(isEnterpriseBrowserProfilesEnabled({ enterpriseBrowserProfilesV1: true })).toBe(true);
    expect(isEnterpriseBrowserProfilesEnabled({ enterpriseBrowserProfilesV1: false })).toBe(false);
    expect(isEnterpriseBrowserProfilesEnabled(undefined)).toBe(false);

    const calls: unknown[] = [];
    const hydrate = createBrowserProfileProjectionHydrator(
      {
        hydrateBrowserProfileAuthorizationsFromProjections: async (...args) => {
          calls.push(args);
        },
      },
      "server-a",
    );
    const input = {
      serverId: "server-a",
      profiles: [],
      bindings: [],
      lifecycleGeneration: "generation-a",
    };
    await hydrate(input);
    expect(calls).toEqual([
      [
        "server-a",
        {
          profiles: input.profiles,
          bindings: input.bindings,
          lifecycleGeneration: "generation-a",
        },
      ],
    ]);
    await expect(hydrate({ ...input, serverId: "server-b" })).rejects.toThrow(
      "Browser profile hydration host does not match",
    );
    expect(calls).toHaveLength(1);
  });
});
