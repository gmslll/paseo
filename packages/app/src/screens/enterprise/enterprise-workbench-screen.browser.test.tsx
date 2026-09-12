/* oxlint-disable react/display-name, react/jsx-no-useless-fragment, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseWorkbenchScreen } from "./enterprise-workbench-screen";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { xl: 12 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { medium: "500" },
    colors: {
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      palette: { red: { 300: "#f66" }, green: { 400: "#4ade80" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    loading,
    testID,
  }: {
    children: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    loading?: boolean;
    testID?: string;
  }) => (
    <button data-testid={testID} disabled={disabled || loading} onClick={onPress} type="button">
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/select-field", () => ({
  SelectField: () => null,
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: () => null,
}));
vi.mock("@/components/enterprise/enterprise-identity-ui", () => ({
  EnterpriseIdentityNavigation: ({
    projection,
    onNavigate,
  }: {
    projection: { navigation?: readonly string[] };
    onNavigate?: (value: string) => void;
  }) => (
    <div>
      {(projection.navigation ?? []).map((destination) => (
        <button
          data-testid={`enterprise-nav-${destination}`}
          key={destination}
          onClick={() => onNavigate?.(destination)}
          type="button"
        >
          {destination}
        </button>
      ))}
    </div>
  ),
  EnterprisePatLoginForm: () => <div>login</div>,
  EnterpriseCapabilityGate: ({
    capability,
    children,
  }: {
    capability: { enterpriseIdentityV1?: boolean };
    children: React.ReactNode;
  }) =>
    capability.enterpriseIdentityV1 ? <>{children}</> : <div>Enterprise sign-in unavailable</div>,
  EnterpriseResourceStatus: ({ projection }: { projection: unknown }) => {
    if (typeof projection !== "object" || projection === null || !("status" in projection))
      return null;
    const status = (projection as { status?: unknown }).status;
    return typeof status === "string" &&
      [
        "ready",
        "resource_waiting",
        "login_required",
        "mfa_required",
        "risk_control",
        "disabled",
      ].includes(status) ? (
      <div data-testid="resource-status">{status}</div>
    ) : null;
  },
}));

const identity = {
  target: "enterprise_host",
  state: "signed_in",
  serverId: "server-a",
  projection: {
    principalType: "human",
    principalId: "usr_0123456789abcdef",
    organizationId: "org_0123456789abcdef",
    nodeId: "nod_0123456789abcdef",
    paseoServerId: "server-a",
    grantVersion: "grant-v1",
    navigation: ["identity"],
    allowedOperations: [
      "organization.resources.view",
      "access.grants.view",
      "browser.profiles.view",
      "identity.logout_all",
    ],
  },
};

const resource = {
  resourceKind: "agent",
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  agentId: "agt_0123456789abcdef",
  workspaceId: "wsp_0123456789abcdef",
  ownerPrincipalId: "usr_0123456789abcdef",
  label: "Agent one",
  status: "ready",
  provider: "codex",
  model: null,
  startedAt: "2026-09-10T00:00:00Z",
  lastActivityAt: "2026-09-10T00:00:00Z",
  durationMs: 0,
};

function createBossStore(resources: readonly (typeof resource)[] = [resource]) {
  let snapshot: any = {
    metadata: { status: "not_requested" },
    detail: { status: "not_requested" },
    content: { status: "not_requested" },
  };
  const listeners = new Set<() => void>();
  const publish = (next: any) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const clearSensitiveState = vi.fn(() =>
    publish({
      metadata: { status: "not_requested" },
      detail: { status: "not_requested" },
      content: { status: "not_requested" },
    }),
  );
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadMetadata: vi.fn(async () => {
      publish({
        metadata: {
          status: "loaded",
          requestId: "r1",
          sessionGeneration: "g1",
          principals: [],
          resources,
          nextCursor: null,
        },
        detail: { status: "not_requested" },
        content: { status: "not_requested" },
      });
      return { ok: true };
    }),
    selectDetail: vi.fn((selectedRef: any) => {
      publish({
        ...snapshot,
        detail: {
          status: "loaded",
          resource: selectedRef,
          sessionGeneration: "g1",
          metadata: resources.find(
            (candidate) => selectedRef.localResourceId === candidate.agentId,
          ),
        },
      });
      return { ok: true };
    }),
    openContent: vi.fn(async () => {
      publish({
        ...snapshot,
        content: {
          status: "loaded",
          resource: {
            organizationId: resource.organizationId,
            nodeId: resource.nodeId,
            resourceKind: "agent",
            localResourceId: resource.agentId,
          },
          requestId: "c1",
          sessionGeneration: "g1",
          value: "approved body",
        },
      });
      return { ok: true };
    }),
    clearSensitiveState,
  } as any;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("enterprise workbench screen", () => {
  it("loads metadata and opens content only after explicit selection", async () => {
    const bossStore = createBossStore();
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => undefined),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          patModel={{} as any}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
          renderContent={(value) => <span>{String(value)}</span>}
        />,
      ),
    );
    expect(container.textContent).not.toContain("approved body");
    await act(async () => {
      (
        container.querySelector('[data-testid="enterprise-boss-load-metadata"]') as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Agent one");
    expect(bossStore.openContent).not.toHaveBeenCalled();
    act(() => {
      (
        container.querySelector(
          '[data-testid="enterprise-boss-select-org_0123456789abcdef:nod_0123456789abcdef:agent:agt_0123456789abcdef"]',
        ) as HTMLElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="enterprise-boss-open-org_0123456789abcdef:nod_0123456789abcdef:agent:agt_0123456789abcdef"]',
        ) as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(bossStore.openContent).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("approved body");
  });

  it("keys and selects Boss resources by the complete GlobalResourceRef", async () => {
    const secondResource = { ...resource, nodeId: "nod_abcdef0123456789" };
    const bossStore = createBossStore([resource, secondResource]);
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => undefined),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    await act(async () => {
      (
        container.querySelector('[data-testid="enterprise-boss-load-metadata"]') as HTMLElement
      ).click();
      await Promise.resolve();
    });
    const rows = container.querySelectorAll('[data-testid^="enterprise-boss-select-"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-testid")).not.toBe(rows[1]?.getAttribute("data-testid"));
    act(() => (rows[1] as HTMLElement).click());
    expect(bossStore.selectDetail).toHaveBeenLastCalledWith({
      organizationId: resource.organizationId,
      nodeId: secondResource.nodeId,
      resourceKind: "agent",
      localResourceId: secondResource.agentId,
    });
  });

  it("clears sensitive store state before a rejected logout", async () => {
    const bossStore = createBossStore();
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => {
        throw new Error("offline");
      }),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          patModel={{} as any}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    await act(async () => {
      (container.querySelector('[data-testid="enterprise-logout-current"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(bossStore.clearSensitiveState).toHaveBeenCalledOnce();
    expect(uiPort.logoutCurrent).toHaveBeenCalledOnce();
  });

  it("routes all four identity states without opening PAT for booting or unavailable", () => {
    const bossStore = createBossStore();
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => undefined),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    const render = (state: string, target = "enterprise_host") =>
      act(() =>
        root.render(
          <EnterpriseWorkbenchScreen
            capability={{
              enterpriseIdentityV1: true,
              enterpriseResourceAuthorizationV1: true,
              enterpriseBrowserProfilesV1: true,
            }}
            identity={{ target, state, serverId: "server-a" }}
            patModel={{} as never}
            bossStore={bossStore}
            generation="g1"
            uiPort={uiPort}
            legacyContent={<span>legacy</span>}
          />,
        ),
      );
    render("booting");
    expect(container.textContent).toContain("Loading enterprise identity");
    render("unavailable");
    expect(container.textContent).toContain("Enterprise identity unavailable");
    expect(uiPort.authenticatePat).not.toHaveBeenCalled();
    const throwingCapability = new Proxy(
      { enterpriseIdentityV1: true },
      {
        ownKeys: () => {
          throw new Error("capability ownKeys failed");
        },
      },
    );
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={throwingCapability}
          identity={{ target: "enterprise_host", state: "signed_out", serverId: "server-a" }}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.textContent).toContain("Enterprise sign-in unavailable");
    expect(uiPort.authenticatePat).not.toHaveBeenCalled();
    render("signed_out");
    expect(container.textContent).toContain("login");
    render("signed_out", "legacy_passthrough");
    expect(container.textContent).toBe("legacy");
  });

  it("captures identity fields once and fails closed for malformed records", () => {
    const bossStore = createBossStore();
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => undefined),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    let descriptorReads = 0;
    const changingIdentity = new Proxy(
      {
        target: "enterprise_host",
        serverId: "server-a",
        state: "signed_out",
      },
      {
        get() {
          throw new Error("identity getter should not run");
        },
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={changingIdentity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(descriptorReads).toBe(3);
    expect(container.textContent).toContain("login");

    const projectionInput = {
      ...identity.projection,
      navigation: ["identity"],
      allowedOperations: ["organization.resources.view"],
    };
    const signedInInput = {
      target: "enterprise_host",
      state: "signed_in",
      serverId: "server-a",
      projection: projectionInput,
    };
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={signedInInput}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    projectionInput.navigation.splice(0, 1, "audit");
    expect(container.querySelector('[data-testid="enterprise-nav-identity"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="enterprise-nav-audit"]')).toBeNull();

    const throwingOwnKeys = new Proxy(
      { target: "enterprise_host", state: "signed_out", serverId: "server-a" },
      {
        ownKeys: () => {
          throw new Error("ownKeys failed");
        },
      },
    );
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={throwingOwnKeys}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.textContent).toBe("");

    const accessorIdentity: Record<string, unknown> = {
      target: "enterprise_host",
      serverId: "server-a",
    };
    Object.defineProperty(accessorIdentity, "state", {
      enumerable: true,
      get: () => "signed_out",
    });
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={accessorIdentity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.textContent).toBe("");

    const inheritedIdentity = Object.create({ target: "enterprise_host" });
    Object.assign(inheritedIdentity, { state: "signed_out", serverId: "server-a" });
    Object.defineProperty(inheritedIdentity, "future", { value: "secret", enumerable: false });
    inheritedIdentity[Symbol("future")] = "secret";
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={inheritedIdentity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.textContent).toBe("");

    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={{
            target: "enterprise_host",
            state: "signed_out",
            serverId: "",
            unexpected: "secret",
          }}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.textContent).toBe("");
    expect(uiPort.authenticatePat).not.toHaveBeenCalled();
  });

  it("renders all six resource states while ignoring malformed and secret fields", () => {
    const bossStore = createBossStore();
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => undefined),
      logoutAll: vi.fn(async () => undefined),
      refreshScope: vi.fn(async () => undefined),
    };
    const statuses = [
      "ready",
      "resource_waiting",
      "login_required",
      "mfa_required",
      "risk_control",
      "disabled",
    ].map((status) => ({ status, holderPrincipalId: "secret-holder" }));
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          resourceStatuses={[...statuses, { status: "unknown", futureSecret: "secret" }, null]}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-testid="resource-status"]').length).toBe(6);
    expect(container.textContent).not.toContain("secret");
  });

  it("gates Boss/admin/logout-all by parsed allowed operations and wires refresh without closing models", () => {
    const bossStore = createBossStore();
    const order: string[] = [];
    const uiPort = {
      authenticatePat: vi.fn(),
      logoutCurrent: vi.fn(async () => {
        order.push("logout");
      }),
      logoutAll: vi.fn(async () => {
        order.push("logout-all");
        throw new Error("logout all rejected");
      }),
      refreshScope: vi.fn(async () => {
        order.push("port-refresh");
      }),
    };
    const grantSnapshot = {
      status: "open",
      server: { status: "loaded" },
      draft: [],
      mutation: { status: "idle" },
      canEdit: true,
      canSubmit: true,
    };
    const grantEditor = {
      getSnapshot: () => grantSnapshot,
      subscribe: () => () => undefined,
      load: vi.fn(),
      submit: vi.fn(),
      refreshScope: vi.fn(() => order.push("grant-refresh")),
      close: vi.fn(),
    } as any;
    const browserSnapshot = {
      status: "open",
      server: { status: "loaded", profiles: [], binding: null },
      draftBrowserProfileId: "p",
      mutation: { status: "idle" },
      canEdit: true,
      canSubmit: true,
    };
    const browserBinding = {
      getSnapshot: () => browserSnapshot,
      subscribe: () => () => undefined,
      load: vi.fn(),
      submit: vi.fn(),
      refreshScope: vi.fn(() => order.push("browser-refresh")),
      close: vi.fn(),
    } as any;
    const limited = {
      ...identity,
      projection: { ...identity.projection, allowedOperations: ["organization.resources.view"] },
    };
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: false,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          grantEditor={grantEditor}
          browserBinding={browserBinding}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="enterprise-boss-metadata"]')).toBeNull();
    expect(container.querySelector('[data-testid="enterprise-admin-projections"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="enterprise-admin-load-grants"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="enterprise-admin-load-profiles"]'),
    ).not.toBeNull();
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: false,
          }}
          identity={identity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          grantEditor={grantEditor}
          browserBinding={browserBinding}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="enterprise-admin-load-grants"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="enterprise-admin-load-profiles"]')).toBeNull();
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={limited}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          grantEditor={grantEditor}
          browserBinding={browserBinding}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="enterprise-admin-projections"]')).toBeNull();
    expect(container.querySelector('[data-testid="enterprise-logout-all"]')).toBeNull();
    act(() =>
      root.render(
        <EnterpriseWorkbenchScreen
          capability={{
            enterpriseIdentityV1: true,
            enterpriseResourceAuthorizationV1: true,
            enterpriseBrowserProfilesV1: true,
          }}
          identity={identity}
          patModel={{} as never}
          bossStore={bossStore}
          generation="g1"
          uiPort={uiPort}
          grantEditor={grantEditor}
          browserBinding={browserBinding}
          legacyContent={<span>legacy</span>}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="enterprise-admin-projections"]')).not.toBeNull();
    (
      container.querySelector('[data-testid="enterprise-admin-load-grants"]') as HTMLElement
    ).click();
    (
      container.querySelector('[data-testid="enterprise-admin-save-grants"]') as HTMLElement
    ).click();
    (
      container.querySelector('[data-testid="enterprise-admin-load-profiles"]') as HTMLElement
    ).click();
    (
      container.querySelector('[data-testid="enterprise-admin-bind-profile"]') as HTMLElement
    ).click();
    expect(grantEditor.load).toHaveBeenCalledOnce();
    expect(grantEditor.submit).toHaveBeenCalledOnce();
    expect(browserBinding.load).toHaveBeenCalledOnce();
    expect(browserBinding.submit).toHaveBeenCalledOnce();
    act(() =>
      (container.querySelector('[data-testid="enterprise-refresh-scope"]') as HTMLElement).click(),
    );
    expect(grantEditor.close).not.toHaveBeenCalled();
    expect(grantEditor.refreshScope).toHaveBeenCalledOnce();
    act(() =>
      (container.querySelector('[data-testid="enterprise-logout-all"]') as HTMLElement).click(),
    );
    expect(order).toEqual([
      "grant-refresh",
      "browser-refresh",
      "port-refresh",
      "grant-refresh",
      "browser-refresh",
      "logout-all",
    ]);
    act(() => {
      (
        container.querySelector('[data-testid="enterprise-admin-load-grants"]') as HTMLElement
      ).click();
      (
        container.querySelector('[data-testid="enterprise-admin-bind-profile"]') as HTMLElement
      ).click();
    });
    expect(grantEditor.load).toHaveBeenCalledTimes(2);
    expect(browserBinding.submit).toHaveBeenCalledTimes(2);
  });
});
