import { describe, expect, test, vi } from "vitest";

import type { AgentPermissionResponse } from "./agent/agent-sdk-types.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { Session, type SessionOptions } from "./session.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import {
  createAgentRequestsStub,
  createProviderSnapshotManagerStub,
} from "./test-utils/session-stubs.js";

const AGENT_ID = "agent-1";
const ALICE = { principalId: "usr_00000000000000a1", displayName: "Alice" };
const BOB = { principalId: "usr_00000000000000b2", displayName: "Bob" };
const ALLOW: AgentPermissionResponse = { behavior: "allow" };

interface SessionInternals {
  handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
}

/**
 * A Session answering for `responder`, on an Agent whose running turn belongs to `controller` and
 * whose Workspace belongs to `owner`. `controller: null` is a turn nobody is recorded as owning.
 */
function sessionFor(input: {
  responder?: { principalId: string };
  controller: { principalId: string; displayName?: string } | null;
  owner?: string;
}): { session: SessionInternals; respondToPermission: ReturnType<typeof vi.fn> } {
  const respondToPermission = vi.fn(async () => undefined);
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const session = asInternals<SessionInternals>(
    new Session({
      agentRequests: createAgentRequestsStub(),
      clientId: "test-client",
      permissions: OWNER_PERMISSIONS,
      onMessage: vi.fn(),
      logger: createStub<SessionOptions["logger"]>(logger),
      downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
      pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
      paseoHome: "/tmp/paseo-test",
      ...(input.responder
        ? {
            enterpriseContext: {
              principal: {
                principalType: "human",
                principalId: input.responder.principalId,
                organizationId: "org_0123456789abcdef",
                credentialId: "cred-1",
                grants: [],
                grantVersion: "g1",
              },
              node: {
                nodeId: "nod_0123456789abcdef",
                paseoServerId: "server-a",
                organizationId: "org_0123456789abcdef",
                mode: "managed",
              },
              sessionBindingGeneration: "gen-1",
            } as SessionOptions["enterpriseContext"],
            // The constructor refuses an enterprise context on its own: the registry, the receipt
            // state and resource authorization have to arrive with it.
            enterpriseAgentContextRegistry: createStub<
              NonNullable<SessionOptions["enterpriseAgentContextRegistry"]>
            >({ bind: () => undefined, resolve: () => null }),
            // Session binding lifecycle, called on construction and teardown. Nothing to do with
            // who may answer a permission, so these record nothing.
            authorityReceiptState: createStub<NonNullable<SessionOptions["authorityReceiptState"]>>(
              {
                registerSessionBinding: () => undefined,
                releaseSession: () => undefined,
              },
            ),
            resourceAuthorization: createStub<NonNullable<SessionOptions["resourceAuthorization"]>>(
              {},
            ),
            principalGrantVersionGuard: createStub<
              NonNullable<SessionOptions["principalGrantVersionGuard"]>
            >({}),
          }
        : {}),
      agentManager: createStub<SessionOptions["agentManager"]>({
        subscribe: () => () => {},
        listAgents: () => [],
        turnControllerOf: () => input.controller,
        getAgent: () =>
          input.owner
            ? {
                id: AGENT_ID,
                enterpriseOwnership: { ownerPrincipalId: input.owner },
              }
            : { id: AGENT_ID },
        respondToPermission,
      }),
      agentStorage: createStub<SessionOptions["agentStorage"]>({
        list: async () => [],
        get: async () => null,
      }),
      projectRegistry: createStub<SessionOptions["projectRegistry"]>({
        subscribeToMutations: () => () => {},
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
      }),
      workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
        subscribeToMutations: () => () => {},
        initialize: async () => {},
        existsOnDisk: async () => true,
        list: async () => [],
        get: async () => null,
      }),
      createAgentMcpTransport: async () => {
        throw new Error("not used");
      },
      stt: null,
      tts: null,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      terminalManager: null,
    }),
  );
  return { session, respondToPermission };
}

describe("who may answer a tool permission request", () => {
  test("refuses a collaborator who does not control the running turn", async () => {
    const { session, respondToPermission } = sessionFor({ responder: BOB, controller: ALICE });

    await session.handleAgentPermissionResponse(AGENT_ID, "req-1", ALLOW);

    // ADR-0034: the permission belongs to the turn that raised it. Answering someone else's would
    // approve a tool call this collaborator never asked for and cannot see the context of.
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  test("lets the turn's controller answer", async () => {
    const { session, respondToPermission } = sessionFor({ responder: ALICE, controller: ALICE });

    await session.handleAgentPermissionResponse(AGENT_ID, "req-1", ALLOW);

    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });

  test("lets the Workspace owner answer another Principal's permission", async () => {
    const { session, respondToPermission } = sessionFor({
      responder: BOB,
      controller: ALICE,
      owner: BOB.principalId,
    });

    await session.handleAgentPermissionResponse(AGENT_ID, "req-1", ALLOW);

    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });

  test("leaves a turn with no recorded controller answerable by anyone", async () => {
    const { session, respondToPermission } = sessionFor({ responder: BOB, controller: null });

    await session.handleAgentPermissionResponse(AGENT_ID, "req-1", ALLOW);

    // Turns opened before authorship, and by the daemon itself, report no controller. Refusing
    // those would take away behaviour that has always worked.
    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });

  test("does not gate a single-user daemon", async () => {
    const { session, respondToPermission } = sessionFor({ controller: ALICE });

    await session.handleAgentPermissionResponse(AGENT_ID, "req-1", ALLOW);

    // No enterprise context means no Principals to tell apart.
    expect(respondToPermission).toHaveBeenCalledTimes(1);
  });
});
