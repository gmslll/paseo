import {
  NodeContextSchema,
  PrincipalContextSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceAuthorization,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";
import type { EnterpriseSessionContext } from "../identity/session-context.js";
import type {
  AuthorizedTerminalAccess,
  AuthorizedTerminalCreate,
  AuthorizedTerminalListPage,
  TerminalAuthorizationPolicy,
} from "./terminal-authorization-policy.js";

const EnterpriseSessionContextSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    sessionBindingGeneration: z.string().min(1),
  })
  .strict();

const WorkspaceRequestSchema = z
  .object({ workspaceId: z.string().min(1), requestId: z.string().min(1) })
  .strict();
const TerminalRequestSchema = z
  .object({ terminalId: z.string().min(1), requestId: z.string().min(1) })
  .strict();
const TerminalListRequestSchema = WorkspaceRequestSchema.extend({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
}).strict();
const ProviderHistoryRequestSchema = z.discriminatedUnion("scope", [
  WorkspaceRequestSchema.extend({ scope: z.literal("workspace") }).strict(),
  z.object({ scope: z.literal("global"), requestId: z.string().min(1) }).strict(),
]);
const ScriptRequestSchema = WorkspaceRequestSchema.extend({
  scriptName: z.string().min(1),
}).strict();

export interface EnterpriseWorkspaceRequest {
  readonly workspaceId: string;
  readonly requestId: string;
}

export interface EnterpriseTerminalRequest {
  readonly terminalId: string;
  readonly requestId: string;
}

export interface EnterpriseTerminalListRequest extends EnterpriseWorkspaceRequest {
  readonly offset: number;
  readonly limit: number;
}

export type EnterpriseProviderHistoryRequest =
  | ({ readonly scope: "workspace" } & EnterpriseWorkspaceRequest)
  | { readonly scope: "global"; readonly requestId: string };

export interface EnterpriseWorkspaceScriptRequest extends EnterpriseWorkspaceRequest {
  readonly scriptName: string;
}

export interface EnterpriseWorkspaceAuthorizationRuntimeOptions {
  readonly context: EnterpriseSessionContext;
  readonly isCurrent: () => boolean;
  readonly terminalPolicy: Pick<
    TerminalAuthorizationPolicy,
    | "authorizeCreate"
    | "authorizeList"
    | "authorizeSubscribe"
    | "authorizeInput"
    | "authorizeRename"
    | "authorizeKill"
    | "authorizeCapture"
    | "authorizeWorkspaceSubscription"
  >;
  readonly authorization: Pick<ResourceAuthorization, "assertWorkspace">;
}

/** Canonical W5 authorization seam for terminal, script, and provider-history Session callsites. */
export class EnterpriseWorkspaceAuthorizationRuntime {
  private readonly context: EnterpriseSessionContext;
  private readonly current: () => boolean;
  private readonly terminal: EnterpriseWorkspaceAuthorizationRuntimeOptions["terminalPolicy"];
  private readonly assertWorkspace: ResourceAuthorization["assertWorkspace"];

  public constructor(options: EnterpriseWorkspaceAuthorizationRuntimeOptions) {
    this.context = freezeContext(EnterpriseSessionContextSchema.parse(options.context));
    const isCurrent = options.isCurrent;
    this.current = () => isCurrent() === true;
    const terminal = options.terminalPolicy;
    this.terminal = Object.freeze({
      authorizeCreate: terminal.authorizeCreate.bind(terminal),
      authorizeList: terminal.authorizeList.bind(terminal),
      authorizeSubscribe: terminal.authorizeSubscribe.bind(terminal),
      authorizeInput: terminal.authorizeInput.bind(terminal),
      authorizeRename: terminal.authorizeRename.bind(terminal),
      authorizeKill: terminal.authorizeKill.bind(terminal),
      authorizeCapture: terminal.authorizeCapture.bind(terminal),
      authorizeWorkspaceSubscription: terminal.authorizeWorkspaceSubscription.bind(terminal),
    });
    this.assertWorkspace = options.authorization.assertWorkspace.bind(options.authorization);
  }

  public async authorizeTerminalCreate(
    input: EnterpriseWorkspaceRequest,
  ): Promise<AuthorizedTerminalCreate> {
    const request = WorkspaceRequestSchema.parse(input);
    this.assertCurrent();
    const result = await this.terminal.authorizeCreate({
      principal: this.context.principal,
      node: this.context.node,
      workspaceId: request.workspaceId,
    });
    this.assertCurrent();
    return result;
  }

