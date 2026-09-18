import { describe, expect, test } from "vitest";

import type {
  MachineRpcClientRequest,
  MachineRpcResult,
} from "@getpaseo/protocol/enterprise-collaboration";

import { MachineRpcClient, type MachineRpcTransport } from "./machine-rpc-client.js";

const CONTAINER = "cws_0123456789abcdef";
const NODE = "nod_0123456789abcdef";
const RPC_ID = "rpc_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function transport(): MachineRpcTransport & {
  sent: MachineRpcClientRequest[];
  emit(result: MachineRpcResult): void;
} {
  const listeners = new Map<string, (result: MachineRpcResult) => void>();
  return {
    sent: [],
    async append(request) {
      this.sent.push(request);
    },
    subscribe(rpcId, onResult) {
      listeners.set(rpcId, onResult);
      return () => listeners.delete(rpcId);
    },
    emit(result) {
      listeners.get(result.rpcId)?.(result);
    },
  };
}

describe("machine RPC client", () => {
  test("refuses a method the table does not list, and does not append", async () => {
    const bus = transport();
    const client = new MachineRpcClient({ transport: bus, randomId: () => RPC_ID });

    await expect(
      client.call({
        method: "agent.delete",
        nodeId: NODE,
        containerId: CONTAINER,
        clientId: "client-1",
        payload: {},
      }),
    ).rejects.toThrow(/Unknown machine RPC method/);
    expect(bus.sent).toEqual([]);
  });

  test("ignores the receipt and returns the node's response", async () => {
    const bus = transport();
    const client = new MachineRpcClient({
      transport: bus,
      randomId: () => RPC_ID,
      now: () => Date.parse("2026-09-17T00:00:00.000Z"),
    });

    const pending = client.call({
      method: "agent.send",
      nodeId: NODE,
      containerId: CONTAINER,
      clientId: "client-1",
      payload: {
        type: "send_agent_message_request",
        agentId: "agent-1",
        text: "hi",
        requestId: "r1",
      },
    });
    await Promise.resolve();
    expect(bus.sent).toHaveLength(1);
    expect(bus.sent[0]?.method).toBe("agent.send");
    bus.emit({
      kind: "receipt",
      rpcVersion: 1,
      rpcId: RPC_ID,
      nodeId: NODE,
      receivedAt: "2026-09-17T00:00:01.000Z",
    });
    bus.emit({
      kind: "response",
      rpcVersion: 1,
      rpcId: RPC_ID,
      nodeId: NODE,
      completedAt: "2026-09-17T00:00:02.000Z",
      payload: { ok: true },
    });

    await expect(pending).resolves.toMatchObject({ kind: "response", payload: { ok: true } });
  });

  test("times out when the node never answers", async () => {
    const bus = transport();
    const client = new MachineRpcClient({
      transport: bus,
      randomId: () => RPC_ID,
      timeoutMs: 5,
      now: () => Date.parse("2026-09-17T00:00:00.000Z"),
    });

    const result = await client.call({
      method: "agent.send",
      nodeId: NODE,
      containerId: CONTAINER,
      clientId: "client-1",
      payload: {},
    });

    expect(result).toMatchObject({ kind: "error", code: "timeout" });
  });
});
