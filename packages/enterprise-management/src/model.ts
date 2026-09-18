import { z } from "zod";

import {
  GlobalResourceRefSchema,
  OrganizationIdSchema,
  ResourceGrantSchema,
} from "@getpaseo/protocol/messages";
import {
  ManagedNodeCapacitySchema,
  ManagedNodeHeartbeatSchema,
  ManagedNodeSchema,
  ManagedNodeRequestAuthenticationSchema,
  ManagedNodeShutdownSchema,
  ManagedPlacementSnapshotSchema,
  ManagedPrincipalIdSchema,
  ManagedSessionTicketClaimsSchema,
} from "@getpaseo/protocol/enterprise-management";

export const ManagementRoleSchema = z.enum(["employee", "boss", "platform_admin"]);
export type ManagementRole = z.infer<typeof ManagementRoleSchema>;

export const ManagementPrincipalSchema = z
  .object({
    principalId: ManagedPrincipalIdSchema,
    organizationId: OrganizationIdSchema,
    principalType: z.enum(["human", "service"]),
    displayName: z.string().trim().min(1).max(120),
    role: ManagementRoleSchema,
    status: z.enum(["active", "disabled", "revoked"]),
    grantVersion: z.string().min(1),
    revocationEpoch: z.number().int().nonnegative(),
    grants: z.array(ResourceGrantSchema),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ManagementPrincipal = z.infer<typeof ManagementPrincipalSchema>;

export const NodeCapacitySchema = ManagedNodeCapacitySchema;
export type NodeCapacity = z.infer<typeof NodeCapacitySchema>;

export { ManagedNodeSchema };
export type ManagedNode = z.infer<typeof ManagedNodeSchema>;

export const PlacementSchema = z
  .object({
    resource: GlobalResourceRefSchema,
    ownerPrincipalId: z.string().min(1),
    assignedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type Placement = z.infer<typeof PlacementSchema>;

export const SessionTicketClaimsSchema = ManagedSessionTicketClaimsSchema;
export type SessionTicketClaims = z.infer<typeof SessionTicketClaimsSchema>;

export const NodeHeartbeatSchema = ManagedNodeHeartbeatSchema;
export const NodeShutdownSchema = ManagedNodeShutdownSchema;

export const NodeRequestAuthenticationSchema = ManagedNodeRequestAuthenticationSchema;
export type NodeRequestAuthentication = z.infer<typeof NodeRequestAuthenticationSchema>;

export { ManagedPlacementSnapshotSchema };
