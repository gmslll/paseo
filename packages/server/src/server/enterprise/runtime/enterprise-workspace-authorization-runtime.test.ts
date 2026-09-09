import type {
  AuthorizedWorkspace,
  EnterpriseAction,
  NodeContext,
  PrincipalContext,
  ResourceAuthorization,
} from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import type {
  AuthorizedTerminalAccess,
  AuthorizedTerminalCreate,
  AuthorizedTerminalListPage,
} from "./terminal-authorization-policy.js";
import { EnterpriseWorkspaceAuthorizationRuntime } from "./enterprise-workspace-authorization-runtime.js";

const WORKSPACE_ID = "workspace-one";
const TERMINAL_ID = "terminal-one";

function principal(): PrincipalContext {
  return {
    principalType: "human",
    principalId: "usr_0123456789abcdef",
    organizationId: "org_0123456789abcdef",
    credentialId: "credential-one",
    grantVersion: "grant-one",
    grants: [],
  };
}

function node(): NodeContext {
  return { nodeId: "nod_0123456789abcdef", paseoServerId: "server-one", mode: "standalone" };
}

function workspace(): AuthorizedWorkspace {
  return {
    organizationId: principal().organizationId,
    nodeId: node().nodeId,
    ownerPrincipalId: principal().principalId,
    createdByPrincipalId: principal().principalId,
    workspaceId: WORKSPACE_ID,
  };
}

class TestTerminalPolicy {
  public readonly calls: unknown[] = [];

  public async authorizeCreate(input: unknown): Promise<AuthorizedTerminalCreate> {
    this.calls.push(input);
    return { operation: "create", workspace: workspace() };
  }

  public async authorizeList(input: { scope: string }): Promise<AuthorizedTerminalListPage> {
    this.calls.push(input);
    if (input.scope === "global") throw new Error("terminal access denied");
    return {
      operation: "list",
      workspace: workspace(),
      terminals: [],
      offset: 0,
      limit: 20,
      total: 0,
      nextOffset: null,
    };
  }

  public async authorizeSubscribe(input: unknown): Promise<AuthorizedTerminalAccess> {
    return this.access("subscribe", input);
  }
  public async authorizeInput(input: unknown): Promise<AuthorizedTerminalAccess> {
    return this.access("input", input);
  }
  public async authorizeRename(input: unknown): Promise<AuthorizedTerminalAccess> {
    return this.access("rename", input);
  }
  public async authorizeKill(input: unknown): Promise<AuthorizedTerminalAccess> {
    return this.access("kill", input);
  }
  public async authorizeCapture(input: unknown): Promise<AuthorizedTerminalAccess> {
    return this.access("capture", input);
  }
  public async authorizeWorkspaceSubscription(input: unknown): Promise<AuthorizedWorkspace> {
    this.calls.push(input);
    return workspace();
  }

  private access(
    operation: AuthorizedTerminalAccess["operation"],
    input: unknown,
  ): AuthorizedTerminalAccess {
    this.calls.push(input);
    return {
      operation,
      workspace: workspace(),
      terminal: { terminalId: TERMINAL_ID, workspaceId: WORKSPACE_ID, nodeId: node().nodeId },
    };
  }
}

class TestAuthorization implements Pick<ResourceAuthorization, "assertWorkspace"> {
  public readonly calls: Array<{ action: EnterpriseAction; workspaceId: string }> = [];

