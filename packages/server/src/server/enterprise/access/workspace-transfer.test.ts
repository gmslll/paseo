import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  AuditEventSchema,
  type AuditAppendOptions,
  type AuditEvent,
  type AuditEventInput,
  type AuditSink,
  type PrincipalContext,
} from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test } from "vitest";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../../workspace-registry.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  closeWorkspaceTransfer,
  createLocalWorkspaceTransfer,
  isWorkspaceTransfer,
  transferWorkspaceOwnership,
  type WorkspaceTransferInput,
  type WorkspaceTransferPrincipalSource,
} from "./workspace-transfer.js";

const organizationId = "org_0123456789abcdef";
const nodeId = "nod_0123456789abcdef";
const ownerPrincipalId = "usr_0123456789abcdef";
const newPrincipalId = "usr_1111111111111111";
const actor: PrincipalContext = {
  principalType: "human",
  principalId: ownerPrincipalId,
  organizationId,
  credentialId: "cred_workspace_transfer",
  grantVersion: "grv_workspace_transfer",
  grants: [
    {
      action: "workspace.manage",
      selector: { kind: "workspace", workspaceIds: ["wks_transfer"] },
    },
  ],
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local WorkspaceTransfer port", () => {
  test("commits through the real registry, returns the finalized audit id, and survives restart", async () => {
    const fixture = await createFixture();
    const result = await transferWorkspaceOwnership(fixture.transfer, transferInput());

    expect(result).toEqual({
      workspace: expect.objectContaining({
        workspaceId: "wks_transfer",
        ownerPrincipalId: newPrincipalId,
        ownershipRevision: "1",
      }),
      receiptId: "evt_workspace_transfer_1",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.workspace)).toBe(true);
    expect(fixture.audit.calls).toEqual([
      {
        input: expect.objectContaining({
          organizationId,
          actorPrincipalId: ownerPrincipalId,
          actorCredentialId: actor.credentialId,
          sessionId: "session_workspace_transfer",
          action: "enterprise.resource.ownership.transfer",
          resource: { kind: "workspace", id: "wks_transfer" },
          outcome: "allowed",
          metadata: {
            phase: "intent",
            newOwnerPrincipalId: newPrincipalId,
            revision: "1",
          },
        }),
        options: { durability: "required" },
      },
    ]);

    const restarted = new FileBackedWorkspaceRegistry(fixture.filePath, createTestLogger());
    await restarted.initialize();
    await expect(restarted.get("wks_transfer")).resolves.toMatchObject({
      ownerPrincipalId: newPrincipalId,
      ownershipRevision: "1",
    });
    await expect(transferWorkspaceOwnership(fixture.transfer, transferInput())).resolves.toBeNull();
    expect(fixture.audit.calls).toHaveLength(1);
  });

  test("uniformly denies missing, stale, foreign, inactive-principal, and callback-stale inputs", async () => {
    const cases: Array<{
      name: string;
      mutateInput?: (input: WorkspaceTransferInput) => WorkspaceTransferInput;
      configure?: (fixture: Awaited<ReturnType<typeof createFixture>>) => void;
    }> = [
      {
        name: "missing workspace",
        mutateInput: (input) => ({
          ...input,
          workspace: { ...input.workspace, workspaceId: "wks_missing" },
        }),
      },
      {
        name: "stale revision",
        mutateInput: (input) => ({ ...input, expectedRevision: "9" }),
      },
      {
        name: "foreign organization",
        mutateInput: (input) => ({
          ...input,
          actor: { ...input.actor, organizationId: "org_fedcba9876543210" },
          workspace: { ...input.workspace, organizationId: "org_fedcba9876543210" },
        }),
      },
      {
        name: "missing principal",
        configure: (fixture) => {
          fixture.principals.records.clear();
        },
      },
      {
        name: "foreign principal record",
        configure: (fixture) => {
          fixture.principals.returnForeign = true;
        },
      },
      {
        name: "disabled principal source",
        configure: (fixture) => {
          fixture.principals.current = false;
        },
      },
      {
        name: "principal removed before locked recheck",
        configure: (fixture) => {
          fixture.principals.removeAfterFirstResolve = true;
        },
      },
      {
        name: "throwing current callback",
        mutateInput: (input) => ({
          ...input,
          isCurrent: () => {
            throw new Error("stale");
          },
        }),
      },
      {
        name: "callback becomes stale before commit",
        mutateInput: (input) => {
          let reads = 0;
          return { ...input, isCurrent: () => ++reads < 3 };
        },
      },
    ];

    for (const denied of cases) {
      const fixture = await createFixture();
      denied.configure?.(fixture);
      const input = denied.mutateInput?.(transferInput()) ?? transferInput();
      await expect(
        transferWorkspaceOwnership(fixture.transfer, input),
        denied.name,
      ).resolves.toBeNull();
      const current = await fixture.registry.get("wks_transfer");
      expect(current?.ownerPrincipalId, denied.name).toBe(ownerPrincipalId);
      expect(current?.ownershipRevision, denied.name).toBeUndefined();
      expect(fixture.audit.calls, denied.name).toEqual([]);
      expect(fixture.writeCount(), denied.name).toBe(1);
    }
  });

  test("rejects mismatched finalized intent metadata without committing", async () => {
    const fixture = await createFixture();
    fixture.audit.returnMetadata = {
      phase: "intent",
      newOwnerPrincipalId: newPrincipalId,
      revision: "2",
    };

    await expect(transferWorkspaceOwnership(fixture.transfer, transferInput())).resolves.toBeNull();
    await expect(fixture.registry.get("wks_transfer")).resolves.toMatchObject({
      ownerPrincipalId,
    });
    expect(fixture.writeCount()).toBe(1);
    expect(fixture.audit.calls).toHaveLength(1);
  });

  test("audit and registry write failures leave the owner unchanged and write failures append failed audit", async () => {
    const auditFailure = await createFixture();
    auditFailure.audit.failAt = 1;
    await expect(
      transferWorkspaceOwnership(auditFailure.transfer, transferInput()),
    ).rejects.toThrow("audit-1");
    const afterAuditFailure = await auditFailure.registry.get("wks_transfer");
    expect(afterAuditFailure?.ownerPrincipalId).toBe(ownerPrincipalId);
    expect(afterAuditFailure?.ownershipRevision).toBeUndefined();
    expect(auditFailure.audit.calls).toEqual([]);

    const writeFailure = await createFixture({ failTransferWrite: true });
    await expect(
      transferWorkspaceOwnership(writeFailure.transfer, transferInput()),
    ).rejects.toThrow("workspace-write");
    const afterWriteFailure = await writeFailure.registry.get("wks_transfer");
    expect(afterWriteFailure?.ownerPrincipalId).toBe(ownerPrincipalId);
    expect(afterWriteFailure?.ownershipRevision).toBeUndefined();
    expect(writeFailure.audit.calls.map((call) => call.input.outcome)).toEqual([
      "allowed",
      "failed",
    ]);
    expect(writeFailure.audit.calls[1]).toEqual({
      input: expect.objectContaining({
        action: "enterprise.resource.ownership.transfer",
        outcome: "failed",
        reasonCode: "workspace_ownership_transfer_failed",
        metadata: expect.objectContaining({
          phase: "storage",
          newOwnerPrincipalId: newPrincipalId,
          revision: "1",
          intentEventId: "evt_workspace_transfer_1",
        }),
      }),
      options: { durability: "required" },
    });

    const failedAuditFailure = await createFixture({ failTransferWrite: true });
    failedAuditFailure.audit.failAt = 2;
    await expect(
      transferWorkspaceOwnership(failedAuditFailure.transfer, transferInput()),
    ).rejects.toThrow("Workspace ownership transfer and failed audit append rejected");
    await expect(failedAuditFailure.registry.get("wks_transfer")).resolves.toMatchObject({
      ownerPrincipalId,
    });
    expect(failedAuditFailure.audit.calls.map((call) => call.input.outcome)).toEqual(["allowed"]);
  });

  test("rejects structural adapters and closes without touching the registry or audit", async () => {
    const fixture = await createFixture();
    expect(
      createLocalWorkspaceTransfer({
        workspaceRegistry: {},
        audit: fixture.audit,
        principalSource: fixture.principals,
      }),
    ).toBeNull();
    expect(isWorkspaceTransfer({ transfer: async () => null, close() {} })).toBe(false);
    closeWorkspaceTransfer(fixture.transfer);
    await expect(transferWorkspaceOwnership(fixture.transfer, transferInput())).resolves.toBeNull();
    const current = await fixture.registry.get("wks_transfer");
    expect(current?.ownerPrincipalId).toBe(ownerPrincipalId);
    expect(current?.ownershipRevision).toBeUndefined();
    expect(fixture.audit.calls).toEqual([]);
  });
});

