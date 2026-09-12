import {
  BrowserProfileBindingProjectionSchema,
  BrowserProfileSummarySchema,
  EnterpriseBrowserBindProfileResponseSchema,
  EnterpriseBrowserListProfilesResponseSchema,
  NodeIdSchema,
  OrganizationIdSchema,
  type BrowserProfileBindingProjection,
  type BrowserProfileSummary,
} from "@getpaseo/protocol/messages";

export type BrowserBindingReasonCode =
  | "enterprise.browser.invalid_scope"
  | "enterprise.browser.invalid_request"
  | "enterprise.browser.invalid_response"
  | "enterprise.browser.unavailable"
  | "enterprise.browser.stale"
  | "enterprise.browser.closed"
  | "enterprise.browser.generation_changed"
  | "enterprise.browser.not_loaded"
  | "enterprise.browser.invalid_profile"
  | "enterprise.browser.mutation_in_progress"
  | "enterprise.browser.mutation_failed";

const BROWSER_REASON_CODES = new Set<BrowserBindingReasonCode>([
  "enterprise.browser.invalid_scope",
  "enterprise.browser.invalid_request",
  "enterprise.browser.invalid_response",
  "enterprise.browser.unavailable",
  "enterprise.browser.stale",
  "enterprise.browser.closed",
  "enterprise.browser.generation_changed",
  "enterprise.browser.not_loaded",
  "enterprise.browser.invalid_profile",
  "enterprise.browser.mutation_in_progress",
  "enterprise.browser.mutation_failed",
]);

function normalizeReason(reason: unknown): BrowserBindingReasonCode {
  return typeof reason === "string" && BROWSER_REASON_CODES.has(reason as BrowserBindingReasonCode)
    ? (reason as BrowserBindingReasonCode)
    : "enterprise.browser.unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

const PROFILE_KEYS = [
  "browserProfileId",
  "organizationId",
  "homeNodeId",
  "ownerPrincipalId",
  "platform",
  "label",
  "status",
] as const;
const BINDING_KEYS = [
  "organizationId",
  "nodeId",
  "workspaceId",
  "browserProfileId",
  "boundAt",
] as const;

function parseProfile(value: unknown): BrowserProfileSummary | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, PROFILE_KEYS)) return undefined;
  const parsed = BrowserProfileSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseBinding(value: unknown): BrowserProfileBindingProjection | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, BINDING_KEYS)) return undefined;
  const parsed = BrowserProfileBindingProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function cloneProfile(profile: BrowserProfileSummary): BrowserProfileSummary {
  return Object.freeze({
    browserProfileId: profile.browserProfileId,
    organizationId: profile.organizationId,
    homeNodeId: profile.homeNodeId,
    ownerPrincipalId: profile.ownerPrincipalId,
    platform: profile.platform,
    label: profile.label,
    status: profile.status,
  });
}

function cloneBinding(binding: BrowserProfileBindingProjection): BrowserProfileBindingProjection {
  return Object.freeze({
    organizationId: binding.organizationId,
    nodeId: binding.nodeId,
    workspaceId: binding.workspaceId,
    browserProfileId: binding.browserProfileId,
    boundAt: binding.boundAt,
  });
}

function cloneProfiles(
  profiles: readonly BrowserProfileSummary[],
): readonly BrowserProfileSummary[] {
  return Object.freeze(profiles.map(cloneProfile));
}

export interface BrowserBindingPortInput<TGeneration extends string> {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly sessionGeneration: TGeneration;
  readonly signal: AbortSignal;
}

export interface BrowserBindingPortBindInput<
  TGeneration extends string,
> extends BrowserBindingPortInput<TGeneration> {
  readonly browserProfileId: string;
}

export interface BrowserBindingFormPort<TGeneration extends string> {
  listProfiles(input: BrowserBindingPortInput<TGeneration>): Promise<unknown>;
  bindProfile(input: BrowserBindingPortBindInput<TGeneration>): Promise<unknown>;
}

export interface MemoryBrowserBindingPortHandlers<TGeneration extends string> {
  readonly listProfiles: (input: BrowserBindingPortInput<TGeneration>) => Promise<unknown>;
  readonly bindProfile: (input: BrowserBindingPortBindInput<TGeneration>) => Promise<unknown>;
}

