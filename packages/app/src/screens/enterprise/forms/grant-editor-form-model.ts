import {
  EnterpriseAccessListGrantsResponseSchema,
  EnterpriseAccessUpdateGrantsResponseSchema,
  ResourceGrantSchema,
  type ResourceGrant,
} from "@getpaseo/protocol/messages";

export type GrantEditorReasonCode =
  | "enterprise.grants.invalid_response"
  | "enterprise.grants.unavailable"
  | "enterprise.grants.stale"
  | "enterprise.grants.closed"
  | "enterprise.grants.generation_changed"
  | "enterprise.grants.not_loaded"
  | "enterprise.grants.invalid_draft"
  | "enterprise.grants.mutation_in_progress"
  | "enterprise.grants.mutation_failed"
  | "enterprise.grants.revision_conflict";

const GRANT_EDITOR_REASONS = new Set<GrantEditorReasonCode>([
  "enterprise.grants.invalid_response",
  "enterprise.grants.unavailable",
  "enterprise.grants.stale",
  "enterprise.grants.closed",
  "enterprise.grants.generation_changed",
  "enterprise.grants.not_loaded",
  "enterprise.grants.invalid_draft",
  "enterprise.grants.mutation_in_progress",
  "enterprise.grants.mutation_failed",
  "enterprise.grants.revision_conflict",
]);

function normalizeReason(reason: unknown, fallback: GrantEditorReasonCode): GrantEditorReasonCode {
  return typeof reason === "string" && GRANT_EDITOR_REASONS.has(reason as GrantEditorReasonCode)
    ? (reason as GrantEditorReasonCode)
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** Parse an editable grant without allowing unknown action/selector fields through the form. */
export function parseGrantDraft(value: unknown): ResourceGrant | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["action", "selector"])) return undefined;
  const selector = value.selector;
  if (!isRecord(selector) || typeof selector.kind !== "string") return undefined;
  let selectorKeys: readonly string[] | undefined;
  if (selector.kind === "self") selectorKeys = ["kind"];
  if (selector.kind === "organization") selectorKeys = ["kind", "organizationId"];
  if (selector.kind === "workspace") selectorKeys = ["kind", "workspaceIds"];
  if (!selectorKeys || !hasOnlyKeys(selector, selectorKeys)) return undefined;

  const parsed = ResourceGrantSchema.safeParse(value);
  if (!parsed.success) return undefined;
  if (parsed.data.selector.kind !== "workspace") return parsed.data;
  return {
    action: parsed.data.action,
    selector: {
      kind: "workspace",
      workspaceIds: [...new Set(parsed.data.selector.workspaceIds)].sort(),
    },
  };
}

function parseGrantList(value: unknown): readonly ResourceGrant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const grants: ResourceGrant[] = [];
  for (const grant of value) {
    const parsed = parseGrantDraft(grant);
    if (!parsed) return undefined;
    grants.push(parsed);
  }
  return grants;
}

function parseResponseGrantList(response: unknown): readonly ResourceGrant[] | undefined {
  if (!isRecord(response) || !isRecord(response.payload)) return undefined;
  return parseGrantList(response.payload.grants);
}

function cloneGrants(grants: readonly ResourceGrant[]): readonly ResourceGrant[] {
  return Object.freeze(
    grants.map((grant) => {
      let selector: ResourceGrant["selector"];
      switch (grant.selector.kind) {
        case "workspace":
          selector = Object.freeze({
            kind: "workspace" as const,
            workspaceIds: Object.freeze([...grant.selector.workspaceIds]) as unknown as string[],
          });
          break;
        case "organization":
          selector = Object.freeze({
            kind: "organization" as const,
            organizationId: grant.selector.organizationId,
          });
          break;
        case "self":
          selector = Object.freeze({ kind: "self" as const });
          break;
      }
      return Object.freeze({ action: grant.action, selector });
    }),
  );
}

function cloneServerSnapshot(server: GrantEditorServerSnapshot): GrantEditorServerSnapshot {
  switch (server.status) {
    case "not_requested":
      return Object.freeze({ status: "not_requested" });
    case "loading":
      return Object.freeze({
        status: "loading",
        requestId: server.requestId,
        sessionGeneration: server.sessionGeneration,
      });
    case "loaded":
      return Object.freeze({
        status: "loaded",
        requestId: server.requestId,
        sessionGeneration: server.sessionGeneration,
        revision: server.revision,
        grants: cloneGrants(server.grants),
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        requestId: server.requestId,
        sessionGeneration: server.sessionGeneration,
        reasonCode: server.reasonCode,
      });
  }
}

