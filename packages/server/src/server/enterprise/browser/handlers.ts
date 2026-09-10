import {
  BrowserProfileBindingProjectionSchema,
  BrowserProfileBindingSchema,
  BrowserProfileRecordSchema,
  EnterpriseBrowserBindProfileRequestSchema,
  EnterpriseBrowserBindProfileResponseSchema,
  EnterpriseBrowserListProfilesRequestSchema,
  EnterpriseBrowserListProfilesResponseSchema,
  EnterpriseResourceAcquireLeaseRequestSchema,
  EnterpriseResourceAcquireLeaseResponseSchema,
  EnterpriseResourceOwnerSchema,
  EnterpriseResourceReleaseLeaseRequestSchema,
  EnterpriseResourceReleaseLeaseResponseSchema,
  EnterpriseResourceRenewLeaseRequestSchema,
  EnterpriseResourceRenewLeaseResponseSchema,
  FencedLeaseSchema,
  GlobalResourceRefSchema,
  projectBrowserProfileSummary,
  type AuthorizedAgent,
  type AuthorizedBrowserProfile,
  type AuthorizedWorkspace,
  type BrowserProfileBinding,
  type BrowserProfileRecord,
  type EnterpriseAction,
  type FencedLease,
  type GlobalResourceRef,
  type PrincipalContext,
  type SessionInboundMessage,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  isEnterpriseAgentContextCurrentForSession,
  normalizeEnterpriseSessionContext,
  type EnterpriseAgentContextHandle,
  type EnterpriseSessionContext,
} from "../../session/enterprise-agent-session-context-registry.js";
import type {
  EnterpriseDispatchContext,
  EnterpriseDispatchResponse,
  EnterpriseDispatchResult,
  EnterpriseSessionDispatcher,
} from "../../session/enterprise-dispatcher.js";
import type {
  BrowserProfileLeaseAcquireInput,
  BrowserProfileLeaseAccessInput,
  BrowserProfileLeaseAuthorization,
  BrowserProfileLeaseRenewInput,
} from "./lease-manager.js";

export interface EnterpriseBrowserProfileReadPort {
  list(): Promise<BrowserProfileRecord[]>;
  get(browserProfileId: string): Promise<BrowserProfileRecord | null>;
}

export interface EnterpriseBrowserProfileBindingPort {
  list(): Promise<BrowserProfileBinding[]>;
  bind(input: {
    workspace: AuthorizedWorkspace;
    profile: AuthorizedBrowserProfile;
    actor: PrincipalContext;
  }): Promise<BrowserProfileBinding>;
}

export interface EnterpriseBrowserLeasePort {
  acquire(input: BrowserProfileLeaseAcquireInput): Promise<FencedLease>;
  renew(input: BrowserProfileLeaseRenewInput): Promise<FencedLease>;
  releaseLease(input: BrowserProfileLeaseAccessInput): Promise<void>;
}

