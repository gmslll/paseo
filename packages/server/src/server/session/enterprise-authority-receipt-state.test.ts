import { describe, expect, it } from "vitest";
import {
  MemoryAuthorityReceiptState,
  AUTHORITY_RECEIPT_CAPACITY_HARD_MAX,
  AUTHORITY_RECEIPT_ID_MIN_LENGTH,
  AUTHORITY_RECEIPT_ID_MAX_ATTEMPTS,
} from "./enterprise-authority-receipt-state.js";
import { StrictOutboundAuthorityVerifier } from "../enterprise/access/authority-receipt-verifier.js";
import type { AuthoritySessionBindingRecord } from "../enterprise/access/authority-receipt-verifier.js";
import type { ActiveAuthorizedRequestHandle } from "../enterprise/access/inbound-authority-request-authorizer.js";
import { createEnterpriseSessionBindingKey } from "@getpaseo/protocol/messages";

const binding: AuthoritySessionBindingRecord = {
  sessionId: "session-a",
  sessionBindingKey: createEnterpriseSessionBindingKey({
    organizationId: "org_aaaaaaaaaaaaaaaa",
    principalId: "usr_aaaaaaaaaaaaaaaa",
    credentialId: "cred-a",
    grantVersion: "grant-v1",
    clientId: "client-a",
  }),
  sessionBindingGeneration: "generation-a",
  organizationId: "org_aaaaaaaaaaaaaaaa",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  principalType: "human",
  credentialId: "cred-a",
  grantVersion: "grant-v1",
  nodeId: "nod_aaaaaaaaaaaaaaaa",
  clientId: "client-a",
};
const fakeHandle = () => Object.freeze({}) as ActiveAuthorizedRequestHandle;
function variant(overrides: Partial<AuthoritySessionBindingRecord>): AuthoritySessionBindingRecord {
  const next = { ...binding, ...overrides };
  return {
    ...next,
    sessionBindingKey: createEnterpriseSessionBindingKey({
      organizationId: next.organizationId,
      principalId: next.principalId,
      credentialId: next.credentialId,
      grantVersion: next.grantVersion,
      clientId: next.clientId,
    }),
  };
}
function lookup(b: AuthoritySessionBindingRecord) {
  return {
    sessionBindingKey: b.sessionBindingKey,
    sessionBindingGeneration: b.sessionBindingGeneration,
  };
}
function sessionScope(b: AuthoritySessionBindingRecord) {
  return {
    sessionId: b.sessionId,
    sessionBindingKey: b.sessionBindingKey,
    sessionBindingGeneration: b.sessionBindingGeneration,
  };
}
type MalformedMode =
  | "extra"
  | "symbol"
  | "non-enumerable"
  | "inherited"
  | "accessor"
  | "throw-ownKeys"
  | "throw-descriptor";
function malformedInput(
  value: Record<string, unknown>,
  mode: MalformedMode,
  reads?: { count: number },
) {
  const keys = Object.keys(value);
  if (mode === "extra") return { ...value, extra: "unexpected" };
  if (mode === "symbol") {
    const result = { ...value };
    Object.defineProperty(result, Symbol("extra"), { enumerable: true, value: "unexpected" });
    return result;
  }
  if (mode === "non-enumerable") {
    const result = { ...value };
    Object.defineProperty(result, "extra", { enumerable: false, value: "unexpected" });
    return result;
  }
  if (mode === "inherited") {
    const [first, ...rest] = keys;
    const result = Object.create({ [first]: value[first] }) as Record<string, unknown>;
    for (const key of rest) result[key] = value[key];
    return result;
  }
  if (mode === "accessor") {
    const result = { ...value };
    Object.defineProperty(result, keys[0], {
      enumerable: true,
      get() {
        if (reads) reads.count += 1;
        return value[keys[0]];
      },
    });
    return result;
  }
  if (mode === "throw-ownKeys") {
    return new Proxy(value, {
      ownKeys: () => {
        throw new Error("ownKeys");
      },
    });
  }
  return new Proxy(value, {
    getOwnPropertyDescriptor: () => {
      throw new Error("descriptor");
    },
  });
}
async function open(state: MemoryAuthorityReceiptState, b = binding) {
  state.registerSessionBinding(b);
  const handle = fakeHandle();
  expect(await state.register({ handle, binding: b })).toEqual(b);
  return handle;
}
async function mint(
  state: MemoryAuthorityReceiptState,
  handle: ActiveAuthorizedRequestHandle,
  b = binding,
  requestId = "request-a",
  emission: "repeatable" | "terminal" = "repeatable",
) {
  const receipt = await state.mintFreshReceipt({
    handle,
    sessionBindingKey: b.sessionBindingKey,
    sessionBindingGeneration: b.sessionBindingGeneration,
    emission,
    materializeReceipt: ({ receiptId, expiresAt }) => ({
      ...b,
      receiptId,
      expiresAt,
      requestId,
      requestType: "daemon.get_status.request",
      authorization: { succeeded: true, daemonPermission: "daemon.read", enterpriseActions: [] },
    }),
  });
  expect(receipt).not.toBeNull();
  return receipt!;
}