  public async authorizeTerminalList(
    input: EnterpriseTerminalListRequest,
  ): Promise<AuthorizedTerminalListPage> {
    const request = TerminalListRequestSchema.parse(input);
    this.assertCurrent();
    const result = await this.terminal.authorizeList({
      scope: "workspace",
      principal: this.context.principal,
      node: this.context.node,
      workspaceId: request.workspaceId,
      offset: request.offset,
      limit: request.limit,
    });
    this.assertCurrent();
    return result;
  }

  public async denyGlobalTerminalList(input: { readonly requestId: string }): Promise<never> {
    z.object({ requestId: z.string().min(1) })
      .strict()
      .parse(input);
    this.assertCurrent();
    await this.terminal.authorizeList({
      scope: "global",
      principal: this.context.principal,
      node: this.context.node,
      offset: 0,
      limit: 1,
    });
    throw denied();
  }

  public authorizeTerminalSubscribe(
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    return this.authorizeTerminal("authorizeSubscribe", input);
  }

  public authorizeTerminalInput(
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    return this.authorizeTerminal("authorizeInput", input);
  }

  public authorizeTerminalRename(
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    return this.authorizeTerminal("authorizeRename", input);
  }

  public authorizeTerminalKill(
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    return this.authorizeTerminal("authorizeKill", input);
  }

  public authorizeTerminalCapture(
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    return this.authorizeTerminal("authorizeCapture", input);
  }

  public async authorizeWorkspaceTerminalSubscription(
    input: EnterpriseWorkspaceRequest,
  ): Promise<AuthorizedWorkspace> {
    const request = WorkspaceRequestSchema.parse(input);
    this.assertCurrent();
    const result = await this.terminal.authorizeWorkspaceSubscription({
      principal: this.context.principal,
      node: this.context.node,
      workspaceId: request.workspaceId,
    });
    this.assertCurrent();
    return result;
  }

  public async authorizeWorkspaceScript(
    input: EnterpriseWorkspaceScriptRequest,
  ): Promise<AuthorizedWorkspace> {
    const request = ScriptRequestSchema.parse(input);
    return await this.authorizeWorkspace(request.workspaceId, "workspace.script.execute");
  }

  public async authorizeProviderHistory(
    input: EnterpriseProviderHistoryRequest,
  ): Promise<AuthorizedWorkspace> {
    const request = ProviderHistoryRequestSchema.parse(input);
    this.assertCurrent();
    if (request.scope === "global") throw denied();
    return await this.authorizeWorkspace(request.workspaceId, "provider.history.read");
  }

  private async authorizeTerminal(
    operation:
      | "authorizeSubscribe"
      | "authorizeInput"
      | "authorizeRename"
      | "authorizeKill"
      | "authorizeCapture",
    input: EnterpriseTerminalRequest,
  ): Promise<AuthorizedTerminalAccess> {
    const request = TerminalRequestSchema.parse(input);
    this.assertCurrent();
    const result = await this.terminal[operation]({
      principal: this.context.principal,
      node: this.context.node,
      terminalId: request.terminalId,
    });
    this.assertCurrent();
    return result;
  }

  private async authorizeWorkspace(
    workspaceId: string,
    action: "workspace.script.execute" | "provider.history.read",
  ): Promise<AuthorizedWorkspace> {
    this.assertCurrent();
    const workspace = await this.assertWorkspace(this.context.principal, action, workspaceId);
    this.assertCurrent();
    if (
      workspace.organizationId !== this.context.principal.organizationId ||
      workspace.nodeId !== this.context.node.nodeId ||
      workspace.workspaceId !== workspaceId
    ) {
      throw denied();
    }
    return workspace;
  }

  private assertCurrent(): void {
    if (!this.current()) throw denied();
  }
}

function denied(): Error {
  return new Error("Enterprise workspace access denied.");
}

function freezeContext(
  input: z.infer<typeof EnterpriseSessionContextSchema>,
): EnterpriseSessionContext {
  return Object.freeze({
    principal: freezePrincipal(input.principal),
    node: freezeNode(input.node),
    sessionBindingGeneration: input.sessionBindingGeneration,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") return Object.freeze({ ...input, grants });
  if (input.principalType === "service") return Object.freeze({ ...input, grants });
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
    grants,
  });
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  return Object.freeze({ action: input.action, selector: cloneSelector(input.selector) });
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") return Object.freeze({ kind: input.kind });
  if (input.kind === "organization") {
    return Object.freeze({ kind: input.kind, organizationId: input.organizationId });
  }
  const workspaceIds = [...input.workspaceIds];
  Object.freeze(workspaceIds);
  return Object.freeze({ kind: input.kind, workspaceIds });
}

function freezeNode(input: NodeContext): NodeContext {
  return Object.freeze({
    nodeId: input.nodeId,
    paseoServerId: input.paseoServerId,
    mode: input.mode,
  });
}
