import { describe, expect, it } from "vitest";
import { isEnterpriseWorkbenchSignedIn } from "./enterprise-workbench-assembly";
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
});
