import type {
  AuthorizedWorkspace,
  EnterpriseAction,
  NodeContext,
  PrincipalContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  TERMINAL_AUTHORIZATION_ENTRY_MAP,
  TerminalAuthorizationPolicy,
  TerminalAuthorizationPolicyError,
  type AuthorizedTerminalAccess,
  type CanonicalTerminalRecord,
  type CanonicalTerminalResolver,
  type CanonicalTerminalWorkspaceQuery,
  type CurrentTerminalSessionBindings,
  type TerminalAccessInput,
  type TerminalCreateInput,
  type TerminalListInput,
  type TerminalWorkspaceSubscriptionInput,
} from "./terminal-authorization-policy.js";

const ORGANIZATION_ID = "org_0123456789abcdef";
const OTHER_ORGANIZATION_ID = "org_fedcba9876543210";
const NODE_ID = "nod_0123456789abcdef";
const OTHER_NODE_ID = "nod_fedcba9876543210";
const PRINCIPAL_ID = "usr_0123456789abcdef";
const OTHER_PRINCIPAL_ID = "usr_fedcba9876543210";
const WORKSPACE_ID = "workspace-one";
const OTHER_WORKSPACE_ID = "workspace-two";
const TERMINAL_ID = "terminal-one";

interface PrincipalOverrides {
  organizationId?: string;
  principalId?: string;
  grantVersion?: string;
}

