import { describe, expect, test } from "vitest";

import { ManagedNodeLifecycle } from "./lifecycle.js";

const NODE = "nod_0123456789abcdef";

describe("ManagedNodeLifecycle", () => {
  test("refreshes policy, heartbeats, and uploads a contiguous audit tail", async () => {
    const order: string[] = [];
    const uploaded: number[][] = [];
    const client = {
      relationship: { node: { nodeId: NODE } },
      heartbeat: async () => {
        order.push("heartbeat");
        return {};
      },
      shutdown: async (input: unknown) => {
        order.push(`shutdown:${JSON.stringify(input)}`);
        return {};
      },
      auditState: async () => ({ lastSequence: 1 }),
      uploadAudit: async (events: readonly { nodeEventSeq: number }[]) => {
        uploaded.push(events.map((event) => event.nodeEventSeq));
        return { accepted: events.length, duplicates: 0, gaps: [], lastSequence: 3 };
      },
    };
    const lifecycle = new ManagedNodeLifecycle({
      client: client as never,
      refreshPolicy: async () => {
        order.push("policy");
      },
      heartbeat: () => heartbeat(),
      audit: {
        flush: async () => {
          order.push("audit.flush");
        },
        snapshotEvents: async () => [auditEvent(1), auditEvent(2), auditEvent(3)],
      },
      scheduler: schedulerWithoutTicks(),
    });

    await lifecycle.ready();
    expect(order).toEqual(["policy", "heartbeat", "audit.flush"]);
    expect(uploaded).toEqual([[2, 3]]);
    await lifecycle.close();
    expect(order).toEqual([
      "policy",
      "heartbeat",
      "audit.flush",
      'shutdown:{"bootId":"boot-a","paseoServerId":"server-a"}',
    ]);
  });

  test("fails closed on a local or remote audit gap", async () => {
    const base = {
      heartbeat: async () => ({}),
      shutdown: async () => ({}),
      auditState: async () => ({ lastSequence: 0 }),
      uploadAudit: async () => ({ accepted: 0, duplicates: 0, lastSequence: 0, gaps: [] }),
    };
    const lifecycle = new ManagedNodeLifecycle({
      client: base as never,
      refreshPolicy: async () => undefined,
      heartbeat: () => heartbeat(),
      audit: { flush: async () => undefined, snapshotEvents: async () => [auditEvent(2)] },
      scheduler: schedulerWithoutTicks(),
    });
    await expect(lifecycle.ready()).rejects.toThrow("local audit sequence gap");
    await lifecycle.close();

    const remoteGap = new ManagedNodeLifecycle({
      client: {
        ...base,
        uploadAudit: async () => ({
          accepted: 0,
          duplicates: 0,
          lastSequence: 0,
          gaps: [{ expected: 1, received: 2 }],
        }),
      } as never,
      refreshPolicy: async () => undefined,
      heartbeat: () => heartbeat(),
      audit: { flush: async () => undefined, snapshotEvents: async () => [auditEvent(1)] },
      scheduler: schedulerWithoutTicks(),
    });
    await expect(remoteGap.ready()).rejects.toThrow("management audit sequence gap");
    await remoteGap.close();
  });

  test("installs one placement snapshot source and synchronizes before returning", async () => {
    const synchronized: unknown[] = [];
    const client = {
      heartbeat: async () => ({}),
      shutdown: async () => ({}),
      auditState: async () => ({ lastSequence: 0 }),
      uploadAudit: async () => ({ accepted: 0, duplicates: 0, lastSequence: 0, gaps: [] }),
      synchronizePlacements: async (placements: readonly unknown[]) => {
        synchronized.push(structuredClone(placements));
        return [];
      },
    };
    const lifecycle = new ManagedNodeLifecycle({
      client: client as never,
      refreshPolicy: async () => undefined,
      heartbeat: () => heartbeat(),
      audit: { flush: async () => undefined, snapshotEvents: async () => [] },
      scheduler: schedulerWithoutTicks(),
    });
    const placements = [
      {
        resource: {
          organizationId: "org_0123456789abcdef",
          nodeId: NODE,
          resourceKind: "workspace" as const,
          localResourceId: "workspace-a",
        },
        ownerPrincipalId: "usr_0123456789abcdef",
      },
    ];
    await lifecycle.installPlacementSource(async () => placements);
    expect(synchronized).toEqual([placements]);
    await expect(lifecycle.installPlacementSource(async () => [])).rejects.toThrow(
      "already installed",
    );
    await lifecycle.close();
  });
});

function heartbeat() {
  return {
    bootId: "boot-a",
    paseoServerId: "server-a",
    endpoint: "wss://node-a.test:6767",
    version: "0.8.0",
    capabilities: { platform: "darwin" },
    capacity: {
      cpuLogical: 8,
      memoryTotalBytes: 16,
      memoryAvailableBytes: 8,
      activeAgents: 0,
      activeBrowserProfiles: 0,
    },
  };
}

function auditEvent(sequence: number) {
  return {
    eventId: `evt_${sequence}`,
    occurredAt: "2026-09-12T00:00:00.000Z",
    organizationId: "org_0123456789abcdef",
    nodeId: NODE,
    nodeEventSeq: sequence,
    actorPrincipalId: "usr_0123456789abcdef",
    action: "workspace.metadata.read",
    resource: { kind: "workspace", id: "workspace-a" },
    outcome: "allowed" as const,
  };
}

function schedulerWithoutTicks() {
  return {
    setInterval: () => ({ unref() {} }),
    clearInterval: () => undefined,
  };
}
