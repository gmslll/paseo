import { beforeEach, describe, expect, test } from "vitest";

import { createAttachTokenStore, type AttachTokenClaims } from "./attach-token-store.js";

const TTL_MS = 60_000;

let clock: number;

function createStore() {
  return createAttachTokenStore({ now: () => clock, ttlMs: TTL_MS });
}

function claims(overrides: Partial<AttachTokenClaims> = {}): AttachTokenClaims {
  return {
    sessionId: "ses_1",
    plane: "terminal",
    principalId: "usr_0123456789abcdef",
    grantVersion: "grv_1",
    ...overrides,
  };
}

beforeEach(() => {
  clock = 1_000_000;
});

describe("attach token store", () => {
  test("spends a token once and returns the claims it was issued for", () => {
    const store = createStore();
    const issued = store.issue(claims());

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(clock + TTL_MS);
    expect(store.consume({ token: issued.token, plane: "terminal" })).toEqual(claims());
    expect(store.consume({ token: issued.token, plane: "terminal" })).toBeNull();
    expect(store.outstanding).toBe(0);
  });

  test("refuses another plane, an unknown token, and one that has expired", () => {
    const store = createStore();
    const terminal = store.issue(claims());
    const data = store.issue(claims({ plane: "data" }));

    expect(store.consume({ token: terminal.token, plane: "data" })).toBeNull();
    expect(store.consume({ token: "not-a-token", plane: "terminal" })).toBeNull();
    // A token spent for the wrong plane is gone, exactly like one spent correctly.
    expect(store.consume({ token: terminal.token, plane: "terminal" })).toBeNull();

    clock += TTL_MS;
    expect(store.consume({ token: data.token, plane: "data" })).toBeNull();
    expect(store.outstanding).toBe(0);
  });

  test("drops the tokens of a Session that went away", () => {
    const store = createStore();
    const mine = store.issue(claims());
    const other = store.issue(claims({ sessionId: "ses_2" }));

    store.revokeSession("ses_1");

    expect(store.consume({ token: mine.token, plane: "terminal" })).toBeNull();
    expect(store.consume({ token: other.token, plane: "terminal" })).toEqual(
      claims({ sessionId: "ses_2" }),
    );
  });
});
