import { z } from "zod";
import type { OrganizationId } from "@getpaseo/protocol/messages";
import type { PrincipalGrantSource } from "./registry.js";
import type { IdentityRegistryFsPort } from "./fs-port.js";

const PrincipalMetadataSchema = z
  .strictObject({
    principalId: z.string().min(1),
    organizationId: z.string().min(1),
    principalType: z.enum(["human", "service"]),
    displayName: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine((value) => value.principalId !== "owner", "break-glass owner is not durable");
const IdentityDocumentSchema = z.strictObject({
  version: z.literal(1),
  principals: z.record(z.string(), PrincipalMetadataSchema),
});

export function createFilePrincipalGrantSource(input: {
  readonly filePath: string;
  readonly fs: IdentityRegistryFsPort;
  readonly grants: PrincipalGrantSource;
}): PrincipalGrantSource {
  return {
    async resolvePrincipal(principalId, organizationId: OrganizationId) {
      let document: z.infer<typeof IdentityDocumentSchema>;
      try {
        const fd = input.fs.open(input.filePath, input.fs.noFollowFlag);
        try {
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
