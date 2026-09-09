import { hash } from "bcryptjs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { AuditEvent, AuditEventInput, AuditAppendOptions } from "@getpaseo/protocol/messages";
import { EnterprisePrincipalAuthenticator } from "./authenticator.js";
import { IdentityRegistry } from "./registry.js";

const node = { nodeId: "nod_0123456789abcdef", paseoServerId: "srv", mode: "standalone" as const };

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
