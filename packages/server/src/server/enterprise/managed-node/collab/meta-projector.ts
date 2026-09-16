import { formatCollabSegment } from "@getpaseo/protocol/enterprise-collaboration";

import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../../../workspace-registry.js";
import type { CollabRepoStore } from "./loro-repo-store.js";

/**
 * Keeps a Workspace's `meta` document and the node's registry record agreeing (ADR-0032).
 *
 * Both sides can write it, which is what makes it different from a session document: the node owns
 * the derived fields, and an editor owns `title` and `pinnedAt`. Those two are the fields a client
 * can already change on a direct connection through `workspace.title.set` and `workspace.pin.set`,
 * both gated on `workspace.write`, so collaboration widens where an editor makes the change and not
 * what an editor may change.
 *
 * A change to anything else is refused and the node republishes the value it holds. Refusing
 * quietly would leave the replica that sent it believing a rename or an ownership transfer had
 * taken, and disagreeing forever.
 */

export const CLIENT_WRITABLE_META_KEYS = ["title", "pinnedAt"] as const;
export type ClientWritableMetaKey = (typeof CLIENT_WRITABLE_META_KEYS)[number];

const META_KEY = "meta";

/** The record fields the node publishes. Everything a client may not touch is listed here. */
const DERIVED_KEYS = [
  "workspaceId",
  "projectId",
  "cwd",
  "kind",
  "displayName",
  "branch",
  "baseBranch",
  "worktreeRoot",
  "mainRepoRoot",
  "isPaseoOwnedWorktree",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "ownershipRevision",
  // A client that could set this would clear the gate that holds an untrusted Workspace back from
  // automation, so it is derived like any other field the node decides.
  "untrustedSource",
  "autoArchivedChangeRequestUrl",
] as const satisfies readonly (keyof PersistedWorkspaceRecord)[];

/**
 * The two registry methods this projector uses, rather than the whole interface: it reads one
 * record and writes the fields an editor may change, and naming that narrowly keeps a caller from
 * having to hand it an archive or a transfer it will never call.
 */
export type MetaWorkspaceStore = Pick<WorkspaceRegistry, "get" | "update">;

export interface MetaProjectorOptions {
  readonly store: CollabRepoStore;
  readonly containerId: string;
  readonly workspaceId: string;
  readonly registry: MetaWorkspaceStore;
  readonly now?: () => number;
}

export interface ReconcileResult {
  /** Keys an editor changed that the node accepted and persisted. */
  readonly applied: ClientWritableMetaKey[];
  /** Keys an editor changed that the node refused and published its own value for. */
  readonly corrected: string[];
}

function normalizeTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  // Same rule as workspace.title.set: blank clears the title back to the derived name.
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizePinnedAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

interface MetaDiff {
  readonly changes: Partial<PersistedWorkspaceRecord>;
  readonly applied: ClientWritableMetaKey[];
  readonly corrected: string[];
}

/**
 * Sorts what the document says into what the node will persist and what it will overrule. Pure, so
 * the decision can be read and tested without a registry or a replica behind it.
 *
 * A key the document does not mention is not a change: a collaborator who never touched `title` is
 * not asking for it to be cleared.
 */
function classifyMeta(meta: Record<string, unknown>, record: PersistedWorkspaceRecord): MetaDiff {
  const changes: Partial<PersistedWorkspaceRecord> = {};
  const applied: ClientWritableMetaKey[] = [];
  const corrected: string[] = [];

  if ("title" in meta) {
    const title = normalizeTitle(meta.title);
    // A value that failed to parse is a refusal like any other: the node's value goes back.
    if (title === undefined) corrected.push("title");
    else if (title !== record.title) {
      changes.title = title;
      applied.push("title");
    }
  }
  if ("pinnedAt" in meta) {
    const pinnedAt = normalizePinnedAt(meta.pinnedAt);
    if (pinnedAt === undefined) corrected.push("pinnedAt");
    else if (pinnedAt !== record.pinnedAt) {
      changes.pinnedAt = pinnedAt;
      applied.push("pinnedAt");
    }
  }
  for (const key of DERIVED_KEYS) {
    if (!(key in meta)) continue;
    if (!Object.is(meta[key] ?? null, record[key] ?? null)) corrected.push(key);
  }
  return { changes, applied, corrected };
}

export class MetaProjector {
  private readonly segment: string;
  private readonly now: () => number;

  constructor(private readonly options: MetaProjectorOptions) {
    this.segment = formatCollabSegment({ kind: "workspace_kv" });
    this.now = options.now ?? Date.now;
  }

  get segmentName(): string {
    return this.segment;
  }

  /** Publishes the node's view. Called on boot and whenever the registry record changes. */
  publish(record: PersistedWorkspaceRecord): void {
    this.options.store.applyLocalChange(this.segment, (document) => {
      const meta = document.getMap(META_KEY);
      for (const key of DERIVED_KEYS) {
        meta.set(key, (record[key] ?? null) as never);
      }
      for (const key of CLIENT_WRITABLE_META_KEYS) {
        meta.set(key, (record[key] ?? null) as never);
      }
    });
  }

  /**
   * Takes what the document now says, persists the client-writable changes, and publishes the
   * node's value back for everything else.
   *
   * Runs after a batch from the plane has been applied, so it sees the replica as a collaborator
   * left it rather than one update at a time.
   */
  async reconcile(): Promise<ReconcileResult> {
    const record = await this.options.registry.get(this.options.workspaceId);
    if (!record) return { applied: [], corrected: [] };

    const { changes, applied, corrected } = classifyMeta(this.readMeta(), record);

    const persisted =
      applied.length > 0
        ? ((await this.options.registry.update(this.options.workspaceId, (current) => ({
            ...current,
            ...changes,
            updatedAt: new Date(this.now()).toISOString(),
          }))) ?? record)
        : record;

    // One publish covers both directions: it carries the accepted values back with the node's
    // updatedAt, and overwrites every refused key with what the node holds.
    if (applied.length > 0 || corrected.length > 0) this.publish(persisted);
    return { applied, corrected };
  }

  private readMeta(): Record<string, unknown> {
    const document = this.options.store.document(this.segment).toJSON() as {
      meta?: Record<string, unknown>;
    };
    return document.meta ?? {};
  }
}
