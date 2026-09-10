import { z } from "zod";
import {
  OrganizationIdSchema,
  PrincipalIdSchema,
  type OrganizationId,
} from "@getpaseo/protocol/messages";
import type { PrincipalGrantProjection, PrincipalGrantSource } from "./registry.js";
import { nodeIdentityRegistryFs, type IdentityRegistryFsPort } from "./fs-port.js";
import {
  isAuthoritativeGrantStoreForAudit,
  readAuthoritativeGrantRecord,
  type GrantStore,
} from "../access/grant-store.js";
import {
  productionAuditCapabilityIssuer,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";

const PrincipalMetadataSchema = z
  .strictObject({
    principalId: PrincipalIdSchema,
    organizationId: OrganizationIdSchema,
    principalType: z.enum(["human", "service"]),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.principalId !== "owner", "break-glass owner is not durable");
const IdentityDocumentSchema = z
  .strictObject({
    version: z.literal(1),
    principals: z.record(PrincipalIdSchema, PrincipalMetadataSchema),
  })
  .superRefine((document, ctx) => {
    for (const [key, value] of Object.entries(document.principals)) {
      if (key !== value.principalId) {
        ctx.addIssue({
          code: "custom",
          path: ["principals", key],
          message: "principal key mismatch",
        });
      }
    }
  });
type GrantProjectionWithoutType = Omit<PrincipalGrantProjection, "principalType">;

export function createFilePrincipalGrantSource(input: {
  readonly filePath: string;
  readonly fs: IdentityRegistryFsPort;
  readonly grants: {
    resolvePrincipal(
      principalId: string,
      organizationId: OrganizationId,
    ): Promise<GrantProjectionWithoutType | null>;
  };
}): PrincipalGrantSource {
  return {
    async resolvePrincipal(principalId, organizationId: OrganizationId) {
      let document: z.infer<typeof IdentityDocumentSchema>;
      try {
        if (!Number.isInteger(input.fs.noFollowFlag) || input.fs.noFollowFlag <= 0) return null;
        const fd = input.fs.open(input.filePath, input.fs.noFollowFlag);
        try {
          const opened = input.fs.fstat(fd);
          if (!opened.isFile()) return null;
          input.fs.fchmod(fd, 0o600);
          const secured = input.fs.fstat(fd);
          if (!secured.isFile() || (secured.mode & 0o777) !== 0o600) return null;
          document = IdentityDocumentSchema.parse(JSON.parse(input.fs.read(fd)));
        } finally {
          input.fs.close(fd);
        }
      } catch {
        return null;
      }
      const metadata = document.principals[principalId];
      if (!metadata || metadata.organizationId !== organizationId) return null;
      const grant = await input.grants.resolvePrincipal(principalId, organizationId);
      if (!grant || grant.principalId !== principalId || grant.organizationId !== organizationId)
        return null;
      return { ...grant, principalType: metadata.principalType };
    },
  };
}

/** Combines durable principal metadata with the single audit-bound W2 grant store. */
export function createProductionPrincipalGrantSource(input: {
  readonly filePath: string;
  readonly fs?: IdentityRegistryFsPort;
  readonly grantStore: GrantStore;
  readonly audit: ProductionAuditCapability;
}): PrincipalGrantSource {
  const audit = productionAuditCapabilityIssuer.requireCurrent(input.audit);
  if (!isAuthoritativeGrantStoreForAudit(input.grantStore, audit)) {
    throw new Error("enterprise principal source requires the audit-bound GrantStore");
  }
  const grantStore = input.grantStore;
  const source = createFilePrincipalGrantSource({
    filePath: input.filePath,
    fs: input.fs ?? nodeIdentityRegistryFs,
    grants: {
      async resolvePrincipal(principalId, organizationId) {
        productionAuditCapabilityIssuer.requireCurrent(audit);
        const record = await readAuthoritativeGrantRecord(grantStore, principalId);
        productionAuditCapabilityIssuer.requireCurrent(audit);
        if (!record || record.organizationId !== organizationId) return null;
        return {
          principalId,
          organizationId,
          grants: record.grants,
          grantVersion: record.grantVersion,
        };
      },
    },
  });
  return source;
}
