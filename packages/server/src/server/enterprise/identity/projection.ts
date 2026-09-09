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
