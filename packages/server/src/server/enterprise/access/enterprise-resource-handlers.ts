import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EnterpriseAccessListGrantsResponseSchema,
  EnterpriseAccessUpdateGrantsResponseSchema,
  EnterpriseOrganizationListResourcesResponseSchema,
  EnterpriseOrganizationResourceProjectionSchema,
  EnterprisePlacementResolveWorkspaceResponseSchema,
  EnterprisePrincipalSummaryProjectionSchema,
  EnterpriseResourceOwnershipTransferResponseSchema,
  EnterpriseWorkspaceOwnershipTransferTombstoneSchema,
  GlobalResourceRefSchema,
  NodeContextSchema,
  PrincipalContextSchema,
  normalizeResourceGrants,
  type EnterpriseOrganizationResourceProjection,
  type EnterprisePrincipalSummaryProjection,
  type EnterpriseWorkspaceOwnershipTransferTombstone,
  type GlobalResourceRef,
  type NodeContext,
  type OutboundAuthorizationContext,
  type PlacementResolver,
  type PrincipalContext,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { SessionInboundMessageSchema, type SessionInboundMessage } from "../../messages.js";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResponse,
  EnterpriseReceiptClassification,
  EnterpriseResponseContextConsumer,
  EnterpriseSessionDispatcher,
} from "../../session/enterprise-dispatcher.js";
import type { AuthoritySessionBindingRecord } from "./authority-receipt-verifier.js";
import {
  isAuthoritativeGrantStore,
  readAuthoritativeGrantRecord,
  updateAuthoritativeGrantRecord,
  type GrantStore,
} from "./grant-store.js";
import {
  getAuthoritativeAgent,
  getAuthoritativeWorkspace,
  isOwnerRegistry,
  type OwnerRegistry,
} from "./owner-registry.js";
import {
  isCurrentProductionAuthorizationRuntimeForAuthoritySources,
  type ProductionAuthorizationRuntime,
} from "./production-authorization-runtime.js";
import {
  isWorkspaceTransfer,
  transferWorkspaceOwnership,
  type WorkspaceTransfer,
} from "./workspace-transfer.js";

export const ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES = Object.freeze([
  "enterprise.access.list_grants.request",
  "enterprise.access.update_grants.request",
  "enterprise.organization.list_resources.request",
  "enterprise.placement.resolve_workspace.request",
  "enterprise.resource.ownership.transfer.request",
] as const satisfies readonly SessionInboundMessage["type"][]);

export type EnterpriseResourceHandlerRequestType =
  (typeof ENTERPRISE_RESOURCE_HANDLER_REQUEST_TYPES)[number];

export type EnterpriseResourceHandlerPolicy = Readonly<
  | {
      requestType:
        | "enterprise.access.list_grants.request"
        | "enterprise.access.update_grants.request"
        | "enterprise.resource.ownership.transfer.request";
      responseType:
        | "enterprise.access.list_grants.response"
        | "enterprise.access.update_grants.response"
        | "enterprise.resource.ownership.transfer.response";
      authorization: "authority_receipt";
    }
  | {
      requestType:
        | "enterprise.organization.list_resources.request"
        | "enterprise.placement.resolve_workspace.request";
      responseType:
        | "enterprise.organization.list_resources.response"
        | "enterprise.placement.resolve_workspace.response";
      authorization: "resources";
    }
>;

const HANDLER_POLICIES = Object.freeze([
  Object.freeze({
    requestType: "enterprise.access.list_grants.request",
    responseType: "enterprise.access.list_grants.response",
    authorization: "authority_receipt",
  }),
  Object.freeze({
    requestType: "enterprise.access.update_grants.request",
    responseType: "enterprise.access.update_grants.response",
    authorization: "authority_receipt",
  }),
  Object.freeze({
    requestType: "enterprise.organization.list_resources.request",
    responseType: "enterprise.organization.list_resources.response",
    authorization: "resources",
  }),
  Object.freeze({
    requestType: "enterprise.placement.resolve_workspace.request",
    responseType: "enterprise.placement.resolve_workspace.response",
    authorization: "resources",
  }),
  Object.freeze({
    requestType: "enterprise.resource.ownership.transfer.request",
    responseType: "enterprise.resource.ownership.transfer.response",
    authorization: "authority_receipt",
  }),
] as const satisfies readonly EnterpriseResourceHandlerPolicy[]);

const handlerPolicyByRequestType = new Map(
  HANDLER_POLICIES.map((policy) => [policy.requestType, policy] as const),
);

export function enterpriseResourceHandlerPolicyForRequestType(
  requestType: string,
): EnterpriseResourceHandlerPolicy | null {
  return (
    handlerPolicyByRequestType.get(requestType as EnterpriseResourceHandlerRequestType) ?? null
  );
}