export class MemoryBrowserBindingPort<
  TGeneration extends string,
> implements BrowserBindingFormPort<TGeneration> {
  readonly listInputs: BrowserBindingPortInput<TGeneration>[] = [];
  readonly bindInputs: BrowserBindingPortBindInput<TGeneration>[] = [];

  constructor(private readonly handlers: MemoryBrowserBindingPortHandlers<TGeneration>) {}

  listProfiles(input: BrowserBindingPortInput<TGeneration>): Promise<unknown> {
    this.listInputs.push(input);
    return this.handlers.listProfiles(input);
  }

  bindProfile(input: BrowserBindingPortBindInput<TGeneration>): Promise<unknown> {
    this.bindInputs.push(input);
    return this.handlers.bindProfile(input);
  }
}

export type BrowserBindingServerSnapshot<TGeneration extends string> =
  | {
      readonly status: "not_requested";
      readonly profiles: readonly BrowserProfileSummary[];
      readonly binding: BrowserProfileBindingProjection | null;
    }
  | {
      readonly status: "loading" | "loaded" | "failed";
      readonly requestId: string;
      readonly sessionGeneration: TGeneration;
      readonly profiles: readonly BrowserProfileSummary[];
      readonly binding: BrowserProfileBindingProjection | null;
      readonly reasonCode?: BrowserBindingReasonCode;
    };

export type BrowserBindingMutationSnapshot<TGeneration extends string> =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      readonly requestId: string;
      readonly sessionGeneration: TGeneration;
    }
  | {
      readonly status: "success";
      readonly requestId: string;
      readonly sessionGeneration: TGeneration;
    }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly sessionGeneration: TGeneration;
      readonly reasonCode: BrowserBindingReasonCode;
    };

export interface BrowserBindingFormSnapshot<TGeneration extends string> {
  readonly status: "open" | "closed";
  readonly server: BrowserBindingServerSnapshot<TGeneration>;
  readonly draftBrowserProfileId: string | null;
  readonly mutation: BrowserBindingMutationSnapshot<TGeneration>;
  readonly canEdit: boolean;
  readonly canSubmit: boolean;
}

export type BrowserBindingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: BrowserBindingReasonCode };

function freezeResult(result: BrowserBindingResult): BrowserBindingResult {
  return Object.freeze(result);
}

interface ListAttempt<TGeneration extends string> {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly sessionGeneration: TGeneration;
  readonly controller: AbortController;
}

interface BindAttempt<TGeneration extends string> extends ListAttempt<TGeneration> {
  readonly browserProfileId: string;
}

