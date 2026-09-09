import type { GlobalResourceRef } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  createBossResourceStore,
  type BossResourceContentReadInput,
  type BossResourceContentReadResult,
  type BossResourceStorePort,
} from "./boss-resource-store";

interface TestSessionGeneration {
  readonly id: string;
}

const AGENT_RESOURCE: GlobalResourceRef = {
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  resourceKind: "agent",
  localResourceId: "agent-1",
};

const WORKSPACE_RESOURCE: GlobalResourceRef = {
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  resourceKind: "workspace",
  localResourceId: "workspace-1",
};

const ORGANIZATION_ID = "org_0123456789abcdef";

function generation(id: string): TestSessionGeneration {
  return Object.freeze({ id });
}

const GENERATION_1 = generation("generation-1");
const GENERATION_2 = generation("generation-2");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function metadataResponse(requestId: string) {
  return {
    type: "enterprise.organization.list_resources.response",
    payload: {
      requestId,
      principals: [
        {
          principalId: "usr_0123456789abcdef",
          displayName: "Avery",
          status: "active",
          credentialId: "credential-must-be-dropped",
        },
      ],
      resources: [
        {
          organizationId: "org_0123456789abcdef",
          nodeId: "nod_0123456789abcdef",
          resourceKind: "agent",
          agentId: "agent-1",
          workspaceId: "workspace-1",
          ownerPrincipalId: "usr_0123456789abcdef",
          label: "Checkout agent",
          status: "running",
          provider: "codex",
          model: null,
          startedAt: "2026-09-10T00:00:00.000Z",
          lastActivityAt: "2026-09-10T00:01:00.000Z",
          durationMs: 60_000,
          rawTranscript: "must-be-dropped",
        },
        {
          organizationId: "org_0123456789abcdef",
          nodeId: "nod_0123456789abcdef",
          resourceKind: "workspace",
          workspaceId: "workspace-1",
          ownerPrincipalId: "usr_0123456789abcdef",
          label: "Checkout",
          status: "active",
          updatedAt: "2026-09-10T00:01:00.000Z",
        },
      ],
      nextCursor: null,
      rawGrants: ["must-be-dropped"],
    },
  };
}

class MemoryBossResourcePort implements BossResourceStorePort<TestSessionGeneration> {
  listCalls = 0;
  listInputs: Array<{
    requestId: string;
    cursor?: string;
    sessionGeneration: TestSessionGeneration;
    signal: AbortSignal;
  }> = [];
  readCalls: Array<{
    kind: GlobalResourceRef["resourceKind"];
    input: BossResourceContentReadInput<TestSessionGeneration>;
  }> = [];
  list: (input: {
    requestId: string;
    cursor?: string;
    sessionGeneration: TestSessionGeneration;
    signal: AbortSignal;
  }) => Promise<unknown> = async ({ requestId }) => metadataResponse(requestId);
  read: (
    kind: GlobalResourceRef["resourceKind"],
    input: BossResourceContentReadInput<TestSessionGeneration>,
  ) => Promise<BossResourceContentReadResult> = async (_kind, input) => ({
    requestId: input.requestId,
    resource: input.resource,
    content: { title: "Opened", messages: ["one"] },
  });

  async listOrganizationResources(input: {
    requestId: string;
    cursor?: string;
    sessionGeneration: TestSessionGeneration;
    signal: AbortSignal;
  }): Promise<unknown> {
    this.listCalls += 1;
    this.listInputs.push(input);
    return this.list(input);
  }

  readWorkspaceContent(input: BossResourceContentReadInput<TestSessionGeneration>) {
    return this.readKind("workspace", input);
  }

  readAgentContent(input: BossResourceContentReadInput<TestSessionGeneration>) {
    return this.readKind("agent", input);
  }

  readBrowserProfileContent(input: BossResourceContentReadInput<TestSessionGeneration>) {
    return this.readKind("browser_profile", input);
  }

  readAppSlotContent(input: BossResourceContentReadInput<TestSessionGeneration>) {
    return this.readKind("app_slot", input);
  }

