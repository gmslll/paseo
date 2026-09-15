import { describe, expect, test } from "vitest";

import {
  COLLAB_SEGMENT_READERS,
  COLLAB_SEGMENT_WRITERS,
  type CollabSegment,
  CollabContainerIdSchema,
  CollabSubscriptionEventSchema,
  MachineRpcAttestedRequestSchema,
  MachineRpcClientRequestSchema,
  MachineRpcResultSchema,
  StreamTokenClaimsSchema,
  WORKSPACE_MEMBER_ROLE_ACTIONS,
  WorkspaceCatalogSchema,
  collabContainerKind,
  collabSegmentContainerKind,
  formatCollabSegment,
  parseCollabSegment,
} from "./enterprise-collaboration.js";
import { EnterpriseActionSchema } from "./messages.js";

const NODE_ID = "nod_0123456789abcdef";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const ORGANIZATION_ID = "org_0123456789abcdef";
const WORKSPACE_UID = "cws_0123456789abcdef";
const BOARD_ID = "brd_0123456789abcdef";
const TASK_ID = "tsk_0123456789abcdef";
const RPC_ID = "rpc_123e4567-e89b-42d3-a456-426614174000";
const AT = "2026-09-16T00:00:00.000Z";

describe("collaboration containers", () => {
  test("container ids distinguish Workspaces and boards", () => {
    expect(CollabContainerIdSchema.safeParse(WORKSPACE_UID).success).toBe(true);
    expect(CollabContainerIdSchema.safeParse(BOARD_ID).success).toBe(true);
    expect(CollabContainerIdSchema.safeParse(ORGANIZATION_ID).success).toBe(false);
    expect(collabContainerKind(WORKSPACE_UID)).toBe("workspace");
    expect(collabContainerKind(BOARD_ID)).toBe("board");
    expect(collabContainerKind("cws_short")).toBeNull();
  });
});

describe("membership roles", () => {
  test("role actions match ADR-0033 and stay inside the frozen action vocabulary", () => {
    expect(WORKSPACE_MEMBER_ROLE_ACTIONS).toEqual({
      owner: [
        "workspace.metadata.read",
        "workspace.content.read",
        "workspace.write",
        "workspace.manage",
      ],
      editor: ["workspace.metadata.read", "workspace.content.read", "workspace.write"],
      viewer: ["workspace.metadata.read", "workspace.content.read"],
    });
    for (const actions of Object.values(WORKSPACE_MEMBER_ROLE_ACTIONS)) {
      for (const action of actions) {
        expect(EnterpriseActionSchema.safeParse(action).success).toBe(true);
      }
    }
  });
});

