import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeContextSchema } from "@getpaseo/protocol/messages";

import type { EnterpriseMultiUserConfig } from "../../persisted-config.js";
import { createAdmissionInvalidationSink } from "../../session/enterprise-admission-invalidation.js";
import { createEnterpriseAgentSessionContextRegistry } from "../../session/enterprise-agent-session-context-registry.js";
import { MemoryAuthorityReceiptState } from "../../session/enterprise-authority-receipt-state.js";
import {
  GrantStorePrincipalGrantVersionGuard,
  ResourceAuthorizationService,
} from "../access/resource-authorization.js";
import { createProductionAuthorizationRuntimeProvider } from "../access/production-authorization-runtime-provider.js";
import { StrictOutboundAuthorityVerifier } from "../access/authority-receipt-verifier.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import { prepareProductionBrowserProfileRegistry } from "../browser/production-bundle.js";
import { createSessionBindingGeneration } from "../identity/authenticator.js";
import type { EnterpriseAdmissionRuntime } from "../identity/runtime.js";
import {
  createProductionAppSlotRegistry,
  isCurrentProductionAppSlotRegistry,
} from "../runtime/production-app-slot-registry.js";
import { ManagedEnterpriseAdmission } from "./admission.js";
import { createManagedIdentityDispatcherRegistration } from "./identity-dispatcher.js";
import { defaultManagedNodeCapacity, ManagedNodeLifecycle } from "./lifecycle.js";
import {
  createManagedLeaseCoordinator,
  ManagedNodeControlPlaneClient,
} from "./management-client.js";
import { ManagedPrincipalGrantSource } from "./principal-source.js";
import { readManagedNodeRelationship } from "./relationship-store.js";

export interface ManagedEnterpriseRuntimeFactoryInput {
  readonly paseoHome: string;
  readonly config: EnterpriseMultiUserConfig;
  readonly audit: ProductionAuditCapability;
}

