import { constants } from "node:fs";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  HumanPrincipalIdSchema,
  OrganizationIdSchema,
  ResourceGrantSchema,
  type NodeContext,
  type EnterprisePrincipalRecord,
  type PrincipalContext,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";
import type { ProductionAuthorizationRuntimeProvider } from "./access/production-authorization-runtime-provider.js";
import { provisionInitialGrant } from "./access/production-grant-provisioner.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "./audit/production-audit-runtime.js";

export interface ProductionInitialCredential {
  readonly credentialId: string;
  /** Present only on the first successful provisioning. */
  readonly token?: string;
  readonly alreadyProvisioned: boolean;
}

export interface ProductionEnterpriseProvisioningPorts {
  current(): boolean;
  authenticateBreakGlass(password: string): Promise<PrincipalContext | null>;
  ensurePrincipalIntent(input: {
    readonly principalId: EnterprisePrincipalRecord["principalId"];
    readonly organizationId: EnterprisePrincipalRecord["organizationId"];
    readonly principalType: "human";
    readonly status: "active";
    readonly displayName?: string;
  }): Promise<EnterprisePrincipalRecord>;
  provisionInitialGrant(input: {
    readonly actor: PrincipalContext;
    readonly principalId: string;
    readonly organizationId: string;
    readonly grants: readonly ResourceGrant[];
  }): Promise<unknown | null>;
  issueInitialCredential(input: {
    readonly actor: PrincipalContext;
    readonly principalId: string;
    readonly organizationId: string;
  }): Promise<
    | { readonly status: "issued"; readonly token: string; readonly credentialId: string }
    | { readonly status: "already_provisioned"; readonly credentialIds: readonly string[] }
  >;
}

/** Adapts the already assembled production authority objects without creating stores. */
export function createProductionEnterpriseProvisioningPorts(input: {
  readonly audit: ProductionAuditCapability;
  readonly admission: {
    readonly node: NodeContext;
    readonly authenticator: {
      authenticateBearer(token: string, context: unknown): Promise<PrincipalContext | null>;
    };
    readonly registry: {
      issueInitialCredential(input: {
        actor: PrincipalContext;
        principalId: string;
        organizationId: string;
      }): Promise<
        Awaited<ReturnType<ProductionEnterpriseProvisioningPorts["issueInitialCredential"]>>
      >;
    };
  };
  readonly provider: ProductionAuthorizationRuntimeProvider;
  readonly principalProvisioning: {
    ensurePrincipalIntent(input: {
      readonly principalId: EnterprisePrincipalRecord["principalId"];
      readonly organizationId: EnterprisePrincipalRecord["organizationId"];
      readonly principalType: "human";
      readonly status: "active";
      readonly displayName?: string;
    }): Promise<EnterprisePrincipalRecord>;
  };
}): ProductionEnterpriseProvisioningPorts {
  return {
    current: () => productionAuditCapabilityIssuer.current(input.audit),
    authenticateBreakGlass: (password) =>
      input.admission.authenticator.authenticateBearer(password, {
        node: input.admission.node,
        transport: "direct",
        peer: "loopback",
      }),
    ensurePrincipalIntent: input.principalProvisioning.ensurePrincipalIntent,
    provisionInitialGrant: ({ actor, principalId, organizationId, grants }) =>
      provisionInitialGrant({
        provider: input.provider,
        actor,
        principalId,
        organizationId,
        grants,
      }),
    issueInitialCredential: ({ actor, principalId, organizationId }) =>
      input.admission.registry.issueInitialCredential({ actor, principalId, organizationId }),
  };
}

const InputSchema = z.strictObject({
  paseoHome: z.string().min(1),
  organizationId: OrganizationIdSchema,
  principalId: HumanPrincipalIdSchema,
  displayName: z.string().min(1).optional(),
  grants: z.array(ResourceGrantSchema),
});

/**
 * Root-owned orchestration only. Every persistence and credential operation is
 * delegated to the W1/W2 ports, so this module cannot create a second store.
 */
export async function provisionProductionEnterpriseInitialAdmin(
  input: unknown,
  ports: ProductionEnterpriseProvisioningPorts,
  bootstrapPassword: string,
): Promise<ProductionInitialCredential & { readonly principalId: string }> {
  const parsed = InputSchema.parse(input);
  if (!path.isAbsolute(parsed.paseoHome) || path.normalize(parsed.paseoHome) !== parsed.paseoHome)
    throw new Error("paseoHome must be canonical absolute path");
  if (!ports.current()) throw new Error("enterprise authority is unavailable");
  const enterpriseDir = path.join(parsed.paseoHome, "enterprise");
  await mkdir(enterpriseDir, { recursive: true, mode: 0o700 });
  await chmod(enterpriseDir, 0o700);
  const lockPath = path.join(enterpriseDir, ".provision.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  } catch {
    throw new Error("enterprise provisioning is already running or unavailable");
  }
  try {
    const actor = await ports.authenticateBreakGlass(bootstrapPassword);
    if (!actor) throw new Error("local bootstrap authentication failed");
    const principal = await ports.ensurePrincipalIntent({
      principalId: parsed.principalId,
      organizationId: parsed.organizationId,
      principalType: "human",
      status: "active",
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    });
    if (principal.organizationId !== parsed.organizationId) throw new Error("principal conflict");
    const grant = await ports.provisionInitialGrant({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
      grants: parsed.grants,
    });
    if (!grant) throw new Error("initial grant provisioning failed");
    const credential = await ports.issueInitialCredential({
      actor,
      principalId: principal.principalId,
      organizationId: principal.organizationId,
    });
    const result =
      credential.status === "issued"
        ? {
            credentialId: credential.credentialId,
            token: credential.token,
            alreadyProvisioned: false,
          }
        : { credentialId: credential.credentialIds[0]!, alreadyProvisioned: true };
    if (!ports.current()) throw new Error("enterprise authority changed during provisioning");
    return Object.freeze({ principalId: principal.principalId, ...result });
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