export interface BrowserBindingFormModel<TGeneration extends string> {
  getSnapshot(): BrowserBindingFormSnapshot<TGeneration>;
  subscribe(listener: () => void): () => void;
  load(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<BrowserBindingResult>;
  selectProfile(browserProfileId: string): BrowserBindingResult;
  submit(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<BrowserBindingResult>;
  setSessionGeneration(sessionGeneration: TGeneration): void;
  refreshScope(sessionGeneration: TGeneration): void;
  close(): void;
}

export function createBrowserBindingFormModel<TGeneration extends string>(options: {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly sessionGeneration: TGeneration;
  readonly port: BrowserBindingFormPort<TGeneration>;
  readonly isCurrentSessionGeneration?: (generation: TGeneration) => boolean;
}): BrowserBindingFormModel<TGeneration> {
  if (!OrganizationIdSchema.safeParse(options.organizationId).success) {
    throw new Error("enterprise.browser.invalid_scope");
  }
  if (!NodeIdSchema.safeParse(options.nodeId).success) {
    throw new Error("enterprise.browser.invalid_scope");
  }
  if (typeof options.workspaceId !== "string" || options.workspaceId.length === 0) {
    throw new Error("enterprise.browser.invalid_scope");
  }
  const workspaceId = options.workspaceId;
  const organizationId = options.organizationId;
  const nodeId = options.nodeId;
  const port = options.port;
  const generationGuard = options.isCurrentSessionGeneration;
  const initialGeneration = options.sessionGeneration;
  const listeners = new Set<() => void>();
  const sameGeneration = (left: TGeneration, right: TGeneration) => Object.is(left, right);
  let currentGeneration = initialGeneration;
  let status: BrowserBindingFormSnapshot<TGeneration>["status"] = "open";
  let server: BrowserBindingServerSnapshot<TGeneration> = {
    status: "not_requested",
    profiles: Object.freeze([]),
    binding: null,
  };
  let draftBrowserProfileId: string | null = null;
  let mutation: BrowserBindingMutationSnapshot<TGeneration> = { status: "idle" };
  let listAttempt: ListAttempt<TGeneration> | undefined;
  let bindAttempt: BindAttempt<TGeneration> | undefined;
  let snapshot = makeSnapshot();

  const isCurrentGeneration = (generation: TGeneration) =>
    sameGeneration(generation, currentGeneration) && (generationGuard?.(generation) ?? true);

  function cloneServer(
    value: BrowserBindingServerSnapshot<TGeneration>,
  ): BrowserBindingServerSnapshot<TGeneration> {
    return Object.freeze({
      ...value,
      profiles: cloneProfiles(value.profiles),
      binding: value.binding ? cloneBinding(value.binding) : null,
    });
  }

  function cloneMutation(
    value: BrowserBindingMutationSnapshot<TGeneration>,
  ): BrowserBindingMutationSnapshot<TGeneration> {
    return Object.freeze({ ...value });
  }

  function makeSnapshot(): BrowserBindingFormSnapshot<TGeneration> {
    return Object.freeze({
      status,
      server: cloneServer(server),
      draftBrowserProfileId,
      mutation: cloneMutation(mutation),
      canEdit: status === "open" && mutation.status !== "pending",
      canSubmit:
        status === "open" &&
        mutation.status !== "pending" &&
        server.status === "loaded" &&
        draftBrowserProfileId !== null,
    });
  }

  function publish() {
    snapshot = makeSnapshot();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Listener failures cannot prevent the remaining subscribers from observing state.
      }
    }
  }

  function isCurrentList(attempt: ListAttempt<TGeneration>) {
    return (
      listAttempt === attempt &&
      status === "open" &&
      attempt.workspaceId === workspaceId &&
      isCurrentGeneration(attempt.sessionGeneration)
    );
  }

  function isCurrentBind(attempt: BindAttempt<TGeneration>) {
    return (
      bindAttempt === attempt &&
      status === "open" &&
      attempt.workspaceId === workspaceId &&
      isCurrentGeneration(attempt.sessionGeneration)
    );
  }

  function cancelList() {
    listAttempt?.controller.abort();
    listAttempt = undefined;
  }

  function cancelBind() {
    bindAttempt?.controller.abort();
    bindAttempt = undefined;
  }

  function failList(attempt: ListAttempt<TGeneration>, reasonCode: BrowserBindingReasonCode) {
    if (!isCurrentList(attempt)) return;
    listAttempt = undefined;
    server = {
      status: "failed",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      profiles: server.profiles,
      binding: server.binding,
      reasonCode,
    };
    publish();
  }

  function failBind(attempt: BindAttempt<TGeneration>, reasonCode: BrowserBindingReasonCode) {
    if (!isCurrentBind(attempt)) return;
    bindAttempt = undefined;
    mutation = {
      status: "failed",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      reasonCode,
    };
    publish();
  }

  function parseProfiles(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    const profiles: BrowserProfileSummary[] = [];
    const profileIds = new Set<string>();
    for (const rawProfile of value) {
      const profile = parseProfile(rawProfile);
      if (
        !profile ||
        profile.organizationId !== organizationId ||
        profile.homeNodeId !== nodeId ||
        profileIds.has(profile.browserProfileId)
      ) {
        return undefined;
      }
      profileIds.add(profile.browserProfileId);
      profiles.push(profile);
    }
    return { profiles, profileIds };
  }