function cloneMutationSnapshot(mutation: GrantEditorMutationSnapshot): GrantEditorMutationSnapshot {
  switch (mutation.status) {
    case "idle":
      return Object.freeze({ status: "idle" });
    case "pending":
      return Object.freeze({
        status: "pending",
        requestId: mutation.requestId,
        sessionGeneration: mutation.sessionGeneration,
      });
    case "success":
      return Object.freeze({
        status: "success",
        requestId: mutation.requestId,
        sessionGeneration: mutation.sessionGeneration,
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        requestId: mutation.requestId,
        sessionGeneration: mutation.sessionGeneration,
        reasonCode: mutation.reasonCode,
        conflict: mutation.conflict,
      });
  }
}

export interface GrantEditorPortInput<TGeneration> {
  readonly requestId: string;
  readonly principalId: string;
  readonly sessionGeneration: TGeneration;
  readonly signal: AbortSignal;
}

export interface GrantEditorUpdatePortInput<TGeneration> extends GrantEditorPortInput<TGeneration> {
  readonly grants: readonly ResourceGrant[];
  readonly expectedRevision: string;
}

export interface GrantEditorPort<TGeneration> {
  listGrants(input: GrantEditorPortInput<TGeneration>): Promise<unknown>;
  updateGrants(input: GrantEditorUpdatePortInput<TGeneration>): Promise<unknown>;
}

export interface MemoryGrantEditorPortHandlers<TGeneration> {
  readonly listGrants: (input: GrantEditorPortInput<TGeneration>) => Promise<unknown>;
  readonly updateGrants: (input: GrantEditorUpdatePortInput<TGeneration>) => Promise<unknown>;
}

/** Typed test adapter. Production callers provide the W0 RPC-backed port. */
export class MemoryGrantEditorPort<TGeneration> implements GrantEditorPort<TGeneration> {
  readonly listInputs: GrantEditorPortInput<TGeneration>[] = [];
  readonly updateInputs: GrantEditorUpdatePortInput<TGeneration>[] = [];

  constructor(private readonly handlers: MemoryGrantEditorPortHandlers<TGeneration>) {}

  listGrants(input: GrantEditorPortInput<TGeneration>): Promise<unknown> {
    this.listInputs.push(input);
    return this.handlers.listGrants(input);
  }

  updateGrants(input: GrantEditorUpdatePortInput<TGeneration>): Promise<unknown> {
    this.updateInputs.push(input);
    return this.handlers.updateGrants(input);
  }
}

export type GrantEditorServerSnapshot =
  | { readonly status: "not_requested" }
  | { readonly status: "loading"; readonly requestId: string; readonly sessionGeneration: unknown }
  | {
      readonly status: "loaded";
      readonly requestId: string;
      readonly sessionGeneration: unknown;
      readonly revision: string;
      readonly grants: readonly ResourceGrant[];
    }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly sessionGeneration: unknown;
      readonly reasonCode: GrantEditorReasonCode;
    };

export type GrantEditorMutationSnapshot =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly requestId: string; readonly sessionGeneration: unknown }
  | { readonly status: "success"; readonly requestId: string; readonly sessionGeneration: unknown }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly sessionGeneration: unknown;
      readonly reasonCode: GrantEditorReasonCode;
      readonly conflict: boolean;
    };

export interface GrantEditorFormSnapshot {
  readonly status: "open" | "closed";
  readonly server: GrantEditorServerSnapshot;
  readonly draft: readonly ResourceGrant[];
  readonly mutation: GrantEditorMutationSnapshot;
  readonly canEdit: boolean;
  readonly canSubmit: boolean;
}

export type GrantEditorResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: GrantEditorReasonCode };

interface ListAttempt<TGeneration> {
  readonly requestId: string;
  readonly principalId: string;
  readonly sessionGeneration: TGeneration;
  readonly controller: AbortController;
}

interface UpdateAttempt<TGeneration> extends ListAttempt<TGeneration> {
  readonly expectedRevision: string;
}

