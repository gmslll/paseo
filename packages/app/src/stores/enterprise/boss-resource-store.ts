import {
  EnterpriseOrganizationListResourcesResponseSchema,
  GlobalResourceRefSchema,
  type EnterpriseOrganizationResourceProjection,
  type EnterprisePrincipalSummaryProjection,
  type GlobalResourceRef,
  type OrganizationId,
} from "@getpaseo/protocol/messages";

export interface BossResourceContentReadInput<TSessionGeneration> {
  readonly requestId: string;
  readonly resource: GlobalResourceRef;
  readonly sessionGeneration: TSessionGeneration;
  readonly signal: AbortSignal;
}

export interface BossResourceContentReadResult {
  readonly requestId: string;
  readonly resource: unknown;
  readonly content: unknown;
}

// These methods adapt existing resource-specific reads. They must not be implemented with a new
// generic content wire RPC.
export interface BossResourceStorePort<TSessionGeneration> {
  listOrganizationResources(input: {
    readonly requestId: string;
    readonly cursor?: string;
    readonly sessionGeneration: TSessionGeneration;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  readWorkspaceContent(
    input: BossResourceContentReadInput<TSessionGeneration>,
  ): Promise<BossResourceContentReadResult>;
  readAgentContent(
    input: BossResourceContentReadInput<TSessionGeneration>,
  ): Promise<BossResourceContentReadResult>;
  readBrowserProfileContent(
    input: BossResourceContentReadInput<TSessionGeneration>,
  ): Promise<BossResourceContentReadResult>;
  readAppSlotContent(
    input: BossResourceContentReadInput<TSessionGeneration>,
  ): Promise<BossResourceContentReadResult>;
}

export type BossResourceStoreReason =
  | "enterprise.metadata.invalid_response"
  | "enterprise.metadata.stale"
  | "enterprise.metadata.unavailable"
  | "enterprise.detail.invalid_resource"
  | "enterprise.detail.not_found"
  | "enterprise.content.invalid_response"
  | "enterprise.content.not_selected"
  | "enterprise.content.stale"
  | "enterprise.content.unavailable";

export type BossResourceMetadataState<TSessionGeneration> =
  | { readonly status: "not_requested" }
  | {
      readonly status: "loading";
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
    }
  | {
      readonly status: "loaded";
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
      readonly principals: readonly EnterprisePrincipalSummaryProjection[];
      readonly resources: readonly EnterpriseOrganizationResourceProjection[];
      readonly nextCursor: string | null;
    }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
      readonly reasonCode: BossResourceStoreReason;
    };

export type BossResourceDetailState<TSessionGeneration> =
  | { readonly status: "not_requested" }
  | {
      readonly status: "loaded";
      readonly resource: GlobalResourceRef;
      readonly sessionGeneration: TSessionGeneration;
      readonly metadata: EnterpriseOrganizationResourceProjection;
    };

export type BossResourceContentState<TContent, TSessionGeneration> =
  | { readonly status: "not_requested" }
  | {
      readonly status: "loading";
      readonly resource: GlobalResourceRef;
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
    }
  | {
      readonly status: "loaded";
      readonly resource: GlobalResourceRef;
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
      readonly value: TContent;
    }
  | {
      readonly status: "failed";
      readonly resource: GlobalResourceRef;
      readonly requestId: string;
      readonly sessionGeneration: TSessionGeneration;
      readonly reasonCode: BossResourceStoreReason;
    };

export interface BossResourceStoreSnapshot<TContent, TSessionGeneration> {
  readonly metadata: BossResourceMetadataState<TSessionGeneration>;
  readonly detail: BossResourceDetailState<TSessionGeneration>;
  readonly content: BossResourceContentState<TContent, TSessionGeneration>;
}

export type BossResourceStoreResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: BossResourceStoreReason };

export interface BossResourceStore<TContent, TSessionGeneration> {
  getSnapshot(): BossResourceStoreSnapshot<TContent, TSessionGeneration>;
  subscribe(listener: () => void): () => void;
  loadMetadata(
    sessionGeneration: TSessionGeneration,
    cursor?: string,
  ): Promise<BossResourceStoreResult>;
  selectDetail(resource: unknown): BossResourceStoreResult;
  openContent(sessionGeneration: TSessionGeneration): Promise<BossResourceStoreResult>;
  closeContent(): void;
  closeDetail(): void;
  clearSensitiveState(): void;
  dispose(): void;
}

const NOT_REQUESTED_METADATA = Object.freeze({ status: "not_requested" as const });
const NOT_REQUESTED_DETAIL = Object.freeze({ status: "not_requested" as const });
const NOT_REQUESTED_CONTENT = Object.freeze({ status: "not_requested" as const });

