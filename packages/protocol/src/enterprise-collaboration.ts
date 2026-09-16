import { z } from "zod";

import { ManagedPrincipalIdSchema } from "./enterprise-management.js";
import { type EnterpriseAction, NodeIdSchema, OrganizationIdSchema } from "./messages.js";

// Collaboration data plane contracts: ADR-0031 through ADR-0037, board containers from ADR-0046.

const COLLAB_WORKSPACE_UID_PATTERN = /^cws_[0-9a-f]{16}$/;
const TASK_BOARD_ID_PATTERN = /^brd_[0-9a-f]{16}$/;
const TASK_ID_PATTERN = /^tsk_[0-9a-f]{16}$/;
const MACHINE_RPC_ID_PATTERN =
  /^rpc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_OFFSET_PATTERN = /^\d{20}$/;
const SEGMENT_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MACHINE_RPC_METHOD_PATTERN = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/;
const COLLAB_SUBSCRIPTION_ID_PATTERN = /^sub_[0-9a-f]{16}$/;

export const CollabSubscriptionIdSchema = z.string().regex(COLLAB_SUBSCRIPTION_ID_PATTERN);
export const CollabWorkspaceUidSchema = z.string().regex(COLLAB_WORKSPACE_UID_PATTERN);
export const TaskBoardIdSchema = z.string().regex(TASK_BOARD_ID_PATTERN);
export const TaskIdSchema = z.string().regex(TASK_ID_PATTERN);
export const CollabContainerIdSchema = z.union([CollabWorkspaceUidSchema, TaskBoardIdSchema]);
export const MachineRpcIdSchema = z.string().regex(MACHINE_RPC_ID_PATTERN);
export const MachineRpcMethodSchema = z.string().regex(MACHINE_RPC_METHOD_PATTERN);
// Offsets are zero-padded so lexical order equals stream order.
export const StreamOffsetSchema = z.string().regex(STREAM_OFFSET_PATTERN);

export type CollabContainerKind = "workspace" | "board";

export function collabContainerKind(containerId: string): CollabContainerKind | null {
  if (COLLAB_WORKSPACE_UID_PATTERN.test(containerId)) return "workspace";
  if (TASK_BOARD_ID_PATTERN.test(containerId)) return "board";
  return null;
}

export const COLLAB_STREAM_LIMITS = {
  maxAppendBytes: 1_048_576,
  maxTimelineRowBytes: 65_536,
  maxSubscriberQueueBytes: 8 * 1_048_576,
  maxSubscriberQueueEvents: 2_000,
  compactionBytes: 8 * 1_048_576,
  compactionUpdates: 5_000,
} as const;

export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const PRESENCE_TTL_MS = 90_000;
export const STREAM_TOKEN_TTL_MS = 5 * 60_000;
/**
 * A subscription is dropped after this long without a read. It holds only cursors, so a client that
 * loses one re-subscribes with the offsets it already has and misses nothing.
 */
export const COLLAB_SUBSCRIPTION_TTL_MS = 5 * 60_000;
export const MACHINE_RPC_DEFAULT_TTL_MS = 60_000;
export const MACHINE_RPC_LIFECYCLE_RECEIPT_MS = 5_000;

export const WORKSPACE_MEMBER_ROLES = ["owner", "editor", "viewer"] as const;
export const WorkspaceMemberRoleSchema = z.enum(WORKSPACE_MEMBER_ROLES);
export type WorkspaceMemberRole = z.infer<typeof WorkspaceMemberRoleSchema>;

// Membership projects onto the frozen V1 actions with a Workspace selector (ADR-0033).
export const WORKSPACE_MEMBER_ROLE_ACTIONS: Readonly<
  Record<WorkspaceMemberRole, readonly EnterpriseAction[]>
> = {
  owner: [
    "workspace.metadata.read",
    "workspace.content.read",
    "workspace.write",
    "workspace.manage",
  ],
  editor: ["workspace.metadata.read", "workspace.content.read", "workspace.write"],
  viewer: ["workspace.metadata.read", "workspace.content.read"],
};

