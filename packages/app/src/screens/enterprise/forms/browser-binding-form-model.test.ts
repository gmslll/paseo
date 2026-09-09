import { describe, expect, test } from "vitest";

import type {
  BrowserProfileBindingProjection,
  BrowserProfileSummary,
} from "@getpaseo/protocol/messages";
import {
  MemoryBrowserBindingPort,
  createBrowserBindingFormModel,
  type BrowserBindingPortBindInput,
  type BrowserBindingPortInput,
} from "./browser-binding-form-model";

const ORGANIZATION_ID = "org_1111111111111111";
const OTHER_ORGANIZATION_ID = "org_2222222222222222";
const NODE_ID = "nod_1111111111111111";
const OTHER_NODE_ID = "nod_2222222222222222";
const WORKSPACE_ID = "workspace-1";
const OTHER_WORKSPACE_ID = "workspace-2";
const PROFILE_ID = "brp_1111111111111111";
const SECOND_PROFILE_ID = "brp_2222222222222222";
const UNKNOWN_PROFILE_ID = "brp_3333333333333333";
const GENERATION_A: string = "generation-a";
const GENERATION_B: string = "generation-b";

const profile = (
  browserProfileId = PROFILE_ID,
  overrides: Partial<BrowserProfileSummary> = {},
): BrowserProfileSummary => ({
  browserProfileId,
  organizationId: ORGANIZATION_ID,
  homeNodeId: NODE_ID,
  ownerPrincipalId: "usr_1111111111111111",
  platform: "generic",
  label: "Primary browser",
  status: "ready",
  ...overrides,
});

const binding = (
  browserProfileId = PROFILE_ID,
  overrides: Partial<BrowserProfileBindingProjection> = {},
): BrowserProfileBindingProjection => ({
  organizationId: ORGANIZATION_ID,
  nodeId: NODE_ID,
  workspaceId: WORKSPACE_ID,
  browserProfileId,
  boundAt: "2026-09-10T00:00:00.000Z",
  ...overrides,
});

function listResponse(
  requestId = "list-1",
  profiles: readonly unknown[] = [profile()],
  bindings: readonly unknown[] = [],
) {
  return {
    type: "enterprise.browser.list_profiles.response" as const,
    payload: { requestId, profiles, bindings },
  };
}

