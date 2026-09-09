import { describe, expect, it } from "vitest";
import { MemoryAuthorityReceiptState } from "./enterprise-authority-receipt-state.js";
import type { AuthoritySessionBindingRecord } from "../enterprise/access/authority-receipt-verifier.js";

const binding: AuthoritySessionBindingRecord = {
  sessionId: "session-a",
  sessionBindingKey: "binding-a",
  sessionBindingGeneration: "generation-a",
  organizationId: "org_aaaaaaaaaaaaaaaa",
  principalId: "usr_aaaaaaaaaaaaaaaa",
  principalType: "human",
  credentialId: "cred-a",
  grantVersion: "grant-v1",
  nodeId: "nod_aaaaaaaaaaaaaaaa",
  clientId: "client-a",
};
const input = {
  ...binding,
  requestId: "request-a",
  requestType: "enterprise.identity.get_current.request",
  expiresAt: 100,
  authorization: { succeeded: true as const, daemonPermission: null, enterpriseActions: [] },
};
describe("MemoryAuthorityReceiptState", () => {
  it("registers, atomically consumes once, and rejects stale handles", async () => {
    let now = 10;
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => now } });
    state.registerSessionBinding(binding);
    const receipt = state.registerAuthorizedRequest(input);
    const [first, second] = await Promise.all([
      state.consumeAuthorizedRequest(receipt.receiptId),
      state.consumeAuthorizedRequest(receipt.receiptId),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    state.registerAuthorizedRequest({ ...input, requestId: "request-b" });
    state.invalidateGeneration({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
    });
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-a",
        sessionBindingGeneration: "generation-a",
      }),
    ).toBeNull();
    now = 200;
    expect(await state.consumeAuthorizedRequest(receipt.receiptId)).toBeNull();
  });
  it("consumes before clock sampling so rollback/throw cannot resurrect a receipt", async () => {
    let now = 10;
    let fail = false;
    const state = new MemoryAuthorityReceiptState({
      clock: {
        now: () => {
          if (fail) throw new Error("clock");
          return now;
        },
      },
    });
    state.registerSessionBinding(binding);
    const receipt = state.registerAuthorizedRequest({ ...input, expiresAt: 11 });
    fail = true;
    await expect(state.consumeAuthorizedRequest(receipt.receiptId)).rejects.toThrow("clock");
    fail = false;
    now = 10;
    await expect(state.consumeAuthorizedRequest(receipt.receiptId)).resolves.toBeNull();
  });
  it("replaces binding atomically and invalidates only the prior session receipts", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let n = 0;
        return () => `receipt-${String(++n).padStart(15, "0")}`;
      })(),
    });
    state.registerSessionBinding(binding);
    const oldReceipt = state.registerAuthorizedRequest(input);
    const replacement = {
      ...binding,
      sessionBindingKey: "binding-new",
      sessionBindingGeneration: "generation-new",
    };
    state.registerSessionBinding(replacement);
    expect(await state.consumeAuthorizedRequest(oldReceipt.receiptId)).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-new",
        sessionBindingGeneration: "generation-new",
      }),
    ).toEqual(expect.objectContaining({ sessionBindingKey: "binding-new" }));
  });
  it("invalidates by request/session/credential/principal/grant and bounds capacity", async () => {
    const state = new MemoryAuthorityReceiptState({
      maxReceipts: 1,
      clock: { now: () => 1 },
      receiptIdFactory: () => "receipt-aaaaaaaa",
    });
    state.registerSessionBinding(binding);
    state.registerAuthorizedRequest(input);
    expect(() => state.registerAuthorizedRequest({ ...input, requestId: "request-b" })).toThrow(
      "capacity",
    );
    state.cancelRequest({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
      requestId: "request-a",
    });
    expect(() =>
      state.registerAuthorizedRequest({ ...input, requestId: "request-b" }),
    ).not.toThrow();
    state.invalidateCredential({
      organizationId: "org_aaaaaaaaaaaaaaaa",
      principalId: "usr_aaaaaaaaaaaaaaaa",
      credentialId: "cred-a",
    });
    await expect(
      state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-a",
        sessionBindingGeneration: "generation-a",
      }),
    ).resolves.toBeNull();
  });
  it("fails closed on malformed inputs and a backwards clock", async () => {
    let now = 2;
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => now } });
    expect(() => state.registerSessionBinding({ ...binding, nodeId: "bad" })).toThrow();
    state.registerSessionBinding(binding);
    state.registerAuthorizedRequest(input);
    now = 1;
    expect(
      state.cancelRequest({
        sessionId: "session-a",
        sessionBindingKey: "binding-a",
        sessionBindingGeneration: "generation-a",
        requestId: "request-a",
      }),
    ).toBeUndefined();
    await expect(state.consumeAuthorizedRequest("missing")).resolves.toBeNull();
  });
  it("burns a receipt before a real clock rollback and keeps invalid callers isolated", async () => {
    let now = 10;
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => now } });
    state.registerSessionBinding(binding);
    const receipt = state.registerAuthorizedRequest(input);
    now = 9;
    await expect(state.consumeAuthorizedRequest(receipt.receiptId)).rejects.toThrow("clock");
    now = 10;
    await expect(state.consumeAuthorizedRequest(receipt.receiptId)).resolves.toBeNull();
    const malformed = {
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
      requestId: "request-a",
      unknown: "must-not-parse",
    };
    expect(() => state.endRequest(malformed as never)).not.toThrow();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-a",
        sessionBindingGeneration: "generation-a",
        extra: "x",
      } as never),
    ).toBeNull();
  });
  it("keeps same request ids and grants isolated across principals and binding replacement", async () => {
    let now = 10;
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => now },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const other = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(other);
    const a = state.registerAuthorizedRequest(input);
    const b = state.registerAuthorizedRequest({ ...input, ...other });
    state.endRequest({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
      requestId: "request-a",
    });
    expect(await state.consumeAuthorizedRequest(a.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(b.receiptId)).not.toBeNull();
    const replacement = {
      ...binding,
      sessionBindingGeneration: "generation-b",
      sessionBindingKey: "binding-new",
    };
    state.registerSessionBinding(replacement);
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-a",
        sessionBindingGeneration: "generation-a",
      }),
    ).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-new",
        sessionBindingGeneration: "generation-b",
      }),
    ).toEqual(expect.objectContaining(replacement));
  });
  it("rejects invalid or exhausted receipt factories without dropping existing receipts", async () => {
    const valid = "receipt-aaaaaaaa";
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => "short",
    });
    state.registerSessionBinding(binding);
    expect(() => state.registerAuthorizedRequest(input)).toThrow("collision");
    const collision = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: () => valid,
      maxReceipts: 2,
    });
    collision.registerSessionBinding(binding);
    const first = collision.registerAuthorizedRequest(input);
    expect(() => collision.registerAuthorizedRequest({ ...input, requestId: "other" })).toThrow(
      "collision",
    );
    await expect(
      collision.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).resolves.toEqual(expect.objectContaining({ sessionId: binding.sessionId }));
    expect(first.receiptId).toBe(valid);
  });

  it("returns recursively frozen receipt, binding, authorization, and actions", async () => {
    let now = 1;
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => now } });
    state.registerSessionBinding(binding);
    const source = {
      ...input,
      authorization: {
        succeeded: true as const,
        daemonPermission: null,
        enterpriseActions: ["workspace.metadata.read" as const],
      },
    };
    const receipt = state.registerAuthorizedRequest(source);
    source.authorization.enterpriseActions.push("browser.use" as never);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.authorization)).toBe(true);
    expect(Object.isFrozen(receipt.authorization.enterpriseActions)).toBe(true);
    const consumed = await state.consumeAuthorizedRequest(receipt.receiptId);
    expect(consumed).not.toBeNull();
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed!.receipt)).toBe(true);
    expect(Object.isFrozen(consumed!.receipt.authorization)).toBe(true);
    expect(Object.isFrozen(consumed!.receipt.authorization.enterpriseActions)).toBe(true);
    expect(Object.isFrozen(consumed!.currentBinding)).toBe(true);
    expect(consumed!.receipt.authorization.enterpriseActions).toEqual(["workspace.metadata.read"]);
    now = 2;
  });

  it("isolates each invalidation scope and rejects malformed callers", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const otherOrg = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
      organizationId: "org_bbbbbbbbbbbbbbbb",
      principalId: "usr_bbbbbbbbbbbbbbbb",
      credentialId: "cred-b",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(otherOrg);
    const a = state.registerAuthorizedRequest(input);
    const b = state.registerAuthorizedRequest({ ...input, ...otherOrg, requestId: "request-b" });
    state.invalidatePrincipal({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
    });
    expect(await state.consumeAuthorizedRequest(a.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(b.receiptId)).not.toBeNull();
    state.registerSessionBinding(binding);
    const c = state.registerAuthorizedRequest({ ...input, requestId: "request-c" });
    state.invalidateSession({
      sessionId: "session-a",
      sessionBindingKey: "wrong",
      sessionBindingGeneration: "generation-a",
    });
    expect(await state.consumeAuthorizedRequest(c.receiptId)).not.toBeNull();
    state.registerSessionBinding(binding);
    const d = state.registerAuthorizedRequest({ ...input, requestId: "request-d" });
    state.releaseSession({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
    });
    expect(await state.consumeAuthorizedRequest(d.receiptId)).toBeNull();
    expect(() =>
      state.invalidateGrant({ organizationId: "bad", principalId: "bad", grantVersion: "g" }),
    ).not.toThrow();
    expect(() =>
      state.invalidateCredential({ organizationId: "bad", principalId: "bad", credentialId: "c" }),
    ).not.toThrow();
    state.invalidatePrincipal({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      extra: "x",
    } as never);
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: "binding-b",
        sessionBindingGeneration: "generation-b",
      }),
    ).not.toBeNull();
  });

  it("enforces expiry edges, cleanup capacity, and hard maximum", async () => {
    let now = 10;
    expect(() => new MemoryAuthorityReceiptState({ maxReceipts: 10001 })).toThrow();
    const state = new MemoryAuthorityReceiptState({
      maxReceipts: 1,
      clock: { now: () => now },
      receiptIdFactory: () => "receipt-aaaaaaaa",
    });
    state.registerSessionBinding(binding);
    expect(() => state.registerAuthorizedRequest({ ...input, expiresAt: 10 })).toThrow("Expired");
    state.registerAuthorizedRequest({ ...input, expiresAt: 11 });
    now = 11;
    expect(() =>
      state.registerAuthorizedRequest({ ...input, requestId: "blocked", expiresAt: 12 }),
    ).not.toThrow();
    now = 12;
    expect(await state.consumeAuthorizedRequest("receipt-aaaaaaaa")).toBeNull();
  });

  it("invalidates an exact session while preserving another binding", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const survivor = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(survivor);
    const targetReceipt = state.registerAuthorizedRequest(input);
    const survivorReceipt = state.registerAuthorizedRequest({
      ...input,
      ...survivor,
      requestId: "survivor",
    });
    state.invalidateSession({
      sessionId: binding.sessionId,
      sessionBindingKey: binding.sessionBindingKey,
      sessionBindingGeneration: binding.sessionBindingGeneration,
    });
    expect(await state.consumeAuthorizedRequest(targetReceipt.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(survivorReceipt.receiptId)).not.toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: survivor.sessionBindingKey,
        sessionBindingGeneration: survivor.sessionBindingGeneration,
      }),
    ).not.toBeNull();
  });

  it("invalidates exact credential and preserves cross-credential receipt", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const survivor = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
      credentialId: "cred-b",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(survivor);
    const target = state.registerAuthorizedRequest(input);
    const keep = state.registerAuthorizedRequest({ ...input, ...survivor, requestId: "keep" });
    state.invalidateCredential({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      credentialId: binding.credentialId,
    });
    expect(await state.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(keep.receiptId)).not.toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: survivor.sessionBindingKey,
        sessionBindingGeneration: survivor.sessionBindingGeneration,
      }),
    ).not.toBeNull();
  });

  it("invalidates exact principal and preserves cross-principal receipt", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const survivor = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
      principalId: "usr_bbbbbbbbbbbbbbbb",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(survivor);
    const target = state.registerAuthorizedRequest(input);
    const keep = state.registerAuthorizedRequest({ ...input, ...survivor, requestId: "keep" });
    state.invalidatePrincipal({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
    });
    expect(await state.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(keep.receiptId)).not.toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: survivor.sessionBindingKey,
        sessionBindingGeneration: survivor.sessionBindingGeneration,
      }),
    ).not.toBeNull();
  });

  it("invalidates exact grant and preserves cross-grant receipt", async () => {
    const state = new MemoryAuthorityReceiptState({
      clock: { now: () => 1 },
      receiptIdFactory: (() => {
        let i = 0;
        return () => `receipt-${String(++i).padStart(15, "0")}`;
      })(),
    });
    const survivor = {
      ...binding,
      sessionId: "session-b",
      sessionBindingKey: "binding-b",
      sessionBindingGeneration: "generation-b",
      grantVersion: "grant-v2",
    };
    state.registerSessionBinding(binding);
    state.registerSessionBinding(survivor);
    const target = state.registerAuthorizedRequest(input);
    const keep = state.registerAuthorizedRequest({ ...input, ...survivor, requestId: "keep" });
    state.invalidateGrant({
      organizationId: binding.organizationId,
      principalId: binding.principalId,
      grantVersion: binding.grantVersion,
    });
    expect(await state.consumeAuthorizedRequest(target.receiptId)).toBeNull();
    expect(await state.consumeAuthorizedRequest(keep.receiptId)).not.toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: binding.sessionBindingKey,
        sessionBindingGeneration: binding.sessionBindingGeneration,
      }),
    ).toBeNull();
    expect(
      await state.resolveCurrentSessionBinding({
        sessionBindingKey: survivor.sessionBindingKey,
        sessionBindingGeneration: survivor.sessionBindingGeneration,
      }),
    ).not.toBeNull();
  });

  it("treats malformed, unknown, and throwing invalidation inputs as no-op", async () => {
    const state = new MemoryAuthorityReceiptState({ clock: { now: () => 1 } });
    state.registerSessionBinding(binding);
    const receipt = state.registerAuthorizedRequest(input);
    const throwing = Object.defineProperty({}, "organizationId", {
      get: () => {
        throw new Error("getter");
      },
    });
    state.invalidateSession({
      sessionId: "",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
    });
    state.releaseSession({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "",
    });
    state.invalidateCredential(throwing as never);
    state.invalidatePrincipal({
      organizationId: "bad",
      principalId: "bad",
      unknown: true,
    } as never);
    state.invalidateGrant({ organizationId: "bad", principalId: "bad", grantVersion: "" });
    state.endRequest({
      sessionId: "session-a",
      sessionBindingKey: "binding-a",
      sessionBindingGeneration: "generation-a",
      requestId: "",
    });
    expect(await state.consumeAuthorizedRequest(receipt.receiptId)).not.toBeNull();
  });

  it("captures clock and factory methods at construction and counts invalid attempts", () => {
    let now = 1;
    const clock = { now: () => now };
    let calls = 0;
    const options = {
      clock,
      receiptIdFactory: () => {
        calls++;
        return "bad";
      },
    };
    const state = new MemoryAuthorityReceiptState(options);
    clock.now = () => 999;
    options.receiptIdFactory = () => "receipt-aaaaaaaa";
    state.registerSessionBinding(binding);
    expect(() => state.registerAuthorizedRequest(input)).toThrow("collision");
    expect(calls).toBe(3);
    now = 1;
  });
});
