import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkspaceMembershipPolicy } from "@getpaseo/protocol/enterprise-collaboration";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { collabPaths } from "./collab-paths.js";
import { ManagedWorkspaceCatalog } from "./workspace-catalog.js";

const NODE_ID = "nod_0123456789abcdef";
const ORG_ID = "org_0123456789abcdef";
const OWNER = "usr_0123456789abcdef";
const MEMBER = "usr_fedcba9876543210";
const WORKSPACE_A = "cws_00000000000000aa";
const WORKSPACE_B = "cws_00000000000000bb";

let directory: string;
let clock: number;
let memberships: readonly WorkspaceMembershipPolicy[] | null;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "workspace-catalog-"));
  clock = Date.parse("2025-06-01T00:00:00.000Z");
  memberships = null;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function membership(workspaceUid: string, localWorkspaceId: string): WorkspaceMembershipPolicy {
  return {
    workspaceUid,
    localWorkspaceId,
    ownerPrincipalId: OWNER,
    membershipVersion: 2,
    members: [
      { principalId: OWNER, role: "owner" },
      { principalId: MEMBER, role: "editor" },
    ],
  };
}

function catalog(): ManagedWorkspaceCatalog {
  return new ManagedWorkspaceCatalog({
    paseoHome: directory,
    nodeId: NODE_ID,
    organizationId: ORG_ID,
    source: { currentWorkspaceMemberships: () => memberships },
    now: () => clock,
  });
}

describe("building the catalog", () => {
  test("leaves it alone on a node that does not collaborate", () => {
    // The plane omits the key entirely for those nodes (ADR-0033), which is null here.
    expect(catalog().refresh()).toBeNull();
  });

  test("lists what the plane says this node hosts", () => {
    memberships = [membership(WORKSPACE_A, "wks_a")];

    const result = catalog().refresh()!;

    expect(result.nodeId).toBe(NODE_ID);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      workspaceUid: WORKSPACE_A,
      localWorkspaceId: "wks_a",
      state: "active",
      remoteMissingAt: null,
    });
    expect(result.workspaces[0]!.members.map((entry) => entry.role).sort()).toEqual([
      "editor",
      "owner",
    ]);
  });
});

describe("a Workspace the plane stops listing", () => {
  test("is kept as remote_missing rather than forgotten", () => {
    const subject = catalog();
    memberships = [membership(WORKSPACE_A, "wks_a"), membership(WORKSPACE_B, "wks_b")];
    subject.refresh();

    clock += 60_000;
    memberships = [membership(WORKSPACE_A, "wks_a")];
    const result = subject.refresh()!;

    // Deleting it would leave an owner with no way to be told what happened to their Workspace.
    const missing = result.workspaces.find((entry) => entry.workspaceUid === WORKSPACE_B)!;
    expect(missing.state).toBe("remote_missing");
    expect(missing.remoteMissingAt).toBe("2025-06-01T00:01:00.000Z");
    expect(subject.activeWorkspaces().map((entry) => entry.workspaceUid)).toEqual([WORKSPACE_A]);
  });

  test("keeps the time it first went missing across later refreshes", () => {
    const subject = catalog();
    memberships = [membership(WORKSPACE_A, "wks_a"), membership(WORKSPACE_B, "wks_b")];
    subject.refresh();
    clock += 60_000;
    memberships = [membership(WORKSPACE_A, "wks_a")];
    subject.refresh();

    clock += 3_600_000;
    const result = subject.refresh()!;

    // Restamping it on every refresh would make "how long has it been gone" unanswerable.
    expect(
      result.workspaces.find((entry) => entry.workspaceUid === WORKSPACE_B)!.remoteMissingAt,
    ).toBe("2025-06-01T00:01:00.000Z");
  });
});

describe("an unreachable plane", () => {
  test("marks nothing missing", () => {
    const subject = catalog();
    memberships = [membership(WORKSPACE_A, "wks_a")];
    const before = subject.refresh()!;

    // A policy refresh that never landed leaves the memberships null. Master spec §5.1.8 lets
    // existing local work continue through a short outage, so an outage must not look like every
    // Workspace being unshared at once.
    memberships = null;
    const after = subject.refresh()!;

    expect(after).toEqual(before);
    expect(subject.activeWorkspaces()).toHaveLength(1);
  });
});

describe("surviving a restart", () => {
  test("loads the catalog the previous boot wrote", () => {
    memberships = [membership(WORKSPACE_A, "wks_a")];
    catalog().refresh();

    const restarted = catalog();
    const loaded = restarted.load()!;

    expect(loaded.workspaces.map((entry) => entry.workspaceUid)).toEqual([WORKSPACE_A]);
    expect(restarted.activeWorkspaces()).toHaveLength(1);
  });

  test("refuses a catalog another node wrote", () => {
    memberships = [membership(WORKSPACE_A, "wks_a")];
    catalog().refresh();

    const other = new ManagedWorkspaceCatalog({
      paseoHome: directory,
      nodeId: "nod_fedcba9876543210",
      organizationId: ORG_ID,
      source: { currentWorkspaceMemberships: () => null },
      now: () => clock,
    });

    // A node must never serve another node's tenants because a file was left behind.
    expect(other.load()).toBeNull();
  });

  test("treats an unreadable file as no catalog rather than refusing to start", () => {
    const paths = collabPaths(directory);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.catalog, "{ not json");

    expect(catalog().load()).toBeNull();
  });
});