class RecordingAudit implements AuditSink {
  readonly calls: Array<{ input: AuditEventInput; options: AuditAppendOptions }> = [];
  failAt: number | null = null;
  returnMetadata: AuditEventInput["metadata"] | undefined;
  private attempts = 0;

  async append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent> {
    this.attempts += 1;
    if (this.failAt === this.attempts) throw new Error(`audit-${this.attempts}`);
    const eventInput = structuredClone(input);
    const event = AuditEventSchema.parse({
      ...eventInput,
      ...(this.returnMetadata === undefined
        ? {}
        : { metadata: structuredClone(this.returnMetadata) }),
      eventId: `evt_workspace_transfer_${this.attempts}`,
      occurredAt: `2026-09-11T00:00:0${this.attempts}.000Z`,
      nodeId,
      nodeEventSeq: this.attempts,
    });
    this.calls.push({ input: structuredClone(input), options: structuredClone(options) });
    return event;
  }
}

class Principals implements WorkspaceTransferPrincipalSource {
  readonly records = new Set([newPrincipalId]);
  current = true;
  returnForeign = false;
  removeAfterFirstResolve = false;
  private resolveCount = 0;

  async resolvePrincipal(principalId: string, requestedOrganizationId: string) {
    this.resolveCount += 1;
    if (!this.records.has(principalId)) return null;
    if (this.removeAfterFirstResolve && this.resolveCount === 1) {
      this.records.delete(principalId);
    }
    return {
      principalType: "human" as const,
      principalId,
      organizationId: this.returnForeign ? "org_fedcba9876543210" : requestedOrganizationId,
      grants: [],
      grantVersion: "grv_new_owner",
    };
  }

