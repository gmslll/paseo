import { z } from "zod";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  type EnterprisePrincipalRecord,
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
    status: z.enum(["active", "disabled", "revoked"]),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
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
type PrincipalMetadataRecord = EnterprisePrincipalRecord;

export interface ProductionPrincipalGrantSource extends PrincipalGrantSource {
  ready(): Promise<void>;
  validateCurrent(): Promise<boolean>;
  isCurrent(): boolean;
  listPrincipalRecords(
    organizationId: OrganizationId,
  ): Promise<readonly EnterprisePrincipalRecord[]>;
}

function readIdentityDocument(
  filePath: string,
  fs: IdentityRegistryFsPort,
): z.infer<typeof IdentityDocumentSchema> {
  if (!Number.isInteger(fs.noFollowFlag) || fs.noFollowFlag <= 0) {
    throw new Error("identity source requires O_NOFOLLOW");
  }
  const fd = fs.open(filePath, fs.noFollowFlag);
  try {
    const opened = fs.fstat(fd);
    if (!opened.isFile()) throw new Error("identity source is not a regular file");
    fs.fchmod(fd, 0o600);
    const secured = fs.fstat(fd);
    if (!secured.isFile() || (secured.mode & 0o777) !== 0o600) {
      throw new Error("identity source is not private");
    }
    return IdentityDocumentSchema.parse(JSON.parse(fs.read(fd)));
  } finally {
    fs.close(fd);
  }
}

export interface ProductionPrincipalProvisioning {
  ensurePrincipal(input: PrincipalMetadataRecord): Promise<PrincipalMetadataRecord>;
}

export function createProductionPrincipalProvisioning(input: {
  readonly filePath: string;
  readonly fs?: IdentityRegistryFsPort;
  readonly audit: ProductionAuditCapability;
}): ProductionPrincipalProvisioning {
  const fs = input.fs ?? nodeIdentityRegistryFs;
  return {
    async ensurePrincipal(record) {
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      const validated = PrincipalMetadataSchema.parse(record);
      let document: z.infer<typeof IdentityDocumentSchema> = { version: 1, principals: {} };
      try {
        const fd = fs.open(input.filePath, fs.noFollowFlag);
        try {
          document = IdentityDocumentSchema.parse(JSON.parse(fs.read(fd)));
        } finally {
          fs.close(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const existing = document.principals[validated.principalId];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(validated))
          throw new Error("principal conflict");
        return Object.freeze({ ...existing });
      }
      const next = {
        version: 1 as const,
        principals: { ...document.principals, [validated.principalId]: validated },
      };
      const tmp = `${input.filePath}.${randomBytes(8).toString("hex")}.tmp`;
      fs.mkdir(path.dirname(input.filePath), 0o700);
      const fd = fs.open(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | fs.noFollowFlag,
        0o600,
      );
      let committed = false;
      try {
        fs.write(fd, JSON.stringify(next));
        fs.fchmod(fd, 0o600);
        const stat = fs.fstat(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
          throw new Error("principal temp is not private");
        fs.fsync(fd);
      } finally {
        fs.close(fd);
      }
      try {
        fs.rename(tmp, input.filePath);
        committed = true;
        const dirFd = fs.open(path.dirname(input.filePath), fs.noFollowFlag);
        try {
          const dirStat = fs.fstat(dirFd);
          if (!dirStat.isDirectory()) throw new Error("identity parent is not a directory");
          fs.fsync(dirFd);
        } finally {
          fs.close(dirFd);
        }
      } finally {
        if (!committed) {
          try {
            fs.unlink(tmp);
          } catch {
            /* best effort */
          }
        }
      }
      productionAuditCapabilityIssuer.requireCurrent(input.audit);
      return Object.freeze({ ...validated });
    },
  };
}

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
        document = readIdentityDocument(input.filePath, input.fs);
      } catch {
        return null;
      }
      const metadata = document.principals[principalId];
      if (!metadata || metadata.organizationId !== organizationId || metadata.status !== "active")
        return null;
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
}): ProductionPrincipalGrantSource {
  const audit = productionAuditCapabilityIssuer.requireCurrent(input.audit);
  if (!isAuthoritativeGrantStoreForAudit(input.grantStore, audit)) {
    throw new Error("enterprise principal source requires the audit-bound GrantStore");
  }
  const grantStore = input.grantStore;
  const fs = input.fs ?? nodeIdentityRegistryFs;
  let ready = false;
  const validateAll = async () => {
    productionAuditCapabilityIssuer.requireCurrent(audit);
    const document = readIdentityDocument(input.filePath, fs);
    for (const metadata of Object.values(document.principals)) {
      const record = await readAuthoritativeGrantRecord(grantStore, metadata.principalId);
      productionAuditCapabilityIssuer.requireCurrent(audit);
      if (!record || record.organizationId !== metadata.organizationId) {
        throw new Error("enterprise principal metadata and GrantStore do not match");
      }
    }
    productionAuditCapabilityIssuer.requireCurrent(audit);
  };
  const source = createFilePrincipalGrantSource({
    filePath: input.filePath,
    fs,
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
  return Object.freeze({
    ...source,
    async ready() {
      ready = false;
      await validateAll();
      ready = true;
    },
    async validateCurrent() {
      try {
        await validateAll();
        return true;
      } catch {
        return false;
      }
    },
    isCurrent() {
      try {
        productionAuditCapabilityIssuer.requireCurrent(audit);
        return ready;
      } catch {
        return false;
      }
    },
    async listPrincipalRecords(organizationId: OrganizationId) {
      productionAuditCapabilityIssuer.requireCurrent(audit);
      const document = readIdentityDocument(input.filePath, fs);
      const records = Object.values(document.principals)
        .filter((record) => record.organizationId === organizationId)
        .map(({ metadata: _metadata, ...record }) => Object.freeze(record));
      productionAuditCapabilityIssuer.requireCurrent(audit);
      return Object.freeze(records);
    },
  });
}
