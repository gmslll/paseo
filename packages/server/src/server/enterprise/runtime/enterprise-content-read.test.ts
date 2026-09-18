import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AppSlotRecord,
  AuthorizedAgent,
  AuthorizedWorkspace,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentTimelineRow } from "../../agent/agent-timeline-store-types.js";
import { SessionAuthorization } from "../../authorization/index.js";
import { FileBackedGrantStorage, type GrantRecord } from "../access/grant-store.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
} from "../access/production-authorization-runtime-provider.js";
import type { ProductionAuthorizationStatePort } from "../access/production-authorization-runtime.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
} from "../identity/admission-authorization.js";
import { createProductionEnterpriseWorkspaceFilesProvider } from "./production-workspace-files-runtime-provider.js";
import type { EnterpriseWorkspaceFilesRuntime } from "./workspace-files-runtime.js";
import {
  ENTERPRISE_APP_SLOT_CONTENT_READ_OPERATION,
  ENTERPRISE_AGENT_CONTENT_READ_OPERATION,
  ENTERPRISE_CONTENT_SOURCE_PAGE_LIMIT,
  ENTERPRISE_WORKSPACE_CONTENT_READ_OPERATION,
  createEnterpriseAgentContentReadSource,
  createEnterpriseAppSlotContentReadSource,
  createEnterpriseWorkspaceContentReadSource,
  isEnterpriseAgentContentReadSource,
  isEnterpriseAppSlotContentReadSource,
  isEnterpriseWorkspaceContentReadSource,
  type EnterpriseContentAgentProductionSource,
} from "./enterprise-content-read.js";

const workspace: AuthorizedWorkspace = Object.freeze({
  workspaceId: "workspace-a",
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  ownerPrincipalId: "usr_0123456789abcdef",
  createdByPrincipalId: "usr_0123456789abcdef",
});
const agent: AuthorizedAgent = Object.freeze({
  agentId: "agent-a",
  workspaceId: workspace.workspaceId,
  organizationId: workspace.organizationId,
  nodeId: workspace.nodeId,
  ownerPrincipalId: workspace.ownerPrincipalId,
  createdByPrincipalId: workspace.createdByPrincipalId,
});
const appSlot: AppSlotRecord = Object.freeze({
  appSlotId: "aps_0123456789abcdef",
  organizationId: workspace.organizationId,
  nodeId: workspace.nodeId,
  appBundleId: "com.example.enterprise",
  accountBindingKey: "secret-account-binding",
  credentialRef: "secret-credential-reference",
  ownerPrincipalId: workspace.ownerPrincipalId,
  concurrency: 1,
  status: "ready",
});
const executeFile = promisify(execFile);

