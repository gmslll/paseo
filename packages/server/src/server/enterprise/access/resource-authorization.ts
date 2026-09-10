import {
  normalizeEnterpriseResourceOwner,
  type AppSlotRecord,
  type AuthorizedAgent,
  type AuthorizedAppSlot,
  type AuthorizedBrowserProfile,
  type AuthorizedWorkspace,
  type BrowserProfileRecord,
  type EnterpriseAction,
  type EnterpriseWorkspaceAuthorizationRecord,
  type GlobalResourceRef,
  type PrincipalContext,
  type ResourceGrant,
  type SessionOutboundMessage,
  type OutboundAuthorizationContext,
  OutboundAuthorizationContextSchema,
  type ResourceAuthorization as ResourceAuthorizationContract,
} from "@getpaseo/protocol/messages";
import type { OwnerRegistry } from "./owner-registry.js";
import type { GrantStore } from "./grant-store.js";
import { isMatchingTransportControl, outboundActionsFor } from "./event-action-map.js";
import type { OutboundAuthorityVerifier } from "./authority-receipt-verifier.js";

export interface BrowserProfileRegistry {
  get(browserProfileId: string): Promise<BrowserProfileRecord | null>;
}

export interface AppSlotRegistry {
  get(appSlotId: string): Promise<AppSlotRecord | null>;
}

export interface WorkspacePathRegistry {
  resolve(workspace: AuthorizedWorkspace, requestedPath: string): Promise<string | null>;
}

export interface OwnerAuthorizationRegistry {
  getWorkspace(workspaceId: string): ReturnType<OwnerRegistry["getWorkspace"]>;
  getAgent(agentId: string): ReturnType<OwnerRegistry["getAgent"]>;
}

export interface ResourceAuthorizationDependencies {
  owners: OwnerAuthorizationRegistry;
  browserProfiles?: BrowserProfileRegistry;
  appSlots?: AppSlotRegistry;
  workspacePaths?: WorkspacePathRegistry;
  authorityVerifier?: OutboundAuthorityVerifier;
  nodeId: string;
  grantVersionGuard: PrincipalGrantVersionGuard;
}

export interface PrincipalGrantVersionGuard {
  isCurrent(ctx: PrincipalContext): boolean;
}

export class GrantStorePrincipalGrantVersionGuard implements PrincipalGrantVersionGuard {
  constructor(private readonly store: GrantStore) {}

  isCurrent(ctx: PrincipalContext): boolean {
    return this.store.currentVersion(ctx.organizationId, ctx.principalId) === ctx.grantVersion;
  }
}

export class ResourceAuthorizationError extends Error {
  readonly code = "resource_not_visible";

  constructor() {
    super("Resource unavailable");
    this.name = "ResourceAuthorizationError";
  }
}

const WORKSPACE_ACTIONS = [
  "workspace.metadata.read",
  "workspace.content.read",
  "workspace.write",
  "workspace.manage",
  "terminal.use",
  "provider.history.read",
  "provider.history.import",
  "workspace.script.execute",
  "workspace.script.configure",
  "workspace.editor.open",
] as const satisfies readonly EnterpriseAction[];

const AGENT_ACTIONS = [
  ...WORKSPACE_ACTIONS,
  "browser.use",
] as const satisfies readonly EnterpriseAction[];

export class ResourceAuthorizationService implements ResourceAuthorizationContract {
  private readonly owners: OwnerAuthorizationRegistry;
  private readonly browserProfiles?: BrowserProfileRegistry;
  private readonly appSlots?: AppSlotRegistry;
  private readonly workspacePaths?: WorkspacePathRegistry;
  private readonly authorityVerifier?: OutboundAuthorityVerifier;
  private readonly nodeId: string;
  private readonly grantVersionGuard: PrincipalGrantVersionGuard;

  constructor(dependencies: ResourceAuthorizationDependencies) {
    this.owners = dependencies.owners;
    this.browserProfiles = dependencies.browserProfiles;
    this.appSlots = dependencies.appSlots;
    this.workspacePaths = dependencies.workspacePaths;
    this.authorityVerifier = dependencies.authorityVerifier;
    this.nodeId = dependencies.nodeId;
    this.grantVersionGuard = dependencies.grantVersionGuard;
  }

