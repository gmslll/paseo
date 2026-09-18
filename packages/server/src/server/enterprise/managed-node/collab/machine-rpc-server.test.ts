import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signMachineRpcAttestation } from "@getpaseo/enterprise-management";
import type {
  MachineRpcAttestationClaims,
  WorkspaceMemberRole,
} from "@getpaseo/protocol/enterprise-collaboration";
import type {
  PrincipalContext,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { collabPaths, ensureCollabRepoPath } from "./collab-paths.js";
import { CollabRepoStore } from "./loro-repo-store.js";
import { MachineRpcServer, type HeadlessSession } from "./machine-rpc-server.js";

const NODE_ID = "nod_0123456789abcdef";
const ORG_ID = "org_0123456789abcdef";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const CONTAINER = "cws_0123456789abcdef";
const RPC_ID = "rpc_0123abcd-0123-0123-0123-0123456789ab";
const SENT_AT = "2025-06-01T00:00:00.000Z";
const EXPIRES_AT = "2025-06-01T00:01:00.000Z";

const planeKeys = generateKeyPairSync("ed25519");

let directory: string;
let store: CollabRepoStore;
let clock: number;
let role: WorkspaceMemberRole | null;
let known: boolean;
let dispatched: SessionInboundMessage[];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "machine-rpc-"));
  clock = Date.parse(SENT_AT);
  role = "editor";
  known = true;
  dispatched = [];
  store = CollabRepoStore.open({
    path: ensureCollabRepoPath(collabPaths(directory), CONTAINER),
    now: () => clock,
  });
  store.beginProducerEpoch(`rpc:res:${RPC_ID}`, NODE_ID);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function claims(overrides: Partial<MachineRpcAttestationClaims> = {}): MachineRpcAttestationClaims {
  return {
    rpcId: RPC_ID,
    method: "agent.send",
    nodeId: NODE_ID,
    containerId: CONTAINER,
    requester: {
      principalId: PRINCIPAL_ID,
      credentialId: "cred-1",
      grantVersion: "g1",
      clientId: "laptop-1",
    },
    sentAt: SENT_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

const PAYLOAD: SessionInboundMessage = {
  type: "send_agent_message_request",
  requestId: "r1",
  agentId: "agent-1",
  text: "hello",
} as SessionInboundMessage;

function envelope(input: { attestation: string; method?: string; rpcId?: string }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: "request",
      rpcVersion: 1,
      rpcId: input.rpcId ?? RPC_ID,
      method: input.method ?? "agent.send",
      nodeId: NODE_ID,
      containerId: CONTAINER,
      clientId: "laptop-1",
      sentAt: SENT_AT,
      expiresAt: EXPIRES_AT,
      payload: PAYLOAD,
      attestation: input.attestation,
    }),
  );
}

function server(): MachineRpcServer {
  return new MachineRpcServer({
    store,
    containerId: CONTAINER,
    nodeId: NODE_ID,
    organizationId: ORG_ID,
    ticketPublicKeyPem: planeKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    principals: {
      resolvePrincipal: async (principalId, organizationId) =>
        known && principalId === PRINCIPAL_ID && organizationId === ORG_ID
          ? ({
              principalType: "human",
              principalId: PRINCIPAL_ID,
              organizationId: ORG_ID,
              grants: [],
              grantVersion: "g1",
            } as Omit<PrincipalContext, "credentialId">)
          : null,
    },
    sessions: {
      open: ({ onMessage }): HeadlessSession => ({
        handleMessage: async (message) => {
          dispatched.push(message);
          onMessage({
            type: "send_agent_message_response",
            payload: { requestId: "r1", accepted: true },
          } as SessionOutboundMessage);
        },
        close: () => undefined,
      }),
    },
    roleOf: () => role,
    now: () => clock,
  });
}

/** What the node actually published for the caller to read back. */
function published(): Array<Record<string, unknown>> {
  return store
    .listPendingUpdates(`rpc:res:${RPC_ID}`)
    .map((entry) => JSON.parse(new TextDecoder().decode(entry.update)) as Record<string, unknown>);
}

describe("running an attested request", () => {
  test("receipts it, dispatches it, and answers on its own segment", async () => {
    const handled = await server().handle(
      envelope({ attestation: signMachineRpcAttestation(claims(), planeKeys.privateKey) }),
    );

    expect(handled?.rpcId).toBe(RPC_ID);
    expect(dispatched).toEqual([PAYLOAD]);
    const results = published();
    expect(results.map((entry) => entry.kind)).toEqual(["receipt", "response"]);
    // The answer is the Session's own reply to that request, not something this module composed.
    expect((results[1]!.payload as Record<string, unknown>).type).toBe(
      "send_agent_message_response",
    );
  });

  test("acts on an rpcId once, however many times the stream replays it", async () => {
    const attestation = signMachineRpcAttestation(claims(), planeKeys.privateKey);
    const subject = server();
    await subject.handle(envelope({ attestation }));

    const again = await subject.handle(envelope({ attestation }));

    // A reconnect replays the segment from the cursor; acting twice is what the inbox prevents.
    expect(again).toBeNull();
    expect(dispatched).toHaveLength(1);
  });
});

describe("refusing what it should not run", () => {
  test("refuses an attestation signed by another key and dispatches nothing", async () => {
    const impostor = generateKeyPairSync("ed25519");

    const handled = await server().handle(
      envelope({ attestation: signMachineRpcAttestation(claims(), impostor.privateKey) }),
    );

    expect(handled!.results.map((entry) => entry.kind)).toEqual(["error"]);
    expect(dispatched).toHaveLength(0);
  });

  test("refuses a requester this node no longer knows", async () => {
    known = false;

    const handled = await server().handle(
      envelope({ attestation: signMachineRpcAttestation(claims(), planeKeys.privateKey) }),
    );

    expect(published()[0]).toMatchObject({ kind: "error", code: "principal_unavailable" });
    expect(handled!.results).toHaveLength(1);
  });

  test("refuses a method the caller's current role does not hold", async () => {
    // The plane signed against the membership it had; this node has since learned of a change.
    role = "viewer";

    await server().handle(
      envelope({ attestation: signMachineRpcAttestation(claims(), planeKeys.privateKey) }),
    );

    expect(published()[0]).toMatchObject({ kind: "error", code: "method_denied" });
    expect(dispatched).toHaveLength(0);
  });

  test("refuses an attestation whose Grant version has moved on", async () => {
    const stale = signMachineRpcAttestation(
      claims({ requester: { ...claims().requester, grantVersion: "g0" } }),
      planeKeys.privateKey,
    );

    await server().handle(envelope({ attestation: stale }));

    // Revocation reaches a node as a policy refresh, and that rolls the version compared here.
    expect(published()[0]).toMatchObject({ kind: "error", code: "revoked" });
    expect(dispatched).toHaveLength(0);
  });

  test("ignores bytes that are not an envelope", async () => {
    expect(await server().handle(new TextEncoder().encode("{ not an envelope"))).toBeNull();
    expect(published()).toHaveLength(0);
  });
});