describe("enterprise resource-specific content read sources", () => {
  test("exposes only the three W5-owned operations and nominal source ports", () => {
    expect([
      ENTERPRISE_WORKSPACE_CONTENT_READ_OPERATION,
      ENTERPRISE_AGENT_CONTENT_READ_OPERATION,
      ENTERPRISE_APP_SLOT_CONTENT_READ_OPERATION,
    ]).toEqual([
      "enterprise.workspace.content.read.request",
      "enterprise.agent.content.read.request",
      "enterprise.app_slot.content.read.request",
    ]);

    const files = filesRuntime([]);
    const agents = agentSource([]);
    const workspaceSource = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    const agentContent = createEnterpriseAgentContentReadSource({ agents: agents.port });
    const appSlotContent = createEnterpriseAppSlotContentReadSource();
    expect(isEnterpriseWorkspaceContentReadSource(workspaceSource)).toBe(true);
    expect(isEnterpriseAgentContentReadSource(agentContent)).toBe(true);
    expect(isEnterpriseAppSlotContentReadSource(appSlotContent)).toBe(true);
    expect(isEnterpriseWorkspaceContentReadSource({ read() {}, close() {} })).toBe(false);
    expect(isEnterpriseAgentContentReadSource({ read() {}, close() {} })).toBe(false);
    expect(isEnterpriseAppSlotContentReadSource({ read() {}, close() {} })).toBe(false);
  });

  test("returns a strict bounded Workspace file page and an opaque resource-bound cursor", async () => {
    const files = filesRuntime([
      entry("z.txt", 3, 30),
      entry("a.txt", 1, 10),
      entry("m.txt", 2, 20),
    ]);
    const agents = agentSource([]);
    const source = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    if (!source) throw new Error("expected Workspace content source");

    const first = await source.read({
      resource: workspace,
      selector: { kind: "workspace", view: "files" },
      page: { limit: 2 },
    });
    expect(first.items).toEqual([
      {
        itemId: "file:1:101",
        occurredAt: new Date(10).toISOString(),
        kind: "file",
        reference: "a.txt",
        label: "a.txt",
        size: 1,
      },
      {
        itemId: "file:1:102",
        occurredAt: new Date(20).toISOString(),
        kind: "file",
        reference: "m.txt",
        label: "m.txt",
        size: 2,
      },
    ]);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.nextCursor).not.toContain("workspace-a");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.items)).toBe(true);

    const wrongResource = { ...workspace, workspaceId: "workspace-b" };
    await expect(
      source.read({
        resource: wrongResource,
        selector: { kind: "workspace", view: "files" },
        page: { limit: 2, cursor: first.nextCursor! },
      }),
    ).rejects.toThrow("cursor");
    expect(files.listCalls).toEqual(["workspace-a"]);
    await expect(
      source.read({
        resource: workspace,
        selector: { kind: "workspace", view: "files" },
        page: { limit: 2, cursor: first.nextCursor! },
      }),
    ).rejects.toThrow("cursor");
    expect(files.listCalls).toEqual(["workspace-a"]);

    await source.close();
  });

  test("caps page limits and snapshots public input before the storage await", async () => {
    const gate = deferred<readonly ReturnType<typeof entry>[]>();
    const files = filesRuntime([], gate.promise);
    const agents = agentSource([]);
    const source = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    if (!source) throw new Error("expected Workspace content source");
    const input = {
      resource: { ...workspace },
      selector: { kind: "workspace" as const, view: "files" as "files" | "timeline" },
      page: { limit: 100 },
    };
    const pending = source.read(input);
    input.resource.workspaceId = "attacker-workspace";
    input.selector.view = "timeline";
    input.page.limit = 1;
    gate.resolve(
      Array.from({ length: ENTERPRISE_CONTENT_SOURCE_PAGE_LIMIT + 1 }, (_, index) =>
        entry(`file-${String(index).padStart(2, "0")}.txt`, index, index),
      ),
    );
    const page = await pending;
    expect(page.items).toHaveLength(ENTERPRISE_CONTENT_SOURCE_PAGE_LIMIT);
    expect(page.nextCursor).not.toBeNull();
    expect(files.listCalls).toEqual([workspace.workspaceId]);
    expect(agents.timelineCalls).toEqual([]);
    await source.close();
  });

  test("reads only exact canonical Workspace agents and rejects a mid-read ownership rebind", async () => {
    const canonicalAgent = managedAgent(agent);
    const foreignAgent = managedAgent({
      ...agent,
      agentId: "agent-foreign",
      workspaceId: "workspace-foreign",
    });
    const agents = agentSource([canonicalAgent, foreignAgent], {
      "agent-a": [messageRow(1, "one")],
      "agent-foreign": [messageRow(2, "foreign")],
    });
    const files = filesRuntime([]);
    const source = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    if (!source) throw new Error("expected Workspace content source");

    await expect(
      source.read({
        resource: workspace,
        selector: { kind: "workspace", view: "timeline" },
        page: { limit: 10 },
      }),
    ).resolves.toMatchObject({
      items: [{ itemId: "agent-a:1", kind: "message", text: "one" }],
      nextCursor: null,
    });
    expect(agents.timelineCalls).toEqual(["agent-a"]);

    const race = deferred<readonly AgentTimelineRow[]>();
    agents.rowsByAgent.set("agent-a", race.promise);
    const pending = source.read({
      resource: workspace,
      selector: { kind: "workspace", view: "timeline" },
      page: { limit: 10 },
    });
    agents.currentById.set("agent-a", managedAgent({ ...agent, workspaceId: "workspace-rebound" }));
    race.resolve([messageRow(2, "late")]);
    await expect(pending).rejects.toThrow("changed");
    await source.close();
  });

  test("Agent transcript uses the exact id and fails closed for missing or rebound storage", async () => {
    const agents = agentSource([managedAgent(agent)], {
      "agent-a": [
        messageRow(1, "user", "user_message"),
        messageRow(2, "assistant", "assistant_message"),
        {
          seq: 3,
          timestamp: "2026-01-01T00:00:03.000Z",
          item: { type: "reasoning", text: "secret" },
        },
      ],
    });
    const source = createEnterpriseAgentContentReadSource({ agents: agents.port });
    if (!source) throw new Error("expected Agent content source");
    const page = await source.read({
      resource: agent,
      selector: { kind: "agent", view: "transcript" },
      page: { limit: 10 },
    });
    expect(page).toEqual({
      items: [
        {
          itemId: "agent-a:1",
          occurredAt: "2026-01-01T00:00:01.000Z",
          kind: "message",
          text: "user",
        },
        {
          itemId: "agent-a:2",
          occurredAt: "2026-01-01T00:00:02.000Z",
          kind: "message",
          text: "assistant",
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toContain("secret");
    expect(agents.timelineCalls).toEqual(["agent-a"]);

    agents.currentById.delete("agent-a");
    await expect(
      source.read({
        resource: agent,
        selector: { kind: "agent", view: "transcript" },
        page: { limit: 10 },
      }),
    ).rejects.toThrow("unavailable");
    expect(agents.timelineCalls).toEqual(["agent-a"]);

    agents.currentById.set("agent-a", managedAgent({ ...agent, nodeId: "node-rebound" }));
    await expect(
      source.read({
        resource: agent,
        selector: { kind: "agent", view: "artifacts" },
        page: { limit: 10 },
      }),
    ).rejects.toThrow("unavailable");
    expect(agents.timelineCalls).toEqual(["agent-a"]);
    await source.close();
  });

  test("App Slot projects only redacted state and never exposes binding or credential fields", async () => {
    const source = createEnterpriseAppSlotContentReadSource();
    const state = await source.read({
      resource: appSlot,
      selector: { kind: "app_slot", view: "state" },
      page: { limit: 10 },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      itemId: `app-slot:${appSlot.appSlotId}:state`,
      kind: "state",
      label: appSlot.appBundleId,
      status: appSlot.status,
    });
    expect(JSON.stringify(state)).not.toContain(appSlot.accountBindingKey);
    expect(JSON.stringify(state)).not.toContain(appSlot.credentialRef);
    await expect(
      source.read({
        resource: appSlot,
        selector: { kind: "app_slot", view: "artifacts" },
        page: { limit: 10 },
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await source.close();
    await expect(
      source.read({
        resource: appSlot,
        selector: { kind: "app_slot", view: "state" },
        page: { limit: 10 },
      }),
    ).rejects.toThrow("closed");
  });

  test("strict snapshots reject accessors, symbols, and cross-family selectors before IO", async () => {
    const files = filesRuntime([entry("secret.txt", 1, 1)]);
    const agents = agentSource([]);
    const source = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    if (!source) throw new Error("expected Workspace content source");
    let getterCalls = 0;
    const hostile = Object.defineProperty(
      {
        selector: { kind: "workspace", view: "files" },
        page: { limit: 10 },
      },
      "resource",
      {
        enumerable: true,
        get() {
          getterCalls += 1;
          return workspace;
        },
      },
    );
    await expect(source.read(hostile as never)).rejects.toThrow();
    await expect(
      source.read({
        resource: workspace,
        selector: { kind: "agent", view: "transcript" } as never,
        page: { limit: 10 },
        [Symbol("extra")]: true,
      } as never),
    ).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(files.listCalls).toEqual([]);
    expect(agents.timelineCalls).toEqual([]);
    await source.close();
  });

  test("close seals a blocked read, waits for settlement, and cleans files exactly once", async () => {
    const gate = deferred<readonly ReturnType<typeof entry>[]>();
    const files = filesRuntime([], gate.promise);
    const agents = agentSource([]);
    const source = createEnterpriseWorkspaceContentReadSource({
      filesRuntime: files.port,
      agents: agents.port,
    });
    if (!source) throw new Error("expected Workspace content source");
    const pending = source.read({
      resource: workspace,
      selector: { kind: "workspace", view: "files" },
      page: { limit: 10 },
    });
    const firstClose = source.close();
    const secondClose = source.close();
    expect(firstClose).toBe(secondClose);
    expect(files.cleanupCalls).toEqual(["session-closed"]);
    let closed = false;
    void firstClose.then(() => {
      closed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    gate.resolve([entry("late.txt", 1, 1)]);
    await expect(pending).rejects.toThrow("closed");
    await expect(firstClose).resolves.toBeUndefined();
    expect(files.cleanupCalls).toEqual(["session-closed"]);
  });

  test.runIf(process.platform === "darwin")(
    "reads the real Darwin production workspace source and fails closed when its registry disappears",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w5-content-source-"));
      const auditAddonPath = path.join(root, "darwin-audit-fs.node");
      const workspaceAddonPath = path.join(root, "darwin-workspace-fs.node");
      await Promise.all([
        executeFile(process.execPath, [
          fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
          "--output",
          auditAddonPath,
        ]),
        executeFile(process.execPath, [
          fileURLToPath(new URL("./native/build-darwin-workspace-fs.mjs", import.meta.url)),
          "--output",
          workspaceAddonPath,
        ]),
      ]);
      const node: NodeContext = Object.freeze({
        nodeId: workspace.nodeId,
        paseoServerId: "srv_content_source",
        mode: "standalone",
      });
      const principal: PrincipalContext = Object.freeze({
        principalType: "human",
        principalId: workspace.ownerPrincipalId,
        organizationId: workspace.organizationId,
        credentialId: "cred_content_source",
        grantVersion: "grv_1",
        grants: Object.freeze([
          {
            action: "workspace.content.read",
            selector: { kind: "workspace", workspaceIds: [workspace.workspaceId] },
          },
        ]),
      });
      const audit = await createProductionAuditRuntime({
        node,
        auditRoot: path.join(root, "audit"),
        nativeAddonPath: auditAddonPath,
      });
      let runtime: Awaited<ReturnType<typeof createProductionAuthorizationRuntimeForSession>> =
        null;
      let source: ReturnType<typeof createEnterpriseWorkspaceContentReadSource> = null;
      try {
        const grantFilePath = path.join(root, "grants.json");
        const grantRecord: GrantRecord = {
          principalId: principal.principalId,
          organizationId: principal.organizationId,
          grants: principal.grants,
          grantVersion: principal.grantVersion,
        };
        await new FileBackedGrantStorage(grantFilePath).put(grantRecord);
        const authorityProvider = createProductionAuthorizationRuntimeProvider({
          audit,
          grantFilePath,
        });
        if (!authorityProvider) throw new Error("expected production authorization provider");
        authorityProvider.owners.registerWorkspace({
          id: workspace.workspaceId,
          organizationId: workspace.organizationId,
          nodeId: workspace.nodeId,
          ownerPrincipalId: workspace.ownerPrincipalId,
          createdByPrincipalId: workspace.createdByPrincipalId,
        });
        const secret = Object.freeze({});
        const issuer = createEnterpriseAdmissionAuthorizationIssuer(secret);
        const evidence = issueEnterpriseAdmissionEvidence(issuer, secret, principal, node, {
          node,
          transport: "direct",
          peer: "loopback",
        });
        const handle = evidence
          ? bindEnterpriseAdmissionSession(issuer, evidence, "client-content-source")
          : null;
        if (!handle) throw new Error("expected production admission handle");
        runtime = await createProductionAuthorizationRuntimeForSession(authorityProvider, {
          admissionAuthorizationIssuer: issuer,
          admissionAuthorizationHandle: handle,
          sessionAuthorization: new SessionAuthorization(["workspace.read"]),
          sessionId: "session-content-source",
          authorityState: new EmptyAuthorityState(),
        });
        if (!runtime) throw new Error("expected production authorization runtime");

        const workspaceRootInput = path.join(root, "workspace");
        await mkdir(workspaceRootInput);
        const workspaceRoot = await realpath(workspaceRootInput);
        await writeFile(path.join(workspaceRoot, "real.txt"), "real-production-content");
        let registryCurrent = true;
        const filesProvider = createProductionEnterpriseWorkspaceFilesProvider({
          workspaceRoots: {
            async get(workspaceId: string) {
              return registryCurrent && workspaceId === workspace.workspaceId
                ? { ...workspace, cwd: workspaceRoot, archivedAt: null }
                : null;
            },
          },
          nativeAddonPath: workspaceAddonPath,
        });
        if (!filesProvider?.releaseReady) throw new Error("expected production workspace provider");
        const sessionFilesRuntime = filesProvider.createSessionRuntime(runtime);
        if (!sessionFilesRuntime) throw new Error("expected production workspace runtime");
        source = createEnterpriseWorkspaceContentReadSource({
          filesRuntime: sessionFilesRuntime,
          agents: agentSource([]).port,
        });
        if (!source) throw new Error("expected production content source");

        await expect(
          source.read({
            resource: workspace,
            selector: { kind: "workspace", view: "files" },
            page: { limit: 10 },
          }),
        ).resolves.toMatchObject({
          items: [{ kind: "file", reference: "real.txt", size: 23 }],
          nextCursor: null,
        });

        registryCurrent = false;
        await expect(
          source.read({
            resource: workspace,
            selector: { kind: "workspace", view: "files" },
            page: { limit: 10 },
          }),
        ).rejects.toThrow("denied");
      } finally {
        await source?.close().catch(() => undefined);
        await runtime?.release().catch(() => undefined);
        await audit.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

class EmptyAuthorityState implements ProductionAuthorizationStatePort {
  async consumeAuthorizedRequest() {
    return null;
  }
  async resolveCurrentSessionBinding() {
    return null;
  }
  async register() {
    return null;
  }
  async resolveOpen() {
    return null;
  }
  async mintFreshReceipt() {
    return null;
  }
  async burnFreshReceipts() {}
  async close() {}
}

function entry(name: string, size: number, mtimeMs: number) {
  return Object.freeze({
    relativePath: name,
    name,
    kind: "file" as const,
    size,
    mtimeMs,
    dev: 1,
    ino: 100 + size,
  });
}

function filesRuntime(
  entries: readonly ReturnType<typeof entry>[],
  pending?: Promise<readonly ReturnType<typeof entry>[]>,
) {
  const listCalls: string[] = [];
  const cleanupCalls: string[] = [];
  const port = {
    async list(input: { workspaceId: string }) {
      listCalls.push(input.workspaceId);
      return pending ? await pending : entries;
    },
    async cleanup(reason: "session-closed" | "generation-replaced") {
      cleanupCalls.push(reason);
    },
  } as unknown as EnterpriseWorkspaceFilesRuntime;
  return { port, listCalls, cleanupCalls };
}

function agentSource(
  agents: readonly ManagedAgent[],
  rows: Readonly<Record<string, readonly AgentTimelineRow[]>> = {},
) {
  const currentById = new Map(agents.map((value) => [value.id, value]));
  const rowsByAgent = new Map<
    string,
    readonly AgentTimelineRow[] | Promise<readonly AgentTimelineRow[]>
  >(Object.entries(rows));
  const timelineCalls: string[] = [];
  const port: EnterpriseContentAgentProductionSource = {
    listAgents: () => [...agents],
    getAgent: (agentId) => currentById.get(agentId) ?? null,
    async getTimelineRows(agentId) {
      timelineCalls.push(agentId);
      const value = rowsByAgent.get(agentId);
      if (!value) throw new Error("missing Agent timeline storage");
      return [...(await value)];
    },
  };
  return { port, currentById, rowsByAgent, timelineCalls };
}

function managedAgent(resource: AuthorizedAgent): ManagedAgent {
  return {
    id: resource.agentId,
    workspaceId: resource.workspaceId,
    enterpriseOwnership: {
      workspaceId: resource.workspaceId,
      organizationId: resource.organizationId,
      nodeId: resource.nodeId,
      ownerPrincipalId: resource.ownerPrincipalId,
      createdByPrincipalId: resource.createdByPrincipalId,
    },
  } as unknown as ManagedAgent;
}

function messageRow(
  seq: number,
  text: string,
  type: "user_message" | "assistant_message" = "assistant_message",
): AgentTimelineRow {
  return {
    seq,
    timestamp: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
    item: { type, text },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