  filterWorkspaces<T extends EnterpriseWorkspaceAuthorizationRecord>(
    ctx: PrincipalContext,
    rows: readonly T[],
  ): T[] {
    if (!this.isCurrent(ctx)) return [];
    return rows.filter((row) => {
      const canonical = this.owners.getWorkspace(row.id);
      if (!canonical) return false;
      let owner: ReturnType<typeof normalizeEnterpriseResourceOwner>;
      try {
        owner = normalizeEnterpriseResourceOwner(row);
      } catch {
        return false;
      }
      if (!owner || !ownersMatch(owner, canonical)) return false;
      return grantAllows(ctx, "workspace.metadata.read", canonical, row.id);
    });
  }

  async assertWorkspace(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    const workspace = this.owners.getWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.nodeId !== this.nodeId ||
      !WORKSPACE_ACTIONS.includes(action as (typeof WORKSPACE_ACTIONS)[number]) ||
      !grantAllows(ctx, action, workspace, workspaceId)
    )
      throw new ResourceAuthorizationError();
    return workspace;
  }

  async assertAgent(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    agentId: string,
  ): Promise<AuthorizedAgent> {
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    const agent = this.owners.getAgent(agentId);
    if (
      !agent ||
      agent.nodeId !== this.nodeId ||
      !AGENT_ACTIONS.includes(action as (typeof AGENT_ACTIONS)[number]) ||
      !grantAllows(ctx, action, agent, agent.workspaceId)
    )
      throw new ResourceAuthorizationError();
    return agent;
  }

  async assertBrowserProfile(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    browserProfileId: string,
  ): Promise<AuthorizedBrowserProfile> {
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    const profile = this.browserProfiles ? await this.browserProfiles.get(browserProfileId) : null;
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    if (
      !profile ||
      profile.homeNodeId !== this.nodeId ||
      !["browser.use", "browser.profile.manage"].includes(action) ||
      profile.organizationId !== ctx.organizationId ||
      !profileGrantAllows(ctx, action, profile.ownerPrincipalId)
    ) {
      throw new ResourceAuthorizationError();
    }
    return profile;
  }

  async assertAppSlot(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    appSlotId: string,
  ): Promise<AuthorizedAppSlot> {
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    const slot = this.appSlots ? await this.appSlots.get(appSlotId) : null;
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    if (
      !slot ||
      slot.nodeId !== this.nodeId ||
      action !== "app.use" ||
      slot.organizationId !== ctx.organizationId ||
      !profileGrantAllows(ctx, action, slot.ownerPrincipalId)
    ) {
      throw new ResourceAuthorizationError();
    }
    return slot;
  }

  async resolveWorkspacePath(
    ctx: PrincipalContext,
    workspaceId: string,
    requestedPath: string,
  ): Promise<string> {
    const workspace = await this.assertWorkspace(ctx, "workspace.content.read", workspaceId);
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    const resolved = this.workspacePaths
      ? await this.workspacePaths.resolve(workspace, requestedPath)
      : null;
    if (!this.isCurrent(ctx)) throw new ResourceAuthorizationError();
    if (!resolved) throw new ResourceAuthorizationError();
    return resolved;
  }

  async canEmit(
    ctx: PrincipalContext,
    event: SessionOutboundMessage,
    context: OutboundAuthorizationContext,
  ): Promise<boolean> {
    if (!this.isCurrent(ctx)) return false;
    if (isExactEmptyResourcesContext(context)) {
      return isSafeEmptyOrganizationProjection(event) && this.isCurrent(ctx);
    }
    const parsed = OutboundAuthorizationContextSchema.safeParse(context);
    if (!parsed.success) return false;
    context = parsed.data;
    if (context.kind === "transport_control") {
      return isMatchingTransportControl(event, context.control) && this.isCurrent(ctx);
    }
    if (context.kind === "authority") {
      if (!this.authorityVerifier) return false;
      try {
        const authorized = await this.authorityVerifier.verify(ctx, event, context.authority);
        return authorized && this.isCurrent(ctx);
      } catch {
        return false;
      }
    }
    for (const resource of context.resources) {
      if (!(await this.resourceIsVisible(ctx, resource, event, context.resources))) return false;
      if (!this.isCurrent(ctx)) return false;
    }
    return this.isCurrent(ctx);
  }

  private isCurrent(ctx: PrincipalContext): boolean {
    try {
      return this.grantVersionGuard.isCurrent(ctx);
    } catch {
      return false;
    }
  }

  private async resourceIsVisible(
    ctx: PrincipalContext,
    resource: GlobalResourceRef,
    event: SessionOutboundMessage,
    contextResources: readonly GlobalResourceRef[],
  ): Promise<boolean> {
    if (resource.organizationId !== ctx.organizationId || resource.nodeId !== this.nodeId)
      return false;
    const actions = outboundActionsFor(event, resource.resourceKind);
    if (actions.length === 0) return false;
    switch (resource.resourceKind) {
      case "workspace": {
        return this.workspaceResourceVisible(ctx, resource.localResourceId, actions);
      }
      case "agent": {
        return this.agentResourceVisible(ctx, resource.localResourceId, actions);
      }
      case "browser_profile": {
        return this.browserProfileResourceVisible(
          ctx,
          resource.localResourceId,
          actions,
          event,
          contextResources,
        );
      }
      case "app_slot": {
        return this.appSlotResourceVisible(
          ctx,
          resource.localResourceId,
          actions,
          event,
          contextResources,
        );
      }
    }
  }

  private workspaceResourceVisible(
    ctx: PrincipalContext,
    workspaceId: string,
    actions: readonly EnterpriseAction[],
  ): boolean {
    const workspace = this.owners.getWorkspace(workspaceId);
    return workspace
      ? actions.some((action) => grantAllows(ctx, action, workspace, workspace.workspaceId))
      : false;
  }

  private agentResourceVisible(
    ctx: PrincipalContext,
    agentId: string,
    actions: readonly EnterpriseAction[],
  ): boolean {
    const agent = this.owners.getAgent(agentId);
    return agent
      ? actions.some((action) => grantAllows(ctx, action, agent, agent.workspaceId))
      : false;
  }

  private async browserProfileResourceVisible(
    ctx: PrincipalContext,
    browserProfileId: string,
    actions: readonly EnterpriseAction[],
    event: SessionOutboundMessage,
    contextResources: readonly GlobalResourceRef[],
  ): Promise<boolean> {
    const profile = this.browserProfiles ? await this.browserProfiles.get(browserProfileId) : null;
    if (
      !profile ||
      profile.organizationId !== ctx.organizationId ||
      profile.homeNodeId !== this.nodeId
    )
      return false;
    if (event.type !== "enterprise.organization.list_resources.response")
      return actions.some((action) => profileGrantAllows(ctx, action, profile.ownerPrincipalId));
    const projection = event.payload.resources.find(
      (row) => row.resourceKind === "browser_profile" && row.browserProfileId === browserProfileId,
    );
    if (!projection || projection.ownerPrincipalId !== profile.ownerPrincipalId) return false;
    return this.organizationMetadataVisible(ctx, projection.workspaceId, contextResources);
  }

  private async appSlotResourceVisible(
    ctx: PrincipalContext,
    appSlotId: string,
    actions: readonly EnterpriseAction[],
    event: SessionOutboundMessage,
    contextResources: readonly GlobalResourceRef[],
  ): Promise<boolean> {
    const slot = this.appSlots ? await this.appSlots.get(appSlotId) : null;
    if (!slot || slot.organizationId !== ctx.organizationId || slot.nodeId !== this.nodeId)
      return false;
    if (event.type !== "enterprise.organization.list_resources.response")
      return actions.some((action) => profileGrantAllows(ctx, action, slot.ownerPrincipalId));
    const projection = event.payload.resources.find(
      (row) => row.resourceKind === "app_slot" && row.appSlotId === appSlotId,
    );
    if (!projection || projection.ownerPrincipalId !== slot.ownerPrincipalId) return false;
    return this.organizationMetadataVisible(ctx, projection.workspaceId, contextResources);
  }

  private organizationMetadataVisible(
    ctx: PrincipalContext,
    boundWorkspaceId: string | undefined,
    contextResources: readonly GlobalResourceRef[],
  ): boolean {
    if (
      ctx.grants.some(
        (grant) =>
          grant.action === "workspace.metadata.read" &&
          grant.selector.kind === "organization" &&
          grant.selector.organizationId === ctx.organizationId,
      )
    )
      return true;
    if (
      !boundWorkspaceId ||
      !contextResources.some(
        (resource) =>
          resource.resourceKind === "workspace" &&
          resource.localResourceId === boundWorkspaceId &&
          resource.organizationId === ctx.organizationId &&
          resource.nodeId === this.nodeId,
      )
    )
      return false;
    const workspace = this.owners.getWorkspace(boundWorkspaceId);
    return workspace
      ? grantAllows(ctx, "workspace.metadata.read", workspace, boundWorkspaceId)
      : false;
  }
}