describe("segments", () => {
  const cases: Array<[string, CollabSegment]> = [
    ["meta", { kind: "meta" }],
    ["wf", { kind: "workspace_kv" }],
    ["ti", { kind: "task_index" }],
    ["rp", { kind: "review_policy" }],
    ["s:agent_1-a", { kind: "session", agentId: "agent_1-a" }],
    ["fi:agent_1-a", { kind: "file_index", agentId: "agent_1-a" }],
    ["pc:preview-7", { kind: "preview_comments", resourceId: "preview-7" }],
    [`mf:${NODE_ID}`, { kind: "machine_state", nodeId: NODE_ID }],
    [`ob:${NODE_ID}`, { kind: "orchestration", nodeId: NODE_ID }],
    [`tk:${TASK_ID}`, { kind: "task", taskId: TASK_ID }],
    [`tks:${TASK_ID}`, { kind: "task_state", taskId: TASK_ID }],
    [`rpc:req:${NODE_ID}`, { kind: "rpc_request", nodeId: NODE_ID }],
    [`rpc:res:${RPC_ID}`, { kind: "rpc_response", rpcId: RPC_ID }],
  ];

  test.each(cases)("parses and formats %s", (segment, parsed) => {
    expect(parseCollabSegment(segment)).toEqual(parsed);
    expect(formatCollabSegment(parsed)).toBe(segment);
  });

  test.each([
    "",
    "fi",
    "s:",
    "s:../agent",
    "s:agent/1",
    "mf:node-1",
    "tk:tsk_xyz",
    "rpc:req:",
    `rpc:other:${NODE_ID}`,
    "rpc:res:rpc_not-a-uuid",
    `unknown:${NODE_ID}`,
    ":meta",
    "constructor",
    "__proto__",
    "toString:agent",
  ])("rejects %j", (segment) => {
    expect(parseCollabSegment(segment)).toBeNull();
  });

  test("task state, task index, and review policy accept writes only from the plane", () => {
    expect(COLLAB_SEGMENT_WRITERS.task_state).toEqual(["plane"]);
    expect(COLLAB_SEGMENT_WRITERS.task_index).toEqual(["plane"]);
    expect(COLLAB_SEGMENT_WRITERS.review_policy).toEqual(["plane"]);
  });

  test("Agent-derived segments accept writes only from the node", () => {
    for (const kind of ["session", "file_index", "machine_state", "orchestration"] as const) {
      expect(COLLAB_SEGMENT_WRITERS[kind]).toEqual(["node"]);
    }
  });

  test("machine RPC requests are node-read and responses are requester-read", () => {
    expect(COLLAB_SEGMENT_WRITERS.rpc_request).toEqual(["member"]);
    expect(COLLAB_SEGMENT_READERS.rpc_request).toEqual(["node"]);
    expect(COLLAB_SEGMENT_WRITERS.rpc_response).toEqual(["node"]);
    expect(COLLAB_SEGMENT_READERS.rpc_response).toEqual(["requester"]);
  });

  test("task segments live in boards and every other segment lives in Workspaces", () => {
    for (const [, parsed] of cases) {
      const expected = ["task_index", "task", "task_state", "review_policy"].includes(parsed.kind)
        ? "board"
        : "workspace";
      expect(collabSegmentContainerKind(parsed)).toBe(expected);
    }
  });
});

describe("workspace catalog", () => {
  const catalog = {
    version: 1,
    nodeId: NODE_ID,
    organizationId: ORGANIZATION_ID,
    fetchedAt: AT,
    workspaces: [
      {
        workspaceUid: WORKSPACE_UID,
        localWorkspaceId: "workspace-1",
        ownerPrincipalId: PRINCIPAL_ID,
        members: [{ principalId: "usr_fedcba9876543210", role: "editor" }],
        state: "remote_missing",
        cachedAt: AT,
        remoteMissingAt: AT,
      },
    ],
  };

  test("parses catalog entries and ignores fields from a newer writer", () => {
    const parsed = WorkspaceCatalogSchema.parse({
      ...catalog,
      futureField: true,
      workspaces: [{ ...catalog.workspaces[0], futureEntryField: "x" }],
    });

    expect(parsed).toEqual(catalog);
  });

  test("rejects an unknown catalog state and an owner that is not a managed Principal", () => {
    expect(
      WorkspaceCatalogSchema.safeParse({
        ...catalog,
        workspaces: [{ ...catalog.workspaces[0], state: "archived" }],
      }).success,
    ).toBe(false);
    expect(
      WorkspaceCatalogSchema.safeParse({
        ...catalog,
        workspaces: [{ ...catalog.workspaces[0], ownerPrincipalId: "owner" }],
      }).success,
    ).toBe(false);
  });
});