export interface EnterpriseBrowserLeaseAuthorityPort {
  assertWorkspace(
    context: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace>;
  assertBrowserProfile(
    context: PrincipalContext,
    action: EnterpriseAction,
    browserProfileId: string,
  ): Promise<AuthorizedBrowserProfile>;
  resolveAgentHandle(input: {
    sessionContext: EnterpriseSessionContext;
    agentId: string;
  }): EnterpriseAgentContextHandle | null | Promise<EnterpriseAgentContextHandle | null>;
  isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean;
  resolveLeaseAuthorization(
    handle: EnterpriseAgentContextHandle,
  ): BrowserProfileLeaseAuthorization | Promise<BrowserProfileLeaseAuthorization>;
}

export interface EnterpriseBrowserLeaseHandlerOptions {
  profiles: EnterpriseBrowserProfileReadPort;
  bindings: EnterpriseBrowserProfileBindingPort;
  leases: EnterpriseBrowserLeasePort;
  authority: EnterpriseBrowserLeaseAuthorityPort;
  leaseTtlMs: number;
  isCurrentSession?: (context: EnterpriseDispatchContext) => boolean;
}

interface EnterpriseBrowserLeaseHandlerRuntime {
  listProfiles: EnterpriseBrowserProfileReadPort["list"];
  getProfile: EnterpriseBrowserProfileReadPort["get"];
  listBindings: EnterpriseBrowserProfileBindingPort["list"];
  bindProfile: EnterpriseBrowserProfileBindingPort["bind"];
  acquireLease: EnterpriseBrowserLeasePort["acquire"];
  renewLease: EnterpriseBrowserLeasePort["renew"];
  releaseLease: EnterpriseBrowserLeasePort["releaseLease"];
  assertWorkspace: EnterpriseBrowserLeaseAuthorityPort["assertWorkspace"];
  assertBrowserProfile: EnterpriseBrowserLeaseAuthorityPort["assertBrowserProfile"];
  resolveAgentHandle: EnterpriseBrowserLeaseAuthorityPort["resolveAgentHandle"];
  isCurrentHandle: EnterpriseBrowserLeaseAuthorityPort["isCurrentHandle"];
  resolveLeaseAuthorization: EnterpriseBrowserLeaseAuthorityPort["resolveLeaseAuthorization"];
  isCurrentSession: (context: EnterpriseDispatchContext) => boolean;
  leaseTtlMs: number;
}

type BrowserResourceRequestType =
  | "enterprise.browser.list_profiles.request"
  | "enterprise.browser.bind_profile.request"
  | "enterprise.resource.acquire_lease.request"
  | "enterprise.resource.renew_lease.request"
  | "enterprise.resource.release_lease.request";

interface BrowserResourceResult {
  readonly response: SessionOutboundMessage;
  readonly requestType: BrowserResourceRequestType;
  readonly requestId: string;
  readonly resources: GlobalResourceRef[];
}

interface PendingBrowserResponse extends BrowserResourceResult {
  readonly context: EnterpriseDispatchContext;
  readonly message: SessionInboundMessage;
}

interface BrowserHandlerIdentity {
  readonly originalContext: EnterpriseDispatchContext;
  readonly originalMessage: SessionInboundMessage;
  readonly sessionContext: EnterpriseDispatchContext;
}

interface HeldBrowserLease {
  readonly handle: EnterpriseAgentContextHandle;
  authorization: BrowserProfileLeaseAuthorization;
  lease: FencedLease;
  released: boolean;
}

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();

const AuthorizedAgentSchema = EnterpriseResourceOwnerSchema.extend({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();

const LeaseAuthorizationSchema = z
  .object({
    workspace: AuthorizedWorkspaceSchema,
    agent: AuthorizedAgentSchema,
    profile: BrowserProfileRecordSchema.strict(),
    bindingRevision: z.string().min(1),
  })
  .strict();

const StrictListProfilesResponseSchema = EnterpriseBrowserListProfilesResponseSchema.extend({
  payload: EnterpriseBrowserListProfilesResponseSchema.shape.payload.strict(),
}).strict();

const StrictBindProfileResponseSchema = EnterpriseBrowserBindProfileResponseSchema.extend({
  payload: EnterpriseBrowserBindProfileResponseSchema.shape.payload.strict(),
}).strict();

const StrictListProfilesRequestSchema = EnterpriseBrowserListProfilesRequestSchema.strict();
const StrictBindProfileRequestSchema = EnterpriseBrowserBindProfileRequestSchema.strict();
const StrictAcquireLeaseRequestSchema = EnterpriseResourceAcquireLeaseRequestSchema.strict();
const StrictRenewLeaseRequestSchema = EnterpriseResourceRenewLeaseRequestSchema.strict();
const StrictReleaseLeaseRequestSchema = EnterpriseResourceReleaseLeaseRequestSchema.strict();

const StrictAcquireLeaseResponseSchema = EnterpriseResourceAcquireLeaseResponseSchema.extend({
  payload: EnterpriseResourceAcquireLeaseResponseSchema.shape.payload.strict(),
}).strict();

const StrictRenewLeaseResponseSchema = EnterpriseResourceRenewLeaseResponseSchema.extend({
  payload: EnterpriseResourceRenewLeaseResponseSchema.shape.payload.strict(),
}).strict();

const StrictReleaseLeaseResponseSchema = EnterpriseResourceReleaseLeaseResponseSchema.extend({
  payload: EnterpriseResourceReleaseLeaseResponseSchema.shape.payload.strict(),
}).strict();

const W4_REQUEST_TYPES = new Set<string>([
  "enterprise.browser.list_profiles.request",
  "enterprise.browser.bind_profile.request",
  "enterprise.resource.acquire_lease.request",
  "enterprise.resource.renew_lease.request",
  "enterprise.resource.release_lease.request",
]);

const ENTERPRISE_RESOURCE_UNAVAILABLE = "Enterprise resource unavailable";

export class EnterpriseBrowserLeaseHandler implements EnterpriseSessionDispatcher {
  private readonly runtime: EnterpriseBrowserLeaseHandlerRuntime;
  private readonly heldLeases = new Map<string, HeldBrowserLease>();
  private readonly issued = new WeakMap<object, PendingBrowserResponse>();
  private readonly pending = new Set<PendingBrowserResponse>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  public requestPolicyForType(type: string): "resources" | null {
    return W4_REQUEST_TYPES.has(type) ? "resources" : null;
  }

  public constructor(options: EnterpriseBrowserLeaseHandlerOptions) {
    const profiles = options.profiles;
    const bindings = options.bindings;
    const leases = options.leases;
    const authority = options.authority;
    const leaseTtlMs = options.leaseTtlMs;
    const listProfiles = profiles.list;
    const getProfile = profiles.get;
    const listBindings = bindings.list;
    const bindProfile = bindings.bind;
    const acquireLease = leases.acquire;
    const renewLease = leases.renew;
    const releaseLease = leases.releaseLease;
    const assertWorkspace = authority.assertWorkspace;
    const assertBrowserProfile = authority.assertBrowserProfile;
    const resolveAgentHandle = authority.resolveAgentHandle;
    const isCurrentHandle = authority.isCurrentHandle;
    const resolveLeaseAuthorization = authority.resolveLeaseAuthorization;
    const isCurrentSession = options.isCurrentSession ?? (() => true);
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new Error("Browser lease handler TTL must be a positive safe integer.");
    }
    if (typeof isCurrentSession !== "function") {
      throw new Error("Browser lease handler current-session check is invalid.");
    }
    this.runtime = Object.freeze({
      listProfiles: listProfiles.bind(profiles),
      getProfile: getProfile.bind(profiles),
      listBindings: listBindings.bind(bindings),
      bindProfile: bindProfile.bind(bindings),
      acquireLease: acquireLease.bind(leases),
      renewLease: renewLease.bind(leases),
      releaseLease: releaseLease.bind(leases),
      assertWorkspace: assertWorkspace.bind(authority),
      assertBrowserProfile: assertBrowserProfile.bind(authority),
      resolveAgentHandle: resolveAgentHandle.bind(authority),
      isCurrentHandle: isCurrentHandle.bind(authority),
      resolveLeaseAuthorization: resolveLeaseAuthorization.bind(authority),
      isCurrentSession,
      leaseTtlMs,
    });
  }

  public async handle(input: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
  }): Promise<EnterpriseDispatchResult> {
    const originalContext = input.sessionContext;
    const originalMessage = input.message;
    let message: SessionInboundMessage;
    let type: string;
    try {
      message = input.message;
      type = message.type;
    } catch {
      return false;
    }
    if (!W4_REQUEST_TYPES.has(type)) return false;
    if (this.closed) return false;
    let sessionContext: EnterpriseDispatchContext;
    try {
      sessionContext = snapshotDispatchContext(input.sessionContext);
    } catch {
      return false;
    }
    if (!this.isCurrentSession(originalContext)) return false;
    switch (type) {
      case "enterprise.browser.list_profiles.request":
        return this.handleListProfiles(
          { originalContext, originalMessage, sessionContext },
          message,
          type,
        );
      case "enterprise.browser.bind_profile.request":
        return this.handleBindProfile(
          { originalContext, originalMessage, sessionContext },
          message,
          type,
        );
      case "enterprise.resource.acquire_lease.request":
        return this.handleAcquireLease(
          { originalContext, originalMessage, sessionContext },
          message,
          type,
        );
      case "enterprise.resource.renew_lease.request":
        return this.handleRenewLease(
          { originalContext, originalMessage, sessionContext },
          message,
          type,
        );
      case "enterprise.resource.release_lease.request":
        return this.handleReleaseLease(
          { originalContext, originalMessage, sessionContext },
          message,
          type,
        );
      default:
        return false;
    }
  }

  public consumeResponse({
    sessionContext,
    message,
    response,
  }: {
    readonly sessionContext: EnterpriseDispatchContext;
    readonly message: SessionInboundMessage;
    readonly response: SessionOutboundMessage;
  }): EnterpriseDispatchResponse | null {
    if (!isObject(response)) return null;
    const issued = this.issued.get(response);
    if (!issued) return null;
    this.issued.delete(response);
    this.pending.delete(issued);
    if (
      issued.context !== sessionContext ||
      issued.message !== message ||
      issued.response !== response ||
      !this.isCurrentSession(sessionContext) ||
      !matchesPendingBrowserResponseSchema(issued, message, response)
    ) {
      return null;
    }
    return deepFreeze({
      response: issued.response,
      authorizationContext: {
        kind: "resources",
        resources: issued.resources,
      },
      receiptClassification: "resources",
    });
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const issued of this.pending) this.issued.delete(issued.response);
    this.pending.clear();
    const held = [...this.heldLeases.values()];
    this.heldLeases.clear();
    this.closePromise = (async () => {
      const failures: unknown[] = [];
      await Promise.all(
        held.map(async (lease) => {
          try {
            await this.releaseHeldLease(lease, true);
          } catch (error) {
            failures.push(error);
          }
        }),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Enterprise browser lease handler close failed.");
      }
    })();
    return this.closePromise;
  }