function principal(overrides: PrincipalOverrides = {}): PrincipalContext {
  return {
    principalType: "human",
    principalId: overrides.principalId ?? PRINCIPAL_ID,
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    credentialId: "credential-one",
    grantVersion: overrides.grantVersion ?? "grant-one",
    grants: [
      {
        action: "terminal.use",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ],
  };
}

function node(nodeId = NODE_ID): NodeContext {
  return {
    nodeId,
    paseoServerId: "server-one",
    mode: "standalone",
  };
}

interface WorkspaceOverrides {
  organizationId?: string;
  nodeId?: string;
  workspaceId?: string;
}

function workspace(overrides: WorkspaceOverrides = {}): AuthorizedWorkspace {
  return {
    organizationId: overrides.organizationId ?? ORGANIZATION_ID,
    nodeId: overrides.nodeId ?? NODE_ID,
    ownerPrincipalId: PRINCIPAL_ID,
    createdByPrincipalId: PRINCIPAL_ID,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
  };
}

interface TerminalOverrides {
  terminalId?: string;
  workspaceId?: string;
  nodeId?: string;
}

function terminal(overrides: TerminalOverrides = {}): CanonicalTerminalRecord {
  return {
    terminalId: overrides.terminalId ?? TERMINAL_ID,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    nodeId: overrides.nodeId ?? NODE_ID,
  };
}

type MemoryTerminalEntry =
  | { readonly state: "canonical"; readonly terminal: CanonicalTerminalRecord }
  | { readonly state: "legacy"; readonly terminalId: string }
  | { readonly state: "quarantined"; readonly terminalId: string };

class MemoryCanonicalTerminalResolver implements CanonicalTerminalResolver {
  public readonly resolveCalls: string[] = [];
  public readonly listWorkspaceCalls: CanonicalTerminalWorkspaceQuery[] = [];
  public listCalls = 0;
  public resolveError: Error | null = null;
  public listError: Error | null = null;

  public constructor(
    private readonly entries: readonly MemoryTerminalEntry[],
    private readonly events: string[] = [],
  ) {}

  public async resolve(terminalId: string): Promise<CanonicalTerminalRecord | null> {
    this.resolveCalls.push(terminalId);
    this.events.push(`resolve:${terminalId}`);
    if (this.resolveError) {
      throw this.resolveError;
    }
    const entry = this.entries.find((candidate) =>
      candidate.state === "canonical"
        ? candidate.terminal.terminalId === terminalId
        : candidate.terminalId === terminalId,
    );
    return entry?.state === "canonical" ? entry.terminal : null;
  }

  public async listWorkspace(
    query: CanonicalTerminalWorkspaceQuery,
  ): Promise<readonly CanonicalTerminalRecord[]> {
    this.listCalls += 1;
    this.listWorkspaceCalls.push({ ...query });
    this.events.push("list");
    if (this.listError) {
      throw this.listError;
    }
    return this.entries.flatMap((entry) => (entry.state === "canonical" ? [entry.terminal] : []));
  }
}

class MemoryCurrentTerminalSessionBindings implements CurrentTerminalSessionBindings {
  public readonly calls: string[] = [];
  public terminalError: Error | null = null;
  public workspaceError: Error | null = null;

  public constructor(
    private readonly terminalIds: ReadonlySet<string> = new Set(),
    private readonly workspaceIds: ReadonlySet<string> = new Set(),
  ) {}

  public hasTerminalSubscription(terminalId: string): boolean {
    this.calls.push(`terminal:${terminalId}`);
    if (this.terminalError) {
      throw this.terminalError;
    }
    return this.terminalIds.has(terminalId);
  }

  public hasWorkspaceSubscription(workspaceId: string): boolean {
    this.calls.push(`workspace:${workspaceId}`);
    if (this.workspaceError) {
      throw this.workspaceError;
    }
    return this.workspaceIds.has(workspaceId);
  }
}

interface AuthorizationCall {
  readonly principal: PrincipalContext;
  readonly action: EnterpriseAction;
  readonly workspaceId: string;
}

type AuthorizationHandler = (
  principal: PrincipalContext,
  action: EnterpriseAction,
  workspaceId: string,
) => AuthorizedWorkspace | Promise<AuthorizedWorkspace>;

interface TestResourceAuthorization extends Pick<ResourceAuthorization, "assertWorkspace"> {
  readonly calls: AuthorizationCall[];
}

function createAuthorization(
  handler: AuthorizationHandler = (_principal, _action, workspaceId) => workspace({ workspaceId }),
  events: string[] = [],
): TestResourceAuthorization {
  const calls: AuthorizationCall[] = [];
  return {
    calls,
    async assertWorkspace(ctx, action, workspaceId) {
      calls.push({ principal: ctx, action, workspaceId });
      events.push(`authorize:${workspaceId}:${action}`);
      return handler(ctx, action, workspaceId);
    },
  };
}

interface PolicyFixtureOptions {
  resolver?: CanonicalTerminalResolver;
  authorization?: Pick<ResourceAuthorization, "assertWorkspace">;
  sessionBindings?: CurrentTerminalSessionBindings;
}

function createPolicy(options: PolicyFixtureOptions = {}): TerminalAuthorizationPolicy {
  return new TerminalAuthorizationPolicy({
    resolver:
      options.resolver ??
      new MemoryCanonicalTerminalResolver([{ state: "canonical", terminal: terminal() }]),
    authorization: options.authorization ?? createAuthorization(),
    sessionBindings: options.sessionBindings ?? new MemoryCurrentTerminalSessionBindings(),
  });
}

function createInput(): TerminalCreateInput {
  return {
    principal: principal(),
    node: node(),
    workspaceId: WORKSPACE_ID,
  };
}

function accessInput(): TerminalAccessInput {
  return {
    principal: principal(),
    node: node(),
    terminalId: TERMINAL_ID,
  };
}

function listInput(offset = 0, limit = 20): TerminalListInput {
  return {
    scope: "workspace",
    principal: principal(),
    node: node(),
    workspaceId: WORKSPACE_ID,
    offset,
    limit,
  };
}

function workspaceSubscriptionInput(): TerminalWorkspaceSubscriptionInput {
  return {
    principal: principal(),
    node: node(),
    workspaceId: WORKSPACE_ID,
  };
}

async function expectDenied(promise: Promise<unknown>): Promise<TerminalAuthorizationPolicyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalAuthorizationPolicyError);
    if (!(error instanceof TerminalAuthorizationPolicyError)) {
      throw new Error("Expected TerminalAuthorizationPolicyError", { cause: error });
    }
    expect(error.name).toBe("TerminalAuthorizationPolicyError");
    expect(error.code).toBe("terminal_access_denied");
    expect(error.message).toBe("Terminal access denied.");
    return error;
  }
  throw new Error("Expected terminal authorization to fail");
}

