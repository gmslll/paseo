import { describe, expect, test } from "vitest";

import {
  ManagedNodeHeartbeatSchema,
  ManagedNodeRequestAuthenticationSchema,
  ManagedNodeShutdownSchema,
  ManagedSessionTicketClaimsSchema,
} from "./enterprise-management.js";

describe("enterprise management channel contracts", () => {
  test("strictly separates node authority and node-bound ticket authority", () => {
    expect(
      ManagedNodeRequestAuthenticationSchema.safeParse({
        nodeId: "nod_0123456789abcdef",
        timestampMs: 1,
        nonce: "nonce_0123456789abcdef012345",
        signature: "signed_value",
        principalId: "usr_0123456789abcdef",
      }).success,
    ).toBe(false);
    expect(
      ManagedNodeHeartbeatSchema.safeParse({
        bootId: "boot",
        paseoServerId: "server",
        endpoint: "wss://node.test:6767",
        version: "0.8.0",
        capabilities: {},
        capacity: {
          cpuLogical: 8,
          memoryTotalBytes: 1,
          memoryAvailableBytes: 1,
          activeAgents: 0,
          activeBrowserProfiles: 0,
        },
        grants: [],
      }).success,
    ).toBe(false);
    expect(ManagedNodeShutdownSchema.parse({ bootId: "boot", paseoServerId: "server" })).toEqual({
      bootId: "boot",
      paseoServerId: "server",
    });
    expect(
      ManagedNodeShutdownSchema.safeParse({
        bootId: "boot",
        paseoServerId: "server",
        status: "offline",
      }).success,
    ).toBe(false);
  });

  test("requires content authority only on a content ticket", () => {
    const base = {
      version: 1 as const,
      issuer: "https://management.test:17443",
      ticketId: "tkt_0123456789abcdef0123456789abcdef",
      organizationId: "org_0123456789abcdef",
      principalId: "usr_0123456789abcdef",
      principalType: "human" as const,
      credentialId: "cred_0123456789abcdef01234567",
      grantVersion: "grv_1",
      revocationEpoch: 0,
      nodeId: "nod_0123456789abcdef",
      paseoServerId: "server",
      grants: [],
      issuedAtMs: 1,
      notBeforeMs: 1,
      expiresAtMs: 2,
    };
    expect(
      ManagedSessionTicketClaimsSchema.parse({ ...base, kind: "session", clientId: "client-a" }),
    ).toMatchObject({ kind: "session", clientId: "client-a" });
    expect(ManagedSessionTicketClaimsSchema.safeParse({ ...base, kind: "session" }).success).toBe(
      false,
    );
    expect(ManagedSessionTicketClaimsSchema.safeParse({ ...base, kind: "content" }).success).toBe(
      false,
    );
    expect(
      ManagedSessionTicketClaimsSchema.parse({
        ...base,
        kind: "content",
        resource: {
          organizationId: base.organizationId,
          nodeId: base.nodeId,
          resourceKind: "workspace",
          localResourceId: "workspace-a",
        },
        action: "workspace.content.read",
      }),
    ).toMatchObject({ kind: "content", action: "workspace.content.read" });
  });
});