  private async handleListProfiles(
    input: BrowserHandlerIdentity,
    message: SessionInboundMessage,
    type: "enterprise.browser.list_profiles.request",
  ): Promise<EnterpriseDispatchResult> {
    let request: z.infer<typeof EnterpriseBrowserListProfilesRequestSchema>;
    try {
      request = snapshotListProfilesRequest(message, type);
    } catch {
      return false;
    }
    try {
      const result = await this.listAuthorizedProfiles(input, request);
      return this.issuePending(input, result);
    } catch {
      return denied(request.type, request.requestId);
    }
  }

  private async handleBindProfile(
    input: BrowserHandlerIdentity,
    message: SessionInboundMessage,
    type: "enterprise.browser.bind_profile.request",
  ): Promise<EnterpriseDispatchResult> {
    let request: z.infer<typeof EnterpriseBrowserBindProfileRequestSchema>;
    try {
      request = snapshotBindProfileRequest(message, type);
    } catch {
      return false;
    }
    try {
      const result = await this.bindAuthorizedProfile(input, request);
      return this.issuePending(input, result);
    } catch {
      return denied(request.type, request.requestId);
    }
  }

  private async handleAcquireLease(
    input: BrowserHandlerIdentity,
    message: SessionInboundMessage,
    type: "enterprise.resource.acquire_lease.request",
  ): Promise<EnterpriseDispatchResult> {
    let request: z.infer<typeof EnterpriseResourceAcquireLeaseRequestSchema>;
    try {
      request = snapshotAcquireLeaseRequest(message, type);
    } catch {
      return false;
    }
    if (request.resourceKind !== "browser_profile") return false;
    let held: HeldBrowserLease | null = null;
    try {
      const handle = await this.runtime.resolveAgentHandle({
        sessionContext: input.sessionContext.enterpriseContext,
        agentId: request.agentId,
      });
      this.assertCurrentSessionHandle(handle, input.sessionContext.enterpriseContext);
      if (handle.agentId !== request.agentId) {
        throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      }
      const authorization = await this.resolveCurrentAuthorization(handle);
      this.assertCurrentSessionHandle(handle, input.sessionContext.enterpriseContext);
      assertAuthorizationMatchesAcquire(handle, authorization, request);
      const acquired = snapshotLease(
        await this.runtime.acquireLease({
          handle,
          resourceId: authorization.profile.browserProfileId,
          mode: request.mode,
          ttlMs: this.runtime.leaseTtlMs,
        }),
      );
      held = { handle, authorization, lease: acquired, released: false };
      this.assertCurrentSessionHandle(handle, input.sessionContext.enterpriseContext);
      const currentAuthorization = await this.resolveCurrentAuthorization(handle);
      this.assertCurrentSessionHandle(handle, input.sessionContext.enterpriseContext);
      if (!sameAuthorization(authorization, currentAuthorization)) {
        throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      }
      assertLeaseMatchesAuthorization(acquired, handle, currentAuthorization, request.mode);
      held.authorization = currentAuthorization;
      if (this.closed) throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      if (this.heldLeases.has(acquired.leaseId)) {
        throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      }
      this.heldLeases.set(acquired.leaseId, held);
      const result = leaseResourceResult({
        response: StrictAcquireLeaseResponseSchema.parse({
          type: "enterprise.resource.acquire_lease.response",
          payload: { requestId: request.requestId, lease: acquired, waiting: false },
        }),
        requestType: request.type,
        requestId: request.requestId,
        authorization: currentAuthorization,
      });
      const response = this.issuePending(input, result);
      if (response === false) await this.releaseHeldLease(held);
      return response;
    } catch {
      if (held) await this.releaseHeldLease(held);
      return denied(request.type, request.requestId);
    }
  }

