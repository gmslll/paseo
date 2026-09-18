import { hash } from "bcryptjs";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AuditEvent, AuditEventInput, AuditAppendOptions } from "@getpaseo/protocol/messages";
import { EnterprisePrincipalAuthenticator } from "./authenticator.js";
import { IdentityRegistry } from "./registry.js";
import {
  type IdentityRegistryFsPort,
  type IdentityRegistryFsStat,
  nodeIdentityRegistryFs,
} from "./fs-port.js";

const node = { nodeId: "nod_0123456789abcdef", paseoServerId: "srv", mode: "standalone" as const };
const SYNTHETIC_NOFOLLOW_FLAG = 0x40000000;

function portableIdentityFs(): IdentityRegistryFsPort {
  const noFollowFlag = nodeIdentityRegistryFs.noFollowFlag || SYNTHETIC_NOFOLLOW_FLAG;
  const pathsByFd = new Map<number, string>();
  const projectedModesByPath = new Map<string, number>();
  return Object.assign(Object.create(nodeIdentityRegistryFs), {
    noFollowFlag,
    open: (filePath: string, flags: number, mode?: number): number => {
      const delegateFlags =
        nodeIdentityRegistryFs.noFollowFlag === 0 ? flags & ~SYNTHETIC_NOFOLLOW_FLAG : flags;
      const fd = nodeIdentityRegistryFs.open(filePath, delegateFlags, mode);
      pathsByFd.set(fd, filePath);
      return fd;
    },
    close: (fd: number): void => {
      nodeIdentityRegistryFs.close(fd);
      pathsByFd.delete(fd);
    },
    fstat: (fd: number): IdentityRegistryFsStat => {
      const value = nodeIdentityRegistryFs.fstat(fd);
      const filePath = pathsByFd.get(fd);
      const mode = filePath ? projectedModesByPath.get(filePath) : undefined;
      if (mode === undefined) return value;
      return Object.assign(Object.create(value), {
        mode: (value.mode & ~0o7777) | mode,
      });
    },
    fchmod: (fd: number, mode: number): void => {
      try {
        nodeIdentityRegistryFs.fchmod(fd, mode);
      } catch (error) {
        if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") {
          throw error;
        }
      }
      const filePath = pathsByFd.get(fd);
      if (process.platform === "win32" && filePath) projectedModesByPath.set(filePath, mode);
    },
    fsync: (fd: number): void => {
      const filePath = pathsByFd.get(fd);
      if (process.platform === "win32" && filePath && statSync(filePath).isDirectory()) return;
      nodeIdentityRegistryFs.fsync(fd);
    },
    rename: (from: string, to: string): void => {
      nodeIdentityRegistryFs.rename(from, to);
      if (process.platform === "win32") {
        const mode = projectedModesByPath.get(from);
        projectedModesByPath.delete(from);
        if (mode !== undefined) projectedModesByPath.set(to, mode);
      }
    },
    unlink: (filePath: string): void => {
      nodeIdentityRegistryFs.unlink(filePath);
      if (process.platform === "win32") projectedModesByPath.delete(filePath);
    },
  });
}

describe("EnterprisePrincipalAuthenticator", () => {
  test("allows daemon password only from local peers and never exposes its hash", async () => {
    const passwordHash = await hash("break-glass-password", 12);
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-authenticator-"));
    const organizationId = "org_0123456789abcdef";
    const events: AuditEvent[] = [];
    const audit = {
      append: async (input: AuditEventInput, _options: AuditAppendOptions): Promise<AuditEvent> => {
        const event = {
          ...input,
          eventId: `evt_${events.length + 1}`,
          occurredAt: new Date().toISOString(),
          nodeId: node.nodeId,
          nodeEventSeq: events.length,
          eventHash: `hash_${events.length + 1}`,
        } as AuditEvent;
        events.push(event);
        return event;
      },
    };
    const registry = new IdentityRegistry({
      filePath: path.join(root, "credentials.json"),
      fs: portableIdentityFs(),
      node,
      principalSource: { resolvePrincipal: async () => null },
      audit,
      invalidation: { publish: async () => {} },
    });
    const authenticator = new EnterprisePrincipalAuthenticator({
      registry,
      node,
      organizationId,
      daemonPassword: passwordHash,
      audit,
    });
    const local = await authenticator.authenticateBearer("break-glass-password", {
      node,
      transport: "direct",
      peer: "loopback",
    });
    expect(local?.principalId).toBe("owner");
    expect(local?.credentialId).not.toContain(passwordHash);
    expect(
      local?.grants.every(
        (grant) =>
          grant.selector.kind === "organization" &&
          grant.selector.organizationId === organizationId,
      ),
    ).toBe(true);
    expect(events[0]?.action).toBe("identity.break_glass.use");
    expect(events[0]?.outcome).toBe("allowed");
    expect(events[0]?.priority).toBe("high");
    expect(
      await authenticator.authenticateBearer("break-glass-password", {
        node,
        transport: "direct",
        peer: "external",
      }),
    ).toBeNull();
  });

  test("rejects invalid connection and node contexts before registry or audit work", async () => {
    let calls = 0;
    const audit = {
      append: async () => {
        calls++;
        return {} as AuditEvent;
      },
    };
    const registry = new IdentityRegistry({
      filePath: path.join(os.tmpdir(), "invalid-context.json"),
      fs: portableIdentityFs(),
      node,
      principalSource: { resolvePrincipal: async () => null },
      audit,
      invalidation: { publish: async () => {} },
      verifier: {
        compare: async () => {
          calls++;
          return false;
        },
      },
    });
    const authenticator = new EnterprisePrincipalAuthenticator({
      registry,
      node,
      organizationId: "org_0123456789abcdef",
      audit,
    });
    await expect(
      authenticator.authenticateBearer("x", {
        node: { ...node, nodeId: "bad" },
        transport: "direct",
        peer: "loopback",
      } as never),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
