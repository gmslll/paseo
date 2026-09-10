import path from "node:path";

import {
  ENTERPRISE_ACTIONS,
  HumanPrincipalIdSchema,
  NodeContextSchema,
  OrganizationIdSchema,
} from "@getpaseo/protocol/messages";
import { EnterpriseMultiUserSchema, type EnterpriseMultiUserConfig } from "../persisted-config.js";
import { createAdmissionInvalidationSink } from "../session/enterprise-admission-invalidation.js";
import { createEnterpriseAgentSessionContextRegistry } from "../session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "../session/enterprise-authority-receipt-state.js";
import {
  GrantStorePrincipalGrantVersionGuard,
  ResourceAuthorizationService,
} from "./access/resource-authorization.js";
import {
  createProductionAuthorizationRuntimeProvider,
  type ProductionAuthorizationRuntimeProvider,
} from "./access/production-authorization-runtime-provider.js";
import {
  isAuthoritativeGrantStoreForAudit,
  readAuthoritativeGrantRecord,
} from "./access/grant-store.js";
import { isCurrentProductionAuthorizationRuntimeForAuthoritySources } from "./access/production-authorization-runtime.js";
import { StrictOutboundAuthorityVerifier } from "./access/authority-receipt-verifier.js";
import { createEnterpriseAuditDispatcher } from "./audit/handlers.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./audit/production-audit-runtime.js";
import { createEnterpriseAdmission } from "./identity/admission.js";
import {
  invalidateEnterpriseCredential,
  invalidateEnterprisePrincipal,
} from "./identity/admission-authorization.js";
import { createSessionBindingGeneration } from "./identity/authenticator.js";
import {
  createProductionPrincipalGrantSource,
  createProductionPrincipalProvisioning,
} from "./identity/principal-source.js";
import { createProductionEnterpriseIdentityDispatcherRegistration } from "./identity/handlers.js";
import type { CredentialInvalidation, CredentialInvalidationSink } from "./identity/registry.js";
import type { EnterpriseAdmissionRuntime } from "./identity/runtime.js";
import { prepareProductionBrowserProfileRegistry } from "./browser/production-bundle.js";
import type { BrowserProfileRegistry } from "./browser/profile-registry.js";
import {
  createProductionAppSlotRegistry,
  isCurrentProductionAppSlotRegistry,
} from "./runtime/production-app-slot-registry.js";
import type {
  EnterpriseDispatcherLease,
  EnterpriseSessionDispatcher,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../session/enterprise-dispatcher.js";
import {
  createProductionEnterpriseProvisioningPorts,
  provisionProductionEnterpriseInitialAdmin,
  type ProductionInitialCredential,
} from "./production-provisioning.js";

export interface ProductionEnterpriseRuntimeFactoryOptions {
  readonly paseoHome: string;
  readonly daemonPassword?: string;
}

export interface ProductionEnterpriseRuntimeFactoryInput {
  readonly config: EnterpriseMultiUserConfig;
  readonly audit: ProductionAuditCapability;
}

export type ProductionEnterpriseRuntimeFactory = (
  input: ProductionEnterpriseRuntimeFactoryInput,
) => Promise<EnterpriseAdmissionRuntime>;

export interface ProductionEnterpriseInitialAdminInput {
  readonly paseoHome: string;
  readonly enterpriseConfig: EnterpriseMultiUserConfig;
  readonly paseoServerId: string;
  readonly daemonPasswordHash: string;
  readonly bootstrapPassword: string;
  readonly principalId: string;
  readonly displayName?: string;
  readonly organizationId?: string;
}

export interface ProductionEnterpriseInitialAdminDependencies {
  readonly issueAudit?: typeof productionAuditCapabilityIssuer.issue;
}

const AUDIT_OPERATIONS = Object.freeze(["enterprise.audit.list_events.request"]);
const productionIdentityRecords = new WeakMap<
  object,
  {
    readonly admission: ReturnType<typeof createEnterpriseAdmission>;
    readonly source: ReturnType<typeof createProductionPrincipalGrantSource>;
    readonly audit: ProductionAuditCapability;
    readonly provider: ProductionAuthorizationRuntimeProvider;
    readonly browserProfiles: BrowserProfileRegistry;
  }
>();

/** Root-owned composition of the W1/W2/W3 production authority objects. */
export function createProductionEnterpriseRuntimeFactory(
  options: ProductionEnterpriseRuntimeFactoryOptions,
): ProductionEnterpriseRuntimeFactory {
  const paseoHome = capturePaseoHome(options.paseoHome);
  const daemonPassword = options.daemonPassword;
  return async ({ config, audit }) => {
    if (config.enabled !== true) throw new Error("enterprise runtime requires enabled config");
    const currentAudit = productionAuditCapabilityIssuer.requireCurrent(audit);
    const node = Object.freeze(
      NodeContextSchema.parse({
        nodeId: config.nodeId,
        paseoServerId: currentAudit.node.paseoServerId,
        mode: "standalone",
      }),
    );
    if (
      currentAudit.node.nodeId !== node.nodeId ||
      currentAudit.node.mode !== node.mode ||
      config.managementMode !== "standalone"
    ) {
      throw new Error("enterprise audit and node configuration do not match");
    }

    const browserProfiles = await prepareProductionBrowserProfileRegistry({
      paseoHome,
      nodeId: node.nodeId,
      downloadBaseRoot: path.join(paseoHome, "enterprise", "browser", "profile-data"),
    });
    const appSlots = createProductionAppSlotRegistry({
      paseoHome,
      organizationId: config.organizationId,
      node,
    });
    if (!appSlots) throw new Error("enterprise App Slot registry unavailable");
    try {
      await appSlots.initialize();
      if (!isCurrentProductionAppSlotRegistry(appSlots)) {
        throw new Error("enterprise App Slot registry unavailable");
      }
    } catch (error) {
      await appSlots.close();
      throw error;
    }
    productionAuditCapabilityIssuer.requireCurrent(currentAudit);
    try {
      const authorizationRuntimeProvider = createProductionAuthorizationRuntimeProvider({
        audit: currentAudit,
        grantFilePath: path.join(paseoHome, "enterprise", "grants.json"),
        browserProfiles,
        appSlots,
      });
      if (!authorizationRuntimeProvider) {
        throw new Error("enterprise authorization provider unavailable");
      }
      const admissionInvalidationSink = createAdmissionInvalidationSink();
      const principalSource = createProductionPrincipalGrantSource({
        filePath: path.join(paseoHome, "enterprise", "principals.json"),
        grantStore: authorizationRuntimeProvider.grantStore,
        audit: currentAudit,
      });
      await principalSource.ready();

      let admission: ReturnType<typeof createEnterpriseAdmission> | null = null;
      const invalidation = createCredentialInvalidationBridge({
        getAdmission: () => admission,
        provider: authorizationRuntimeProvider,
        sessionSink: admissionInvalidationSink,
        audit: currentAudit,
      });
      admission = createEnterpriseAdmission({
        filePath: path.join(paseoHome, "enterprise", "credentials.json"),
        principalSource,
        invalidation,
        node,
        audit: currentAudit,
        organizationId: config.organizationId,
        ...(daemonPassword ? { daemonPassword } : {}),
      });
      await admission.registry.load();
      productionAuditCapabilityIssuer.requireCurrent(currentAudit);

      const agentContextRegistry = createEnterpriseAgentSessionContextRegistry();
      const authorityReceiptState = new MemoryAuthorityReceiptState();
      const grantVersionGuard = new GrantStorePrincipalGrantVersionGuard(
        authorizationRuntimeProvider.grantStore,
      );
      const resourceAuthorization = new ResourceAuthorizationService({
        owners: authorizationRuntimeProvider.owners,
        nodeId: node.nodeId,
        grantVersionGuard,
        authorityVerifier: new StrictOutboundAuthorityVerifier(node.nodeId, authorityReceiptState),
        browserProfiles,
        appSlots,
      });
      productionAuditCapabilityIssuer.requireCurrent(currentAudit);
      let closePromise: Promise<void> | null = null;
      const runtime = Object.freeze({
        audit: currentAudit,
        admission,
        node,
        agentContextRegistry,
        authorityReceiptState,
        grantVersionGuard,
        resourceAuthorization,
        authorizationRuntimeProvider,
        admissionInvalidationSink,
        principalSource,
        nextSessionBindingGeneration: createSessionBindingGeneration,
        close() {
          closePromise ??= appSlots.close();
          return closePromise;
        },
      });
      productionIdentityRecords.set(
        admission,
        Object.freeze({
          admission,
          source: principalSource,
          audit: currentAudit,
          provider: authorizationRuntimeProvider,
          browserProfiles,
        }),
      );
      return runtime;
    } catch (error) {
      await appSlots.close();
      throw error;
    }
  };
}

/**
 * Provisions the first administrator without starting a daemon. The audit capability is the
 * lifetime owner for the one-shot authority graph; closing it invalidates the admission issuer and
 * the single authorization provider before this function returns.
 */
export async function provisionProductionEnterpriseInitialAdminFromHome(
  input: ProductionEnterpriseInitialAdminInput,
  dependencies: ProductionEnterpriseInitialAdminDependencies = {},
): Promise<ProductionInitialCredential & { readonly principalId: string }> {
  const paseoHome = capturePaseoHome(input.paseoHome);
  const enterpriseConfig = Object.freeze(
    EnterpriseMultiUserSchema.parse(structuredClone(input.enterpriseConfig)),
  );
  if (enterpriseConfig.enabled !== true) {
    throw new Error("enterprise multi-user mode is not enabled");
  }
  const organizationId = OrganizationIdSchema.parse(
    input.organizationId ?? enterpriseConfig.organizationId,
  );
  if (organizationId !== enterpriseConfig.organizationId) {
    throw new Error("enterprise organization does not match daemon configuration");
  }
  const principalId = HumanPrincipalIdSchema.parse(input.principalId);
  if (typeof input.daemonPasswordHash !== "string" || input.daemonPasswordHash.length === 0) {
    throw new Error("enterprise initialization requires a configured daemon password");
  }
  if (typeof input.bootstrapPassword !== "string" || input.bootstrapPassword.length === 0) {
    throw new Error("enterprise initialization requires the daemon password");
  }
  const node = Object.freeze(
    NodeContextSchema.parse({
      nodeId: enterpriseConfig.nodeId,
      paseoServerId: input.paseoServerId,
      mode: "standalone",
    }),
  );
  const issueAudit = dependencies.issueAudit ?? productionAuditCapabilityIssuer.issue;
  const audit = await issueAudit({
    node,
    auditRoot: path.join(paseoHome, "enterprise", "audit"),
  });
  let result: ProductionInitialCredential & { readonly principalId: string };
  let primaryError: unknown;
  try {
    const currentAudit = productionAuditCapabilityIssuer.requireCurrent(audit);
    const provider = createProductionAuthorizationRuntimeProvider({
      audit: currentAudit,
      grantFilePath: path.join(paseoHome, "enterprise", "grants.json"),
    });
    if (!provider) throw new Error("enterprise authorization provider unavailable");
    const principalSource = createProductionPrincipalGrantSource({
      filePath: path.join(paseoHome, "enterprise", "principals.json"),
      grantStore: provider.grantStore,
      audit: currentAudit,
    });
    const principalProvisioning = createProductionPrincipalProvisioning({
      filePath: path.join(paseoHome, "enterprise", "principals.json"),
      audit: currentAudit,
    });
    const sessionSink = createAdmissionInvalidationSink();
    let admission: ReturnType<typeof createEnterpriseAdmission> | null = null;
    const invalidation = createCredentialInvalidationBridge({
      getAdmission: () => admission,
      provider,
      sessionSink,
      audit: currentAudit,
    });
    admission = createEnterpriseAdmission({
      filePath: path.join(paseoHome, "enterprise", "credentials.json"),
      principalSource,
      invalidation,
      node,
      audit: currentAudit,
      organizationId,
      daemonPassword: input.daemonPasswordHash,
    });
    await admission.registry.load();
    const ports = createProductionEnterpriseProvisioningPorts({
      audit: currentAudit,
      admission,
      provider,
      principalProvisioning,
    });
    const grants = ENTERPRISE_ACTIONS.map((action) => ({
      action,
      selector: { kind: "organization" as const, organizationId },
    }));
    result = await provisionProductionEnterpriseInitialAdmin(
      {
        paseoHome,
        organizationId,
        principalId,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        grants,
      },
      ports,
      input.bootstrapPassword,
    );
    await principalSource.ready();
    productionAuditCapabilityIssuer.requireCurrent(currentAudit);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown;
  try {
    await audit.close();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "enterprise initialization and audit cleanup failed",
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}

/** Returns the exact W4 profile registry captured by the production authority graph. */
export function resolveProductionBrowserProfileRegistry(input: {
  readonly admission: EnterpriseAdmissionRuntime["admission"];
  readonly audit: ProductionAuditCapability;
  readonly provider: ProductionAuthorizationRuntimeProvider;
}): BrowserProfileRegistry | null {
  try {
    const record = productionIdentityRecords.get(input.admission);
    if (
      !record ||
      record.admission !== input.admission ||
      record.audit !== input.audit ||
      record.provider !== input.provider ||
      !productionAuditCapabilityIssuer.current(record.audit) ||
      !record.source.isCurrent()
    ) {
      return null;
    }
    return record.browserProfiles;
  } catch {
    return null;
  }
}

export function createProductionIdentityDispatcherRegistration(input: {
  readonly admission: EnterpriseAdmissionRuntime["admission"];
  readonly audit: ProductionAuditCapability;
  readonly provider: ProductionAuthorizationRuntimeProvider;
}): EnterpriseSessionDispatcherFactoryRegistration | null {
  try {
    const record = productionIdentityRecords.get(input.admission);
    if (
      !record ||
      record.admission !== input.admission ||
      record.audit !== input.audit ||
      record.provider !== input.provider ||
      !record.source.isCurrent() ||
      !isAuthoritativeGrantStoreForAudit(input.provider.grantStore, input.audit)
    ) {
      return null;
    }
    return createProductionEnterpriseIdentityDispatcherRegistration({
      admission: record.admission,
      source: record.source,
      audit: record.audit,
    });
  } catch {
    return null;
  }
}

export function createProductionAuditDispatcherRegistration(input: {
  readonly audit: ProductionAuditCapability;
  readonly provider: ProductionAuthorizationRuntimeProvider;
}): EnterpriseSessionDispatcherFactoryRegistration | null {
  try {
    const audit = productionAuditCapabilityIssuer.requireCurrent(input.audit);
    const provider = input.provider;
    if (!isAuthoritativeGrantStoreForAudit(provider.grantStore, audit)) return null;
    return Object.freeze({
      manifest: Object.freeze({ operations: AUDIT_OPERATIONS }),
      open(openInput: { readonly authorizationRuntime?: unknown }): EnterpriseDispatcherLease {
        if (
          !productionAuditCapabilityIssuer.current(audit) ||
          !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
            openInput.authorizationRuntime,
            provider.grantStore,
            provider.owners,
          )
        ) {
          throw new Error("enterprise audit dispatcher authority unavailable");
        }
        const delegate = createEnterpriseAuditDispatcher({ audit });
        let active = true;
        return Object.freeze({
          dispatcher: Object.freeze({
            async handle(handleInput: Parameters<EnterpriseSessionDispatcher["handle"]>[0]) {
              if (!active || !productionAuditCapabilityIssuer.current(audit)) return false;
              const response = await delegate.handle(handleInput);
              return active && productionAuditCapabilityIssuer.current(audit) ? response : false;
            },
          }),
          close() {
            active = false;
          },
        });
      },
    });
  } catch {
    return null;
  }
}

function createCredentialInvalidationBridge(input: {
  readonly getAdmission: () => ReturnType<typeof createEnterpriseAdmission> | null;
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly sessionSink: ReturnType<typeof createAdmissionInvalidationSink>;
  readonly audit: ProductionAuditCapability;
}): CredentialInvalidationSink {
  return Object.freeze({
    async publishCredentialInvalidation(event: CredentialInvalidation) {
      const admission = input.getAdmission();
      if (!admission) throw new Error("enterprise admission invalidation unavailable");
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      if (event.kind === "principal.logout_all") {
        invalidateEnterprisePrincipal(
          admission.authorizationIssuer,
          event.organizationId,
          event.principalId,
        );
      } else {
        for (const credentialId of event.credentialIds) {
          invalidateEnterpriseCredential(admission.authorizationIssuer, credentialId);
        }
      }
      const grant = await readAuthoritativeGrantRecord(
        input.provider.grantStore,
        event.principalId,
      );
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      if (!grant || grant.organizationId !== event.organizationId) {
        throw new Error("enterprise invalidation GrantStore record unavailable");
      }
      await input.sessionSink.publishCredentialInvalidation({
        kind: sessionInvalidationKind(event.kind),
        credentialIds: Object.freeze([...event.credentialIds]),
        principalId: event.principalId,
        organizationId: event.organizationId,
        grantVersion: grant.grantVersion,
      });
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
    },
  });
}

function sessionInvalidationKind(
  kind: CredentialInvalidation["kind"],
): "revoke" | "rotate" | "logout_all" {
  if (kind === "credential.revoke") return "revoke";
  if (kind === "credential.rotate") return "rotate";
  return "logout_all";
}

function capturePaseoHome(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new Error("production enterprise paseoHome must be a canonical absolute path");
  }
  return value;
}
