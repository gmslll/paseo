import { describe, expect, test } from "vitest";

import { ENTERPRISE_ACTIONS, SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { INBOUND_PERMISSION } from "../../authorization/operation-permissions.js";
import {
  ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES,
  OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS,
  OUTBOUND_EVENTS_WITHOUT_RESOURCE_POLICY,
  OUTBOUND_OWNERSHIP_TRANSFER_TOMBSTONE_EVENTS,
  OUTBOUND_RESOURCE_ACTION_MAP,
  OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS,
  authorityReceiptPolicyForEvent,
  authorityReceiptPolicyForRequestType,
  isMatchingTransportControl,
  outboundActionsFor,
} from "./event-action-map.js";

function outbound(
  type: Parameters<typeof outboundActionsFor>[0]["type"],
): Parameters<typeof outboundActionsFor>[0] {
  return { type } as Parameters<typeof outboundActionsFor>[0];
}

function outboundTypes(): string[] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value).sort();
}

describe("outbound enterprise event-action map", () => {
  test("classifies every outbound event exactly once", () => {
    const resourceEvents = [...OUTBOUND_RESOURCE_ACTION_MAP.keys()];
    const dynamicResourceEvents = [...OUTBOUND_DYNAMIC_RESOURCE_POLICY_EVENTS];
    const operationOnlyEvents = [...OUTBOUND_EVENTS_WITHOUT_RESOURCE_POLICY];
    const transferTombstoneEvents = [...OUTBOUND_OWNERSHIP_TRANSFER_TOMBSTONE_EVENTS];
    const transportEvents = [...OUTBOUND_TRANSPORT_CONTROL_ONLY_EVENTS];
    const classified = [
      ...resourceEvents,
      ...dynamicResourceEvents,
      ...operationOnlyEvents,
      ...transferTombstoneEvents,
      ...transportEvents,
    ];

    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.sort()).toEqual(outboundTypes());
  });

  test("keeps transfer tombstones outside ordinary post-CAS resource policy", () => {
    expect(OUTBOUND_OWNERSHIP_TRANSFER_TOMBSTONE_EVENTS).toEqual([
      "enterprise.workspace.ownership.transfer.tombstone",
    ]);
    expect(Object.isFrozen(OUTBOUND_OWNERSHIP_TRANSFER_TOMBSTONE_EVENTS)).toBe(true);
    expect(
      OUTBOUND_RESOURCE_ACTION_MAP.has("enterprise.workspace.ownership.transfer.tombstone"),
    ).toBe(false);
    expect(
      OUTBOUND_EVENTS_WITHOUT_RESOURCE_POLICY.includes(
        "enterprise.workspace.ownership.transfer.tombstone" as never,
      ),
    ).toBe(false);
    expect(
      outboundActionsFor(
        outbound("enterprise.workspace.ownership.transfer.tombstone"),
        "workspace",
      ),
    ).toEqual([]);
  });

  test("contains only frozen EnterpriseAction V1 values", () => {
    const actions = new Set(ENTERPRISE_ACTIONS);
    for (const policy of OUTBOUND_RESOURCE_ACTION_MAP.values()) {
      for (const values of Object.values(policy)) {
        expect(values.every((action) => actions.has(action))).toBe(true);
      }
    }
  });

  test("pairs every authority receipt with one exact request and its coarse permission", () => {
    const keys = ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map(
      (policy) => `${policy.event}:${policy.status ?? ""}:${policy.requestType}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const policy of ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES) {
      expect(policy.daemonPermission).toEqual(INBOUND_PERMISSION[policy.requestType]);
      expect(authorityReceiptPolicyForRequestType(policy.requestType)).toMatchObject({
        requestType: policy.requestType,
        daemonPermission: policy.daemonPermission,
        enterpriseActions: policy.enterpriseActions,
      });
      expect(["repeatable", "terminal"]).toContain(policy.emission);
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.enterpriseActions)).toBe(true);
      if (Array.isArray(policy.daemonPermission)) {
        expect(Object.isFrozen(policy.daemonPermission)).toBe(true);
      }
    }
    expect(Object.isFrozen(ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES)).toBe(true);
    expect(authorityReceiptPolicyForRequestType("fetch_agent_request")).toBeNull();
    expect(authorityReceiptPolicyForRequestType("future.unknown.request")).toBeNull();

    expect(
      authorityReceiptPolicyForEvent({
        type: "status",
        payload: { status: "restart_requested", clientId: "client", requestId: "request" },
      }),
    ).toMatchObject({ requestType: "restart_server_request" });
    expect(
      authorityReceiptPolicyForEvent({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "client", requestId: "request" },
      }),
    ).toMatchObject({ requestType: "shutdown_server_request" });
    expect(
      authorityReceiptPolicyForEvent({
        type: "status",
        payload: { status: "daemon_config_changed", config: {} },
      } as never),
    ).toBeNull();

    expect(
      authorityReceiptPolicyForEvent({
        type: "daemon.update.progress",
        payload: { requestId: "request", phase: "installing" },
      }),
    ).toMatchObject({ requestType: "daemon.update.request", emission: "repeatable" });
    expect(
      authorityReceiptPolicyForEvent({
        type: "daemon.update.response",
        payload: {
          requestId: "request",
          success: true,
          error: null,
          previousVersion: "1",
          newVersion: "2",
        },
      }),
    ).toMatchObject({ requestType: "daemon.update.request", emission: "terminal" });
    expect(
      authorityReceiptPolicyForEvent({
        type: "rpc_error",
        payload: {
          requestId: "request",
          requestType: "daemon.update.request",
          error: "redacted",
        },
      }),
    ).toMatchObject({
      event: "rpc_error",
      requestType: "daemon.update.request",
      emission: "terminal",
    });
  });

  test("keeps content, runtime, and execution-resource actions distinct", () => {
    expect(outboundActionsFor(outbound("agent_stream"), "agent")).toEqual([
      "workspace.content.read",
    ]);
    expect(outboundActionsFor(outbound("terminal_stream_exit"), "agent")).toEqual(["terminal.use"]);
    expect(outboundActionsFor(outbound("workspace.script.start.response"), "workspace")).toEqual([
      "workspace.script.execute",
    ]);
    expect(
      outboundActionsFor(outbound("browser.automation.execute.request"), "browser_profile"),
    ).toEqual(["browser.use"]);
    expect(outboundActionsFor(outbound("get_daemon_config_response"), "browser_profile")).toEqual(
      [],
    );
  });

  test("classifies only Agent status subtypes as resource-scoped", () => {
    expect(
      outboundActionsFor(
        {
          type: "status",
          payload: { status: "agent_create_failed", requestId: "req", error: "redacted" },
        },
        "workspace",
      ),
    ).toEqual(["workspace.write"]);
    expect(
      outboundActionsFor(
        {
          type: "status",
          payload: { status: "daemon_config_changed", config: {} },
        } as never,
        "workspace",
      ),
    ).toEqual([]);
    expect(
      outboundActionsFor(
        { type: "rpc_error", payload: { requestId: "req", error: "redacted" } },
        "workspace",
      ),
    ).toEqual([]);
    expect(
      outboundActionsFor(
        {
          type: "rpc_error",
          payload: {
            requestId: "req",
            requestType: "fetch_agent_request",
            error: "redacted",
          },
        },
        "workspace",
      ),
    ).toEqual(["workspace.content.read"]);
  });

  test("matches server_info by its status payload instead of its outer event type", () => {
    expect(
      isMatchingTransportControl(
        {
          type: "status",
          payload: { status: "server_info", serverId: "srv_test" },
        },
        "server_info",
      ),
    ).toBe(true);
    expect(
      isMatchingTransportControl(
        {
          type: "status",
          payload: { status: "shutdown_requested", clientId: "client", requestId: "request" },
        },
        "server_info",
      ),
    ).toBe(false);
  });
});
