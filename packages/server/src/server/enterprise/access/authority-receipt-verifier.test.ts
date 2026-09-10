import { describe, expect, test } from "vitest";

import {
  createEnterpriseSessionBindingKey,
  type OutboundAuthorizationContext,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import {
  StrictOutboundAuthorityVerifier,
  type AuthorityReceiptClock,
  type AuthorityReceiptStatePort,
  type AuthoritySessionBindingRecord,
  type AuthorizedRequestReceipt,
} from "./authority-receipt-verifier.js";
import { OwnerRegistry } from "./owner-registry.js";
import { ResourceAuthorizationService } from "./resource-authorization.js";

const now = 1_800_000_000_000;
const nodeId = "nod_0123456789abcdef";
const clientId = "client-a";
const requestId = "request-a";
const receiptId = "receipt-a";
const generation = "generation-a";

const ctx: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  credentialId: "credential-a",
  grantVersion: "grant-a",
  grants: [{ action: "identity.manage", selector: { kind: "self" } }],
};

const sessionBindingKey = createEnterpriseSessionBindingKey({
  organizationId: ctx.organizationId,
  principalId: ctx.principalId,
  credentialId: ctx.credentialId,
  grantVersion: ctx.grantVersion,
  clientId,
});

type AuthorityContext = Extract<OutboundAuthorizationContext, { kind: "authority" }>;
type AuthorizedRequestAuthority = Extract<
  AuthorityContext["authority"],
  { kind: "authorized_request" }
>;

function binding(
  patch: Partial<AuthoritySessionBindingRecord> = {},
): AuthoritySessionBindingRecord {
  return {
    sessionId: "session-a",
    sessionBindingKey,
    sessionBindingGeneration: generation,
    organizationId: ctx.organizationId,
    principalId: ctx.principalId,
    principalType: ctx.principalType,
    credentialId: ctx.credentialId,
    grantVersion: ctx.grantVersion,
    nodeId,
    clientId,
    ...patch,
  };
}

function receipt(patch: Partial<AuthorizedRequestReceipt> = {}): AuthorizedRequestReceipt {
  return {
    ...binding(),
    receiptId,
    requestId,
    requestType: "enterprise.access.list_grants.request",
    expiresAt: now + 1_000,
    authorization: {
      succeeded: true,
      daemonPermission: "workspace.read",
      enterpriseActions: ["identity.manage"],
    },
    ...patch,
  };
}

function authority(patch: Partial<AuthorizedRequestAuthority> = {}): AuthorityContext {
  return {
    kind: "authority",
    authority: {
      kind: "authorized_request",
      receiptId,
      requestId,
      requestType: "enterprise.access.list_grants.request",
      sessionBindingKey,
      sessionBindingGeneration: generation,
      ...patch,
    },
  };
}

function requestEvent(
  type: SessionOutboundMessage["type"] = "enterprise.access.list_grants.response",
  eventRequestId = requestId,
): SessionOutboundMessage {
  return { type, payload: { requestId: eventRequestId } } as SessionOutboundMessage;
}

class MemoryAuthorityReceiptState implements AuthorityReceiptStatePort {
  private consumed = false;

  constructor(
    private readonly storedReceipt: AuthorizedRequestReceipt | null,
    private readonly currentBinding: AuthoritySessionBindingRecord | null,
    private readonly fail = false,
  ) {}

  async consumeAuthorizedRequest(receiptKey: string) {
    if (this.fail) throw new Error("receipt registry unavailable");
    if (this.consumed || receiptKey !== this.storedReceipt?.receiptId || !this.currentBinding)
      return null;
    this.consumed = true;
    return { receipt: this.storedReceipt, currentBinding: this.currentBinding };
  }

  async resolveCurrentSessionBinding(input: {
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }) {
    if (this.fail) throw new Error("binding registry unavailable");
    if (
      !this.currentBinding ||
      input.sessionBindingKey !== this.currentBinding.sessionBindingKey ||
      input.sessionBindingGeneration !== this.currentBinding.sessionBindingGeneration
    )
      return null;
    return this.currentBinding;
  }
}