export type CollabSegment =
  | { kind: "meta" }
  | { kind: "workspace_kv" }
  | { kind: "session"; agentId: string }
  | { kind: "file_index"; agentId: string }
  | { kind: "machine_state"; nodeId: string }
  | { kind: "orchestration"; nodeId: string }
  | { kind: "preview_comments"; resourceId: string }
  | { kind: "task_index" }
  | { kind: "task"; taskId: string }
  | { kind: "task_state"; taskId: string }
  | { kind: "review_policy" }
  | { kind: "rpc_request"; nodeId: string }
  | { kind: "rpc_response"; rpcId: string };

export type CollabSegmentKind = CollabSegment["kind"];
export type CollabSegmentWriter = "node" | "editor" | "member" | "plane";
export type CollabSegmentReader = "member" | "node" | "requester";

// Plane-side append authority per segment (ADR-0032, ADR-0046). Client-writable keys inside
// node-written segments are validated again by the node projector.
export const COLLAB_SEGMENT_WRITERS: Readonly<
  Record<CollabSegmentKind, readonly CollabSegmentWriter[]>
> = {
  meta: ["node", "editor"],
  workspace_kv: ["node", "editor"],
  session: ["node"],
  file_index: ["node"],
  machine_state: ["node"],
  orchestration: ["node"],
  preview_comments: ["editor"],
  task_index: ["plane"],
  task: ["editor"],
  task_state: ["plane"],
  review_policy: ["plane"],
  rpc_request: ["member"],
  rpc_response: ["node"],
};

// Content-Grant readers outside membership are authorized separately and audited (ADR-0037).
export const COLLAB_SEGMENT_READERS: Readonly<
  Record<CollabSegmentKind, readonly CollabSegmentReader[]>
> = {
  meta: ["member", "node"],
  workspace_kv: ["member", "node"],
  session: ["member", "node"],
  file_index: ["member", "node"],
  machine_state: ["member", "node"],
  orchestration: ["member", "node"],
  preview_comments: ["member", "node"],
  task_index: ["member", "node"],
  task: ["member", "node"],
  task_state: ["member", "node"],
  review_policy: ["member", "node"],
  rpc_request: ["node"],
  rpc_response: ["requester"],
};

const BOARD_SEGMENT_KINDS: ReadonlySet<CollabSegmentKind> = new Set([
  "task_index",
  "task",
  "task_state",
  "review_policy",
]);

export function collabSegmentContainerKind(segment: CollabSegment): CollabContainerKind {
  return BOARD_SEGMENT_KINDS.has(segment.kind) ? "board" : "workspace";
}

function isSegmentResourceId(value: string): boolean {
  return SEGMENT_RESOURCE_ID_PATTERN.test(value);
}

function isNodeId(value: string): boolean {
  return NodeIdSchema.safeParse(value).success;
}

// Maps, not object literals, so inherited keys such as "constructor" never match.
const FIXED_SEGMENTS = new Map<string, () => CollabSegment>([
  ["meta", () => ({ kind: "meta" })],
  ["wf", () => ({ kind: "workspace_kv" })],
  ["ti", () => ({ kind: "task_index" })],
  ["rp", () => ({ kind: "review_policy" })],
]);

// Segment resource IDs never contain ":", so the last separator splits the prefix from the ID.
const PREFIXED_SEGMENT_PARSERS = new Map<string, (id: string) => CollabSegment | null>([
  ["s", (id) => (isSegmentResourceId(id) ? { kind: "session", agentId: id } : null)],
  ["fi", (id) => (isSegmentResourceId(id) ? { kind: "file_index", agentId: id } : null)],
  ["pc", (id) => (isSegmentResourceId(id) ? { kind: "preview_comments", resourceId: id } : null)],
  ["mf", (id) => (isNodeId(id) ? { kind: "machine_state", nodeId: id } : null)],
  ["ob", (id) => (isNodeId(id) ? { kind: "orchestration", nodeId: id } : null)],
  ["tk", (id) => (TASK_ID_PATTERN.test(id) ? { kind: "task", taskId: id } : null)],
  ["tks", (id) => (TASK_ID_PATTERN.test(id) ? { kind: "task_state", taskId: id } : null)],
  ["rpc:req", (id) => (isNodeId(id) ? { kind: "rpc_request", nodeId: id } : null)],
  [
    "rpc:res",
    (id) => (MACHINE_RPC_ID_PATTERN.test(id) ? { kind: "rpc_response", rpcId: id } : null),
  ],
]);