  public async assertWorkspace(
    _principal: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace> {
    this.calls.push({ action, workspaceId });
    return workspace();
  }
}

function createHarness() {
  const terminalPolicy = new TestTerminalPolicy();
  const authorization = new TestAuthorization();
  let current = true;
  const runtime = new EnterpriseWorkspaceAuthorizationRuntime({
    context: { principal: principal(), node: node(), sessionBindingGeneration: "generation-one" },
    isCurrent: () => current,
    terminalPolicy,
    authorization,
  });
  return { authorization, runtime, terminalPolicy, revoke: () => (current = false) };
}

describe("EnterpriseWorkspaceAuthorizationRuntime", () => {
  it("passes only canonical context and terminalId to terminal authorization", async () => {
    const { runtime, terminalPolicy } = createHarness();

    await runtime.authorizeTerminalInput({ terminalId: TERMINAL_ID, requestId: "request-one" });

    expect(terminalPolicy.calls).toEqual([
      { principal: principal(), node: node(), terminalId: TERMINAL_ID },
    ]);
  });

  it("rejects caller cwd and global terminal list before policy access", async () => {
    const { runtime, terminalPolicy } = createHarness();

    await expect(
      runtime.authorizeTerminalCreate({
        workspaceId: WORKSPACE_ID,
        requestId: "request-one",
        cwd: "/caller/root",
      }),
    ).rejects.toThrow();
    await expect(runtime.denyGlobalTerminalList({ requestId: "request-two" })).rejects.toThrow();
    expect(terminalPolicy.calls).toEqual([
      expect.objectContaining({ scope: "global", principal: principal(), node: node() }),
    ]);
  });

  it("authorizes scripts and workspace provider history with their exact actions", async () => {
    const { authorization, runtime } = createHarness();

    await runtime.authorizeWorkspaceScript({
      workspaceId: WORKSPACE_ID,
      scriptName: "dev",
      requestId: "request-script",
    });
    await runtime.authorizeProviderHistory({
      scope: "workspace",
      workspaceId: WORKSPACE_ID,
      requestId: "request-history",
    });

    expect(authorization.calls).toEqual([
      { action: "workspace.script.execute", workspaceId: WORKSPACE_ID },
      { action: "provider.history.read", workspaceId: WORKSPACE_ID },
    ]);
  });

  it("denies global provider history without consulting ResourceAuthorization", async () => {
    const { authorization, runtime } = createHarness();

    await expect(
      runtime.authorizeProviderHistory({ scope: "global", requestId: "request-global" }),
    ).rejects.toThrow("access denied");
    expect(authorization.calls).toHaveLength(0);
  });

  it("fails closed after generation replacement before policy access", async () => {
    const { authorization, revoke, runtime, terminalPolicy } = createHarness();
    revoke();

    await expect(
      runtime.authorizeTerminalCreate({ workspaceId: WORKSPACE_ID, requestId: "request-one" }),
    ).rejects.toThrow("access denied");
    await expect(
      runtime.authorizeWorkspaceScript({
        workspaceId: WORKSPACE_ID,
        scriptName: "dev",
        requestId: "request-two",
      }),
    ).rejects.toThrow("access denied");
    expect(terminalPolicy.calls).toHaveLength(0);
    expect(authorization.calls).toHaveLength(0);
  });

  it("captures mutable dependencies at construction", async () => {
    const { authorization, runtime, terminalPolicy } = createHarness();
    terminalPolicy.authorizeInput = async () => {
      throw new Error("mutated terminal policy");
    };
    authorization.assertWorkspace = async () => {
      throw new Error("mutated authorization");
    };

    await expect(
      runtime.authorizeTerminalInput({ terminalId: TERMINAL_ID, requestId: "request-one" }),
    ).resolves.toMatchObject({ operation: "input" });
    await expect(
      runtime.authorizeWorkspaceScript({
        workspaceId: WORKSPACE_ID,
        scriptName: "dev",
        requestId: "request-two",
      }),
    ).resolves.toMatchObject({ workspaceId: WORKSPACE_ID });
  });

  it("deeply snapshots canonical session context at construction", async () => {
    const terminalPolicy = new TestTerminalPolicy();
    const authorization = new TestAuthorization();
    const context = {
      principal: principal(),
      node: node(),
      sessionBindingGeneration: "generation-one",
    };
    const runtime = new EnterpriseWorkspaceAuthorizationRuntime({
      context,
      isCurrent: () => true,
      terminalPolicy,
      authorization,
    });

    context.principal.principalId = "usr_mutated00000000";
    context.node.nodeId = "nod_mutated00000000";

    await runtime.authorizeTerminalInput({ terminalId: TERMINAL_ID, requestId: "request-one" });

    expect(terminalPolicy.calls).toEqual([
      { principal: principal(), node: node(), terminalId: TERMINAL_ID },
    ]);
  });
});