  function parseBindings(value: unknown, profileIds: ReadonlySet<string>) {
    if (!Array.isArray(value)) return undefined;
    const bindings: BrowserProfileBindingProjection[] = [];
    const bindingKeys = new Set<string>();
    for (const rawBinding of value) {
      const binding = parseBinding(rawBinding);
      const key = isRecord(rawBinding)
        ? JSON.stringify([rawBinding.workspaceId, rawBinding.browserProfileId])
        : "invalid";
      if (
        !binding ||
        binding.organizationId !== organizationId ||
        binding.nodeId !== nodeId ||
        binding.workspaceId !== workspaceId ||
        !profileIds.has(binding.browserProfileId) ||
        bindingKeys.has(key)
      ) {
        return undefined;
      }
      bindingKeys.add(key);
      bindings.push(binding);
    }
    return bindings.length > 1 ? undefined : bindings;
  }

  function parseListResponse(response: unknown, requestId: string) {
    if (!isRecord(response) || !hasOnlyKeys(response, ["requestId", "profiles", "bindings"])) {
      return undefined;
    }
    const parsed = EnterpriseBrowserListProfilesResponseSchema.shape.payload.safeParse(response);
    if (!parsed.success || parsed.data.requestId !== requestId) return undefined;
    const parsedProfiles = parseProfiles(response.profiles);
    if (!parsedProfiles) return undefined;
    const bindings = parseBindings(response.bindings, parsedProfiles.profileIds);
    if (!bindings) return undefined;
    return {
      profiles: cloneProfiles(parsedProfiles.profiles),
      binding: bindings[0] ? cloneBinding(bindings[0]) : null,
    };
  }

  function parseBindResponse(response: unknown, requestId: string, profileId: string) {
    if (!isRecord(response) || !hasOnlyKeys(response, ["requestId", "binding"])) {
      return undefined;
    }
    const parsed = EnterpriseBrowserBindProfileResponseSchema.shape.payload.safeParse(response);
    if (!parsed.success || parsed.data.requestId !== requestId) return undefined;
    const binding = parseBinding(response.binding);
    if (
      !binding ||
      binding.workspaceId !== workspaceId ||
      binding.organizationId !== organizationId ||
      binding.nodeId !== nodeId
    ) {
      return undefined;
    }
    if (binding.browserProfileId !== profileId) return undefined;
    const profile = server.profiles.find((candidate) => candidate.browserProfileId === profileId);
    if (!profile || profile.organizationId !== organizationId || profile.homeNodeId !== nodeId) {
      return undefined;
    }
    return cloneBinding(binding);
  }

  function setGeneration(nextGeneration: TGeneration) {
    if (status === "closed" || sameGeneration(currentGeneration, nextGeneration)) return;
    cancelList();
    cancelBind();
    currentGeneration = nextGeneration;
    server = { status: "not_requested", profiles: Object.freeze([]), binding: null };
    draftBrowserProfileId = null;
    mutation = { status: "idle" };
    publish();
  }

  function refreshScope(nextGeneration: TGeneration) {
    cancelList();
    cancelBind();
    currentGeneration = nextGeneration;
    server = { status: "not_requested", profiles: Object.freeze([]), binding: null };
    draftBrowserProfileId = null;
    mutation = { status: "idle" };
    publish();
  }

