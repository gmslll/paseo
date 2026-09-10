import type { EnterpriseWorkspaceOwnershipTransferTombstone } from "@getpaseo/protocol/messages";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthoritySessionBindingRecord } from "../enterprise/access/authority-receipt-verifier.js";
import type { WorkspaceOwnershipTransferTombstoneContext } from "../enterprise/access/enterprise-resource-handlers.js";
import { createEnterpriseAgentSessionContextRegistry } from "./enterprise-agent-session-context-registry.js";

const handlerMocks = vi.hoisted(() => ({
  consume: vi.fn(),
}));

vi.mock("../enterprise/access/enterprise-resource-handlers.js", () => ({
  consumeWorkspaceOwnershipTransferTombstoneContext: handlerMocks.consume,
}));

import {
  claimAndFanoutWorkspaceOwnershipTransferTombstone,
  consumeWorkspaceOwnershipTransferTargetDelivery,
  registerWorkspaceOwnershipTransferSession,
  unregisterWorkspaceOwnershipTransferSession,
  WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT,
  WorkspaceOwnershipTransferReplayLedger,
  type WorkspaceOwnershipTransferTargetDelivery,
} from "./enterprise-workspace-ownership-transfer-fanout.js";

const organizationId = "org_aaaaaaaaaaaaaaaa";
const nodeId = "nod_aaaaaaaaaaaaaaaa";
const oldPrincipalId = "usr_aaaaaaaaaaaaaaaa";

function binding(
  suffix: string,
  overrides: Partial<AuthoritySessionBindingRecord> = {},
): AuthoritySessionBindingRecord {
  return {
    sessionId: `session-${suffix}`,
    sessionBindingKey: `binding-${suffix}`,
    sessionBindingGeneration: `generation-${suffix}`,
    organizationId,
    principalId: oldPrincipalId,
    principalType: "human",
    credentialId: `credential-${suffix}`,
    grantVersion: "grant-v1",
    nodeId,
    clientId: `client-${suffix}`,
    ...overrides,
  };
}

function tombstoneContext(
  issuerBinding: AuthoritySessionBindingRecord,
  eventId = "event-1",
): WorkspaceOwnershipTransferTombstoneContext {
  const message: EnterpriseWorkspaceOwnershipTransferTombstone = Object.freeze({
    type: "enterprise.workspace.ownership.transfer.tombstone",
    payload: Object.freeze({
      eventId,
      resource: Object.freeze({
        organizationId,
        nodeId,
        resourceKind: "workspace",
        localResourceId: "wks_aaaaaaaaaaaaaaaa",
      }),
      oldPrincipalId,
      newRevision: "opaque-revision",
      transferReceiptId: "transfer-receipt-1",
    }),
  });
  return Object.freeze({ message, issuerBinding }) as WorkspaceOwnershipTransferTombstoneContext;
}

function consumingSink(
  currentBinding: AuthoritySessionBindingRecord,
  messages: EnterpriseWorkspaceOwnershipTransferTombstone[],
) {
  return (delivery: WorkspaceOwnershipTransferTargetDelivery) => {
    const message = consumeWorkspaceOwnershipTransferTargetDelivery(delivery, currentBinding);
    if (!message) return Object.freeze({ sealed: false, delivered: false });
    messages.push(message);
    return Object.freeze({ sealed: true, delivered: true });
  };
}

