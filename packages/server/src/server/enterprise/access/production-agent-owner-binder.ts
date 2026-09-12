import { NodeIdSchema, type NodeId } from "@getpaseo/protocol/messages";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

declare const productionAgentOwnerBinderBrand: unique symbol;

export interface ProductionAgentOwnerBinder {
  readonly [productionAgentOwnerBinderBrand]: never;
  readonly onPersisted: (record: StoredAgentRecord) => boolean;
}

interface BinderRecord {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly nodeId: NodeId;
}

const binderRecords = new WeakMap<object, BinderRecord>();
const BINDER_KEYS = new Set(["provider", "records", "nodeId"]);

export function bindProductionAgentOwners(input: unknown): ProductionAgentOwnerBinder | null {
  try {
    const captured = captureInput(input);
    if (
      !captured ||
      !isCurrentProductionAuthorizationRuntimeProvider(captured.provider) ||
      !Array.isArray(captured.records) ||
      !captured.records.every(isStoredAgentRecord)
    ) {
      return null;
    }
    const binder = Object.freeze({
      onPersisted: (record: StoredAgentRecord): boolean => {
        try {
          const state = binderRecords.get(binder);
          if (!state || !isCurrentProductionAuthorizationRuntimeProvider(state.provider)) {
            return false;
          }
          return registerRecord(state, record);
        } catch {
          return false;
        }
      },
    }) as unknown as ProductionAgentOwnerBinder;
    binderRecords.set(
      binder,
      Object.freeze({ provider: captured.provider, nodeId: captured.nodeId }),
    );
    for (const record of captured.records) {
      registerRecord({ provider: captured.provider, nodeId: captured.nodeId }, record);
    }
    return binder;
  } catch {
    return null;
  }
}

export function isProductionAgentOwnerBinder(value: unknown): value is ProductionAgentOwnerBinder {
  return isObject(value) && binderRecords.has(value);
}

function registerRecord(state: BinderRecord, record: StoredAgentRecord): boolean {
  if (!isStoredAgentRecord(record) || record.nodeId !== state.nodeId) return false;
  state.provider.owners.registerAgent({
    id: record.id,
    workspaceId: record.workspaceId,
    organizationId: record.organizationId,
    nodeId: record.nodeId,
    ownerPrincipalId: record.ownerPrincipalId,
    createdByPrincipalId: record.createdByPrincipalId,
  });
  return true;
}

function captureInput(value: unknown): {
  provider: ProductionAuthorizationRuntimeProvider;
  records: readonly unknown[];
  nodeId: NodeId;
} | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== BINDER_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !BINDER_KEYS.has(key))
  )
    return null;
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[key] = descriptor.value;
  }
  if (
    !isCurrentProductionAuthorizationRuntimeProvider(captured.provider) ||
    !Array.isArray(captured.records) ||
    !NodeIdSchema.safeParse(captured.nodeId).success
  )
    return null;
  return {
    provider: captured.provider,
    records: captured.records,
    nodeId: captured.nodeId as NodeId,
  };
}

function isStoredAgentRecord(value: unknown): value is StoredAgentRecord {
  if (!isObject(value)) return false;
  const candidate = value as { id?: unknown; nodeId?: unknown };
  return typeof candidate.id === "string" && typeof candidate.nodeId === "string";
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