interface ExistingOperationCase {
  readonly operation: AuthorizedTerminalAccess["operation"];
  authorize(
    policy: TerminalAuthorizationPolicy,
    input: TerminalAccessInput,
  ): Promise<AuthorizedTerminalAccess>;
}

const EXISTING_OPERATIONS: readonly ExistingOperationCase[] = [
  {
    operation: "subscribe",
    authorize: (policy, input) => policy.authorizeSubscribe(input),
  },
  { operation: "input", authorize: (policy, input) => policy.authorizeInput(input) },
  { operation: "kill", authorize: (policy, input) => policy.authorizeKill(input) },
  { operation: "capture", authorize: (policy, input) => policy.authorizeCapture(input) },
  { operation: "rename", authorize: (policy, input) => policy.authorizeRename(input) },
];

interface TerminalUseEntryCase {
  readonly entry: string;
  readonly resolution: "none" | "terminal" | "workspace-list";
  authorize(policy: TerminalAuthorizationPolicy): Promise<unknown>;
}

const TERMINAL_USE_ENTRIES: readonly TerminalUseEntryCase[] = [
  {
    entry: "create_terminal_request",
    resolution: "none",
    authorize: (policy) => policy.authorizeCreate(createInput()),
  },
  {
    entry: "list_terminals_request",
    resolution: "workspace-list",
    authorize: (policy) => policy.authorizeList(listInput()),
  },
  {
    entry: "subscribe_terminals_request",
    resolution: "none",
    authorize: (policy) => policy.authorizeWorkspaceSubscription(workspaceSubscriptionInput()),
  },
  {
    entry: "subscribe_terminal_request",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeSubscribe(accessInput()),
  },
  {
    entry: "terminal_input:input",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeInput(accessInput()),
  },
  {
    entry: "terminal_input:resize",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeInput(accessInput()),
  },
  {
    entry: "terminal_input:mouse",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeInput(accessInput()),
  },
  {
    entry: "terminal.rename.request",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeRename(accessInput()),
  },
  {
    entry: "kill_terminal_request",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeKill(accessInput()),
  },
  {
    entry: "capture_terminal_request",
    resolution: "terminal",
    authorize: (policy) => policy.authorizeCapture(accessInput()),
  },
];

