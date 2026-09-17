import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkspaceCatalogEntry } from "@getpaseo/protocol/enterprise-collaboration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentManagerEvent } from "../../../agent/agent-manager.js";
import type { ManagedAgent } from "../../../agent/agent-projections.js";
import type { AgentPermissionRequest, AgentSession } from "../../../agent/agent-sdk-types.js";
import type { PersistedWorkspaceRecord } from "../../../workspace-registry.js";
import { generateManagedNodeKeyPair, type ManagedNodeRelationship } from "../relationship-store.js";
import { CollabRuntime, type CollabRuntimeOptions } from "./collab-runtime.js";
import type { HeadlessSessionFactory } from "./machine-rpc-server.js";
import type { MetaWorkspaceStore } from "./meta-projector.js";
import type { StreamUplinkTransport } from "./stream-uplink.js";
import type { AgentSubscription } from "./timeline-projector.js";

const NODE_ID = "nod_0123456789abcdef";
const OWNER = "usr_0123456789abcdef";
const CONTAINER = "cws_0123456789abcdef";
const OTHER_CONTAINER = "cws_fedcba9876543210";
const WORKSPACE_ID = "wks_local_1";
const OTHER_WORKSPACE_ID = "wks_local_2";
const AGENT_ID = "agent-123";
const OFFSET = "00000000000000000001";
// The uplink signs every request, so the relationship needs a real key even though the transport
// never leaves the process.
const NODE_KEYS = generateManagedNodeKeyPair();

let directory: string;
let records: Map<string, PersistedWorkspaceRecord>;
let sent: Array<{ path: string; headers: Readonly<Record<string, string>> }>;
let read: string[];
let failFor: string | null;
let subscribers: Array<(event: AgentManagerEvent) => void>;
let lastState: Map<string, AgentManagerEvent>;
let runtimes: CollabRuntime[];
let failures: Array<{ containerId: string; error: unknown }>;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "collab-runtime-"));
  records = new Map([
    [WORKSPACE_ID, workspaceRecord(WORKSPACE_ID)],
    [OTHER_WORKSPACE_ID, workspaceRecord(OTHER_WORKSPACE_ID)],
  ]);
  sent = [];
  read = [];
  failFor = null;
  subscribers = [];
  lastState = new Map();
  runtimes = [];
  failures = [];
});

afterEach(() => {
  for (const created of runtimes) created.close();
  rmSync(directory, { recursive: true, force: true });
});

function workspaceRecord(workspaceId: string): PersistedWorkspaceRecord {
  return {
    workspaceId,
    projectId: "prj_1",
    cwd: "/tmp/project",
    kind: "worktree",
    displayName: "feature/refactor",
    title: null,
    branch: "feature/refactor",
    baseBranch: "main",
    worktreeRoot: "/tmp/project",
    mainRepoRoot: "/tmp/repo",
    isPaseoOwnedWorktree: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
  } as PersistedWorkspaceRecord;
}

