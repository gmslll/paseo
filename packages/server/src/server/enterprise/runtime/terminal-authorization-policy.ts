import {
  EnterpriseResourceOwnerSchema,
  NodeContextSchema,
  NodeIdSchema,
  PrincipalContextSchema,
  type AuthorizedWorkspace,
  type NodeContext,
  type PrincipalContext,
  type ResourceAuthorization,
  type ResourceGrant,
  type ResourceSelector,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

const TERMINAL_ACCESS_DENIED_MESSAGE = "Terminal access denied.";

const TERMINAL_INPUT_MESSAGE_KINDS = Object.freeze(["input", "resize", "mouse"] as const);

export const TERMINAL_AUTHORIZATION_ENTRY_MAP = Object.freeze([
  Object.freeze({
    requestType: "create_terminal_request",
    authority: "terminal.use",
    scope: "workspace",
  }),
  Object.freeze({
    requestType: "list_terminals_request",
    authority: "terminal.use",
    scope: "workspace",
  }),
  Object.freeze({
    requestType: "subscribe_terminals_request",
    authority: "terminal.use",
    scope: "workspace",
  }),
  Object.freeze({
    requestType: "subscribe_terminal_request",
    authority: "terminal.use",
    scope: "terminal",
  }),
  Object.freeze({
    requestType: "terminal_input",
    authority: "terminal.use",
    scope: "terminal",
    messageKinds: TERMINAL_INPUT_MESSAGE_KINDS,
  }),
  Object.freeze({
    requestType: "terminal.rename.request",
    authority: "terminal.use",
    scope: "terminal",
  }),
  Object.freeze({
    requestType: "kill_terminal_request",
    authority: "terminal.use",
    scope: "terminal",
  }),
  Object.freeze({
    requestType: "capture_terminal_request",
    authority: "terminal.use",
    scope: "terminal",
  }),
  Object.freeze({
    requestType: "unsubscribe_terminal_request",
    authority: "current-session-binding",
    scope: "terminal",
  }),
  Object.freeze({
    requestType: "unsubscribe_terminals_request",
    authority: "current-session-binding",
    scope: "workspace",
  }),
] as const);

const AuthorizedWorkspaceSchema = EnterpriseResourceOwnerSchema.extend({
  workspaceId: z.string().min(1),
}).strict();

const CanonicalTerminalRecordSchema = z
  .object({
    terminalId: z.string().min(1),
    workspaceId: z.string().min(1),
    nodeId: NodeIdSchema,
  })
  .strict();

const TerminalCreateInputSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    workspaceId: z.string().min(1),
  })
  .strict();

const TerminalAccessInputSchema = z
  .object({
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    terminalId: z.string().min(1),
  })
  .strict();

const TerminalCleanupInputSchema = z.object({ terminalId: z.string().min(1) }).strict();

const TerminalWorkspaceCleanupInputSchema = z.object({ workspaceId: z.string().min(1) }).strict();

const PaginationShape = {
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

const TerminalWorkspaceListInputSchema = z
  .object({
    scope: z.literal("workspace"),
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    workspaceId: z.string().min(1),
    ...PaginationShape,
  })
  .strict();

const TerminalGlobalListInputSchema = z
  .object({
    scope: z.literal("global"),
    principal: PrincipalContextSchema,
    node: NodeContextSchema,
    ...PaginationShape,
  })
  .strict();

const TerminalListInputSchema = z.discriminatedUnion("scope", [
  TerminalWorkspaceListInputSchema,
  TerminalGlobalListInputSchema,
]);

export interface CanonicalTerminalRecord {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly nodeId: string;
}

export interface CanonicalTerminalResolver {
  resolve(terminalId: string): Promise<CanonicalTerminalRecord | null>;
  listWorkspace(
    query: CanonicalTerminalWorkspaceQuery,
  ): Promise<readonly CanonicalTerminalRecord[]>;
}

export interface CanonicalTerminalWorkspaceQuery {
  readonly workspaceId: string;
  readonly nodeId: string;
}

// W3 supplies a per-Session adapter backed only by bindings created after successful subscribe
// authorization. These checks must not consult daemon-global Terminal state or current Grants.
export interface CurrentTerminalSessionBindings {
  hasTerminalSubscription(terminalId: string): boolean;
  hasWorkspaceSubscription(workspaceId: string): boolean;
}

export interface TerminalCreateInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
}

