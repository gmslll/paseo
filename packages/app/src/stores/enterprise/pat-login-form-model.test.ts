import { describe, expect, it, vi } from "vitest";
import { createPatLoginFormModel } from "./pat-login-form-model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function authenticationSuccess<T>(value: T) {
  return { ok: true as const, value };
}

describe("PAT login form model", () => {
  it("keeps the token out of snapshots and clears it after successful authentication", async () => {
    const model = createPatLoginFormModel();
    const seen: string[] = [];
    model.setToken("pat-super-secret");

    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: true, canSubmit: true });
    expect(JSON.stringify(model.getSnapshot())).not.toContain("pat-super-secret");

    const result = await model.submit(async (token) => {
      seen.push(token);
      return authenticationSuccess("signed-in");
    });

    expect(result).toEqual({ ok: true, value: "signed-in" });
    expect(seen).toEqual(["pat-super-secret"]);
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: false, canSubmit: false });
  });

  it("returns only a reason code on failure and retains the token for a deliberate retry", async () => {
    const model = createPatLoginFormModel();
    const listener = vi.fn();
    model.subscribe(listener);
    model.setToken("pat-do-not-echo");

    const result = await model.submit(async () => ({
      ok: false as const,
      reasonCode: "identity.invalid_token",
    }));

    expect(result).toEqual({ ok: false, reasonCode: "identity.invalid_token" });
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: true, canSubmit: true });
    expect(JSON.stringify(model.getSnapshot())).not.toContain("pat-do-not-echo");
    expect(listener).toHaveBeenCalledTimes(3);

    const unexpected = await model.submit(async () => {
      throw new Error("adapter echoed pat-do-not-echo");
    });
    expect(unexpected).toEqual({ ok: false, reasonCode: "identity.unavailable" });
    expect(JSON.stringify(unexpected)).not.toContain("pat-do-not-echo");
  });

  it("normalizes an unsupported adapter reason without reflecting a PAT canary", async () => {
    const model = createPatLoginFormModel();
    model.setToken("pat-canary-must-not-escape");

    const result = await model.submit(async () => ({
      ok: false as const,
      reasonCode: "backend included pat-canary-must-not-escape",
    }));

    expect(result).toEqual({ ok: false, reasonCode: "identity.unavailable" });
    expect(JSON.stringify(result)).not.toContain("pat-canary-must-not-escape");
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: true, canSubmit: true });
  });

  it("locks duplicate submit while pending and calls authenticate once", async () => {
    const model = createPatLoginFormModel();
    const result = deferred<ReturnType<typeof authenticationSuccess<string>>>();
    const authenticate = vi.fn(() => result.promise);
    model.setToken("pat-single-flight");

    const first = model.submit(authenticate);
    expect(model.getSnapshot()).toEqual({
      status: "pending",
      hasToken: true,
      canSubmit: false,
    });

    await expect(model.submit(authenticate)).resolves.toEqual({
      ok: false,
      reasonCode: "identity.authentication_pending",
    });
    expect(authenticate).toHaveBeenCalledTimes(1);

    result.resolve(authenticationSuccess("signed-in"));
    await expect(first).resolves.toEqual({ ok: true, value: "signed-in" });
  });

  it("locks token edits and clear while authentication is pending", async () => {
    const model = createPatLoginFormModel();
    const result = deferred<ReturnType<typeof authenticationSuccess<string>>>();
    model.setToken("pat-first");

    const first = model.submit(() => result.promise);
    model.setToken("pat-next");
    model.clear();
    expect(model.getSnapshot()).toEqual({
      status: "pending",
      hasToken: true,
      canSubmit: false,
    });

    result.resolve(authenticationSuccess("signed-in"));
    await expect(first).resolves.toEqual({ ok: true, value: "signed-in" });
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: false, canSubmit: false });
  });

  it("keeps clear locked to form state without cancelling the pending request", async () => {
    const model = createPatLoginFormModel();
    const result = deferred<{ readonly ok: false; readonly reasonCode: string }>();
    model.setToken("pat-clear-pending");

    const pending = model.submit(() => result.promise);
    model.clear();
    expect(model.getSnapshot()).toEqual({
      status: "pending",
      hasToken: true,
      canSubmit: false,
    });

    result.resolve({ ok: false, reasonCode: "identity.invalid_token" });
    await pending;
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: true, canSubmit: true });
  });

  it.each(["success", "failure"] as const)(
    "is permanently closed and ignores late %s publication",
    async (outcome) => {
      const model = createPatLoginFormModel();
      const result = deferred<
        | ReturnType<typeof authenticationSuccess<string>>
        | { readonly ok: false; readonly reasonCode: string }
      >();
      let authenticationSignal: AbortSignal | undefined;
      const firstListener = vi.fn();
      const secondListener = vi.fn();
      model.subscribe(() => {
        firstListener();
        throw new Error("listener failure must be isolated");
      });
      model.subscribe(secondListener);
      model.setToken("pat-close-me");
      const pending = model.submit((_token, signal) => {
        authenticationSignal = signal;
        return result.promise;
      });
      expect(authenticationSignal?.aborted).toBe(false);
      model.close();
      expect(authenticationSignal?.aborted).toBe(true);

      expect(model.getSnapshot()).toEqual({
        status: "closed",
        hasToken: false,
        canSubmit: false,
      });
      expect(firstListener).toHaveBeenCalled();
      expect(secondListener).toHaveBeenCalledTimes(firstListener.mock.calls.length);
      const callsAfterClose = [firstListener.mock.calls.length, secondListener.mock.calls.length];

      if (outcome === "success") {
        result.resolve(authenticationSuccess("signed-in"));
      } else result.reject(new Error("late failure with pat-close-me"));
      await expect(pending).resolves.toEqual({
        ok: false,
        reasonCode: "identity.form_closed",
      });
      model.setToken("pat-must-not-reopen");
      model.clear();
      await expect(model.submit(vi.fn())).resolves.toEqual({
        ok: false,
        reasonCode: "identity.form_closed",
      });
      expect(model.getSnapshot()).toEqual({
        status: "closed",
        hasToken: false,
        canSubmit: false,
      });
      expect([firstListener.mock.calls.length, secondListener.mock.calls.length]).toEqual(
        callsAfterClose,
      );
    },
  );

  it("does not submit blank input", async () => {
    const model = createPatLoginFormModel();
    const authenticate = vi.fn();

    await expect(model.submit(authenticate)).resolves.toEqual({
      ok: false,
      reasonCode: "identity.token_required",
    });
    expect(authenticate).not.toHaveBeenCalled();
  });
});