  private async handleRenewLease(
    input: BrowserHandlerIdentity,
    message: SessionInboundMessage,
    type: "enterprise.resource.renew_lease.request",
  ): Promise<EnterpriseDispatchResult> {
    let request: z.infer<typeof EnterpriseResourceRenewLeaseRequestSchema>;
    try {
      request = snapshotRenewLeaseRequest(message, type);
    } catch {
      return false;
    }
    const held = this.heldLeases.get(request.leaseId);
    if (!held) return false;
    const expectedMode = held.lease.mode;
    let didRenew = false;
    try {
      this.assertHeldLeaseRequest(
        held,
        input.sessionContext.enterpriseContext,
        request.fencingToken,
      );
      const renewed = snapshotLease(
        await this.runtime.renewLease({
          handle: held.handle,
          lease: held.lease,
          ttlMs: this.runtime.leaseTtlMs,
        }),
      );
      held.lease = renewed;
      didRenew = true;
      this.assertCurrentSessionHandle(held.handle, input.sessionContext.enterpriseContext);
      const authorization = await this.resolveCurrentAuthorization(held.handle);
      this.assertCurrentSessionHandle(held.handle, input.sessionContext.enterpriseContext);
      if (!sameAuthorization(held.authorization, authorization)) {
        throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      }
      assertLeaseMatchesAuthorization(renewed, held.handle, authorization, expectedMode);
      held.authorization = authorization;
      const result = leaseResourceResult({
        response: StrictRenewLeaseResponseSchema.parse({
          type: "enterprise.resource.renew_lease.response",
          payload: { requestId: request.requestId, lease: renewed },
        }),
        requestType: request.type,
        requestId: request.requestId,
        authorization,
      });
      const response = this.issuePending(input, result);
      if (response === false) await this.releaseHeldLease(held);
      return response;
    } catch {
      if (didRenew) await this.releaseHeldLease(held);
      return denied(request.type, request.requestId);
    }
  }

  private async handleReleaseLease(
    input: BrowserHandlerIdentity,
    message: SessionInboundMessage,
    type: "enterprise.resource.release_lease.request",
  ): Promise<EnterpriseDispatchResult> {
    let request: z.infer<typeof EnterpriseResourceReleaseLeaseRequestSchema>;
    try {
      request = snapshotReleaseLeaseRequest(message, type);
    } catch {
      return false;
    }
    const held = this.heldLeases.get(request.leaseId);
    if (!held) return false;
    try {
      this.assertHeldLeaseRequest(
        held,
        input.sessionContext.enterpriseContext,
        request.fencingToken,
      );
      const authorization = await this.resolveCurrentAuthorization(held.handle);
      this.assertCurrentSessionHandle(held.handle, input.sessionContext.enterpriseContext);
      if (!sameAuthorization(held.authorization, authorization)) {
        throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
      }
      assertLeaseMatchesAuthorization(held.lease, held.handle, authorization, held.lease.mode);
      held.released = true;
      this.heldLeases.delete(held.lease.leaseId);
      await this.runtime.releaseLease({ handle: held.handle, lease: held.lease });
      return this.issuePending(
        input,
        leaseResourceResult({
          response: StrictReleaseLeaseResponseSchema.parse({
            type: "enterprise.resource.release_lease.response",
            payload: { requestId: request.requestId, released: true },
          }),
          requestType: request.type,
          requestId: request.requestId,
          authorization,
        }),
      );
    } catch {
      return denied(request.type, request.requestId);
    }
  }

