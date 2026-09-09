import { describe, expect, test } from "vitest";

import {
  ENTERPRISE_ACTIONS,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "@getpaseo/protocol/messages";
import {
  INBOUND_PERMISSION,
  OUTBOUND_PERMISSION,
} from "../../authorization/operation-permissions.js";
import { OUTBOUND_AUTHORITY_RECEIPT_POLICIES } from "./event-action-map.js";
import {
  ENTERPRISE_ENTRY_INVENTORY,
  ENTERPRISE_ENTRY_INVENTORY_FIELDS,
  REVIEWED_INBOUND_ENTRIES,
  entriesForSurface,
} from "./entry-inventory.js";

function schemaTypes(
  schema: typeof SessionInboundMessageSchema | typeof SessionOutboundMessageSchema,
): string[] {
  return schema.options.map((option) => option.shape.type.value).sort();
}

describe("enterprise entry inventory", () => {
  test("uses exactly the fixed twelve fields for every entry", () => {
    expect(ENTERPRISE_ENTRY_INVENTORY_FIELDS).toHaveLength(12);
    for (const item of ENTERPRISE_ENTRY_INVENTORY) {
      expect(Object.keys(item)).toEqual(ENTERPRISE_ENTRY_INVENTORY_FIELDS);
    }
  });

  test("requires explicit review of every inbound and outbound union member", () => {
    expect([...REVIEWED_INBOUND_ENTRIES].sort()).toEqual(Object.keys(INBOUND_PERMISSION).sort());
    expect([...REVIEWED_INBOUND_ENTRIES].sort()).toEqual(schemaTypes(SessionInboundMessageSchema));

    const inbound = entriesForSurface("session_inbound").map((item) => item.entry);
    const outbound = entriesForSurface("session_outbound").map((item) => item.entry);
    expect(new Set(inbound).size).toBe(inbound.length);
    expect(new Set(outbound).size).toBe(outbound.length);
    expect(inbound.sort()).toEqual(Object.keys(INBOUND_PERMISSION).sort());
    expect(outbound.sort()).toEqual(Object.keys(OUTBOUND_PERMISSION).sort());
    expect(outbound.sort()).toEqual(schemaTypes(SessionOutboundMessageSchema));
  });

  test("keeps authority receipts paired with an exact reviewed request policy", () => {
    const inboundTypes = new Set(REVIEWED_INBOUND_ENTRIES);
    for (const policy of OUTBOUND_AUTHORITY_RECEIPT_POLICIES) {
      expect(inboundTypes.has(policy.requestType)).toBe(true);
      expect(policy.daemonPermission).toEqual(INBOUND_PERMISSION[policy.requestType]);
      const item = entriesForSurface("session_outbound").find(
        (candidate) => candidate.entry === policy.event,
      );
      expect(item?.authoritySource).toBe("authority_receipt");
      expect(item?.wiringGap).toBe("runtime_call_site");
    }

    for (const entry of [
      "enterprise.identity.get_current.response",
      "enterprise.identity.logout_all.response",
      "enterprise.identity.scope_refreshed",
      "enterprise.identity.credential_revoked",
    ]) {
      const item = entriesForSurface("session_outbound").find(
        (candidate) => candidate.entry === entry,
      );
      expect(item?.authoritySource).toBe("authority_receipt");
      expect(item?.wiringGap).toBe("runtime_call_site");
    }

    expect(ENTERPRISE_ENTRY_INVENTORY.map((item) => item.wiringGap)).not.toContain(
      "authority_context_contract",
    );
    expect(
      entriesForSurface("session_outbound").find((item) => item.entry === "status"),
    ).toMatchObject({ authoritySource: "authority_receipt", wiringGap: "runtime_call_site" });
  });

  test("contains only frozen actions and marks uncorrelated resource entries fail closed", () => {
    const actions = new Set(ENTERPRISE_ACTIONS);
    for (const item of ENTERPRISE_ENTRY_INVENTORY) {
      expect(item.enterpriseActions.every((action) => actions.has(action))).toBe(true);
    }
    for (const entry of [
      "dictation_stream_start",
      "dictation_stream_chunk",
      "dictation_stream_finish",
      "dictation_stream_cancel",
      "voice_audio_chunk",
      "register_push_token",
    ]) {
      const item = entriesForSurface("session_inbound").find(
        (candidate) => candidate.entry === entry,
      );
      expect(item?.workspaceIdPolicy).toBe("contract_blocked");
      expect(item?.wiringGap).toBe("resource_correlation");
    }
  });

  test("keeps non-union entry points explicit", () => {
    for (const surface of [
      "file_binary",
      "terminal_binary",
      "http_download",
      "push",
      "browser_broker",
      "websocket_direct_notification",
    ] as const) {
      expect(entriesForSurface(surface).length).toBeGreaterThan(0);
    }
  });
});