export interface TerminalAccessInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly terminalId: string;
}

export interface TerminalWorkspaceSubscriptionInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
}

export interface TerminalCleanupInput {
  readonly terminalId: string;
}

export interface TerminalWorkspaceCleanupInput {
  readonly workspaceId: string;
}

export interface TerminalWorkspaceListInput {
  readonly scope: "workspace";
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface TerminalGlobalListInput {
  readonly scope: "global";
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly offset: number;
  readonly limit: number;
}

export type TerminalListInput = TerminalWorkspaceListInput | TerminalGlobalListInput;

export type TerminalExistingOperation = "subscribe" | "input" | "rename" | "kill" | "capture";

export interface TerminalCleanupBinding {
  readonly kind: "terminal";
  readonly terminalId: string;
}

export interface TerminalWorkspaceCleanupBinding {
  readonly kind: "workspace";
  readonly workspaceId: string;
}

export type TerminalCleanupDecision =
  | {
      readonly allowed: true;
      readonly binding: TerminalCleanupBinding | TerminalWorkspaceCleanupBinding;
    }
  | { readonly allowed: false };

export interface AuthorizedTerminalCreate {
  readonly operation: "create";
  readonly workspace: AuthorizedWorkspace;
}

export interface AuthorizedTerminalAccess {
  readonly operation: TerminalExistingOperation;
  readonly terminal: CanonicalTerminalRecord;
  readonly workspace: AuthorizedWorkspace;
}

export interface AuthorizedTerminalListPage {
  readonly operation: "list";
  readonly workspace: AuthorizedWorkspace;
  readonly terminals: readonly CanonicalTerminalRecord[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly nextOffset: number | null;
}

export class TerminalAuthorizationPolicyError extends Error {
  public readonly code = "terminal_access_denied";

  public constructor() {
    super(TERMINAL_ACCESS_DENIED_MESSAGE);
    this.name = "TerminalAuthorizationPolicyError";
  }
}

export interface TerminalAuthorizationPolicyOptions {
  readonly resolver: CanonicalTerminalResolver;
  readonly authorization: Pick<ResourceAuthorization, "assertWorkspace">;
  readonly sessionBindings: CurrentTerminalSessionBindings;
}

interface ParsedTerminalCreateInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
}

interface ParsedTerminalAccessInput {
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly terminalId: string;
}

interface ParsedTerminalWorkspaceListInput {
  readonly scope: "workspace";
  readonly principal: PrincipalContext;
  readonly node: NodeContext;
  readonly workspaceId: string;
  readonly offset: number;
  readonly limit: number;
}

export class TerminalAuthorizationPolicy {
  private readonly resolveTerminal: CanonicalTerminalResolver["resolve"];
  private readonly listWorkspaceTerminals: CanonicalTerminalResolver["listWorkspace"];
  private readonly assertWorkspace: ResourceAuthorization["assertWorkspace"];
  private readonly hasTerminalSubscription: CurrentTerminalSessionBindings["hasTerminalSubscription"];
  private readonly hasWorkspaceSubscription: CurrentTerminalSessionBindings["hasWorkspaceSubscription"];

  public constructor(options: TerminalAuthorizationPolicyOptions) {
    this.resolveTerminal = options.resolver.resolve.bind(options.resolver);
    this.listWorkspaceTerminals = options.resolver.listWorkspace.bind(options.resolver);
    this.assertWorkspace = options.authorization.assertWorkspace.bind(options.authorization);
    this.hasTerminalSubscription = options.sessionBindings.hasTerminalSubscription.bind(
      options.sessionBindings,
    );
    this.hasWorkspaceSubscription = options.sessionBindings.hasWorkspaceSubscription.bind(
      options.sessionBindings,
    );
  }