  private readKind(
    kind: GlobalResourceRef["resourceKind"],
    input: BossResourceContentReadInput<TestSessionGeneration>,
  ) {
    this.readCalls.push({ kind, input });
    return this.read(kind, input);
  }
}

function createStore(
  port = new MemoryBossResourcePort(),
  options: { readonly createRequestId?: () => string } = {},
) {
  let requestNumber = 0;
  let currentGeneration = GENERATION_1;
  let currentOrganizationId: string | undefined = ORGANIZATION_ID;
  const store = createBossResourceStore({
    port,
    organizationId: ORGANIZATION_ID,
    createRequestId: options.createRequestId ?? (() => `boss-request-${(requestNumber += 1)}`),
    isCurrentOrganizationScope: (captured) => captured === currentOrganizationId,
    isCurrentSessionGeneration: (captured) => captured.id === currentGeneration.id,
    cloneContent: (_resource, content) => {
      if (
        typeof content !== "object" ||
        content === null ||
        typeof (content as { title?: unknown }).title !== "string" ||
        !Array.isArray((content as { messages?: unknown }).messages) ||
        !(content as { messages: unknown[] }).messages.every(
          (message) => typeof message === "string",
        )
      ) {
        throw new Error("invalid content projection");
      }
      return Object.freeze({
        title: (content as { title: string }).title,
        messages: Object.freeze([...(content as { messages: string[] }).messages]),
      });
    },
  });
  return {
    port,
    store,
    setGeneration: (next: TestSessionGeneration) => {
      currentGeneration = next;
    },
    setOrganizationId: (next: string | undefined) => {
      currentOrganizationId = next;
    },
  };
}

async function loadAndSelectAgent(store: ReturnType<typeof createStore>["store"]): Promise<void> {
  await store.loadMetadata(GENERATION_1);
  expect(store.selectDetail(AGENT_RESOURCE)).toEqual({ ok: true });
}

