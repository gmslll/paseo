import { describe, expect, test } from "vitest";

import {
  MemoryGrantEditorPort,
  createGrantEditorFormModel,
  type GrantEditorPortInput,
  type GrantEditorUpdatePortInput,
} from "./grant-editor-form-model";
import type { ResourceGrant } from "@getpaseo/protocol/messages";

const PRINCIPAL_ID = "usr_1111111111111111";
const OTHER_PRINCIPAL_ID = "usr_2222222222222222";
const GENERATION_A = { value: "a" };
const GENERATION_B = { value: "b" };

const grant: ResourceGrant = {
  action: "workspace.write" as const,
  selector: { kind: "workspace" as const, workspaceIds: ["workspace-b", "workspace-a"] },
};

function listResponse(
  requestId = "list-1",
  principalId = PRINCIPAL_ID,
  revision = "rev-1",
  grants = [grant],
) {
  return { requestId, principalId, revision, grants };
}

function updateResponse(
  requestId = "update-1",
  principalId = PRINCIPAL_ID,
  revision = "rev-2",
  grants = [grant],
) {
  return { requestId, principalId, revision, grants };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createHarness<TGeneration>(generation: TGeneration) {
  let listHandler: (input: GrantEditorPortInput<TGeneration>) => Promise<unknown> = async () =>
    listResponse();
  let updateHandler: (
    input: GrantEditorUpdatePortInput<TGeneration>,
  ) => Promise<unknown> = async () => updateResponse();
  const port = new MemoryGrantEditorPort<TGeneration>({
    listGrants: (input) => listHandler(input),
    updateGrants: (input) => updateHandler(input),
  });
  const model = createGrantEditorFormModel({
    principalId: PRINCIPAL_ID,
    sessionGeneration: generation,
    port,
  });
  return {
    model,
    port,
    setListHandler: (handler: typeof listHandler) => {
      listHandler = handler;
    },
    setUpdateHandler: (handler: typeof updateHandler) => {
      updateHandler = handler;
    },
  };
}

describe("grant editor form model", () => {
  test("starts fresh with server snapshot and draft separated", async () => {
    const { model } = createHarness(GENERATION_A);
    expect(model.getSnapshot()).toMatchObject({
      status: "open",
      server: { status: "not_requested" },
      draft: [],
      mutation: { status: "idle" },
      canEdit: true,
      canSubmit: false,
    });

    await model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    const snapshot = model.getSnapshot();
    expect(snapshot.server).toMatchObject({ status: "loaded", revision: "rev-1" });
    if (snapshot.server.status !== "loaded") throw new Error("expected loaded server snapshot");
    expect(snapshot.draft).toEqual([
      {
        action: "workspace.write",
        selector: { kind: "workspace", workspaceIds: ["workspace-a", "workspace-b"] },
      },
    ]);
    expect(snapshot.draft).not.toBe(snapshot.server.grants);
    expect(Object.isFrozen(snapshot.server)).toBe(true);
    expect(Object.isFrozen(snapshot.server.grants)).toBe(true);
    expect(Object.isFrozen(snapshot.server.grants[0]?.selector)).toBe(true);
    expect(
      Object.isFrozen(
        snapshot.server.grants[0]?.selector.kind === "workspace"
          ? snapshot.server.grants[0].selector.workspaceIds
          : [],
      ),
    ).toBe(true);
    expect(() => {
      (snapshot.server as { revision: string }).revision = "caller-mutated";
    }).toThrow();
    expect(() => {
      (snapshot.draft as ResourceGrant[]).push(grant);
    }).toThrow();
  });

  test("normalizes workspace IDs and rejects unknown action or selector fields", () => {
    const { model } = createHarness(GENERATION_A);
    expect(
      model.setDraft([
        {
          action: "workspace.write",
          selector: { kind: "workspace", workspaceIds: ["b", "a", "b"] },
        },
      ]),
    ).toEqual({ ok: true });
    expect(model.getSnapshot().draft[0]).toEqual({
      action: "workspace.write",
      selector: { kind: "workspace", workspaceIds: ["a", "b"] },
    });
    expect(
      model.setDraft([{ action: "workspace.write", selector: { kind: "self", extra: "nope" } }]),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_draft",
    });
    expect(model.setDraft([{ action: "not-an-action", selector: { kind: "self" } }])).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_draft",
    });
  });

  test.each(["old-first", "old-last"] as const)(
    "same generation and reused list request ID cannot let %s old response win",
    async (order) => {
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      let call = 0;
      const harness = createHarness(GENERATION_A);
      harness.setListHandler(async () => {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      });
      const oldLoad = harness.model.load({ requestId: "same", sessionGeneration: GENERATION_A });
      const newLoad = harness.model.load({ requestId: "same", sessionGeneration: GENERATION_A });
      const oldResponse = listResponse("same", PRINCIPAL_ID, "old-rev", [
        { action: "workspace.write", selector: { kind: "self" } },
      ]);
      const newResponse = listResponse("same", PRINCIPAL_ID, "new-rev", [grant]);
      if (order === "old-first") {
        first.resolve(oldResponse);
        second.resolve(newResponse);
      } else {
        second.resolve(newResponse);
        first.resolve(oldResponse);
      }
      await Promise.all([oldLoad, newLoad]);
      expect(harness.model.getSnapshot().server).toMatchObject({
        status: "loaded",
        revision: "new-rev",
      });
      expect(harness.model.getSnapshot().draft).toEqual([
        {
          action: "workspace.write",
          selector: { kind: "workspace", workspaceIds: ["workspace-a", "workspace-b"] },
        },
      ]);
    },
  );

  test("load failure keeps the previous server snapshot and draft", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(
      harness.model.setDraft([{ action: "workspace.metadata.read", selector: { kind: "self" } }])
        .ok,
    ).toBe(true);
    harness.setListHandler(async () => {
      throw new Error("network broke");
    });
    expect(
      await harness.model.load({ requestId: "list-2", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.unavailable",
    });
    expect(harness.model.getSnapshot()).toMatchObject({
      server: { status: "failed", reasonCode: "enterprise.grants.unavailable" },
      draft: [{ action: "workspace.metadata.read", selector: { kind: "self" } }],
    });
  });

  test("load catch returns the same controlled reason stored in the failed snapshot", async () => {
    const known = createHarness(GENERATION_A);
    known.setListHandler(async () => {
      throw new Error("enterprise.grants.invalid_response");
    });
    expect(await known.model.load({ requestId: "known", sessionGeneration: GENERATION_A })).toEqual(
      {
        ok: false,
        reasonCode: "enterprise.grants.invalid_response",
      },
    );
    expect(known.model.getSnapshot().server).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.grants.invalid_response",
    });

    const unknown = createHarness(GENERATION_A);
    unknown.setListHandler(async () => {
      throw new Error("PAT-canary-should-not-reach-ui");
    });
    expect(
      await unknown.model.load({ requestId: "unknown", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.unavailable",
    });
    expect(unknown.model.getSnapshot().server).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.grants.unavailable",
    });
  });

  test("pending update locks edits while preserving the draft", async () => {
    const update = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(
      harness.model.setDraft([{ action: "workspace.manage", selector: { kind: "self" } }]).ok,
    ).toBe(true);
    harness.setUpdateHandler(() => update.promise);
    const pending = harness.model.submit({
      requestId: "update-1",
      sessionGeneration: GENERATION_A,
    });
    expect(harness.model.getSnapshot()).toMatchObject({
      mutation: { status: "pending" },
      canEdit: false,
      canSubmit: false,
    });
    expect(
      harness.model.setDraft([{ action: "workspace.write", selector: { kind: "self" } }]),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.mutation_in_progress",
    });
    expect(harness.model.getSnapshot().draft).toEqual([
      { action: "workspace.manage", selector: { kind: "self" } },
    ]);
    update.resolve(
      updateResponse("update-1", PRINCIPAL_ID, "rev-2", [
        { action: "workspace.manage", selector: { kind: "self" } },
      ]),
    );
    expect(await pending).toEqual({ ok: true });
  });

  test("successful update requires matching request and principal, then replaces server and draft", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(
      harness.model.setDraft([{ action: "workspace.manage", selector: { kind: "self" } }]).ok,
    ).toBe(true);
    harness.setUpdateHandler(async () =>
      updateResponse("update-1", PRINCIPAL_ID, "rev-2", [
        { action: "workspace.manage", selector: { kind: "self" } },
      ]),
    );
    expect(
      await harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A }),
    ).toEqual({ ok: true });
    expect(harness.model.getSnapshot()).toMatchObject({
      server: { status: "loaded", revision: "rev-2" },
      mutation: { status: "success", requestId: "update-1" },
      draft: [{ action: "workspace.manage", selector: { kind: "self" } }],
    });
  });

  test("malformed update response preserves server and draft and uses a controlled reason", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    const before = harness.model.getSnapshot();
    harness.setUpdateHandler(async () => ({
      type: "unexpected",
      payload: { secret: "do not store" },
    }));
    expect(
      await harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_response",
    });
    expect(harness.model.getSnapshot().server).toEqual(before.server);
    expect(harness.model.getSnapshot().draft).toEqual(before.draft);
  });

  test("W0 schema-compatible but form-invalid selector extras fail before clearing loading or pending", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () =>
      listResponse("list-1", PRINCIPAL_ID, "rev-1", [
        { action: "workspace.write", selector: { kind: "self", secret: "drop-me" } } as never,
      ]),
    );
    expect(
      await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_response",
    });
    expect(harness.model.getSnapshot().server).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.grants.invalid_response",
    });

    const updateHarness = createHarness(GENERATION_A);
    await updateHarness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    updateHarness.setUpdateHandler(async () =>
      updateResponse("update-1", PRINCIPAL_ID, "rev-2", [
        { action: "workspace.write", selector: { kind: "self", secret: "drop-me" } } as never,
      ]),
    );
    expect(
      await updateHarness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_response",
    });
    expect(updateHarness.model.getSnapshot().mutation).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.grants.invalid_response",
    });
  });

  test("revision conflict is explicit and retains draft plus old server for reload/review", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.setUpdateHandler(async () => {
      throw new Error("enterprise.grants.revision_conflict");
    });
    expect(
      await harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.revision_conflict",
    });
    expect(harness.model.getSnapshot().mutation).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.grants.revision_conflict",
      conflict: true,
    });
    expect(harness.model.getSnapshot().server).toMatchObject({
      status: "loaded",
      revision: "rev-1",
    });
  });

  test("wrong-principal response cannot replace the current server snapshot", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () => listResponse("list-1", OTHER_PRINCIPAL_ID));
    expect(
      await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.invalid_response",
    });
    expect(harness.model.getSnapshot().server).toMatchObject({ status: "failed" });
  });

  test("generation change aborts and ignores a late list response", async () => {
    const pending = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () => pending.promise);
    const loading = harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.model.setSessionGeneration(GENERATION_B);
    pending.resolve(listResponse("list-1", PRINCIPAL_ID, "old-rev"));
    expect(await loading).toEqual({ ok: false, reasonCode: "enterprise.grants.stale" });
    expect(harness.model.getSnapshot()).toMatchObject({
      server: { status: "not_requested" },
      draft: [],
    });
    expect(harness.port.listInputs[0]?.signal.aborted).toBe(true);
  });

  test("same-generation reused list ID old error cannot replace a newer success", async () => {
    const oldList = deferred<unknown>();
    const newList = deferred<unknown>();
    let call = 0;
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () => {
      call += 1;
      return call === 1 ? oldList.promise : newList.promise;
    });
    const oldLoad = harness.model.load({ requestId: "same", sessionGeneration: GENERATION_A });
    const newLoad = harness.model.load({ requestId: "same", sessionGeneration: GENERATION_A });
    oldList.reject(new Error("old failure"));
    newList.resolve(listResponse("same", PRINCIPAL_ID, "new-rev"));
    expect(await oldLoad).toEqual({ ok: false, reasonCode: "enterprise.grants.stale" });
    expect(await newLoad).toEqual({ ok: true });
    expect(harness.model.getSnapshot().server).toMatchObject({
      status: "loaded",
      revision: "new-rev",
    });
  });

  test("close aborts and ignores late mutation response", async () => {
    const pending = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.setUpdateHandler(async () => pending.promise);
    const saving = harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A });
    harness.model.close();
    pending.resolve(updateResponse());
    expect(await saving).toEqual({ ok: false, reasonCode: "enterprise.grants.stale" });
    expect(harness.model.getSnapshot().status).toBe("closed");
    expect(harness.port.updateInputs[0]?.signal.aborted).toBe(true);
  });

  test.each(["generation", "close"] as const)(
    "late update error during %s is stale and cannot replace state",
    async (action) => {
      const pending = deferred<unknown>();
      const harness = createHarness(GENERATION_A);
      await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
      harness.setUpdateHandler(async () => pending.promise);
      const saving = harness.model.submit({ requestId: "same", sessionGeneration: GENERATION_A });
      if (action === "generation") harness.model.setSessionGeneration(GENERATION_B);
      else harness.model.close();
      pending.reject(new Error("old failure"));
      expect(await saving).toEqual({ ok: false, reasonCode: "enterprise.grants.stale" });
    },
  );

  test("pending update rejects load without invoking the port", async () => {
    const update = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.setUpdateHandler(() => update.promise);
    const saving = harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A });
    const listCallCount = harness.port.listInputs.length;
    expect(
      await harness.model.load({ requestId: "list-2", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.grants.mutation_in_progress",
    });
    expect(harness.port.listInputs).toHaveLength(listCallCount);
    update.resolve(updateResponse());
    await saving;
  });

  test("port receives frozen grant copies that cannot mutate the draft or server snapshot", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(
      harness.model.setDraft([{ action: "workspace.manage", selector: { kind: "self" } }]).ok,
    ).toBe(true);
    let received!: readonly ResourceGrant[];
    harness.setUpdateHandler(async (input) => {
      received = input.grants;
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received[0])).toBe(true);
      expect(Object.isFrozen(received[0]?.selector)).toBe(true);
      let mutated = false;
      try {
        (received as ResourceGrant[]).push(grant);
      } catch {
        mutated = true;
      }
      expect(mutated).toBe(true);
      return updateResponse("update-1", PRINCIPAL_ID, "rev-2", [
        { action: "workspace.manage", selector: { kind: "self" } },
      ]);
    });
    expect(
      await harness.model.submit({ requestId: "update-1", sessionGeneration: GENERATION_A }),
    ).toEqual({ ok: true });
  });

  test("listener failures are isolated", async () => {
    const harness = createHarness(GENERATION_A);
    let received = 0;
    harness.model.subscribe(() => {
      throw new Error("listener failed");
    });
    harness.model.subscribe(() => {
      received += 1;
    });
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(received).toBeGreaterThan(0);
  });

  test("reused update request ID across generations cannot let the old response win", async () => {
    const oldUpdate = deferred<unknown>();
    const newUpdate = deferred<unknown>();
    let updateCall = 0;
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) => listResponse(input.requestId, PRINCIPAL_ID, "rev-new"));
    await harness.model.load({ requestId: "list-a", sessionGeneration: GENERATION_A });
    harness.setUpdateHandler(async () => {
      updateCall += 1;
      return updateCall === 1 ? oldUpdate.promise : newUpdate.promise;
    });
    const oldSave = harness.model.submit({ requestId: "same", sessionGeneration: GENERATION_A });
    harness.model.setSessionGeneration(GENERATION_B);
    await harness.model.load({ requestId: "list-b", sessionGeneration: GENERATION_B });
    const newSave = harness.model.submit({ requestId: "same", sessionGeneration: GENERATION_B });
    newUpdate.resolve(
      updateResponse("same", PRINCIPAL_ID, "new-rev", [
        { action: "workspace.manage", selector: { kind: "self" } },
      ]),
    );
    oldUpdate.resolve(
      updateResponse("same", PRINCIPAL_ID, "old-rev", [
        { action: "workspace.write", selector: { kind: "self" } },
      ]),
    );
    expect(await newSave).toEqual({ ok: true });
    expect(await oldSave).toEqual({ ok: false, reasonCode: "enterprise.grants.stale" });
    expect(harness.model.getSnapshot().server).toMatchObject({ revision: "new-rev" });
  });
});