  public async authorizeCreate(input: TerminalCreateInput): Promise<AuthorizedTerminalCreate> {
    try {
      const request = parseCreateInput(input);
      const workspace = await this.authorizeWorkspace(request, request.workspaceId);
      return Object.freeze({ operation: "create", workspace });
    } catch {
      throw accessDenied();
    }
  }

  public async authorizeList(input: TerminalListInput): Promise<AuthorizedTerminalListPage> {
    try {
      const request = TerminalListInputSchema.parse(input);
      if (request.scope === "global") {
        throw accessDenied();
      }
      const parsed = freezeWorkspaceListInput(request);
      const workspace = await this.authorizeWorkspace(parsed, parsed.workspaceId);
      const records = (
        await this.listWorkspaceTerminals({
          workspaceId: workspace.workspaceId,
          nodeId: workspace.nodeId,
        })
      ).map(parseTerminal);
      const filtered = records.filter(
        (terminal) =>
          terminal.nodeId === workspace.nodeId && terminal.workspaceId === workspace.workspaceId,
      );
      const end =
        parsed.offset >= filtered.length
          ? filtered.length
          : parsed.offset + Math.min(parsed.limit, filtered.length - parsed.offset);
      const terminals = filtered.slice(parsed.offset, end).map(freezeTerminal);
      Object.freeze(terminals);
      const nextOffset = end < filtered.length ? end : null;
      return Object.freeze({
        operation: "list",
        workspace,
        terminals,
        offset: parsed.offset,
        limit: parsed.limit,
        total: filtered.length,
        nextOffset,
      });
    } catch {
      throw accessDenied();
    }
  }

  public async authorizeWorkspaceSubscription(
    input: TerminalWorkspaceSubscriptionInput,
  ): Promise<AuthorizedWorkspace> {
    try {
      const request = parseCreateInput(input);
      return await this.authorizeWorkspace(request, request.workspaceId);
    } catch {
      throw accessDenied();
    }
  }

  public authorizeSubscribe(input: TerminalAccessInput): Promise<AuthorizedTerminalAccess> {
    return this.authorizeExisting("subscribe", input);
  }

  public authorizeInput(input: TerminalAccessInput): Promise<AuthorizedTerminalAccess> {
    return this.authorizeExisting("input", input);
  }

  public authorizeKill(input: TerminalAccessInput): Promise<AuthorizedTerminalAccess> {
    return this.authorizeExisting("kill", input);
  }

  public authorizeCapture(input: TerminalAccessInput): Promise<AuthorizedTerminalAccess> {
    return this.authorizeExisting("capture", input);
  }

  public authorizeRename(input: TerminalAccessInput): Promise<AuthorizedTerminalAccess> {
    return this.authorizeExisting("rename", input);
  }

  // W3 calls these before the matching controller cleanup and may release only the returned
  // Session-local binding. A denied result is deliberately independent of daemon-global state.
  public decideTerminalUnsubscribe(input: TerminalCleanupInput): TerminalCleanupDecision {
    try {
      const request = TerminalCleanupInputSchema.parse(input);
      if (!this.hasTerminalSubscription(request.terminalId)) {
        return cleanupDenied();
      }
      const binding: TerminalCleanupBinding = Object.freeze({
        kind: "terminal",
        terminalId: request.terminalId,
      });
      return Object.freeze({ allowed: true, binding });
    } catch {
      return cleanupDenied();
    }
  }

  public decideWorkspaceUnsubscribe(input: TerminalWorkspaceCleanupInput): TerminalCleanupDecision {
    try {
      const request = TerminalWorkspaceCleanupInputSchema.parse(input);
      if (!this.hasWorkspaceSubscription(request.workspaceId)) {
        return cleanupDenied();
      }
      const binding: TerminalWorkspaceCleanupBinding = Object.freeze({
        kind: "workspace",
        workspaceId: request.workspaceId,
      });
      return Object.freeze({ allowed: true, binding });
    } catch {
      return cleanupDenied();
    }
  }

