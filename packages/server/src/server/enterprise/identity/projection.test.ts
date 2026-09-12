import type { PrincipalContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { createEnterpriseIdentityDisplayProjection } from "./projection.js";

const principal = (grants: PrincipalContext["grants"]): PrincipalContext => ({
  organizationId: "org_aaaaaaaaaaaaaaaa",
  principalType: "human",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  credentialId: "cred",
  grantVersion: "grant",
  grants,
});

describe("enterprise identity display projection", () => {
  test("projects organization administration from current grants", () => {
    const projection = createEnterpriseIdentityDisplayProjection(
      principal([
        {
          action: "workspace.metadata.read",
          selector: { kind: "organization", organizationId: "org_aaaaaaaaaaaaaaaa" },
        },
        {
          action: "workspace.manage",
          selector: { kind: "organization", organizationId: "org_aaaaaaaaaaaaaaaa" },
        },
        {
          action: "browser.profile.manage",
          selector: { kind: "organization", organizationId: "org_aaaaaaaaaaaaaaaa" },
        },
        {
          action: "audit.read",
          selector: { kind: "organization", organizationId: "org_aaaaaaaaaaaaaaaa" },
        },
        {
          action: "identity.manage",
          selector: { kind: "organization", organizationId: "org_aaaaaaaaaaaaaaaa" },
        },
      ]),
      "Platform Admin",
    );

    expect(projection).toEqual({
      displayName: "Platform Admin",
      navigation: ["workspaces", "organization", "identity", "browser_profiles", "audit"],
      allowedOperations: [
        "workspace.create",
        "organization.resources.view",
        "identity.principals.view",
        "access.grants.view",
        "access.grants.manage",
        "browser.profiles.view",
        "browser.profiles.bind",
        "audit.events.view",
        "identity.logout_all",
      ],
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.navigation)).toBe(true);
    expect(Object.isFrozen(projection.allowedOperations)).toBe(true);
  });

  test("projects employee resources without administration", () => {
    const projection = createEnterpriseIdentityDisplayProjection(
      principal([
        {
          action: "workspace.metadata.read",
          selector: { kind: "workspace", workspaceIds: ["wks_aaaaaaaaaaaaaaaa"] },
        },
        { action: "browser.use", selector: { kind: "self" } },
        {
          action: "identity.manage",
          selector: { kind: "organization", organizationId: "org_bbbbbbbbbbbbbbbb" },
        },
      ]),
      "Employee One",
    );

    expect(projection).toEqual({
      displayName: "Employee One",
      navigation: ["workspaces", "organization", "identity", "browser_profiles"],
      allowedOperations: ["organization.resources.view"],
    });
  });
});
