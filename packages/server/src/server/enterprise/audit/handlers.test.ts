import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  AuditEvent,
  AuditEventInput,
  AuditHashInput,
  NodeContext,
  PrincipalContext,
} from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EnterpriseDispatchContext } from "../../session/enterprise-dispatcher.js";
import { createEnterpriseAuditDispatcher } from "./handlers.js";
import { Sha256AuditHash } from "./local-audit-sink.js";
import {
  createProductionAuditRuntime,
  type ProductionAuditCapability,
} from "./production-audit-runtime.js";

const executeFile = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0000000000000001",
  paseoServerId: "srv_audit_handler",
  mode: "standalone",
};
const ORGANIZATION_A = "org_0000000000000001";
const ORGANIZATION_B = "org_0000000000000002";
const PRINCIPAL_A = "usr_0000000000000001";
const PRINCIPAL_B = "usr_0000000000000002";

interface MutableContext extends EnterpriseDispatchContext {
  enterpriseContext: {
    principal: PrincipalContext;
    node: NodeContext;
    sessionBindingGeneration: string;
  };
}

interface AuditHarness {
  readonly parent: string;
  readonly auditRoot: string;
  readonly audit: ProductionAuditCapability;
  readonly nextIdentity: { value: number };
  readonly hash: DeferredAuditHash;
}

class DeferredAuditHash extends Sha256AuditHash {
  calls = 0;
  private shouldBlock = false;
  private releaseGate: () => void = () => undefined;
  private markStarted: () => void = () => undefined;
  private gate: Promise<void> = Promise.resolve();
  started: Promise<void> = Promise.resolve();

  blockNext(): void {
    this.shouldBlock = true;
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate();
  }

  override async hash(event: Readonly<AuditHashInput>): Promise<string> {
    this.calls += 1;
    if (this.shouldBlock) {
      this.shouldBlock = false;
      this.markStarted();
      await this.gate;
    }
    return super.hash(event);
  }
}

function context(organizationId: string, principalId: string, suffix: string): MutableContext {
  const credentialId = `cred_${suffix}`;
  const generation = `generation_${suffix}`;
  return {
    sessionId: `session_${suffix}`,
    clientId: `client_${suffix}`,
    credentialId,
    sessionBindingGeneration: generation,
    enterpriseContext: {
      principal: {
        organizationId,
        principalId,
        principalType: "human",
        credentialId,
        grantVersion: `grant_${suffix}`,
        grants: [
          {
            action: "audit.read",
            selector: { kind: "organization", organizationId },
          },
        ],
      },
      node: { ...node },
      sessionBindingGeneration: generation,
    },
  };
}

function eventInput(
  organizationId: string,
  actorPrincipalId: string,
  workspaceId: string,
  resourceId: string,
): AuditEventInput {
  return {
    organizationId,
    actorPrincipalId,
    action: "workspace.content.read",
    resource: { kind: "workspace", id: resourceId },
    workspaceId,
    outcome: "allowed",
  };
}

async function createHarness(addonPath: string): Promise<AuditHarness> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "paseo-audit-handler-"));
  const auditRoot = path.join(parent, "audit");
  const nextIdentity = { value: 0 };
  const hash = new DeferredAuditHash();
  const audit = await createProductionAuditRuntime({
    node,
    auditRoot,
    nativeAddonPath: addonPath,
    clock: {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, nextIdentity.value)).toISOString(),
    },
    idSource: {
      next: () => {
        nextIdentity.value += 1;
        return `evt_audit_handler_${nextIdentity.value}`;
      },
    },
    hash,
  });
  return { parent, auditRoot, audit, nextIdentity, hash };
}

async function append(
  harness: AuditHarness,
  organizationId: string,
  principalId: string,
  workspaceId: string,
  resourceId: string,
): Promise<AuditEvent> {
  return harness.audit.append(eventInput(organizationId, principalId, workspaceId, resourceId), {
    durability: "required",
  });
}

async function diskSnapshot(auditRoot: string): Promise<readonly [string, string][]> {
  const names = (await readdir(auditRoot)).sort();
  return Promise.all(
    names.map(async (name) => [name, await readFile(path.join(auditRoot, name), "utf8")] as const),
  );
}

describe("enterprise audit handler nominal boundary", () => {
  it("rejects a structural readiness fake without touching its query method", () => {
    let reads = 0;
    const fake = {
      adapterKind: "local",
      node,
      releaseReady: true,
      snapshotEvents: async () => {
        reads += 1;
        return [];
      },
    } as unknown as ProductionAuditCapability;

    expect(() => createEnterpriseAuditDispatcher({ audit: fake })).toThrow(
      "current production audit capability required",
    );
    expect(reads).toBe(0);
  });
});

