import { z } from "zod";
import {
  AuditEventInputSchema,
  AuditEventSchema,
  EnterpriseResourceOwnerSchema,
  OrganizationIdSchema,
  PrincipalContextSchema,
  PrincipalIdSchema,
  ResourceGrantSchema,
  type AuditSink,
  type AuthorizedWorkspace,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import {
  FileBackedWorkspaceRegistry,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import type { PrincipalGrantProjection } from "../identity/registry.js";

const OwnershipRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => {
    try {
      return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
    } catch {
      return false;
    }
  });
const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
});
const PrincipalGrantProjectionSchema = z
  .object({
    principalType: z.enum(["human", "service", "break_glass_owner"]),
    principalId: PrincipalIdSchema,
    organizationId: OrganizationIdSchema,
    grants: z.array(ResourceGrantSchema),
    grantVersion: z.string().min(1),
  })
  .strict();

const workspaceTransferBrand: unique symbol = Symbol("paseo.workspace-transfer");

export interface WorkspaceTransferPrincipalSource {
  resolvePrincipal(
    principalId: string,
    organizationId: AuthorizedWorkspace["organizationId"],
  ): Promise<PrincipalGrantProjection | null>;
  isCurrent(): boolean;
}

export interface WorkspaceTransferInput {
  readonly actor: PrincipalContext;
  readonly sessionId: string;
  readonly workspace: AuthorizedWorkspace;
  readonly expectedOwnerPrincipalId: string;
  readonly expectedRevision: string;
  readonly newPrincipalId: string;
  readonly isCurrent: () => boolean;
}

export interface CommittedWorkspaceOwnershipTransfer {
  readonly workspace: PersistedWorkspaceRecord;
  readonly receiptId: string;
}

export interface WorkspaceTransfer {
  readonly [workspaceTransferBrand]: true;
  transfer(input: WorkspaceTransferInput): Promise<CommittedWorkspaceOwnershipTransfer | null>;
  close(): void;
}

interface LocalWorkspaceTransferState {
  active: boolean;
  readonly workspaceRegistry: FileBackedWorkspaceRegistry;
  readonly appendAudit: AuditSink["append"];
  readonly resolvePrincipal: WorkspaceTransferPrincipalSource["resolvePrincipal"];
  readonly principalSourceIsCurrent: WorkspaceTransferPrincipalSource["isCurrent"];
}

interface CanonicalTransferInput {
  readonly actor: PrincipalContext;
  readonly sessionId: string;
  readonly workspace: AuthorizedWorkspace;
  readonly expectedOwnerPrincipalId: string;
  readonly expectedRevision: string;
  readonly newPrincipalId: string;
  readonly isCurrent: () => boolean;
}

interface TransferIntent {
  readonly receiptId: string;
  readonly revision: string;
}

type CanonicalPrincipalGrantProjection = z.infer<typeof PrincipalGrantProjectionSchema>;

const OPTION_KEYS = new Set(["workspaceRegistry", "audit", "principalSource"]);
const INPUT_KEYS = new Set([
  "actor",
  "sessionId",
  "workspace",
  "expectedOwnerPrincipalId",
  "expectedRevision",
  "newPrincipalId",
  "isCurrent",
]);
const localWorkspaceTransfers = new WeakMap<object, LocalWorkspaceTransferState>();

class WorkspaceTransferDeniedError extends Error {
  constructor() {
    super("Workspace ownership transfer denied");
    this.name = "WorkspaceTransferDeniedError";
  }
}

