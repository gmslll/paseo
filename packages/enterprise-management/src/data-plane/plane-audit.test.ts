import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  EnterpriseManagementPlane,
  PLANE_AUDIT_NODE_ID,
  type AuthenticatedManagementPrincipal,
  type ManagementAuditRecord,
} from "../management-plane.js";
import { openSqliteDatabase } from "../sqlite.js";

const ORG = "org_0123456789abcdef";

interface Harness {
  plane: EnterpriseManagementPlane;
  admin: AuthenticatedManagementPrincipal;
  memberPrincipalId: string;
  workspaceUid: string;
  databasePath: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/**
 * A file database, not `:memory:`, because one test opens a second connection to the same file to
 * make an audit append collide. Nothing else here depends on it.
 */
async function start(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plane-audit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "plane.sqlite3");
  const ticketKeys = generateKeyPairSync("ed25519");
  const plane = new EnterpriseManagementPlane({
    databasePath,
    organizationId: ORG,
    organizationName: "Plane audit test",
    issuer: "https://management.test:17443",
    bootstrapSecret: "bootstrap-secret-for-plane-audit",
    ticketPrivateKey: ticketKeys.privateKey,
    ticketPublicKey: ticketKeys.publicKey,
  });
  cleanups.push(() => plane.close());

  const bootstrap = await plane.bootstrapAdministrator({
    bootstrapSecret: "bootstrap-secret-for-plane-audit",
    displayName: "Admin",
  });
  const admin = (await plane.authenticatePersonalAccessToken(bootstrap.token))!;
  const ownerPrincipal = await plane.createPrincipal(admin, {
    displayName: "Owner",
    principalType: "human",
    role: "employee",
  });
  const memberPrincipal = await plane.createPrincipal(admin, {
    displayName: "Member",
    principalType: "human",
    role: "employee",
  });
  const workspace = await plane.registerCollabWorkspace(admin, {
    localWorkspaceId: "wks_plane_audit",
    ownerPrincipalId: ownerPrincipal.principalId,
  });

  return {
    plane,
    admin,
    memberPrincipalId: memberPrincipal.principalId,
    workspaceUid: workspace.workspaceUid,
    databasePath,
  };
}

async function auditFor(harness: Harness, action: string): Promise<ManagementAuditRecord[]> {
  const events = await harness.plane.listAudit(harness.admin, 500);
  return events.filter((event) => event.action === action);
}

describe("plane-origin audit", () => {
  test("records a role change under the reserved plane node", async () => {
    const harness = await start();

    await harness.plane.setCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
      role: "editor",
    });

    const [event] = await auditFor(harness, "collab.member.set");
    expect(event).toBeDefined();
    // ADR-0037: the plane is not a node, so its events hang off one reserved row.
    expect(event!.nodeId).toBe(PLANE_AUDIT_NODE_ID);
    expect(event!.resourceId).toBe(harness.workspaceUid);
    expect(event!.actorPrincipalId).toBe(harness.admin.principalId);
    expect(event!.metadata).toEqual({ principalId: harness.memberPrincipalId, role: "editor" });
  });

  test("records a removal and a collaboration switch", async () => {
    const harness = await start();
    await harness.plane.setCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
      role: "editor",
    });

    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: harness.workspaceUid,
      enabled: true,
    });
    await harness.plane.removeCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
    });
    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: harness.workspaceUid,
      enabled: false,
    });

    expect(await auditFor(harness, "collab.workspace.enable")).toHaveLength(1);
    expect(await auditFor(harness, "collab.workspace.disable")).toHaveLength(1);
    const [removal] = await auditFor(harness, "collab.member.remove");
    expect(removal!.metadata).toEqual({ principalId: harness.memberPrincipalId });
  });

  test("keeps every sequence number, so the plane's own log has no gaps", async () => {
    const harness = await start();
    await harness.plane.setCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
      role: "editor",
    });
    await harness.plane.setCollabCollaboration(harness.admin, {
      workspaceUid: harness.workspaceUid,
      enabled: true,
    });

    expect(harness.plane.auditLastSequence(PLANE_AUDIT_NODE_ID)).toBe(2);
    const events = (await harness.plane.listAudit(harness.admin, 500)).filter(
      (event) => event.nodeId === PLANE_AUDIT_NODE_ID,
    );
    expect(events.map((event) => event.nodeEventSeq).sort()).toEqual([1, 2]);
  });

  test("denies the operation when a required audit append fails", async () => {
    const harness = await start();
    const taken = harness.plane.auditLastSequence(PLANE_AUDIT_NODE_ID) + 1;

    // Occupy the sequence the next append will claim, without moving audit_node_state, so the
    // plane's own insert collides on UNIQUE (node_id, node_event_seq). A second connection is the
    // only way to arrange this without a seam in the plane itself.
    const raw = openSqliteDatabase(harness.databasePath);
    raw
      .prepare(
        "INSERT INTO audit_events (event_id, organization_id, node_id, node_event_seq, occurred_at, action, outcome, actor_principal_id, resource_kind, resource_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "evt_squatter",
        ORG,
        PLANE_AUDIT_NODE_ID,
        taken,
        new Date().toISOString(),
        "test.squatter",
        "allowed",
        harness.admin.principalId,
        "workspace",
        harness.workspaceUid,
        "{}",
      );
    raw.close();

    await expect(
      harness.plane.setCollabMember(harness.admin, {
        workspaceUid: harness.workspaceUid,
        principalId: harness.memberPrincipalId,
        role: "editor",
      }),
    ).rejects.toThrow();

    // ADR-0037: a failed required append denies the operation. The membership must not exist, or
    // the change happened unrecorded — which is the thing required durability is meant to prevent.
    const members = await harness.plane.listCollabMembers(harness.admin, harness.workspaceUid);
    expect(members.some((member) => member.principalId === harness.memberPrincipalId)).toBe(false);
  });

  test("keeps the reserved node out of the node list and out of reach", async () => {
    const harness = await start();

    const nodes = await harness.plane.listNodes(harness.admin);
    expect(nodes.some((node) => node.nodeId === PLANE_AUDIT_NODE_ID)).toBe(false);

    // Naming it directly is refused the same way a missing node is, so it cannot be turned into a
    // machine that looks available, nor discovered by probing.
    await expect(
      harness.plane.setNodeStatus(harness.admin, PLANE_AUDIT_NODE_ID, "active"),
    ).rejects.toThrow("node unavailable");
    await expect(harness.plane.ingestAuditEvents(PLANE_AUDIT_NODE_ID, [])).rejects.toThrow(
      "node unavailable",
    );
  });

  test("records identifiers only, never bodies or credentials", async () => {
    const harness = await start();
    await harness.plane.setCollabMember(harness.admin, {
      workspaceUid: harness.workspaceUid,
      principalId: harness.memberPrincipalId,
      role: "editor",
    });

    const events = (await harness.plane.listAudit(harness.admin, 500)).filter(
      (event) => event.nodeId === PLANE_AUDIT_NODE_ID,
    );
    // ADR-0037: no prompt bodies, document bytes, file contents, tokens, or cookies.
    for (const event of events) {
      expect(Object.keys(event.metadata).sort()).toEqual(["principalId", "role"]);
    }
  });
});