describe.runIf(process.platform === "darwin")(
  "enterprise audit handler on real Darwin storage",
  () => {
    let buildDirectory = "";
    let addonPath = "";

    beforeAll(async () => {
      buildDirectory = await mkdtemp(path.join(os.tmpdir(), "paseo-audit-handler-native-"));
      addonPath = path.join(buildDirectory, "darwin-audit-fs.node");
      await executeFile(process.execPath, [
        fileURLToPath(new URL("./native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
    });

    afterAll(async () => {
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
    });

    it("returns strict newest-first pages from the current organization", async () => {
      const harness = await createHarness(addonPath);
      try {
        const a1 = await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a1", "ws_a1");
        await append(harness, ORGANIZATION_B, PRINCIPAL_B, "ws_b1", "ws_b1");
        const a2 = await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a2", "ws_a2");
        const a3 = await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a3", "ws_a3");
        const dispatcher = createEnterpriseAuditDispatcher({ audit: harness.audit });
        const first = await dispatcher.handle({
          sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "page-1",
            limit: 2,
          },
        });
        expect(first).toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "page-1", events: [a3, a2], nextCursor: a2.eventId },
        });
        expect(Object.isFrozen(first)).toBe(true);
        expect(first && Object.isFrozen(first.payload)).toBe(true);
        const second = await dispatcher.handle({
          sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "page-2",
            cursor: a2.eventId,
            limit: 2,
          },
        });
        expect(second).toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "page-2", events: [a1], nextCursor: null },
        });
        const filtered = await dispatcher.handle({
          sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "filtered",
            workspaceId: "ws_a2",
            resource: { kind: "workspace", id: "ws_a2" },
          },
        });
        expect(filtered).toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "filtered", events: [a2], nextCursor: null },
        });
      } finally {
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });

    it("makes foreign and missing IDOR probes identical with zero durable side effects", async () => {
      const harness = await createHarness(addonPath);
      try {
        await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a", "ws_a");
        const foreign = await append(harness, ORGANIZATION_B, PRINCIPAL_B, "ws_b", "ws_b");
        const dispatcher = createEnterpriseAuditDispatcher({ audit: harness.audit });
        const sessionContext = context(ORGANIZATION_A, PRINCIPAL_A, "a");
        const before = await diskSnapshot(harness.auditRoot);
        const foreignResource = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-request",
            resource: { kind: "workspace", id: "ws_b" },
          },
        });
        const missingResource = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-request",
            resource: { kind: "workspace", id: "ws_missing" },
          },
        });
        expect(foreignResource).toEqual(missingResource);
        expect(foreignResource).toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "same-request", events: [], nextCursor: null },
        });
        const foreignWorkspace = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-workspace-request",
            workspaceId: "ws_b",
          },
        });
        const missingWorkspace = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-workspace-request",
            workspaceId: "ws_missing",
          },
        });
        expect(foreignWorkspace).toEqual(missingWorkspace);
        expect(foreignWorkspace).toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "same-workspace-request", events: [], nextCursor: null },
        });

        const foreignCursor = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-cursor-request",
            cursor: foreign.eventId,
          },
        });
        const missingCursor = await dispatcher.handle({
          sessionContext,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "same-cursor-request",
            cursor: "evt_audit_handler_missing",
          },
        });
        expect(foreignCursor).toEqual(missingCursor);
        expect(foreignCursor).toEqual({
          type: "rpc_error",
          payload: {
            requestId: "same-cursor-request",
            requestType: "enterprise.audit.list_events.request",
            error: "Audit events unavailable",
            code: "resource_not_visible",
          },
        });
        expect(await diskSnapshot(harness.auditRoot)).toEqual(before);
        expect((await harness.audit.snapshotEvents()).map((event) => event.eventId)).toEqual([
          "evt_audit_handler_1",
          "evt_audit_handler_2",
        ]);
      } finally {
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });

    it("rejects stale authority and wrong-node contexts before reading storage", async () => {
      const harness = await createHarness(addonPath);
      try {
        await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a", "ws_a");
        const dispatcher = createEnterpriseAuditDispatcher({ audit: harness.audit });
        const withoutGrant = context(ORGANIZATION_A, PRINCIPAL_A, "without-grant");
        withoutGrant.enterpriseContext.principal.grants = [];
        const wrongNode = context(ORGANIZATION_A, PRINCIPAL_A, "wrong-node");
        wrongNode.enterpriseContext.node.nodeId = "nod_0000000000000002";
        const hashCalls = harness.hash.calls;
        const before = await diskSnapshot(harness.auditRoot);

        const missingGrant = await dispatcher.handle({
          sessionContext: withoutGrant,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "denied",
          },
        });
        const mismatchedNode = await dispatcher.handle({
          sessionContext: wrongNode,
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "denied",
          },
        });

        expect(missingGrant).toEqual(mismatchedNode);
        expect(missingGrant).toEqual({
          type: "rpc_error",
          payload: {
            requestId: "denied",
            requestType: "enterprise.audit.list_events.request",
            error: "Audit events unavailable",
            code: "resource_not_visible",
          },
        });
        expect(harness.hash.calls).toBe(hashCalls);
        expect(await diskSnapshot(harness.auditRoot)).toEqual(before);
      } finally {
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });

    it("isolates concurrent caller snapshots while a real chain verification is blocked", async () => {
      const harness = await createHarness(addonPath);
      try {
        const eventA = await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a", "ws_a");
        const eventB = await append(harness, ORGANIZATION_B, PRINCIPAL_B, "ws_b", "ws_b");
        const dispatcherOptions = { audit: harness.audit };
        const dispatcher = createEnterpriseAuditDispatcher(dispatcherOptions);
        dispatcherOptions.audit = {
          releaseReady: false,
        } as unknown as ProductionAuditCapability;
        const contextA = context(ORGANIZATION_A, PRINCIPAL_A, "a");
        const contextB = context(ORGANIZATION_B, PRINCIPAL_B, "b");
        const requestA = {
          type: "enterprise.audit.list_events.request" as const,
          requestId: "concurrent-a",
          resource: { kind: "workspace", id: "ws_a" },
        };
        const requestB = {
          type: "enterprise.audit.list_events.request" as const,
          requestId: "concurrent-b",
          resource: { kind: "workspace", id: "ws_b" },
        };
        harness.hash.blockNext();
        const pendingA = dispatcher.handle({ sessionContext: contextA, message: requestA });
        const pendingB = dispatcher.handle({ sessionContext: contextB, message: requestB });
        await harness.hash.started;

        requestA.resource.id = "ws_b";
        requestB.resource.id = "ws_a";
        contextA.enterpriseContext.principal.organizationId = ORGANIZATION_B;
        contextA.enterpriseContext.principal.grants = [];
        contextB.enterpriseContext.principal.organizationId = ORGANIZATION_A;
        contextB.enterpriseContext.node.nodeId = "nod_0000000000000002";
        harness.hash.release();

        await expect(pendingA).resolves.toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "concurrent-a", events: [eventA], nextCursor: null },
        });
        await expect(pendingB).resolves.toEqual({
          type: "enterprise.audit.list_events.response",
          payload: { requestId: "concurrent-b", events: [eventB], nextCursor: null },
        });
      } finally {
        harness.hash.release();
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });

    it("suppresses an in-flight page when close revokes the capability and shares the barrier", async () => {
      const harness = await createHarness(addonPath);
      try {
        await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a", "ws_a");
        const dispatcher = createEnterpriseAuditDispatcher({ audit: harness.audit });
        const before = await diskSnapshot(harness.auditRoot);
        harness.hash.blockNext();
        const pending = dispatcher.handle({
          sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
          message: {
            type: "enterprise.audit.list_events.request",
            requestId: "close-race",
          },
        });
        await harness.hash.started;
        let closeSettled = false;
        const close = harness.audit.close();
        const secondClose = harness.audit.close();
        expect(secondClose).toBe(close);
        const trackedClose = close.then(() => {
          closeSettled = true;
          return undefined;
        });
        await Promise.resolve();
        expect(closeSettled).toBe(false);
        harness.hash.release();

        await expect(pending).resolves.toEqual({
          type: "rpc_error",
          payload: {
            requestId: "close-race",
            requestType: "enterprise.audit.list_events.request",
            error: "Audit events unavailable",
            code: "resource_not_visible",
          },
        });
        await Promise.all([trackedClose, secondClose]);
        expect(closeSettled).toBe(true);
        expect(await diskSnapshot(harness.auditRoot)).toEqual(before);
      } finally {
        harness.hash.release();
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });

    it("returns false only for other operations and fails closed after capability close", async () => {
      const harness = await createHarness(addonPath);
      try {
        await append(harness, ORGANIZATION_A, PRINCIPAL_A, "ws_a", "ws_a");
        const dispatcher = createEnterpriseAuditDispatcher({ audit: harness.audit });
        const before = await diskSnapshot(harness.auditRoot);
        await expect(
          dispatcher.handle({
            sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
            message: {
              type: "enterprise.identity.get_current.request",
              requestId: "identity",
            },
          }),
        ).resolves.toBe(false);
        await harness.audit.close();
        await expect(
          dispatcher.handle({
            sessionContext: context(ORGANIZATION_A, PRINCIPAL_A, "a"),
            message: {
              type: "enterprise.audit.list_events.request",
              requestId: "closed",
            },
          }),
        ).resolves.toEqual({
          type: "rpc_error",
          payload: {
            requestId: "closed",
            requestType: "enterprise.audit.list_events.request",
            error: "Audit events unavailable",
            code: "resource_not_visible",
          },
        });
        expect(await diskSnapshot(harness.auditRoot)).toEqual(before);
      } finally {
        await harness.audit.close().catch(() => undefined);
        await rm(harness.parent, { recursive: true, force: true });
      }
    });
  },
);