export interface GrantEditorFormModel<TGeneration> {
  getSnapshot(): GrantEditorFormSnapshot;
  subscribe(listener: () => void): () => void;
  load(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<GrantEditorResult>;
  setDraft(grants: readonly unknown[]): GrantEditorResult;
  submit(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<GrantEditorResult>;
  setSessionGeneration(sessionGeneration: TGeneration): void;
  close(): void;
}

export function createGrantEditorFormModel<TGeneration>(options: {
  readonly principalId: string;
  readonly sessionGeneration: TGeneration;
  readonly port: GrantEditorPort<TGeneration>;
  readonly isCurrentSessionGeneration?: (generation: TGeneration) => boolean;
}): GrantEditorFormModel<TGeneration> {
  const listeners = new Set<() => void>();
  const isSameGeneration = (left: TGeneration, right: TGeneration) => Object.is(left, right);
  const isCurrentGeneration = (generation: TGeneration) =>
    (options.isCurrentSessionGeneration?.(generation) ?? true) &&
    isSameGeneration(generation, currentGeneration);
  let currentGeneration = options.sessionGeneration;
  let status: GrantEditorFormSnapshot["status"] = "open";
  let server: GrantEditorServerSnapshot = { status: "not_requested" };
  let draft: readonly ResourceGrant[] = Object.freeze([]);
  let mutation: GrantEditorMutationSnapshot = { status: "idle" };
  let listAttempt: ListAttempt<TGeneration> | undefined;
  let updateAttempt: UpdateAttempt<TGeneration> | undefined;
  let snapshot = makeSnapshot();

  function makeSnapshot(): GrantEditorFormSnapshot {
    return Object.freeze({
      status,
      server: cloneServerSnapshot(server),
      draft: cloneGrants(draft),
      mutation: cloneMutationSnapshot(mutation),
      canEdit: status === "open" && mutation.status !== "pending",
      canSubmit: status === "open" && mutation.status !== "pending" && server.status === "loaded",
    });
  }

  function publish() {
    snapshot = makeSnapshot();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Listener failures cannot prevent other subscribers from observing the form.
      }
    }
  }

  function isCurrentList(attempt: ListAttempt<TGeneration>): boolean {
    return (
      listAttempt === attempt &&
      status === "open" &&
      attempt.principalId === options.principalId &&
      isCurrentGeneration(attempt.sessionGeneration)
    );
  }

  function isCurrentUpdate(attempt: UpdateAttempt<TGeneration>): boolean {
    return (
      updateAttempt === attempt &&
      status === "open" &&
      attempt.principalId === options.principalId &&
      isCurrentGeneration(attempt.sessionGeneration)
    );
  }

  function cancelList() {
    listAttempt?.controller.abort();
    listAttempt = undefined;
  }

  function cancelUpdate() {
    updateAttempt?.controller.abort();
    updateAttempt = undefined;
  }

  function failList(attempt: ListAttempt<TGeneration>, reasonCode: GrantEditorReasonCode) {
    if (!isCurrentList(attempt)) return;
    listAttempt = undefined;
    server = {
      status: "failed",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      reasonCode,
    };
    publish();
  }

  function failUpdate(
    attempt: UpdateAttempt<TGeneration>,
    reasonCode: GrantEditorReasonCode,
    conflict = false,
  ) {
    if (!isCurrentUpdate(attempt)) return;
    updateAttempt = undefined;
    mutation = {
      status: "failed",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      reasonCode,
      conflict,
    };
    publish();
  }

