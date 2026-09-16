import { readFileSync } from "node:fs";

import {
  WorkspaceCatalogSchema,
  type WorkspaceCatalog,
  type WorkspaceCatalogEntry,
  type WorkspaceMembershipPolicy,
} from "@getpaseo/protocol/enterprise-collaboration";

import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../../private-files.js";
import { collabPaths, type CollabPaths } from "./collab-paths.js";

/**
 * Which collaborative Workspaces this node hosts (ADR-0032, ADR-0036).
 *
 * The plane sends them with the node policy, so there is no separate route to poll: a refresh is
 * whatever the last policy response carried. It is written to disk because §5.1.8 lets existing
 * local work continue through a short plane outage within a valid Ticket and Grant — a node that
 * restarted during one would otherwise come back unable to name the Workspaces it is hosting.
 *
 * A Workspace the plane stops listing becomes `remote_missing` rather than disappearing: it may
 * have been unshared, or the plane may be wrong, and a node that deleted its own record of it could
 * not tell an owner what happened. `revoked` is not set here — revocation is ADR-0036's, and a
 * membership list cannot say whether an absence is a revocation.
 */

export interface WorkspaceCatalogSource {
  currentWorkspaceMemberships(): readonly WorkspaceMembershipPolicy[] | null;
}

export interface ManagedWorkspaceCatalogOptions {
  readonly paseoHome: string;
  readonly nodeId: string;
  readonly organizationId: string;
  readonly source: WorkspaceCatalogSource;
  readonly now?: () => number;
}

export class ManagedWorkspaceCatalog {
  private readonly paths: CollabPaths;
  private readonly now: () => number;
  private catalog: WorkspaceCatalog | null = null;

  constructor(private readonly options: ManagedWorkspaceCatalogOptions) {
    this.paths = collabPaths(options.paseoHome);
    this.now = options.now ?? Date.now;
  }

  /**
   * Reads the catalog left by the previous boot. A file that is missing, unreadable or no longer
   * matches the schema is treated as no catalog rather than as a failure to start: the next
   * successful policy refresh rebuilds it, and refusing to boot over a cache would make a stale
   * file worse than an absent one.
   */
  load(): WorkspaceCatalog | null {
    try {
      const parsed = WorkspaceCatalogSchema.parse(
        JSON.parse(readFileSync(this.paths.catalog, "utf8")),
      );
      this.catalog = parsed.nodeId === this.options.nodeId ? parsed : null;
    } catch {
      this.catalog = null;
    }
    return this.catalog;
  }

  current(): WorkspaceCatalog | null {
    return this.catalog;
  }

  /**
   * Rebuilds the catalog from the memberships the last policy refresh carried.
   *
   * Returns the catalog unchanged when the node does not collaborate, and — importantly — when the
   * policy has never been read. A plane that cannot be reached leaves the memberships null, and
   * treating that as "hosts nothing" would mark every Workspace missing during an outage §5.1.8
   * says to work through.
   */
  refresh(): WorkspaceCatalog | null {
    const memberships = this.options.source.currentWorkspaceMemberships();
    if (memberships === null) return this.catalog;

    const at = new Date(this.now()).toISOString();
    const present = new Map(memberships.map((entry) => [entry.workspaceUid, entry]));
    const entries: WorkspaceCatalogEntry[] = memberships.map((entry) => ({
      workspaceUid: entry.workspaceUid,
      localWorkspaceId: entry.localWorkspaceId,
      ownerPrincipalId: entry.ownerPrincipalId,
      members: entry.members.map((member) => ({ ...member })),
      state: "active",
      cachedAt: at,
      remoteMissingAt: null,
    }));

    for (const known of this.catalog?.workspaces ?? []) {
      if (present.has(known.workspaceUid)) continue;
      entries.push({
        ...known,
        state: "remote_missing",
        // Keep the first time it went missing rather than restamping it on every refresh, so how
        // long it has been gone stays answerable.
        remoteMissingAt: known.remoteMissingAt ?? at,
      });
    }

    entries.sort((left, right) => left.workspaceUid.localeCompare(right.workspaceUid));
    const next = WorkspaceCatalogSchema.parse({
      version: 1,
      nodeId: this.options.nodeId,
      organizationId: this.options.organizationId,
      fetchedAt: at,
      workspaces: entries,
    });
    this.catalog = next;
    this.persist(next);
    return next;
  }

  /** The Workspaces this node will serve: the ones the plane still lists. */
  activeWorkspaces(): readonly WorkspaceCatalogEntry[] {
    return (this.catalog?.workspaces ?? []).filter((entry) => entry.state === "active");
  }

  private persist(catalog: WorkspaceCatalog): void {
    ensurePrivateDirectory(this.paths.root);
    writePrivateFileAtomicSync(this.paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
  }
}