describe("machine RPC envelopes", () => {
  const request = {
    kind: "request",
    rpcVersion: 1,
    rpcId: RPC_ID,
    method: "agent.send",
    nodeId: NODE_ID,
    containerId: WORKSPACE_UID,
    clientId: "client-1",
    sentAt: AT,
    expiresAt: AT,
    payload: { type: "send_agent_message_request", requestId: "r1", agentId: "a", text: "hi" },
  };
  const attestation = {
    claims: {
      rpcId: RPC_ID,
      method: "agent.send",
      nodeId: NODE_ID,
      containerId: WORKSPACE_UID,
      requester: {
        principalId: PRINCIPAL_ID,
        credentialId: "cred-1",
        grantVersion: "g1",
        clientId: "client-1",
      },
      sentAt: AT,
      expiresAt: AT,
    },
    signature: "c2lnbmF0dXJl",
  };

  test("a client request cannot carry its own attestation", () => {
    expect(MachineRpcClientRequestSchema.parse(request)).toEqual(request);
    expect(MachineRpcClientRequestSchema.safeParse({ ...request, attestation }).success).toBe(
      false,
    );
  });

  test("the plane-attested request carries strict requester claims", () => {
    expect(MachineRpcAttestedRequestSchema.parse({ ...request, attestation })).toEqual({
      ...request,
      attestation,
    });
    expect(
      MachineRpcAttestedRequestSchema.safeParse({
        ...request,
        attestation: {
          ...attestation,
          claims: {
            ...attestation.claims,
            requester: { ...attestation.claims.requester, organizationId: ORGANIZATION_ID },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("results are receipts, responses, or errors of RPC version 1", () => {
    const base = { rpcVersion: 1, rpcId: RPC_ID, nodeId: NODE_ID };
    expect(MachineRpcResultSchema.parse({ kind: "receipt", ...base, receivedAt: AT }).kind).toBe(
      "receipt",
    );
    expect(
      MachineRpcResultSchema.parse({ kind: "response", ...base, completedAt: AT, payload: null })
        .kind,
    ).toBe("response");
    expect(
      MachineRpcResultSchema.parse({ kind: "error", ...base, code: "access_denied", message: "" })
        .kind,
    ).toBe("error");
    expect(
      MachineRpcResultSchema.safeParse({ kind: "receipt", ...base, rpcVersion: 2, receivedAt: AT })
        .success,
    ).toBe(false);
  });

  test("rejects method names outside the dotted namespace form", () => {
    expect(MachineRpcClientRequestSchema.safeParse({ ...request, method: "send" }).success).toBe(
      false,
    );
    expect(
      MachineRpcClientRequestSchema.safeParse({ ...request, method: "agent.Send" }).success,
    ).toBe(false);
  });
});

describe("stream tokens and subscriptions", () => {
  const claims = {
    tokenId: "tok-1",
    organizationId: ORGANIZATION_ID,
    principalId: PRINCIPAL_ID,
    credentialId: "cred-1",
    clientId: "client-1",
    grantVersion: "g1",
    revocationEpoch: 0,
    containerIds: [WORKSPACE_UID, BOARD_ID],
    issuedAt: AT,
    expiresAt: AT,
  };

  test("stream token claims are strict and name at least one container", () => {
    expect(StreamTokenClaimsSchema.parse(claims)).toEqual(claims);
    expect(StreamTokenClaimsSchema.safeParse({ ...claims, role: "owner" }).success).toBe(false);
    expect(StreamTokenClaimsSchema.safeParse({ ...claims, containerIds: [] }).success).toBe(false);
  });

  test("subscription events cover data, control, presence, and revocation", () => {
    const offset = "00000000000000000042";
    const events = [
      { type: "data", containerId: WORKSPACE_UID, segment: "meta", offset, update: "AQID" },
      {
        type: "control",
        containerId: WORKSPACE_UID,
        segment: "meta",
        nextOffset: offset,
        lowerBoundOffset: "00000000000000000000",
        upToDate: true,
      },
      {
        type: "presence",
        containerId: WORKSPACE_UID,
        entries: [
          {
            kind: "principal",
            principalId: PRINCIPAL_ID,
            clientId: "client-1",
            focusAgentId: null,
            heartbeatAt: AT,
          },
          { kind: "node", nodeId: NODE_ID, heartbeatAt: AT },
        ],
      },
      { type: "revoked", containerId: WORKSPACE_UID, reason: "membership_removed" },
    ];

    for (const event of events) {
      expect(CollabSubscriptionEventSchema.parse(event)).toEqual(event);
    }
    expect(CollabSubscriptionEventSchema.safeParse({ ...events[0], offset: "42" }).success).toBe(
      false,
    );
  });
});
