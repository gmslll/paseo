import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "../messages.js";
import {
  DAEMON_PERMISSIONS,
  OWNER_PERMISSIONS,
  SessionAuthorization,
  closeActiveDaemonPermission,
  consumeCurrentInboundDaemonAuthorizationDecision,
  consumeInboundDaemonAuthorizationDecision,
  isActiveDaemonPermissionCurrent,
  issueActiveDaemonPermission,
  permissionsForLegacyHubScopes,
  parseDaemonPermissions,
} from "./index.js";
import {
  type PermissionRequirement,
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

function inboundOperationTypes(): SessionInboundMessage["type"][] {
  return SessionInboundMessageSchema.options.map((option) => option.shape.type.value);
}

function outboundOperationTypes(): SessionOutboundMessage["type"][] {
  return SessionOutboundMessageSchema.options.map((option) => option.shape.type.value);
}

function inboundMessage(type: SessionInboundMessage["type"]): SessionInboundMessage {
  return { type } as SessionInboundMessage;
}

function outboundMessage(type: SessionOutboundMessage["type"]): SessionOutboundMessage {
  if (type === "status")
    return {
      type,
      payload: { status: "agent_create_failed", error: "test", requestId: "test" },
    } as SessionOutboundMessage;
  return { type } as SessionOutboundMessage;
}

describe("SessionAuthorization", () => {
  test("enterprise operations have explicit coarse permission requirements", () => {
    const inboundRequirements = {
      "enterprise.access.list_grants.request": "workspace.read",
      "enterprise.access.update_grants.request": "workspace.write",
      "enterprise.audit.list_events.request": "workspace.read",
      "enterprise.browser.bind_profile.request": "workspace.write",
      "enterprise.browser.list_profiles.request": "workspace.read",
      "enterprise.identity.get_current.request": null,
      "enterprise.identity.list_principals.request": "workspace.read",
      "enterprise.identity.logout_all.request": null,
      "enterprise.node.list_nodes.request": "daemon.read",
      "enterprise.node.set_drain.request": "daemon.manage",
      "enterprise.organization.list_resources.request": "workspace.read",
      "enterprise.placement.resolve_workspace.request": "workspace.read",
      "enterprise.resource.acquire_lease.request": "workspace.write",
      "enterprise.resource.release_lease.request": "workspace.write",
      "enterprise.resource.renew_lease.request": "workspace.write",
    } as const satisfies Partial<Record<SessionInboundMessage["type"], PermissionRequirement>>;
    const outboundRequirements = {
      "enterprise.access.list_grants.response": "workspace.read",
      "enterprise.access.update_grants.response": "workspace.write",
      "enterprise.audit.list_events.response": "workspace.read",
      "enterprise.browser.bind_profile.response": "workspace.write",
      "enterprise.browser.list_profiles.response": "workspace.read",
      "enterprise.identity.credential_revoked": null,
      "enterprise.identity.get_current.response": null,
      "enterprise.identity.list_principals.response": "workspace.read",
      "enterprise.identity.logout_all.response": null,
      "enterprise.identity.scope_refreshed": null,
      "enterprise.node.list_nodes.response": "daemon.read",
      "enterprise.node.set_drain.response": "daemon.manage",
      "enterprise.organization.list_resources.response": "workspace.read",
      "enterprise.placement.resolve_workspace.response": "workspace.read",
      "enterprise.resource.acquire_lease.response": "workspace.write",
      "enterprise.resource.release_lease.response": "workspace.write",
      "enterprise.resource.renew_lease.response": "workspace.write",
      "enterprise.resource.status": "workspace.read",
      "enterprise.resource.waiting": "workspace.read",
    } as const satisfies Partial<Record<SessionOutboundMessage["type"], PermissionRequirement>>;

    for (const [operation, requirement] of Object.entries(inboundRequirements)) {
      expect(requiredPermissionForInbound(operation as SessionInboundMessage["type"])).toEqual(
        requirement,
      );
    }
    for (const [operation, requirement] of Object.entries(outboundRequirements)) {
      expect(
        requiredPermissionForOutbound(outboundMessage(operation as SessionOutboundMessage["type"])),
      ).toEqual(requirement);
    }
  });

  test("authenticated sessions retain identity self-control after all coarse permissions are removed", () => {
    const authorization = new SessionAuthorization([]);

    expect(
      authorization.allowsInbound(inboundMessage("enterprise.identity.get_current.request")),
    ).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("enterprise.identity.get_current.response")),
    ).toBe(true);
    expect(
      authorization.allowsInbound(inboundMessage("enterprise.identity.logout_all.request")),
    ).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("enterprise.identity.logout_all.response")),
    ).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("enterprise.identity.scope_refreshed")),
    ).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("enterprise.identity.credential_revoked")),
    ).toBe(true);
  });

  test("owner authority covers every session operation", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);

    expect(
      inboundOperationTypes().every((type) => authorization.allowsInbound(inboundMessage(type))),
    ).toBe(true);
    expect(
      outboundOperationTypes().every((type) => authorization.allowsOutbound(outboundMessage(type))),
    ).toBe(true);
  });

  test("semantic permissions authorize operations instead of RPC namespaces", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);

    expect(authorization.allowsInbound(inboundMessage("hub.execution.agent.create.request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("hub.execution.agent.update"))).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsInbound(inboundMessage("refresh_providers_snapshot_request"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("get_providers_snapshot_response"))).toBe(
      true,
    );
    expect(authorization.allowsOutbound(outboundMessage("providers_snapshot_update"))).toBe(true);
    expect(
      authorization.allowsOutbound(outboundMessage("refresh_providers_snapshot_response")),
    ).toBe(true);
    expect(authorization.allowsInbound(inboundMessage("get_daemon_config_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("provider_diagnostic_request"))).toBe(false);
    expect(authorization.allowsInbound(inboundMessage("ping"))).toBe(false);
    expect(
      authorization.allowsInbound(inboundMessage("hub.management.daemon.get_status.request")),
    ).toBe(false);
  });

  test("Hub can operate ordinary agents and recover workspaces without daemon administration", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    for (const type of [
      "create_agent_request",
      "send_agent_message_request",
      "fetch_agent_request",
      "agent.timeline.set_subscription.request",
      "workspace.recovery.inspect.request",
      "workspace.recovery.restore.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(true);
    }
    for (const type of [
      "status",
      "agent_update",
      "agent_stream",
      "send_agent_message_response",
      "workspace.recovery.restore.response",
    ] as const) {
      expect(authorization.allowsOutbound(outboundMessage(type))).toBe(true);
    }
    for (const type of [
      "restart_server_request",
      "terminal_input",
      "hub.management.daemon.permissions.update.request",
    ] as const) {
      expect(authorization.allowsInbound(inboundMessage(type))).toBe(false);
    }
    expect(
      authorization.allowsOutbound({
        type: "status",
        payload: { status: "shutdown_requested", clientId: "owner", requestId: "shutdown" },
      }),
    ).toBe(false);
    authorization.replacePermissions([]);
    expect(authorization.allowsInbound(inboundMessage("send_agent_message_request"))).toBe(false);
    expect(authorization.allowsOutbound(outboundMessage("agent_update"))).toBe(false);
  });

  test("correlated authorization errors can always be emitted", () => {
    const authorization = new SessionAuthorization([]);

    expect(authorization.allowsOutbound(outboundMessage("rpc_error"))).toBe(true);
  });

  test("legacy Hub authority is translated at one compatibility boundary", () => {
    expect(permissionsForLegacyHubScopes(["hub.execution.*"])).toEqual(["hub.execute"]);
    expect(permissionsForLegacyHubScopes(["*"])).toEqual([]);
  });

  test("permission names are semantic", () => {
    expect(
      DAEMON_PERMISSIONS.every(
        (permission) => !permission.includes("*") && !permission.includes("request"),
      ),
    ).toBe(true);
  });

  test("permission parsing validates against the shared registry and removes duplicates", () => {
    expect(parseDaemonPermissions(["hub.execute", "hub.execute"])).toEqual(["hub.execute"]);
    expect(() => parseDaemonPermissions(["hub.execution.*"])).toThrow("Invalid daemon permission");
  });

  test("issues an opaque exact-message decision when any required daemon permission succeeds", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    const allowed = inboundMessage("create_agent_request");

    const decision = authorization.authorizeInbound(allowed);

    expect(decision).not.toBeNull();
    expect(Object.keys(decision!)).toEqual([]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(authorization.authorizeInbound(inboundMessage("restart_server_request"))).toBeNull();
    expect(new SessionAuthorization([]).authorizeInbound(allowed)).toBeNull();
  });

  test("consumes a daemon decision once for its exact message and permission generation", () => {
    const authorization = new SessionAuthorization(["hub.execute"]);
    const message = inboundMessage("create_agent_request");
    const wrongMessageDecision = authorization.authorizeInbound(message)!;

    expect(
      consumeInboundDaemonAuthorizationDecision(
        authorization,
        inboundMessage("create_agent_request"),
        wrongMessageDecision,
      ),
    ).toBeNull();
    expect(
      consumeInboundDaemonAuthorizationDecision(authorization, message, wrongMessageDecision),
    ).toBeNull();

    const replacedDecision = authorization.authorizeInbound(message)!;
    authorization.replacePermissions(["hub.execute"]);
    expect(
      consumeInboundDaemonAuthorizationDecision(authorization, message, replacedDecision),
    ).toBeNull();

    const currentDecision = authorization.authorizeInbound(message)!;
    const consumed = consumeInboundDaemonAuthorizationDecision(
      authorization,
      message,
      currentDecision,
    );
    expect(consumed).toEqual({
      requestType: "create_agent_request",
      daemonPermission: ["workspace.write", "hub.execute"],
    });
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed?.daemonPermission)).toBe(true);
    expect(
      consumeCurrentInboundDaemonAuthorizationDecision(
        authorization,
        message,
        message.type,
        consumed!,
      ),
    ).toBe(true);
    expect(
      consumeCurrentInboundDaemonAuthorizationDecision(
        authorization,
        message,
        message.type,
        consumed!,
      ),
    ).toBe(false);
    expect(
      consumeInboundDaemonAuthorizationDecision(authorization, message, currentDecision),
    ).toBeNull();
  });

  test("invalidates an opaque daemon permission handle on every permission replacement", () => {
    const authorization = new SessionAuthorization(["workspace.read"]);
    const handle = issueActiveDaemonPermission(authorization, "workspace.read");

    expect(handle).not.toBeNull();
    expect(Object.keys(handle!)).toEqual([]);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(isActiveDaemonPermissionCurrent(authorization, handle!, "workspace.read")).toBe(true);
    expect(isActiveDaemonPermissionCurrent(authorization, handle!, "workspace.write")).toBe(false);
    expect(
      isActiveDaemonPermissionCurrent(
        new SessionAuthorization(["workspace.read"]),
        handle!,
        "workspace.read",
      ),
    ).toBe(false);

    authorization.replacePermissions(["workspace.read"]);
    expect(isActiveDaemonPermissionCurrent(authorization, handle!, "workspace.read")).toBe(false);

    const current = issueActiveDaemonPermission(authorization, "workspace.read")!;
    expect(closeActiveDaemonPermission(authorization, current)).toBe(true);
    expect(closeActiveDaemonPermission(authorization, current)).toBe(false);
    expect(isActiveDaemonPermissionCurrent(authorization, current, "workspace.read")).toBe(false);
    expect(issueActiveDaemonPermission(authorization, "workspace.write")).toBeNull();
  });
});
