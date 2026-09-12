import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import type { EnterpriseDispatchContext } from "../../session/enterprise-dispatcher.js";
import {
  createProductionAuditRuntime,
  type ProductionAuditCapability,
} from "../audit/production-audit-runtime.js";
import {
  createManagedIdentityDispatcherRegistration,
  type ManagedIdentityPrincipalSource,
} from "./identity-dispatcher.js";

const execFileAsync = promisify(execFile);
const organizationId = "org_0123456789abcdef" as const;
const principalId = "usr_0123456789abcdef" as const;
const node = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_managed_identity",
  mode: "managed" as const,
};

describe.runIf(process.platform === "darwin")("managed identity dispatcher", () => {
  test("projects the current managed principal's display name and controls from grants", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "managed-identity-dispatcher-"));
    let audit: ProductionAuditCapability | undefined;
    try {
      const addonPath = path.join(parent, "darwin-audit-fs.node");
      await execFileAsync(process.execPath, [
        fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
        "--output",
        addonPath,
      ]);
      audit = await createProductionAuditRuntime({
        node,
        auditRoot: path.join(parent, "audit"),
        nativeAddonPath: addonPath,
      });
      const source: ManagedIdentityPrincipalSource = {
        isCurrent: () => true,
        listPrincipalRecords: async () => [
          {
            principalType: "human",
            principalId,
            organizationId,
            displayName: "Platform Admin",
            status: "active",
            createdAt: "2026-09-12T00:00:00.000Z",
            updatedAt: "2026-09-12T00:00:00.000Z",
          },
        ],
      };
      const principal = {
        organizationId,
        principalType: "human" as const,
        principalId,
        credentialId: "cred_managed_identity",
        grantVersion: "grant_managed_identity",
        grants: [
          {
            action: "workspace.metadata.read" as const,
            selector: { kind: "organization" as const, organizationId },
          },
          {
            action: "workspace.manage" as const,
            selector: { kind: "organization" as const, organizationId },
          },
          {
            action: "identity.manage" as const,
            selector: { kind: "organization" as const, organizationId },
          },
        ],
      };
      const registration = createManagedIdentityDispatcherRegistration({ source, audit });
      const lease = registration.open({
        sessionId: "session_managed_identity",
        clientId: "client_managed_identity",
        context: { principal, node, sessionBindingGeneration: "generation_managed_identity" },
      });
      const sessionContext: EnterpriseDispatchContext = {
        sessionId: "session_managed_identity",
        clientId: "client_managed_identity",
        credentialId: principal.credentialId,
        sessionBindingGeneration: "generation_managed_identity",
        enterpriseContext: {
          principal,
          node,
          sessionBindingGeneration: "generation_managed_identity",
        },
      };

      await expect(
        lease.dispatcher.handle({
          sessionContext,
          message: { type: "enterprise.identity.get_current.request", requestId: "identity-1" },
        }),
      ).resolves.toEqual({
        type: "enterprise.identity.get_current.response",
        payload: {
          requestId: "identity-1",
          identity: {
            principalType: "human",
            principalId,
            organizationId,
            nodeId: node.nodeId,
            paseoServerId: node.paseoServerId,
            displayName: "Platform Admin",
            grantVersion: "grant_managed_identity",
            navigation: ["workspaces", "organization", "identity"],
            allowedOperations: [
              "workspace.create",
              "organization.resources.view",
              "identity.principals.view",
              "access.grants.view",
              "access.grants.manage",
              "identity.logout_all",
            ],
          },
        },
      });

      await lease.close();
    } finally {
      await audit?.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