class SequenceClock implements AuthorityReceiptClock {
  calls = 0;

  constructor(private readonly readings: readonly (number | Error)[]) {}

  now(): number {
    const reading = this.readings[this.calls];
    this.calls += 1;
    if (reading instanceof Error) throw reading;
    if (reading === undefined) throw new Error("unexpected clock read");
    return reading;
  }
}

class MultiReceiptState implements AuthorityReceiptStatePort {
  private readonly receipts: Map<string, AuthorizedRequestReceipt>;

  constructor(
    receipts: readonly AuthorizedRequestReceipt[],
    private readonly currentBinding: AuthoritySessionBindingRecord,
  ) {
    this.receipts = new Map(receipts.map((stored) => [stored.receiptId, stored]));
  }

  async consumeAuthorizedRequest(receiptKey: string) {
    const stored = this.receipts.get(receiptKey);
    if (!stored) return null;
    this.receipts.delete(receiptKey);
    return { receipt: stored, currentBinding: this.currentBinding };
  }

  async resolveCurrentSessionBinding(input: {
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }) {
    return input.sessionBindingKey === this.currentBinding.sessionBindingKey &&
      input.sessionBindingGeneration === this.currentBinding.sessionBindingGeneration
      ? this.currentBinding
      : null;
  }
}

interface HarnessOptions {
  storedReceipt?: AuthorizedRequestReceipt | null;
  currentBinding?: AuthoritySessionBindingRecord | null;
  currentGrant?: boolean;
  failState?: boolean;
  withVerifier?: boolean;
  clock?: AuthorityReceiptClock;
}

function authorization(options: HarnessOptions = {}): ResourceAuthorizationService {
  const state = new MemoryAuthorityReceiptState(
    options.storedReceipt === undefined ? receipt() : options.storedReceipt,
    options.currentBinding === undefined ? binding() : options.currentBinding,
    options.failState,
  );
  return new ResourceAuthorizationService({
    owners: new OwnerRegistry(),
    nodeId,
    grantVersionGuard: { isCurrent: () => options.currentGrant ?? true },
    ...(options.withVerifier === false
      ? {}
      : {
          authorityVerifier: new StrictOutboundAuthorityVerifier(
            nodeId,
            state,
            options.clock ?? { now: () => now },
          ),
        }),
  });
}

async function canEmitAuthorized(
  options: HarnessOptions = {},
  event: SessionOutboundMessage = requestEvent(),
  context: AuthorityContext = authority(),
): Promise<boolean> {
  return authorization(options).canEmit(ctx, event, context);
}

function identityProjection(patch: Record<string, unknown> = {}) {
  return {
    organizationId: ctx.organizationId,
    principalId: ctx.principalId,
    principalType: ctx.principalType,
    nodeId,
    paseoServerId: "server-a",
    grantVersion: ctx.grantVersion,
    navigation: [],
    allowedOperations: [],
    ...patch,
  };
}

function identityAuthority(
  message: Extract<AuthorityContext["authority"], { kind: "identity_self" }>["message"],
  patch: Partial<Extract<AuthorityContext["authority"], { kind: "identity_self" }>> = {},
): AuthorityContext {
  return {
    kind: "authority",
    authority: {
      kind: "identity_self",
      sessionBindingKey,
      sessionBindingGeneration: generation,
      message,
      ...patch,
    },
  };
}

