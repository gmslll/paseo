import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext, ResourceGrant } from "@getpaseo/protocol/messages";
import { SessionAuthorization } from "../../authorization/index.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  bindEnterpriseAdmissionSession,
} from "../identity/admission-authorization.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

export const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_factory",
  mode: "standalone",
};
export const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_factory",
  grantVersion: "grv_1",
  grants: [],
};
export class EmptyAuthorityState {
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
const execFileAsync = promisify(execFile);
let root = "";
let audit: Awaited<ReturnType<typeof createProductionAuditRuntime>> | undefined;
const secret = Object.freeze({});
export async function createProductionRuntimeFixture(
  name: string,
  options: { readonly grants?: readonly ResourceGrant[] } = {},
) {
  if (!audit) {
    root = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-fixture-"));
    const addon = path.join(root, "audit.node");
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
      "--output",
      addon,
    ]);
    audit = await createProductionAuditRuntime({
      node,
      auditRoot: path.join(root, "audit"),
      nativeAddonPath: addon,
    });
  }
  const provider = createProductionAuthorizationRuntimeProvider({
    audit,
    grantFilePath: path.join(root, `${name}.json`),
  });
  if (!provider) throw new Error("provider");
  const workspaceId = "wks_0123456789abcdef";
  const grants: readonly ResourceGrant[] = options.grants ?? [
    {
      action: "workspace.content.read" as const,
      selector: { kind: "workspace" as const, workspaceIds: [workspaceId] },
    },
  ];
  await provider.grantStore.update({
    organizationId: principal.organizationId,
    principalId: principal.principalId,
    expectedVersion: null,
    grants,
    actor: principal,
  });
  const record = await provider.grantStore.get(principal.principalId);
  if (!record) throw new Error("grant");
  provider.owners.registerWorkspace({
    id: workspaceId,
    organizationId: principal.organizationId,
    nodeId: node.nodeId,
    ownerPrincipalId: principal.principalId,
    createdByPrincipalId: principal.principalId,
  });
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(secret);
  const evidence = issueEnterpriseAdmissionEvidence(
    issuer,
    secret,
    { ...principal, grantVersion: record.grantVersion, grants: record.grants },
    node,
    { node, transport: "direct", peer: "loopback" },
  );
  const handle = evidence && bindEnterpriseAdmissionSession(issuer, evidence, `client-${name}`);
  const runtime =
    handle &&
    (await createProductionAuthorizationRuntimeForSession(provider, {
      admissionAuthorizationIssuer: issuer,
      admissionAuthorizationHandle: handle,
      sessionAuthorization: new SessionAuthorization(["workspace.read"]),
      sessionId: `session-${name}`,
      authorityState: new EmptyAuthorityState(),
    }));
  if (!runtime) throw new Error("runtime");
  return {
    provider,
    runtime,
    audit,
    context: {
      sessionId: runtime.binding.sessionId,
      clientId: runtime.binding.clientId,
      credentialId: runtime.principal.credentialId,
      sessionBindingGeneration: runtime.binding.sessionBindingGeneration,
      enterpriseContext: {
        principal: runtime.principal,
        node: runtime.node,
        sessionBindingGeneration: runtime.binding.sessionBindingGeneration,
      },
    },
  };
}
export async function closeProductionRuntimeFixture() {
  if (audit) await audit.close();
  if (root) await rm(root, { recursive: true, force: true });
  audit = undefined;
  root = "";
}
