import { describe, expect, test } from "vitest";
import {
  createEnterpriseSessionBindingKey,
  type OutboundAuthorizationContext,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { SessionAuthorization } from "../../authorization/index.js";
import {
  StrictOutboundAuthorityVerifier,
  type AuthorityReceiptStatePort,
  type AuthoritySessionBindingRecord,
  type AuthorizedRequestReceipt,
} from "./authority-receipt-verifier.js";
import {
  InboundAuthorityRequestAuthorizer,
  type ActiveAuthorizedRequestHandle,
} from "./inbound-authority-request-authorizer.js";
import {
  ACTIVE_AUTHORIZED_REQUEST_MAX_EMISSIONS,
  OutboundAuthorityEmissionAuthorizer,
  type ActiveAuthorizedRequestCloseReason,
  type OutboundAuthorityEmissionStatePort,
} from "./outbound-authority-emission-authorizer.js";

const organizationId = "org_0123456789abcdef";
const nodeId = "nod_0123456789abcdef";
const clientId = "client-a";
const generation = "generation-a";
const requestId = "request-a";
const now = 1_800_000_000_000;

const principal: PrincipalContext = {
  principalType: "human",
  principalId: "usr_0123456789abcdef",
  organizationId,
  credentialId: "credential-a",
  grantVersion: "grant-a",
  grants: [],
};

const sessionBindingKey = createEnterpriseSessionBindingKey({
  organizationId,
  principalId: principal.principalId,
  credentialId: principal.credentialId,
  grantVersion: principal.grantVersion,
  clientId,
});

function binding(
  patch: Partial<AuthoritySessionBindingRecord> = {},
): AuthoritySessionBindingRecord {
  return {
    sessionId: "session-a",
    sessionBindingKey,
    sessionBindingGeneration: generation,
    organizationId,
    principalId: principal.principalId,
    principalType: principal.principalType,
    credentialId: principal.credentialId,
    grantVersion: principal.grantVersion,
    nodeId,
    clientId,
    ...patch,
  };
}

function progress(phase: "starting" | "downloading" | "installing" | "complete") {
  return {
    type: "daemon.update.progress",
    payload: { requestId, phase },
  } satisfies SessionOutboundMessage;
}

function response(): SessionOutboundMessage {
  return {
    type: "daemon.update.response",
    payload: {
      requestId,
      success: true,
      error: null,
      previousVersion: "1",
      newVersion: "2",
    },
  };
}

function rpcError(): SessionOutboundMessage {
  return {
    type: "rpc_error",
    payload: { requestId, requestType: "daemon.update.request", error: "redacted" },
  };
}

type AuthorityContext = Extract<OutboundAuthorizationContext, { kind: "authority" }>;

interface StoredRequest {
  binding: AuthoritySessionBindingRecord;
  status: "open" | "terminal" | "closed";
}

class MemoryEmissionState implements OutboundAuthorityEmissionStatePort, AuthorityReceiptStatePort {
  readonly requests = new Map<ActiveAuthorizedRequestHandle, StoredRequest>();
  readonly receipts = new Map<
    string,
    { receipt: AuthorizedRequestReceipt; handle: ActiveAuthorizedRequestHandle }
  >();
  readonly closeReasons: ActiveAuthorizedRequestCloseReason[] = [];
  registerHook?: () => Promise<void>;
  resolveHook?: () => Promise<void>;
  mintHook?: () => Promise<void>;
  afterMintHook?: () => Promise<void>;
  transformMintResult?: (receipt: AuthorizedRequestReceipt) => unknown;
  lastRegisterInput: object | null = null;
  lastMintInput: object | null = null;
  burnCalls = 0;
  mintCalls = 0;
  throwBurn = false;
  throwClose = false;
  private nextReceipt = 0;

  async register(input: {
    handle: ActiveAuthorizedRequestHandle;
    binding: AuthoritySessionBindingRecord;
  }) {
    this.lastRegisterInput = input;
    await this.registerHook?.();
    if (this.requests.has(input.handle)) return null;
    const stored = { binding: structuredClone(input.binding), status: "open" as const };
    this.requests.set(input.handle, stored);
    return structuredClone(stored.binding);
  }

  async resolveOpen(input: {
    handle: ActiveAuthorizedRequestHandle;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }) {
    await this.resolveHook?.();
    const stored = this.requests.get(input.handle);
    if (
      !stored ||
      stored.status !== "open" ||
      stored.binding.sessionBindingKey !== input.sessionBindingKey ||
      stored.binding.sessionBindingGeneration !== input.sessionBindingGeneration
    ) {
      return null;
    }
    return structuredClone(stored.binding);
  }

  async mintFreshReceipt(
    input: Parameters<OutboundAuthorityEmissionStatePort["mintFreshReceipt"]>[0],
  ) {
    this.mintCalls += 1;
    this.lastMintInput = input;
    await this.mintHook?.();
    const stored = this.requests.get(input.handle);
    if (
      !stored ||
      stored.status !== "open" ||
      stored.binding.sessionBindingKey !== input.sessionBindingKey ||
      stored.binding.sessionBindingGeneration !== input.sessionBindingGeneration
    ) {
      return null;
    }
    const receipt = input.materializeReceipt({
      receiptId: `receipt-${++this.nextReceipt}`,
      expiresAt: now + 1_000,
    });
    if (!receipt) return null;
    if (input.emission === "terminal") stored.status = "terminal";
    this.receipts.set(receipt.receiptId, { receipt, handle: input.handle });
    await this.afterMintHook?.();
    return (this.transformMintResult?.(receipt) ??
      structuredClone(receipt)) as AuthorizedRequestReceipt;
  }

  async burnFreshReceipts(input: {
    handle: ActiveAuthorizedRequestHandle;
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }) {
    this.burnCalls += 1;
    if (this.throwBurn) throw new Error("burn failed");
    this.deleteReceipts(input.handle);
  }

  async close(input: Parameters<OutboundAuthorityEmissionStatePort["close"]>[0]): Promise<void> {
    this.closeReasons.push(input.reason);
    if (this.throwClose) throw new Error("close failed");
    const stored = this.requests.get(input.handle);
    if (stored) stored.status = "closed";
    this.deleteReceipts(input.handle);
  }

  async consumeAuthorizedRequest(receiptId: string) {
    const storedReceipt = this.receipts.get(receiptId);
    if (!storedReceipt) return null;
    this.receipts.delete(receiptId);
    const request = this.requests.get(storedReceipt.handle);
    if (!request || request.status === "closed") return null;
    return {
      receipt: structuredClone(storedReceipt.receipt),
      currentBinding: structuredClone(request.binding),
    };
  }

  async resolveCurrentSessionBinding(input: {
    sessionBindingKey: string;
    sessionBindingGeneration: string;
  }) {
    for (const request of this.requests.values()) {
      if (
        request.status !== "closed" &&
        request.binding.sessionBindingKey === input.sessionBindingKey &&
        request.binding.sessionBindingGeneration === input.sessionBindingGeneration
      ) {
        return structuredClone(request.binding);
      }
    }
    return null;
  }

  private deleteReceipts(handle: ActiveAuthorizedRequestHandle): void {
    for (const [receiptId, stored] of this.receipts) {
      if (stored.handle === handle) this.receipts.delete(receiptId);
    }
  }
}

interface Harness {
  authorization: SessionAuthorization;
  inboundAuthorizer: InboundAuthorityRequestAuthorizer;
  emissionAuthorizer: OutboundAuthorityEmissionAuthorizer;
  handle: ActiveAuthorizedRequestHandle;
  state: MemoryEmissionState;
  setCurrent(value: boolean): void;
}

function createUnregisteredHarness(options: { state?: MemoryEmissionState } = {}): Harness {
  let current = true;
  const authorization = new SessionAuthorization(["daemon.manage"]);
  const inboundAuthorizer = new InboundAuthorityRequestAuthorizer({
    sessionAuthorization: authorization,
    principal,
    grantVersionGuard: { isCurrent: () => current },
  });
  const message = { type: "daemon.update.request", requestId } as const;
  const pending = inboundAuthorizer.authorize(message, authorization.authorizeInbound(message)!);
  if (!pending) throw new Error("Expected inbound evidence");
  const consumed = inboundAuthorizer.consumeForRegistration(message, pending);
  if (!consumed) throw new Error("Expected consumed inbound evidence");
  const state = options.state ?? new MemoryEmissionState();
  return {
    authorization,
    inboundAuthorizer,
    emissionAuthorizer: new OutboundAuthorityEmissionAuthorizer({
      inboundAuthorizer,
      sessionAuthorization: authorization,
      nodeId,
      state,
    }),
    handle: consumed.activeRequestHandle,
    state,
    setCurrent(value) {
      current = value;
    },
  };
}

async function createHarness(options: { state?: MemoryEmissionState } = {}): Promise<Harness> {
  const harness = createUnregisteredHarness(options);
  await expect(
    harness.emissionAuthorizer.register({
      handle: harness.handle,
      principal,
      binding: binding(),
    }),
  ).resolves.toBe(true);
  return harness;
}

async function authorizeEvent(harness: Harness, event: SessionOutboundMessage) {
  return harness.emissionAuthorizer.authorizeEmission({
    handle: harness.handle,
    principal,
    binding: binding(),
    event,
  });
}

function controlledHook(): {
  hook(): Promise<void>;
  waitUntilEntered(): Promise<void>;
  release(): void;
} {
  let signalEntered = () => undefined;
  let release = () => undefined;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async hook() {
      signalEntered();
      await blocked;
    },
    waitUntilEntered: () => entered,
    release,
  };
}