describe("Workspace ownership transfer Session fanout", () => {
  beforeEach(() => {
    handlerMocks.consume.mockReset();
  });

  test("fans out once to exact old-principal Sessions within one runtime", () => {
    const runtime = createEnterpriseAgentSessionContextRegistry();
    const otherRuntime = createEnterpriseAgentSessionContextRegistry();
    const issuerBinding = binding("issuer");
    const siblingBinding = binding("sibling");
    const newOwnerBinding = binding("new-owner", { principalId: "usr_bbbbbbbbbbbbbbbb" });
    const otherNodeBinding = binding("other-node", { nodeId: "nod_bbbbbbbbbbbbbbbb" });
    const isolatedBinding = binding("isolated");
    const issuerMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const siblingMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const newOwnerMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const otherNodeMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const isolatedMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const issuerHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: issuerBinding,
      deliver: consumingSink(issuerBinding, issuerMessages),
    });
    registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: siblingBinding,
      deliver: consumingSink(siblingBinding, siblingMessages),
    });
    registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: newOwnerBinding,
      deliver: consumingSink(newOwnerBinding, newOwnerMessages),
    });
    registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: otherNodeBinding,
      deliver: consumingSink(otherNodeBinding, otherNodeMessages),
    });
    registerWorkspaceOwnershipTransferSession({
      runtimeKey: otherRuntime,
      binding: isolatedBinding,
      deliver: consumingSink(isolatedBinding, isolatedMessages),
    });
    const context = tombstoneContext(issuerBinding);
    handlerMocks.consume.mockReturnValue(context);

    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: true,
      targetedSessions: 2,
      deliveredSessions: 2,
    });
    expect(handlerMocks.consume).toHaveBeenCalledTimes(1);
    expect(issuerMessages).toEqual([context.message]);
    expect(siblingMessages).toEqual([context.message]);
    expect(newOwnerMessages).toEqual([]);
    expect(otherNodeMessages).toEqual([]);
    expect(isolatedMessages).toEqual([]);

    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: false,
      targetedSessions: 0,
      deliveredSessions: 0,
    });
    expect(handlerMocks.consume).toHaveBeenCalledTimes(2);
    expect(issuerMessages).toHaveLength(1);
    expect(siblingMessages).toHaveLength(1);
  });

  test("burns target tokens for wrong current bindings, cleanup, and late callbacks", () => {
    const runtime = createEnterpriseAgentSessionContextRegistry();
    const issuerBinding = binding("issuer-late");
    const wrongBinding = binding("wrong");
    let captured: WorkspaceOwnershipTransferTargetDelivery | null = null;
    const issuerHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: issuerBinding,
      deliver: (delivery) => {
        captured = delivery;
        expect(consumeWorkspaceOwnershipTransferTargetDelivery(delivery, wrongBinding)).toBeNull();
        return Object.freeze({ sealed: false, delivered: false });
      },
    });
    const removedMessages: EnterpriseWorkspaceOwnershipTransferTombstone[] = [];
    const removedBinding = binding("removed");
    const removedHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: removedBinding,
      deliver: consumingSink(removedBinding, removedMessages),
    });
    unregisterWorkspaceOwnershipTransferSession(removedHandle);
    unregisterWorkspaceOwnershipTransferSession(removedHandle);
    handlerMocks.consume.mockReturnValue(tombstoneContext(issuerBinding, "event-late"));

    const result = claimAndFanoutWorkspaceOwnershipTransferTombstone({
      issuerHandle,
      dispatcher: Object.freeze({}),
      contextualResponse: Object.freeze({}),
    });
    expect(result).toEqual({
      claimed: true,
      issuerSealed: false,
      targetedSessions: 1,
      deliveredSessions: 0,
    });
    expect(removedMessages).toEqual([]);
    expect(captured).not.toBeNull();
    expect(consumeWorkspaceOwnershipTransferTargetDelivery(captured!, issuerBinding)).toBeNull();

    unregisterWorkspaceOwnershipTransferSession(issuerHandle);
    handlerMocks.consume.mockReturnValue(tombstoneContext(issuerBinding, "event-after-cleanup"));
    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: false,
      targetedSessions: 0,
      deliveredSessions: 0,
    });
  });

  test.each([
    ["sessionId", "session-other"],
    ["clientId", "client-other"],
    ["sessionBindingGeneration", "generation-other"],
    ["organizationId", "org_bbbbbbbbbbbbbbbb"],
    ["nodeId", "nod_bbbbbbbbbbbbbbbb"],
    ["principalId", "usr_bbbbbbbbbbbbbbbb"],
  ] as const)("rejects a target whose current %s is not exact", (field, value) => {
    const runtime = createEnterpriseAgentSessionContextRegistry();
    const issuerBinding = binding(`issuer-${field}`);
    const targetBinding = binding(`target-${field}`);
    const issuerHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: issuerBinding,
      deliver: consumingSink(issuerBinding, []),
    });
    let targetDelivery: WorkspaceOwnershipTransferTargetDelivery | null = null;
    registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: targetBinding,
      deliver: (delivery) => {
        targetDelivery = delivery;
        expect(
          consumeWorkspaceOwnershipTransferTargetDelivery(delivery, {
            ...targetBinding,
            [field]: value,
          }),
        ).toBeNull();
        return Object.freeze({ sealed: false, delivered: false });
      },
    });
    handlerMocks.consume.mockReturnValue(tombstoneContext(issuerBinding, `event-target-${field}`));

    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: true,
      targetedSessions: 2,
      deliveredSessions: 1,
    });
    expect(targetDelivery).not.toBeNull();
    expect(
      consumeWorkspaceOwnershipTransferTargetDelivery(targetDelivery!, targetBinding),
    ).toBeNull();
  });

  test("bounds the replay ledger while continuing to fan out new transfers", () => {
    const ledger = new WorkspaceOwnershipTransferReplayLedger();
    for (let index = 0; index < WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT; index += 1) {
      expect(ledger.remember(`pair-${index}`)).toBe(true);
      expect(ledger.size).toBeLessThanOrEqual(WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT);
    }
    expect(ledger.remember("pair-4096")).toBe(true);
    expect(ledger.size).toBe(WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT);
    expect(ledger.remember("pair-4096")).toBe(false);
    expect(ledger.size).toBe(WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT);
    expect(ledger.remember("pair-0")).toBe(true);
    expect(ledger.size).toBe(WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT);

    const runtime = createEnterpriseAgentSessionContextRegistry();
    const issuerBinding = binding("bounded-ledger");
    let delivered = 0;
    const issuerHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: issuerBinding,
      deliver: (delivery) => {
        const message = consumeWorkspaceOwnershipTransferTargetDelivery(delivery, issuerBinding);
        if (!message) return Object.freeze({ sealed: false, delivered: false });
        delivered += 1;
        return Object.freeze({ sealed: true, delivered: true });
      },
    });
    const fanout = (eventId: string) => {
      handlerMocks.consume.mockReturnValue(tombstoneContext(issuerBinding, eventId));
      return claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      });
    };

    for (let index = 0; index < WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT; index += 1) {
      expect(fanout(`event-bounded-${index}`).deliveredSessions).toBe(1);
    }
    expect(delivered).toBe(WORKSPACE_OWNERSHIP_TRANSFER_REPLAY_LEDGER_LIMIT);

    expect(fanout("event-bounded-4096").deliveredSessions).toBe(1);
    expect(fanout("event-bounded-4096").deliveredSessions).toBe(0);
    expect(fanout("event-bounded-0").deliveredSessions).toBe(1);
    expect(delivered).toBe(4098);
  });

  test("burns a claimed context when the issuer binding or handle is not exact", () => {
    const runtime = createEnterpriseAgentSessionContextRegistry();
    const issuerBinding = binding("issuer-mismatch");
    const issuerHandle = registerWorkspaceOwnershipTransferSession({
      runtimeKey: runtime,
      binding: issuerBinding,
      deliver: () => Object.freeze({ sealed: true, delivered: true }),
    });
    handlerMocks.consume.mockReturnValue(
      tombstoneContext({ ...issuerBinding, clientId: "client-mismatch" }, "event-mismatch"),
    );
    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: false,
      targetedSessions: 0,
      deliveredSessions: 0,
    });

    handlerMocks.consume.mockReturnValue(tombstoneContext(issuerBinding, "event-no-handle"));
    expect(
      claimAndFanoutWorkspaceOwnershipTransferTombstone({
        issuerHandle: null,
        dispatcher: Object.freeze({}),
        contextualResponse: Object.freeze({}),
      }),
    ).toEqual({
      claimed: true,
      issuerSealed: false,
      targetedSessions: 0,
      deliveredSessions: 0,
    });
  });
});