describe("TerminalAuthorizationPolicy", () => {
  it("publishes the complete Terminal entry authorization map", () => {
    expect(TERMINAL_AUTHORIZATION_ENTRY_MAP).toEqual([
      {
        requestType: "create_terminal_request",
        authority: "terminal.use",
        scope: "workspace",
      },
      {
        requestType: "list_terminals_request",
        authority: "terminal.use",
        scope: "workspace",
      },
      {
        requestType: "subscribe_terminals_request",
        authority: "terminal.use",
        scope: "workspace",
      },
      {
        requestType: "subscribe_terminal_request",
        authority: "terminal.use",
        scope: "terminal",
      },
      {
        requestType: "terminal_input",
        authority: "terminal.use",
        scope: "terminal",
        messageKinds: ["input", "resize", "mouse"],
      },
      {
        requestType: "terminal.rename.request",
        authority: "terminal.use",
        scope: "terminal",
      },
      {
        requestType: "kill_terminal_request",
        authority: "terminal.use",
        scope: "terminal",
      },
      {
        requestType: "capture_terminal_request",
        authority: "terminal.use",
        scope: "terminal",
      },
      {
        requestType: "unsubscribe_terminal_request",
        authority: "current-session-binding",
        scope: "terminal",
      },
      {
        requestType: "unsubscribe_terminals_request",
        authority: "current-session-binding",
        scope: "workspace",
      },
    ]);
    expect(Object.isFrozen(TERMINAL_AUTHORIZATION_ENTRY_MAP)).toBe(true);
    for (const entry of TERMINAL_AUTHORIZATION_ENTRY_MAP) {
      expect(Object.isFrozen(entry)).toBe(true);
      if ("messageKinds" in entry) {
        expect(Object.isFrozen(entry.messageKinds)).toBe(true);
      }
    }
  });

  it.each(TERMINAL_USE_ENTRIES)(
    "maps $entry to terminal.use with the declared canonical resolution",
    async (row) => {
      const resolver = new MemoryCanonicalTerminalResolver([
        { state: "canonical", terminal: terminal() },
      ]);
      const authorization = createAuthorization();
      const policy = createPolicy({ resolver, authorization });

      await row.authorize(policy);

      expect(authorization.calls).toEqual([
        {
          principal: principal(),
          action: "terminal.use",
          workspaceId: WORKSPACE_ID,
        },
      ]);
      expect(resolver.resolveCalls).toEqual(row.resolution === "terminal" ? [TERMINAL_ID] : []);
      expect(resolver.listWorkspaceCalls).toEqual(
        row.resolution === "workspace-list" ? [{ workspaceId: WORKSPACE_ID, nodeId: NODE_ID }] : [],
      );
    },
  );

  it("authorizes create from runtime-parsed Principal and Node context using only workspaceId", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });
    const rawPrincipal = { ...principal(), callerOwner: OTHER_PRINCIPAL_ID };
    const rawNode = { ...node(), callerNode: OTHER_NODE_ID };

    const authorized = await policy.authorizeCreate({
      principal: rawPrincipal,
      node: rawNode,
      workspaceId: WORKSPACE_ID,
    });

    expect(authorized).toEqual({ operation: "create", workspace: workspace() });
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(Object.isFrozen(authorized.workspace)).toBe(true);
    expect(authorization.calls).toEqual([
      {
        principal: principal(),
        action: "terminal.use",
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
    expect(Object.isFrozen(authorization.calls[0]?.principal)).toBe(true);
    expect(Object.isFrozen(authorization.calls[0]?.principal.grants)).toBe(true);
  });

  it.each(EXISTING_OPERATIONS)(
    "authorizes $operation by resolving terminalId before checking terminal.use",
    async (row) => {
      const events: string[] = [];
      const resolver = new MemoryCanonicalTerminalResolver(
        [{ state: "canonical", terminal: terminal() }],
        events,
      );
      const authorization = createAuthorization(undefined, events);
      const policy = createPolicy({ resolver, authorization });

      const authorized = await row.authorize(policy, accessInput());

      expect(authorized).toEqual({
        operation: row.operation,
        terminal: terminal(),
        workspace: workspace(),
      });
      expect(events).toEqual([`resolve:${TERMINAL_ID}`, `authorize:${WORKSPACE_ID}:terminal.use`]);
      expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
      expect(resolver.listCalls).toBe(0);
      expect(authorization.calls).toEqual([
        {
          principal: principal(),
          action: "terminal.use",
          workspaceId: WORKSPACE_ID,
        },
      ]);
      expect(Object.isFrozen(authorized)).toBe(true);
      expect(Object.isFrozen(authorized.terminal)).toBe(true);
      expect(Object.isFrozen(authorized.workspace)).toBe(true);
    },
  );

  it("authorizes a Workspace terminal subscription from only workspaceId", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    const authorized = await policy.authorizeWorkspaceSubscription(workspaceSubscriptionInput());

    expect(authorized).toEqual(workspace());
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(authorization.calls).toEqual([
      {
        principal: principal(),
        action: "terminal.use",
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
  });

  it.each([
    {
      missing: "workspaceId",
      input: { principal: principal(), node: node() },
    },
    {
      missing: "Workspace scope via a global fallback",
      input: { principal: principal(), node: node(), scope: "global" },
    },
  ])("rejects Workspace subscription without $missing before dependencies", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver([]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(Reflect.apply(policy.authorizeWorkspaceSubscription, policy, [row.input]));

    expect(authorization.calls).toEqual([]);
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
  });

  it("authorizes Workspace list before canonical filtering and paginates only the filtered rows", async () => {
    const events: string[] = [];
    const rows: MemoryTerminalEntry[] = [
      {
        state: "canonical",
        terminal: terminal({ terminalId: "foreign-before", workspaceId: OTHER_WORKSPACE_ID }),
      },
      { state: "canonical", terminal: terminal({ terminalId: "own-one" }) },
      {
        state: "canonical",
        terminal: terminal({ terminalId: "other-node", nodeId: OTHER_NODE_ID }),
      },
      { state: "canonical", terminal: terminal({ terminalId: "own-two" }) },
      {
        state: "canonical",
        terminal: terminal({ terminalId: "foreign-after", workspaceId: OTHER_WORKSPACE_ID }),
      },
      { state: "canonical", terminal: terminal({ terminalId: "own-three" }) },
    ];
    const resolver = new MemoryCanonicalTerminalResolver(rows, events);
    const authorization = createAuthorization(undefined, events);
    const policy = createPolicy({ resolver, authorization });

    const page = await policy.authorizeList(listInput(1, 1));

    expect(events).toEqual([`authorize:${WORKSPACE_ID}:terminal.use`, "list"]);
    expect(page).toEqual({
      operation: "list",
      workspace: workspace(),
      terminals: [terminal({ terminalId: "own-two" })],
      offset: 1,
      limit: 1,
      total: 3,
      nextOffset: 2,
    });
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(1);
    expect(resolver.listWorkspaceCalls).toEqual([{ workspaceId: WORKSPACE_ID, nodeId: NODE_ID }]);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.workspace)).toBe(true);
    expect(Object.isFrozen(page.terminals)).toBe(true);
    expect(Object.isFrozen(page.terminals[0])).toBe(true);
  });

  it("fails closed for an employee global list without touching authorization or registry", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(
      policy.authorizeList({
        scope: "global",
        principal: principal(),
        node: node(),
        offset: 0,
        limit: 20,
      }),
    );

    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
    expect(resolver.listWorkspaceCalls).toEqual([]);
    expect(authorization.calls).toEqual([]);
  });

  it("has no Workspace-list fallback when workspaceId is absent", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });
    const missingWorkspaceId = {
      scope: "workspace",
      principal: principal(),
      node: node(),
      offset: 0,
      limit: 20,
    };

    await expectDenied(Reflect.apply(policy.authorizeList, policy, [missingWorkspaceId]));

    expect(resolver.listCalls).toBe(0);
    expect(resolver.listWorkspaceCalls).toEqual([]);
    expect(authorization.calls).toEqual([]);
  });

  it.each([
    {
      entry: "unsubscribe_terminal_request",
      sessionBindings: new MemoryCurrentTerminalSessionBindings(new Set([TERMINAL_ID])),
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideTerminalUnsubscribe({ terminalId: TERMINAL_ID }),
      expectedCall: `terminal:${TERMINAL_ID}`,
      expectedBinding: { kind: "terminal", terminalId: TERMINAL_ID },
    },
    {
      entry: "unsubscribe_terminals_request",
      sessionBindings: new MemoryCurrentTerminalSessionBindings(new Set(), new Set([WORKSPACE_ID])),
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideWorkspaceUnsubscribe({ workspaceId: WORKSPACE_ID }),
      expectedCall: `workspace:${WORKSPACE_ID}`,
      expectedBinding: { kind: "workspace", workspaceId: WORKSPACE_ID },
    },
  ])("maps $entry to current-Session binding cleanup even after Grant revocation", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver([]);
    resolver.resolveError = new Error("cleanup must not resolve canonical resources");
    const authorization = createAuthorization(() => {
      throw new Error("revoked Grant must not block cleanup");
    });
    const policy = createPolicy({
      resolver,
      authorization,
      sessionBindings: row.sessionBindings,
    });

    const decision = row.decide(policy);

    expect(decision).toEqual({ allowed: true, binding: row.expectedBinding });
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.allowed) {
      expect(Object.isFrozen(decision.binding)).toBe(true);
    }
    expect(row.sessionBindings.calls).toEqual([row.expectedCall]);
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
    expect(authorization.calls).toEqual([]);
  });

  it.each([
    {
      target: "foreign terminal",
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideTerminalUnsubscribe({ terminalId: TERMINAL_ID }),
      expectedCall: `terminal:${TERMINAL_ID}`,
    },
    {
      target: "foreign Workspace",
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideWorkspaceUnsubscribe({ workspaceId: WORKSPACE_ID }),
      expectedCall: `workspace:${WORKSPACE_ID}`,
    },
  ])("returns the same non-enumerating false result for a $target", (row) => {
    const sessionBindings = new MemoryCurrentTerminalSessionBindings();
    const resolver = new MemoryCanonicalTerminalResolver([]);
    const authorization = createAuthorization();
    const policy = createPolicy({ sessionBindings, resolver, authorization });

    const decision = row.decide(policy);

    expect(decision).toEqual({ allowed: false });
    expect(Object.keys(decision)).toEqual(["allowed"]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(sessionBindings.calls).toEqual([row.expectedCall]);
    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
    expect(authorization.calls).toEqual([]);
  });

  it.each([
    {
      target: "terminal",
      configure(bindings: MemoryCurrentTerminalSessionBindings) {
        bindings.terminalError = new Error("foreign terminal secret");
      },
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideTerminalUnsubscribe({ terminalId: TERMINAL_ID }),
    },
    {
      target: "Workspace",
      configure(bindings: MemoryCurrentTerminalSessionBindings) {
        bindings.workspaceError = new Error("foreign Workspace secret");
      },
      decide: (policy: TerminalAuthorizationPolicy) =>
        policy.decideWorkspaceUnsubscribe({ workspaceId: WORKSPACE_ID }),
    },
  ])("fails $target cleanup binding lookup closed without throwing or leaking", (row) => {
    const sessionBindings = new MemoryCurrentTerminalSessionBindings();
    row.configure(sessionBindings);
    const policy = createPolicy({ sessionBindings });

    const decision = row.decide(policy);

    expect(decision).toEqual({ allowed: false });
    expect(JSON.stringify(decision)).not.toContain("secret");
  });

  it.each([
    {
      malformed: "terminal cleanup caller authority",
      decide: (policy: TerminalAuthorizationPolicy) =>
        Reflect.apply(policy.decideTerminalUnsubscribe, policy, [
          { terminalId: TERMINAL_ID, ownerPrincipalId: OTHER_PRINCIPAL_ID },
        ]),
    },
    {
      malformed: "Workspace cleanup caller cwd",
      decide: (policy: TerminalAuthorizationPolicy) =>
        Reflect.apply(policy.decideWorkspaceUnsubscribe, policy, [
          { workspaceId: WORKSPACE_ID, cwd: "/caller/selected" },
        ]),
    },
    {
      malformed: "Workspace cleanup missing workspaceId",
      decide: (policy: TerminalAuthorizationPolicy) =>
        Reflect.apply(policy.decideWorkspaceUnsubscribe, policy, [{}]),
    },
  ])("returns false for malformed $malformed without a binding lookup", (row) => {
    const sessionBindings = new MemoryCurrentTerminalSessionBindings(
      new Set([TERMINAL_ID]),
      new Set([WORKSPACE_ID]),
    );
    const policy = createPolicy({ sessionBindings });

    expect(row.decide(policy)).toEqual({ allowed: false });
    expect(sessionBindings.calls).toEqual([]);
  });

  it.each([
    { state: "unknown" as const, entries: [] },
    {
      state: "legacy" as const,
      entries: [{ state: "legacy" as const, terminalId: TERMINAL_ID }],
    },
    {
      state: "quarantined" as const,
      entries: [{ state: "quarantined" as const, terminalId: TERMINAL_ID }],
    },
  ])("returns the same non-enumerable error for a $state terminal", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver(row.entries);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeCapture(accessInput()));

    expect(String(error)).toBe("TerminalAuthorizationPolicyError: Terminal access denied.");
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it("rejects a cross-node terminal before authorization with the same error", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal({ nodeId: OTHER_NODE_ID }) },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(policy.authorizeInput(accessInput()));

    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it.each([
    { state: "unknown" as const, entries: [] },
    {
      state: "quarantined" as const,
      entries: [{ state: "quarantined" as const, terminalId: TERMINAL_ID }],
    },
  ])("rejects rename for a $state terminal without authorizing", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver(row.entries);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(policy.authorizeRename(accessInput()));

    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it("rejects rename for a cross-node terminal before authorization", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal({ nodeId: OTHER_NODE_ID }) },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(policy.authorizeRename(accessInput()));

    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it("maps a stale Grant rejection during rename to the uniform error", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization(() => {
      throw new Error("stale rename grant secret-eight");
    });
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(
      policy.authorizeRename({
        ...accessInput(),
        principal: principal({ grantVersion: "stale-grant" }),
      }),
    );

    expect(error.message).not.toContain("secret-eight");
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toHaveLength(1);
  });

  it("fails rename closed when its resolver throws", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    resolver.resolveError = new Error("rename registry path /private/rename");
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeRename(accessInput()));

    expect(error.message).not.toContain("/private/rename");
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it("fails rename closed when terminal.use authorization throws", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization(() => {
      throw new Error("rename authorization leaked org_fedcba9876543210");
    });
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeRename(accessInput()));

    expect(error.message).not.toContain(OTHER_ORGANIZATION_ID);
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toHaveLength(1);
  });

  it.each([
    {
      mismatch: "organization",
      authorizedWorkspace: workspace({ organizationId: OTHER_ORGANIZATION_ID }),
    },
    { mismatch: "node", authorizedWorkspace: workspace({ nodeId: OTHER_NODE_ID }) },
    {
      mismatch: "workspace",
      authorizedWorkspace: workspace({ workspaceId: OTHER_WORKSPACE_ID }),
    },
  ])("rejects an AuthorizedWorkspace $mismatch mismatch without leaking it", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization(() => row.authorizedWorkspace);
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeKill(accessInput()));

    expect(error.message).not.toContain(row.mismatch);
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toHaveLength(1);
  });

  it("maps stale Grant rejection to the same non-enumerable error", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization(() => {
      throw new Error("stale grant version grant-secret-seven");
    });
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(
      policy.authorizeSubscribe({
        ...accessInput(),
        principal: principal({ grantVersion: "stale-grant" }),
      }),
    );

    expect(error.message).not.toContain("grant-secret-seven");
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toHaveLength(1);
  });

  it("fails closed without leaking resolver errors or calling authorization", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    resolver.resolveError = new Error("registry exposed /private/terminal/path");
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeCapture(accessInput()));

    expect(error.message).not.toContain("/private/terminal/path");
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toEqual([]);
  });

  it("fails closed without leaking Workspace authorization errors", async () => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization(() => {
      throw new Error("organization org_fedcba9876543210 is forbidden");
    });
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeInput(accessInput()));

    expect(error.message).not.toContain(OTHER_ORGANIZATION_ID);
    expect(resolver.resolveCalls).toEqual([TERMINAL_ID]);
    expect(authorization.calls).toHaveLength(1);
  });

  it("fails a Workspace list closed when canonical enumeration throws", async () => {
    const events: string[] = [];
    const resolver = new MemoryCanonicalTerminalResolver([], events);
    resolver.listError = new Error("terminal registry unavailable");
    const authorization = createAuthorization(undefined, events);
    const policy = createPolicy({ resolver, authorization });

    const error = await expectDenied(policy.authorizeList(listInput()));

    expect(error.message).not.toContain("registry unavailable");
    expect(events).toEqual([`authorize:${WORKSPACE_ID}:terminal.use`, "list"]);
  });

  it.each([
    {
      entry: "create",
      authorize: (policy: TerminalAuthorizationPolicy) =>
        policy.authorizeCreate({
          ...createInput(),
          cwd: "/caller/selected",
          ownerPrincipalId: OTHER_PRINCIPAL_ID,
        }),
    },
    {
      entry: "list",
      authorize: (policy: TerminalAuthorizationPolicy) =>
        policy.authorizeList({
          ...listInput(),
          cwd: "/caller/selected",
          ownerPrincipalId: OTHER_PRINCIPAL_ID,
        }),
    },
    {
      entry: "workspace subscribe",
      authorize: (policy: TerminalAuthorizationPolicy) =>
        policy.authorizeWorkspaceSubscription({
          ...workspaceSubscriptionInput(),
          cwd: "/caller/selected",
          ownerPrincipalId: OTHER_PRINCIPAL_ID,
        }),
    },
    ...EXISTING_OPERATIONS.map((row) => ({
      entry: row.operation,
      authorize: (policy: TerminalAuthorizationPolicy) =>
        row.authorize(policy, {
          ...accessInput(),
          cwd: "/caller/selected",
          ownerPrincipalId: OTHER_PRINCIPAL_ID,
        }),
    })),
  ])("rejects caller cwd and owner fields at the $entry entry", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(row.authorize(policy));

    expect(resolver.resolveCalls).toEqual([]);
    expect(resolver.listCalls).toBe(0);
    expect(authorization.calls).toEqual([]);
  });

  it.each([
    {
      context: "PrincipalContext",
      input: { ...accessInput(), principal: principal({ principalId: "caller" }) },
    },
    { context: "NodeContext", input: { ...accessInput(), node: node("node-one") } },
  ])("runtime-rejects an invalid $context before resolver or authorization", async (row) => {
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: terminal() },
    ]);
    const authorization = createAuthorization();
    const policy = createPolicy({ resolver, authorization });

    await expectDenied(policy.authorizeSubscribe(row.input));

    expect(resolver.resolveCalls).toEqual([]);
    expect(authorization.calls).toEqual([]);
  });

  it("isolates caller mutation across async authorization and freezes returned clones", async () => {
    let releaseAuthorization: () => void = () => undefined;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const authorization = createAuthorization(async () => {
      await authorizationGate;
      return workspace();
    });
    const policy = createPolicy({ authorization });
    const input = createInput();
    const authorizing = policy.authorizeCreate(input);

    input.principal.organizationId = OTHER_ORGANIZATION_ID;
    input.principal.principalId = OTHER_PRINCIPAL_ID;
    input.node.nodeId = OTHER_NODE_ID;
    expect(Reflect.set(input, "workspaceId", OTHER_WORKSPACE_ID)).toBe(true);
    releaseAuthorization();

    const authorized = await authorizing;
    expect(authorized).toEqual({ operation: "create", workspace: workspace() });
    expect(authorization.calls).toEqual([
      {
        principal: principal(),
        action: "terminal.use",
        workspaceId: WORKSPACE_ID,
      },
    ]);
    expect(Reflect.set(authorized, "operation", "capture")).toBe(false);
    expect(Reflect.set(authorized.workspace, "workspaceId", OTHER_WORKSPACE_ID)).toBe(false);
    expect(
      Reflect.set(authorization.calls[0]?.principal ?? {}, "principalId", OTHER_PRINCIPAL_ID),
    ).toBe(false);
  });

  it("returns list clones that cannot be mutated into another Workspace or Node", async () => {
    const source = terminal();
    const resolver = new MemoryCanonicalTerminalResolver([
      { state: "canonical", terminal: source },
    ]);
    const policy = createPolicy({ resolver });
    const page = await policy.authorizeList(listInput());

    expect(Reflect.set(source, "workspaceId", OTHER_WORKSPACE_ID)).toBe(true);
    expect(Reflect.set(page.terminals[0] ?? {}, "workspaceId", OTHER_WORKSPACE_ID)).toBe(false);
    expect(Reflect.set(page.terminals, 0, terminal({ nodeId: OTHER_NODE_ID }))).toBe(false);
    expect(page.terminals).toEqual([terminal()]);
  });
});
