import { mkdtemp } from "node:fs/promises";
import { hash } from "bcryptjs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { EnterpriseAdmission } from "./admission.js";
import type { EnterpriseAuditSink } from "./admission.js";
import { nodeIdentityRegistryFs } from "./fs-port.js";
interface AuthStub {
  authenticateBearer: (token: string, context: unknown) => Promise<unknown>;
}
interface GuardStub {
  isCurrentPrincipalContext: (value: unknown) => Promise<boolean>;
}

const node = { nodeId: "nod_0123456789abcdef", paseoServerId: "srv", mode: "standalone" as const };
const base = (audit: EnterpriseAuditSink) => ({
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
    ).toThrow("release-ready");
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0 });
    expect(
      () =>
        new EnterpriseAdmission({
          ...base({ append: async () => ({}), releaseReady: true }),
          node: { ...node, nodeId: "bad" } as never,
        }),
    ).toThrow();
    expect(
      () =>
        new EnterpriseAdmission({
          ...base({ append: async () => ({}), releaseReady: true }),
          organizationId: "bad",
        }),
    ).toThrow();
  });

  test("invalid node and organization reject before wrapped fs calls", () => {
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
          ...base({ append: async () => ({}), releaseReady: true }),
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
          ...base({ append: async () => ({}), releaseReady: true }),
          fs,
          organizationId: "bad",
        }),
    ).toThrow();
    expect(calls).toEqual({ mkdir: 0, open: 0, read: 0 });
  });

  test("accepts release-ready audit and rejects invalid connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-"));
    const admission = new EnterpriseAdmission({
      ...base({ append: async () => ({}), releaseReady: true }),
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
      ...base({ append: async () => ({}), releaseReady: true }),
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
      ...base({ append: async () => ({}), releaseReady: true }),
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
      ...base({ append: async () => ({}), releaseReady: true }),
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

  test("deferred guard snapshots principal and rejects malformed raw", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "admission-deferred-"));
    const admission = new EnterpriseAdmission({
      ...base({ append: async () => ({}), releaseReady: true }),
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
});