export function createLocalWorkspaceTransfer(input: unknown): WorkspaceTransfer | null {
  try {
    const options = captureExactRecord(input, OPTION_KEYS);
    if (!options || !(options.workspaceRegistry instanceof FileBackedWorkspaceRegistry)) {
      return null;
    }
    const appendAudit = captureMethod<AuditSink["append"]>(options.audit, "append");
    const resolvePrincipal = captureMethod<WorkspaceTransferPrincipalSource["resolvePrincipal"]>(
      options.principalSource,
      "resolvePrincipal",
    );
    const principalSourceIsCurrent = captureMethod<WorkspaceTransferPrincipalSource["isCurrent"]>(
      options.principalSource,
      "isCurrent",
    );
    if (!appendAudit || !resolvePrincipal || !principalSourceIsCurrent) return null;

    const adapter = Object.freeze({
      [workspaceTransferBrand]: true as const,
      transfer: (request: WorkspaceTransferInput) => transferWorkspaceOwnership(adapter, request),
      close: () => closeWorkspaceTransfer(adapter),
    });
    localWorkspaceTransfers.set(adapter, {
      active: true,
      workspaceRegistry: options.workspaceRegistry,
      appendAudit,
      resolvePrincipal,
      principalSourceIsCurrent,
    });
    return adapter;
  } catch {
    return null;
  }
}

export function isWorkspaceTransfer(value: unknown): value is WorkspaceTransfer {
  return isObject(value) && localWorkspaceTransfers.has(value);
}

export async function transferWorkspaceOwnership(
  transfer: WorkspaceTransfer,
  input: WorkspaceTransferInput,
): Promise<CommittedWorkspaceOwnershipTransfer | null> {
  try {
    if (!isObject(transfer)) return null;
    const state = localWorkspaceTransfers.get(transfer);
    const request = canonicalTransferInput(input);
    if (!state || !request || !isCurrent(state, request)) return null;
    if (
      request.expectedOwnerPrincipalId !== request.actor.principalId ||
      request.workspace.ownerPrincipalId !== request.actor.principalId ||
      request.newPrincipalId === request.actor.principalId
    ) {
      return null;
    }
    const newPrincipal = await resolveAuthoritativeNewPrincipal(state, request);
    if (!newPrincipal) return null;
    return await commitWorkspaceOwnership(state, request, newPrincipal);
  } catch (error) {
    if (error instanceof WorkspaceTransferDeniedError) return null;
    throw error;
  }
}

async function resolveAuthoritativeNewPrincipal(
  state: LocalWorkspaceTransferState,
  request: CanonicalTransferInput,
): Promise<CanonicalPrincipalGrantProjection | null> {
  const newPrincipal = PrincipalGrantProjectionSchema.safeParse(
    structuredClone(
      await state.resolvePrincipal(request.newPrincipalId, request.workspace.organizationId),
    ),
  );
  if (
    !newPrincipal.success ||
    newPrincipal.data.principalId !== request.newPrincipalId ||
    newPrincipal.data.organizationId !== request.workspace.organizationId ||
    !isCurrent(state, request)
  ) {
    return null;
  }
  return deepFreeze(newPrincipal.data);
}