  async function load(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<GrantEditorResult> {
    if (status === "closed") return { ok: false, reasonCode: "enterprise.grants.closed" };
    if (mutation.status === "pending")
      return { ok: false, reasonCode: "enterprise.grants.mutation_in_progress" };
    if (!isCurrentGeneration(input.sessionGeneration)) {
      return { ok: false, reasonCode: "enterprise.grants.generation_changed" };
    }
    cancelList();
    const attempt: ListAttempt<TGeneration> = {
      requestId: input.requestId,
      principalId: options.principalId,
      sessionGeneration: input.sessionGeneration,
      controller: new AbortController(),
    };
    listAttempt = attempt;
    server = {
      status: "loading",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
    };
    publish();
    let response: unknown;
    try {
      response = await options.port.listGrants({
        requestId: attempt.requestId,
        principalId: attempt.principalId,
        sessionGeneration: attempt.sessionGeneration,
        signal: attempt.controller.signal,
      });
    } catch (error) {
      if (!isCurrentList(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
      const reason = normalizeReason(
        error instanceof Error ? error.message : undefined,
        "enterprise.grants.unavailable",
      );
      failList(attempt, reason);
      return { ok: false, reasonCode: reason };
    }
    if (!isCurrentList(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
    const parsed = EnterpriseAccessListGrantsResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.payload.requestId !== attempt.requestId ||
      parsed.data.payload.principalId !== attempt.principalId
    ) {
      failList(attempt, "enterprise.grants.invalid_response");
      return { ok: false, reasonCode: "enterprise.grants.invalid_response" };
    }
    const grants = parseResponseGrantList(response);
    if (!grants) {
      failList(attempt, "enterprise.grants.invalid_response");
      return { ok: false, reasonCode: "enterprise.grants.invalid_response" };
    }
    if (!isCurrentList(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
    listAttempt = undefined;
    server = {
      status: "loaded",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      revision: parsed.data.payload.revision,
      grants: cloneGrants(grants),
    };
    draft = cloneGrants(grants);
    mutation = { status: "idle" };
    publish();
    return { ok: true };
  }

  async function submit(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<GrantEditorResult> {
    if (status === "closed") return { ok: false, reasonCode: "enterprise.grants.closed" };
    if (mutation.status === "pending")
      return { ok: false, reasonCode: "enterprise.grants.mutation_in_progress" };
    if (!isCurrentGeneration(input.sessionGeneration)) {
      return { ok: false, reasonCode: "enterprise.grants.generation_changed" };
    }
    if (server.status !== "loaded")
      return { ok: false, reasonCode: "enterprise.grants.not_loaded" };
    const parsedDraft = parseGrantList(draft);
    if (!parsedDraft) return { ok: false, reasonCode: "enterprise.grants.invalid_draft" };
    cancelUpdate();
    const attempt: UpdateAttempt<TGeneration> = {
      requestId: input.requestId,
      principalId: options.principalId,
      sessionGeneration: input.sessionGeneration,
      expectedRevision: server.revision,
      controller: new AbortController(),
    };
    updateAttempt = attempt;
    mutation = {
      status: "pending",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
    };
    publish();
    let response: unknown;
    try {
      response = await options.port.updateGrants({
        requestId: attempt.requestId,
        principalId: attempt.principalId,
        sessionGeneration: attempt.sessionGeneration,
        grants: cloneGrants(parsedDraft),
        expectedRevision: attempt.expectedRevision,
        signal: attempt.controller.signal,
      });
    } catch (error) {
      if (!isCurrentUpdate(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
      const reason = normalizeReason(
        error instanceof Error ? error.message : undefined,
        "enterprise.grants.mutation_failed",
      );
      failUpdate(attempt, reason, reason === "enterprise.grants.revision_conflict");
      return { ok: false, reasonCode: reason };
    }
    if (!isCurrentUpdate(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
    const parsed = EnterpriseAccessUpdateGrantsResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.payload.requestId !== attempt.requestId ||
      parsed.data.payload.principalId !== attempt.principalId
    ) {
      failUpdate(attempt, "enterprise.grants.invalid_response");
      return { ok: false, reasonCode: "enterprise.grants.invalid_response" };
    }
    const grants = parseResponseGrantList(response);
    if (!grants) {
      failUpdate(attempt, "enterprise.grants.invalid_response");
      return { ok: false, reasonCode: "enterprise.grants.invalid_response" };
    }
    if (!isCurrentUpdate(attempt)) return { ok: false, reasonCode: "enterprise.grants.stale" };
    updateAttempt = undefined;
    server = {
      status: "loaded",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      revision: parsed.data.payload.revision,
      grants: cloneGrants(grants),
    };
    draft = cloneGrants(grants);
    mutation = {
      status: "success",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
    };
    publish();
    return { ok: true };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (status === "closed") return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    setDraft: (grants) => {
      if (status === "closed") return { ok: false, reasonCode: "enterprise.grants.closed" };
      if (mutation.status === "pending")
        return { ok: false, reasonCode: "enterprise.grants.mutation_in_progress" };
      const parsed = parseGrantList(grants);
      if (!parsed) return { ok: false, reasonCode: "enterprise.grants.invalid_draft" };
      draft = cloneGrants(parsed);
      publish();
      return { ok: true };
    },
    submit,
    setSessionGeneration: (nextGeneration) => {
      if (status === "closed" || isSameGeneration(currentGeneration, nextGeneration)) return;
      cancelList();
      cancelUpdate();
      currentGeneration = nextGeneration;
      server = { status: "not_requested" };
      draft = Object.freeze([]);
      mutation = { status: "idle" };
      publish();
    },
    close: () => {
      if (status === "closed") return;
      cancelList();
      cancelUpdate();
      status = "closed";
      listeners.clear();
      publish();
    },
  };
}
