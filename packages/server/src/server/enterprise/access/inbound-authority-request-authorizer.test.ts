import { describe, expect, test } from "vitest";

import {
  type DaemonPermission,
  type PrincipalContext,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { SessionInboundMessageSchema, type SessionInboundMessage } from "../../messages.js";
import {
  OWNER_PERMISSIONS,
  SessionAuthorization,
  type InboundDaemonAuthorizationDecision,
} from "../../authorization/index.js";
import {
  ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES,
  authorityReceiptPolicyForRequestType,
} from "./event-action-map.js";
import {
  InboundAuthorityRequestAuthorizer,
  isActiveAuthorizedRequestHandle,
  isInboundAuthoritySuccessEvidence,
} from "./inbound-authority-request-authorizer.js";
import type { PrincipalGrantVersionGuard } from "./resource-authorization.js";

const organizationId = "org_0123456789abcdef";
const foreignOrganizationId = "org_fedcba9876543210";

function principal(
  grants: PrincipalContext["grants"] = [],
): Extract<PrincipalContext, { principalType: "human" }> {
  return {
    principalType: "human",
    principalId: "usr_0123456789abcdef",
    organizationId,
    credentialId: "credential-a",
    grantVersion: "grant-a",
    grants,
  };
}

function inbound(
  type: SessionInboundMessage["type"],
  requestId = "request-a",
): SessionInboundMessage {
  return { type, requestId } as SessionInboundMessage;
}

function currentGuard(): PrincipalGrantVersionGuard {
  return { isCurrent: () => true };
}

function createAuthorizer(input: {
  authorization: SessionAuthorization;
  principal?: PrincipalContext;
  guard?: PrincipalGrantVersionGuard;
}): InboundAuthorityRequestAuthorizer {
  return new InboundAuthorityRequestAuthorizer({
    sessionAuthorization: input.authorization,
    principal: input.principal ?? principal(),
    grantVersionGuard: input.guard ?? currentGuard(),
  });
}

function authorize(
  authorizer: InboundAuthorityRequestAuthorizer,
  authorization: SessionAuthorization,
  type: SessionInboundMessage["type"],
) {
  const message = inbound(type);
  const decision = authorization.authorizeInbound(message);
  expect(decision).not.toBeNull();
  const pending = authorizer.authorize(message, decision!);
  if (!pending) return null;
  return authorizer.consumeForRegistration(message, pending);
}

describe("InboundAuthorityRequestAuthorizer", () => {
  test("produces canonical frozen evidence from fixed policy with no caller authority fields", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const actor = principal();
    const message = {
      type: "daemon.get_status.request",
      organizationId: foreignOrganizationId,
      principalId: "usr_fedcba9876543210",
      grantVersion: "caller-version",
      daemonPermission: "daemon.manage",
      enterpriseActions: ["identity.manage"],
      requestId: "request-a",
    } as unknown as SessionInboundMessage;
    const authorizer = createAuthorizer({ authorization, principal: actor });
    const decision = authorization.authorizeInbound(message)!;

    const pending = authorizer.authorize(message, decision);

    expect(pending).not.toBeNull();
    if (!pending) throw new Error("Expected pending authority evidence");
    expect(Object.keys(pending)).toEqual([]);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(isInboundAuthoritySuccessEvidence(pending)).toBe(true);
    expect(isInboundAuthoritySuccessEvidence(structuredClone(pending))).toBe(false);
    expect(isInboundAuthoritySuccessEvidence({ ...pending })).toBe(false);

    const evidence = authorizer.consumeForRegistration(message, pending);
    expect(evidence).not.toBeNull();
    if (!evidence) throw new Error("Expected authority success evidence");
    expect(evidence).toEqual({
      organizationId,
      principalId: actor.principalId,
      principalType: "human",
      credentialId: "credential-a",
      grantVersion: "grant-a",
      requestType: "daemon.get_status.request",
      requestId: "request-a",
      activeRequestHandle: evidence.activeRequestHandle,
      authorization: {
        succeeded: true,
        daemonPermission: "daemon.read",
        enterpriseActions: [],
      },
    });
    expect(evidence).not.toHaveProperty("receiptId");
    expect(Object.keys(evidence.activeRequestHandle)).toEqual([]);
    expect(Object.isFrozen(evidence.activeRequestHandle)).toBe(true);
    expect(isActiveAuthorizedRequestHandle(evidence.activeRequestHandle)).toBe(true);
    expect(isInboundAuthoritySuccessEvidence(pending)).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.authorization)).toBe(true);
    expect(Object.isFrozen(evidence.authorization.enterpriseActions)).toBe(true);
    expect(() => {
      (evidence as { organizationId: string }).organizationId = foreignOrganizationId;
    }).toThrow();
  });

  test("requires one matching daemon permission and rejects missing permission", () => {
    const allowed = new SessionAuthorization(["hub.execute"]);
    const message = inbound("create_agent_request");
    expect(allowed.authorizeInbound(message)).not.toBeNull();

    const denied = new SessionAuthorization([]);
    expect(denied.authorizeInbound(message)).toBeNull();

    const authorityOnly = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({ authorization: authorityOnly });
    expect(authorize(authorizer, authorityOnly, "daemon.get_status.request")).not.toBeNull();
  });

  test.each([
    ["identity.manage", "enterprise.access.list_grants.request", { kind: "self" }, false],
    [
      "identity.manage",
      "enterprise.access.list_grants.request",
      { kind: "workspace", workspaceIds: ["workspace-a"] },
      false,
    ],
    [
      "identity.manage",
      "enterprise.access.list_grants.request",
      { kind: "organization", organizationId: foreignOrganizationId },
      false,
    ],
    [
      "identity.manage",
      "enterprise.access.list_grants.request",
      { kind: "organization", organizationId },
      true,
    ],
    ["audit.read", "enterprise.audit.list_events.request", { kind: "self" }, false],
    [
      "audit.read",
      "enterprise.audit.list_events.request",
      { kind: "workspace", workspaceIds: ["workspace-a"] },
      false,
    ],
    [
      "audit.read",
      "enterprise.audit.list_events.request",
      { kind: "organization", organizationId: foreignOrganizationId },
      false,
    ],
    [
      "audit.read",
      "enterprise.audit.list_events.request",
      { kind: "organization", organizationId },
      true,
    ],
  ] as const)(
    "requires an exact organization selector for global action %s using %o",
    (action, requestType, selector, expected) => {
      const policy = authorityReceiptPolicyForRequestType(requestType);
      const requirement = policy?.daemonPermission;
      expect(typeof requirement).toBe("string");
      const authorization = new SessionAuthorization([requirement as DaemonPermission]);
      const authorizer = createAuthorizer({
        authorization,
        principal: principal([{ action, selector: selector as ResourceSelector }]),
      });

      expect(authorize(authorizer, authorization, requestType) !== null).toBe(expected);
    },
  );

  test("requires the policy's exact enterprise action", () => {
    const deniedAuthorization = new SessionAuthorization(["workspace.read"]);
    const deniedAuthorizer = createAuthorizer({
      authorization: deniedAuthorization,
      principal: principal([
        {
          action: "audit.read",
          selector: { kind: "organization", organizationId },
        },
      ]),
    });
    const policy = authorityReceiptPolicyForRequestType("enterprise.access.list_grants.request");
    expect(policy?.enterpriseActions).toEqual(["identity.manage"]);
    expect(
      authorize(deniedAuthorizer, deniedAuthorization, "enterprise.access.list_grants.request"),
    ).toBeNull();

    const allowedAuthorization = new SessionAuthorization(["workspace.read"]);
    const allowedAuthorizer = createAuthorizer({
      authorization: allowedAuthorization,
      principal: principal([
        {
          action: "identity.manage",
          selector: { kind: "organization", organizationId },
        },
      ]),
    });
    expect(
      authorize(allowedAuthorizer, allowedAuthorization, "enterprise.access.list_grants.request"),
    ).not.toBeNull();
  });

  test("rejects resource-scoped and unknown request types", () => {
    const authorization = new SessionAuthorization(OWNER_PERMISSIONS);
    const authorizer = createAuthorizer({ authorization });
    for (const type of ["fetch_agent_request", "create_agent_request"] as const) {
      expect(authorize(authorizer, authorization, type)).toBeNull();
    }
    expect(authorityReceiptPolicyForRequestType("future.unknown.request")).toBeNull();
  });

  test("rejects structural decisions and decisions from another SessionAuthorization", () => {
    const first = new SessionAuthorization(["daemon.read"]);
    const second = new SessionAuthorization(["daemon.read"]);
    const message = inbound("daemon.get_status.request");
    const authorizer = createAuthorizer({ authorization: second });

    expect(authorizer.authorize(message, {} as InboundDaemonAuthorizationDecision)).toBeNull();
    expect(authorizer.authorize(message, first.authorizeInbound(message)!)).toBeNull();
  });

  test("burns pending evidence before rejecting reuse, foreign authorizers, or foreign messages", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const firstAuthorizer = createAuthorizer({ authorization });
    const secondAuthorizer = createAuthorizer({ authorization });
    const message = inbound("daemon.get_status.request", "request-a");

    const reused = firstAuthorizer.authorize(message, authorization.authorizeInbound(message)!)!;
    expect(firstAuthorizer.consumeForRegistration(message, reused)).not.toBeNull();
    expect(firstAuthorizer.consumeForRegistration(message, reused)).toBeNull();

    const foreignAuthorizer = firstAuthorizer.authorize(
      message,
      authorization.authorizeInbound(message)!,
    )!;
    expect(secondAuthorizer.consumeForRegistration(message, foreignAuthorizer)).toBeNull();
    expect(firstAuthorizer.consumeForRegistration(message, foreignAuthorizer)).toBeNull();

    const clonedMessageEvidence = firstAuthorizer.authorize(
      message,
      authorization.authorizeInbound(message)!,
    )!;
    expect(
      firstAuthorizer.consumeForRegistration(
        inbound("daemon.get_status.request", "request-a"),
        clonedMessageEvidence,
      ),
    ).toBeNull();
    expect(firstAuthorizer.consumeForRegistration(message, clonedMessageEvidence)).toBeNull();

    const differentRequestEvidence = firstAuthorizer.authorize(
      message,
      authorization.authorizeInbound(message)!,
    )!;
    expect(
      firstAuthorizer.consumeForRegistration(
        inbound("daemon.get_status.request", "request-b"),
        differentRequestEvidence,
      ),
    ).toBeNull();
    expect(firstAuthorizer.consumeForRegistration(message, differentRequestEvidence)).toBeNull();
  });

  test("burns pending evidence when the exact caller message is mutated", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({ authorization });
    const message = inbound("daemon.get_status.request", "request-a") as SessionInboundMessage & {
      requestId: string;
    };
    const pending = authorizer.authorize(message, authorization.authorizeInbound(message)!)!;

    message.requestId = "request-b";
    expect(authorizer.consumeForRegistration(message, pending)).toBeNull();
    message.requestId = "request-a";
    expect(authorizer.consumeForRegistration(message, pending)).toBeNull();

    const typeMessage = inbound("daemon.get_status.request");
    const typeEvidence = authorizer.authorize(
      typeMessage,
      authorization.authorizeInbound(typeMessage)!,
    )!;
    (typeMessage as { type: string }).type = "plugin.list.request";
    expect(authorizer.consumeForRegistration(typeMessage, typeEvidence)).toBeNull();
    (typeMessage as { type: string }).type = "daemon.get_status.request";
    expect(authorizer.consumeForRegistration(typeMessage, typeEvidence)).toBeNull();
  });

  test("rejects same-value permission replacement before first consume and accepts fresh evidence", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({ authorization });
    const message = inbound("daemon.get_status.request");
    const pending = authorizer.authorize(message, authorization.authorizeInbound(message)!)!;
    authorization.replacePermissions(["daemon.read"]);

    expect(authorizer.consumeForRegistration(message, pending)).toBeNull();
    expect(authorize(authorizer, authorization, "daemon.get_status.request")).not.toBeNull();
  });

  test("rejects remove-then-readd before first consume and accepts fresh evidence", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({ authorization });
    const message = inbound("daemon.get_status.request");
    const pending = authorizer.authorize(message, authorization.authorizeInbound(message)!)!;
    authorization.replacePermissions([]);
    authorization.replacePermissions(["daemon.read"]);

    expect(authorizer.consumeForRegistration(message, pending)).toBeNull();
    expect(authorize(authorizer, authorization, "daemon.get_status.request")).not.toBeNull();
  });

  test("burns pending evidence when Grant currentness changes", () => {
    let current = true;
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({
      authorization,
      guard: { isCurrent: () => current },
    });
    const grantMessage = inbound("daemon.get_status.request");
    const grantEvidence = authorizer.authorize(
      grantMessage,
      authorization.authorizeInbound(grantMessage)!,
    )!;
    current = false;
    expect(authorizer.consumeForRegistration(grantMessage, grantEvidence)).toBeNull();
    current = true;
    expect(authorizer.consumeForRegistration(grantMessage, grantEvidence)).toBeNull();
  });

  test("rejects a structural SessionAuthorization receiver", () => {
    const real = new SessionAuthorization(["daemon.read"]);
    const fake = Object.create(SessionAuthorization.prototype) as SessionAuthorization;
    const message = inbound("daemon.get_status.request");
    const authorizer = createAuthorizer({ authorization: fake });

    expect(authorizer.authorize(message, real.authorizeInbound(message)!)).toBeNull();
  });

  test("uses a strict frozen Principal snapshot despite caller mutation", () => {
    const authorization = new SessionAuthorization(["workspace.read"]);
    const actor = principal([
      {
        action: "identity.manage",
        selector: { kind: "organization", organizationId },
      },
    ]);
    const seen: PrincipalContext[] = [];
    const authorizer = createAuthorizer({
      authorization,
      principal: Object.assign(actor, { callerOnly: "discarded" }),
      guard: {
        isCurrent(ctx) {
          seen.push(ctx);
          return ctx.organizationId === organizationId && ctx.grantVersion === "grant-a";
        },
      },
    });
    actor.organizationId = foreignOrganizationId;
    actor.principalId = "usr_fedcba9876543210";
    actor.credentialId = "credential-b";
    actor.grantVersion = "grant-b";
    actor.grants = [];

    const evidence = authorize(authorizer, authorization, "enterprise.access.list_grants.request");

    expect(evidence?.organizationId).toBe(organizationId);
    expect(evidence?.principalId).toBe("usr_0123456789abcdef");
    expect(seen).toHaveLength(3);
    for (const snapshot of seen) {
      expect(Object.keys(snapshot).sort()).toEqual([
        "credentialId",
        "grantVersion",
        "grants",
        "organizationId",
        "principalId",
        "principalType",
      ]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.grants)).toBe(true);
      expect(Object.isFrozen(snapshot.grants[0]?.selector)).toBe(true);
    }
  });

  test.each([
    ["stale", { isCurrent: () => false }],
    [
      "throwing",
      {
        isCurrent() {
          throw new Error("guard unavailable");
        },
      },
    ],
  ] as const)("fails closed for a %s Grant guard", (_name, guard) => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({ authorization, guard });

    expect(authorize(authorizer, authorization, "daemon.get_status.request")).toBeNull();
  });

  test("fails the final synchronous guard sample when revocation occurs during authorization", () => {
    let guardCalls = 0;
    const authorization = new SessionAuthorization(["daemon.read"]);
    const authorizer = createAuthorizer({
      authorization,
      guard: {
        isCurrent() {
          guardCalls += 1;
          return guardCalls !== 2;
        },
      },
    });
    const message = inbound("daemon.get_status.request");
    const decision = authorization.authorizeInbound(message)!;

    expect(authorizer.authorize(message, decision)).toBeNull();
    expect(guardCalls).toBe(2);
    expect(authorizer.authorize(message, decision)).toBeNull();
    expect(guardCalls).toBe(3);
  });

  test("fails closed and burns state when message getters or proxies throw", () => {
    const authorization = new SessionAuthorization(["daemon.read"]);
    const throwingType = new Proxy(inbound("daemon.get_status.request"), {
      has() {
        throw new Error("type unavailable");
      },
    });
    expect(authorization.authorizeInbound(throwingType)).toBeNull();
    expect(authorization.allowsInbound(throwingType)).toBe(false);

    const authorizer = createAuthorizer({ authorization });
    let typeUnavailable = false;
    const consumeProxy = new Proxy(inbound("daemon.get_status.request"), {
      has(target, property) {
        if (typeUnavailable) throw new Error("type unavailable");
        return Reflect.has(target, property);
      },
    });
    const consumeDecision = authorization.authorizeInbound(consumeProxy)!;
    typeUnavailable = true;
    expect(authorizer.authorize(consumeProxy, consumeDecision)).toBeNull();
    typeUnavailable = false;
    expect(authorizer.authorize(consumeProxy, consumeDecision)).toBeNull();

    const throwingRequestId = inbound("daemon.get_status.request") as SessionInboundMessage & {
      requestId: string;
    };
    const throwingDecision = authorization.authorizeInbound(throwingRequestId)!;
    Object.defineProperty(throwingRequestId, "requestId", {
      configurable: true,
      get() {
        throw new Error("request id unavailable");
      },
    });
    expect(authorizer.authorize(throwingRequestId, throwingDecision)).toBeNull();
    Object.defineProperty(throwingRequestId, "requestId", {
      configurable: true,
      value: "request-a",
    });
    expect(authorizer.authorize(throwingRequestId, throwingDecision)).toBeNull();

    const message = inbound("daemon.get_status.request") as SessionInboundMessage & {
      requestId: string;
    };
    const pending = authorizer.authorize(message, authorization.authorizeInbound(message)!)!;
    Object.defineProperty(message, "requestId", {
      configurable: true,
      get() {
        throw new Error("request id unavailable");
      },
    });
    expect(authorizer.consumeForRegistration(message, pending)).toBeNull();
    expect(isInboundAuthoritySuccessEvidence(pending)).toBe(false);
  });

  test("covers every fixed authority-receipt request policy and no other inbound type", () => {
    const requestTypes = new Set(
      ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES.map((policy) => policy.requestType),
    );
    expect(ALL_OUTBOUND_AUTHORITY_RECEIPT_POLICIES).toHaveLength(45);
    expect(requestTypes.size).toBe(44);

    const actor = principal(
      (["identity.manage", "audit.read", "workspace.manage"] as const).map((action) => ({
        action,
        selector: { kind: "organization" as const, organizationId },
      })),
    );
    for (const requestType of requestTypes) {
      const authorization = new SessionAuthorization(OWNER_PERMISSIONS);
      const authorizer = createAuthorizer({ authorization, principal: actor });
      const evidence = authorize(authorizer, authorization, requestType);
      const policy = authorityReceiptPolicyForRequestType(requestType);
      expect(evidence?.requestType).toBe(requestType);
      expect(evidence?.authorization.daemonPermission).toEqual(policy?.daemonPermission);
      expect(evidence?.authorization.enterpriseActions).toEqual(policy?.enterpriseActions);
    }

    for (const option of SessionInboundMessageSchema.options) {
      const requestType = option.shape.type.value;
      expect(authorityReceiptPolicyForRequestType(requestType) !== null).toBe(
        requestTypes.has(requestType),
      );
    }
  });
});
