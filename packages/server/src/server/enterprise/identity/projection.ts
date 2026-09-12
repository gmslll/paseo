import {
  projectCurrentIdentity,
  normalizeEnterpriseDisplayStrings,
  type CurrentIdentityProjection,
  type NodeContext,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";

export const ENTERPRISE_NAVIGATION = [
  "workspaces",
  "organization",
  "identity",
  "browser_profiles",
  "audit",
] as const;

export const ENTERPRISE_ALLOWED_OPERATIONS = [
  "workspace.create",
  "organization.resources.view",
  "identity.principals.view",
  "access.grants.view",
  "access.grants.manage",
  "browser.profiles.view",
  "browser.profiles.bind",
  "audit.events.view",
  "identity.logout_all",
] as const;

export interface EnterpriseIdentityDisplayProjection {
  readonly displayName?: string;
  readonly navigation: readonly string[];
  readonly allowedOperations: readonly string[];
}

export function createEnterpriseIdentityDisplayProjection(
  principal: PrincipalContext,
  displayName?: string,
): EnterpriseIdentityDisplayProjection {
  const hasAction = (action: PrincipalContext["grants"][number]["action"]): boolean =>
    principal.grants.some(
      (grant) =>
        grant.action === action &&
        (grant.selector.kind !== "organization" ||
          grant.selector.organizationId === principal.organizationId),
    );
  const hasOrganizationAction = (action: PrincipalContext["grants"][number]["action"]): boolean =>
    principal.grants.some(
      (grant) =>
        grant.action === action &&
        grant.selector.kind === "organization" &&
        grant.selector.organizationId === principal.organizationId,
    );
  const hasOrganizationIdentityManagement = hasOrganizationAction("identity.manage");
  const hasWorkspaceAccess = principal.grants.some((grant) =>
    grant.action.startsWith("workspace."),
  );
  const canViewOrganizationResources = hasAction("workspace.metadata.read");
  const canManageBrowserProfiles = hasAction("browser.profile.manage");

  const navigation = ENTERPRISE_NAVIGATION.filter((destination) => {
    switch (destination) {
      case "workspaces":
        return hasWorkspaceAccess;
      case "organization":
        return canViewOrganizationResources;
      case "identity":
        return true;
      case "browser_profiles":
        return hasAction("browser.use") || canManageBrowserProfiles;
      case "audit":
        return hasAction("audit.read");
    }
  });
  const allowedOperations = ENTERPRISE_ALLOWED_OPERATIONS.filter((operation) => {
    switch (operation) {
      case "workspace.create":
        return hasOrganizationAction("workspace.manage");
      case "organization.resources.view":
        return canViewOrganizationResources;
      case "identity.principals.view":
      case "access.grants.view":
      case "access.grants.manage":
      case "identity.logout_all":
        return hasOrganizationIdentityManagement;
      case "browser.profiles.view":
      case "browser.profiles.bind":
        return canManageBrowserProfiles;
      case "audit.events.view":
        return hasAction("audit.read");
    }
  });

  return Object.freeze({
    ...(displayName ? { displayName } : {}),
    navigation: Object.freeze(navigation),
    allowedOperations: Object.freeze(allowedOperations),
  });
}

export function createCurrentIdentityProjection(
  principal: PrincipalContext,
  node: NodeContext,
  display: {
    displayName?: string;
    navigation: readonly string[];
    allowedOperations: readonly string[];
  },
): CurrentIdentityProjection {
  return projectCurrentIdentity(principal, node, {
    displayName: display.displayName,
    navigation: normalizeEnterpriseDisplayStrings(display.navigation, ENTERPRISE_NAVIGATION),
    allowedOperations: normalizeEnterpriseDisplayStrings(
      display.allowedOperations,
      ENTERPRISE_ALLOWED_OPERATIONS,
    ),
  });
}