describe("strict outbound authority receipt verifier", () => {
  test("accepts an exact authorized operation once and rejects receipt reuse", async () => {
    const clock = new SequenceClock([now]);
    const service = authorization({ clock });
    await expect(service.canEmit(ctx, requestEvent(), authority())).resolves.toBe(true);
    await expect(service.canEmit(ctx, requestEvent(), authority())).resolves.toBe(false);
    expect(clock.calls).toBe(1);
  });

  test("uses an inclusive expiry boundary and burns an expired receipt", async () => {
    const clock = new SequenceClock([now]);
    const service = authorization({ storedReceipt: receipt({ expiresAt: now }), clock });

    await expect(service.canEmit(ctx, requestEvent(), authority())).resolves.toBe(false);
    await expect(service.canEmit(ctx, requestEvent(), authority())).resolves.toBe(false);
    expect(clock.calls).toBe(1);

    await expect(
      canEmitAuthorized({ storedReceipt: receipt({ expiresAt: now + 1 }) }),
    ).resolves.toBe(true);
  });

  test("rejects invalid or throwing clock samples after atomically burning the receipt", async () => {
    const cases: readonly [string, number | Error][] = [
      ["NaN", Number.NaN],
      ["negative", -1],
      ["fractional", now + 0.5],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
      ["throw", new Error("clock unavailable")],
    ];

    for (const [name, reading] of cases) {
      const clock = new SequenceClock([reading]);
      const service = authorization({ clock });
      await expect(service.canEmit(ctx, requestEvent(), authority()), name).resolves.toBe(false);
      await expect(
        service.canEmit(ctx, requestEvent(), authority()),
        `${name} reuse`,
      ).resolves.toBe(false);
      expect(clock.calls, name).toBe(1);
    }
  });

  test("rejects a clock rollback after consuming the receipt", async () => {
    const secondRequestId = "request-b";
    const secondReceiptId = "receipt-b";
    const state = new MultiReceiptState(
      [receipt(), receipt({ receiptId: secondReceiptId, requestId: secondRequestId })],
      binding(),
    );
    const clock = new SequenceClock([now, now - 1]);
    const service = new ResourceAuthorizationService({
      owners: new OwnerRegistry(),
      nodeId,
      grantVersionGuard: { isCurrent: () => true },
      authorityVerifier: new StrictOutboundAuthorityVerifier(nodeId, state, clock),
    });

    await expect(service.canEmit(ctx, requestEvent(), authority())).resolves.toBe(true);
    await expect(
      service.canEmit(
        ctx,
        requestEvent(undefined, secondRequestId),
        authority({ receiptId: secondReceiptId, requestId: secondRequestId }),
      ),
    ).resolves.toBe(false);
    await expect(
      service.canEmit(
        ctx,
        requestEvent(undefined, secondRequestId),
        authority({ receiptId: secondReceiptId, requestId: secondRequestId }),
      ),
    ).resolves.toBe(false);
    expect(clock.calls).toBe(2);
  });

  test("supports exact request pairing for correlated lifecycle status", async () => {
    const restartReceipt = receipt({
      requestType: "restart_server_request",
      authorization: {
        succeeded: true,
        daemonPermission: "daemon.manage",
        enterpriseActions: [],
      },
    });
    const event = {
      type: "status",
      payload: { status: "restart_requested", clientId, requestId },
    } as SessionOutboundMessage;
    const context = authority({ requestType: "restart_server_request" });

    await expect(
      canEmitAuthorized({ storedReceipt: restartReceipt }, event, context),
    ).resolves.toBe(true);
    await expect(
      canEmitAuthorized(
        { storedReceipt: restartReceipt },
        {
          type: "status",
          payload: { status: "shutdown_requested", clientId, requestId },
        } as SessionOutboundMessage,
        context,
      ),
    ).resolves.toBe(false);
    await expect(
      canEmitAuthorized(
        { storedReceipt: restartReceipt },
        {
          type: "status",
          payload: { status: "restart_requested", clientId: "client-b", requestId },
        } as SessionOutboundMessage,
        context,
      ),
    ).resolves.toBe(false);
  });

  test("inherits an authorized-request receipt for a correlated rpc_error", async () => {
    await expect(
      canEmitAuthorized(
        {},
        {
          type: "rpc_error",
          payload: {
            requestId,
            requestType: "enterprise.access.list_grants.request",
            error: "fixed_error",
          },
        },
      ),
    ).resolves.toBe(true);
    await expect(
      canEmitAuthorized({}, { type: "rpc_error", payload: { requestId, error: "fixed_error" } }),
    ).resolves.toBe(false);
  });

  test("fails closed for every receipt, request, authorization, and binding mismatch", async () => {
    const foreignPrincipal = "usr_fedcba9876543210";
    const cases: readonly [string, HarnessOptions, SessionOutboundMessage?, AuthorityContext?][] = [
      ["missing receipt", { storedReceipt: null }],
      ["expired receipt", { storedReceipt: receipt({ expiresAt: now }) }],
      ["stale Grant", { currentGrant: false }],
      ["registry failure", { failState: true }],
      ["no verifier wiring", { withVerifier: false }],
      ["missing current binding", { currentBinding: null }],
      ["wrong receipt id", { storedReceipt: receipt({ receiptId: "receipt-b" }) }],
      ["wrong request id in receipt", { storedReceipt: receipt({ requestId: "request-b" }) }],
      [
        "wrong request type in receipt",
        { storedReceipt: receipt({ requestType: "enterprise.access.update_grants.request" }) },
      ],
      [
        "wrong coarse permission",
        {
          storedReceipt: receipt({
            authorization: {
              succeeded: true,
              daemonPermission: "daemon.read",
              enterpriseActions: ["identity.manage"],
            },
          }),
        },
      ],
      [
        "wrong EnterpriseAction",
        {
          storedReceipt: receipt({
            authorization: {
              succeeded: true,
              daemonPermission: "access.manage",
              enterpriseActions: ["audit.read"],
            },
          }),
        },
      ],
      [
        "duplicate EnterpriseAction result",
        {
          storedReceipt: receipt({
            authorization: {
              succeeded: true,
              daemonPermission: "access.manage",
              enterpriseActions: ["identity.manage", "identity.manage"],
            },
          }),
        },
      ],
      [
        "non-strict receipt record",
        {
          storedReceipt: {
            ...receipt(),
            unexpected: true,
          } as AuthorizedRequestReceipt,
        },
      ],
      [
        "wrong organization",
        { storedReceipt: receipt({ organizationId: "org_fedcba9876543210" }) },
      ],
      ["wrong Principal", { storedReceipt: receipt({ principalId: foreignPrincipal }) }],
      ["wrong credential", { storedReceipt: receipt({ credentialId: "credential-b" }) }],
      ["wrong Grant version", { storedReceipt: receipt({ grantVersion: "grant-b" }) }],
      ["wrong node", { storedReceipt: receipt({ nodeId: "nod_fedcba9876543210" }) }],
      ["wrong client", { storedReceipt: receipt({ clientId: "client-b" }) }],
      ["wrong Session", { storedReceipt: receipt({ sessionId: "session-b" }) }],
      ["wrong receipt binding key", { storedReceipt: receipt({ sessionBindingKey: "binding-b" }) }],
      [
        "wrong receipt generation",
        { storedReceipt: receipt({ sessionBindingGeneration: "generation-b" }) },
      ],
      ["wrong current client binding", { currentBinding: binding({ clientId: "client-b" }) }],
      ["wrong event request id", {}, requestEvent(undefined, "request-b")],
      ["wrong event pair", {}, requestEvent("plugin.list.response")],
      ["wrong context request id", {}, undefined, authority({ requestId: "request-b" })],
      [
        "wrong context request type",
        {},
        undefined,
        authority({ requestType: "enterprise.access.update_grants.request" }),
      ],
      ["wrong context binding key", {}, undefined, authority({ sessionBindingKey: "binding-b" })],
      [
        "wrong context generation",
        {},
        undefined,
        authority({ sessionBindingGeneration: "generation-b" }),
      ],
    ];

    for (const [name, options, event = requestEvent(), context = authority()] of cases) {
      await expect(canEmitAuthorized(options, event, context), name).resolves.toBe(false);
    }
  });

  test("accepts exactly the four current-session identity_self messages", async () => {
    const cases: readonly [SessionOutboundMessage, AuthorityContext][] = [
      [
        {
          type: "enterprise.identity.get_current.response",
          payload: { requestId, identity: identityProjection() },
        } as SessionOutboundMessage,
        identityAuthority({ type: "enterprise.identity.get_current.response", requestId }),
      ],
      [
        {
          type: "enterprise.identity.logout_all.response",
          payload: { requestId, loggedOut: true },
        },
        identityAuthority({ type: "enterprise.identity.logout_all.response", requestId }),
      ],
      [
        {
          type: "enterprise.identity.scope_refreshed",
          payload: { identity: identityProjection() },
        } as SessionOutboundMessage,
        identityAuthority({ type: "enterprise.identity.scope_refreshed" }),
      ],
      [
        {
          type: "enterprise.identity.credential_revoked",
          payload: { revokedAt: "2026-09-10T00:00:00.000Z" },
        },
        identityAuthority({ type: "enterprise.identity.credential_revoked" }),
      ],
    ];

    for (const [event, context] of cases) {
      await expect(canEmitAuthorized({}, event, context)).resolves.toBe(true);
    }
  });

  test("fails closed for identity_self message, request, Principal, and binding mismatches", async () => {
    const getCurrentEvent = {
      type: "enterprise.identity.get_current.response",
      payload: { requestId, identity: identityProjection() },
    } as SessionOutboundMessage;
    const getCurrentAuthority = identityAuthority({
      type: "enterprise.identity.get_current.response",
      requestId,
    });
    const cases: readonly [string, HarnessOptions, SessionOutboundMessage, AuthorityContext][] = [
      [
        "wrong message type",
        {},
        getCurrentEvent,
        identityAuthority({ type: "enterprise.identity.logout_all.response", requestId }),
      ],
      [
        "wrong response request id",
        {},
        {
          type: "enterprise.identity.get_current.response",
          payload: { requestId: "request-b", identity: identityProjection() },
        } as SessionOutboundMessage,
        getCurrentAuthority,
      ],
      [
        "wrong projected Principal",
        {},
        {
          type: "enterprise.identity.get_current.response",
          payload: {
            requestId,
            identity: identityProjection({ principalId: "usr_fedcba9876543210" }),
          },
        } as SessionOutboundMessage,
        getCurrentAuthority,
      ],
      [
        "wrong projected organization",
        {},
        {
          type: "enterprise.identity.scope_refreshed",
          payload: { identity: identityProjection({ organizationId: "org_fedcba9876543210" }) },
        } as SessionOutboundMessage,
        identityAuthority({ type: "enterprise.identity.scope_refreshed" }),
      ],
      [
        "wrong context binding key",
        {},
        getCurrentEvent,
        identityAuthority(
          { type: "enterprise.identity.get_current.response", requestId },
          { sessionBindingKey: "binding-b" },
        ),
      ],
      [
        "wrong context generation",
        {},
        getCurrentEvent,
        identityAuthority(
          { type: "enterprise.identity.get_current.response", requestId },
          { sessionBindingGeneration: "generation-b" },
        ),
      ],
      [
        "wrong binding credential",
        { currentBinding: binding({ credentialId: "credential-b" }) },
        getCurrentEvent,
        getCurrentAuthority,
      ],
      [
        "wrong binding Grant version",
        { currentBinding: binding({ grantVersion: "grant-b" }) },
        getCurrentEvent,
        getCurrentAuthority,
      ],
      [
        "wrong binding node",
        { currentBinding: binding({ nodeId: "nod_fedcba9876543210" }) },
        getCurrentEvent,
        getCurrentAuthority,
      ],
      [
        "wrong binding client",
        { currentBinding: binding({ clientId: "client-b" }) },
        getCurrentEvent,
        getCurrentAuthority,
      ],
      ["stale Grant", { currentGrant: false }, getCurrentEvent, getCurrentAuthority],
      ["missing binding", { currentBinding: null }, getCurrentEvent, getCurrentAuthority],
      ["registry failure", { failState: true }, getCurrentEvent, getCurrentAuthority],
    ];

    for (const [name, options, event, context] of cases) {
      await expect(canEmitAuthorized(options, event, context), name).resolves.toBe(false);
    }
  });
});