function bindResponse(requestId = "bind-1", nextBinding: unknown = binding()) {
  return {
    type: "enterprise.browser.bind_profile.response" as const,
    payload: { requestId, binding: nextBinding },
  };
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

function createHarness<TGeneration extends string>(generation: TGeneration) {
  let listHandler: (input: BrowserBindingPortInput<TGeneration>) => Promise<unknown> = async (
    input,
  ) => listResponse(input.requestId);
  let bindHandler: (input: BrowserBindingPortBindInput<TGeneration>) => Promise<unknown> = async (
    input,
  ) => bindResponse(input.requestId, binding(input.browserProfileId));
  const port = new MemoryBrowserBindingPort<TGeneration>({
    listProfiles: (input) => listHandler(input),
    bindProfile: (input) => bindHandler(input),
  });
  const model = createBrowserBindingFormModel({
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    nodeId: NODE_ID,
    sessionGeneration: generation,
    port,
  });
  return {
    model,
    port,
    setListHandler: (handler: typeof listHandler) => {
      listHandler = handler;
    },
    setBindHandler: (handler: typeof bindHandler) => {
      bindHandler = handler;
    },
  };
}

describe("browser binding form model", () => {
  test("fresh mount has no selection and load carries workspace, request, generation, and signal", async () => {
    const harness = createHarness(GENERATION_A);
    expect(harness.model.getSnapshot()).toMatchObject({
      status: "open",
      server: { status: "not_requested", profiles: [], binding: null },
      draftBrowserProfileId: null,
      mutation: { status: "idle" },
      canEdit: true,
      canSubmit: false,
    });
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.port.listInputs[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestId: "list-1",
      sessionGeneration: GENERATION_A,
    });
    expect(harness.port.listInputs[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.model.getSnapshot().draftBrowserProfileId).toBe(null);
  });

  test("constructor validates scope and captures scope, port, and generation guard", async () => {
    expect(() =>
      createBrowserBindingFormModel({
        workspaceId: "",
        organizationId: ORGANIZATION_ID,
        nodeId: NODE_ID,
        sessionGeneration: GENERATION_A,
        port: new MemoryBrowserBindingPort({
          listProfiles: async () => listResponse(),
          bindProfile: async () => bindResponse(),
        }),
      }),
    ).toThrow("enterprise.browser.invalid_scope");

    const pending = deferred<unknown>();
    const portA = new MemoryBrowserBindingPort<string>({
      listProfiles: async () => pending.promise,
      bindProfile: async (input) => bindResponse(input.requestId),
    });
    const portB = new MemoryBrowserBindingPort<string>({
      listProfiles: async () => listResponse("wrong-port"),
      bindProfile: async (input) => bindResponse(input.requestId),
    });
    const options = {
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      nodeId: NODE_ID,
      sessionGeneration: GENERATION_A,
      port: portA,
      isCurrentSessionGeneration: (_generation: string) => true,
    };
    const model = createBrowserBindingFormModel(options);
    options.workspaceId = OTHER_WORKSPACE_ID;
    options.organizationId = OTHER_ORGANIZATION_ID;
    options.nodeId = OTHER_NODE_ID;
    options.port = portB;
    options.isCurrentSessionGeneration = () => false;
    const loading = model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(portA.listInputs).toHaveLength(1);
    expect(portB.listInputs).toHaveLength(0);
    pending.resolve(listResponse("list-1"));
    expect(await loading).toEqual({ ok: true });
    expect(model.getSnapshot().server).toMatchObject({ status: "loaded", profiles: [profile()] });
  });

  test("blank request IDs are rejected before either port is called", async () => {
    const harness = createHarness(GENERATION_A);
    expect(await harness.model.load({ requestId: "", sessionGeneration: GENERATION_A })).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_request",
    });
    expect(harness.port.listInputs).toHaveLength(0);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    expect(await harness.model.submit({ requestId: "", sessionGeneration: GENERATION_A })).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_request",
    });
    expect(harness.port.bindInputs).toHaveLength(0);
  });

  test("valid list stores only frozen summary and binding projections", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) =>
      listResponse(input.requestId, [profile()], [binding()]),
    );
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    const snapshot = harness.model.getSnapshot();
    expect(snapshot.server).toMatchObject({ status: "loaded", binding: binding() });
    expect(snapshot.draftBrowserProfileId).toBe(PROFILE_ID);
    expect(Object.isFrozen(snapshot.server)).toBe(true);
    expect(Object.isFrozen(snapshot.server.profiles)).toBe(true);
    expect(Object.isFrozen(snapshot.server.profiles[0])).toBe(true);
    expect(Object.isFrozen(snapshot.server.binding)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /partitionKey|downloadRoot|credentialRef|businessAccountKey|expectedIdentity/,
    );
    expect(() =>
      (snapshot.server.profiles as BrowserProfileSummary[]).push(profile(SECOND_PROFILE_ID)),
    ).toThrow();
    expect(() => {
      (snapshot.server as { status: "loaded" | "failed" }).status = "failed";
    }).toThrow();
  });

  test.each([
    ["profile organization", [profile(PROFILE_ID, { organizationId: OTHER_ORGANIZATION_ID })], []],
    ["profile node", [profile(PROFILE_ID, { homeNodeId: OTHER_NODE_ID })], []],
    [
      "binding organization",
      [profile()],
      [binding(PROFILE_ID, { organizationId: OTHER_ORGANIZATION_ID })],
    ],
    ["binding workspace", [profile()], [binding(PROFILE_ID, { workspaceId: OTHER_WORKSPACE_ID })]],
    ["binding unknown profile", [profile()], [binding(UNKNOWN_PROFILE_ID)]],
    ["duplicate profile", [profile(), profile()], []],
    ["duplicate binding", [profile()], [binding(), binding()]],
  ] as const)("fails closed on %s", async (_label, profiles, bindings) => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) => listResponse(input.requestId, profiles, bindings));
    expect(
      await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_response",
    });
    expect(harness.model.getSnapshot().server).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.browser.invalid_response",
    });
  });

  test("malformed and unknown response fields fail closed without retaining sensitive data", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) =>
      listResponse(input.requestId, [{ ...profile(), partitionKey: "secret" }], []),
    );
    expect(
      await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_response",
    });
    expect(JSON.stringify(harness.model.getSnapshot())).not.toContain("secret");
  });

  test("selection is limited to the current list", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(UNKNOWN_PROFILE_ID)).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_profile",
    });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    expect(harness.model.getSnapshot().draftBrowserProfileId).toBe(PROFILE_ID);
  });

  test.each(["old-success", "old-error"] as const)(
    "same generation reused list ID old %s cannot overwrite a newer response",
    async (kind) => {
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
      newList.resolve(listResponse("same", [profile(SECOND_PROFILE_ID)], []));
      if (kind === "old-success") oldList.resolve(listResponse("same", [profile()], [binding()]));
      else oldList.reject(new Error("old failure"));
      expect(await newLoad).toEqual({ ok: true });
      expect(await oldLoad).toEqual({ ok: false, reasonCode: "enterprise.browser.stale" });
      expect(harness.model.getSnapshot().server).toMatchObject({
        status: "loaded",
        profiles: [profile(SECOND_PROFILE_ID)],
        binding: null,
      });
    },
  );

  test("pending bind locks load and selection, preserves draft, and sends frozen input", async () => {
    const pending = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    harness.setBindHandler(async () => pending.promise);
    const saving = harness.model.submit({ requestId: "bind-1", sessionGeneration: GENERATION_A });
    expect(harness.model.getSnapshot()).toMatchObject({
      mutation: { status: "pending" },
      canEdit: false,
    });
    expect(
      await harness.model.load({ requestId: "list-2", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.mutation_in_progress",
    });
    expect(harness.model.selectProfile(SECOND_PROFILE_ID)).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.mutation_in_progress",
    });
    expect(harness.port.listInputs).toHaveLength(1);
    expect(harness.port.bindInputs[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      browserProfileId: PROFILE_ID,
    });
    expect(Object.isFrozen(harness.port.bindInputs[0])).toBe(true);
    pending.resolve(bindResponse("bind-1", binding(PROFILE_ID)));
    expect(await saving).toEqual({ ok: true });
  });

  test("refreshScope invalidates even when generation is unchanged and clears all projections", async () => {
    const pending = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () => pending.promise);
    const loading = harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.model.refreshScope(GENERATION_A);
    expect(harness.model.getSnapshot()).toMatchObject({
      server: { status: "not_requested", profiles: [], binding: null },
      draftBrowserProfileId: null,
      mutation: { status: "idle" },
    });
    pending.resolve(listResponse("list-1"));
    expect(await loading).toEqual({ ok: false, reasonCode: "enterprise.browser.stale" });
    expect(harness.model.getSnapshot().server).toMatchObject({
      status: "not_requested",
      profiles: [],
    });
  });

  test("successful bind checks request/workspace/profile/generation and replaces binding without optimism", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    harness.setBindHandler(async () =>
      bindResponse("bind-1", binding(PROFILE_ID, { boundAt: "new-time" })),
    );
    expect(harness.model.getSnapshot().server.binding).toBe(null);
    const saving = harness.model.submit({ requestId: "bind-1", sessionGeneration: GENERATION_A });
    expect(harness.model.getSnapshot().server.binding).toBe(null);
    expect(await saving).toEqual({ ok: true });
    expect(harness.model.getSnapshot().server.binding).toMatchObject({ boundAt: "new-time" });
  });

  test("bind failure preserves old binding and draft", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) =>
      listResponse(input.requestId, [profile(), profile(SECOND_PROFILE_ID)], [binding()]),
    );
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(SECOND_PROFILE_ID)).toEqual({ ok: true });
    harness.setBindHandler(async () => {
      throw new Error("network down");
    });
    expect(
      await harness.model.submit({ requestId: "bind-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.unavailable",
    });
    expect(harness.model.getSnapshot()).toMatchObject({
      draftBrowserProfileId: SECOND_PROFILE_ID,
      server: { status: "loaded", binding: binding() },
    });
  });

  test("malformed bind response fails without pending leak", async () => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    harness.setBindHandler(async () => ({ type: "unexpected", payload: { secret: "drop" } }));
    expect(
      await harness.model.submit({ requestId: "bind-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_response",
    });
    expect(harness.model.getSnapshot().mutation).toMatchObject({ status: "failed" });
  });

  test.each([
    ["workspace", binding(PROFILE_ID, { workspaceId: OTHER_WORKSPACE_ID })],
    ["organization", binding(PROFILE_ID, { organizationId: OTHER_ORGANIZATION_ID })],
    ["node", binding(PROFILE_ID, { nodeId: OTHER_NODE_ID })],
    ["profile", binding(SECOND_PROFILE_ID)],
  ] as const)("bind response with wrong %s fails closed", async (_label, responseBinding) => {
    const harness = createHarness(GENERATION_A);
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
    harness.setBindHandler(async () => bindResponse("bind-1", responseBinding));
    expect(
      await harness.model.submit({ requestId: "bind-1", sessionGeneration: GENERATION_A }),
    ).toEqual({
      ok: false,
      reasonCode: "enterprise.browser.invalid_response",
    });
    expect(harness.model.getSnapshot().mutation).toMatchObject({ status: "failed" });
  });

  test.each(["old-success", "old-error"] as const)(
    "same ID old bind %s cannot overwrite a new generation",
    async (kind) => {
      const oldBind = deferred<unknown>();
      const newBind = deferred<unknown>();
      let call = 0;
      const harness = createHarness(GENERATION_A);
      await harness.model.load({ requestId: "list-a", sessionGeneration: GENERATION_A });
      expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
      harness.setBindHandler(async () => {
        call += 1;
        return call === 1 ? oldBind.promise : newBind.promise;
      });
      const oldSave = harness.model.submit({ requestId: "same", sessionGeneration: GENERATION_A });
      harness.model.setSessionGeneration(GENERATION_B);
      await harness.model.load({ requestId: "list-b", sessionGeneration: GENERATION_B });
      expect(harness.model.selectProfile(PROFILE_ID)).toEqual({ ok: true });
      const newSave = harness.model.submit({ requestId: "same", sessionGeneration: GENERATION_B });
      newBind.resolve(bindResponse("same", binding(PROFILE_ID, { boundAt: "new" })));
      if (kind === "old-success")
        oldBind.resolve(bindResponse("same", binding(PROFILE_ID, { boundAt: "old" })));
      else oldBind.reject(new Error("old failure"));
      expect(await newSave).toEqual({ ok: true });
      expect(await oldSave).toEqual({ ok: false, reasonCode: "enterprise.browser.stale" });
      expect(harness.model.getSnapshot().server.binding).toMatchObject({ boundAt: "new" });
    },
  );

  test("generation change and close abort pending work and ignore late responses", async () => {
    const pending = deferred<unknown>();
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async () => pending.promise);
    const loading = harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    harness.model.setSessionGeneration(GENERATION_B);
    pending.resolve(listResponse("list-1"));
    expect(await loading).toEqual({ ok: false, reasonCode: "enterprise.browser.stale" });
    expect(harness.port.listInputs[0]?.signal.aborted).toBe(true);

    const closePending = deferred<unknown>();
    harness.setListHandler(async () => closePending.promise);
    const closing = harness.model.load({ requestId: "list-2", sessionGeneration: GENERATION_B });
    harness.model.close();
    closePending.resolve(listResponse("list-2"));
    expect(await closing).toEqual({ ok: false, reasonCode: "enterprise.browser.stale" });
    expect(harness.port.listInputs[1]?.signal.aborted).toBe(true);
  });

  test("close clears profile, binding, draft, and mutation from the readback snapshot", async () => {
    const harness = createHarness(GENERATION_A);
    harness.setListHandler(async (input) =>
      listResponse(input.requestId, [profile()], [binding()]),
    );
    await harness.model.load({ requestId: "list-1", sessionGeneration: GENERATION_A });
    expect(harness.model.getSnapshot().draftBrowserProfileId).toBe(PROFILE_ID);
    harness.model.close();
    const snapshot = harness.model.getSnapshot();
    expect(snapshot).toMatchObject({
      status: "closed",
      server: { status: "not_requested", profiles: [], binding: null },
      draftBrowserProfileId: null,
      mutation: { status: "idle" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/brp_|Primary browser|boundAt/);
  });

  test("browser binding results are frozen", async () => {
    const harness = createHarness(GENERATION_A);
    const result = await harness.model.load({
      requestId: "list-1",
      sessionGeneration: GENERATION_A,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { ok: boolean }).ok = false;
    }).toThrow();
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
});