function contextReceiptId(context: AuthorityContext): string {
  if (context.authority.kind !== "authorized_request") throw new Error("Expected receipt context");
  return context.authority.receiptId;
}

async function expectOneUse(
  state: MemoryEmissionState,
  event: SessionOutboundMessage,
  context: AuthorityContext,
): Promise<void> {
  const verifier = new StrictOutboundAuthorityVerifier(nodeId, state, { now: () => now });
  await expect(verifier.verify(principal, event, context.authority)).resolves.toBe(true);
  await expect(verifier.verify(principal, event, context.authority)).resolves.toBe(false);
}

describe("OutboundAuthorityEmissionAuthorizer", () => {
  test("mints fresh one-use receipts for repeated progress and one terminal response", async () => {
    const harness = await createHarness();
    const events = [progress("starting"), progress("installing"), response()];
    const contexts: AuthorityContext[] = [];
    for (const event of events) {
      const context = await authorizeEvent(harness, event);
      expect(context).not.toBeNull();
      contexts.push(context!);
    }

    expect(new Set(contexts.map(contextReceiptId)).size).toBe(3);
    expect(Object.isFrozen(contexts[0])).toBe(true);
    expect(await authorizeEvent(harness, progress("complete"))).toBeNull();
    for (let index = 0; index < events.length; index += 1) {
      await expectOneUse(harness.state, events[index]!, contexts[index]!);
    }
  });

  test("allows progress followed by a terminal correlated rpc_error", async () => {
    const harness = await createHarness();
    const first = await authorizeEvent(harness, progress("downloading"));
    const terminal = await authorizeEvent(harness, rpcError());

    expect(first).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(contextReceiptId(first!)).not.toBe(contextReceiptId(terminal!));
    expect(await authorizeEvent(harness, response())).toBeNull();
    await expectOneUse(harness.state, progress("downloading"), first!);
    await expectOneUse(harness.state, rpcError(), terminal!);
  });

  test("derives the only state-port mint authority from the fixed W2 policy", async () => {
    const harness = await createHarness();
    const context = await authorizeEvent(harness, progress("starting"));
    expect(context).not.toBeNull();
    expect(Object.keys(harness.state.lastRegisterInput ?? {}).sort()).toEqual([
      "binding",
      "handle",
    ]);
    expect(Object.keys(harness.state.lastMintInput ?? {}).sort()).toEqual([
      "emission",
      "handle",
      "materializeReceipt",
      "sessionBindingGeneration",
      "sessionBindingKey",
    ]);
    expect(harness.state.lastMintInput).not.toHaveProperty("principal");
    expect(harness.state.lastMintInput).not.toHaveProperty("daemonPermission");
    expect(harness.state.lastMintInput).not.toHaveProperty("enterpriseActions");
    expect(harness.state.lastMintInput).not.toHaveProperty("requestId");
    expect(harness.state.lastMintInput).not.toHaveProperty("requestType");
  });

  test("invalidates the handle after same-value permission replacement", async () => {
    const harness = await createHarness();
    harness.authorization.replacePermissions(["daemon.manage"]);

    await expect(authorizeEvent(harness, progress("starting"))).resolves.toBeNull();
    expect(harness.state.closeReasons).toContain("authorization_failed");
    expect(harness.state.receipts.size).toBe(0);
  });

  test("checks current Grant after register awaits", async () => {
    const state = new MemoryEmissionState();
    const gate = controlledHook();
    state.registerHook = gate.hook;
    const harness = createUnregisteredHarness({ state });
    const registering = harness.emissionAuthorizer.register({
      handle: harness.handle,
      principal,
      binding: binding(),
    });
    await gate.waitUntilEntered();
    harness.setCurrent(false);
    gate.release();

    await expect(registering).resolves.toBe(false);
    expect(state.closeReasons).toContain("authorization_failed");
  });

  test("burns a freshly minted receipt when Grant currentness changes after mint", async () => {
    const harness = await createHarness();
    const gate = controlledHook();
    harness.state.afterMintHook = gate.hook;
    const emitting = authorizeEvent(harness, progress("starting"));
    await gate.waitUntilEntered();
    harness.setCurrent(false);
    gate.release();

    await expect(emitting).resolves.toBeNull();
    expect(harness.state.burnCalls).toBe(1);
    expect(harness.state.receipts.size).toBe(0);
    await expect(authorizeEvent(harness, progress("installing"))).resolves.toBeNull();
  });

  test("burns a freshly minted receipt when permission generation changes after mint", async () => {
    const harness = await createHarness();
    const gate = controlledHook();
    harness.state.afterMintHook = gate.hook;
    const emitting = authorizeEvent(harness, progress("starting"));
    await gate.waitUntilEntered();
    harness.authorization.replacePermissions(["daemon.manage"]);
    gate.release();

    await expect(emitting).resolves.toBeNull();
    expect(harness.state.burnCalls).toBe(1);
    expect(harness.state.receipts.size).toBe(0);
    await expect(authorizeEvent(harness, progress("installing"))).resolves.toBeNull();
  });

  test.each(["end", "cancel", "revoked", "release", "invalidate"] as const)(
    "lets close(%s) win a race with a terminal receipt mint",
    async (reason) => {
      const harness = await createHarness();
      const gate = controlledHook();
      harness.state.mintHook = gate.hook;
      const emitting = authorizeEvent(harness, response());
      await gate.waitUntilEntered();
      await expect(
        harness.emissionAuthorizer.close({
          handle: harness.handle,
          principal,
          binding: binding(),
          reason,
        }),
      ).resolves.toBe(true);
      gate.release();

      await expect(emitting).resolves.toBeNull();
      expect(harness.state.receipts.size).toBe(0);
      expect(harness.state.mintCalls).toBe(1);
      await expect(authorizeEvent(harness, progress("installing"))).resolves.toBeNull();
    },
  );

  test("does not begin another mint while a terminal mint is pending", async () => {
    const harness = await createHarness();
    const gate = controlledHook();
    harness.state.mintHook = gate.hook;
    const terminal = authorizeEvent(harness, response());
    await gate.waitUntilEntered();
    const afterTerminal = authorizeEvent(harness, progress("complete"));

    expect(harness.state.mintCalls).toBe(1);
    gate.release();
    const terminalContext = await terminal;
    expect(terminalContext).not.toBeNull();
    await expect(afterTerminal).resolves.toBeNull();
    expect(harness.state.mintCalls).toBe(1);
    await expect(
      harness.emissionAuthorizer.close({
        handle: harness.handle,
        principal,
        binding: binding(),
        reason: "end",
      }),
    ).resolves.toBe(false);
    await expectOneUse(harness.state, response(), terminalContext!);
  });

  test("captures every state method before caller mutation", async () => {
    const harness = createUnregisteredHarness();
    Object.assign(harness.state, {
      register: () => Promise.reject(new Error("mutated register")),
      resolveOpen: () => Promise.reject(new Error("mutated resolve")),
      mintFreshReceipt: () => Promise.reject(new Error("mutated mint")),
      burnFreshReceipts: () => Promise.reject(new Error("mutated burn")),
      close: () => Promise.reject(new Error("mutated close")),
    });

    await expect(
      harness.emissionAuthorizer.register({
        handle: harness.handle,
        principal,
        binding: binding(),
      }),
    ).resolves.toBe(true);
    harness.state.transformMintResult = () => ({ invalid: true });
    await expect(authorizeEvent(harness, progress("starting"))).resolves.toBeNull();
    expect(harness.state.mintCalls).toBe(1);
    expect(harness.state.burnCalls).toBe(1);
    expect(harness.state.closeReasons).toContain("authorization_failed");
  });

  test("bounds receipt history and closes before another mint", async () => {
    const harness = await createHarness();
    for (let index = 0; index < ACTIVE_AUTHORIZED_REQUEST_MAX_EMISSIONS; index += 1) {
      await expect(authorizeEvent(harness, progress("installing"))).resolves.not.toBeNull();
    }

    await expect(authorizeEvent(harness, progress("installing"))).resolves.toBeNull();
    expect(harness.state.mintCalls).toBe(ACTIVE_AUTHORIZED_REQUEST_MAX_EMISSIONS);
    expect(harness.state.burnCalls).toBe(1);
    expect(harness.state.receipts.size).toBe(0);
    expect(harness.state.closeReasons).toContain("authorization_failed");
  });

  test("rejects foreign handles, bindings, sessions, clients, and requests", async () => {
    const foreign = createUnregisteredHarness();
    const local = createUnregisteredHarness();
    await expect(
      local.emissionAuthorizer.register({
        handle: foreign.handle,
        principal,
        binding: binding(),
      }),
    ).resolves.toBe(false);
    await expect(
      foreign.emissionAuthorizer.register({
        handle: foreign.handle,
        principal,
        binding: binding(),
      }),
    ).resolves.toBe(false);

    for (const invalidBinding of [
      binding({ clientId: "client-b" }),
      binding({ nodeId: "nod_fedcba9876543210" }),
    ]) {
      const harness = createUnregisteredHarness();
      await expect(
        harness.emissionAuthorizer.register({
          handle: harness.handle,
          principal,
          binding: invalidBinding,
        }),
      ).resolves.toBe(false);
    }

    for (const invalidBinding of [
      binding({ sessionId: "session-b" }),
      binding({ clientId: "client-b" }),
      binding({ sessionBindingGeneration: "generation-b" }),
    ]) {
      const harness = await createHarness();
      await expect(
        harness.emissionAuthorizer.authorizeEmission({
          handle: harness.handle,
          principal,
          binding: invalidBinding,
          event: progress("starting"),
        }),
      ).resolves.toBeNull();
    }

    const harness = await createHarness();
    await expect(
      authorizeEvent(harness, {
        type: "daemon.update.progress",
        payload: { requestId: "request-b", phase: "starting" },
      }),
    ).resolves.toBeNull();
    await expect(authorizeEvent(harness, response())).resolves.toBeNull();

    const wrongPrincipal = await createHarness();
    await expect(
      wrongPrincipal.emissionAuthorizer.authorizeEmission({
        handle: wrongPrincipal.handle,
        principal: { ...principal, credentialId: "credential-b" },
        binding: binding(),
        event: progress("starting"),
      }),
    ).resolves.toBeNull();

    const wrongRequestType = await createHarness();
    await expect(
      authorizeEvent(wrongRequestType, {
        type: "diagnostics.response",
        payload: { requestId, diagnostic: "redacted" },
      }),
    ).resolves.toBeNull();
  });

  test("fails closed for throwing getters and a malformed mint result", async () => {
    const harness = await createHarness();
    const throwingEvent = new Proxy(progress("starting"), {
      get() {
        throw new Error("event getter failed");
      },
    });
    await expect(authorizeEvent(harness, throwingEvent)).resolves.toBeNull();
    await expect(authorizeEvent(harness, progress("starting"))).resolves.not.toBeNull();

    const malformed = await createHarness();
    malformed.state.transformMintResult = () =>
      new Proxy({} as AuthorizedRequestReceipt, {
        get() {
          throw new Error("receipt getter failed");
        },
      });
    await expect(authorizeEvent(malformed, progress("starting"))).resolves.toBeNull();
    expect(malformed.state.burnCalls).toBe(1);
    expect(malformed.state.receipts.size).toBe(0);
  });

  test("keeps the local handle closed when burn and close cleanup both throw", async () => {
    const harness = await createHarness();
    harness.state.transformMintResult = () => ({ invalid: true });
    harness.state.throwBurn = true;
    harness.state.throwClose = true;

    const denied = await authorizeEvent(harness, progress("starting"));
    expect(denied).toBeNull();
    expect(harness.state.burnCalls).toBe(1);
    expect(harness.state.closeReasons).toEqual(["authorization_failed"]);
    expect(harness.state.mintCalls).toBe(1);

    await expect(authorizeEvent(harness, progress("installing"))).resolves.toBeNull();
    expect(harness.state.mintCalls).toBe(1);
  });

  test("uses the captured Grant checker after authorizer method mutation", async () => {
    const harness = await createHarness();
    harness.setCurrent(false);
    Object.assign(harness.inboundAuthorizer, {
      isPrincipalGrantCurrent: () => true,
    });

    await expect(authorizeEvent(harness, progress("starting"))).resolves.toBeNull();
    expect(harness.state.mintCalls).toBe(0);
    expect(harness.state.closeReasons).toContain("authorization_failed");
  });
});
