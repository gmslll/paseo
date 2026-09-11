import { z } from "zod";

import {
  EnterpriseActionSchema,
  FencedLeaseSchema,
  GlobalResourceRefSchema,
  HumanPrincipalIdSchema,
  NodeIdSchema,
  OrganizationIdSchema,
  PrincipalIdSchema,
  ResourceGrantSchema,
  ServicePrincipalIdSchema,
} from "./messages.js";

export const ManagedPrincipalIdSchema = z.union([HumanPrincipalIdSchema, ServicePrincipalIdSchema]);

export const ManagedNodeStatusSchema = z.enum([
  "registered",
  "active",
  "draining",
  "offline",
  "degraded",
  "disabled",
  "revoked",
]);

export const ManagedNodeCapacitySchema = z
  .object({
    cpuLogical: z.number().int().positive(),
    memoryTotalBytes: z.number().int().nonnegative(),
    memoryAvailableBytes: z.number().int().nonnegative(),
    activeAgents: z.number().int().nonnegative(),
    activeBrowserProfiles: z.number().int().nonnegative(),
  })
  .strict();

export const ManagedNodeHeartbeatSchema = z
  .object({
    bootId: z.string().min(1),
    paseoServerId: z.string().min(1),
    endpoint: z.string().url(),
    version: z.string().min(1),
    capabilities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    capacity: ManagedNodeCapacitySchema,
  })
  .strict();

export const ManagedNodeShutdownSchema = z
  .object({
    bootId: z.string().min(1),
    paseoServerId: z.string().min(1),
  })
  .strict();

export const ManagedNodeSchema = ManagedNodeHeartbeatSchema.extend({
  nodeId: NodeIdSchema,
  organizationId: OrganizationIdSchema,
  publicKeyPem: z.string().min(1),
  status: ManagedNodeStatusSchema,
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const ManagedNodeEnrollmentRequestSchema = ManagedNodeHeartbeatSchema.extend({
  token: z.string().min(1),
  publicKeyPem: z.string().min(1),
}).strict();

export const ManagedNodeEnrollmentResponseSchema = z
  .object({
    node: ManagedNodeSchema,
    ticketPublicKeyPem: z.string().min(1),
  })
  .strict();

export const ManagedNodePolicyEntrySchema = z
  .object({
    principalId: ManagedPrincipalIdSchema,
    principalType: z.enum(["human", "service"]),
    displayName: z.string().trim().min(1).max(120),
    grantVersion: z.string().min(1),
    revocationEpoch: z.number().int().nonnegative(),
    grants: z.array(ResourceGrantSchema),
    status: z.enum(["active", "disabled", "revoked"]),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ManagedNodePolicyResponseSchema = z
  .object({ principals: z.array(ManagedNodePolicyEntrySchema) })
  .strict();

export const ManagedNodeRequestAuthenticationSchema = z
  .object({
    nodeId: NodeIdSchema,
    timestampMs: z.number().int().nonnegative(),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,86}$/),
    signature: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

export const ManagedSessionTicketClaimsSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["session", "content"]),
    issuer: z.string().url(),
    ticketId: z.string().regex(/^tkt_[0-9a-f]{32}$/),
    organizationId: OrganizationIdSchema,
    principalId: ManagedPrincipalIdSchema,
    principalType: z.enum(["human", "service"]),
    credentialId: z.string().regex(/^cred_[0-9a-f]{24}$/),
    clientId: z.string().min(1).optional(),
    grantVersion: z.string().min(1),
    revocationEpoch: z.number().int().nonnegative(),
    nodeId: NodeIdSchema,
    paseoServerId: z.string().min(1),
    grants: z.array(ResourceGrantSchema),
    resource: GlobalResourceRefSchema.optional(),
    action: EnterpriseActionSchema.optional(),
    issuedAtMs: z.number().int().nonnegative(),
    notBeforeMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.kind === "content") !==
      (value.resource !== undefined && value.action !== undefined)
    ) {
      ctx.addIssue({ code: "custom", message: "content tickets require resource and action" });
    }
    if (value.expiresAtMs <= value.notBeforeMs || value.notBeforeMs < value.issuedAtMs - 5_000) {
      ctx.addIssue({ code: "custom", message: "invalid ticket lifetime" });
    }
    if ((value.kind === "session") !== (value.clientId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "session tickets require clientId" });
    }
  });

export const ManagedPlacementRegistrationSchema = z
  .object({
    resource: GlobalResourceRefSchema,
    ownerPrincipalId: PrincipalIdSchema,
  })
  .strict();

export const ManagedPlacementSchema = z
  .object({
    resource: GlobalResourceRefSchema,
    ownerPrincipalId: PrincipalIdSchema,
    assignedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const ManagedPlacementSnapshotSchema = z
  .object({ placements: z.array(ManagedPlacementRegistrationSchema).max(10_000) })
  .strict();

export const ManagedPlacementSnapshotResponseSchema = z
  .object({ placements: z.array(ManagedPlacementSchema).max(10_000) })
  .strict();

export const ManagedGlobalLeaseSchema = FencedLeaseSchema;

export const ManagedAuditInputSchema = z
  .object({
    eventId: z.string().min(1),
    nodeId: NodeIdSchema,
    nodeEventSeq: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    action: z.string().min(1),
    outcome: z.enum(["allowed", "denied", "failed"]),
    actorPrincipalId: PrincipalIdSchema,
    resourceKind: z.string().min(1),
    resourceId: z.string().min(1),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();

export const ManagedAuditIngestResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    lastSequence: z.number().int().nonnegative(),
    gaps: z.array(
      z
        .object({
          expected: z.number().int().positive(),
          received: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const ManagedAuditStateResponseSchema = z
  .object({ lastSequence: z.number().int().nonnegative() })
  .strict();

export type ManagedNodeCapacity = z.infer<typeof ManagedNodeCapacitySchema>;
export type ManagedNodeHeartbeat = z.infer<typeof ManagedNodeHeartbeatSchema>;
export type ManagedNodeShutdown = z.infer<typeof ManagedNodeShutdownSchema>;
export type ManagedNode = z.infer<typeof ManagedNodeSchema>;
export type ManagedNodeEnrollmentRequest = z.infer<typeof ManagedNodeEnrollmentRequestSchema>;
export type ManagedNodeEnrollmentResponse = z.infer<typeof ManagedNodeEnrollmentResponseSchema>;
export type ManagedNodePolicyEntry = z.infer<typeof ManagedNodePolicyEntrySchema>;
export type ManagedNodePolicyResponse = z.infer<typeof ManagedNodePolicyResponseSchema>;
export type ManagedNodeRequestAuthentication = z.infer<
  typeof ManagedNodeRequestAuthenticationSchema
>;
export type ManagedSessionTicketClaims = z.infer<typeof ManagedSessionTicketClaimsSchema>;
export type ManagedPlacementRegistration = z.infer<typeof ManagedPlacementRegistrationSchema>;
export type ManagedPlacement = z.infer<typeof ManagedPlacementSchema>;
export type ManagedPlacementSnapshot = z.infer<typeof ManagedPlacementSnapshotSchema>;
export type ManagedPlacementSnapshotResponse = z.infer<
  typeof ManagedPlacementSnapshotResponseSchema
>;
export type ManagedGlobalLease = z.infer<typeof ManagedGlobalLeaseSchema>;
export type ManagedAuditInput = z.infer<typeof ManagedAuditInputSchema>;
export type ManagedAuditIngestResponse = z.infer<typeof ManagedAuditIngestResponseSchema>;
export type ManagedAuditStateResponse = z.infer<typeof ManagedAuditStateResponseSchema>;