export function enterpriseResourceRequestPolicyForType(
  requestType: string,
): EnterpriseReceiptClassification | null {
  const policy = enterpriseResourceHandlerPolicyForRequestType(requestType);
  if (!policy) return null;
  return policy.authorization === "authority_receipt" ? "authority" : "resources";
}

export interface EnterpriseOrganizationResourcePage {
  readonly principals: readonly EnterprisePrincipalSummaryProjection[];
  readonly resources: readonly EnterpriseOrganizationResourceProjection[];
  readonly nextCursor: string | null;
}

export interface EnterpriseOrganizationResourceSource {
  list(input: {
    readonly organizationId: string;
    readonly nodeId: string;
    readonly resourceKinds: readonly EnterpriseOrganizationResourceProjection["resourceKind"][];
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<EnterpriseOrganizationResourcePage>;
}

export interface EnterpriseResourceHandlerDependencies {
  readonly runtime: ProductionAuthorizationRuntime;
  readonly grantStore: GrantStore;
  readonly owners: OwnerRegistry;
  readonly placement: PlacementResolver;
  readonly organizationResources: EnterpriseOrganizationResourceSource;
  readonly workspaceTransfers?: WorkspaceTransfer;
}

export interface EnterpriseResourceDispatcher extends EnterpriseSessionDispatcher {
  readonly requestPolicyForType: (type: string) => EnterpriseReceiptClassification | null;
  readonly consumeResponse: EnterpriseResponseContextConsumer["consumeResponse"];
}

declare const workspaceOwnershipTransferTombstoneContextBrand: unique symbol;

/** Opaque W2 authority for W3 to fan out one committed Workspace-transfer tombstone. */
export interface WorkspaceOwnershipTransferTombstoneContext {
  readonly [workspaceOwnershipTransferTombstoneContextBrand]: never;
  readonly message: EnterpriseWorkspaceOwnershipTransferTombstone;
  readonly issuerBinding: AuthoritySessionBindingRecord;
}

type ResourceContext = Extract<OutboundAuthorizationContext, { kind: "resources" }>;

export type ConsumedEnterpriseResourceHandlerResult = Readonly<
  | {
      response: SessionOutboundMessage;
      authorization: "authority_receipt";
    }
  | {
      response: SessionOutboundMessage;
      authorization: "resources";
      context: ResourceContext;
    }
>;

type HandlerInput = Parameters<EnterpriseSessionDispatcher["handle"]>[0];

interface CanonicalHandlerInput {
  readonly originalContext: EnterpriseDispatchContext;
  readonly originalMessage: SessionInboundMessage;
  readonly sessionContext: EnterpriseDispatchContext;
  readonly message: Extract<SessionInboundMessage, { type: EnterpriseResourceHandlerRequestType }>;
}

interface IssuedResultState {
  readonly handler: EnterpriseResourceAuthorizationHandlers;
  readonly input: CanonicalHandlerInput;
  readonly output: ConsumedEnterpriseResourceHandlerResult;
}

interface WorkspaceOwnershipTransferTombstoneSeed {
  readonly handler: EnterpriseResourceAuthorizationHandlers;
  readonly sessionContext: EnterpriseDispatchContext;
  readonly resource: Extract<GlobalResourceRef, { resourceKind: "workspace" }>;
  readonly oldPrincipalId: string;
  readonly newRevision: string;
  readonly transferReceiptId: string;
  readonly binding: AuthoritySessionBindingRecord;
}

interface EnterpriseResourceDispatcherState {
  readonly handler: EnterpriseResourceAuthorizationHandlers;
  readonly isActive: () => boolean;
}

const issuedHandlerResults = new WeakMap<object, IssuedResultState>();
const transferTombstoneSeeds = new WeakMap<object, WorkspaceOwnershipTransferTombstoneSeed>();
const issuedTransferTombstones = new WeakMap<object, WorkspaceOwnershipTransferTombstoneSeed>();
const enterpriseResourceDispatchers = new WeakMap<object, EnterpriseResourceDispatcherState>();
const workspaceOwnershipTransferTombstoneContexts = new WeakSet<object>();
const enterpriseResourceHandlers = new WeakSet<object>();

const OrganizationResourcePageSchema = z
  .object({
    principals: z.array(EnterprisePrincipalSummaryProjectionSchema),
    resources: z.array(EnterpriseOrganizationResourceProjectionSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

const RESOURCE_KINDS = Object.freeze([
  "workspace",
  "agent",
  "browser_profile",
  "app_slot",
] as const);

export class EnterpriseResourceAuthorizationHandlers implements EnterpriseSessionDispatcher {
  private readonly runtime: ProductionAuthorizationRuntime;
  private readonly grantStore: GrantStore;
  private readonly owners: OwnerRegistry;
  private readonly resolveWorkspace: PlacementResolver["resolveWorkspace"];
  private readonly listOrganizationResources: EnterpriseOrganizationResourceSource["list"];
  private readonly workspaceTransfers: WorkspaceTransfer | undefined;

  constructor(dependencies: EnterpriseResourceHandlerDependencies) {
    this.runtime = dependencies.runtime;
    this.grantStore = dependencies.grantStore;
    this.owners = dependencies.owners;
    this.resolveWorkspace = dependencies.placement.resolveWorkspace.bind(dependencies.placement);
    this.listOrganizationResources = dependencies.organizationResources.list.bind(
      dependencies.organizationResources,
    );
    this.workspaceTransfers = dependencies.workspaceTransfers;
    if (
      !isAuthoritativeGrantStore(this.grantStore) ||
      !isOwnerRegistry(this.owners) ||
      !isCurrentProductionAuthorizationRuntimeForAuthoritySources(
        this.runtime,
        this.grantStore,
        this.owners,
      )
    ) {
      throw new Error("enterprise resource handlers require exact production authority sources");
    }
    if (this.workspaceTransfers !== undefined && !isWorkspaceTransfer(this.workspaceTransfers)) {
      throw new Error("enterprise resource handlers require a nominal WorkspaceTransfer");
    }
    enterpriseResourceHandlers.add(this);
    Object.freeze(this);
  }

  async handle(input: HandlerInput): Promise<SessionOutboundMessage | false> {
    const captured = canonicalHandlerInput(input);
    if (!captured || !this.isCurrent(captured.sessionContext)) return false;
    let output: ConsumedEnterpriseResourceHandlerResult | null = null;
    try {
      switch (captured.message.type) {
        case "enterprise.access.list_grants.request":
          output = await this.listGrants({ ...captured, message: captured.message });
          break;
        case "enterprise.access.update_grants.request":
          output = await this.updateGrants({ ...captured, message: captured.message });
          break;
        case "enterprise.organization.list_resources.request":
          output = await this.listResources({ ...captured, message: captured.message });
          break;
        case "enterprise.placement.resolve_workspace.request":
          output = await this.resolvePlacement({ ...captured, message: captured.message });
          break;
        case "enterprise.resource.ownership.transfer.request":
          output = await this.transferOwnership({ ...captured, message: captured.message });
          break;
      }
    } catch {
      return false;
    }
    if (!output || !this.isCurrent(captured.sessionContext)) return false;
    issuedHandlerResults.set(output.response, { handler: this, input: captured, output });
    return output.response;
  }

  /** @internal Result capabilities are burned before any caller-controlled validation. */
  consume(
    input: HandlerInput,
    result: SessionOutboundMessage,
  ): ConsumedEnterpriseResourceHandlerResult | null {
    try {
      if (!isObject(result)) return null;
      const issued = issuedHandlerResults.get(result);
      if (!issued) return null;
      issuedHandlerResults.delete(result);
      const own = strictOwnData(input, ["sessionContext", "message"]);
      if (
        !own ||
        issued.handler !== this ||
        own.sessionContext !== issued.input.originalContext ||
        own.message !== issued.input.originalMessage
      ) {
        return null;
      }
      const captured = canonicalHandlerInput(input);
      if (
        !captured ||
        !sameCanonical(captured.sessionContext, issued.input.sessionContext) ||
        !sameCanonical(captured.message, issued.input.message) ||
        !this.isCurrent(captured.sessionContext)
      ) {
        return null;
      }
      return issued.output;
    } catch {
      return null;
    }
  }

  private async listGrants(
    input: CanonicalHandlerInput & {
      readonly message: Extract<
        SessionInboundMessage,
        { type: "enterprise.access.list_grants.request" }
      >;
    },
  ): Promise<ConsumedEnterpriseResourceHandlerResult | null> {
    if (!hasOrganizationAction(input.sessionContext.enterpriseContext.principal, "identity.manage"))
      return null;
    const record = await readAuthoritativeGrantRecord(this.grantStore, input.message.principalId);
    if (!this.isCurrent(input.sessionContext) || !record) return null;
    if (record.organizationId !== input.sessionContext.enterpriseContext.principal.organizationId)
      return null;
    const response = canonicalResponse(
      EnterpriseAccessListGrantsResponseSchema.parse({
        type: "enterprise.access.list_grants.response",
        payload: {
          requestId: input.message.requestId,
          principalId: record.principalId,
          grants: record.grants,
          revision: record.grantVersion,
        },
      }),
    );
    return deepFreeze({ response, authorization: "authority_receipt" as const });
  }

  private async updateGrants(
    input: CanonicalHandlerInput & {
      readonly message: Extract<
        SessionInboundMessage,
        { type: "enterprise.access.update_grants.request" }
      >;
    },
  ): Promise<ConsumedEnterpriseResourceHandlerResult | null> {
    const principal = input.sessionContext.enterpriseContext.principal;
    if (!hasOrganizationAction(principal, "identity.manage")) return null;
    const previous = await readAuthoritativeGrantRecord(this.grantStore, input.message.principalId);
    if (!this.isCurrent(input.sessionContext) || !previous) return null;
    if (previous.organizationId !== principal.organizationId) return null;
    const change = await updateAuthoritativeGrantRecord(this.grantStore, {
      actor: principal,
      principalId: previous.principalId,
      organizationId: principal.organizationId,
      grants: input.message.grants,
      expectedVersion: input.message.expectedRevision,
    });
    if (!this.isCurrent(input.sessionContext)) return null;
    const response = canonicalResponse(
      EnterpriseAccessUpdateGrantsResponseSchema.parse({
        type: "enterprise.access.update_grants.response",
        payload: {
          requestId: input.message.requestId,
          principalId: change.current.principalId,
          grants: change.current.grants,
          revision: change.current.grantVersion,
        },
      }),
    );
    return deepFreeze({ response, authorization: "authority_receipt" as const });
  }

  private async resolvePlacement(
    input: CanonicalHandlerInput & {
      readonly message: Extract<
        SessionInboundMessage,
        { type: "enterprise.placement.resolve_workspace.request" }
      >;
    },
  ): Promise<ConsumedEnterpriseResourceHandlerResult | null> {
    const principal = input.sessionContext.enterpriseContext.principal;
    const authorized = await this.runtime.resourceAuthorization.assertWorkspace(
      principal,
      "workspace.metadata.read",
      input.message.workspaceId,
    );
    if (!this.isCurrent(input.sessionContext)) return null;
    const rawResource = await this.resolveWorkspace(input.message.workspaceId);
    if (!this.isCurrent(input.sessionContext) || !rawResource) return null;
    const resource = deepFreeze(GlobalResourceRefSchema.parse(structuredClone(rawResource)));
    if (
      resource.resourceKind !== "workspace" ||
      resource.localResourceId !== authorized.workspaceId ||
      resource.organizationId !== authorized.organizationId ||
      resource.nodeId !== authorized.nodeId
    ) {
      return null;
    }
    const response = canonicalResponse(
      EnterprisePlacementResolveWorkspaceResponseSchema.parse({
        type: "enterprise.placement.resolve_workspace.response",
        payload: { requestId: input.message.requestId, resource },
      }),
    );
    const context = resourceContext([resource]);
    if (!(await this.runtime.resourceAuthorization.canEmit(principal, response, context)))
      return null;
    if (!this.isCurrent(input.sessionContext)) return null;
    return deepFreeze({ response, authorization: "resources" as const, context });
  }

  private async transferOwnership(
    input: CanonicalHandlerInput & {
      readonly message: Extract<
        SessionInboundMessage,
        { type: "enterprise.resource.ownership.transfer.request" }
      >;
    },
  ): Promise<ConsumedEnterpriseResourceHandlerResult | null> {
    if (!this.workspaceTransfers || input.message.resource.resourceKind !== "workspace")
      return null;
    const principal = input.sessionContext.enterpriseContext.principal;
    const resource = input.message.resource;
    if (
      resource.organizationId !== principal.organizationId ||
      resource.nodeId !== input.sessionContext.enterpriseContext.node.nodeId ||
      input.message.expectedOwnerPrincipalId !== principal.principalId
    ) {
      return null;
    }
    const canonical = getAuthoritativeWorkspace(this.owners, resource.localResourceId);
    if (
      !canonical ||
      canonical.organizationId !== resource.organizationId ||
      canonical.nodeId !== resource.nodeId ||
      canonical.ownerPrincipalId !== principal.principalId
    ) {
      return null;
    }
    const authorized = await this.runtime.resourceAuthorization.assertWorkspace(
      principal,
      "workspace.manage",
      canonical.workspaceId,
    );
    if (!this.isCurrent(input.sessionContext) || !sameWorkspaceAuthority(authorized, canonical)) {
      return null;
    }
    const transferIsCurrent = () => {
      if (!this.isCurrent(input.sessionContext)) return false;
      const current = getAuthoritativeWorkspace(this.owners, canonical.workspaceId);
      return Boolean(current && sameWorkspaceAuthority(current, canonical));
    };
    const committed = await transferWorkspaceOwnership(this.workspaceTransfers, {
      actor: principal,
      sessionId: input.sessionContext.sessionId,
      workspace: authorized,
      expectedOwnerPrincipalId: input.message.expectedOwnerPrincipalId,
      expectedRevision: input.message.expectedRevision,
      newPrincipalId: input.message.newPrincipalId,
      isCurrent: transferIsCurrent,
    });
    if (!committed) return null;
    this.owners.registerWorkspace({
      id: committed.workspace.workspaceId,
      organizationId: committed.workspace.organizationId,
      nodeId: committed.workspace.nodeId,
      ownerPrincipalId: committed.workspace.ownerPrincipalId,
      createdByPrincipalId: committed.workspace.createdByPrincipalId,
    });
    const current = getAuthoritativeWorkspace(this.owners, canonical.workspaceId);
    if (
      !this.isCurrent(input.sessionContext) ||
      !current ||
      current.organizationId !== canonical.organizationId ||
      current.nodeId !== canonical.nodeId ||
      current.ownerPrincipalId !== input.message.newPrincipalId ||
      current.createdByPrincipalId !== canonical.createdByPrincipalId
    ) {
      return null;
    }
    const response = canonicalResponse(
      EnterpriseResourceOwnershipTransferResponseSchema.parse({
        type: "enterprise.resource.ownership.transfer.response",
        payload: {
          requestId: input.message.requestId,
          resource,
          ownerPrincipalId: current.ownerPrincipalId,
          revision: committed.workspace.ownershipRevision,
          receiptId: committed.receiptId,
        },
      }),
    );
    transferTombstoneSeeds.set(
      response,
      Object.freeze({
        handler: this,
        sessionContext: input.sessionContext,
        resource,
        oldPrincipalId: principal.principalId,
        newRevision: response.payload.revision,
        transferReceiptId: committed.receiptId,
        binding: deepFreeze(structuredClone(this.runtime.binding)),
      }),
    );
    return deepFreeze({ response, authorization: "authority_receipt" as const });
  }

  private async listResources(
    input: CanonicalHandlerInput & {
      readonly message: Extract<
        SessionInboundMessage,
        { type: "enterprise.organization.list_resources.request" }
      >;
    },
  ): Promise<ConsumedEnterpriseResourceHandlerResult | null> {
    const principal = input.sessionContext.enterpriseContext.principal;
    const requestedKinds = input.message.resourceKinds ?? RESOURCE_KINDS;
    const page = OrganizationResourcePageSchema.parse(
      structuredClone(
        await this.listOrganizationResources(
          deepFreeze({
            organizationId: principal.organizationId,
            nodeId: input.sessionContext.enterpriseContext.node.nodeId,
            resourceKinds: [...requestedKinds],
            ...(input.message.cursor === undefined ? {} : { cursor: input.message.cursor }),
            ...(input.message.limit === undefined ? {} : { limit: input.message.limit }),
          }),
        ),
      ),
    );
    if (!this.isCurrent(input.sessionContext)) return null;

    const resources: EnterpriseOrganizationResourceProjection[] = [];
    const refs: GlobalResourceRef[] = [];
    const seen = new Set<string>();
    for (const row of page.resources) {
      if (!requestedKinds.includes(row.resourceKind)) continue;
      const rowRefs = await this.authorizeOrganizationRow(input, row);
      if (!this.isCurrent(input.sessionContext)) return null;
      if (!rowRefs) continue;
      const key = projectionKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      resources.push(deepFreeze(structuredClone(row)));
      refs.push(...rowRefs);
    }
    const ownerPrincipalIds = new Set(
      resources.flatMap((row) => (row.ownerPrincipalId ? [row.ownerPrincipalId] : [])),
    );
    const principals = page.principals
      .filter((candidate) => ownerPrincipalIds.has(candidate.principalId))
      .map((candidate) => deepFreeze(structuredClone(candidate)));
    const response = canonicalResponse(
      EnterpriseOrganizationListResourcesResponseSchema.parse({
        type: "enterprise.organization.list_resources.response",
        payload: {
          requestId: input.message.requestId,
          principals,
          resources,
          nextCursor: resources.length === 0 ? null : page.nextCursor,
        },
      }),
    );
    const context = resourceContext(uniqueResources(refs));
    if (!(await this.runtime.resourceAuthorization.canEmit(principal, response, context)))
      return null;
    if (!this.isCurrent(input.sessionContext)) return null;
    return deepFreeze({ response, authorization: "resources" as const, context });
  }

  private async authorizeOrganizationRow(
    input: CanonicalHandlerInput,
    row: EnterpriseOrganizationResourceProjection,
  ): Promise<readonly GlobalResourceRef[] | null> {
    const principal = input.sessionContext.enterpriseContext.principal;
    if (
      row.organizationId !== principal.organizationId ||
      row.nodeId !== input.sessionContext.enterpriseContext.node.nodeId
    ) {
      return null;
    }
    const ref = projectionResource(row);
    if (row.resourceKind === "workspace") {
      const workspace = getAuthoritativeWorkspace(this.owners, row.workspaceId);
      if (!workspace || workspace.ownerPrincipalId !== row.ownerPrincipalId) return null;
      try {
        await this.runtime.resourceAuthorization.assertWorkspace(
          principal,
          "workspace.metadata.read",
          row.workspaceId,
        );
      } catch {
        return null;
      }
      return [ref];
    }
    if (row.resourceKind === "agent") {
      const agent = getAuthoritativeAgent(this.owners, row.agentId);
      if (
        !agent ||
        agent.workspaceId !== row.workspaceId ||
        agent.ownerPrincipalId !== row.ownerPrincipalId
      ) {
        return null;
      }
      try {
        await this.runtime.resourceAuthorization.assertAgent(
          principal,
          "workspace.metadata.read",
          row.agentId,
        );
      } catch {
        return null;
      }
      return [ref];
    }
    const refs = [ref];
    if (row.workspaceId) {
      const workspace = getAuthoritativeWorkspace(this.owners, row.workspaceId);
      if (
        !workspace ||
        workspace.organizationId !== principal.organizationId ||
        workspace.nodeId !== input.sessionContext.enterpriseContext.node.nodeId
      ) {
        return null;
      }
      refs.push({
        organizationId: workspace.organizationId,
        nodeId: workspace.nodeId,
        resourceKind: "workspace",
        localResourceId: workspace.workspaceId,
      });
    }
    const probe = canonicalResponse(
      EnterpriseOrganizationListResourcesResponseSchema.parse({
        type: "enterprise.organization.list_resources.response",
        payload: {
          requestId: input.message.requestId,
          principals: [],
          resources: [row],
          nextCursor: null,
        },
      }),
    );
    return (await this.runtime.resourceAuthorization.canEmit(
      principal,
      probe,
      resourceContext(refs),
    ))
      ? refs
      : null;
  }

  private isCurrent(context: EnterpriseDispatchContext): boolean {
    try {
      return (
        isCurrentProductionAuthorizationRuntimeForAuthoritySources(
          this.runtime,
          this.grantStore,
          this.owners,
        ) &&
        this.runtime.binding.sessionId === context.sessionId &&
        this.runtime.binding.clientId === context.clientId &&
        this.runtime.principal.credentialId === context.credentialId &&
        this.runtime.binding.sessionBindingGeneration === context.sessionBindingGeneration &&
        this.runtime.binding.sessionBindingGeneration ===
          context.enterpriseContext.sessionBindingGeneration &&
        samePrincipalAuthority(this.runtime.principal, context.enterpriseContext.principal) &&
        sameNodeAuthority(this.runtime.node, context.enterpriseContext.node)
      );
    } catch {
      return false;
    }
  }

  /** @internal Revalidates the exact issuing Session generation before W3 claims a tombstone. */
  isCurrentForIssuedTombstone(
    context: EnterpriseDispatchContext,
    binding: AuthoritySessionBindingRecord,
  ): boolean {
    return this.isCurrent(context) && sameAuthorityBinding(this.runtime.binding, binding);
  }
}

export function consumeEnterpriseResourceHandlerResult(
  handler: unknown,
  input: HandlerInput,
  result: SessionOutboundMessage,
): ConsumedEnterpriseResourceHandlerResult | null {
  if (!isObject(handler) || !enterpriseResourceHandlers.has(handler)) return null;
  return EnterpriseResourceAuthorizationHandlers.prototype.consume.call(handler, input, result);
}

export function createEnterpriseResourceDispatcher(
  dependencies: EnterpriseResourceHandlerDependencies,
): EnterpriseResourceDispatcher {
  const handlers = new EnterpriseResourceAuthorizationHandlers(dependencies);
  const dispatcher = Object.freeze({
    requestPolicyForType: enterpriseResourceRequestPolicyForType,
    handle: handlers.handle.bind(handlers),
    consumeResponse: (input: Parameters<EnterpriseResponseContextConsumer["consumeResponse"]>[0]) =>
      consumeResponse(handlers, input),
  });
  enterpriseResourceDispatchers.set(dispatcher, {
    handler: handlers,
    isActive: () => true,
  });
  return dispatcher;
}

/** Builds the only lease facade that preserves W2's nominal tombstone issuer. */
export function createLeasedEnterpriseResourceDispatcher(
  delegate: EnterpriseResourceDispatcher,
  isActive: () => boolean,
): EnterpriseResourceDispatcher | null {
  try {
    const delegateState = enterpriseResourceDispatchers.get(delegate);
    if (!delegateState || typeof isActive !== "function") return null;
    const active = () => {
      try {
        return isActive() && delegateState.isActive();
      } catch {
        return false;
      }
    };
    const dispatcher: EnterpriseResourceDispatcher = Object.freeze({
      requestPolicyForType: (requestType: string) =>
        active() ? delegate.requestPolicyForType(requestType) : null,
      handle: async (input: Parameters<EnterpriseResourceDispatcher["handle"]>[0]) => {
        if (!active()) return false;
        try {
          const response = await delegate.handle(input);
          return active() ? response : false;
        } catch {
          return false;
        }
      },
      consumeResponse: (input: Parameters<EnterpriseResourceDispatcher["consumeResponse"]>[0]) => {
        if (!active()) return null;
        try {
          return delegate.consumeResponse(input);
        } catch {
          return null;
        }
      },
    });
    enterpriseResourceDispatchers.set(dispatcher, {
      handler: delegateState.handler,
      isActive: active,
    });
    return dispatcher;
  } catch {
    return null;
  }
}

/**
 * Burns the authority-response sidecar before validation and returns one nominal,
 * current-generation tombstone context only for a committed Workspace transfer.
 */
export function consumeWorkspaceOwnershipTransferTombstoneContext(
  dispatcher: unknown,
  contextualResponse: unknown,
): WorkspaceOwnershipTransferTombstoneContext | null {
  try {
    if (!isObject(contextualResponse)) return null;
    const seed = issuedTransferTombstones.get(contextualResponse);
    if (!seed) return null;
    issuedTransferTombstones.delete(contextualResponse);
    if (!isObject(dispatcher)) return null;
    const dispatcherState = enterpriseResourceDispatchers.get(dispatcher);
    if (
      !dispatcherState ||
      dispatcherState.handler !== seed.handler ||
      !dispatcherState.isActive() ||
      !seed.handler.isCurrentForIssuedTombstone(seed.sessionContext, seed.binding) ||
      seed.sessionContext.sessionBindingGeneration !==
        seed.sessionContext.enterpriseContext.sessionBindingGeneration ||
      seed.binding.organizationId !== seed.resource.organizationId ||
      seed.binding.nodeId !== seed.resource.nodeId ||
      seed.binding.principalId !== seed.oldPrincipalId
    ) {
      return null;
    }
    const message = deepFreeze(
      EnterpriseWorkspaceOwnershipTransferTombstoneSchema.parse({
        type: "enterprise.workspace.ownership.transfer.tombstone",
        payload: {
          eventId: randomUUID(),
          resource: seed.resource,
          oldPrincipalId: seed.oldPrincipalId,
          newRevision: seed.newRevision,
          transferReceiptId: seed.transferReceiptId,
        },
      }),
    );
    const context = deepFreeze({
      message,
      issuerBinding: seed.binding,
    }) as WorkspaceOwnershipTransferTombstoneContext;
    workspaceOwnershipTransferTombstoneContexts.add(context);
    return context;
  } catch {
    return null;
  }
}

export function isWorkspaceOwnershipTransferTombstoneContext(
  value: unknown,
): value is WorkspaceOwnershipTransferTombstoneContext {
  return isObject(value) && workspaceOwnershipTransferTombstoneContexts.has(value);
}

function consumeResponse(
  handlers: EnterpriseResourceAuthorizationHandlers,
  input: Parameters<EnterpriseResponseContextConsumer["consumeResponse"]>[0],
): EnterpriseDispatchResponse | null {
  try {
    if (!isObject(input)) return null;
    const responseDescriptor = Object.getOwnPropertyDescriptor(input, "response");
    if (
      !responseDescriptor ||
      !("value" in responseDescriptor) ||
      !isObject(responseDescriptor.value)
    ) {
      return null;
    }
    const tombstoneSeed = transferTombstoneSeeds.get(responseDescriptor.value);
    transferTombstoneSeeds.delete(responseDescriptor.value);
    const captured = strictOwnData(input, ["sessionContext", "message", "response"]);
    const consumed = consumeEnterpriseResourceHandlerResult(
      handlers,
      captured
        ? {
            sessionContext: captured.sessionContext as EnterpriseDispatchContext,
            message: captured.message as SessionInboundMessage,
          }
        : (Object.freeze(Object.create(null)) as HandlerInput),
      responseDescriptor.value as SessionOutboundMessage,
    );
    if (!consumed) return null;
    const contextual =
      consumed.authorization === "authority_receipt"
        ? deepFreeze({ response: consumed.response, receiptClassification: "authority" as const })
        : deepFreeze({
            response: consumed.response,
            authorizationContext: consumed.context,
            receiptClassification: "resources" as const,
          });
    if (tombstoneSeed && tombstoneSeed.handler === handlers) {
      issuedTransferTombstones.set(contextual, tombstoneSeed);
    }
    return contextual;
  } catch {
    return null;
  }
}

function canonicalHandlerInput(input: HandlerInput): CanonicalHandlerInput | null {
  try {
    const own = strictOwnData(input, ["sessionContext", "message"]);
    if (!own || !isObject(own.sessionContext) || !isObject(own.message)) return null;
    const contextOwn = strictOwnData(own.sessionContext, [
      "sessionId",
      "clientId",
      "credentialId",
      "sessionBindingGeneration",
      "enterpriseContext",
    ]);
    if (!contextOwn || !isObject(contextOwn.enterpriseContext)) return null;
    const enterpriseOwn = strictOwnData(contextOwn.enterpriseContext, [
      "principal",
      "node",
      "sessionBindingGeneration",
    ]);
    if (!enterpriseOwn) return null;
    const sessionContext = deepFreeze({
      sessionId: z.string().min(1).parse(contextOwn.sessionId),
      clientId: z.string().min(1).parse(contextOwn.clientId),
      credentialId: z.string().min(1).parse(contextOwn.credentialId),
      sessionBindingGeneration: z.string().min(1).parse(contextOwn.sessionBindingGeneration),
      enterpriseContext: {
        principal: PrincipalContextSchema.parse(structuredClone(enterpriseOwn.principal)),
        node: NodeContextSchema.parse(structuredClone(enterpriseOwn.node)),
        sessionBindingGeneration: z.string().min(1).parse(enterpriseOwn.sessionBindingGeneration),
      },
    });
    if (
      sessionContext.credentialId !== sessionContext.enterpriseContext.principal.credentialId ||
      sessionContext.sessionBindingGeneration !==
        sessionContext.enterpriseContext.sessionBindingGeneration
    ) {
      return null;
    }
    const message = deepFreeze(SessionInboundMessageSchema.parse(structuredClone(own.message)));
    if (!enterpriseResourceHandlerPolicyForRequestType(message.type)) return null;
    return {
      originalContext: own.sessionContext as EnterpriseDispatchContext,
      originalMessage: own.message as SessionInboundMessage,
      sessionContext,
      message: message as CanonicalHandlerInput["message"],
    };
  } catch {
    return null;
  }
}

function projectionResource(row: EnterpriseOrganizationResourceProjection): GlobalResourceRef {
  let localResourceId: string;
  switch (row.resourceKind) {
    case "workspace":
      localResourceId = row.workspaceId;
      break;
    case "agent":
      localResourceId = row.agentId;
      break;
    case "browser_profile":
      localResourceId = row.browserProfileId;
      break;
    case "app_slot":
      localResourceId = row.appSlotId;
      break;
  }
  return deepFreeze(
    GlobalResourceRefSchema.parse({
      organizationId: row.organizationId,
      nodeId: row.nodeId,
      resourceKind: row.resourceKind,
      localResourceId,
    }),
  );
}

function projectionKey(row: EnterpriseOrganizationResourceProjection): string {
  const resource = projectionResource(row);
  return `${resource.resourceKind}\0${resource.localResourceId}`;
}

function resourceContext(resources: readonly GlobalResourceRef[]): ResourceContext {
  return deepFreeze({ kind: "resources" as const, resources: [...resources] });
}

function uniqueResources(resources: readonly GlobalResourceRef[]): GlobalResourceRef[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.resourceKind}\0${resource.localResourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalResponse<T extends SessionOutboundMessage>(response: T): T {
  return deepFreeze(structuredClone(response));
}

function hasOrganizationAction(principal: PrincipalContext, action: "identity.manage"): boolean {
  return principal.grants.some(
    (grant) =>
      grant.action === action &&
      grant.selector.kind === "organization" &&
      grant.selector.organizationId === principal.organizationId,
  );
}

function strictOwnData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!isObject(value) || Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return null;
    }
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePrincipalAuthority(left: PrincipalContext, right: PrincipalContext): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    JSON.stringify(normalizeResourceGrants(left.grants)) ===
      JSON.stringify(normalizeResourceGrants(right.grants))
  );
}

function sameNodeAuthority(left: NodeContext, right: NodeContext): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.paseoServerId === right.paseoServerId &&
    left.mode === right.mode
  );
}

function sameWorkspaceAuthority(
  left: {
    readonly workspaceId: string;
    readonly organizationId: string;
    readonly nodeId: string;
    readonly ownerPrincipalId: string;
    readonly createdByPrincipalId: string;
  },
  right: {
    readonly workspaceId: string;
    readonly organizationId: string;
    readonly nodeId: string;
    readonly ownerPrincipalId: string;
    readonly createdByPrincipalId: string;
  },
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function sameAuthorityBinding(
  left: AuthoritySessionBindingRecord,
  right: AuthoritySessionBindingRecord,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sessionBindingKey === right.sessionBindingKey &&
    left.sessionBindingGeneration === right.sessionBindingGeneration &&
    left.organizationId === right.organizationId &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType &&
    left.credentialId === right.credentialId &&
    left.grantVersion === right.grantVersion &&
    left.nodeId === right.nodeId &&
    left.clientId === right.clientId
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