describe("Boss resource store", () => {
  it("starts metadata, detail, and content as not_requested without reading anything", () => {
    const { port, store } = createStore();

    expect(store.getSnapshot()).toEqual({
      metadata: { status: "not_requested" },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });
    expect(port.listCalls).toBe(0);
    expect(port.readCalls).toEqual([]);
  });

  it("runtime-parses metadata, deep-freezes it, and drops unprojected fields", async () => {
    const { store } = createStore();

    await expect(store.loadMetadata(GENERATION_1)).resolves.toEqual({ ok: true });
    expect(store.getSnapshot()).toMatchObject({
      metadata: {
        status: "loaded",
        requestId: "boss-request-1",
        sessionGeneration: GENERATION_1,
        principals: [
          {
            principalId: "usr_0123456789abcdef",
            displayName: "Avery",
            status: "active",
          },
        ],
        resources: [
          { resourceKind: "agent", label: "Checkout agent" },
          { resourceKind: "workspace", label: "Checkout" },
        ],
        nextCursor: null,
      },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });
    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain("credential-must-be-dropped");
    expect(serialized).not.toContain("rawGrants");
    expect(serialized).not.toContain("rawTranscript");
    const metadata = store.getSnapshot().metadata;
    expect(Object.isFrozen(metadata)).toBe(true);
    if (metadata.status === "loaded") {
      expect(Object.isFrozen(metadata.principals)).toBe(true);
      expect(Object.isFrozen(metadata.resources)).toBe(true);
      expect(Object.isFrozen(metadata.resources[0])).toBe(true);
    }
  });

  it("does not request metadata for a stale generation or organization scope", async () => {
    for (const staleBoundary of ["generation", "organization"] as const) {
      const port = new MemoryBossResourcePort();
      const { store, setGeneration, setOrganizationId } = createStore(port);
      if (staleBoundary === "generation") setGeneration(GENERATION_2);
      else setOrganizationId("org_ffffffffffffffff");

      await expect(store.loadMetadata(GENERATION_1)).resolves.toEqual({
        ok: false,
        reasonCode: "enterprise.metadata.stale",
      });
      expect(port.listCalls).toBe(0);
      expect(store.getSnapshot().metadata).toEqual({ status: "not_requested" });
    }
  });

  it("rejects an entire metadata response containing a cross-organization row", async () => {
    const port = new MemoryBossResourcePort();
    port.list = async ({ requestId }) => {
      const response = metadataResponse(requestId);
      response.payload.resources[1]!.organizationId = "org_ffffffffffffffff";
      return response;
    };
    const { store } = createStore(port);

    await expect(store.loadMetadata(GENERATION_1)).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.metadata.invalid_response",
    });
    expect(store.getSnapshot()).toMatchObject({
      metadata: {
        status: "failed",
        sessionGeneration: GENERATION_1,
        reasonCode: "enterprise.metadata.invalid_response",
      },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });
    expect(JSON.stringify(store.getSnapshot())).not.toContain("org_ffffffffffffffff");
  });

  it("loads detail from parsed metadata without opening or prefetching content", async () => {
    const { port, store } = createStore();
    await store.loadMetadata(GENERATION_1);

    expect(store.selectDetail(AGENT_RESOURCE)).toEqual({ ok: true });

    expect(store.getSnapshot()).toMatchObject({
      detail: {
        status: "loaded",
        resource: AGENT_RESOURCE,
        sessionGeneration: GENERATION_1,
        metadata: { resourceKind: "agent", label: "Checkout agent" },
      },
      content: { status: "not_requested" },
    });
    expect(port.readCalls).toEqual([]);
  });

  it.each(["malformed", "unlisted"] as const)(
    "clears an existing detail and content before rejecting a %s reference",
    async (kind) => {
      const { port, store } = createStore();
      await loadAndSelectAgent(store);
      await store.openContent(GENERATION_1);

      const result = store.selectDetail(
        kind === "malformed"
          ? { ...AGENT_RESOURCE, resourceKind: "future" }
          : { ...AGENT_RESOURCE, localResourceId: "agent-not-listed" },
      );

      expect(result).toEqual(
        kind === "malformed"
          ? { ok: false, reasonCode: "enterprise.detail.invalid_resource" }
          : { ok: false, reasonCode: "enterprise.detail.not_found" },
      );
      expect(store.getSnapshot()).toMatchObject({
        metadata: { status: "loaded" },
        detail: { status: "not_requested" },
        content: { status: "not_requested" },
      });
      expect(port.readCalls).toHaveLength(1);
    },
  );

  it("does not open content until a parsed metadata detail is selected", async () => {
    const { port, store } = createStore();

    await expect(store.openContent(GENERATION_1)).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.not_selected",
    });
    expect(port.readCalls).toEqual([]);
    expect(store.getSnapshot().content).toEqual({ status: "not_requested" });
  });

  it("does not call a content reader for a stale or mismatched session generation", async () => {
    const port = new MemoryBossResourcePort();
    const { store, setGeneration } = createStore(port);
    await loadAndSelectAgent(store);
    setGeneration(GENERATION_2);

    await expect(store.openContent(GENERATION_1)).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.stale",
    });
    await expect(store.openContent(GENERATION_2)).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.stale",
    });
    expect(port.readCalls).toEqual([]);
    expect(store.getSnapshot().content).toEqual({ status: "not_requested" });
  });

  it("opens selected content explicitly and binds it to ref, request, and generation", async () => {
    const port = new MemoryBossResourcePort();
    const openedContent = { title: "Agent chat", messages: ["hello"] };
    const blocked = deferred<BossResourceContentReadResult>();
    port.read = () => blocked.promise;
    const { store } = createStore(port);
    await loadAndSelectAgent(store);
    const capturedGeneration = GENERATION_1;

    const opening = store.openContent(capturedGeneration);
    expect(store.getSnapshot()).toMatchObject({
      detail: {
        status: "loaded",
        resource: AGENT_RESOURCE,
        sessionGeneration: GENERATION_1,
      },
      content: {
        status: "loading",
        resource: AGENT_RESOURCE,
        requestId: "boss-request-2",
        sessionGeneration: capturedGeneration,
      },
    });
    expect(port.readCalls).toHaveLength(1);
    expect(port.readCalls[0]?.kind).toBe("agent");
    expect(port.readCalls[0]?.input.sessionGeneration).toBe(GENERATION_1);

    blocked.resolve({
      requestId: "boss-request-2",
      resource: AGENT_RESOURCE,
      content: { ...openedContent, rawContent: "must-not-be-stored" },
      auditReceipt: "must-not-be-required-or-stored",
    } as BossResourceContentReadResult & { auditReceipt: string });
    await expect(opening).resolves.toEqual({ ok: true });

    expect(store.getSnapshot().content).toEqual({
      status: "loaded",
      resource: AGENT_RESOURCE,
      requestId: "boss-request-2",
      sessionGeneration: capturedGeneration,
      value: openedContent,
    });
    expect(JSON.stringify(store.getSnapshot().content)).not.toContain("rawContent");
    expect(store.getSnapshot().content).not.toHaveProperty("auditReceipt");
  });

  it.each(["request", "resource"] as const)(
    "fails closed when a content result has the wrong %s",
    async (mismatch) => {
      const port = new MemoryBossResourcePort();
      port.read = async (_kind, readInput) => ({
        requestId: mismatch === "request" ? "wrong-request" : readInput.requestId,
        resource: mismatch === "resource" ? WORKSPACE_RESOURCE : readInput.resource,
        content: { title: "Wrong", messages: [] },
      });
      const { store } = createStore(port);
      await loadAndSelectAgent(store);

      await expect(store.openContent(GENERATION_1)).resolves.toEqual({
        ok: false,
        reasonCode: "enterprise.content.invalid_response",
      });
      expect(store.getSnapshot().content).toMatchObject({
        status: "failed",
        reasonCode: "enterprise.content.invalid_response",
      });
    },
  );

  it("fails closed when resource-specific content cannot be cloned", async () => {
    const port = new MemoryBossResourcePort();
    port.read = async (_kind, readInput) => ({
      requestId: readInput.requestId,
      resource: readInput.resource,
      content: { title: "Malformed", messages: undefined },
    });
    const { store } = createStore(port);
    await loadAndSelectAgent(store);

    await expect(store.openContent(GENERATION_1)).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.invalid_response",
    });
    expect(store.getSnapshot().content).toMatchObject({
      status: "failed",
      reasonCode: "enterprise.content.invalid_response",
    });
  });

  it("drops a content result after the authoritative session generation changes", async () => {
    const port = new MemoryBossResourcePort();
    const blocked = deferred<BossResourceContentReadResult>();
    port.read = () => blocked.promise;
    const { store, setGeneration } = createStore(port);
    await loadAndSelectAgent(store);
    const opening = store.openContent(GENERATION_1);

    setGeneration(GENERATION_2);
    blocked.resolve({
      requestId: "boss-request-2",
      resource: AGENT_RESOURCE,
      content: { title: "Stale", messages: [] },
    });

    await expect(opening).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.stale",
    });
    expect(store.getSnapshot().content).toEqual({ status: "not_requested" });
  });

  it("does not let an older explicit open overwrite a newer selected detail", async () => {
    const port = new MemoryBossResourcePort();
    const first = deferred<BossResourceContentReadResult>();
    const second = deferred<BossResourceContentReadResult>();
    port.read = (kind) => (kind === "agent" ? first.promise : second.promise);
    const { store } = createStore(port);
    await loadAndSelectAgent(store);

    const firstOpen = store.openContent(GENERATION_1);
    expect(store.selectDetail(WORKSPACE_RESOURCE)).toEqual({ ok: true });
    const secondOpen = store.openContent(GENERATION_1);
    first.resolve({
      requestId: "boss-request-2",
      resource: AGENT_RESOURCE,
      content: { title: "Old", messages: [] },
    });
    second.resolve({
      requestId: "boss-request-3",
      resource: WORKSPACE_RESOURCE,
      content: { title: "New", messages: [] },
    });

    await expect(firstOpen).resolves.toMatchObject({ ok: false });
    await expect(secondOpen).resolves.toEqual({ ok: true });
    expect(store.getSnapshot()).toMatchObject({
      detail: {
        status: "loaded",
        resource: WORKSPACE_RESOURCE,
        sessionGeneration: GENERATION_1,
      },
      content: {
        status: "loaded",
        resource: WORKSPACE_RESOURCE,
        requestId: "boss-request-3",
        value: { title: "New" },
      },
    });
  });

  it("aborts and clears content as soon as a replacing metadata page starts", async () => {
    const port = new MemoryBossResourcePort();
    const contentResult = deferred<BossResourceContentReadResult>();
    const metadataResult = deferred<unknown>();
    let contentSignal: AbortSignal | undefined;
    port.read = (_kind, readInput) => {
      contentSignal = readInput.signal;
      return contentResult.promise;
    };
    const { store } = createStore(port);
    await loadAndSelectAgent(store);
    const opening = store.openContent(GENERATION_1);
    port.list = () => metadataResult.promise;

    const reloading = store.loadMetadata(GENERATION_1);
    expect(contentSignal?.aborted).toBe(true);
    expect(store.getSnapshot()).toEqual({
      metadata: {
        status: "loading",
        requestId: "boss-request-3",
        sessionGeneration: GENERATION_1,
      },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });

    metadataResult.resolve({
      type: "enterprise.organization.list_resources.response",
      payload: {
        requestId: "boss-request-3",
        principals: [],
        resources: [],
        nextCursor: null,
      },
    });
    await expect(reloading).resolves.toEqual({ ok: true });

    expect(store.getSnapshot()).toEqual({
      metadata: {
        status: "loaded",
        requestId: "boss-request-3",
        sessionGeneration: GENERATION_1,
        principals: [],
        resources: [],
        nextCursor: null,
      },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });

    contentResult.resolve({
      requestId: "boss-request-2",
      resource: AGENT_RESOURCE,
      content: { title: "Late", messages: [] },
    });
    await expect(opening).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.stale",
    });
  });

  it("rejects an aborted old-generation metadata response when request ids are reused", async () => {
    const port = new MemoryBossResourcePort();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let callNumber = 0;
    port.list = () => ((callNumber += 1) === 1 ? first.promise : second.promise);
    const { store, setGeneration } = createStore(port, {
      createRequestId: () => "reused-request-id",
    });

    const oldLoad = store.loadMetadata(GENERATION_1);
    const oldSignal = port.listInputs[0]!.signal;
    expect(oldSignal.aborted).toBe(false);
    store.clearSensitiveState();
    expect(oldSignal.aborted).toBe(true);
    setGeneration(GENERATION_2);
    const currentLoad = store.loadMetadata(GENERATION_2);

    first.resolve(metadataResponse("reused-request-id"));
    await expect(oldLoad).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.metadata.stale",
    });
    expect(store.getSnapshot().metadata).toEqual({
      status: "loading",
      requestId: "reused-request-id",
      sessionGeneration: GENERATION_2,
    });

    second.resolve(metadataResponse("reused-request-id"));
    await expect(currentLoad).resolves.toEqual({ ok: true });
    expect(store.getSnapshot().metadata).toMatchObject({
      status: "loaded",
      requestId: "reused-request-id",
      sessionGeneration: GENERATION_2,
    });
  });

  it.each(["old first", "old last"] as const)(
    "keeps the new same-generation metadata attempt when reused ids return %s",
    async (order) => {
      const port = new MemoryBossResourcePort();
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      let callNumber = 0;
      port.list = () => ((callNumber += 1) === 1 ? first.promise : second.promise);
      const { store } = createStore(port, { createRequestId: () => "reused-request-id" });

      const oldLoad = store.loadMetadata(GENERATION_1);
      const currentLoad = store.loadMetadata(GENERATION_1);
      const currentSignal = port.listInputs[1]!.signal;

      if (order === "old first") {
        first.resolve(metadataResponse("reused-request-id"));
        await expect(oldLoad).resolves.toEqual({
          ok: false,
          reasonCode: "enterprise.metadata.stale",
        });
        expect(store.getSnapshot().metadata).toEqual({
          status: "loading",
          requestId: "reused-request-id",
          sessionGeneration: GENERATION_1,
        });
        expect(currentSignal.aborted).toBe(false);
      }

      const currentResponse = metadataResponse("reused-request-id");
      currentResponse.payload.resources[0]!.label = "Current metadata";
      second.resolve(currentResponse);
      await expect(currentLoad).resolves.toEqual({ ok: true });

      if (order === "old last") {
        first.resolve(metadataResponse("reused-request-id"));
        await expect(oldLoad).resolves.toEqual({
          ok: false,
          reasonCode: "enterprise.metadata.stale",
        });
      }

      expect(currentSignal.aborted).toBe(false);
      const metadata = store.getSnapshot().metadata;
      expect(metadata.status).toBe("loaded");
      if (metadata.status === "loaded") {
        expect(metadata.resources[0]?.label).toBe("Current metadata");
      }
    },
  );

  it("does not let an aborted old-generation content result clear a reused request id", async () => {
    const port = new MemoryBossResourcePort();
    const first = deferred<BossResourceContentReadResult>();
    const second = deferred<BossResourceContentReadResult>();
    let callNumber = 0;
    port.read = () => ((callNumber += 1) === 1 ? first.promise : second.promise);
    const { store, setGeneration } = createStore(port, {
      createRequestId: () => "reused-request-id",
    });
    await store.loadMetadata(GENERATION_1);
    expect(store.selectDetail(AGENT_RESOURCE)).toEqual({ ok: true });
    const oldOpen = store.openContent(GENERATION_1);

    store.clearSensitiveState();
    setGeneration(GENERATION_2);
    await store.loadMetadata(GENERATION_2);
    expect(store.selectDetail(AGENT_RESOURCE)).toEqual({ ok: true });
    const currentOpen = store.openContent(GENERATION_2);

    first.resolve({
      requestId: "reused-request-id",
      resource: AGENT_RESOURCE,
      content: { title: "Old", messages: [] },
    });
    await expect(oldOpen).resolves.toEqual({
      ok: false,
      reasonCode: "enterprise.content.stale",
    });
    expect(store.getSnapshot().content).toMatchObject({
      status: "loading",
      requestId: "reused-request-id",
      sessionGeneration: GENERATION_2,
    });

    second.resolve({
      requestId: "reused-request-id",
      resource: AGENT_RESOURCE,
      content: { title: "Current", messages: [] },
    });
    await expect(currentOpen).resolves.toEqual({ ok: true });
    expect(store.getSnapshot().content).toMatchObject({
      status: "loaded",
      requestId: "reused-request-id",
      sessionGeneration: GENERATION_2,
      value: { title: "Current" },
    });
  });

  it.each([
    ["success", "old first"],
    ["success", "old last"],
    ["error", "old first"],
    ["error", "old last"],
  ] as const)(
    "keeps the new same-resource content attempt when old %s returns %s with a reused id",
    async (outcome, order) => {
      const port = new MemoryBossResourcePort();
      const first = deferred<BossResourceContentReadResult>();
      const second = deferred<BossResourceContentReadResult>();
      let callNumber = 0;
      port.read = () => ((callNumber += 1) === 1 ? first.promise : second.promise);
      const { store } = createStore(port, { createRequestId: () => "reused-request-id" });
      await loadAndSelectAgent(store);

      const oldOpen = store.openContent(GENERATION_1);
      const currentOpen = store.openContent(GENERATION_1);
      const currentSignal = port.readCalls[1]!.input.signal;
      const settleOld = () => {
        if (outcome === "success") {
          first.resolve({
            requestId: "reused-request-id",
            resource: AGENT_RESOURCE,
            content: { title: "Old", messages: [] },
          });
        } else first.reject(new Error("old request failed"));
      };

      if (order === "old first") {
        settleOld();
        await expect(oldOpen).resolves.toMatchObject({ ok: false });
        expect(store.getSnapshot().content).toMatchObject({
          status: "loading",
          requestId: "reused-request-id",
          sessionGeneration: GENERATION_1,
        });
        expect(currentSignal.aborted).toBe(false);
      }

      second.resolve({
        requestId: "reused-request-id",
        resource: AGENT_RESOURCE,
        content: { title: "Current", messages: [] },
      });
      await expect(currentOpen).resolves.toEqual({ ok: true });

      if (order === "old last") {
        settleOld();
        await expect(oldOpen).resolves.toMatchObject({ ok: false });
      }

      expect(currentSignal.aborted).toBe(false);
      expect(store.getSnapshot().content).toMatchObject({
        status: "loaded",
        requestId: "reused-request-id",
        value: { title: "Current" },
      });
    },
  );

  it("does not let an old different-resource error clear a reused content id", async () => {
    const port = new MemoryBossResourcePort();
    const first = deferred<BossResourceContentReadResult>();
    const second = deferred<BossResourceContentReadResult>();
    port.read = (kind) => (kind === "agent" ? first.promise : second.promise);
    const { store } = createStore(port, { createRequestId: () => "reused-request-id" });
    await loadAndSelectAgent(store);

    const oldOpen = store.openContent(GENERATION_1);
    expect(store.selectDetail(WORKSPACE_RESOURCE)).toEqual({ ok: true });
    const currentOpen = store.openContent(GENERATION_1);
    first.reject(new Error("old agent read failed"));

    await expect(oldOpen).resolves.toMatchObject({ ok: false });
    expect(store.getSnapshot().content).toMatchObject({
      status: "loading",
      resource: WORKSPACE_RESOURCE,
      requestId: "reused-request-id",
    });

    second.resolve({
      requestId: "reused-request-id",
      resource: WORKSPACE_RESOURCE,
      content: { title: "Workspace", messages: [] },
    });
    await expect(currentOpen).resolves.toEqual({ ok: true });
    expect(store.getSnapshot().content).toMatchObject({
      status: "loaded",
      resource: WORKSPACE_RESOURCE,
      value: { title: "Workspace" },
    });
  });

  it("uses replace pagination semantics within the same generation", async () => {
    const port = new MemoryBossResourcePort();
    let receivedCursor: string | undefined;
    let receivedGeneration: TestSessionGeneration | undefined;
    const { store } = createStore(port);
    await store.loadMetadata(GENERATION_1);
    port.list = async ({ requestId, cursor, sessionGeneration }) => {
      receivedCursor = cursor;
      receivedGeneration = sessionGeneration;
      const response = metadataResponse(requestId);
      response.payload.resources = [response.payload.resources[1]!];
      return response;
    };

    await expect(store.loadMetadata(GENERATION_1, "page-2")).resolves.toEqual({ ok: true });

    expect(receivedCursor).toBe("page-2");
    expect(receivedGeneration).toBe(GENERATION_1);
    expect(store.getSnapshot().metadata).toMatchObject({
      status: "loaded",
      requestId: "boss-request-2",
      sessionGeneration: GENERATION_1,
      resources: [{ resourceKind: "workspace", workspaceId: "workspace-1" }],
    });
  });

  it("closes only content and ignores the aborted result", async () => {
    const port = new MemoryBossResourcePort();
    const blocked = deferred<BossResourceContentReadResult>();
    let signal: AbortSignal | undefined;
    port.read = (_kind, readInput) => {
      signal = readInput.signal;
      return blocked.promise;
    };
    const { store } = createStore(port);
    await loadAndSelectAgent(store);
    const opening = store.openContent(GENERATION_1);

    store.closeContent();
    expect(signal?.aborted).toBe(true);
    expect(store.getSnapshot()).toMatchObject({
      metadata: { status: "loaded" },
      detail: { status: "loaded" },
      content: { status: "not_requested" },
    });
    blocked.resolve({
      requestId: "boss-request-2",
      resource: AGENT_RESOURCE,
      content: { title: "Late", messages: [] },
    });
    await expect(opening).resolves.toMatchObject({ ok: false });
  });

  it.each(["scope change", "revocation", "session generation change", "logout"])(
    "clears all three in-memory layers on %s",
    async () => {
      const { store } = createStore();
      await loadAndSelectAgent(store);
      await store.openContent(GENERATION_1);

      store.clearSensitiveState();

      expect(store.getSnapshot()).toEqual({
        metadata: { status: "not_requested" },
        detail: { status: "not_requested" },
        content: { status: "not_requested" },
      });
    },
  );

  it.each(["clear", "dispose"] as const)(
    "invalidates a pending metadata attempt on %s even when the port ignores abort",
    async (action) => {
      const port = new MemoryBossResourcePort();
      const result = deferred<unknown>();
      port.list = () => result.promise;
      const { store } = createStore(port);
      const loading = store.loadMetadata(GENERATION_1);
      const signal = port.listInputs[0]!.signal;

      if (action === "clear") store.clearSensitiveState();
      else store.dispose();
      expect(signal.aborted).toBe(true);
      result.resolve(metadataResponse("boss-request-1"));

      await expect(loading).resolves.toEqual({
        ok: false,
        reasonCode: "enterprise.metadata.stale",
      });
      expect(store.getSnapshot()).toEqual({
        metadata: { status: "not_requested" },
        detail: { status: "not_requested" },
        content: { status: "not_requested" },
      });
    },
  );

  it.each(["clear", "dispose"] as const)(
    "invalidates a pending content attempt on %s even when the port ignores abort",
    async (action) => {
      const port = new MemoryBossResourcePort();
      const result = deferred<BossResourceContentReadResult>();
      port.read = () => result.promise;
      const { store } = createStore(port);
      await loadAndSelectAgent(store);
      const opening = store.openContent(GENERATION_1);
      const signal = port.readCalls[0]!.input.signal;

      if (action === "clear") store.clearSensitiveState();
      else store.dispose();
      expect(signal.aborted).toBe(true);
      result.resolve({
        requestId: "boss-request-2",
        resource: AGENT_RESOURCE,
        content: { title: "Late", messages: [] },
      });

      await expect(opening).resolves.toEqual({
        ok: false,
        reasonCode: "enterprise.content.stale",
      });
      expect(store.getSnapshot()).toEqual({
        metadata: { status: "not_requested" },
        detail: { status: "not_requested" },
        content: { status: "not_requested" },
      });
    },
  );

  it.each(["malformed", "throw"] as const)(
    "normalizes %s metadata failures without storing port details",
    async (failure) => {
      const port = new MemoryBossResourcePort();
      port.list =
        failure === "malformed"
          ? async () => ({
              type: "enterprise.organization.list_resources.response",
              payload: { requestId: "wrong", principals: [], resources: [], nextCursor: null },
            })
          : async () => {
              throw { reasonCode: "raw pat-error-canary", detail: "pat-error-canary" };
            };
      const { store } = createStore(port);
      const reasonCode =
        failure === "malformed"
          ? "enterprise.metadata.invalid_response"
          : "enterprise.metadata.unavailable";

      await expect(store.loadMetadata(GENERATION_1)).resolves.toEqual({
        ok: false,
        reasonCode,
      });
      expect(store.getSnapshot().metadata).toMatchObject({
        status: "failed",
        sessionGeneration: GENERATION_1,
        reasonCode,
      });
      expect(JSON.stringify(store.getSnapshot())).not.toContain("pat-error-canary");
    },
  );

  it("clears memory and isolates listeners when disposed", async () => {
    const { store } = createStore();
    const healthyCalls: string[] = [];
    store.subscribe(() => {
      throw new Error("observer failure");
    });
    store.subscribe(() => healthyCalls.push("published"));

    await loadAndSelectAgent(store);
    await store.openContent(GENERATION_1);
    expect(healthyCalls.length).toBeGreaterThan(0);

    store.dispose();

    expect(store.getSnapshot()).toEqual({
      metadata: { status: "not_requested" },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    });
  });
});
