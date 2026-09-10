import {
  EnterpriseOrganizationResourceProjectionSchema,
  GlobalResourceRefSchema,
  type EnterpriseOrganizationResourceProjection,
  type GlobalResourceRef,
  type NodeId,
  type PlacementResolver,
} from "@getpaseo/protocol/messages";
import {
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import type {
  EnterpriseOrganizationResourcePage,
  EnterpriseOrganizationResourceSource,
} from "./enterprise-resource-handlers.js";
import {
  createEnterpriseResourceDispatcherFactory,
  type EnterpriseResourceDispatcherFactory,
} from "./enterprise-resource-dispatcher-factory.js";
import { getAuthoritativeWorkspace } from "./owner-registry.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

export interface ProductionResourceBundleOptions {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly workspaceRegistry: FileBackedWorkspaceRegistry;
  readonly nodeId: NodeId;
}

export interface ProductionResourceBundle {
  readonly dispatcherFactory: EnterpriseResourceDispatcherFactory;
  readonly placement: PlacementResolver;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
}

const BUNDLE_KEYS = new Set(["provider", "workspaceRegistry", "nodeId"]);
const PLACEMENT_KEYS = new Set(["workspaceRegistry", "nodeId"]);

export async function createProductionResourceBundle(
  input: unknown,
): Promise<ProductionResourceBundle | null> {
  try {
    const captured = captureExactRecord(input, BUNDLE_KEYS);
    if (!captured || !isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) {
      return null;
    }
    if (!(captured.workspaceRegistry instanceof FileBackedWorkspaceRegistry)) return null;
    if (typeof captured.nodeId !== "string" || captured.nodeId.length === 0) return null;

    await captured.workspaceRegistry.initialize();
    const records = await captured.workspaceRegistry.list();
    if (!isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) return null;
    for (const record of records) {
      if (record.nodeId !== captured.nodeId || record.archivedAt !== null) continue;
      const existing = getAuthoritativeWorkspace(captured.provider.owners, record.workspaceId);
      if (existing) {
        if (!sameOwner(existing, record)) return null;
        continue;
      }
      captured.provider.owners.registerWorkspace({
        id: record.workspaceId,
        organizationId: record.organizationId,
        nodeId: record.nodeId,
        ownerPrincipalId: record.ownerPrincipalId,
        createdByPrincipalId: record.createdByPrincipalId,
      });
    }

    const placement = createProductionPlacementResolver({
      workspaceRegistry: captured.workspaceRegistry,
      nodeId: captured.nodeId,
    });
    const organizationResources = createProductionOrganizationResourceSource({
      provider: captured.provider,
      workspaceRegistry: captured.workspaceRegistry,
      nodeId: captured.nodeId,
    });
    if (!placement || !organizationResources) return null;
    const dispatcherFactory = createEnterpriseResourceDispatcherFactory({
      provider: captured.provider,
      placement,
      organizationResources,
    });
    if (!dispatcherFactory) return null;
    return Object.freeze({ dispatcherFactory, placement, organizationResources });
  } catch {
    return null;
  }
}

export function createProductionPlacementResolver(input: unknown): PlacementResolver | null {
  try {
    const captured = capturePlacementInput(input);
    if (!captured) return null;
    return Object.freeze({
      async resolveWorkspace(workspaceId: string): Promise<GlobalResourceRef | null> {
        try {
          const record = await captured.workspaceRegistry.get(workspaceId);
          if (!record || record.archivedAt !== null || record.nodeId !== captured.nodeId)
            return null;
          return GlobalResourceRefSchema.parse({
            organizationId: record.organizationId,
            nodeId: captured.nodeId,
            resourceKind: "workspace",
            localResourceId: record.workspaceId,
          });
        } catch {
          return null;
        }
      },
    });
  } catch {
    return null;
  }
}

export function createProductionOrganizationResourceSource(
  input: unknown,
): EnterpriseOrganizationResourceSource | null {
  try {
    const captured = captureOrganizationInput(input);
    if (!captured) return null;
    return Object.freeze({
      async list(
        request: Parameters<EnterpriseOrganizationResourceSource["list"]>[0],
      ): Promise<EnterpriseOrganizationResourcePage> {
        if (!isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) {
          throw new Error("production resource source is unavailable");
        }
        const records = (await captured.workspaceRegistry.list())
          .filter(
            (record) =>
              record.archivedAt === null &&
              record.organizationId === request.organizationId &&
              record.nodeId === captured.nodeId &&
              (request.resourceKinds.length === 0 || request.resourceKinds.includes("workspace")),
          )
          .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
        const afterCursor = request.cursor
          ? records.filter((record) => record.workspaceId > request.cursor!)
          : records;
        const limit = Math.min(request.limit ?? 100, 500);
        const page = afterCursor.slice(0, limit);
        const resources = page.map((record) => workspaceProjection(record, captured.nodeId));
        const hasMore = afterCursor.length > page.length;
        return Object.freeze({
          principals: Object.freeze([]),
          resources: Object.freeze(resources),
          nextCursor: hasMore ? (page.at(-1)?.workspaceId ?? null) : null,
        });
      },
    });
  } catch {
    return null;
  }
}

function workspaceProjection(
  record: PersistedWorkspaceRecord,
  nodeId: NodeId,
): EnterpriseOrganizationResourceProjection {
  return EnterpriseOrganizationResourceProjectionSchema.parse({
    organizationId: record.organizationId,
    nodeId,
    resourceKind: "workspace",
    workspaceId: record.workspaceId,
    ownerPrincipalId: record.ownerPrincipalId,
    label: record.title ?? record.displayName,
    status: "ready",
    updatedAt: record.updatedAt,
  });
}

function capturePlacementInput(value: unknown): {
  workspaceRegistry: FileBackedWorkspaceRegistry;
  nodeId: NodeId;
} | null {
  const captured = captureExactRecord(value, PLACEMENT_KEYS);
  if (
    !captured ||
    !(captured.workspaceRegistry instanceof FileBackedWorkspaceRegistry) ||
    typeof captured.nodeId !== "string" ||
    captured.nodeId.length === 0
  )
    return null;
  return captured as unknown as { workspaceRegistry: FileBackedWorkspaceRegistry; nodeId: NodeId };
}

function captureOrganizationInput(value: unknown): {
  provider: ProductionAuthorizationRuntimeProvider;
  workspaceRegistry: FileBackedWorkspaceRegistry;
  nodeId: NodeId;
} | null {
  const captured = captureExactRecord(value, BUNDLE_KEYS);
  if (
    !captured ||
    !isCurrentProductionAuthorizationRuntimeProvider(captured.provider) ||
    !(captured.workspaceRegistry instanceof FileBackedWorkspaceRegistry) ||
    typeof captured.nodeId !== "string" ||
    captured.nodeId.length === 0
  )
    return null;
  return captured as unknown as {
    provider: ProductionAuthorizationRuntimeProvider;
    workspaceRegistry: FileBackedWorkspaceRegistry;
    nodeId: NodeId;
  };
}

function captureExactRecord(
  value: unknown,
  expected: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    return null;
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function sameOwner(
  existing: {
    organizationId: string;
    nodeId: string;
    ownerPrincipalId: string;
    createdByPrincipalId: string;
  },
  record: PersistedWorkspaceRecord,
): boolean {
  return (
    existing.organizationId === record.organizationId &&
    existing.nodeId === record.nodeId &&
    existing.ownerPrincipalId === record.ownerPrincipalId &&
    existing.createdByPrincipalId === record.createdByPrincipalId
  );
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