  private async listAuthorizedProfiles(
    input: BrowserHandlerIdentity,
    request: z.infer<typeof EnterpriseBrowserListProfilesRequestSchema>,
  ): Promise<BrowserResourceResult> {
    const sessionContext = input.sessionContext;
    const principal = sessionContext.enterpriseContext.principal;
    const workspace = snapshotWorkspace(
      await this.runtime.assertWorkspace(principal, "workspace.metadata.read", request.workspaceId),
    );
    this.assertCurrentSession(input.originalContext);
    const records = (await this.runtime.listProfiles()).map(snapshotProfile);
    this.assertCurrentSession(input.originalContext);
    const visibleProfiles: AuthorizedBrowserProfile[] = [];
    for (const record of records) {
      if (!profileMatchesWorkspace(record, workspace)) continue;
      for (const action of ["browser.use", "browser.profile.manage"] as const) {
        try {
          const authorized = snapshotProfile(
            await this.runtime.assertBrowserProfile(principal, action, record.browserProfileId),
          );
          this.assertCurrentSession(input.originalContext);
          if (sameProfile(record, authorized)) visibleProfiles.push(authorized);
          break;
        } catch {
          // Discovery is a filter; one invisible record cannot reveal itself.
        }
      }
    }
    visibleProfiles.sort((left, right) =>
      left.browserProfileId.localeCompare(right.browserProfileId),
    );
    const visibleProfileIds = new Set(visibleProfiles.map((profile) => profile.browserProfileId));
    const bindings = (await this.runtime.listBindings())
      .map(snapshotBinding)
      .filter(
        (binding) =>
          binding.organizationId === workspace.organizationId &&
          binding.nodeId === workspace.nodeId &&
          binding.workspaceId === workspace.workspaceId &&
          visibleProfileIds.has(binding.browserProfileId),
      )
      .sort((left, right) => left.browserProfileId.localeCompare(right.browserProfileId))
      .map((binding) =>
        BrowserProfileBindingProjectionSchema.parse({
          organizationId: binding.organizationId,
          nodeId: binding.nodeId,
          workspaceId: binding.workspaceId,
          browserProfileId: binding.browserProfileId,
          boundAt: binding.boundAt,
        }),
      );
    this.assertCurrentSession(input.originalContext);
    const currentWorkspace = snapshotWorkspace(
      await this.runtime.assertWorkspace(principal, "workspace.metadata.read", request.workspaceId),
    );
    this.assertCurrentSession(input.originalContext);
    if (!sameWorkspace(workspace, currentWorkspace)) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    const response = deepFreeze(
      StrictListProfilesResponseSchema.parse({
        type: "enterprise.browser.list_profiles.response",
        payload: {
          requestId: request.requestId,
          profiles: visibleProfiles.map(projectBrowserProfileSummary),
          bindings,
        },
      }),
    );
    const resources = deepFreeze([
      workspaceResourceRef(workspace),
      ...visibleProfiles.map(browserProfileResourceRef),
    ]);
    return deepFreeze({
      response,
      requestType: request.type,
      requestId: request.requestId,
      resources,
    });
  }

  private async bindAuthorizedProfile(
    input: BrowserHandlerIdentity,
    request: z.infer<typeof EnterpriseBrowserBindProfileRequestSchema>,
  ): Promise<BrowserResourceResult> {
    const sessionContext = input.sessionContext;
    const principal = sessionContext.enterpriseContext.principal;
    const workspace = snapshotWorkspace(
      await this.runtime.assertWorkspace(principal, "workspace.metadata.read", request.workspaceId),
    );
    this.assertCurrentSession(input.originalContext);
    const authorizedProfile = snapshotProfile(
      await this.runtime.assertBrowserProfile(
        principal,
        "browser.profile.manage",
        request.browserProfileId,
      ),
    );
    this.assertCurrentSession(input.originalContext);
    const registryProfile = await this.runtime.getProfile(authorizedProfile.browserProfileId);
    this.assertCurrentSession(input.originalContext);
    if (!registryProfile || !sameProfile(authorizedProfile, snapshotProfile(registryProfile))) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    if (!profileMatchesWorkspace(authorizedProfile, workspace)) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    const currentWorkspace = snapshotWorkspace(
      await this.runtime.assertWorkspace(principal, "workspace.metadata.read", request.workspaceId),
    );
    this.assertCurrentSession(input.originalContext);
    const currentProfile = snapshotProfile(
      await this.runtime.assertBrowserProfile(
        principal,
        "browser.profile.manage",
        request.browserProfileId,
      ),
    );
    this.assertCurrentSession(input.originalContext);
    if (
      !sameWorkspace(workspace, currentWorkspace) ||
      !sameProfile(authorizedProfile, currentProfile)
    ) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    const bound = snapshotBinding(
      await this.runtime.bindProfile({
        workspace,
        profile: authorizedProfile,
        actor: principal,
      }),
    );
    this.assertCurrentSession(input.originalContext);
    const postBindWorkspace = snapshotWorkspace(
      await this.runtime.assertWorkspace(principal, "workspace.metadata.read", request.workspaceId),
    );
    this.assertCurrentSession(input.originalContext);
    const postBindProfile = snapshotProfile(
      await this.runtime.assertBrowserProfile(
        principal,
        "browser.profile.manage",
        request.browserProfileId,
      ),
    );
    this.assertCurrentSession(input.originalContext);
    if (
      !sameWorkspace(workspace, postBindWorkspace) ||
      !sameProfile(authorizedProfile, postBindProfile) ||
      !bindingMatchesWorkspaceProfile(bound, workspace, authorizedProfile)
    ) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    const response = deepFreeze(
      StrictBindProfileResponseSchema.parse({
        type: "enterprise.browser.bind_profile.response",
        payload: {
          requestId: request.requestId,
          binding: {
            organizationId: bound.organizationId,
            nodeId: bound.nodeId,
            workspaceId: bound.workspaceId,
            browserProfileId: bound.browserProfileId,
            boundAt: bound.boundAt,
          },
        },
      }),
    );
    const resources = deepFreeze([
      workspaceResourceRef(postBindWorkspace),
      browserProfileResourceRef(postBindProfile),
    ]);
    return deepFreeze({
      response,
      requestType: request.type,
      requestId: request.requestId,
      resources,
    });
  }