  private async authorizeExisting(
    operation: TerminalExistingOperation,
    input: TerminalAccessInput,
  ): Promise<AuthorizedTerminalAccess> {
    try {
      const request = parseAccessInput(input);
      const resolved = await this.resolveTerminal(request.terminalId);
      if (resolved === null) {
        throw accessDenied();
      }
      const terminal = parseTerminal(resolved);
      if (terminal.terminalId !== request.terminalId || terminal.nodeId !== request.node.nodeId) {
        throw accessDenied();
      }
      const workspace = await this.authorizeWorkspace(request, terminal.workspaceId);
      if (workspace.nodeId !== terminal.nodeId) {
        throw accessDenied();
      }
      return Object.freeze({ operation, terminal: freezeTerminal(terminal), workspace });
    } catch {
      throw accessDenied();
    }
  }

  private async authorizeWorkspace(
    request: { readonly principal: PrincipalContext; readonly node: NodeContext },
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    const workspace = AuthorizedWorkspaceSchema.parse(
      await this.assertWorkspace(request.principal, "terminal.use", workspaceId),
    );
    if (
      workspace.organizationId !== request.principal.organizationId ||
      workspace.nodeId !== request.node.nodeId ||
      workspace.workspaceId !== workspaceId
    ) {
      throw accessDenied();
    }
    return freezeWorkspace(workspace);
  }
}

function accessDenied(): TerminalAuthorizationPolicyError {
  return new TerminalAuthorizationPolicyError();
}

const CLEANUP_DENIED: TerminalCleanupDecision = Object.freeze({ allowed: false });

function cleanupDenied(): TerminalCleanupDecision {
  return CLEANUP_DENIED;
}

function parseCreateInput(input: TerminalCreateInput): ParsedTerminalCreateInput {
  const parsed = TerminalCreateInputSchema.parse(input);
  return Object.freeze({
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    workspaceId: parsed.workspaceId,
  });
}

function parseAccessInput(input: TerminalAccessInput): ParsedTerminalAccessInput {
  const parsed = TerminalAccessInputSchema.parse(input);
  return Object.freeze({
    principal: freezePrincipal(parsed.principal),
    node: freezeNode(parsed.node),
    terminalId: parsed.terminalId,
  });
}

function freezeWorkspaceListInput(
  input: z.infer<typeof TerminalWorkspaceListInputSchema>,
): ParsedTerminalWorkspaceListInput {
  return Object.freeze({
    scope: input.scope,
    principal: freezePrincipal(input.principal),
    node: freezeNode(input.node),
    workspaceId: input.workspaceId,
    offset: input.offset,
    limit: input.limit,
  });
}

function parseTerminal(input: CanonicalTerminalRecord): CanonicalTerminalRecord {
  return freezeTerminal(CanonicalTerminalRecordSchema.parse(input));
}

function freezeTerminal(input: CanonicalTerminalRecord): CanonicalTerminalRecord {
  return Object.freeze({
    terminalId: input.terminalId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
  });
}

function freezePrincipal(input: PrincipalContext): PrincipalContext {
  const grants = input.grants.map(cloneGrant);
  Object.freeze(grants);
  if (input.principalType === "human") {
    return Object.freeze({
      principalType: input.principalType,
      principalId: input.principalId,
      organizationId: input.organizationId,
      grants,
      credentialId: input.credentialId,
      grantVersion: input.grantVersion,
    });
  }
  if (input.principalType === "service") {
    return Object.freeze({
      principalType: input.principalType,
      principalId: input.principalId,
      organizationId: input.organizationId,
      grants,
      credentialId: input.credentialId,
      grantVersion: input.grantVersion,
    });
  }
  return Object.freeze({
    principalType: input.principalType,
    principalId: input.principalId,
    organizationId: input.organizationId,
    grants,
    credentialId: input.credentialId,
    grantVersion: input.grantVersion,
  });
}

function cloneGrant(input: ResourceGrant): ResourceGrant {
  return Object.freeze({
    action: input.action,
    selector: cloneSelector(input.selector),
  });
}

function cloneSelector(input: ResourceSelector): ResourceSelector {
  if (input.kind === "self") {
    return Object.freeze({ kind: input.kind });
  }
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

function freezeWorkspace(input: AuthorizedWorkspace): AuthorizedWorkspace {
  return Object.freeze({
    organizationId: input.organizationId,
    nodeId: input.nodeId,
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    workspaceId: input.workspaceId,
  });
}