interface MetadataAttempt<TSessionGeneration> {
  readonly requestId: string;
  readonly sessionGeneration: TSessionGeneration;
  readonly abortController: AbortController;
}

interface ContentAttempt<TSessionGeneration> extends MetadataAttempt<TSessionGeneration> {
  readonly resource: GlobalResourceRef;
}

function emptySnapshot<TContent, TSessionGeneration>(): BossResourceStoreSnapshot<
  TContent,
  TSessionGeneration
> {
  return Object.freeze({
    metadata: NOT_REQUESTED_METADATA,
    detail: NOT_REQUESTED_DETAIL,
    content: NOT_REQUESTED_CONTENT,
  });
}

function cloneResource(resource: GlobalResourceRef): GlobalResourceRef {
  return Object.freeze({
    organizationId: resource.organizationId,
    nodeId: resource.nodeId,
    resourceKind: resource.resourceKind,
    localResourceId: resource.localResourceId,
  }) as GlobalResourceRef;
}

function sameResource(left: GlobalResourceRef, right: GlobalResourceRef): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.resourceKind === right.resourceKind &&
    left.localResourceId === right.localResourceId
  );
}

function resourceRefFromMetadata(
  metadata: EnterpriseOrganizationResourceProjection,
): GlobalResourceRef {
  const shared = {
    organizationId: metadata.organizationId,
    nodeId: metadata.nodeId,
  };
  switch (metadata.resourceKind) {
    case "workspace":
      return cloneResource({
        ...shared,
        resourceKind: "workspace",
        localResourceId: metadata.workspaceId,
      });
    case "agent":
      return cloneResource({ ...shared, resourceKind: "agent", localResourceId: metadata.agentId });
    case "browser_profile":
      return cloneResource({
        ...shared,
        resourceKind: "browser_profile",
        localResourceId: metadata.browserProfileId,
      });
    case "app_slot":
      return cloneResource({
        ...shared,
        resourceKind: "app_slot",
        localResourceId: metadata.appSlotId,
      });
  }
}

function deepFreezeProjection<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeProjection(nested);
  return Object.freeze(value);
}

