import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import { createProductionAuthorizationRuntimeProvider } from "./production-authorization-runtime-provider.js";
import {
  bindProductionAgentOwners,
  isProductionAgentOwnerBinder,
} from "./production-agent-owner-binder.js";
import { getAuthoritativeAgent } from "./owner-registry.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";

const execFileAsync = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_agent_binder",
  mode: "standalone",
};
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_agent_binder",
  grantVersion: "grv_1",
  grants: [],
};

function record(overrides: Record<string, unknown> = {}): StoredAgentRecord {
  return {
    id: "agent-a",
    nodeId: node.nodeId,
    workspaceId: "workspace-a",
    organizationId: principal.organizationId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
    ...overrides,
  } as StoredAgentRecord;
}

describe("production agent owner binder", () => {
  test("rejects structural provider and malformed records", () => {
    expect(
      bindProductionAgentOwners({
        provider: { grantStore: {}, owners: {} },
        records: [record()],
        nodeId: node.nodeId,
      }),
    ).toBeNull();
    expect(
      bindProductionAgentOwners({
        provider: { grantStore: {}, owners: {} },
        records: [{}],
        nodeId: node.nodeId,
      }),
    ).toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "binds initial/persisted agents, preserves quarantine, and fails closed when stale",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-agent-binder-"));
      const addonPath = path.join(root, "darwin-audit-fs.node");
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
      const audit = await createProductionAuditRuntime({
        node,
        auditRoot: path.join(root, "audit"),
        nativeAddonPath: addonPath,
      });
      try {
        const provider = createProductionAuthorizationRuntimeProvider({
          audit,
          grantFilePath: path.join(root, "grants.json"),
        });
        if (!provider) throw new Error("expected provider");
        await provider.grantStore.update({
          organizationId: principal.organizationId,
          principalId: principal.principalId,
          expectedVersion: null,
          grants: [],
          actor: principal,
        });
        provider.owners.registerWorkspace({
          id: "workspace-a",
          organizationId: principal.organizationId,
          nodeId: node.nodeId,
          ownerPrincipalId: principal.principalId,
          createdByPrincipalId: principal.principalId,
        });
        const binder = bindProductionAgentOwners({
          provider,
          records: [record()],
          nodeId: node.nodeId,
        });
        expect(binder).not.toBeNull();
        expect(isProductionAgentOwnerBinder(binder)).toBe(true);
        expect(getAuthoritativeAgent(provider.owners, "agent-a")).not.toBeNull();
        expect(binder?.onPersisted(record({ id: "agent-b" }))).toBe(true);
        expect(getAuthoritativeAgent(provider.owners, "agent-b")).not.toBeNull();
        expect(
          binder?.onPersisted(record({ id: "agent-foreign", nodeId: "nod_abcdefabcdefabcd" })),
        ).toBe(false);
        expect(
          binder?.onPersisted(record({ id: "agent-mismatch", workspaceId: "workspace-missing" })),
        ).toBe(true);
        expect(provider.owners.quarantined()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "agent", id: "agent-mismatch" }),
          ]),
        );
        await audit.close();
        expect(binder?.onPersisted(record({ id: "agent-after-revoke" }))).toBe(false);
      } finally {
        await audit.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
