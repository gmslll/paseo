import { constants } from "node:fs";
import { chmod, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  HumanPrincipalIdSchema,
  OrganizationIdSchema,
  ResourceGrantSchema,
  type EnterprisePrincipalRecord,
  type PrincipalContext,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";

export interface ProductionInitialCredential {
  readonly credentialId: string;
  /** Present only on the first successful provisioning. */
  readonly token?: string;
  readonly alreadyProvisioned: boolean;
}

export interface ProductionEnterpriseProvisioningPorts {
  current(): boolean;
  authenticateBreakGlass(password: string): Promise<PrincipalContext | null>;
  ensurePrincipal(input: {
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
  }): Promise<ProductionInitialCredential>;
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
    const principal = await ports.ensurePrincipal({
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
    if (!credential.alreadyProvisioned && !credential.token)
      throw new Error("initial credential did not return a token");
    if (!ports.current()) throw new Error("enterprise authority changed during provisioning");
    return Object.freeze({ principalId: principal.principalId, ...credential });
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