export function createBossResourceStore<TContent, TSessionGeneration>(input: {
  readonly port: BossResourceStorePort<TSessionGeneration>;
  readonly organizationId: OrganizationId;
  readonly createRequestId: () => string;
  readonly isCurrentOrganizationScope: (organizationId: OrganizationId) => boolean;
  readonly isCurrentSessionGeneration: (generation: TSessionGeneration) => boolean;
  readonly cloneContent: (resource: GlobalResourceRef, content: unknown) => TContent;
}): BossResourceStore<TContent, TSessionGeneration> {
  let snapshot = emptySnapshot<TContent, TSessionGeneration>();
  let metadataAttempt: MetadataAttempt<TSessionGeneration> | undefined;
  let contentAttempt: ContentAttempt<TSessionGeneration> | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();

  const publish = (next: BossResourceStoreSnapshot<TContent, TSessionGeneration>) => {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A view observer cannot block the remaining observers.
      }
    }
  };

  const isCurrentScope = () => input.isCurrentOrganizationScope(input.organizationId);

  const isCurrentMetadataAttempt = (attempt: MetadataAttempt<TSessionGeneration>) =>
    !disposed &&
    metadataAttempt === attempt &&
    snapshot.metadata.status === "loading" &&
    snapshot.metadata.requestId === attempt.requestId &&
    snapshot.metadata.sessionGeneration === attempt.sessionGeneration &&
    input.isCurrentSessionGeneration(attempt.sessionGeneration) &&
    isCurrentScope();

  const discardMetadataAttempt = (attempt: MetadataAttempt<TSessionGeneration>) => {
    if (metadataAttempt !== attempt) return;
    metadataAttempt = undefined;
    if (
      snapshot.metadata.status === "loading" &&
      snapshot.metadata.requestId === attempt.requestId &&
      snapshot.metadata.sessionGeneration === attempt.sessionGeneration
    ) {
      publish(emptySnapshot());
    }
  };

  async function loadMetadata(
    sessionGeneration: TSessionGeneration,
    cursor?: string,
  ): Promise<BossResourceStoreResult> {
    if (disposed) return { ok: false, reasonCode: "enterprise.metadata.unavailable" };
    if (!input.isCurrentSessionGeneration(sessionGeneration) || !isCurrentScope()) {
      return { ok: false, reasonCode: "enterprise.metadata.stale" };
    }
    metadataAttempt?.abortController.abort();
    cancelContent();
    const abortController = new AbortController();
    const requestId = input.createRequestId();
    const attempt: MetadataAttempt<TSessionGeneration> = {
      requestId,
      sessionGeneration,
      abortController,
    };
    metadataAttempt = attempt;
    publish({
      metadata: Object.freeze({ status: "loading", requestId, sessionGeneration }),
      detail: NOT_REQUESTED_DETAIL,
      content: NOT_REQUESTED_CONTENT,
    });

    let response: unknown;
    try {
      response = await input.port.listOrganizationResources({
        requestId,
        ...(cursor !== undefined ? { cursor } : {}),
        sessionGeneration,
        signal: abortController.signal,
      });
    } catch {
      if (!isCurrentMetadataAttempt(attempt)) {
        discardMetadataAttempt(attempt);
        return { ok: false, reasonCode: "enterprise.metadata.stale" };
      }
      metadataAttempt = undefined;
      const reasonCode: BossResourceStoreReason = "enterprise.metadata.unavailable";
      publish({
        ...snapshot,
        metadata: Object.freeze({ status: "failed", requestId, sessionGeneration, reasonCode }),
      });
      return { ok: false, reasonCode };
    }

    if (!isCurrentMetadataAttempt(attempt)) {
      discardMetadataAttempt(attempt);
      return { ok: false, reasonCode: "enterprise.metadata.stale" };
    }
    metadataAttempt = undefined;
    const parsed = EnterpriseOrganizationListResourcesResponseSchema.safeParse(response);
    if (
      !parsed.success ||
      parsed.data.payload.requestId !== requestId ||
      parsed.data.payload.resources.some(
        (resource) => resource.organizationId !== input.organizationId,
      )
    ) {
      const reasonCode: BossResourceStoreReason = "enterprise.metadata.invalid_response";
      publish({
        ...snapshot,
        metadata: Object.freeze({ status: "failed", requestId, sessionGeneration, reasonCode }),
      });
      return { ok: false, reasonCode };
    }

    const principals = Object.freeze(
      parsed.data.payload.principals.map((principal) => deepFreezeProjection(principal)),
    );
    const resources = Object.freeze(
      parsed.data.payload.resources.map((resource) => deepFreezeProjection(resource)),
    );
    // P0 pagination is replace-only. Appending needs a separate cursor and deduplication contract.
    publish({
      ...snapshot,
      metadata: Object.freeze({
        status: "loaded",
        requestId,
        sessionGeneration,
        principals,
        resources,
        nextCursor: parsed.data.payload.nextCursor,
      }),
    });
    return { ok: true };
  }

  const cancelContent = () => {
    contentAttempt?.abortController.abort();
    contentAttempt = undefined;
  };

  const isMatchingContentAttempt = (attempt: ContentAttempt<TSessionGeneration>) =>
    !disposed &&
    contentAttempt === attempt &&
    snapshot.content.status === "loading" &&
    snapshot.content.requestId === attempt.requestId &&
    sameResource(snapshot.content.resource, attempt.resource) &&
    snapshot.content.sessionGeneration === attempt.sessionGeneration;

  const isCurrentContentAttempt = (attempt: ContentAttempt<TSessionGeneration>) =>
    isMatchingContentAttempt(attempt) &&
    input.isCurrentSessionGeneration(attempt.sessionGeneration) &&
    isCurrentScope();

  const readContent = (
    resource: GlobalResourceRef,
    readInput: BossResourceContentReadInput<TSessionGeneration>,
  ) => {
    switch (resource.resourceKind) {
      case "workspace":
        return input.port.readWorkspaceContent(readInput);
      case "agent":
        return input.port.readAgentContent(readInput);
      case "browser_profile":
        return input.port.readBrowserProfileContent(readInput);
      case "app_slot":
        return input.port.readAppSlotContent(readInput);
    }
  };

  const rejectContent = (
    attempt: ContentAttempt<TSessionGeneration>,
    reasonCode: BossResourceStoreReason,
    publishError: boolean,
  ): BossResourceStoreResult => {
    if (publishError && isCurrentContentAttempt(attempt)) {
      contentAttempt = undefined;
      publish({
        ...snapshot,
        content: Object.freeze({
          status: "failed",
          resource: attempt.resource,
          requestId: attempt.requestId,
          sessionGeneration: attempt.sessionGeneration,
          reasonCode,
        }),
      });
    } else if (isMatchingContentAttempt(attempt)) {
      contentAttempt = undefined;
      publish({ ...snapshot, content: NOT_REQUESTED_CONTENT });
    }
    return { ok: false, reasonCode };
  };

  async function openContent(
    sessionGeneration: TSessionGeneration,
  ): Promise<BossResourceStoreResult> {
    if (disposed) return { ok: false, reasonCode: "enterprise.content.unavailable" };
    if (snapshot.detail.status !== "loaded" || snapshot.metadata.status !== "loaded") {
      return { ok: false, reasonCode: "enterprise.content.not_selected" };
    }
    if (
      snapshot.detail.sessionGeneration !== sessionGeneration ||
      snapshot.metadata.sessionGeneration !== sessionGeneration ||
      !input.isCurrentSessionGeneration(sessionGeneration) ||
      !isCurrentScope() ||
      snapshot.detail.resource.organizationId !== input.organizationId
    ) {
      return { ok: false, reasonCode: "enterprise.content.stale" };
    }
    const resource = cloneResource(snapshot.detail.resource);
    cancelContent();
    const abortController = new AbortController();
    const requestId = input.createRequestId();
    const attempt: ContentAttempt<TSessionGeneration> = {
      requestId,
      resource,
      sessionGeneration,
      abortController,
    };
    contentAttempt = attempt;
    publish({
      ...snapshot,
      content: Object.freeze({
        status: "loading",
        resource,
        requestId,
        sessionGeneration,
      }),
    });

    let result: BossResourceContentReadResult;
    try {
      result = await readContent(resource, {
        requestId,
        resource,
        sessionGeneration,
        signal: abortController.signal,
      });
    } catch {
      return rejectContent(attempt, "enterprise.content.unavailable", true);
    }

    if (!isCurrentContentAttempt(attempt)) {
      return rejectContent(attempt, "enterprise.content.stale", false);
    }
    const resultResource = GlobalResourceRefSchema.safeParse(result.resource);
    if (
      result.requestId !== requestId ||
      !resultResource.success ||
      !sameResource(resultResource.data, resource)
    ) {
      return rejectContent(attempt, "enterprise.content.invalid_response", true);
    }

    let content: TContent;
    try {
      content = input.cloneContent(resource, result.content);
    } catch {
      return rejectContent(attempt, "enterprise.content.invalid_response", true);
    }

    if (!isCurrentContentAttempt(attempt)) {
      return rejectContent(attempt, "enterprise.content.stale", false);
    }

    contentAttempt = undefined;
    publish({
      ...snapshot,
      content: Object.freeze({
        status: "loaded",
        resource,
        requestId,
        sessionGeneration,
        value: content,
      }),
    });
    return { ok: true };
  }

  const clearSensitiveState = () => {
    if (disposed) return;
    metadataAttempt?.abortController.abort();
    metadataAttempt = undefined;
    cancelContent();
    publish(emptySnapshot());
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadMetadata,
    selectDetail: (rawResource) => {
      if (disposed) return { ok: false, reasonCode: "enterprise.detail.not_found" };
      cancelContent();
      publish({ ...snapshot, detail: NOT_REQUESTED_DETAIL, content: NOT_REQUESTED_CONTENT });
      const parsedResource = GlobalResourceRefSchema.safeParse(rawResource);
      if (!parsedResource.success) {
        return { ok: false, reasonCode: "enterprise.detail.invalid_resource" };
      }
      if (
        snapshot.metadata.status !== "loaded" ||
        !input.isCurrentSessionGeneration(snapshot.metadata.sessionGeneration) ||
        !isCurrentScope() ||
        parsedResource.data.organizationId !== input.organizationId
      ) {
        return { ok: false, reasonCode: "enterprise.detail.not_found" };
      }
      const resource = cloneResource(parsedResource.data);
      const metadata = snapshot.metadata.resources.find((candidate) =>
        sameResource(resourceRefFromMetadata(candidate), resource),
      );
      if (!metadata) return { ok: false, reasonCode: "enterprise.detail.not_found" };
      publish({
        ...snapshot,
        detail: Object.freeze({
          status: "loaded",
          resource,
          sessionGeneration: snapshot.metadata.sessionGeneration,
          metadata,
        }),
        content: NOT_REQUESTED_CONTENT,
      });
      return { ok: true };
    },
    openContent,
    closeContent: () => {
      if (disposed) return;
      cancelContent();
      publish({ ...snapshot, content: NOT_REQUESTED_CONTENT });
    },
    closeDetail: () => {
      if (disposed) return;
      cancelContent();
      publish({ ...snapshot, detail: NOT_REQUESTED_DETAIL, content: NOT_REQUESTED_CONTENT });
    },
    clearSensitiveState,
    dispose: () => {
      if (disposed) return;
      metadataAttempt?.abortController.abort();
      metadataAttempt = undefined;
      cancelContent();
      snapshot = emptySnapshot();
      disposed = true;
      listeners.clear();
    },
  };
}