/** Only the two methods the meta projector reaches for, as its option type asks. */
function registry(): MetaWorkspaceStore {
  return {
    get: async (workspaceId: string) => records.get(workspaceId) ?? null,
    update: async (
      workspaceId: string,
      updater: (current: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ) => {
      const current = records.get(workspaceId);
      if (!current) return null;
      const next = updater(current);
      records.set(workspaceId, next);
      return next;
    },
  };
}

/**
 * Replays current state on subscribe, which is what the Agent manager does and what the timeline
 * projector asks for. Without it a projector created for a running Agent would stay empty until
 * that Agent happened to change.
 */
function agents(): AgentSubscription {
  return {
    subscribe: (callback, options) => {
      subscribers.push(callback);
      if (options?.replayState) {
        for (const [agentId, event] of lastState) {
          if (!options.agentId || options.agentId === agentId) callback(event);
        }
      }
      return () => {
        const index = subscribers.indexOf(callback);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
  };
}

function emitAgentState(agentId: string, workspaceId: string | undefined): void {
  const event: AgentManagerEvent = {
    type: "agent_state",
    agent: managedAgent(agentId, workspaceId),
  };
  lastState.set(agentId, event);
  for (const subscriber of subscribers.slice()) subscriber(event);
}

function managedAgent(agentId: string, workspaceId: string | undefined): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  return {
    id: agentId,
    provider: "claude",
    cwd: "/tmp/project",
    ...(workspaceId ? { workspaceId } : {}),
    session: {} as AgentSession,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { provider: "claude", cwd: "/tmp/project" },
    lifecycle: "idle",
    createdAt: now,
    updatedAt: now,
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map<string, AgentPermissionRequest>(),
    activeTurnId: null,
    activeTurnStartedAt: null,
    queuedTurns: [],
    features: [],
    labels: {},
    persistence: null,
    lastUserMessageAt: null,
    attention: { requiresAttention: false },
  } as unknown as ManagedAgent;
}

function catalogEntry(workspaceUid: string, localWorkspaceId: string): WorkspaceCatalogEntry {
  return {
    workspaceUid,
    localWorkspaceId,
    ownerPrincipalId: OWNER,
    members: [{ principalId: OWNER, role: "owner" }],
    state: "active",
    cachedAt: "2025-01-01T00:00:00.000Z",
    remoteMissingAt: null,
  };
}

/** The plane's side of the exchange, recorded rather than dialed. */
function transport(): StreamUplinkTransport {
  return {
    sendBytes: async (input) => {
      if (failFor && input.path.includes(failFor)) throw new Error("plane unreachable");
      sent.push({ path: input.path, headers: input.headers });
      return { status: 201, headers: {}, body: null };
    },
    readJson: async <T>(input: { path: string }): Promise<T> => {
      read.push(input.path);
      return {
        messages: [],
        nextOffset: OFFSET,
        lowerBoundOffset: OFFSET,
        upToDate: true,
      } as T;
    },
  } as StreamUplinkTransport;
}

function runtime(entries: readonly WorkspaceCatalogEntry[]): CollabRuntime {
  const options: CollabRuntimeOptions = {
    // Always recorded. A container error the runtime reports and a test ignores looks exactly like
    // a test that passed.
    onError: (containerId, error) => failures.push({ containerId, error }),
    paseoHome: directory,
    relationship: {
      version: 1,
      managementBaseUrl: "https://management.test",
      node: { nodeId: NODE_ID },
      nodePrivateKeyPem: NODE_KEYS.privateKeyPem,
      ticketPublicKeyPem: NODE_KEYS.publicKeyPem,
    } as unknown as ManagedNodeRelationship,
    caCertificate: "ca",
    catalog: { activeWorkspaces: () => entries },
    organizationId: "org_0123456789abcdef",
    ticketPublicKeyPem: "unused-until-an-attestation-arrives",
    // No RPC reaches these tests: sessions are never attached, so the machine RPC server is null
    // and nothing resolves a Principal.
    principals: { resolvePrincipal: async () => null },
    transport: transport(),
  };
  const created = new CollabRuntime(options);
  runtimes.push(created);
  return created;
}

/** Enough to make an RPC answerable; what a Session does with the message is its own test. */
function sessions(): HeadlessSessionFactory {
  return {
    open: () => ({ handleMessage: async () => {}, close: () => {} }),
  };
}

function pathsSent(): string[] {
  return sent.map((entry) => entry.path);
}

describe("collaborating on behalf of a node", () => {
  test("opens a replica per Workspace and sends the node's meta document", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });

    await collab.pump();

    // The container opened, the epoch opened with it, and the published record was queued and sent.
    expect(pathsSent()).toContain(`/v1/ds/${CONTAINER}/wf`);
    expect(failures).toEqual([]);
    expect(sent[0]!.headers["producer-id"]).toBe(`nod:${NODE_ID}`);
  });

  test("reads the documents the members write, and not the RPC log it cannot answer", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });

    await collab.pump();

    expect(read).toContain(`/v1/ds/${CONTAINER}/meta`);
    expect(read).toContain(`/v1/ds/${CONTAINER}/wf`);
    // Not rpc:req. Reading it advances the cursor past envelopes the replica does not keep, so
    // until something answers them, pulling it would consume machine RPCs and drop them.
    expect(read.some((entry) => entry.includes(encodeURIComponent(`rpc:req:${NODE_ID}`)))).toBe(
      false,
    );
  });

  test("pulls the RPC log once it can answer one", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });
    await collab.pump();
    const rpcPath = encodeURIComponent(`rpc:req:${NODE_ID}`);
    expect(read.some((entry) => entry.includes(rpcPath))).toBe(false);

    collab.attachSessions(sessions());
    await collab.pump();

    // Reading it is what makes a request answerable, and attaching the factory is what makes
    // reading it safe: before this there was nothing to answer with, and the bytes do not survive
    // the read (ADR-0032). Whether a signed envelope then dispatches is the machine RPC server's
    // own test; this covers the branch that decides to read at all.
    expect(read.some((entry) => entry.includes(rpcPath))).toBe(true);
    expect(failures).toEqual([]);
  });

  test("projects an Agent that belongs to a collaborating Workspace", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });

    emitAgentState(AGENT_ID, WORKSPACE_ID);
    await collab.pump();

    expect(pathsSent()).toContain(`/v1/ds/${CONTAINER}/${encodeURIComponent(`s:${AGENT_ID}`)}`);
  });

  test("leaves an Agent outside the catalog alone", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });

    // A Workspace the plane never shared, and an Agent with no Workspace at all.
    emitAgentState("agent-elsewhere", OTHER_WORKSPACE_ID);
    emitAgentState("agent-loose", undefined);
    await collab.pump();

    expect(pathsSent().some((entry) => entry.includes("agent-elsewhere"))).toBe(false);
    expect(pathsSent().some((entry) => entry.includes("agent-loose"))).toBe(false);
  });

  test("one container's failure does not stop the next", async () => {
    const collab = runtime([
      catalogEntry(CONTAINER, WORKSPACE_ID),
      catalogEntry(OTHER_CONTAINER, OTHER_WORKSPACE_ID),
    ]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });

    failFor = CONTAINER;
    await collab.pump();

    expect(failures.map((entry) => entry.containerId)).toEqual([CONTAINER]);
    expect(pathsSent()).toContain(`/v1/ds/${OTHER_CONTAINER}/wf`);
  });

  test("picks up a Workspace shared after it was installed", async () => {
    // The catalog is empty on a first boot until the policy refresh builds it, so install cannot be
    // the only time it is read.
    const entries: WorkspaceCatalogEntry[] = [];
    const collab = runtime(entries);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });
    await collab.pump();
    expect(pathsSent()).toEqual([]);

    entries.push(catalogEntry(CONTAINER, WORKSPACE_ID));
    await collab.pump();

    expect(pathsSent()).toContain(`/v1/ds/${CONTAINER}/wf`);
    expect(failures).toEqual([]);
  });

  test("stops projecting once closed", async () => {
    const collab = runtime([catalogEntry(CONTAINER, WORKSPACE_ID)]);
    await collab.install({ workspaceRegistry: registry(), agents: agents() });
    await collab.pump();
    const before = sent.length;

    collab.close();
    emitAgentState(AGENT_ID, WORKSPACE_ID);
    await collab.pump();

    expect(sent.length).toBe(before);
  });
});
