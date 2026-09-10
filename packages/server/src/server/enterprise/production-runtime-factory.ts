import path from "node:path";

import { NodeContextSchema } from "@getpaseo/protocol/messages";
import type { EnterpriseMultiUserConfig } from "../persisted-config.js";
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
import { createProductionPrincipalGrantSource } from "./identity/principal-source.js";
import type { CredentialInvalidation, CredentialInvalidationSink } from "./identity/registry.js";
import type { EnterpriseAdmissionRuntime } from "./identity/runtime.js";
import type {
  EnterpriseDispatcherLease,
  EnterpriseSessionDispatcher,
  EnterpriseSessionDispatcherFactoryRegistration,
} from "../session/enterprise-dispatcher.js";

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

const AUDIT_OPERATIONS = Object.freeze(["enterprise.audit.list_events.request"]);

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

    const authorizationRuntimeProvider = createProductionAuthorizationRuntimeProvider({
      audit: currentAudit,
      grantFilePath: path.join(paseoHome, "enterprise", "grants.json"),
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
    });
    productionAuditCapabilityIssuer.requireCurrent(currentAudit);
    return Object.freeze({
      audit: currentAudit,
      admission,
      node,
      agentContextRegistry,
      authorityReceiptState,
      grantVersionGuard,
      resourceAuthorization,
      authorizationRuntimeProvider,
      admissionInvalidationSink,
      nextSessionBindingGeneration: createSessionBindingGeneration,
    });
  };
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