export async function createManagedEnterpriseRuntime(
  input: ManagedEnterpriseRuntimeFactoryInput,
): Promise<EnterpriseAdmissionRuntime> {
  if (input.config.enabled !== true || input.config.managementMode !== "managed") {
    throw new Error("managed enterprise runtime requires managed configuration");
  }
  const paseoHome = canonicalAbsolutePath(input.paseoHome, "paseoHome");
  const relationshipPath = canonicalAbsolutePath(
    input.config.management.relationshipPath,
    "managed relationship path",
  );
  const caCertificatePath = canonicalAbsolutePath(
    input.config.management.caCertificatePath,
    "management CA certificate path",
  );
  const audit = productionAuditCapabilityIssuer.requireCurrent(input.audit);
  const relationship = readManagedNodeRelationship(relationshipPath);
  if (!relationship) throw new Error("managed node relationship is not enrolled");
  if (
    relationship.managementBaseUrl !== normalizeOrigin(input.config.management.baseUrl) ||
    relationship.node.organizationId !== input.config.organizationId ||
    relationship.node.nodeId !== input.config.nodeId ||
    relationship.node.paseoServerId !== audit.node.paseoServerId ||
    audit.node.nodeId !== input.config.nodeId
  ) {
    throw new Error("managed node relationship does not match daemon configuration");
  }
  const node = Object.freeze(
    NodeContextSchema.parse({
      nodeId: relationship.node.nodeId,
      paseoServerId: relationship.node.paseoServerId,
      mode: "managed",
    }),
  );
  const client = new ManagedNodeControlPlaneClient({
    relationship,
    caCertificate: readFileSync(caCertificatePath),
  });
  const managedBootId = `boot_${randomBytes(16).toString("hex")}`;
  const browserProfiles = await prepareProductionBrowserProfileRegistry({
    paseoHome,
    nodeId: node.nodeId,
    downloadBaseRoot: path.join(paseoHome, "enterprise", "browser", "profile-data"),
  });
  const appSlots = createProductionAppSlotRegistry({
    paseoHome,
    organizationId: input.config.organizationId,
    node,
  });
  if (!appSlots) throw new Error("managed App Slot registry unavailable");
  try {
    await appSlots.initialize();
    if (!isCurrentProductionAppSlotRegistry(appSlots)) {
      throw new Error("managed App Slot registry unavailable");
    }
    const authorizationRuntimeProvider = createProductionAuthorizationRuntimeProvider({
      audit,
      grantFilePath: path.join(paseoHome, "enterprise", "managed-grants.json"),
      browserProfiles,
      appSlots,
    });
    if (!authorizationRuntimeProvider) {
      throw new Error("managed authorization provider unavailable");
    }
    const principalSource = new ManagedPrincipalGrantSource(
      client,
      authorizationRuntimeProvider.grantStore,
      audit,
    );
    const lifecycle = new ManagedNodeLifecycle({
      client,
      audit,
      refreshPolicy: () => principalSource.ready(),
      heartbeat: async () => ({
        bootId: managedBootId,
        paseoServerId: relationship.node.paseoServerId,
        endpoint: relationship.node.endpoint,
        version: relationship.node.version,
        capabilities: structuredClone(relationship.node.capabilities),
        capacity: defaultManagedNodeCapacity({
          activeBrowserProfiles: (await browserProfiles.list()).length,
        }),
      }),
      heartbeatIntervalMs: input.config.management.heartbeatIntervalMs,
      policyRefreshIntervalMs: input.config.management.policyRefreshIntervalMs,
      auditUploadIntervalMs: input.config.management.auditUploadIntervalMs,
    });
    await lifecycle.ready();
    const admissionInvalidationSink = createAdmissionInvalidationSink();
    const admission = new ManagedEnterpriseAdmission({
      client,
      audit,
      onAuthenticatedPrincipal: async (principal) => {
        const current = await principalSource.resolvePrincipal(
          principal.principalId,
          principal.organizationId,
        );
        if (!current || current.grantVersion !== principal.grantVersion) {
          throw new Error("managed principal policy changed during authentication");
        }
      },
    });
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
    const identityDispatcherRegistration = createManagedIdentityDispatcherRegistration({
      source: principalSource,
      audit,
    });
    let closePromise: Promise<void> | null = null;
    const managedPlacementSource = Object.freeze({
      install: (source: Parameters<ManagedNodeLifecycle["installPlacementSource"]>[0]) =>
        lifecycle.installPlacementSource(async () => {
          const [resources, slots] = await Promise.all([source(), appSlots.list()]);
          return Object.freeze([
            ...resources,
            ...slots.flatMap((slot) =>
              slot.ownerPrincipalId
                ? [
                    {
                      resource: {
                        organizationId: slot.organizationId,
                        nodeId: slot.nodeId,
                        resourceKind: "app_slot" as const,
                        localResourceId: slot.appSlotId,
                      },
                      ownerPrincipalId: slot.ownerPrincipalId,
                    },
                  ]
                : [],
            ),
          ]);
        }),
    });
    return Object.freeze({
      audit,
      admission,
      node,
      agentContextRegistry,
      authorityReceiptState,
      grantVersionGuard,
      resourceAuthorization,
      authorizationRuntimeProvider,
      admissionInvalidationSink,
      principalSource,
      browserProfiles,
      identityDispatcherRegistration,
      leaseCoordinator: createManagedLeaseCoordinator(client),
      managedPlacementSource,
      nextSessionBindingGeneration: createSessionBindingGeneration,
      close() {
        closePromise ??= (async () => {
          admission.close();
          await lifecycle.close();
          principalSource.close();
          await appSlots.close();
        })();
        return closePromise;
      },
    });
  } catch (error) {
    await appSlots.close();
    throw error;
  }
}

function canonicalAbsolutePath(value: string, subject: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${subject} must be a canonical absolute path`);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("management base URL must use HTTPS without credentials");
  }
  return url.origin;
}
