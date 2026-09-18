import { randomBytes, randomUUID } from "node:crypto";
import {
  AppSlotRecordSchema,
  EnterpriseAgentContentItemSchema,
  EnterpriseAgentContentSelectorSchema,
  EnterpriseAppSlotContentItemSchema,
  EnterpriseAppSlotContentSelectorSchema,
  EnterpriseResourceOwnerSchema,
  EnterpriseWorkspaceContentItemSchema,
  EnterpriseWorkspaceContentSelectorSchema,
  type AppSlotRecord,
  type AuthorizedAgent,
  type AuthorizedWorkspace,
  type EnterpriseAgentContentItem,
  type EnterpriseAgentContentSelector,
  type EnterpriseAppSlotContentItem,
  type EnterpriseAppSlotContentSelector,
  type EnterpriseWorkspaceContentItem,
  type EnterpriseWorkspaceContentSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { AgentManager, ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentTimelineRow } from "../../agent/agent-timeline-store-types.js";
import type {
  EnterpriseWorkspaceEntry,
  EnterpriseWorkspaceFilesRuntime,
} from "./workspace-files-runtime.js";

export const ENTERPRISE_WORKSPACE_CONTENT_READ_OPERATION =
  "enterprise.workspace.content.read.request" as const;
export const ENTERPRISE_AGENT_CONTENT_READ_OPERATION =
  "enterprise.agent.content.read.request" as const;
export const ENTERPRISE_APP_SLOT_CONTENT_READ_OPERATION =
  "enterprise.app_slot.content.read.request" as const;

export const ENTERPRISE_CONTENT_SOURCE_PAGE_LIMIT = 50;
export const ENTERPRISE_CONTENT_SOURCE_CURSOR_CAPACITY = 1_024;
export const ENTERPRISE_CONTENT_SOURCE_CURSOR_MAX_LENGTH = 128;
const CURSOR_TTL_MS = 5 * 60_000;
const SOURCE_ITEM_HARD_MAX = 10_000;
const WORKSPACE_AGENT_HARD_MAX = 1_000;

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();
const AuthorizedAgentSchema = EnterpriseResourceOwnerSchema.extend({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();
const StrictAppSlotRecordSchema = AppSlotRecordSchema.strict();
const SourcePageInputSchema = z
  .object({
    cursor: z.string().min(1).max(ENTERPRISE_CONTENT_SOURCE_CURSOR_MAX_LENGTH).optional(),
    limit: z.number().int().positive().max(100),
  })
  .strict();
const WorkspaceSourceInputSchema = z
  .object({
    resource: AuthorizedWorkspaceSchema,
    selector: EnterpriseWorkspaceContentSelectorSchema,
    page: SourcePageInputSchema,
  })
  .strict();
const AgentSourceInputSchema = z
  .object({
    resource: AuthorizedAgentSchema,
    selector: EnterpriseAgentContentSelectorSchema,
    page: SourcePageInputSchema,
  })
  .strict();
const AppSlotSourceInputSchema = z
  .object({
    resource: StrictAppSlotRecordSchema,
    selector: EnterpriseAppSlotContentSelectorSchema,
    page: SourcePageInputSchema,
  })
  .strict();
const WorkspacePageSchema = z
  .object({
    items: z.array(EnterpriseWorkspaceContentItemSchema),
    nextCursor: z.string().min(1).max(ENTERPRISE_CONTENT_SOURCE_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
const AgentPageSchema = z
  .object({
    items: z.array(EnterpriseAgentContentItemSchema),
    nextCursor: z.string().min(1).max(ENTERPRISE_CONTENT_SOURCE_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
const AppSlotPageSchema = z
  .object({
    items: z.array(EnterpriseAppSlotContentItemSchema),
    nextCursor: z.string().min(1).max(ENTERPRISE_CONTENT_SOURCE_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();

export interface EnterpriseContentSourcePageInput {
  readonly cursor?: string;
  readonly limit: number;
}

export interface EnterpriseWorkspaceContentReadInput {
  /** W2-resolved current Workspace. Caller wire references are never accepted here. */
  readonly resource: AuthorizedWorkspace;
  readonly selector: EnterpriseWorkspaceContentSelector;
  readonly page: EnterpriseContentSourcePageInput;
}

export interface EnterpriseAgentContentReadInput {
  /** W2-resolved current Agent and owning Workspace. */
  readonly resource: AuthorizedAgent;
  readonly selector: EnterpriseAgentContentSelector;
  readonly page: EnterpriseContentSourcePageInput;
}

export interface EnterpriseAppSlotContentReadInput {
  /** W2-resolved current App Slot record. */
  readonly resource: AppSlotRecord;
  readonly selector: EnterpriseAppSlotContentSelector;
  readonly page: EnterpriseContentSourcePageInput;
}

export interface EnterpriseWorkspaceContentReadPage {
  readonly items: readonly EnterpriseWorkspaceContentItem[];
  readonly nextCursor: string | null;
}

export interface EnterpriseAgentContentReadPage {
  readonly items: readonly EnterpriseAgentContentItem[];
  readonly nextCursor: string | null;
}

export interface EnterpriseAppSlotContentReadPage {
  readonly items: readonly EnterpriseAppSlotContentItem[];
  readonly nextCursor: string | null;
}

declare const workspaceContentSourceBrand: unique symbol;
declare const agentContentSourceBrand: unique symbol;
declare const appSlotContentSourceBrand: unique symbol;

export interface EnterpriseWorkspaceContentReadSource {
  readonly [workspaceContentSourceBrand]: never;
  read(input: EnterpriseWorkspaceContentReadInput): Promise<EnterpriseWorkspaceContentReadPage>;
  close(): Promise<void>;
}

export interface EnterpriseAgentContentReadSource {
  readonly [agentContentSourceBrand]: never;
  read(input: EnterpriseAgentContentReadInput): Promise<EnterpriseAgentContentReadPage>;
  close(): Promise<void>;
}

export interface EnterpriseAppSlotContentReadSource {
  readonly [appSlotContentSourceBrand]: never;
  read(input: EnterpriseAppSlotContentReadInput): Promise<EnterpriseAppSlotContentReadPage>;
  close(): Promise<void>;
}

export type EnterpriseContentAgentProductionSource = Pick<
  AgentManager,
  "listAgents" | "getAgent" | "getTimelineRows"
>;

export interface EnterpriseWorkspaceContentReadSourceOptions {
  /** Session-bound W5 safe-FS runtime. This factory assumes cleanup ownership. */
  readonly filesRuntime: EnterpriseWorkspaceFilesRuntime;
  readonly agents: EnterpriseContentAgentProductionSource;
}

export interface EnterpriseAgentContentReadSourceOptions {
  readonly agents: EnterpriseContentAgentProductionSource;
}

interface CapturedAgents {
  readonly listAgents: EnterpriseContentAgentProductionSource["listAgents"];
  readonly getAgent: EnterpriseContentAgentProductionSource["getAgent"];
  readonly getTimelineRows: EnterpriseContentAgentProductionSource["getTimelineRows"];
}

interface CursorBinding {
  readonly resource: string;
  readonly selector: string;
  readonly offset: number;
  readonly expiresAt: number;
}

interface ReadAttempt {
  active: boolean;
  readonly settled: Promise<void>;
  readonly settle: () => void;
}

const workspaceSourceRecords = new WeakSet<object>();
const agentSourceRecords = new WeakSet<object>();
const appSlotSourceRecords = new WeakSet<object>();

export function createEnterpriseWorkspaceContentReadSource(
  input: unknown,
): EnterpriseWorkspaceContentReadSource | null {
  try {
    const options = captureExactRecord(input, new Set(["filesRuntime", "agents"]));
    if (!options) return null;
    const filesRuntime = captureWorkspaceFilesRuntime(options.filesRuntime);
    const agents = captureAgents(options.agents);
    if (!filesRuntime || !agents) return null;
    const source = new WorkspaceContentSource(filesRuntime, agents);
    workspaceSourceRecords.add(source.publicPort);
    return source.publicPort;
  } catch {
    return null;
  }
}

export function createEnterpriseAgentContentReadSource(
  input: unknown,
): EnterpriseAgentContentReadSource | null {
  try {
    const options = captureExactRecord(input, new Set(["agents"]));
    const agents = options ? captureAgents(options.agents) : null;
    if (!agents) return null;
    const source = new AgentContentSource(agents);
    agentSourceRecords.add(source.publicPort);
    return source.publicPort;
  } catch {
    return null;
  }
}

export function createEnterpriseAppSlotContentReadSource(): EnterpriseAppSlotContentReadSource {
  const source = new AppSlotContentSource();
  appSlotSourceRecords.add(source.publicPort);
  return source.publicPort;
}

export function isEnterpriseWorkspaceContentReadSource(
  value: unknown,
): value is EnterpriseWorkspaceContentReadSource {
  return isObject(value) && workspaceSourceRecords.has(value);
}

export function isEnterpriseAgentContentReadSource(
  value: unknown,
): value is EnterpriseAgentContentReadSource {
  return isObject(value) && agentSourceRecords.has(value);
}

export function isEnterpriseAppSlotContentReadSource(
  value: unknown,
): value is EnterpriseAppSlotContentReadSource {
  return isObject(value) && appSlotSourceRecords.has(value);
}

abstract class ContentSourceLifecycle {
  protected readonly cursors = new CursorLedger();
  private readonly attempts = new Set<ReadAttempt>();
  private active = true;
  private closePromise: Promise<void> | null = null;

  protected begin(): ReadAttempt | null {
    if (!this.active) return null;
    let settle!: () => void;
    const attempt: ReadAttempt = {
      active: true,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    this.attempts.add(attempt);
    return attempt;
  }

  protected assertCurrent(attempt: ReadAttempt): void {
    if (!this.active || !attempt.active || !this.attempts.has(attempt)) {
      throw new Error("Enterprise content source is closed.");
    }
  }

  protected finish(attempt: ReadAttempt): void {
    if (!this.attempts.delete(attempt)) return;
    attempt.active = false;
    attempt.settle();
  }

  protected closeWith(cleanup?: () => Promise<void>): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.active = false;
    this.cursors.clear();
    const attempts = [...this.attempts];
    for (const attempt of attempts) attempt.active = false;
    let cleanupPromise: Promise<void> | null = null;
    if (cleanup) {
      try {
        cleanupPromise = cleanup();
      } catch (error) {
        cleanupPromise = Promise.reject(error);
      }
    }
    this.closePromise = (async () => {
      const results = await Promise.allSettled([
        ...attempts.map((attempt) => attempt.settled),
        ...(cleanupPromise ? [cleanupPromise] : []),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Enterprise content source cleanup failed.", {
          cause: failures[0],
        });
      }
    })();
    return this.closePromise;
  }
}

class WorkspaceContentSource extends ContentSourceLifecycle {
  public readonly publicPort: EnterpriseWorkspaceContentReadSource;
  private readonly listFiles: EnterpriseWorkspaceFilesRuntime["list"];
  private readonly cleanupFiles: EnterpriseWorkspaceFilesRuntime["cleanup"];
  private readonly agents: CapturedAgents;

  public constructor(
    filesRuntime: Pick<EnterpriseWorkspaceFilesRuntime, "list" | "cleanup">,
    agents: CapturedAgents,
  ) {
    super();
    this.listFiles = filesRuntime.list;
    this.cleanupFiles = filesRuntime.cleanup;
    this.agents = agents;
    this.publicPort = Object.freeze({
      read: (input: EnterpriseWorkspaceContentReadInput) => this.read(input),
      close: () => this.close(),
    }) as EnterpriseWorkspaceContentReadSource;
  }

  private async read(
    input: EnterpriseWorkspaceContentReadInput,
  ): Promise<EnterpriseWorkspaceContentReadPage> {
    const snapshot = parseInput(WorkspaceSourceInputSchema, input);
    const attempt = this.begin();
    if (!attempt) throw new Error("Enterprise Workspace content source is closed.");
    const cursor = this.cursors.consume(snapshot.resource, snapshot.selector, snapshot.page.cursor);
    if (cursor === null) {
      this.finish(attempt);
      throw new Error("Enterprise Workspace content cursor is unavailable.");
    }
    try {
      const items =
        snapshot.selector.view === "files"
          ? await this.files(snapshot.resource, attempt)
          : await this.timeline(snapshot.resource, attempt);
      this.assertCurrent(attempt);
      const page = paginate(items, cursor, snapshot.page.limit, this.cursors, {
        resource: snapshot.resource,
        selector: snapshot.selector,
      });
      return deepFreeze(WorkspacePageSchema.parse(page));
    } finally {
      this.finish(attempt);
    }
  }

  private async files(
    workspace: AuthorizedWorkspace,
    attempt: ReadAttempt,
  ): Promise<readonly EnterpriseWorkspaceContentItem[]> {
    const entries = await this.listFiles({
      workspaceId: workspace.workspaceId,
      relativePath: ".",
      requestId: `content-${randomUUID()}`,
    });
    this.assertCurrent(attempt);
    if (entries.length > SOURCE_ITEM_HARD_MAX) throw sourceTooLarge();
    return Object.freeze(
      [...entries]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map(projectWorkspaceFile),
    );
  }

  private async timeline(
    workspace: AuthorizedWorkspace,
    attempt: ReadAttempt,
  ): Promise<readonly EnterpriseWorkspaceContentItem[]> {
    const agents = this.agents.listAgents();
    if (agents.length > WORKSPACE_AGENT_HARD_MAX) throw sourceTooLarge();
    const agentIds = agents
      .filter((agent) => agentMatchesResource(agent, workspace))
      .map(exactAgentId)
      .filter((agentId): agentId is string => agentId !== null)
      .sort();
    const items: EnterpriseWorkspaceContentItem[] = [];
    for (const agentId of agentIds) {
      this.assertCurrent(attempt);
      const rows = await this.agents.getTimelineRows(agentId);
      this.assertCurrent(attempt);
      const current = this.agents.getAgent(agentId);
      if (!current || !agentMatchesResource(current, workspace)) {
        throw new Error("Workspace Agent source changed during content read.");
      }
      for (const row of rows) {
        const item = projectTimelineMessage(agentId, row, EnterpriseWorkspaceContentItemSchema);
        if (item) items.push(item);
        if (items.length > SOURCE_ITEM_HARD_MAX) throw sourceTooLarge();
      }
    }
    items.sort(compareItems);
    return Object.freeze(items);
  }

  private close(): Promise<void> {
    return this.closeWith(() => this.cleanupFiles("session-closed"));
  }
}

class AgentContentSource extends ContentSourceLifecycle {
  public readonly publicPort: EnterpriseAgentContentReadSource;
  private readonly getAgent: CapturedAgents["getAgent"];
  private readonly getTimelineRows: CapturedAgents["getTimelineRows"];

  public constructor(agents: CapturedAgents) {
    super();
    this.getAgent = agents.getAgent;
    this.getTimelineRows = agents.getTimelineRows;
    this.publicPort = Object.freeze({
      read: (input: EnterpriseAgentContentReadInput) => this.read(input),
      close: () => this.closeWith(),
    }) as EnterpriseAgentContentReadSource;
  }

  private async read(
    input: EnterpriseAgentContentReadInput,
  ): Promise<EnterpriseAgentContentReadPage> {
    const snapshot = parseInput(AgentSourceInputSchema, input);
    const attempt = this.begin();
    if (!attempt) throw new Error("Enterprise Agent content source is closed.");
    const cursor = this.cursors.consume(snapshot.resource, snapshot.selector, snapshot.page.cursor);
    if (cursor === null) {
      this.finish(attempt);
      throw new Error("Enterprise Agent content cursor is unavailable.");
    }
    try {
      let items: readonly EnterpriseAgentContentItem[] = Object.freeze([]);
      const before = this.getAgent(snapshot.resource.agentId);
      if (!before || !agentMatchesResource(before, snapshot.resource)) {
        throw new Error("Canonical Agent content source is unavailable.");
      }
      if (snapshot.selector.view === "transcript") {
        const rows = await this.getTimelineRows(snapshot.resource.agentId);
        this.assertCurrent(attempt);
        const after = this.getAgent(snapshot.resource.agentId);
        if (!after || !agentMatchesResource(after, snapshot.resource)) {
          throw new Error("Agent source changed during content read.");
        }
        if (rows.length > SOURCE_ITEM_HARD_MAX) throw sourceTooLarge();
        items = Object.freeze(
          rows.flatMap((row) => {
            const item = projectTimelineMessage(
              snapshot.resource.agentId,
              row,
              EnterpriseAgentContentItemSchema,
            );
            return item ? [item] : [];
          }),
        );
      }
      const page = paginate(items, cursor, snapshot.page.limit, this.cursors, {
        resource: snapshot.resource,
        selector: snapshot.selector,
      });
      return deepFreeze(AgentPageSchema.parse(page));
    } finally {
      this.finish(attempt);
    }
  }
}

class AppSlotContentSource extends ContentSourceLifecycle {
  public readonly publicPort: EnterpriseAppSlotContentReadSource;

  public constructor() {
    super();
    this.publicPort = Object.freeze({
      read: (input: EnterpriseAppSlotContentReadInput) => this.read(input),
      close: () => this.closeWith(),
    }) as EnterpriseAppSlotContentReadSource;
  }

  private async read(
    input: EnterpriseAppSlotContentReadInput,
  ): Promise<EnterpriseAppSlotContentReadPage> {
    const snapshot = parseInput(AppSlotSourceInputSchema, input);
    const attempt = this.begin();
    if (!attempt) throw new Error("Enterprise App Slot content source is closed.");
    const cursor = this.cursors.consume(snapshot.resource, snapshot.selector, snapshot.page.cursor);
    if (cursor === null) {
      this.finish(attempt);
      throw new Error("Enterprise App Slot content cursor is unavailable.");
    }
    try {
      const items: readonly EnterpriseAppSlotContentItem[] =
        snapshot.selector.view === "state"
          ? Object.freeze([projectAppSlotState(snapshot.resource)])
          : Object.freeze([]);
      const page = paginate(items, cursor, snapshot.page.limit, this.cursors, {
        resource: snapshot.resource,
        selector: snapshot.selector,
      });
      return deepFreeze(AppSlotPageSchema.parse(page));
    } finally {
      this.finish(attempt);
    }
  }
}

class CursorLedger {
  private readonly records = new Map<string, CursorBinding>();

  public consume(resource: object, selector: object, cursor?: string): number | null {
    if (cursor === undefined) return 0;
    const binding = this.records.get(cursor);
    if (!binding) return null;
    this.records.delete(cursor);
    if (binding.expiresAt <= Date.now()) return null;
    return binding.resource === fingerprint(resource) && binding.selector === fingerprint(selector)
      ? binding.offset
      : null;
  }

  public issue(resource: object, selector: object, offset: number): string {
    this.prune(Date.now());
    if (
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      this.records.size >= ENTERPRISE_CONTENT_SOURCE_CURSOR_CAPACITY
    ) {
      throw new Error("Enterprise content source cursor capacity unavailable.");
    }
    for (let index = 0; index < 4; index += 1) {
      const token = randomBytes(32).toString("base64url");
      if (this.records.has(token)) continue;
      this.records.set(
        token,
        Object.freeze({
          resource: fingerprint(resource),
          selector: fingerprint(selector),
          offset,
          expiresAt: Date.now() + CURSOR_TTL_MS,
        }),
      );
      return token;
    }
    throw new Error("Enterprise content source cursor unavailable.");
  }

  public clear(): void {
    this.records.clear();
  }

  private prune(now: number): void {
    for (const [cursor, binding] of this.records) {
      if (binding.expiresAt <= now) this.records.delete(cursor);
    }
  }
}

function paginate<T>(
  items: readonly T[],
  offset: number,
  requestedLimit: number,
  cursors: CursorLedger,
  binding: { readonly resource: object; readonly selector: object },
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  if (items.length > SOURCE_ITEM_HARD_MAX) throw sourceTooLarge();
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length)
    throw new Error("Enterprise content source cursor is stale.");
  const limit = Math.min(requestedLimit, ENTERPRISE_CONTENT_SOURCE_PAGE_LIMIT);
  const pageItems = Object.freeze(items.slice(offset, offset + limit));
  const nextOffset = offset + pageItems.length;
  return Object.freeze({
    items: pageItems,
    nextCursor:
      nextOffset < items.length
        ? cursors.issue(binding.resource, binding.selector, nextOffset)
        : null,
  });
}

function captureWorkspaceFilesRuntime(
  value: unknown,
): Pick<EnterpriseWorkspaceFilesRuntime, "list" | "cleanup"> | null {
  const list = captureMethod<EnterpriseWorkspaceFilesRuntime["list"]>(value, "list");
  const cleanup = captureMethod<EnterpriseWorkspaceFilesRuntime["cleanup"]>(value, "cleanup");
  return list && cleanup ? Object.freeze({ list, cleanup }) : null;
}

function captureAgents(value: unknown): CapturedAgents | null {
  const listAgents = captureMethod<EnterpriseContentAgentProductionSource["listAgents"]>(
    value,
    "listAgents",
  );
  const getAgent = captureMethod<EnterpriseContentAgentProductionSource["getAgent"]>(
    value,
    "getAgent",
  );
  const getTimelineRows = captureMethod<EnterpriseContentAgentProductionSource["getTimelineRows"]>(
    value,
    "getTimelineRows",
  );
  return listAgents && getAgent && getTimelineRows
    ? Object.freeze({ listAgents, getAgent, getTimelineRows })
    : null;
}

function projectTimelineMessage<
  T extends EnterpriseWorkspaceContentItem | EnterpriseAgentContentItem,
>(agentId: string, row: AgentTimelineRow, schema: { parse(value: unknown): T }): T | null {
  const seq = ownDataValue(row, "seq");
  const occurredAt = ownDataValue(row, "timestamp");
  const item = ownDataValue(row, "item");
  if (
    !Number.isSafeInteger(seq) ||
    (seq as number) < 0 ||
    typeof occurredAt !== "string" ||
    occurredAt.length === 0 ||
    !isObject(item)
  ) {
    throw new Error("Invalid canonical Agent timeline row.");
  }
  const type = ownDataValue(item, "type");
  if (type !== "user_message" && type !== "assistant_message") return null;
  const text = ownDataValue(item, "text");
  if (typeof text !== "string") throw new Error("Invalid canonical Agent message.");
  return deepFreeze(
    schema.parse({
      itemId: `${agentId}:${String(seq)}`,
      occurredAt,
      kind: "message",
      text,
    }),
  );
}

function projectWorkspaceFile(entry: EnterpriseWorkspaceEntry): EnterpriseWorkspaceContentItem {
  const relativePath = ownDataValue(entry, "relativePath");
  const name = ownDataValue(entry, "name");
  const dev = ownDataValue(entry, "dev");
  const ino = ownDataValue(entry, "ino");
  const size = ownDataValue(entry, "size");
  const mtimeMs = ownDataValue(entry, "mtimeMs");
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    !Number.isSafeInteger(dev) ||
    !Number.isSafeInteger(ino) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    typeof mtimeMs !== "number" ||
    !Number.isFinite(mtimeMs)
  ) {
    throw new Error("Invalid canonical Workspace file metadata.");
  }
  const occurredAt = new Date(mtimeMs).toISOString();
  return deepFreeze(
    EnterpriseWorkspaceContentItemSchema.parse({
      itemId: `file:${String(dev)}:${String(ino)}`,
      occurredAt,
      kind: "file",
      reference: relativePath,
      label: name,
      size,
    }),
  );
}

function projectAppSlotState(resource: AppSlotRecord): EnterpriseAppSlotContentItem {
  return deepFreeze(
    EnterpriseAppSlotContentItemSchema.parse({
      itemId: `app-slot:${resource.appSlotId}:state`,
      occurredAt: new Date().toISOString(),
      kind: "state",
      label: resource.appBundleId,
      status: resource.status,
    }),
  );
}

function agentMatchesResource(
  agent: ManagedAgent,
  resource: AuthorizedWorkspace | AuthorizedAgent,
): boolean {
  if (
    ownDataValue(agent, "workspaceId") !== resource.workspaceId ||
    ("agentId" in resource && ownDataValue(agent, "id") !== resource.agentId)
  ) {
    return false;
  }
  const ownership = ownDataValue(agent, "enterpriseOwnership");
  if (!isObject(ownership)) return false;
  return (
    ownDataValue(ownership, "workspaceId") === resource.workspaceId &&
    ownDataValue(ownership, "organizationId") === resource.organizationId &&
    ownDataValue(ownership, "nodeId") === resource.nodeId &&
    ownDataValue(ownership, "ownerPrincipalId") === resource.ownerPrincipalId &&
    ownDataValue(ownership, "createdByPrincipalId") === resource.createdByPrincipalId
  );
}

function exactAgentId(agent: ManagedAgent): string | null {
  const id = ownDataValue(agent, "id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function compareItems(left: EnterpriseWorkspaceContentItem, right: EnterpriseWorkspaceContentItem) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.itemId.localeCompare(right.itemId);
}

function parseInput<T>(schema: { parse(value: unknown): T }, input: unknown): T {
  return deepFreeze(schema.parse(snapshotPlainData(input)));
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
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
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
      return "value" in descriptor && typeof descriptor.value === "function"
        ? (descriptor.value.bind(receiver) as T)
        : null;
    }
    current = Reflect.getPrototypeOf(current);
  }
  return null;
}

function ownDataValue(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// oxlint-disable-next-line complexity -- recursive descriptor validation keeps one read per field.
function snapshotPlainData(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("Enterprise content source input nesting exceeds limit.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (!isObject(value)) throw new Error("Enterprise content source input is invalid.");
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^\d+$/.test(key))))
      throw new Error("Enterprise content source input array is invalid.");
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new Error("Enterprise content source input array is invalid.");
      result.push(snapshotPlainData(descriptor.value, depth + 1));
    }
    return Object.freeze(result);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Enterprise content source input object is invalid.");
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new Error("Enterprise content source input key is invalid.");
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      throw new Error("Enterprise content source input descriptor is invalid.");
    result[key] = snapshotPlainData(descriptor.value, depth + 1);
  }
  return Object.freeze(result);
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function sourceTooLarge(): Error {
  return new Error("Enterprise content source exceeds its hard bound.");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