async function commitWorkspaceOwnership(
  state: LocalWorkspaceTransferState,
  request: CanonicalTransferInput,
  authorizedNewPrincipal: CanonicalPrincipalGrantProjection,
): Promise<CommittedWorkspaceOwnershipTransfer | null> {
  const intentState: { value: TransferIntent | null } = { value: null };
  try {
    const committed = await state.workspaceRegistry.transferOwnership({
      workspaceId: request.workspace.workspaceId,
      expectedOwnerPrincipalId: request.expectedOwnerPrincipalId,
      expectedOwnershipRevision: request.expectedRevision,
      newOwnerPrincipalId: request.newPrincipalId,
      beforeCommit: async (record) => {
        if (!isCurrent(state, request) || !matchesAuthorizedWorkspace(record, request.workspace)) {
          throw new WorkspaceTransferDeniedError();
        }
        const currentNewPrincipal = await resolveAuthoritativeNewPrincipal(state, request);
        if (!currentNewPrincipal || !sameCanonical(currentNewPrincipal, authorizedNewPrincipal)) {
          throw new WorkspaceTransferDeniedError();
        }
        const revision = nextRevision(record.ownershipRevision ?? "0");
        const finalized = await appendTransferIntent(state, request, revision);
        if (!auditMatchesIntent(finalized, request, revision) || !isCurrent(state, request)) {
          throw new WorkspaceTransferDeniedError();
        }
        intentState.value = Object.freeze({ receiptId: finalized.eventId, revision });
      },
    });
    const intent = intentState.value;
    if (!committed || !intent || !matchesCommittedWorkspace(committed, request, intent.revision)) {
      return null;
    }
    return committedResult(committed, intent.receiptId);
  } catch (error) {
    if (error instanceof WorkspaceTransferDeniedError) return null;
    const intent = intentState.value;
    if (!intent) throw error;

    const persisted = await readWorkspaceAfterFailure(state.workspaceRegistry, request);
    if (persisted && matchesCommittedWorkspace(persisted, request, intent.revision)) {
      return committedResult(persisted, intent.receiptId);
    }
    const auditFailure = await appendFailedAudit(state, request, intent, error);
    if (auditFailure) {
      // oxlint-disable-next-line preserve-caught-error -- both primary and audit failures are retained.
      throw new AggregateError(
        [error, auditFailure],
        "Workspace ownership transfer and failed audit append rejected",
        { cause: error },
      );
    }
    throw error;
  }
}

async function appendTransferIntent(
  state: LocalWorkspaceTransferState,
  request: CanonicalTransferInput,
  revision: string,
): Promise<z.infer<typeof AuditEventSchema>> {
  return AuditEventSchema.parse(
    structuredClone(
      await state.appendAudit(
        AuditEventInputSchema.parse({
          organizationId: request.workspace.organizationId,
          actorPrincipalId: request.actor.principalId,
          actorCredentialId: request.actor.credentialId,
          sessionId: request.sessionId,
          action: "enterprise.resource.ownership.transfer",
          resource: { kind: "workspace", id: request.workspace.workspaceId },
          outcome: "allowed",
          metadata: {
            phase: "intent",
            newOwnerPrincipalId: request.newPrincipalId,
            revision,
          },
        }),
        { durability: "required" },
      ),
    ),
  );
}

export function closeWorkspaceTransfer(transfer: WorkspaceTransfer): void {
  if (!isObject(transfer)) return;
  const state = localWorkspaceTransfers.get(transfer);
  if (state) state.active = false;
}

function canonicalTransferInput(input: unknown): CanonicalTransferInput | null {
  try {
    const captured = captureExactRecord(input, INPUT_KEYS);
    if (!captured || typeof captured.isCurrent !== "function") return null;
    const actor = PrincipalContextSchema.parse(structuredClone(captured.actor));
    const workspace = AuthorizedWorkspaceSchema.parse(structuredClone(captured.workspace));
    const sessionId = z.string().min(1).parse(captured.sessionId);
    const expectedOwnerPrincipalId = PrincipalIdSchema.parse(captured.expectedOwnerPrincipalId);
    const expectedRevision = OwnershipRevisionSchema.parse(captured.expectedRevision);
    const newPrincipalId = PrincipalIdSchema.parse(captured.newPrincipalId);
    return deepFreeze({
      actor,
      sessionId,
      workspace,
      expectedOwnerPrincipalId,
      expectedRevision,
      newPrincipalId,
      isCurrent: captured.isCurrent.bind(undefined),
    });
  } catch {
    return null;
  }
}

function isCurrent(state: LocalWorkspaceTransferState, input: CanonicalTransferInput): boolean {
  if (!state.active) return false;
  try {
    return state.principalSourceIsCurrent() === true && input.isCurrent() === true;
  } catch {
    return false;
  }
}

