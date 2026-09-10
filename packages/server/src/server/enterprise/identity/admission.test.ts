import { mkdtemp } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hash } from "bcryptjs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { EnterpriseAdmission } from "./admission.js";
import type { ProductionAuditCapability } from "../audit/production-audit-runtime.js";
import { productionAuditCapabilityIssuer } from "../audit/production-audit-runtime.js";
import {
  isCurrentEnterpriseAdmissionAuthorization,
  resolveCurrentEnterpriseAdmissionAuthorization,
} from "./admission-authorization.js";
import { nodeIdentityRegistryFs } from "./fs-port.js";
interface AuthStub {
  authenticateBearer: (token: string, context: unknown) => Promise<unknown>;
}
interface GuardStub {
  isCurrentPrincipalContext: (value: unknown) => Promise<boolean>;
}

const node = { nodeId: "nod_0123456789abcdef", paseoServerId: "srv", mode: "standalone" as const };
const executeFile = promisify(execFile);
let buildDirectory: string;
let addonPath: string;
const issuedCapabilities = new Set<ProductionAuditCapability>();
const caseDirectories = new Set<string>();
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  buildDirectory = await mkdtemp(path.join(os.tmpdir(), "admission-addon-"));
  addonPath = path.join(buildDirectory, "darwin-audit-fs.node");
  await executeFile(process.execPath, [
    fileURLToPath(new URL("../audit/native/build-darwin-audit-fs.mjs", import.meta.url)),
    "--output",
    addonPath,
  ]);
});

test("structural fake proxy reads only audit", () => {
  const reads: string[] = [];
  const fake = { append: async () => ({}) };
  const options = new Proxy(
    { ...base(fake as unknown as ProductionAuditCapability) },
    {
      get(target, key, receiver) {
        reads.push(String(key));
        if (key !== "audit") throw new Error("unexpected read");
        return key === "audit" ? fake : Reflect.get(target, key, receiver);
      },
    },
  );
  expect(() => new EnterpriseAdmission(options as never)).toThrow(
    "current runtime-issued production audit capability required",
  );
  expect(reads).toEqual(["audit"]);
});
afterEach(async () => {
  for (const capability of issuedCapabilities) await capability.close().catch(() => undefined);
  issuedCapabilities.clear();
  for (const dir of caseDirectories) await rm(dir, { recursive: true, force: true });
  caseDirectories.clear();
});
afterAll(async () => {
  if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
});
async function issueAudit(parent: string): Promise<ProductionAuditCapability> {
  if (process.platform !== "darwin") throw new Error("Darwin audit capability unavailable");
  const capability = await productionAuditCapabilityIssuer.issue({
    node,
    auditRoot: path.join(parent, "audit"),
    nativeAddonPath: addonPath,
  });
  issuedCapabilities.add(capability);
  caseDirectories.add(parent);
  return capability;
}
const base = (audit: ProductionAuditCapability) => ({
  filePath: path.join(os.tmpdir(), "admission.json"),
  principalSource: { resolvePrincipal: async () => null },
  node,
  audit,
  invalidation: { publish: async () => {} },
  organizationId: "org_0123456789abcdef",
});

describe("EnterpriseAdmission", () => {
  test("rejects non-release-ready audit before registry construction", () => {
    const calls = { mkdir: 0, open: 0, read: 0 };
    const fs = {
      ...nodeIdentityRegistryFs,
      mkdir: (...args: Parameters<typeof nodeIdentityRegistryFs.mkdir>) => {
        calls.mkdir++;
        return nodeIdentityRegistryFs.mkdir(...args);
      },
      open: (...args: Parameters<typeof nodeIdentityRegistryFs.open>) => {
        calls.open++;
        return nodeIdentityRegistryFs.open(...args);
      },
      read: (...args: Parameters<typeof nodeIdentityRegistryFs.read>) => {
        calls.read++;
        return nodeIdentityRegistryFs.read(...args);
      },
    };
    expect(
      () =>
        new EnterpriseAdmission({ ...base({ append: async () => ({}), releaseReady: false }), fs }),
    ).toThrow("current runtime-issued production audit capability required");
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0 });
  });
});