  isCurrent(): boolean {
    return this.current;
  }
}

async function createFixture(options: { failTransferWrite?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-workspace-transfer-"));
  roots.push(root);
  const filePath = path.join(root, "workspaces.json");
  let writes = 0;
  const registry = new FileBackedWorkspaceRegistry(filePath, createTestLogger(), {
    writeRecords: async (target, records) => {
      writes += 1;
      if (options.failTransferWrite && writes === 2) throw new Error("workspace-write");
      await writeJsonFileAtomic(target, records);
    },
  });
  await registry.initialize();
  await registry.upsert({
    ...createPersistedWorkspaceRecord({
      workspaceId: "wks_transfer",
      projectId: "prj_transfer",
      cwd: path.join(root, "workspace"),
      kind: "directory",
      displayName: "Transfer",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    }),
    organizationId,
    nodeId,
    ownerPrincipalId,
    createdByPrincipalId: ownerPrincipalId,
  });
  const audit = new RecordingAudit();
  const principals = new Principals();
  const transfer = createLocalWorkspaceTransfer({
    workspaceRegistry: registry,
    audit,
    principalSource: principals,
  });
  if (!transfer) throw new Error("expected WorkspaceTransfer");
  return { root, filePath, registry, audit, principals, transfer, writeCount: () => writes };
}

function transferInput(): WorkspaceTransferInput {
  return {
    actor,
    sessionId: "session_workspace_transfer",
    workspace: {
      workspaceId: "wks_transfer",
      organizationId,
      nodeId,
      ownerPrincipalId,
      createdByPrincipalId: ownerPrincipalId,
    },
    expectedOwnerPrincipalId: ownerPrincipalId,
    expectedRevision: "0",
    newPrincipalId,
    isCurrent: () => true,
  };
}