function matchesAuthorizedWorkspace(
  record: PersistedWorkspaceRecord,
  workspace: AuthorizedWorkspace,
): boolean {
  return (
    record.workspaceId === workspace.workspaceId &&
    record.archivedAt === null &&
    record.organizationId === workspace.organizationId &&
    record.nodeId === workspace.nodeId &&
    record.ownerPrincipalId === workspace.ownerPrincipalId &&
    record.createdByPrincipalId === workspace.createdByPrincipalId
  );
}

function matchesCommittedWorkspace(
  record: PersistedWorkspaceRecord,
  input: CanonicalTransferInput,
  revision: string,
): boolean {
  return (
    record.workspaceId === input.workspace.workspaceId &&
    record.archivedAt === null &&
    record.organizationId === input.workspace.organizationId &&
    record.nodeId === input.workspace.nodeId &&
    record.ownerPrincipalId === input.newPrincipalId &&
    record.createdByPrincipalId === input.workspace.createdByPrincipalId &&
    record.ownershipRevision === revision
  );
}

function auditMatchesIntent(
  event: z.infer<typeof AuditEventSchema>,
  input: CanonicalTransferInput,
  revision: string,
): boolean {
  const metadata = event.metadata;
  return (
    event.organizationId === input.workspace.organizationId &&
    event.actorPrincipalId === input.actor.principalId &&
    event.actorCredentialId === input.actor.credentialId &&
    event.sessionId === input.sessionId &&
    event.action === "enterprise.resource.ownership.transfer" &&
    event.resource.kind === "workspace" &&
    event.resource.id === input.workspace.workspaceId &&
    event.outcome === "allowed" &&
    metadata !== undefined &&
    Reflect.ownKeys(metadata).length === 3 &&
    metadata.phase === "intent" &&
    metadata.newOwnerPrincipalId === input.newPrincipalId &&
    metadata.revision === revision
  );
}

async function readWorkspaceAfterFailure(
  registry: FileBackedWorkspaceRegistry,
  input: CanonicalTransferInput,
): Promise<PersistedWorkspaceRecord | null> {
  try {
    return await registry.get(input.workspace.workspaceId);
  } catch {
    return null;
  }
}

async function appendFailedAudit(
  state: LocalWorkspaceTransferState,
  input: CanonicalTransferInput,
  intent: TransferIntent,
  error: unknown,
): Promise<unknown | null> {
  try {
    await state.appendAudit(
      AuditEventInputSchema.parse({
        organizationId: input.workspace.organizationId,
        actorPrincipalId: input.actor.principalId,
        actorCredentialId: input.actor.credentialId,
        sessionId: input.sessionId,
        action: "enterprise.resource.ownership.transfer",
        resource: { kind: "workspace", id: input.workspace.workspaceId },
        outcome: "failed",
        reasonCode: "workspace_ownership_transfer_failed",
        metadata: {
          phase: "storage",
          newOwnerPrincipalId: input.newPrincipalId,
          revision: intent.revision,
          intentEventId: intent.receiptId,
          error: error instanceof Error ? error.name : "unknown",
        },
      }),
      { durability: "required" },
    );
    return null;
  } catch (auditError) {
    return auditError;
  }
}

function committedResult(
  workspace: PersistedWorkspaceRecord,
  receiptId: string,
): CommittedWorkspaceOwnershipTransfer {
  return deepFreeze({ workspace: structuredClone(workspace), receiptId });
}

function nextRevision(revision: string): string {
  const parsed = OwnershipRevisionSchema.parse(revision);
  const next = BigInt(parsed) + 1n;
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkspaceTransferDeniedError();
  return next.toString();
}

function captureMethod<T extends (...parameters: never[]) => unknown>(
  receiver: unknown,
  name: string,
): T | null {
  if (!isObject(receiver)) return null;
  let current: object | null = receiver;
  while (current) {
    const descriptor = Reflect.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      return descriptor.value.bind(receiver) as T;
    }
    current = Reflect.getPrototypeOf(current);
  }
  return null;
}

function captureExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return null;
  }
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
    Object.freeze(value);
  }
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