describe.runIf(process.platform === "darwin")("EnterpriseAdmission with production audit", () => {
  test("invalid node and organization reject before wrapped fs calls", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const calls = { mkdir: 0, open: 0, read: 0 };
    const fs = {
      ...nodeIdentityRegistryFs,
      mkdir: (...a: Parameters<typeof nodeIdentityRegistryFs.mkdir>) => {
        calls.mkdir++;
        return nodeIdentityRegistryFs.mkdir(...a);
      },
      open: (...a: Parameters<typeof nodeIdentityRegistryFs.open>) => {
        calls.open++;
        return nodeIdentityRegistryFs.open(...a);
      },
      read: (...a: Parameters<typeof nodeIdentityRegistryFs.read>) => {
        calls.read++;
        return nodeIdentityRegistryFs.read(...a);
      },
    };
    expect(
      () =>
        new EnterpriseAdmission({
          ...base(audit),
          fs,
          node: { ...node, nodeId: "bad" } as never,
        }),
    ).toThrow();
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0 });
    calls.mkdir = 0;
    calls.open = 0;
    calls.read = 0;
    expect(
      () =>
        new EnterpriseAdmission({
          ...base(audit),
          fs,
          organizationId: "bad",
        }),
    ).toThrow();
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0 });
  });

  test("accepts release-ready audit and rejects invalid connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
    });
    await expect(
      admission.authenticate("bad", {
        node: { ...node, nodeId: "bad" },
        transport: "direct",
        peer: "loopback",
      } as never),
    ).resolves.toBeNull();
  });

  test("guard false denies PAT and returned context is deeply frozen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
    });
    const principal = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [
        { action: "workspace.content.read", selector: { kind: "workspace", workspaceIds: ["w"] } },
      ],
    } as const;
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => principal;
    (admission.registry as unknown as GuardStub).isCurrentPrincipalContext = async () => false;
    await expect(
      admission.authenticate("token", { node, transport: "direct", peer: "loopback" }),
    ).resolves.toBeNull();
    (admission.registry as unknown as GuardStub).isCurrentPrincipalContext = async () => true;
    await expect(
      admission.authenticate("token", { node, transport: "direct", peer: "loopback" }),
    ).resolves.toEqual(principal);
    const returned = await admission.authenticate("token", {
      node,
      transport: "direct",
      peer: "loopback",
    });
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned?.grants)).toBe(true);
    expect(Object.isFrozen(returned?.grants[0]?.selector)).toBe(true);
    expect(() => {
      (returned!.grants[0]!.selector as { workspaceIds: string[] }).workspaceIds.push("x");
    }).toThrow();
  });

  test.each([
    ["direct", "loopback", true],
    ["direct", "local_ipc", true],
    ["relay", "loopback", false],
    ["hub", "local_ipc", false],
    ["direct", "external", false],
  ])("real bcrypt break-glass %s/%s", async (transport, peer, allowed) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-bg-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
      daemonPassword: await hash("pw", 4),
    });
    const local = await admission.authenticate("pw", {
      node,
      transport: transport as "direct" | "relay" | "hub",
      peer: peer as "loopback" | "local_ipc" | "external",
    });
    expect(Boolean(local)).toBe(allowed);
    if (!local) return;
    expect(
      await admission.authenticator.isCurrentPrincipalContext({
        ...local!,
        grants: local!.grants.map((grant) =>
          Object.assign({}, grant, { action: "workspace.write" as const }),
        ),
      }),
    ).toBe(false);
    expect(
      await admission.authenticator.isCurrentPrincipalContext({ ...local, credentialId: "old" }),
    ).toBe(false);
    expect(
      await admission.authenticator.isCurrentPrincipalContext({ ...local, grantVersion: "old" }),
    ).toBe(false);
  });

  test("authentication receives a call-time immutable connection snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-snapshot-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
    });
    let seen: unknown;
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blockGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async (
      _token,
      context,
    ) => {
      seen = context;
      entered();
      await blockGate;
      return null;
    };
    const context = {
      node: { ...node },
      transport: "direct" as const,
      peer: "loopback" as const,
      remoteAddress: "127.0.0.1",
      origin: "https://x",
      userAgent: "ua",
    };
    const pending = admission.authenticate("token", context);
    await enteredGate;
    context.node.nodeId = "nod_aaaaaaaaaaaaaaaa";
    context.node.paseoServerId = "mutated";
    context.node.mode = "managed";
    context.transport = "relay";
    context.peer = "external";
    context.remoteAddress = "mutated";
    context.origin = "mutated";
    context.userAgent = "mutated";
    release();
    await expect(pending).resolves.toBeNull();
    expect((seen as { node: { nodeId: string } }).node.nodeId).toBe(node.nodeId);
    const captured = seen as typeof context;
    expect(captured.node.paseoServerId).toBe("srv");
    expect(captured.node.mode).toBe("standalone");
    expect(captured.transport).toBe("direct");
    expect(captured.peer).toBe("loopback");
    expect(captured.remoteAddress).toBe("127.0.0.1");
    expect(captured.origin).toBe("https://x");
    expect(captured.userAgent).toBe("ua");
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen((seen as { node: object }).node)).toBe(true);
    expect(() => {
      (captured.node as { nodeId: string }).nodeId = "x";
    }).toThrow();
    expect(() => {
      (captured as { transport: string }).transport = "relay";
    }).toThrow();
  });

  test("authenticateEvidence keeps a frozen context across deferred caller mutation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-evidence-context-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
    });
    const principal = {
      principalType: "human" as const,
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [],
    };
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => {
      entered();
      await gate;
      return principal;
    };
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async () => true;
    const context = { node: { ...node }, transport: "direct" as const, peer: "loopback" as const };
    const pending = admission.authenticateEvidence("token", context);
    await started;
    context.node.nodeId = "mutated";
    (context as { cycle?: unknown }).cycle = context;
    release();
    const evidence = await pending;
    expect(evidence).not.toBeNull();
    expect(admission.bindSession(evidence!, "client")).not.toBeNull();
  });

  test("deferred guard snapshots principal and rejects malformed raw", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-deferred-"));
    const admission = new EnterpriseAdmission({
      ...base(await issueAudit(root)),
      filePath: path.join(root, "credentials.json"),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const source = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [
        {
          action: "workspace.content.read" as const,
          selector: { kind: "workspace" as const, workspaceIds: ["w"] },
        },
      ],
    };
    let guardValue: unknown;
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => source;
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async (value) => {
      guardValue = value;
      started();
      await gate;
      return true;
    };
    const pending = admission.authenticate("token", {
      node,
      transport: "direct",
      peer: "loopback",
    });
    await guardStarted;
    source.grants[0]!.selector.workspaceIds[0] = "mutated";
    source.principalId = "usr_aaaaaaaaaaaaaaaa";
    source.credentialId = "cred_aaaaaaaaaaaaaaaaaaaaaaaa";
    source.grantVersion = "mutated";
    source.grants[0]!.action = "workspace.write";
    source.grants[0]!.selector = { kind: "self" };
    source.grants.push(source.grants[0]!);
    release();
    const result = await pending;
    expect((guardValue as typeof source).grants[0]!.selector.workspaceIds[0]).toBe("w");
    expect((guardValue as typeof source).principalId).toBe("usr_0123456789abcdef");
    expect((guardValue as typeof source).grantVersion).toBe("1");
    expect((guardValue as typeof source).credentialId).toBe("cred_0123456789abcdef01234567");
    expect((guardValue as typeof source).grants).toHaveLength(1);
    expect((guardValue as typeof source).grants[0]!.action).toBe("workspace.content.read");
    expect((guardValue as typeof source).grants[0]!.selector.kind).toBe("workspace");
    expect(Object.isFrozen(guardValue)).toBe(true);
    expect(Object.isFrozen((guardValue as typeof source).grants)).toBe(true);
    expect(Object.isFrozen((guardValue as typeof source).grants[0])).toBe(true);
    expect(Object.isFrozen((guardValue as typeof source).grants[0]!.selector)).toBe(true);
    expect(Object.isFrozen((guardValue as typeof source).grants[0]!.selector.workspaceIds)).toBe(
      true,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.grants)).toBe(true);
    expect(Object.isFrozen(result!.grants[0])).toBe(true);
    expect(Object.isFrozen(result!.grants[0]!.selector)).toBe(true);
    expect(Object.isFrozen(result!.grants[0]!.selector.workspaceIds)).toBe(true);
    expect(result!.principalId).toBe("usr_0123456789abcdef");
    expect(result!.credentialId).toBe("cred_0123456789abcdef01234567");
    expect(result!.grantVersion).toBe("1");
    expect(result!.grants).toHaveLength(1);
    expect(result!.grants[0]!.action).toBe("workspace.content.read");
    expect(result!.grants[0]!.selector.kind).toBe("workspace");
    expect(result!.grants[0]!.selector.workspaceIds).toEqual(["w"]);
    expect(() =>
      (result!.grants[0]!.selector as { workspaceIds: string[] }).workspaceIds.push("x"),
    ).toThrow();
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => ({
      bad: true,
    });
    await expect(
      admission.authenticate("token", { node, transport: "direct", peer: "loopback" }),
    ).resolves.toBeNull();
  });

  test("rejects spread capability synchronously", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const spread = { ...audit } as unknown as ProductionAuditCapability;
    expect(() => new EnterpriseAdmission(base(spread))).toThrow(
      "current runtime-issued production audit capability required",
    );
  });

  test("rejects closed capability synchronously", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    await audit.close();
    expect(() => new EnterpriseAdmission(base(audit))).toThrow(
      "current runtime-issued production audit capability required",
    );
  });

  test("closed capability rejects public calls synchronously", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const admission = new EnterpriseAdmission(base(audit));
    let authCalls = 0;
    let guardCalls = 0;
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => {
      authCalls++;
      return null;
    };
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async () => {
      guardCalls++;
      return false;
    };
    await audit.close();
    expect(() =>
      admission.authenticate("token", { node, transport: "direct", peer: "loopback" }),
    ).toThrow("current runtime-issued production audit capability required");
    expect(() => admission.isCurrentPrincipalContext({} as never)).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(authCalls).toBe(0);
    expect(guardCalls).toBe(0);
  });

  test("close during authenticate bearer rejects pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const admission = new EnterpriseAdmission(base(audit));
    let started!: () => void;
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const principal = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [],
    } as const;
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => {
      started();
      await gate;
      return principal;
    };
    let published = 0;
    const pending = admission
      .authenticate("token", {
        node,
        transport: "direct",
        peer: "loopback",
      })
      .then((value) => {
        published++;
        return value;
      });
    await signal;
    await audit.close();
    release();
    await expect(pending).rejects.toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(published).toBe(0);
  });

  test("close during current guard rejects pending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const admission = new EnterpriseAdmission(base(audit));
    const principal = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [],
    } as const;
    let started!: () => void;
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => principal;
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async () => {
      started();
      await gate;
      return true;
    };
    let published = 0;
    const pending = admission
      .authenticate("token", {
        node,
        transport: "direct",
        peer: "loopback",
      })
      .then((value) => {
        published++;
        return value;
      });
    await signal;
    await audit.close();
    release();
    await expect(pending).rejects.toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(published).toBe(0);
  });

  test("constructor reads captured options once", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const reads: string[] = [];
    const options = new Proxy(base(audit), {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    void new EnterpriseAdmission(options);
    for (const key of [
      "audit",
      "filePath",
      "principalSource",
      "node",
      "organizationId",
      "invalidation",
      "clock",
      "credentialIds",
      "secrets",
      "hasher",
      "verifier",
      "fs",
      "daemonPassword",
    ])
      expect(reads.filter((value) => value === key)).toHaveLength(1);
    expect(reads[0]).toBe("audit");
  });

  test("closed capability proxy reads only audit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    await audit.close();
    const reads: string[] = [];
    const options = new Proxy(base(audit), {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => new EnterpriseAdmission(options)).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(reads).toEqual(["audit"]);
  });

  test("guard false after capability close rejects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const admission = new EnterpriseAdmission(base(audit));
    const principal = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [],
    } as const;
    let started!: () => void;
    const signal = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => principal;
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async () => {
      started();
      await gate;
      return false;
    };
    const pending = admission.authenticate("token", {
      node,
      transport: "direct",
      peer: "loopback",
    });
    await signal;
    await audit.close();
    release();
    await expect(pending).rejects.toThrow(
      "current runtime-issued production audit capability required",
    );
  });

  test("structural readiness fakes are rejected", () => {
    const fake = {
      append: async () => ({}),
      releaseReady: true,
    } as unknown as ProductionAuditCapability;
    expect(() => new EnterpriseAdmission(base(fake))).toThrow(
      "current runtime-issued production audit capability required",
    );
  });

  test("options close after audit check prevents consumers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const reads: string[] = [];
    const options = new Proxy(base(audit), {
      get(target, key, receiver) {
        reads.push(String(key));
        const value = Reflect.get(target, key, receiver);
        if (key === "audit") void audit.close();
        return value;
      },
    });
    expect(() => new EnterpriseAdmission(options)).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(reads[0]).toBe("audit");
  });

  test("reflect replacement of audit is rejected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const other = await issueAudit(root + "-other");
    const admission = new EnterpriseAdmission(base(audit));
    expect(Reflect.set(admission, "audit", other)).toBe(false);
    expect(admission.audit).toBe(audit);
    await audit.close();
    expect(() => admission.authenticate("token", {})).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(() => productionAuditCapabilityIssuer.requireCurrent(other)).not.toThrow();
  });

  test("enterprise evidence binds and releases an opaque session handle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const audit = await issueAudit(root);
    const admission = new EnterpriseAdmission(base(audit));
    const principal = {
      principalType: "human",
      principalId: "usr_0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "1",
      grants: [],
    } as const;
    (admission.authenticator as unknown as AuthStub).authenticateBearer = async () => principal;
    (admission.authenticator as unknown as GuardStub).isCurrentPrincipalContext = async () => true;
    const evidence = await admission.authenticateEvidence("token", {
      node,
      transport: "direct",
      peer: "loopback",
    });
    expect(evidence).not.toBeNull();
    const handle = admission.bindSession(evidence!, "client-a");
    expect(handle).not.toBeNull();
    expect(isCurrentEnterpriseAdmissionAuthorization(admission.authorizationIssuer, handle)).toBe(
      true,
    );
    expect(
      resolveCurrentEnterpriseAdmissionAuthorization(admission.authorizationIssuer, handle)
        ?.clientId,
    ).toBe("client-a");
    expect(admission.releaseSession(handle!)).toBe(true);
    expect(isCurrentEnterpriseAdmissionAuthorization(admission.authorizationIssuer, handle)).toBe(
      false,
    );
  });

  test("release-ready structural fake does not read close or filesystem", () => {
    const calls = { mkdir: 0, open: 0, read: 0, close: 0 };
    const fs = {
      ...nodeIdentityRegistryFs,
      mkdir: (...args: Parameters<typeof nodeIdentityRegistryFs.mkdir>) => {
        calls.mkdir++;
        return nodeIdentityRegistryFs.mkdir(...args);
      },
      open: (...args: Parameters<typeof nodeIdentityRegistryFs.open>) => {
        calls.open++;
        return nodeIdentityRegistryFs.open(...args);
      },
      read: (...args: Parameters<typeof nodeIdentityRegistryFs.read>) => {
        calls.read++;
        return nodeIdentityRegistryFs.read(...args);
      },
    };
    const fake = new Proxy(
      { append: async () => ({}), releaseReady: true } as unknown as ProductionAuditCapability,
      {
        get(target, key, receiver) {
          if (key === "close") {
            calls.close++;
            throw new Error("close getter read");
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(() => new EnterpriseAdmission({ ...base(fake), fs })).toThrow(
      "current runtime-issued production audit capability required",
    );
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0, close: 0 });
  });
});
