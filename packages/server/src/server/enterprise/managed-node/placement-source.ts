import {
  ManagedPlacementRegistrationSchema,
  type ManagedPlacementRegistration,
} from "@getpaseo/protocol/enterprise-management";
import type { EnterpriseOrganizationResourceProjection } from "@getpaseo/protocol/messages";

import type { EnterpriseOrganizationResourceSource } from "../access/enterprise-resource-handlers.js";
import type { BrowserProfileRegistry } from "../browser/profile-registry.js";

const PAGE_SIZE = 500;
const MAX_PAGES = 1_000;

export function createManagedPlacementSnapshotSource(input: {
  readonly organizationId: string;
  readonly nodeId: string;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
  readonly browserProfiles: BrowserProfileRegistry;
}): () => Promise<readonly ManagedPlacementRegistration[]> {
  return async () => {
    const resources = await listOrganizationResources(input);
    const browserProfiles = await input.browserProfiles.list();
    const placements = [
      ...resources.map(resourcePlacement),
      ...browserProfiles.map((profile) =>
        ManagedPlacementRegistrationSchema.parse({
          resource: {
            organizationId: profile.organizationId,
            nodeId: profile.homeNodeId,
            resourceKind: "browser_profile",
            localResourceId: profile.browserProfileId,
          },
          ownerPrincipalId: profile.ownerPrincipalId,
        }),
      ),
    ];
    const seen = new Set<string>();
    for (const placement of placements) {
      if (
        placement.resource.organizationId !== input.organizationId ||
        placement.resource.nodeId !== input.nodeId
      ) {
        throw new Error("managed placement source returned a foreign resource");
      }
      const key = placementKey(placement);
      if (seen.has(key)) throw new Error("managed placement source returned a duplicate resource");
      seen.add(key);
    }
    return Object.freeze(
      placements.sort((left, right) => placementKey(left).localeCompare(placementKey(right))),
    );
  };
}

async function listOrganizationResources(input: {
  readonly organizationId: string;
  readonly nodeId: string;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
}): Promise<readonly EnterpriseOrganizationResourceProjection[]> {
  const resources: EnterpriseOrganizationResourceProjection[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await input.organizationResources.list({
      organizationId: input.organizationId,
      nodeId: input.nodeId,
      resourceKinds: ["workspace", "agent"],
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    });
    resources.push(...page.resources);
    if (page.nextCursor === null) return Object.freeze(resources);
    if (!page.nextCursor || page.nextCursor === cursor) {
      throw new Error("managed placement source cursor did not advance");
    }
    cursor = page.nextCursor;
  }
  throw new Error("managed placement source exceeded the page limit");
}

function resourcePlacement(
  resource: EnterpriseOrganizationResourceProjection,
): ManagedPlacementRegistration {
  if (resource.resourceKind === "workspace") {
    return ManagedPlacementRegistrationSchema.parse({
      resource: {
        organizationId: resource.organizationId,
        nodeId: resource.nodeId,
        resourceKind: resource.resourceKind,
        localResourceId: resource.workspaceId,
      },
      ownerPrincipalId: resource.ownerPrincipalId,
    });
  }
  if (resource.resourceKind === "agent") {
    return ManagedPlacementRegistrationSchema.parse({
      resource: {
        organizationId: resource.organizationId,
        nodeId: resource.nodeId,
        resourceKind: resource.resourceKind,
        localResourceId: resource.agentId,
      },
      ownerPrincipalId: resource.ownerPrincipalId,
    });
  }
  throw new Error(`unsupported managed placement resource kind ${resource.resourceKind}`);
}

function placementKey(placement: ManagedPlacementRegistration): string {
  const resource = placement.resource;
  return JSON.stringify([
    resource.organizationId,
    resource.nodeId,
    resource.resourceKind,
    resource.localResourceId,
  ]);
}
