import type { Buffer } from "node:buffer";

import { formatCollabSegment } from "@getpaseo/protocol/enterprise-collaboration";

import type { AgentManagerEvent } from "../../../agent/agent-manager.js";
import type { ManagedNodeRelationship } from "../relationship-store.js";
import { collabPaths, ensureCollabRepoPath, type CollabPaths } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";
import {
  MachineRpcServer,
  type HeadlessSessionFactory,
  type MachineRpcPrincipalSource,
} from "./machine-rpc-server.js";
import { MetaProjector, type MetaWorkspaceStore } from "./meta-projector.js";
import { CollabStreamUplink, type StreamUplinkTransport } from "./stream-uplink.js";
import { TimelineProjector, type AgentSubscription } from "./timeline-projector.js";
import type { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

/**
 * Wires one node's collaboration replicas to the plane (ADR-0031, ADR-0032).
 *
 * A container per collaborating Workspace, each with its own replica file, its own uplink and its
 * own projectors. The daemon-side collaborators arrive through `install` rather than the
 * constructor: the plane-side inputs are known when the enterprise runtime is built, and the
 * Workspace registry and Agent manager only exist later in bootstrap.
 */
export interface CollabRuntimeOptions {
  readonly paseoHome: string;
  readonly relationship: ManagedNodeRelationship;
  readonly caCertificate: string | Buffer;
  /** Only the method this uses, so a caller can hand over a catalog without a directory. */
  readonly catalog: Pick<ManagedWorkspaceCatalog, "activeWorkspaces">;
  /** Reported rather than thrown: one container's failure must not stop the others. */
  readonly onError?: (containerId: string, error: unknown) => void;
  readonly organizationId: string;
  /** The plane's ticket key, which is what an attestation is checked against (ADR-0035). */
  readonly ticketPublicKeyPem: string;
  /** Resolves the Principal an attested request names, for the Session that answers it. */
  readonly principals: MachineRpcPrincipalSource;
  readonly now?: () => number;
  /** Handed to every uplink. Left unset, each dials the plane over HTTPS as it does in production. */
  readonly transport?: StreamUplinkTransport;
}

export interface CollabRuntimeDependencies {
  readonly workspaceRegistry: MetaWorkspaceStore;
  readonly agents: AgentSubscription;
}

interface CollabContainer {
  readonly containerId: string;
  readonly workspaceId: string;
  readonly store: CollabRepoStore;
  readonly uplink: CollabStreamUplink;
  readonly meta: MetaProjector;
  readonly timelines: Map<string, TimelineProjector>;
  readonly rpc: MachineRpcServer | null;
}

export class CollabRuntime {
  private readonly paths: CollabPaths;
  private readonly containers = new Map<string, CollabContainer>();
  private dependencies: CollabRuntimeDependencies | null = null;
  private sessions: HeadlessSessionFactory | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: CollabRuntimeOptions) {
    this.paths = collabPaths(options.paseoHome);
  }

  /** Opens a replica per collaborating Workspace and starts projecting the Agents on them. */
  async install(dependencies: CollabRuntimeDependencies): Promise<void> {
    if (this.closed) throw new Error("collaboration runtime is closed");
    if (this.dependencies) throw new Error("collaboration runtime is already installed");
    this.dependencies = dependencies;
    await this.openCatalogedContainers();
    // Every Agent event, not one Agent's: this is what notices an Agent the node did not have when
    // the container opened.
    this.unsubscribe = dependencies.agents.subscribe((event) => this.onAgentEvent(event));
  }

  /**
   * Lets the node answer machine RPCs (ADR-0035, ADR-0053).
   *
   * Separate from `install` because the factory belongs to the WebSocket server, which bootstrap
   * builds long after the replicas. Until this lands the RPC log is not even read: consuming a
   * request with nothing to answer it would drop it past its cursor.
   */
  attachSessions(sessions: HeadlessSessionFactory): void {
    if (this.closed) throw new Error("collaboration runtime is closed");
    if (this.sessions) throw new Error("collaboration sessions are already attached");
    this.sessions = sessions;
    for (const [containerId, container] of this.containers) {
      this.containers.set(containerId, { ...container, rpc: this.createRpcServer(container) });
    }
  }

  /**
   * One cycle of the exchange: send what this node wrote, take what the members wrote, then let the
   * meta projector settle the Workspace record against what arrived.
   */
  async pump(): Promise<void> {
    if (this.closed || !this.dependencies) return;
    // The catalog is re-read every cycle rather than only at install: it is empty on a first boot
    // until the policy refresh builds it, and a Workspace shared later arrives the same way. A
    // container opened once at install would miss both.
    await this.openCatalogedContainers();
    for (const container of this.containers.values()) {
      // Re-checked each turn: close() can land between two containers, and the stores it closed
      // must not be flushed against.
      if (this.closed) return;
      try {
        await this.pumpContainer(container);
      } catch (error) {
        this.options.onError?.(container.containerId, error);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const container of this.containers.values()) {
      for (const timeline of container.timelines.values()) timeline.stop();
      container.timelines.clear();
      container.store.close();
    }
    this.containers.clear();
  }

  private async openCatalogedContainers(): Promise<void> {
    for (const entry of this.options.catalog.activeWorkspaces()) {
      if (this.closed) return;
      if (this.containers.has(entry.workspaceUid)) continue;
      try {
        await this.openContainer(entry.workspaceUid, entry.localWorkspaceId);
      } catch (error) {
        this.options.onError?.(entry.workspaceUid, error);
      }
    }
  }

  private async pumpContainer(container: CollabContainer): Promise<void> {
    // Flushing by what is queued rather than by a fixed list: the segments this node writes are
    // whichever ones its projectors touched.
    const dirty = new Set(container.store.listPendingUpdates().map((update) => update.segment));
    for (const segment of dirty) await container.uplink.flushSegment(segment);

    for (const segment of this.pullSet(container)) await container.uplink.pullSegment(segment);

    // Read only with something to answer with: a log segment's bytes exist nowhere after the read.
    const rpc = container.rpc;
    if (rpc) {
      const requests = await container.uplink.pullSegment(
        formatCollabSegment({ kind: "rpc_request", nodeId: this.options.relationship.node.nodeId }),
      );
      for (const request of requests.messages) await rpc.handle(request);
    }

    await container.meta.reconcile();
    container.store.sweepRpcInbox();
  }

  /** What this node reads: the shared Workspace documents, the RPCs addressed to it, and whatever
   * it already holds a cursor for. */
  private pullSet(container: CollabContainer): readonly string[] {
    // `rpc:req:<nodeId>` is not here: it is pulled in `pumpContainer`, and only when a session
    // factory is attached, because reading it advances the cursor past envelopes the replica does
    // not keep (ADR-0032).
    const segments = new Set<string>([
      formatCollabSegment({ kind: "meta" }),
      formatCollabSegment({ kind: "workspace_kv" }),
      ...Object.keys(container.store.remoteCursors()),
    ]);
    return [...segments];
  }

  private async openContainer(containerId: string, workspaceId: string): Promise<void> {
    if (this.containers.has(containerId)) return;
    const dependencies = this.dependencies;
    if (!dependencies) throw new Error("collaboration runtime is not installed");

    const store = CollabRepoStore.open({
      path: ensureCollabRepoPath(this.paths, containerId),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    const uplink = new CollabStreamUplink({
      relationship: this.options.relationship,
      caCertificate: this.options.caCertificate,
      containerId,
      store,
      ...(this.options.transport ? { transport: this.options.transport } : {}),
    });
    const meta = new MetaProjector({
      store,
      containerId,
      workspaceId,
      registry: dependencies.workspaceRegistry,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    // A write without an epoch is refused by the replica, and the segment to open is the one the
    // projector owns rather than one named here: `meta` is a key inside that document, not the
    // segment holding it.
    uplink.beginEpoch(meta.segmentName);
    const record = await dependencies.workspaceRegistry.get(workspaceId);
    if (record) meta.publish(record);

    const container: CollabContainer = {
      containerId,
      workspaceId,
      store,
      uplink,
      meta,
      timelines: new Map(),
      rpc: null,
    };
    this.containers.set(containerId, { ...container, rpc: this.createRpcServer(container) });
  }

  /** Null until sessions are attached, which is what makes an RPC answerable. */
  private createRpcServer(container: CollabContainer): MachineRpcServer | null {
    const sessions = this.sessions;
    if (!sessions) return null;
    return new MachineRpcServer({
      store: container.store,
      containerId: container.containerId,
      nodeId: this.options.relationship.node.nodeId,
      organizationId: this.options.organizationId,
      ticketPublicKeyPem: this.options.ticketPublicKeyPem,
      principals: this.options.principals,
      sessions,
      // The role the plane recorded for this container, which is the second of the two checks
      // ADR-0035 wants: the plane applies one before signing, the node applies its own.
      roleOf: (principalId) =>
        this.options.catalog
          .activeWorkspaces()
          .find((entry) => entry.workspaceUid === container.containerId)
          ?.members.find((member) => member.principalId === principalId)?.role ?? null,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  private onAgentEvent(event: AgentManagerEvent): void {
    if (this.closed || event.type !== "agent_state") return;
    const workspaceId = event.agent.workspaceId;
    if (!workspaceId) return;
    const entry = this.options.catalog
      .activeWorkspaces()
      .find((candidate) => candidate.localWorkspaceId === workspaceId);
    if (!entry) return;
    const container = this.containers.get(entry.workspaceUid);
    if (!container || container.timelines.has(event.agent.id)) return;

    const projector = new TimelineProjector({
      store: container.store,
      agentId: event.agent.id,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    container.uplink.beginEpoch(projector.segmentName);
    container.timelines.set(event.agent.id, projector);
    // Attaching replays the Agent's current state, so the document catches up with an Agent that
    // was already running when this node started collaborating.
    projector.attach(this.dependencies!.agents);
  }
}
