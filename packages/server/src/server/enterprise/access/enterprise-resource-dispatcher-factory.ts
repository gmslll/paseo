import type { PlacementResolver } from "@getpaseo/protocol/messages";
import type {
  EnterpriseDispatcherLease,
  EnterpriseDispatcherManifest,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../../session/enterprise-dispatcher.js";
import {
  createEnterpriseResourceDispatcher,
  ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES,
  type EnterpriseOrganizationResourceSource,
  type EnterpriseResourceDispatcher,
} from "./enterprise-resource-handlers.js";
import {
  isCurrentProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";
import { isCurrentProductionAuthorizationRuntimeForAuthoritySources } from "./production-authorization-runtime.js";

declare const enterpriseResourceDispatcherFactoryBrand: unique symbol;

export interface EnterpriseResourceDispatcherFactory extends EnterpriseSessionDispatcherFactoryRegistration {
  readonly [enterpriseResourceDispatcherFactoryBrand]: never;
}

export interface EnterpriseResourceDispatcherFactoryOptions {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly placement: PlacementResolver;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
}

interface FactoryRecord {
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly placement: PlacementResolver;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
}

interface LeaseState {
  active: boolean;
  readonly delegate: EnterpriseResourceDispatcher;
}

const FACTORY_OPTION_KEYS = new Set(["provider", "placement", "organizationResources"]);
const factoryRecords = new WeakMap<object, FactoryRecord>();

export const ENTERPRISE_RESOURCE_DISPATCHER_MANIFEST: EnterpriseDispatcherManifest = Object.freeze({
  operations: ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES,
});

export class EnterpriseResourceDispatcherOpenError extends Error {
  constructor() {
    super("Enterprise resource dispatcher is unavailable for this Session authority");
    this.name = "EnterpriseResourceDispatcherOpenError";
  }
}

export function createEnterpriseResourceDispatcherFactory(
  input: unknown,
): EnterpriseResourceDispatcherFactory | null {
  try {
    const options = captureExactRecord(input, FACTORY_OPTION_KEYS);
    if (!options) return null;
    const provider = options.provider;
    if (!isCurrentProductionAuthorizationRuntimeProvider(provider)) return null;
    const placement = capturePlacementResolver(options.placement);
    const organizationResources = captureOrganizationResourceSource(options.organizationResources);
    if (!placement || !organizationResources) return null;

    let factory: EnterpriseResourceDispatcherFactory;
    const registration = Object.assign(Object.create(null) as object, {
      manifest: ENTERPRISE_RESOURCE_DISPATCHER_MANIFEST,
      open: (registrationInput: unknown): EnterpriseDispatcherLease => {
        const runtime = captureAuthorizationRuntime(registrationInput);
        const lease = openEnterpriseResourceDispatcher(factory, runtime);
        if (!lease) throw new EnterpriseResourceDispatcherOpenError();
        return lease;
      },
    });
    factory = Object.freeze(registration) as EnterpriseResourceDispatcherFactory;
    factoryRecords.set(factory, Object.freeze({ provider, placement, organizationResources }));
    return factory;
  } catch {
    return null;
  }
}

export function openEnterpriseResourceDispatcher(
  factory: unknown,
  runtime: unknown,
): EnterpriseDispatcherLease | null {
  try {
    if (!isObject(factory)) return null;
    const record = factoryRecords.get(factory);
    if (
      !record ||
      !isCurrentProductionAuthorizationRuntimeProvider(record.provider) ||
      !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
        runtime,
        record.provider.grantStore,
        record.provider.owners,
      )
    ) {
      return null;
    }
    const delegate = createEnterpriseResourceDispatcher({
      runtime,
      grantStore: record.provider.grantStore,
      owners: record.provider.owners,
      placement: record.placement,
      organizationResources: record.organizationResources,
    });
    if (
      !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
        runtime,
        record.provider.grantStore,
        record.provider.owners,
      )
    ) {
      return null;
    }
    return createLease(delegate);
  } catch {
    return null;
  }
}

function createLease(delegate: EnterpriseResourceDispatcher): EnterpriseDispatcherLease {
  const state: LeaseState = { active: true, delegate };
  const dispatcher: EnterpriseResourceDispatcher = Object.freeze({
    requestPolicyForType: (requestType: string) =>
      state.active ? state.delegate.requestPolicyForType(requestType) : null,
    handle: async (input: Parameters<EnterpriseResourceDispatcher["handle"]>[0]) => {
      if (!state.active) return false;
      try {
        const response = await state.delegate.handle(input);
        return state.active ? response : false;
      } catch {
        return false;
      }
    },
    consumeResponse: (input: Parameters<EnterpriseResourceDispatcher["consumeResponse"]>[0]) => {
      if (!state.active) return null;
      try {
        return state.delegate.consumeResponse(input);
      } catch {
        return null;
      }
    },
  });
  return Object.freeze({
    dispatcher,
    close: () => {
      state.active = false;
    },
  });
}

function capturePlacementResolver(value: unknown): PlacementResolver | null {
  const resolveWorkspace = captureMethod<PlacementResolver["resolveWorkspace"]>(
    value,
    "resolveWorkspace",
  );
  return resolveWorkspace ? Object.freeze({ resolveWorkspace }) : null;
}

function captureOrganizationResourceSource(
  value: unknown,
): EnterpriseOrganizationResourceSource | null {
  const list = captureMethod<EnterpriseOrganizationResourceSource["list"]>(value, "list");
  return list ? Object.freeze({ list }) : null;
}

function captureMethod<T extends (...parameters: never[]) => unknown>(
  receiver: unknown,
  name: string,
): T | null {
  if (!isObject(receiver)) return null;
  let current: object | null = receiver;
  while (current) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      return descriptor.value.bind(receiver) as T;
    }
    current = Reflect.getPrototypeOf(current);
  }
  return null;
}

function captureAuthorizationRuntime(input: unknown): unknown {
  if (!isObject(input)) return null;
  const descriptor = Reflect.getOwnPropertyDescriptor(input, "authorizationRuntime");
  if (!descriptor || !("value" in descriptor)) return null;
  return descriptor.value;
}

function captureExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return null;
  }
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