  async function load(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<BrowserBindingResult> {
    if (status === "closed")
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.closed" });
    if (mutation.status === "pending")
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.mutation_in_progress" });
    if (typeof input.requestId !== "string" || input.requestId.length === 0)
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_request" });
    if (!isCurrentGeneration(input.sessionGeneration)) {
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.generation_changed" });
    }
    cancelList();
    const attempt: ListAttempt<TGeneration> = {
      requestId: input.requestId,
      workspaceId,
      sessionGeneration: input.sessionGeneration,
      controller: new AbortController(),
    };
    listAttempt = attempt;
    server = {
      status: "loading",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      profiles: server.profiles,
      binding: server.binding,
    };
    publish();
    let response: unknown;
    try {
      response = await port.listProfiles(
        Object.freeze({
          workspaceId: attempt.workspaceId,
          requestId: attempt.requestId,
          sessionGeneration: attempt.sessionGeneration,
          signal: attempt.controller.signal,
        }),
      );
    } catch (error) {
      if (!isCurrentList(attempt))
        return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
      const reason = normalizeReason(error instanceof Error ? error.message : undefined);
      failList(attempt, reason);
      return freezeResult({ ok: false, reasonCode: reason });
    }
    if (!isCurrentList(attempt))
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
    const parsed = parseListResponse(response, attempt.requestId);
    if (!parsed) {
      failList(attempt, "enterprise.browser.invalid_response");
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_response" });
    }
    if (!isCurrentList(attempt))
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
    listAttempt = undefined;
    server = {
      status: "loaded",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
      profiles: parsed.profiles,
      binding: parsed.binding,
    };
    draftBrowserProfileId = parsed.binding?.browserProfileId ?? null;
    mutation = { status: "idle" };
    publish();
    return freezeResult({ ok: true });
  }

  async function submit(input: {
    readonly requestId: string;
    readonly sessionGeneration: TGeneration;
  }): Promise<BrowserBindingResult> {
    if (status === "closed")
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.closed" });
    if (mutation.status === "pending")
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.mutation_in_progress" });
    if (typeof input.requestId !== "string" || input.requestId.length === 0)
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_request" });
    if (!isCurrentGeneration(input.sessionGeneration)) {
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.generation_changed" });
    }
    if (server.status !== "loaded")
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.not_loaded" });
    if (
      !draftBrowserProfileId ||
      !server.profiles.some((profile) => profile.browserProfileId === draftBrowserProfileId)
    ) {
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_profile" });
    }
    cancelBind();
    const attempt: BindAttempt<TGeneration> = {
      requestId: input.requestId,
      workspaceId,
      sessionGeneration: input.sessionGeneration,
      browserProfileId: draftBrowserProfileId,
      controller: new AbortController(),
    };
    bindAttempt = attempt;
    mutation = {
      status: "pending",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
    };
    publish();
    let response: unknown;
    try {
      response = await port.bindProfile(
        Object.freeze({
          workspaceId: attempt.workspaceId,
          requestId: attempt.requestId,
          sessionGeneration: attempt.sessionGeneration,
          browserProfileId: attempt.browserProfileId,
          signal: attempt.controller.signal,
        }),
      );
    } catch (error) {
      if (!isCurrentBind(attempt))
        return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
      const reason = normalizeReason(error instanceof Error ? error.message : undefined);
      failBind(attempt, reason);
      return freezeResult({ ok: false, reasonCode: reason });
    }
    if (!isCurrentBind(attempt))
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
    const binding = parseBindResponse(response, attempt.requestId, attempt.browserProfileId);
    if (!binding) {
      failBind(attempt, "enterprise.browser.invalid_response");
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_response" });
    }
    if (!isCurrentBind(attempt))
      return freezeResult({ ok: false, reasonCode: "enterprise.browser.stale" });
    bindAttempt = undefined;
    server = { ...server, status: "loaded", binding: cloneBinding(binding) };
    draftBrowserProfileId = binding.browserProfileId;
    mutation = {
      status: "success",
      requestId: attempt.requestId,
      sessionGeneration: attempt.sessionGeneration,
    };
    publish();
    return freezeResult({ ok: true });
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (status === "closed") return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    selectProfile: (browserProfileId) => {
      if (status === "closed")
        return freezeResult({ ok: false, reasonCode: "enterprise.browser.closed" });
      if (mutation.status === "pending")
        return freezeResult({ ok: false, reasonCode: "enterprise.browser.mutation_in_progress" });
      if (
        server.status !== "loaded" ||
        !server.profiles.some((profile) => profile.browserProfileId === browserProfileId)
      ) {
        return freezeResult({ ok: false, reasonCode: "enterprise.browser.invalid_profile" });
      }
      draftBrowserProfileId = browserProfileId;
      publish();
      return freezeResult({ ok: true });
    },
    submit,
    setSessionGeneration: setGeneration,
    refreshScope,
    close: () => {
      if (status === "closed") return;
      cancelList();
      cancelBind();
      server = { status: "not_requested", profiles: Object.freeze([]), binding: null };
      draftBrowserProfileId = null;
      mutation = { status: "idle" };
      status = "closed";
      listeners.clear();
      publish();
    },
  };
}
