import { describe, expect, test } from "vitest";
import type {
  AuditAppendOptions,
  AuditEvent,
  AuditEventInput,
  AuditSink,
  PrincipalContext,
} from "@getpaseo/protocol/messages";

import { OwnerRegistry } from "../enterprise/access/owner-registry.js";
import { ResourceAuthorizationService } from "../enterprise/access/resource-authorization.js";
import type { PrincipalGrantProjection } from "../enterprise/identity/registry.js";
import { createEnterpriseOrchestrationAuthority } from "./enterprise-orchestration-authority.js";
import { OrchestrationError } from "./orchestration-error.js";

const ORGANIZATION = "org_0123456789abcdef";
const NODE = "nod_0123456789abcdef";
const ALICE = "usr_0123456789abcdef";
const BOB = "usr_fedcba9876543210";

const alice = {
  organizationId: ORGANIZATION,
  nodeId: NODE,
  ownerPrincipalId: ALICE,
  createdByPrincipalId: ALICE,
} as const;
const bob = { ...alice, ownerPrincipalId: BOB, createdByPrincipalId: BOB } as const;

class RecordingAudit implements AuditSink {
  readonly appended: Array<{ input: AuditEventInput; options: AuditAppendOptions }> = [];

  async append(input: AuditEventInput, options: AuditAppendOptions): Promise<AuditEvent> {
    this.appended.push({ input, options });
    return {
      ...input,
      eventId: `evt_${this.appended.length}`,
      occurredAt: "2026-09-16T08:00:00.000Z",
      nodeId: NODE,
      nodeEventSeq: this.appended.length,
    };
  }
}

function createFixture() {
  const owners = new OwnerRegistry();
  owners.registerWorkspace({ id: "wks_alice", ...alice });
  owners.registerWorkspace({ id: "wks_bob", ...bob });
  owners.registerAgent({ id: "agent_parent", workspaceId: "wks_alice", ...alice });
  owners.registerAgent({ id: "agent_bob", workspaceId: "wks_bob", ...bob });

  const grantVersions = new Map<string, string>([[ALICE, "grv_1"]]);
  const projection = (principalId: string): PrincipalGrantProjection => ({
    principalType: "human",
    principalId: principalId as PrincipalContext["principalId"],
    organizationId: ORGANIZATION,
    grantVersion: grantVersions.get(principalId) ?? "grv_1",
    grants: [
      { action: "workspace.metadata.read", selector: { kind: "self" } },
      { action: "workspace.write", selector: { kind: "self" } },
    ],
  });
  const grantVersionGuard = {
    isCurrent: (ctx: PrincipalContext) => grantVersions.get(ctx.principalId) === ctx.grantVersion,
  };
  const audit = new RecordingAudit();
  const authority = createEnterpriseOrchestrationAuthority({
    owners,
    principals: {
      resolvePrincipal: async (principalId, organizationId) =>
        organizationId === ORGANIZATION && principalId === ALICE ? projection(principalId) : null,
    },
    resources: new ResourceAuthorizationService({ owners, nodeId: NODE, grantVersionGuard }),
    grantVersionGuard,
    audit,
  });
  return { authority, audit, grantVersions };
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return error instanceof OrchestrationError ? error.code : String(error);
  }
  return null;
}

describe("enterprise delegation authority", () => {
  test("acts for the requester Workspace owner and freezes that Principal", async () => {
    const { authority, audit } = createFixture();

    const frozen = await authority.authorizeAccept({
      requesterAgentId: "agent_parent",
      targets: [
        { kind: "create", workspaceId: "wks_alice" },
        { kind: "prompt", agentId: "agent_parent" },
      ],
    });

    expect(frozen).toMatchObject({
      mode: "enterprise",
      principal: {
        principalId: ALICE,
        grantVersion: "grv_1",
        credentialId: "agent-delegation:agent_parent",
      },
    });
    expect(authority.isCurrent(frozen)).toBe(true);
    expect(audit.appended).toEqual([]);
  });

  test("denies a target in another person's Workspace with one required audit event", async () => {
    const { authority, audit } = createFixture();

    expect(
      await rejectionCode(
        authority.authorizeAccept({
          requesterAgentId: "agent_parent",
          targets: [
            { kind: "create", workspaceId: "wks_alice" },
            { kind: "prompt", agentId: "agent_bob" },
          ],
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
    expect(audit.appended).toEqual([
      {
        input: {
          organizationId: ORGANIZATION,
          actorPrincipalId: ALICE,
          action: "orchestration.operation.denied",
          resource: { kind: "agent", id: "agent_bob" },
          outcome: "denied",
          priority: "high",
          reasonCode: "AUTHORIZATION_DENIED",
          metadata: { requesterAgentId: "agent_parent" },
        },
        options: { durability: "required" },
      },
    ]);
  });

  test("denies an Agent the owner registry does not know and a requester whose owner is gone", async () => {
    const { authority, audit } = createFixture();

    expect(
      await rejectionCode(
        authority.authorizeAccept({
          requesterAgentId: "agent_unknown",
          targets: [{ kind: "create", workspaceId: "wks_alice" }],
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
    expect(
      await rejectionCode(
        authority.authorizeAccept({
          requesterAgentId: "agent_bob",
          targets: [{ kind: "create", workspaceId: "wks_bob" }],
        }),
      ),
    ).toBe("AUTHORIZATION_DENIED");
    expect(audit.appended).toEqual([]);
  });

  test("stops treating a frozen authority as current once the owner's grants change", async () => {
    const { authority, grantVersions } = createFixture();
    const frozen = await authority.authorizeAccept({
      requesterAgentId: "agent_parent",
      targets: [{ kind: "create", workspaceId: "wks_alice" }],
    });

    grantVersions.set(ALICE, "grv_2");

    expect(authority.isCurrent(frozen)).toBe(false);
    expect(authority.isCurrent({ mode: "standalone" })).toBe(false);
  });

  test("records operation lifecycle events as the owner with buffered durability", async () => {
    const { authority, audit } = createFixture();
    const frozen = await authority.authorizeAccept({
      requesterAgentId: "agent_parent",
      targets: [{ kind: "create", workspaceId: "wks_alice" }],
    });

    await authority.record?.({
      action: "orchestration.delivery.uncertain",
      authority: frozen,
      requesterAgentId: "agent_parent",
      operationId: "fan-out",
      metadata: { deliverySeq: "2" },
    });

    expect(audit.appended).toEqual([
      {
        input: {
          organizationId: ORGANIZATION,
          actorPrincipalId: ALICE,
          action: "orchestration.delivery.uncertain",
          resource: { kind: "agent", id: "agent_parent" },
          agentId: "agent_parent",
          outcome: "failed",
          metadata: { deliverySeq: "2", operationId: "fan-out" },
        },
        options: { durability: "buffered" },
      },
    ]);
  });
});