export function parseCollabSegment(segment: string): CollabSegment | null {
  const fixed = FIXED_SEGMENTS.get(segment);
  if (fixed) return fixed();
  const separator = segment.lastIndexOf(":");
  if (separator <= 0) return null;
  const parse = PREFIXED_SEGMENT_PARSERS.get(segment.slice(0, separator));
  return parse ? parse(segment.slice(separator + 1)) : null;
}

export function formatCollabSegment(segment: CollabSegment): string {
  switch (segment.kind) {
    case "meta":
      return "meta";
    case "workspace_kv":
      return "wf";
    case "task_index":
      return "ti";
    case "review_policy":
      return "rp";
    case "session":
      return `s:${segment.agentId}`;
    case "file_index":
      return `fi:${segment.agentId}`;
    case "preview_comments":
      return `pc:${segment.resourceId}`;
    case "machine_state":
      return `mf:${segment.nodeId}`;
    case "orchestration":
      return `ob:${segment.nodeId}`;
    case "task":
      return `tk:${segment.taskId}`;
    case "task_state":
      return `tks:${segment.taskId}`;
    case "rpc_request":
      return `rpc:req:${segment.nodeId}`;
    case "rpc_response":
      return `rpc:res:${segment.rpcId}`;
  }
}

const TimestampSchema = z.string().datetime({ offset: true });

export const CollabWorkspaceStateSchema = z.enum(["active", "remote_missing", "revoked"]);

export const WorkspaceMemberSchema = z.object({
  principalId: ManagedPrincipalIdSchema,
  role: WorkspaceMemberRoleSchema,
});

export const WorkspaceCatalogEntrySchema = z.object({
  workspaceUid: CollabWorkspaceUidSchema,
  localWorkspaceId: z.string().min(1),
  ownerPrincipalId: ManagedPrincipalIdSchema,
  members: z.array(WorkspaceMemberSchema),
  state: CollabWorkspaceStateSchema,
  cachedAt: TimestampSchema,
  remoteMissingAt: TimestampSchema.nullable(),
});

export const WorkspaceCatalogSchema = z.object({
  version: z.literal(1),
  nodeId: NodeIdSchema,
  organizationId: OrganizationIdSchema,
  fetchedAt: TimestampSchema,
  workspaces: z.array(WorkspaceCatalogEntrySchema),
});

// Sent only to nodes whose heartbeat declares collaborationV1 (ADR-0033).
export const WorkspaceMembershipPolicySchema = z.object({
  workspaceUid: CollabWorkspaceUidSchema,
  localWorkspaceId: z.string().min(1),
  ownerPrincipalId: ManagedPrincipalIdSchema,
  membershipVersion: z.number().int().nonnegative(),
  members: z.array(WorkspaceMemberSchema),
});