export class ResourceAuthorization extends ResourceAuthorizationService {}

function isSafeEmptyOrganizationProjection(event: SessionOutboundMessage): boolean {
  return (
    event.type === "enterprise.organization.list_resources.response" &&
    event.payload.principals.length === 0 &&
    event.payload.resources.length === 0 &&
    event.payload.nextCursor === null
  );
}

function isExactEmptyResourcesContext(context: unknown): boolean {
  try {
    if (typeof context !== "object" || context === null || Array.isArray(context)) return false;
    const keys = Reflect.ownKeys(context);
    if (
      keys.length !== 2 ||
      !keys.includes("kind") ||
      !keys.includes("resources") ||
      keys.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    const kind = Object.getOwnPropertyDescriptor(context, "kind");
    const resources = Object.getOwnPropertyDescriptor(context, "resources");
    return Boolean(
      kind?.enumerable &&
      "value" in kind &&
      kind.value === "resources" &&
      resources?.enumerable &&
      "value" in resources &&
      Array.isArray(resources.value) &&
      resources.value.length === 0,
    );
  } catch {
    return false;
  }
}

function ownersMatch(
  left: NonNullable<ReturnType<typeof normalizeEnterpriseResourceOwner>>,
  right: NonNullable<ReturnType<typeof normalizeEnterpriseResourceOwner>>,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.nodeId === right.nodeId &&
    left.ownerPrincipalId === right.ownerPrincipalId &&
    left.createdByPrincipalId === right.createdByPrincipalId
  );
}

function grantAllows(
  ctx: PrincipalContext,
  action: EnterpriseAction,
  owner: { organizationId: string; ownerPrincipalId: string },
  workspaceId: string,
): boolean {
  if (owner.organizationId !== ctx.organizationId) return false;
  return ctx.grants.some((grant) =>
    grantMatches(grant, action, ctx, owner.ownerPrincipalId, workspaceId),
  );
}

function profileGrantAllows(
  ctx: PrincipalContext,
  action: EnterpriseAction,
  ownerPrincipalId?: string,
): boolean {
  return ctx.grants.some((grant) => grantMatches(grant, action, ctx, ownerPrincipalId));
}

function grantMatches(
  grant: ResourceGrant,
  action: EnterpriseAction,
  ctx: PrincipalContext,
  ownerPrincipalId?: string,
  workspaceId?: string,
): boolean {
  if (grant.action !== action) return false;
  switch (grant.selector.kind) {
    case "organization":
      return grant.selector.organizationId === ctx.organizationId;
    case "self":
      return ownerPrincipalId !== undefined && ownerPrincipalId === ctx.principalId;
    case "workspace":
      return workspaceId !== undefined && grant.selector.workspaceIds.includes(workspaceId);
  }
}