  private issuePending(
    input: BrowserHandlerIdentity,
    result: BrowserResourceResult,
  ): SessionOutboundMessage | false {
    if (!this.isCurrentSession(input.originalContext)) return false;
    const pending = Object.freeze({
      ...result,
      context: input.originalContext,
      message: input.originalMessage,
    });
    this.issued.set(result.response, pending);
    this.pending.add(pending);
    return result.response;
  }

  private assertCurrentSession(context: EnterpriseDispatchContext): void {
    if (!this.isCurrentSession(context)) throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }

  private isCurrentSession(context: EnterpriseDispatchContext): boolean {
    try {
      return !this.closed && this.runtime.isCurrentSession(context) === true;
    } catch {
      return false;
    }
  }

  private async resolveCurrentAuthorization(
    handle: EnterpriseAgentContextHandle,
  ): Promise<BrowserProfileLeaseAuthorization> {
    if (!this.isCurrentHandle(handle)) throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    const authorization = snapshotLeaseAuthorization(
      await this.runtime.resolveLeaseAuthorization(handle),
    );
    if (!this.isCurrentHandle(handle)) throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    assertAuthorizationMatchesHandle(handle, authorization);
    return authorization;
  }

  private assertCurrentSessionHandle(
    handle: EnterpriseAgentContextHandle | null,
    sessionContext: EnterpriseSessionContext,
  ): asserts handle is EnterpriseAgentContextHandle {
    if (!handle || !this.isCurrentHandle(handle)) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    let matchesSession = false;
    try {
      matchesSession = isEnterpriseAgentContextCurrentForSession(handle, sessionContext);
    } catch {
      matchesSession = false;
    }
    if (!matchesSession) throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }

  private assertHeldLeaseRequest(
    held: HeldBrowserLease,
    sessionContext: EnterpriseSessionContext,
    fencingToken: number,
  ): void {
    if (this.closed || held.released || held.lease.fencingToken !== fencingToken) {
      throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
    }
    this.assertCurrentSessionHandle(held.handle, sessionContext);
  }

  private isCurrentHandle(handle: EnterpriseAgentContextHandle): boolean {
    try {
      return this.runtime.isCurrentHandle(handle) === true;
    } catch {
      return false;
    }
  }

  private async releaseHeldLease(held: HeldBrowserLease, propagateError = false): Promise<void> {
    if (held.released) return;
    held.released = true;
    if (this.heldLeases.get(held.lease.leaseId) === held) {
      this.heldLeases.delete(held.lease.leaseId);
    }
    try {
      await this.runtime.releaseLease({ handle: held.handle, lease: held.lease });
    } catch (error) {
      // The authorization failure remains primary; the manager owns release diagnostics.
      if (propagateError) throw error;
    }
  }
}

function snapshotDispatchContext(input: EnterpriseDispatchContext): EnterpriseDispatchContext {
  const sessionId = input.sessionId;
  const clientId = input.clientId;
  const credentialId = input.credentialId;
  const sessionBindingGeneration = input.sessionBindingGeneration;
  const enterpriseContext = normalizeEnterpriseSessionContext(input.enterpriseContext);
  if (
    !sessionId ||
    !clientId ||
    credentialId !== enterpriseContext.principal.credentialId ||
    sessionBindingGeneration !== enterpriseContext.sessionBindingGeneration
  ) {
    throw new Error("Invalid enterprise dispatch context.");
  }
  return Object.freeze({
    sessionId,
    clientId,
    credentialId,
    sessionBindingGeneration,
    enterpriseContext,
  });
}

function snapshotListProfilesRequest(
  message: SessionInboundMessage,
  type: "enterprise.browser.list_profiles.request",
): z.infer<typeof EnterpriseBrowserListProfilesRequestSchema> {
  const request = message as Extract<SessionInboundMessage, { type: typeof type }>;
  const requestId = request.requestId;
  const workspaceId = request.workspaceId;
  return EnterpriseBrowserListProfilesRequestSchema.parse({ type, requestId, workspaceId });
}

function snapshotBindProfileRequest(
  message: SessionInboundMessage,
  type: "enterprise.browser.bind_profile.request",
): z.infer<typeof EnterpriseBrowserBindProfileRequestSchema> {
  const request = message as Extract<SessionInboundMessage, { type: typeof type }>;
  const requestId = request.requestId;
  const workspaceId = request.workspaceId;
  const browserProfileId = request.browserProfileId;
  return EnterpriseBrowserBindProfileRequestSchema.parse({
    type,
    requestId,
    workspaceId,
    browserProfileId,
  });
}

