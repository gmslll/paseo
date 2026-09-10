import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NodeContext, PrincipalContext } from "@getpaseo/protocol/messages";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SessionAuthorization } from "../../authorization/index.js";
import { createProductionAuditRuntime } from "../audit/production-audit-runtime.js";
import {
  createEnterpriseAdmissionAuthorizationIssuer,
  issueEnterpriseAdmissionEvidence,
  bindEnterpriseAdmissionSession,
} from "../identity/admission-authorization.js";
import {
  createEnterpriseResourceDispatcherFactory,
  openEnterpriseResourceDispatcher,
} from "./enterprise-resource-dispatcher-factory.js";
import {
  createProductionAuthorizationRuntimeForSession,
  createProductionAuthorizationRuntimeProvider,
} from "./production-authorization-runtime-provider.js";

const execFileAsync = promisify(execFile);
const node: NodeContext = {
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "srv_factory",
  mode: "standalone",
};
const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "cred_factory",
  grantVersion: "grv_1",
  grants: [],
};

let parent = "";
let addonPath = "";
let audit: Awaited<ReturnType<typeof createProductionAuditRuntime>>;

class EmptyAuthorityState {
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

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  parent = await mkdtemp(path.join(os.tmpdir(), "paseo-w2-resource-factory-"));
  addonPath = path.join(parent, "darwin-audit-fs.node");
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
});

afterAll(async () => {
  await audit?.close();
  if (parent) await rm(parent, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("enterprise resource dispatcher factory", () => {
  test("requires both production sources and publishes the exact W3 manifest", async () => {
    const fixture = await createFixture("manifest");
    const placement = { resolveWorkspace: async () => null };
    const source = { list: async () => ({ principals: [], resources: [], nextCursor: null }) };
    const factory = createEnterpriseResourceDispatcherFactory({
      provider: fixture.provider,
      placement,
      organizationResources: source,
    });
    expect(factory).not.toBeNull();
    expect(factory?.manifest.operations).toEqual([
      "enterprise.access.list_grants.request",
      "enterprise.access.update_grants.request",
      "enterprise.organization.list_resources.request",
      "enterprise.placement.resolve_workspace.request",
    ]);
    expect(
      createEnterpriseResourceDispatcherFactory({
        provider: fixture.provider,
        placement,
        organizationResources: undefined,
      }),
    ).toBeNull();
    await fixture.runtime.release();
  });

  test("opens only for the provider's current runtime and closes the lease", async () => {
    const fixture = await createFixture("open");
    const factory = createEnterpriseResourceDispatcherFactory({
      provider: fixture.provider,
      placement: { resolveWorkspace: async () => null },
      organizationResources: {
        list: async () => ({ principals: [], resources: [], nextCursor: null }),
      },
    });
    expect(factory).not.toBeNull();
    const lease = factory?.open({
      sessionId: "session-open",
      clientId: "client-open",
      context: {} as never,
      authorizationRuntime: fixture.runtime,
    });
    expect(lease).toBeDefined();
    expect(
      lease?.dispatcher.requestPolicyForType("enterprise.organization.list_resources.request"),
    ).toBe("resources");
    await lease?.close();
    expect(
      lease?.dispatcher.requestPolicyForType("enterprise.organization.list_resources.request"),
    ).toBeNull();
    await fixture.runtime.release();
  });

  test("rejects structural providers and foreign runtimes without touching authority fields", async () => {
    const fixture = await createFixture("foreign");
    let touched = 0;
    const factory = createEnterpriseResourceDispatcherFactory({
      provider: { grantStore: {}, owners: {} },
      placement: { resolveWorkspace: async () => null },
      organizationResources: {
        list: async () => ({ principals: [], resources: [], nextCursor: null }),
      },
    });
    expect(factory).toBeNull();
    const foreignRuntime = new Proxy(
      {},
      {
        get() {
          touched += 1;
          throw new Error("foreign runtime touched");
        },
      },
    );
    expect(openEnterpriseResourceDispatcher(factory, foreignRuntime)).toBeNull();
    expect(touched).toBe(0);
    await fixture.runtime.release();
  });
});

async function createFixture(name: string) {
  const provider = createProductionAuthorizationRuntimeProvider({
    audit,
    grantFilePath: path.join(parent, `${name}.json`),
  });
  if (!provider) throw new Error("expected provider");
  const actor = { ...principal, grants: [] };
  await provider.grantStore.update({
    organizationId: principal.organizationId,
    principalId: principal.principalId,
    expectedVersion: null,
    grants: [],
    actor,
  });
  const record = await provider.grantStore.get(principal.principalId);
  if (!record) throw new Error("expected grant record");
  const admittedPrincipal = { ...principal, grantVersion: record.grantVersion };
  const mintSecret = Object.freeze({});
  const issuer = createEnterpriseAdmissionAuthorizationIssuer(mintSecret);
  const evidence = issueEnterpriseAdmissionEvidence(issuer, mintSecret, admittedPrincipal, node, {
    node,
    transport: "direct",
    peer: "loopback",
  });
  if (!evidence) throw new Error("expected evidence");
  const handle = bindEnterpriseAdmissionSession(issuer, evidence, `client-${name}`);
  if (!handle) throw new Error("expected handle");
  const runtime = await createProductionAuthorizationRuntimeForSession(provider, {
    admissionAuthorizationIssuer: issuer,
    admissionAuthorizationHandle: handle,
    sessionAuthorization: new SessionAuthorization(["workspace.read"]),
    sessionId: `session-${name}`,
    authorityState: new EmptyAuthorityState(),
  });
  if (!runtime) throw new Error("expected runtime");
  return { provider, runtime };
}
