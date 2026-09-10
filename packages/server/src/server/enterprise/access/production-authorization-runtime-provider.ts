import path from "node:path";

import { isSessionAuthorization, type SessionAuthorization } from "../../authorization/index.js";
import type {
  EnterpriseAdmissionAuthorizationHandle,
  EnterpriseAdmissionAuthorizationIssuer,
} from "../identity/admission-authorization.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import { FileBackedGrantStorage, GrantStore } from "./grant-store.js";
import { OwnerRegistry } from "./owner-registry.js";
import {
  createEnterpriseAuthorizationRuntime,
  type ProductionAuthorizationRuntime,
  type ProductionAuthorizationStatePort,
} from "./production-authorization-runtime.js";
import type { AuthorityReceiptClock } from "./authority-receipt-verifier.js";
import type {
  AppSlotRegistry,
  BrowserProfileRegistry,
  WorkspacePathRegistry,
} from "./resource-authorization.js";

declare const productionAuthorizationRuntimeProviderBrand: unique symbol;

export interface ProductionAuthorizationRuntimeProvider {
  readonly [productionAuthorizationRuntimeProviderBrand]: never;
  readonly grantStore: GrantStore;
  readonly owners: OwnerRegistry;
}

export interface ProductionAuthorizationRuntimeProviderOptions {
  readonly audit: ProductionAuditCapability;
  readonly grantFilePath: string;
  readonly authorityReceiptClock?: AuthorityReceiptClock;
  readonly browserProfiles?: BrowserProfileRegistry;
  readonly appSlots?: AppSlotRegistry;
  readonly workspacePaths?: WorkspacePathRegistry;
}

export interface ProductionAuthorizationRuntimeSessionDependencies {
  readonly admissionAuthorizationIssuer: EnterpriseAdmissionAuthorizationIssuer;
  readonly admissionAuthorizationHandle: EnterpriseAdmissionAuthorizationHandle;
  readonly sessionAuthorization: SessionAuthorization;
  readonly sessionId: string;
  readonly authorityState: ProductionAuthorizationStatePort;
}

interface ProviderRecord {
  readonly audit: ProductionAuditCapability;
  readonly grantStore: GrantStore;
  readonly owners: OwnerRegistry;
  readonly authorityReceiptClock?: AuthorityReceiptClock;
  readonly browserProfiles?: BrowserProfileRegistry;
  readonly appSlots?: AppSlotRegistry;
  readonly workspacePaths?: WorkspacePathRegistry;
}

const providerRecords = new WeakMap<object, ProviderRecord>();
const PROVIDER_OPTION_KEYS = new Set([
  "audit",
  "grantFilePath",
  "authorityReceiptClock",
  "browserProfiles",
  "appSlots",
  "workspacePaths",
]);
const PROVIDER_REQUIRED_KEYS = new Set(["audit", "grantFilePath"]);
const SESSION_DEPENDENCY_KEYS = new Set([
  "admissionAuthorizationIssuer",
  "admissionAuthorizationHandle",
  "sessionAuthorization",
  "sessionId",
  "authorityState",
]);

export function createProductionAuthorizationRuntimeProvider(
  input: unknown,
): ProductionAuthorizationRuntimeProvider | null {
  try {
    const options = captureProviderOptions(input);
    if (
      !options ||
      !path.isAbsolute(options.grantFilePath) ||
      !productionAuditCapabilityIssuer.current(options.audit)
    ) {
      return null;
    }
    const grantStore = new GrantStore(
      new FileBackedGrantStorage(options.grantFilePath),
      undefined,
      options.audit,
    );
    const owners = new OwnerRegistry();
    const provider = Object.freeze(
      Object.assign(Object.create(null) as object, { grantStore, owners }),
    ) as ProductionAuthorizationRuntimeProvider;
    providerRecords.set(
      provider,
      Object.freeze({
        audit: options.audit,
        grantStore,
        owners,
        authorityReceiptClock: options.authorityReceiptClock,
        browserProfiles: options.browserProfiles,
        appSlots: options.appSlots,
        workspacePaths: options.workspacePaths,
      }),
    );
    return provider;
  } catch {
    return null;
  }
}

export function isProductionAuthorizationRuntimeProvider(
  value: unknown,
): value is ProductionAuthorizationRuntimeProvider {
  return isObject(value) && providerRecords.has(value);
}

export async function createProductionAuthorizationRuntimeForSession(
  provider: unknown,
  input: unknown,
): Promise<ProductionAuthorizationRuntime | null> {
  try {
    if (!isObject(provider)) return null;
    const shared = providerRecords.get(provider);
    if (!shared || !productionAuditCapabilityIssuer.current(shared.audit)) return null;
    const session = captureSessionDependencies(input);
    if (!session || !isSessionAuthorization(session.sessionAuthorization)) return null;
    return createEnterpriseAuthorizationRuntime({
      admissionAuthorizationIssuer: session.admissionAuthorizationIssuer,
      admissionAuthorizationHandle: session.admissionAuthorizationHandle,
      grantStore: shared.grantStore,
      audit: shared.audit,
      sessionAuthorization: session.sessionAuthorization,
      sessionId: session.sessionId,
      owners: shared.owners,
      authorityState: session.authorityState,
      authorityReceiptClock: shared.authorityReceiptClock,
      browserProfiles: shared.browserProfiles,
      appSlots: shared.appSlots,
      workspacePaths: shared.workspacePaths,
    });
  } catch {
    return null;
  }
}

function captureProviderOptions(
  input: unknown,
): Readonly<ProductionAuthorizationRuntimeProviderOptions> | null {
  const captured = captureExactRecord(input, PROVIDER_OPTION_KEYS, PROVIDER_REQUIRED_KEYS);
  if (
    !captured ||
    typeof captured.grantFilePath !== "string" ||
    captured.grantFilePath.length === 0
  )
    return null;
  return Object.freeze({
    audit: captured.audit as ProductionAuditCapability,
    grantFilePath: captured.grantFilePath,
    authorityReceiptClock: captured.authorityReceiptClock as AuthorityReceiptClock | undefined,
    browserProfiles: captured.browserProfiles as BrowserProfileRegistry | undefined,
    appSlots: captured.appSlots as AppSlotRegistry | undefined,
    workspacePaths: captured.workspacePaths as WorkspacePathRegistry | undefined,
  });
}

function captureSessionDependencies(
  input: unknown,
): Readonly<ProductionAuthorizationRuntimeSessionDependencies> | null {
  const captured = captureExactRecord(input, SESSION_DEPENDENCY_KEYS, SESSION_DEPENDENCY_KEYS);
  if (!captured || typeof captured.sessionId !== "string" || captured.sessionId.length === 0)
    return null;
  return Object.freeze({
    admissionAuthorizationIssuer:
      captured.admissionAuthorizationIssuer as EnterpriseAdmissionAuthorizationIssuer,
    admissionAuthorizationHandle:
      captured.admissionAuthorizationHandle as EnterpriseAdmissionAuthorizationHandle,
    sessionAuthorization: captured.sessionAuthorization as SessionAuthorization,
    sessionId: captured.sessionId,
    authorityState: captured.authorityState as ProductionAuthorizationStatePort,
  });
}

function captureExactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    [...required].some((key) => !keys.includes(key))
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