function snapshotAcquireLeaseRequest(
  message: SessionInboundMessage,
  type: "enterprise.resource.acquire_lease.request",
): z.infer<typeof EnterpriseResourceAcquireLeaseRequestSchema> {
  const request = message as Extract<SessionInboundMessage, { type: typeof type }>;
  const requestId = request.requestId;
  const workspaceId = request.workspaceId;
  const agentId = request.agentId;
  const resourceKind = request.resourceKind;
  const mode = request.mode;
  return EnterpriseResourceAcquireLeaseRequestSchema.parse({
    type,
    requestId,
    workspaceId,
    agentId,
    resourceKind,
    mode,
  });
}

function snapshotRenewLeaseRequest(
  message: SessionInboundMessage,
  type: "enterprise.resource.renew_lease.request",
): z.infer<typeof EnterpriseResourceRenewLeaseRequestSchema> {
  const request = message as Extract<SessionInboundMessage, { type: typeof type }>;
  const requestId = request.requestId;
  const leaseId = request.leaseId;
  const fencingToken = request.fencingToken;
  return EnterpriseResourceRenewLeaseRequestSchema.parse({
    type,
    requestId,
    leaseId,
    fencingToken,
  });
}

function snapshotReleaseLeaseRequest(
  message: SessionInboundMessage,
  type: "enterprise.resource.release_lease.request",
): z.infer<typeof EnterpriseResourceReleaseLeaseRequestSchema> {
  const request = message as Extract<SessionInboundMessage, { type: typeof type }>;
  const requestId = request.requestId;
  const leaseId = request.leaseId;
  const fencingToken = request.fencingToken;
  return EnterpriseResourceReleaseLeaseRequestSchema.parse({
    type,
    requestId,
    leaseId,
    fencingToken,
  });
}

function snapshotWorkspace(input: AuthorizedWorkspace): AuthorizedWorkspace {
  return AuthorizedWorkspaceSchema.parse(structuredClone(input));
}

function snapshotProfile(input: BrowserProfileRecord): AuthorizedBrowserProfile {
  return BrowserProfileRecordSchema.strict().parse(structuredClone(input));
}

function snapshotBinding(input: BrowserProfileBinding): BrowserProfileBinding {
  return BrowserProfileBindingSchema.strict().parse(structuredClone(input));
}

function snapshotLease(input: FencedLease): FencedLease {
  return FencedLeaseSchema.parse(structuredClone(input));
}

function snapshotLeaseAuthorization(
  input: BrowserProfileLeaseAuthorization,
): BrowserProfileLeaseAuthorization {
  return LeaseAuthorizationSchema.parse(structuredClone(input));
}

function profileMatchesWorkspace(
  profile: AuthorizedBrowserProfile,
  workspace: AuthorizedWorkspace,
): boolean {
  return (
    profile.organizationId === workspace.organizationId &&
    profile.homeNodeId === workspace.nodeId &&
    profile.ownerPrincipalId === workspace.ownerPrincipalId
  );
}

