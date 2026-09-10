import {
  EnterpriseOrganizationResourceProjectionSchema,
  GlobalResourceRefSchema,
  NodeIdSchema,
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
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import {
  createEnterpriseResourceDispatcherFactory,
  type EnterpriseResourceDispatcherFactory,
} from "./enterprise-resource-dispatcher-factory.js";
import { getAuthoritativeAgent, getAuthoritativeWorkspace } from "./owner-registry.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import type { ProductionPrincipalGrantSource } from "../identity/principal-source.js";
import { isAuthoritativeGrantStoreForAudit } from "./grant-store.js";
import { createLocalWorkspaceTransfer, type WorkspaceTransfer } from "./workspace-transfer.js";

export interface ProductionResourceBundleOptions {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly workspaceRegistry: FileBackedWorkspaceRegistry;
  readonly agentRecords: ProductionAgentRecordSource;
  readonly nodeId: NodeId;
  readonly audit?: ProductionAuditCapability;
  readonly principalSource?: ProductionPrincipalGrantSource;
}

export interface ProductionAgentRecordSource {
  readonly list: () => Promise<readonly StoredAgentRecord[]> | readonly StoredAgentRecord[];
}

export interface ProductionResourceBundle {
  readonly dispatcherFactory: EnterpriseResourceDispatcherFactory;
  readonly placement: PlacementResolver;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
  readonly workspaceTransfers?: WorkspaceTransfer;
}

interface CapturedProductionResourceBundleOptions {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly workspaceRegistry: FileBackedWorkspaceRegistry;
  readonly agentRecords: ProductionAgentRecordSource;
  readonly nodeId: NodeId;
  readonly audit?: ProductionAuditCapability;
  readonly principalSource?: ProductionPrincipalGrantSource;
}

const RESOURCE_SOURCE_KEYS = new Set(["provider", "workspaceRegistry", "agentRecords", "nodeId"]);
const BUNDLE_KEYS = new Set([...RESOURCE_SOURCE_KEYS, "audit", "principalSource"]);
const BUNDLE_REQUIRED_KEYS = RESOURCE_SOURCE_KEYS;
const PLACEMENT_KEYS = new Set(["workspaceRegistry", "nodeId"]);

export async function createProductionResourceBundle(
  input: unknown,
): Promise<ProductionResourceBundle | null> {
  try {
    const captured = captureExactRecord(input, BUNDLE_KEYS, BUNDLE_REQUIRED_KEYS);
    if (!captured || !isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) {
      return null;
    }
    if (!(captured.workspaceRegistry instanceof FileBackedWorkspaceRegistry)) return null;
    if (!isAgentRecordSource(captured.agentRecords)) return null;
    if (!NodeIdSchema.safeParse(captured.nodeId).success) return null;
    const bundle = captured as unknown as CapturedProductionResourceBundleOptions;

    await bundle.workspaceRegistry.initialize();
    const records = await bundle.workspaceRegistry.list();
    if (!isCurrentProductionAuthorizationRuntimeProvider(bundle.provider)) return null;
    if (!registerPersistedWorkspaceOwners(bundle, records)) return null;
    await registerAgentRecords(bundle.provider, bundle.agentRecords, bundle.nodeId);

    const placement = createProductionPlacementResolver({
      workspaceRegistry: bundle.workspaceRegistry,
      nodeId: bundle.nodeId,
    });
    const organizationResources = createProductionOrganizationResourceSource({
      provider: bundle.provider,
      workspaceRegistry: bundle.workspaceRegistry,
      agentRecords: bundle.agentRecords,
      nodeId: bundle.nodeId,
    });
    if (!placement || !organizationResources) return null;
    const workspaceTransfers = createBundleWorkspaceTransfer(bundle);
    if (workspaceTransfers === null) return null;
    const dispatcherFactory = createEnterpriseResourceDispatcherFactory({
      provider: bundle.provider,
      placement,
      organizationResources,
      ...(workspaceTransfers ? { workspaceTransfers } : {}),
    });
    if (!dispatcherFactory) return null;
    return Object.freeze({
      dispatcherFactory,
      placement,
      organizationResources,
      ...(workspaceTransfers ? { workspaceTransfers } : {}),
    });
  } catch {
    return null;
  }
}

function registerPersistedWorkspaceOwners(
  bundle: CapturedProductionResourceBundleOptions,
  records: readonly PersistedWorkspaceRecord[],
): boolean {
  for (const record of records) {
    if (record.nodeId !== bundle.nodeId || record.archivedAt !== null) continue;
    const existing = getAuthoritativeWorkspace(bundle.provider.owners, record.workspaceId);
    if (existing) {
      if (!sameOwner(existing, record)) return false;
      continue;
    }
    bundle.provider.owners.registerWorkspace({
      id: record.workspaceId,
      organizationId: record.organizationId,
      nodeId: record.nodeId,
      ownerPrincipalId: record.ownerPrincipalId,
      createdByPrincipalId: record.createdByPrincipalId,
    });
  }
  return true;
}

function createBundleWorkspaceTransfer(
  bundle: CapturedProductionResourceBundleOptions,
): WorkspaceTransfer | null | undefined {
  if (bundle.audit === undefined && bundle.principalSource === undefined) return undefined;
  if (!bundle.audit || !bundle.principalSource) return null;
  if (
    !productionAuditCapabilityIssuer.current(bundle.audit) ||
    !isAuthoritativeGrantStoreForAudit(bundle.provider.grantStore, bundle.audit) ||
    !bundle.principalSource.isCurrent()
  ) {
    return null;
  }
  return createLocalWorkspaceTransfer({
    workspaceRegistry: bundle.workspaceRegistry,
    audit: bundle.audit,
    principalSource: bundle.principalSource,
  });
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
        const [workspaceRecords, agentRecords] = await Promise.all([
          captured.workspaceRegistry.list(),
          captured.agentRecords.list(),
        ]);
        await registerAgentRecords(
          captured.provider,
          captured.agentRecords,
          captured.nodeId,
          agentRecords,
        );
        if (!isCurrentProductionAuthorizationRuntimeProvider(captured.provider)) {
          throw new Error("production resource source is unavailable");
        }
        const workspaceRows = workspaceRecords
          .filter(
            (record) =>
              record.archivedAt === null &&
              record.organizationId === request.organizationId &&
              record.nodeId === captured.nodeId &&
              (request.resourceKinds.length === 0 || request.resourceKinds.includes("workspace")),
          )
          .map((record) => workspaceProjection(record, captured.nodeId));
        const agentRows = agentRecords
          .filter(
            (record) =>
              record.archivedAt == null &&
              record.organizationId === request.organizationId &&
              record.nodeId === captured.nodeId &&
              (request.resourceKinds.length === 0 || request.resourceKinds.includes("agent")),
          )
          .map((record) => agentProjection(captured.provider, record, captured.nodeId))
          .filter((row): row is EnterpriseOrganizationResourceProjection => row !== null);
        const resources = [...workspaceRows, ...agentRows].sort((left, right) =>
          resourceId(left).localeCompare(resourceId(right)),
        );
        const afterCursor = request.cursor
          ? resources.filter((row) => resourceId(row) > request.cursor!)
          : resources;
        const limit = Math.min(request.limit ?? 100, 500);
        const page = afterCursor.slice(0, limit);
        const hasMore = afterCursor.length > page.length;
        const last = page.at(-1);
        return Object.freeze({
          principals: Object.freeze([]),
          resources: Object.freeze(resources),
          nextCursor: hasMore && last ? resourceId(last) : null,
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
    !NodeIdSchema.safeParse(captured.nodeId).success
  )
    return null;
  return captured as unknown as { workspaceRegistry: FileBackedWorkspaceRegistry; nodeId: NodeId };
}

function captureOrganizationInput(value: unknown): {
  provider: ProductionAuthorizationRuntimeProvider;
  workspaceRegistry: FileBackedWorkspaceRegistry;
  agentRecords: ProductionAgentRecordSource;
  nodeId: NodeId;
} | null {
  const captured = captureExactRecord(value, RESOURCE_SOURCE_KEYS);
  if (
    !captured ||
    !isCurrentProductionAuthorizationRuntimeProvider(captured.provider) ||
    !(captured.workspaceRegistry instanceof FileBackedWorkspaceRegistry) ||
    !NodeIdSchema.safeParse(captured.nodeId).success
  )
    return null;
  return captured as unknown as {
    provider: ProductionAuthorizationRuntimeProvider;
    workspaceRegistry: FileBackedWorkspaceRegistry;
    agentRecords: ProductionAgentRecordSource;
    nodeId: NodeId;
  };
}

async function registerAgentRecords(
  provider: ProductionAuthorizationRuntimeProvider,
  source: ProductionAgentRecordSource,
  nodeId: NodeId,
  records?: readonly StoredAgentRecord[],
): Promise<void> {
  const current = records ?? (await source.list());
  for (const record of current) {
    if (record.nodeId === nodeId && record.archivedAt == null) {
      provider.owners.registerAgent({
        id: record.id,
        workspaceId: record.workspaceId,
        organizationId: record.organizationId,
        nodeId: record.nodeId,
        ownerPrincipalId: record.ownerPrincipalId,
        createdByPrincipalId: record.createdByPrincipalId,
      });
    }
  }
}

function isAgentRecordSource(value: unknown): value is ProductionAgentRecordSource {
  return isObject(value) && typeof (value as { list?: unknown }).list === "function";
}

function agentProjection(
  provider: ProductionAuthorizationRuntimeProvider,
  record: StoredAgentRecord,
  nodeId: NodeId,
): EnterpriseOrganizationResourceProjection | null {
  const owner = getAuthoritativeAgent(provider.owners, record.id);
  if (
    !owner ||
    owner.nodeId !== nodeId ||
    owner.organizationId !== record.organizationId ||
    owner.workspaceId !== record.workspaceId
  )
    return null;
  return EnterpriseOrganizationResourceProjectionSchema.parse({
    organizationId: owner.organizationId,
    nodeId,
    resourceKind: "agent",
    agentId: record.id,
    workspaceId: owner.workspaceId,
    ownerPrincipalId: owner.ownerPrincipalId,
    label: record.title ?? record.id,
    status: record.lastStatus,
    provider: record.provider,
    model: record.config?.model ?? null,
    startedAt: record.createdAt,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt,
    durationMs: 0,
  });
}

function resourceId(row: EnterpriseOrganizationResourceProjection): string {
  if (row.resourceKind === "workspace") return row.workspaceId;
  if (row.resourceKind === "agent") return row.agentId;
  return row.resourceKind === "browser_profile" ? row.browserProfileId : row.appSlotId;
}

function captureExactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = allowed,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    [...required].some((key) => !keys.includes(key))
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