export const StreamTokenClaimsSchema = z
  .object({
    tokenId: z.string().min(1),
    organizationId: OrganizationIdSchema,
    principalId: ManagedPrincipalIdSchema,
    credentialId: z.string().min(1),
    clientId: z.string().min(1),
    grantVersion: z.string().min(1),
    revocationEpoch: z.number().int().nonnegative(),
    containerIds: z.array(CollabContainerIdSchema).min(1),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const MachineRpcRequesterSchema = z
  .object({
    principalId: ManagedPrincipalIdSchema,
    credentialId: z.string().min(1),
    grantVersion: z.string().min(1),
    clientId: z.string().min(1),
  })
  .strict();

export const MachineRpcAttestationClaimsSchema = z
  .object({
    rpcId: MachineRpcIdSchema,
    method: MachineRpcMethodSchema,
    nodeId: NodeIdSchema,
    containerId: CollabWorkspaceUidSchema,
    requester: MachineRpcRequesterSchema,
    sentAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

// The payload is a Session inbound message; the node validates it before dispatch (ADR-0035).
export const MachineRpcClientRequestSchema = z
  .object({
    kind: z.literal("request"),
    rpcVersion: z.literal(1),
    rpcId: MachineRpcIdSchema,
    method: MachineRpcMethodSchema,
    nodeId: NodeIdSchema,
    containerId: CollabWorkspaceUidSchema,
    clientId: z.string().min(1),
    sentAt: TimestampSchema,
    expiresAt: TimestampSchema,
    payload: z.unknown(),
  })
  .strict();

export const MachineRpcAttestedRequestSchema = MachineRpcClientRequestSchema.extend({
  attestation: z
    .object({
      claims: MachineRpcAttestationClaimsSchema,
      signature: z.string().min(1),
    })
    .strict(),
}).strict();

const MachineRpcResultShape = {
  rpcVersion: z.literal(1),
  rpcId: MachineRpcIdSchema,
  nodeId: NodeIdSchema,
};

export const MachineRpcResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receipt"), ...MachineRpcResultShape, receivedAt: TimestampSchema }),
  z.object({
    kind: z.literal("response"),
    ...MachineRpcResultShape,
    completedAt: TimestampSchema,
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("error"),
    ...MachineRpcResultShape,
    code: z.string().min(1),
    message: z.string(),
  }),
]);

export const PresenceEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("principal"),
    principalId: ManagedPrincipalIdSchema,
    displayName: z.string().optional(),
    clientId: z.string().min(1),
    focusAgentId: z.string().min(1).nullable(),
    heartbeatAt: TimestampSchema,
  }),
  z.object({
    kind: z.literal("node"),
    nodeId: NodeIdSchema,
    heartbeatAt: TimestampSchema,
  }),
]);

export const CollabSubscriptionRequestSchema = z
  .object({
    containerId: CollabContainerIdSchema,
    cursors: z.record(z.string(), StreamOffsetSchema),
    live: z.enum(["sse", "long-poll"]).optional(),
  })
  .strict();

// Not strict: this is a response, and an older client must keep parsing it after the plane starts
// sending a new field.
export const CollabSubscriptionCreatedSchema = z.object({
  subscriptionId: CollabSubscriptionIdSchema,
  containerId: CollabContainerIdSchema,
  expiresAt: TimestampSchema,
});

export const CollabSubscriptionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data"),
    containerId: CollabContainerIdSchema,
    segment: z.string().min(1),
    offset: StreamOffsetSchema,
    // Base64-encoded Loro update or JSON log entry.
    update: z.string(),
  }),
  z.object({
    type: z.literal("control"),
    containerId: CollabContainerIdSchema,
    segment: z.string().min(1),
    nextOffset: StreamOffsetSchema,
    lowerBoundOffset: StreamOffsetSchema,
    upToDate: z.boolean(),
    overflow: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("presence"),
    containerId: CollabContainerIdSchema,
    entries: z.array(PresenceEntrySchema),
  }),
  z.object({
    type: z.literal("revoked"),
    containerId: CollabContainerIdSchema,
    reason: z.string().min(1),
  }),
]);

export type WorkspaceCatalog = z.infer<typeof WorkspaceCatalogSchema>;
export type WorkspaceCatalogEntry = z.infer<typeof WorkspaceCatalogEntrySchema>;
export type WorkspaceMembershipPolicy = z.infer<typeof WorkspaceMembershipPolicySchema>;
export type StreamTokenClaims = z.infer<typeof StreamTokenClaimsSchema>;
export type MachineRpcClientRequest = z.infer<typeof MachineRpcClientRequestSchema>;
export type MachineRpcAttestedRequest = z.infer<typeof MachineRpcAttestedRequestSchema>;
export type MachineRpcResult = z.infer<typeof MachineRpcResultSchema>;
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;
export type CollabSubscriptionEvent = z.infer<typeof CollabSubscriptionEventSchema>;
export type CollabSubscriptionCreated = z.infer<typeof CollabSubscriptionCreatedSchema>;