function sameWorkspace(left: AuthorizedWorkspace, right: AuthorizedWorkspace): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function sameAgent(left: AuthorizedAgent, right: AuthorizedAgent): boolean {
  return (
    left.agentId === right.agentId &&
    left.workspaceId === right.workspaceId &&
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function sameProfile(left: AuthorizedBrowserProfile, right: AuthorizedBrowserProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingMatchesWorkspaceProfile(
  binding: BrowserProfileBinding,
  workspace: AuthorizedWorkspace,
  profile: AuthorizedBrowserProfile,
): boolean {
  return (
    binding.organizationId === workspace.organizationId &&
    binding.nodeId === workspace.nodeId &&
    binding.workspaceId === workspace.workspaceId &&
    binding.browserProfileId === profile.browserProfileId
  );
}

function assertAuthorizationMatchesHandle(
  handle: EnterpriseAgentContextHandle,
  authorization: BrowserProfileLeaseAuthorization,
): void {
  const principal = handle.context.principal;
  const node = handle.context.node;
  const expectedAgent: AuthorizedAgent = {
    ...authorization.workspace,
    agentId: authorization.agent.agentId,
    workspaceId: authorization.workspace.workspaceId,
  };
  if (
    authorization.agent.agentId !== handle.agentId ||
    authorization.workspace.organizationId !== principal.organizationId ||
    authorization.agent.organizationId !== principal.organizationId ||
    authorization.profile.organizationId !== principal.organizationId ||
    authorization.workspace.nodeId !== node.nodeId ||
    authorization.agent.nodeId !== node.nodeId ||
    authorization.profile.homeNodeId !== node.nodeId ||
    !sameAgent(authorization.agent, expectedAgent) ||
    !profileMatchesWorkspace(authorization.profile, authorization.workspace)
  ) {
    throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }
}

function assertAuthorizationMatchesAcquire(
  handle: EnterpriseAgentContextHandle,
  authorization: BrowserProfileLeaseAuthorization,
  request: z.infer<typeof EnterpriseResourceAcquireLeaseRequestSchema>,
): void {
  assertAuthorizationMatchesHandle(handle, authorization);
  if (
    authorization.workspace.workspaceId !== request.workspaceId ||
    authorization.agent.agentId !== request.agentId ||
    authorization.profile.status !== "ready"
  ) {
    throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }
}

function sameAuthorization(
  left: BrowserProfileLeaseAuthorization,
  right: BrowserProfileLeaseAuthorization,
): boolean {
  return (
    left.bindingRevision === right.bindingRevision &&
    sameWorkspace(left.workspace, right.workspace) &&
    sameAgent(left.agent, right.agent) &&
    sameProfile(left.profile, right.profile)
  );
}

function assertLeaseMatchesAuthorization(
  lease: FencedLease,
  handle: EnterpriseAgentContextHandle,
  authorization: BrowserProfileLeaseAuthorization,
  mode: "read" | "write",
): void {
  if (
    lease.resourceKind !== "browser_profile" ||
    lease.resourceId !== authorization.profile.browserProfileId ||
    lease.organizationId !== authorization.workspace.organizationId ||
    lease.nodeId !== authorization.workspace.nodeId ||
    lease.businessIdentityId !== authorization.profile.businessIdentityId ||
    lease.holderPrincipalId !== handle.context.principal.principalId ||
    lease.holderAgentId !== authorization.agent.agentId ||
    lease.mode !== mode
  ) {
    throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }
}

function matchesPendingBrowserResponseSchema(
  issued: PendingBrowserResponse,
  message: SessionInboundMessage,
  response: SessionOutboundMessage,
): boolean {
  try {
    switch (issued.requestType) {
      case "enterprise.browser.list_profiles.request":
        return (
          StrictListProfilesRequestSchema.parse(message).requestId === issued.requestId &&
          StrictListProfilesResponseSchema.parse(response).payload.requestId === issued.requestId
        );
      case "enterprise.browser.bind_profile.request":
        return (
          StrictBindProfileRequestSchema.parse(message).requestId === issued.requestId &&
          StrictBindProfileResponseSchema.parse(response).payload.requestId === issued.requestId
        );
      case "enterprise.resource.acquire_lease.request":
        return (
          StrictAcquireLeaseRequestSchema.parse(message).requestId === issued.requestId &&
          StrictAcquireLeaseResponseSchema.parse(response).payload.requestId === issued.requestId
        );
      case "enterprise.resource.renew_lease.request":
        return (
          StrictRenewLeaseRequestSchema.parse(message).requestId === issued.requestId &&
          StrictRenewLeaseResponseSchema.parse(response).payload.requestId === issued.requestId
        );
      case "enterprise.resource.release_lease.request":
        return (
          StrictReleaseLeaseRequestSchema.parse(message).requestId === issued.requestId &&
          StrictReleaseLeaseResponseSchema.parse(response).payload.requestId === issued.requestId
        );
    }
  } catch {
    return false;
  }
}

function leaseResourceResult(input: {
  response: SessionOutboundMessage;
  requestType:
    | "enterprise.resource.acquire_lease.request"
    | "enterprise.resource.renew_lease.request"
    | "enterprise.resource.release_lease.request";
  requestId: string;
  authorization: BrowserProfileLeaseAuthorization;
}): BrowserResourceResult {
  const resources = deepFreeze([
    workspaceResourceRef(input.authorization.workspace),
    agentResourceRef(input.authorization.agent),
    browserProfileResourceRef(input.authorization.profile),
  ]);
  return deepFreeze({
    response: deepFreeze(input.response),
    requestType: input.requestType,
    requestId: input.requestId,
    resources,
  });
}

const GLOBAL_RESOURCE_REF_KEYS = new Set([
  "organizationId",
  "nodeId",
  "resourceKind",
  "localResourceId",
]);

function workspaceResourceRef(workspace: AuthorizedWorkspace): GlobalResourceRef {
  return strictResourceRef({
    organizationId: workspace.organizationId,
    nodeId: workspace.nodeId,
    resourceKind: "workspace",
    localResourceId: workspace.workspaceId,
  });
}

function agentResourceRef(agent: AuthorizedAgent): GlobalResourceRef {
  return strictResourceRef({
    organizationId: agent.organizationId,
    nodeId: agent.nodeId,
    resourceKind: "agent",
    localResourceId: agent.agentId,
  });
}

function browserProfileResourceRef(profile: AuthorizedBrowserProfile): GlobalResourceRef {
  return strictResourceRef({
    organizationId: profile.organizationId,
    nodeId: profile.homeNodeId,
    resourceKind: "browser_profile",
    localResourceId: profile.browserProfileId,
  });
}

function strictResourceRef(input: GlobalResourceRef): GlobalResourceRef {
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== GLOBAL_RESOURCE_REF_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !GLOBAL_RESOURCE_REF_KEYS.has(key))
  ) {
    throw new Error(ENTERPRISE_RESOURCE_UNAVAILABLE);
  }
  return deepFreeze(GlobalResourceRefSchema.parse(structuredClone(input)));
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function deepFreeze<T>(value: T): T {
  if (isObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const child = Reflect.get(value, key);
      if (isObject(child)) deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function denied(requestType: string, requestId: string): EnterpriseDispatchResult {
  return {
    type: "rpc_error",
    payload: {
      requestId,
      requestType,
      error: ENTERPRISE_RESOURCE_UNAVAILABLE,
      code: "access_denied",
    },
  };
}