describe("MemoryAuthorityReceiptState", () => {
  it("registers and real verifier consumes once", async () => {
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => 10 } });
    const h = await open(state);
    const r = await mint(state, h);
    const v = new StrictOutboundAuthorityVerifier(binding.nodeId, state, { now: () => 10 });
    const a = {
      kind: "authorized_request" as const,
      receiptId: r.receiptId,
      requestId: r.requestId,
      requestType: r.requestType,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
    };
    const e = {
      type: "daemon.get_status.response",
      payload: { requestId: "request-a", phase: "x" },
    } as const;
    expect(await v.verify(binding, e, a)).toBe(true);
    expect(await v.verify(binding, e, a)).toBe(false);
    expect(await state.consumeAuthorizedRequest(r.receiptId)).toBeNull();
  });
  it("captures each register descriptor once and rejects nested accessor binding without collateral", async () => {
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => 10 } });
    state.registerSessionBinding(binding);
    const handle = fakeHandle();
    const descriptorReads = new Map<string, number>();
    const input = new Proxy(
      { handle, binding },
      {
        getOwnPropertyDescriptor(target, property) {
          const key = String(property);
          descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
          if ((descriptorReads.get(key) ?? 0) > 1) throw new Error("descriptor reread");
          return Object.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    expect(await state.register(input)).toEqual(binding);
    expect([...descriptorReads.values()]).toEqual([1, 1]);

    const secondHandle = fakeHandle();
    const malformedBinding = { ...binding } as Record<string, unknown>;
    Object.defineProperty(malformedBinding, "clientId", {
      enumerable: true,
      get() {
        throw new Error("nested accessor");
      },
    });
    expect(
      await state.register({
        handle: secondHandle,
        binding: malformedBinding as AuthoritySessionBindingRecord,
      }),
    ).toBeNull();
    expect(await state.register({ handle: secondHandle, binding })).toEqual(binding);
  });
  it("replacement invalidates old handle/receipt", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const h = await open(s);
    const r = await mint(s, h);
    const n = {
      ...binding,
      sessionBindingKey: createEnterpriseSessionBindingKey({
        organizationId: binding.organizationId,
        principalId: binding.principalId,
        credentialId: binding.credentialId,
        grantVersion: "grant-v2",
        clientId: binding.clientId,
      }),
      sessionBindingGeneration: "generation-new",
      grantVersion: "grant-v2",
    };
    s.registerSessionBinding(n);
    expect(
      await s.resolveOpen({
        handle: h,
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(await s.consumeAuthorizedRequest(r.receiptId)).toBeNull();
    expect(await open(s, n)).toBeTruthy();
  });
  it("burns before clock and rollback cannot resurrect", async () => {
    let fail = false;
    const s = new MemoryAuthorityReceiptState({
      clock: {
        now: () => {
          if (fail) throw Error("clock");
          return 10;
        },
      },
    });
    const h = await open(s);
    const r = await mint(s, h);
    fail = true;
    await expect(s.consumeAuthorizedRequest(r.receiptId)).rejects.toThrow("clock");
    fail = false;
    await expect(s.consumeAuthorizedRequest(r.receiptId)).resolves.toBeNull();
  });
  it("rejects malformed materialization and preserves active receipt", async () => {
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => "receipt-aaaaaaaaaaaaaaa",
    });
    const h = await open(s);
    const r = await mint(s, h);
    const bad = await s.mintFreshReceipt({
      handle: h,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
      emission: "repeatable",
      materializeReceipt: ({ receiptId, expiresAt }) => ({
        ...r,
        receiptId: `${receiptId}-bad`,
        expiresAt,
      }),
    });
    expect(bad).toBeNull();
    expect(await s.consumeAuthorizedRequest(r.receiptId)).not.toBeNull();
  });
  it("terminal close permits a fresh request on same binding", async () => {
    let n = 0;
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () =>
        `receipt-${String(++n).padStart(AUTHORITY_RECEIPT_ID_MIN_LENGTH, "0")}`,
    });
    const h = await open(s);
    await mint(s, h, binding, "terminal-a", "terminal");
    await s.close({
      handle: h,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
      reason: "end",
    });
    expect(await mint(s, await open(s), binding, "terminal-b")).toBeTruthy();
  });
  it.each([
    [
      "credential",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidateCredential({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
          credentialId: binding.credentialId,
        }),
    ],
    [
      "principal",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidatePrincipal({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
        }),
    ],
    [
      "grant",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidateGrant({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
          grantVersion: binding.grantVersion,
        }),
    ],
    [
      "session",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidateSession({
          sessionId: binding.sessionId,
          sessionBindingKey: binding.sessionBindingKey,
          sessionBindingGeneration: binding.sessionBindingGeneration,
        }),
    ],
  ])("invalidates exact %s scope", async (_n, fn) => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const h = await open(s);
    const r = await mint(s, h);
    fn(s);
    expect(await s.consumeAuthorizedRequest(r.receiptId)).toBeNull();
  });
  it("invalidateSession removes target binding/handle/receipt and preserves survivor", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetBinding = variant({ sessionId: "session-target" });
    const survivorBinding = variant({
      sessionId: "session-survivor",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    });
    const targetHandle = await open(s, targetBinding);
    const survivorHandle = await open(s, survivorBinding);
    const target = await mint(s, targetHandle, targetBinding, "target");
    const survivor = await mint(s, survivorHandle, survivorBinding, "survivor");
    s.invalidateSession({
      sessionId: targetBinding.sessionId,
      sessionBindingKey: targetBinding.sessionBindingKey,
      sessionBindingGeneration: targetBinding.sessionBindingGeneration,
    });
    expect(await s.resolveCurrentSessionBinding(lookup(targetBinding))).toBeNull();
    expect(
      await s.resolveOpen({
        handle: targetHandle,
        sessionBindingKey: targetBinding.sessionBindingKey,
        sessionBindingGeneration: targetBinding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(await s.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: survivorHandle,
        sessionBindingKey: survivorBinding.sessionBindingKey,
        sessionBindingGeneration: survivorBinding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(survivor.receiptId)).not.toBeNull();
  });
  it("invalidateGeneration removes only the exact generation target", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetBinding = variant({
      sessionId: "generation-target",
      sessionBindingGeneration: "generation-target",
    });
    const survivorBinding = variant({
      sessionId: "generation-survivor",
      sessionBindingGeneration: "generation-survivor",
    });
    const targetHandle = await open(s, targetBinding);
    const survivorHandle = await open(s, survivorBinding);
    const target = await mint(s, targetHandle, targetBinding, "target");
    const survivor = await mint(s, survivorHandle, survivorBinding, "survivor");
    s.invalidateGeneration(sessionScope(targetBinding));
    expect(await s.resolveCurrentSessionBinding(lookup(targetBinding))).toBeNull();
    expect(
      await s.resolveOpen({
        handle: targetHandle,
        sessionBindingKey: targetBinding.sessionBindingKey,
        sessionBindingGeneration: targetBinding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(await s.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: survivorHandle,
        sessionBindingKey: survivorBinding.sessionBindingKey,
        sessionBindingGeneration: survivorBinding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(survivor.receiptId)).not.toBeNull();
  });
  it("releaseSession removes target and preserves a different session", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetBinding = variant({ sessionId: "release-target" });
    const survivorBinding = variant({
      sessionId: "release-survivor",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    });
    const targetHandle = await open(s, targetBinding);
    const survivorHandle = await open(s, survivorBinding);
    const target = await mint(s, targetHandle, targetBinding, "target");
    const survivor = await mint(s, survivorHandle, survivorBinding, "survivor");
    s.releaseSession(sessionScope(targetBinding));
    expect(await s.resolveCurrentSessionBinding(lookup(targetBinding))).toBeNull();
    expect(
      await s.resolveOpen({
        handle: targetHandle,
        sessionBindingKey: targetBinding.sessionBindingKey,
        sessionBindingGeneration: targetBinding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(await s.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: survivorHandle,
        sessionBindingKey: survivorBinding.sessionBindingKey,
        sessionBindingGeneration: survivorBinding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(survivor.receiptId)).not.toBeNull();
  });
  it("invalidateCredential removes same credential across grants/generations only", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetA = variant({
      sessionId: "credential-a",
      grantVersion: "grant-a",
      sessionBindingGeneration: "generation-a",
    });
    const targetB = variant({
      sessionId: "credential-b",
      grantVersion: "grant-b",
      sessionBindingGeneration: "generation-b",
    });
    const survivorBinding = variant({
      sessionId: "credential-survivor",
      credentialId: "cred-other",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    });
    const ha = await open(s, targetA);
    const hb = await open(s, targetB);
    const hs = await open(s, survivorBinding);
    const ra = await mint(s, ha, targetA, "a");
    const rb = await mint(s, hb, targetB, "b");
    const rs = await mint(s, hs, survivorBinding, "s");
    s.invalidateCredential({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      credentialId: binding.credentialId,
    });
    expect(await s.resolveCurrentSessionBinding(lookup(targetA))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(targetB))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: ha,
        sessionBindingKey: targetA.sessionBindingKey,
        sessionBindingGeneration: targetA.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(
      await s.resolveOpen({
        handle: hb,
        sessionBindingKey: targetB.sessionBindingKey,
        sessionBindingGeneration: targetB.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(await s.consumeAuthorizedRequest(ra.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rb.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rs.receiptId)).not.toBeNull();
  });
  it("invalidatePrincipal removes all target credentials/grants/generations only", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetA = variant({
      sessionId: "principal-a",
      credentialId: "cred-a",
      grantVersion: "grant-a",
    });
    const targetB = variant({
      sessionId: "principal-b",
      credentialId: "cred-b",
      grantVersion: "grant-b",
    });
    const survivorBinding = variant({
      sessionId: "principal-survivor",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    });
    const ha = await open(s, targetA);
    const hb = await open(s, targetB);
    const hs = await open(s, survivorBinding);
    const ra = await mint(s, ha, targetA, "a");
    const rb = await mint(s, hb, targetB, "b");
    const rs = await mint(s, hs, survivorBinding, "s");
    s.invalidatePrincipal({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
    });
    expect(await s.resolveCurrentSessionBinding(lookup(targetA))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(targetB))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(ra.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rb.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rs.receiptId)).not.toBeNull();
  });
  it("invalidateGrant removes matching grant across credentials/generations only", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetA = variant({
      sessionId: "grant-a",
      credentialId: "cred-a",
      sessionBindingGeneration: "generation-a",
    });
    const targetB = variant({
      sessionId: "grant-b",
      credentialId: "cred-b",
      sessionBindingGeneration: "generation-b",
    });
    const survivorBinding = variant({ sessionId: "grant-survivor", grantVersion: "grant-other" });
    const ha = await open(s, targetA);
    const hb = await open(s, targetB);
    const hs = await open(s, survivorBinding);
    const ra = await mint(s, ha, targetA, "a");
    const rb = await mint(s, hb, targetB, "b");
    const rs = await mint(s, hs, survivorBinding, "s");
    s.invalidateGrant({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      grantVersion: binding.grantVersion,
    });
    expect(await s.resolveCurrentSessionBinding(lookup(targetA))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(targetB))).toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(ra.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rb.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rs.receiptId)).not.toBeNull();
  });
  it("freezes receipt output", async () => {
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => "receipt-aaaaaaaaaaaaaaa",
    });
    const r = await mint(s, await open(s));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.authorization)).toBe(true);
    expect(Object.isFrozen(r.authorization.enterpriseActions)).toBe(true);
  });
  it("keeps binding snapshot after caller mutation through register/resolve/mint/consume", async () => {
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => "receipt-snapshot-0001",
    });
    const callerBinding = { ...binding };
    s.registerSessionBinding(callerBinding);
    const handle = fakeHandle();
    expect(await s.register({ handle, binding: callerBinding })).toEqual(binding);
    callerBinding.organizationId = "org_bbbbbbbbbbbbbbbb";
    callerBinding.grantVersion = "grant-mutated";
    expect(await s.resolveCurrentSessionBinding(lookup(binding))).toEqual(binding);
    const receipt = await mint(s, handle, binding);
    expect(receipt.organizationId).toBe(binding.organizationId);
    const consumed = await s.consumeAuthorizedRequest(receipt.receiptId);
    expect(consumed?.currentBinding).toEqual(binding);
    expect(consumed?.receipt.organizationId).toBe(binding.organizationId);
  });
  it("returns a fully frozen detached consume wrapper", async () => {
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => "receipt-detached-0001",
    });
    const consumed = await s.consumeAuthorizedRequest((await mint(s, await open(s))).receiptId);
    expect(consumed).not.toBeNull();
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed?.receipt)).toBe(true);
    expect(Object.isFrozen(consumed?.currentBinding)).toBe(true);
    expect(Object.isFrozen(consumed?.receipt.authorization)).toBe(true);
    expect(Object.isFrozen(consumed?.receipt.authorization.enterpriseActions)).toBe(true);
    expect(consumed?.receipt).not.toBe(consumed?.currentBinding);
    expect(consumed?.receipt.authorization.enterpriseActions).not.toBe(consumed?.currentBinding);
  });
  it("recovers after mint clock failure without losing the handle", async () => {
    let shouldThrow = true;
    const s = new MemoryAuthorityReceiptState({
      clock: {
        now: () => {
          if (shouldThrow) throw new Error("clock");
          return 1;
        },
      },
      receiptIdFactory: () => "receipt-clock-recover-0001",
    });
    const h = await open(s);
    expect(
      await s.mintFreshReceipt({
        handle: h,
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
        emission: "repeatable",
        materializeReceipt: ({ receiptId, expiresAt }) => ({
          ...binding,
          receiptId,
          expiresAt,
          requestId: "request-a",
          requestType: "daemon.get_status.request",
          authorization: {
            succeeded: true,
            daemonPermission: "daemon.read",
            enterpriseActions: [],
          },
        }),
      }),
    ).toBeNull();
    shouldThrow = false;
    expect(await mint(s, h)).not.toBeNull();
  });
  it.each(["binding", "receiptId", "expiresAt", "extra", "getter"])(
    "rejects materialized %s while preserving active and survivor receipts",
    async (kind) => {
      let phase = 0;
      const selected = "receipt-materialized-bad";
      const s = new MemoryAuthorityReceiptState({
        clock: { now: () => 1 },
        receiptIdFactory: () => {
          phase += 1;
          if (phase === 1) return "receipt-materialized-good";
          if (phase === 2) return "receipt-materialized-survivor";
          return selected;
        },
      });
      const targetBinding = variant({ sessionId: "materialized-target" });
      const survivorBinding = variant({
        sessionId: "materialized-survivor",
        principalId: "usr_bbbbbbbbbbbbbbbb",
      });
      const targetHandle = await open(s, targetBinding);
      const survivorHandle = await open(s, survivorBinding);
      const active = await mint(s, targetHandle, targetBinding, "active");
      const survivor = await mint(s, survivorHandle, survivorBinding, "survivor");
      const failed = await s.mintFreshReceipt({
        handle: targetHandle,
        sessionBindingKey: targetBinding.sessionBindingKey,
        sessionBindingGeneration: targetBinding.sessionBindingGeneration,
        emission: "repeatable",
        materializeReceipt: ({ receiptId, expiresAt }) => {
          const result: Record<string, unknown> = {
            ...targetBinding,
            receiptId,
            expiresAt,
            requestId: "failed",
            requestType: "daemon.get_status.request",
            authorization: {
              succeeded: true,
              daemonPermission: "daemon.read",
              enterpriseActions: [],
            },
          };
          if (kind === "binding") result.organizationId = "org_bbbbbbbbbbbbbbbb";
          if (kind === "receiptId") result.receiptId = "receipt-wrong-materialized";
          if (kind === "expiresAt") result.expiresAt = expiresAt + 1;
          if (kind === "extra") result.extra = "unexpected";
          if (kind === "getter")
            Object.defineProperty(result, "requestId", {
              enumerable: true,
              get: () => {
                throw new Error("getter");
              },
            });
          return result;
        },
      });
      expect(failed).toBeNull();
      expect(await s.consumeAuthorizedRequest(active.receiptId)).not.toBeNull();
      expect(await s.consumeAuthorizedRequest(survivor.receiptId)).not.toBeNull();
      expect(
        await s.mintFreshReceipt({
          handle: targetHandle,
          sessionBindingKey: targetBinding.sessionBindingKey,
          sessionBindingGeneration: targetBinding.sessionBindingGeneration,
          emission: "repeatable",
          materializeReceipt: ({ receiptId, expiresAt }) => ({
            ...targetBinding,
            receiptId,
            expiresAt,
            requestId: "failed-again",
            requestType: "daemon.get_status.request",
            authorization: {
              succeeded: true,
              daemonPermission: "daemon.read",
              enterpriseActions: [],
            },
          }),
        }),
      ).toBeNull();
    },
  );
  it.each([
    [
      "credential",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidateCredential({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
          credentialId: binding.credentialId,
        }),
    ],
    [
      "principal",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidatePrincipal({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
        }),
    ],
    [
      "grant",
      (s: MemoryAuthorityReceiptState) =>
        s.invalidateGrant({
          organizationId: binding.organizationId,
          principalId: binding.principalId,
          grantVersion: binding.grantVersion,
        }),
    ],
  ])("scope %s leaves a cross-principal survivor", async (_name, invalidate) => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const h = await open(s);
    const target = await mint(s, h);
    const survivorBinding = {
      ...binding,
      principalId: "usr_bbbbbbbbbbbbbbbb",
      sessionId: "session-b",
      sessionBindingKey: "survivor-key",
    };
    const survivorHandle = await open(s, survivorBinding);
    const survivor = await mint(s, survivorHandle, survivorBinding, "survivor");
    invalidate(s);
    expect(await s.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(survivor.receiptId)).not.toBeNull();
  });
  it("same request ids remain isolated across sessions", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const a = await open(s);
    const bBinding = { ...binding, sessionId: "session-b", sessionBindingKey: "session-b-key" };
    const b = await open(s, bBinding);
    const ra = await mint(s, a, binding, "same");
    const rb = await mint(s, b, bBinding, "same");
    s.endRequest({
      sessionId: binding.sessionId,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
      requestId: "same",
    });
    expect(await s.consumeAuthorizedRequest(ra.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rb.receiptId)).not.toBeNull();
  });
  it("endRequest closes only the exact request within one binding", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const h = await open(s);
    const h2 = fakeHandle();
    expect(await s.register({ handle: h2, binding })).toEqual(binding);
    const first = await mint(s, h, binding, "first");
    const second = await mint(s, h2, binding, "second");
    s.endRequest({
      sessionId: binding.sessionId,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
      requestId: "first",
    });
    expect(await s.consumeAuthorizedRequest(first.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(second.receiptId)).not.toBeNull();
  });
  it("cancelRequest does not close same requestId on another binding", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const aBinding = variant({ sessionId: "cancel-a" });
    const bBinding = variant({ sessionId: "cancel-b", principalId: "usr_bbbbbbbbbbbbbbbb" });
    const a = await open(s, aBinding);
    const b = await open(s, bBinding);
    const ra = await mint(s, a, aBinding, "same");
    const rb = await mint(s, b, bBinding, "same");
    s.cancelRequest({
      sessionId: aBinding.sessionId,
      sessionBindingKey: aBinding.sessionBindingKey,
      sessionBindingGeneration: aBinding.sessionBindingGeneration,
      requestId: "same",
    });
    expect(await s.consumeAuthorizedRequest(ra.receiptId)).toBeNull();
    expect(await s.consumeAuthorizedRequest(rb.receiptId)).not.toBeNull();
  });
  it("rejects malformed invalidation without collateral", async () => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const r = await mint(s, await open(s));
    s.invalidatePrincipal({ organizationId: "bad", principalId: "bad" });
    expect(await s.consumeAuthorizedRequest(r.receiptId)).not.toBeNull();
  });
  it("purges expired receipts before capacity", async () => {
    let now = 1;
    let ids = 0;
    const s = new MemoryAuthorityReceiptState({
      maxReceipts: 1,
      clock: { now: () => now },
      receiptIdFactory: () => `receipt-${String(++ids).padStart(16, "0")}`,
    });
    const h = await open(s);
    await mint(s, h);
    now = 40000;
    expect(
      await s.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
  });
  it("captures factory method and rejects short/throwing ids", async () => {
    let factory = () => "receipt-aaaaaaaaaaaaaaa";
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => factory(),
    });
    const h = await open(s);
    expect(await mint(s, h)).toBeTruthy();
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    AUTHORITY_RECEIPT_CAPACITY_HARD_MAX + 1,
  ])("rejects invalid capacity %s before reading clock/factory", (capacity) => {
    let clockReads = 0;
    let factoryReads = 0;
    const options: Record<string, unknown> = { maxReceipts: capacity };
    Object.defineProperty(options, "clock", {
      enumerable: true,
      get() {
        clockReads += 1;
        return { now: () => 1 };
      },
    });
    Object.defineProperty(options, "receiptIdFactory", {
      enumerable: true,
      get() {
        factoryReads += 1;
        return () => "receipt-aaaaaaaaaaaaaaa";
      },
    });
    expect(() => new MemoryAuthorityReceiptState(options as never)).toThrow("capacity");
    expect(clockReads).toBe(0);
    expect(factoryReads).toBe(0);
  });
  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    60_001,
  ])("rejects invalid TTL %s before reading clock/factory", (receiptTtlMs) => {
    let clockReads = 0;
    let factoryReads = 0;
    const options: Record<string, unknown> = { receiptTtlMs };
    Object.defineProperty(options, "clock", {
      enumerable: true,
      get() {
        clockReads += 1;
        return { now: () => 1 };
      },
    });
    Object.defineProperty(options, "receiptIdFactory", {
      enumerable: true,
      get() {
        factoryReads += 1;
        return () => "receipt-aaaaaaaaaaaaaaa";
      },
    });
    expect(() => new MemoryAuthorityReceiptState(options as never)).toThrow("TTL");
    expect(clockReads).toBe(0);
    expect(factoryReads).toBe(0);
  });
  it("accepts hard maximum capacity", () => {
    expect(
      () => new MemoryAuthorityReceiptState({ maxReceipts: AUTHORITY_RECEIPT_CAPACITY_HARD_MAX }),
    ).not.toThrow();
  });
  it("burns a selected id before materialization failure", async () => {
    let next = 0;
    const selected: string[] = [];
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => `receipt-${String(++next).padStart(16, "0")}`,
    });
    const h = await open(s);
    const failed = await s.mintFreshReceipt({
      handle: h,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
      emission: "repeatable",
      materializeReceipt: ({ receiptId }) => {
        selected.push(receiptId);
        return null;
      },
    });
    expect(failed).toBeNull();
    const recovered = await mint(s, h);
    expect(selected[0]).not.toBe(recovered.receiptId);
  });
  it("purges expired receipt before capacity check", async () => {
    let now = 1;
    let next = 0;
    const s = new MemoryAuthorityReceiptState({
      maxReceipts: 1,
      receiptTtlMs: 10,
      clock: { now: () => now },
      receiptIdFactory: () => `receipt-${String(++next).padStart(16, "0")}`,
    });
    const h = await open(s);
    await mint(s, h);
    now = 11;
    expect(await mint(s, h)).not.toBeNull();
  });
  it("enforces expiry before boundary and accepts one tick after", async () => {
    let now = 1;
    const create = async () => {
      const s = new MemoryAuthorityReceiptState({
        receiptTtlMs: 10,
        clock: { now: () => now },
        receiptIdFactory: () => `receipt-${String(now).padStart(16, "0")}`,
      });
      const h = await open(s);
      return { s, r: await mint(s, h) };
    };
    const before = await create();
    now = 10;
    expect(await before.s.consumeAuthorizedRequest(before.r.receiptId)).not.toBeNull();
    const exact = await create();
    now = 20;
    expect(await exact.s.consumeAuthorizedRequest(exact.r.receiptId)).toBeNull();
    now = 1;
    const after = await create();
    now = 10;
    expect(await after.s.consumeAuthorizedRequest(after.r.receiptId)).not.toBeNull();
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe clock %s while keeping handle recoverable",
    async (clockValue) => {
      let now: number = clockValue;
      const s = new MemoryAuthorityReceiptState({
        clock: { now: () => now },
        receiptIdFactory: () => "receipt-aaaaaaaaaaaaaaa",
      });
      const h = await open(s);
      expect(
        await s.mintFreshReceipt({
          handle: h,
          sessionBindingKey: binding.sessionBindingKey,
          sessionBindingGeneration: binding.sessionBindingGeneration,
          emission: "repeatable",
          materializeReceipt: ({ receiptId, expiresAt }) => ({
            ...binding,
            receiptId,
            expiresAt,
            requestId: "request-a",
            requestType: "daemon.get_status.request",
            authorization: {
              succeeded: true,
              daemonPermission: "daemon.read",
              enterpriseActions: [],
            },
          }),
        }),
      ).toBeNull();
      now = 1;
      expect(await mint(s, h)).not.toBeNull();
    },
  );
  it("burns receipt on clock rollback and cannot reuse after recovery", async () => {
    let now = 10;
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => now },
      receiptIdFactory: () => "receipt-aaaaaaaaaaaaaaa",
    });
    const r = await mint(s, await open(s));
    now = 9;
    await expect(s.consumeAuthorizedRequest(r.receiptId)).rejects.toThrow("clock");
    now = 10;
    await expect(s.consumeAuthorizedRequest(r.receiptId)).resolves.toBeNull();
  });
  it("rejects expiry addition overflow without allocating an id", async () => {
    let factoryCalls = 0;
    const s = new MemoryAuthorityReceiptState({
      receiptTtlMs: 1,
      clock: { now: () => Number.MAX_SAFE_INTEGER },
      receiptIdFactory: () => {
        factoryCalls += 1;
        return "receipt-aaaaaaaaaaaaaaa";
      },
    });
    const h = await open(s);
    expect(
      await s.mintFreshReceipt({
        handle: h,
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
        emission: "repeatable",
        materializeReceipt: ({ receiptId, expiresAt }) => ({
          ...binding,
          receiptId,
          expiresAt,
          requestId: "request-a",
          requestType: "daemon.get_status.request",
          authorization: {
            succeeded: true,
            daemonPermission: "daemon.read",
            enterpriseActions: [],
          },
        }),
      }),
    ).toBeNull();
    expect(factoryCalls).toBe(0);
  });
  it("captures clock and factory methods at construction", async () => {
    let now = 1;
    let id = 0;
    const clock = { now: () => now };
    const factory = { make: () => `receipt-${String(++id).padStart(16, "0")}` };
    const s = new MemoryAuthorityReceiptState({
      clock,
      receiptIdFactory: factory.make.bind(factory),
    });
    clock.now = () => 99;
    factory.make = () => "receipt-mutated-mutated";
    const r = await mint(s, await open(s));
    expect(r.expiresAt).toBe(30_001);
    expect(r.receiptId).toBe("receipt-0000000000000001");
  });
  it("tries bounded invalid and collision candidates without replacing existing receipt", async () => {
    let calls = 0;
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => {
        calls += 1;
        return "short";
      },
    });
    const h = await open(s);
    expect(
      await s.mintFreshReceipt({
        handle: h,
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
        emission: "repeatable",
        materializeReceipt: ({ receiptId, expiresAt }) => ({
          ...binding,
          receiptId,
          expiresAt,
          requestId: "request-a",
          requestType: "daemon.get_status.request",
          authorization: {
            succeeded: true,
            daemonPermission: "daemon.read",
            enterpriseActions: [],
          },
        }),
      }),
    ).toBeNull();
    expect(calls).toBe(AUTHORITY_RECEIPT_ID_MAX_ATTEMPTS);
  });
  it("burns three colliding candidates and accepts the fourth fresh id", async () => {
    const existingId = "receipt-existing-0001";
    const freshId = "receipt-fresh-0001";
    let calls = 0;
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => {
        calls += 1;
        if (calls === 1 || calls <= 4) return existingId;
        return freshId;
      },
    });
    const h = await open(s);
    const first = await mint(s, h);
    expect(first.receiptId).toBe(existingId);
    const second = await mint(s, h);
    expect(second.receiptId).toBe(freshId);
    expect(calls).toBe(5);
  });
  it("fails closed when the captured factory throws", async () => {
    let calls = 0;
    const s = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => {
        calls += 1;
        throw new Error("factory");
      },
    });
    const h = await open(s);
    expect(
      await s.mintFreshReceipt({
        handle: h,
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
        emission: "repeatable",
        materializeReceipt: ({ receiptId, expiresAt }) => ({
          ...binding,
          receiptId,
          expiresAt,
          requestId: "request-a",
          requestType: "daemon.get_status.request",
          authorization: {
            succeeded: true,
            daemonPermission: "daemon.read",
            enterpriseActions: [],
          },
        }),
      }),
    ).toBeNull();
    expect(calls).toBe(1);
  });
  it.each(
    [
      "extra",
      "symbol",
      "non-enumerable",
      "inherited",
      "accessor",
      "throw-ownKeys",
      "throw-descriptor",
    ].flatMap((mode) =>
      [
        {
          name: "register",
          value: (h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            handle: h,
            binding: b,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) => s.register(value as never),
        },
        {
          name: "resolveOpen",
          value: (h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            handle: h,
            sessionBindingKey: b.sessionBindingKey,
            sessionBindingGeneration: b.sessionBindingGeneration,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) => s.resolveOpen(value as never),
        },
        {
          name: "mintFreshReceipt",
          value: (h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            handle: h,
            sessionBindingKey: b.sessionBindingKey,
            sessionBindingGeneration: b.sessionBindingGeneration,
            emission: "repeatable",
            materializeReceipt: ({
              receiptId,
              expiresAt,
            }: {
              receiptId: string;
              expiresAt: number;
            }) => ({
              ...b,
              receiptId,
              expiresAt,
              requestId: "target",
              requestType: "daemon.get_status.request",
              authorization: {
                succeeded: true,
                daemonPermission: "daemon.read",
                enterpriseActions: [],
              },
            }),
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.mintFreshReceipt(value as never),
        },
        {
          name: "burnFreshReceipts",
          value: (h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            handle: h,
            sessionBindingKey: b.sessionBindingKey,
            sessionBindingGeneration: b.sessionBindingGeneration,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.burnFreshReceipts(value as never),
        },
        {
          name: "close",
          value: (h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            handle: h,
            sessionBindingKey: b.sessionBindingKey,
            sessionBindingGeneration: b.sessionBindingGeneration,
            reason: "end",
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) => s.close(value as never),
        },
        {
          name: "registerSessionBinding",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => b,
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.registerSessionBinding(value as never),
        },
        {
          name: "resolveCurrentSessionBinding",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => lookup(b),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.resolveCurrentSessionBinding(value as never),
        },
        {
          name: "endRequest",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            ...sessionScope(b),
            requestId: "target",
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) => s.endRequest(value as never),
        },
        {
          name: "cancelRequest",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            ...sessionScope(b),
            requestId: "target",
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.cancelRequest(value as never),
        },
        {
          name: "invalidateSession",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) =>
            sessionScope(b),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.invalidateSession(value as never),
        },
        {
          name: "invalidateGeneration",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) =>
            sessionScope(b),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.invalidateGeneration(value as never),
        },
        {
          name: "invalidateCredential",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            organizationId: b.organizationId,
            principalId: b.principalId,
            credentialId: b.credentialId,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.invalidateCredential(value as never),
        },
        {
          name: "invalidatePrincipal",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            organizationId: b.organizationId,
            principalId: b.principalId,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.invalidatePrincipal(value as never),
        },
        {
          name: "invalidateGrant",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) => ({
            organizationId: b.organizationId,
            principalId: b.principalId,
            grantVersion: b.grantVersion,
          }),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.invalidateGrant(value as never),
        },
        {
          name: "releaseSession",
          value: (_h: ActiveAuthorizedRequestHandle, b: AuthoritySessionBindingRecord) =>
            sessionScope(b),
          invoke: (s: MemoryAuthorityReceiptState, value: unknown) =>
            s.releaseSession(value as never),
        },
      ].map((api) => ({ mode, api })),
    ),
  )("rejects %s input for %s without collateral", async ({ mode, api }) => {
    const s = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    const targetBinding = variant({ sessionId: "malformed-target" });
    const survivorBinding = variant({
      sessionId: "malformed-survivor",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    });
    const targetHandle = await open(s, targetBinding);
    const survivorHandle = await open(s, survivorBinding);
    const targetReceipt = await mint(s, targetHandle, targetBinding, "target");
    const survivorReceipt = await mint(s, survivorHandle, survivorBinding, "survivor");
    const reads = { count: 0 };
    const malformed = malformedInput(
      api.value(targetHandle, targetBinding),
      mode as MalformedMode,
      reads,
    );
    if (api.name === "registerSessionBinding") expect(() => api.invoke(s, malformed)).toThrow();
    else await api.invoke(s, malformed);
    if (mode === "accessor") expect(reads.count).toBe(0);
    expect(await s.resolveCurrentSessionBinding(lookup(targetBinding))).not.toBeNull();
    expect(await s.resolveCurrentSessionBinding(lookup(survivorBinding))).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: targetHandle,
        sessionBindingKey: targetBinding.sessionBindingKey,
        sessionBindingGeneration: targetBinding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
    expect(
      await s.resolveOpen({
        handle: survivorHandle,
        sessionBindingKey: survivorBinding.sessionBindingKey,
        sessionBindingGeneration: survivorBinding.sessionBindingGeneration,
      }),
    ).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(targetReceipt.receiptId)).not.toBeNull();
    expect(await s.consumeAuthorizedRequest(survivorReceipt.receiptId)).not.toBeNull();
  });
});
