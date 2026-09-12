import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";
import { SessionAuthorization } from "../../authorization/index.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  bindEnterpriseAdmissionSession,
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
} from "../identity/admission-authorization.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";
import {
  resolveAuthoritativeAgent,
  resolveCurrentProductionRuntimeAuthority,
} from "./production-runtime-authority.js";

const execFileAsync = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_runtime_authority",
  mode: "standalone",
};
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_runtime_authority",
  grantVersion: "grv_1",
  grants: [],
};

describe("production runtime authority seam", () => {
  test("rejects structural and foreign authority inputs without inspection", () => {
    expect(resolveCurrentProductionRuntimeAuthority({}, {})).toBeNull();
    expect(resolveAuthoritativeAgent({}, "agent_a")).toBeNull();
    const runtime = new Proxy(
      {},
      {
        get() {
          throw new Error("foreign runtime inspected");
        },
      },
    );
    expect(resolveCurrentProductionRuntimeAuthority(runtime, {})).toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "returns current resource authorization and exact provider-owned agent",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-runtime-authority-"));
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
        expect(provider).not.toBeNull();
        if (!provider) throw new Error("expected provider");
        await provider.grantStore.update({
          organizationId: principal.organizationId,
          principalId: principal.principalId,
          expectedVersion: null,
          grants: [],
          actor: principal,
        });
        const record = await provider.grantStore.get(principal.principalId);
        if (!record) throw new Error("expected grant record");
        const secret = Object.freeze({});
        const issuer = createEnterpriseAdmissionAuthorizationIssuer(secret);
        const evidence = issueEnterpriseAdmissionEvidence(
          issuer,
          secret,
          { ...principal, grantVersion: record.grantVersion },
          node,
          { node, transport: "direct", peer: "loopback" },
        );
        const handle = evidence
          ? bindEnterpriseAdmissionSession(issuer, evidence, "client-authority")
          : null;
        expect(handle).not.toBeNull();
        if (!handle) throw new Error("expected handle");
        provider.owners.registerWorkspace({
          id: "workspace-a",
          organizationId: principal.organizationId,
          nodeId: node.nodeId,
          ownerPrincipalId: principal.principalId,
          createdByPrincipalId: principal.principalId,
        });
        provider.owners.registerAgent({
          id: "agent-a",
          workspaceId: "workspace-a",
          organizationId: principal.organizationId,
          nodeId: node.nodeId,
          ownerPrincipalId: principal.principalId,
          createdByPrincipalId: principal.principalId,
        });
        const runtime = await createProductionAuthorizationRuntimeForSession(provider, {
          admissionAuthorizationIssuer: issuer,
          admissionAuthorizationHandle: handle,
          sessionAuthorization: new SessionAuthorization(["workspace.read"]),
          sessionId: "session-authority",
          authorityState: {
            async consumeAuthorizedRequest() {
              return null;
            },
            async resolveCurrentSessionBinding() {
              return null;
            },
            async register() {
              return null;
            },
            async resolveOpen() {
              return null;
            },
            async mintFreshReceipt() {
              return null;
            },
            async burnFreshReceipts() {},
            async close() {},
          },
        });
        expect(runtime).not.toBeNull();
        if (!runtime) throw new Error("expected runtime");
        const authority = resolveCurrentProductionRuntimeAuthority(runtime, provider);
        expect(authority).not.toBeNull();
        if (!authority) throw new Error("expected authority");
        expect(resolveAuthoritativeAgent(authority.owners, "agent-a")).toMatchObject({
          agentId: "agent-a",
          workspaceId: "workspace-a",
        });
        expect(resolveAuthoritativeAgent(authority.owners, "missing")).toBeNull();
        await runtime.release();
        expect(resolveAuthoritativeAgent(authority.owners, "agent-a")).toBeNull();
      } finally {
        await audit.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
