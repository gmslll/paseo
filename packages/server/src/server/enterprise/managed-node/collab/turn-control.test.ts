import { describe, expect, test } from "vitest";
import type { WorkspaceCatalog } from "@getpaseo/protocol/enterprise-collaboration";
import { COLLAB_TURN_UNAVAILABLE, createCollabTurnControl } from "./turn-control.js";

const OWNER = "usr_aaaaaaaaaaaaaaaa";
const WORKSPACE_UID = "cws_0123456789abcdef";
const RPC_ID = "rpc_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function catalog(): WorkspaceCatalog {
  return {
    version: 1,
    nodeId: "nod_0123456789abcdef",
    organizationId: "org_1111111111111111",
    fetchedAt: "2026-09-17T00:00:00.000Z",
    workspaces: [
      {
        workspaceUid: WORKSPACE_UID,
        localWorkspaceId: "ws-1",
        ownerPrincipalId: OWNER,
        members: [{ principalId: OWNER, role: "owner" }],
        state: "active",
        cachedAt: "2026-09-17T00:00:00.000Z",
        remoteMissingAt: null,
      },
    ],
  };
}

describe("collab turn control", () => {
  test("submits agent.send through the plane and accepts the node's response", async () => {
    const submitted: unknown[] = [];
    const control = createCollabTurnControl({
      catalog: { current: () => catalog() },
      mutator: {
        async submitSend(change) {
          submitted.push(change.payload);
          expect(change.method).toBe("agent.send");
          expect(change.localWorkspaceId).toBe("ws-1");
          return {
            kind: "request",
            rpcVersion: 1,
            rpcId: change.rpcId,
            method: "agent.send",
            nodeId: "nod_0123456789abcdef",
            containerId: WORKSPACE_UID,
            clientId: change.clientId,
            sentAt: "2026-09-18T00:00:00.000Z",
            expiresAt: "2026-09-18T00:01:00.000Z",
            payload: change.payload,
            attestation: "pmr_v1.abc.def",
          };
        },
        async dispatch() {
          return {
            kind: "response",
            rpcVersion: 1,
            rpcId: RPC_ID,
            nodeId: "nod_0123456789abcdef",
            completedAt: "2026-09-18T00:00:01.000Z",
            payload: { type: "send_agent_message_response", payload: { accepted: true } },
          };
        },
      },
    });

    expect(
      await control.send({
        workspaceId: "ws-1",
        actorPrincipalId: OWNER,
        credentialId: "cred-1",
        clientId: "client-1",
        agentId: "agent-1",
        text: "hi",
        requestId: "r1",
      }),
    ).toEqual({ accepted: true });
    expect(submitted).toEqual([
      {
        type: "send_agent_message_request",
        requestId: "r1",
        agentId: "agent-1",
        text: "hi",
      },
    ]);
  });

  test("an unknown Workspace cannot send a collaborative turn", async () => {
    const control = createCollabTurnControl({
      catalog: { current: () => catalog() },
    });

    await expect(
      control.send({
        workspaceId: "missing",
        actorPrincipalId: OWNER,
        credentialId: "cred-1",
        clientId: "client-1",
        agentId: "agent-1",
        text: "hi",
        requestId: "r1",
      }),
    ).rejects.toThrow(COLLAB_TURN_UNAVAILABLE);
  });
});
