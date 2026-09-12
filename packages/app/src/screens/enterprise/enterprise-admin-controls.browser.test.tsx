/* oxlint-disable react/display-name, react/jsx-no-useless-fragment, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserBindingFormModel } from "./forms/browser-binding-form-model";
import { createGrantEditorFormModel } from "./forms/grant-editor-form-model";
import { EnterpriseAdminControls } from "./enterprise-admin-controls";

const ORGANIZATION_ID = "org_1111111111111111";
const NODE_ID = "nod_1111111111111111";
const ADMIN_ID = "usr_1111111111111111";
const EMPLOYEE_ID = "usr_2222222222222222";
const PROFILE_ID = "brp_1111111111111111";
const WORKSPACE_ID = "workspace-1";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
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
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress, disabled, loading, testID }: any) => (
    <button data-testid={testID} disabled={disabled || loading} onClick={onPress} type="button">
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/ui/select-field", () => ({
  SelectField: ({ value, options, onChange, testID, disabled }: any) => (
    <select
      data-testid={testID}
      disabled={disabled}
      value={value ?? ""}
      onChange={(event) => {
        const option = options.find((candidate: any) => candidate.value === event.target.value);
        if (option) onChange(option.value, { label: option.label });
      }}
    >
      <option value="" />
      {options.map((option: any) => (
        <option key={option.id} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: ({ value, onValueChange, disabled, testID }: any) => (
    <input
      data-testid={testID}
      type="checkbox"
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.checked)}
    />
  ),
}));

function createBossStore() {
  const snapshot = {
    metadata: {
      status: "loaded" as const,
      requestId: "metadata-1",
      sessionGeneration: "generation-1",
      principals: [],
      resources: [
        {
          resourceKind: "workspace" as const,
          organizationId: ORGANIZATION_ID,
          nodeId: NODE_ID,
          workspaceId: WORKSPACE_ID,
          ownerPrincipalId: ADMIN_ID,
          label: "Customer support",
          status: "ready",
          updatedAt: "2026-09-12T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    },
    detail: { status: "not_requested" as const },
    content: { status: "not_requested" as const },
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    loadMetadata: vi.fn(async () => ({ ok: true as const })),
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
  vi.clearAllMocks();
});

describe("EnterpriseAdminControls", () => {
  it("loads employees, edits a workspace grant, and binds a browser profile", async () => {
    let requestCounter = 0;
    const createRequestId = () => `request-${++requestCounter}`;
    const grantUpdates: any[] = [];
    const browserBindings: any[] = [];
    const createGrantEditor = vi.fn((principalId: string) =>
      createGrantEditorFormModel({
        principalId,
        sessionGeneration: "generation-1",
        port: {
          listGrants: async (input) => ({
            requestId: input.requestId,
            principalId,
            grants: [],
            revision: "revision-1",
          }),
          updateGrants: async (input) => {
            grantUpdates.push(input);
            return {
              requestId: input.requestId,
              principalId,
              grants: input.grants,
              revision: "revision-2",
            };
          },
        },
      }),
    );
    const createBrowserBinding = vi.fn((workspace: any) =>
      createBrowserBindingFormModel({
        workspaceId: workspace.workspaceId,
        organizationId: workspace.organizationId,
        nodeId: workspace.nodeId,
        sessionGeneration: "generation-1",
        port: {
          listProfiles: async (input) => ({
            requestId: input.requestId,
            profiles: [
              {
                browserProfileId: PROFILE_ID,
                organizationId: ORGANIZATION_ID,
                homeNodeId: NODE_ID,
                ownerPrincipalId: ADMIN_ID,
                platform: "generic",
                label: "Support browser",
                status: "ready",
              },
            ],
            bindings: [],
          }),
          bindProfile: async (input) => {
            browserBindings.push(input);
            return {
              requestId: input.requestId,
              binding: {
                organizationId: ORGANIZATION_ID,
                nodeId: NODE_ID,
                workspaceId: WORKSPACE_ID,
                browserProfileId: input.browserProfileId,
                boundAt: "2026-09-12T00:00:00.000Z",
              },
            };
          },
        },
      }),
    );

    await act(async () => {
      root.render(
        <EnterpriseAdminControls
          principalPort={{
            listPrincipals: async ({ requestId }) => ({
              requestId,
              principals: [
                {
                  principalType: "human",
                  principalId: ADMIN_ID,
                  organizationId: ORGANIZATION_ID,
                  displayName: "Administrator",
                  status: "active",
                  createdAt: "2026-09-12T00:00:00.000Z",
                  updatedAt: "2026-09-12T00:00:00.000Z",
                },
                {
                  principalType: "human",
                  principalId: EMPLOYEE_ID,
                  organizationId: ORGANIZATION_ID,
                  displayName: "Employee One",
                  status: "active",
                  createdAt: "2026-09-12T00:00:00.000Z",
                  updatedAt: "2026-09-12T00:00:00.000Z",
                },
              ],
            }),
          }}
          bossStore={createBossStore()}
          generation="generation-1"
          currentPrincipalId={ADMIN_ID}
          organizationId={ORGANIZATION_ID}
          createGrantEditor={createGrantEditor}
          createBrowserBinding={createBrowserBinding}
          canViewPrincipals
          canViewGrants
          canManageGrants
          canViewProfiles
          canBindProfiles
          createRequestId={createRequestId}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createGrantEditor).toHaveBeenCalledWith(EMPLOYEE_ID);
    expect(container.textContent).toContain("Employee One");
    expect(container.textContent).toContain("Customer support");

    act(() => {
      const scope = container.querySelector(
        '[data-testid="enterprise-admin-grant-scope"]',
      ) as HTMLSelectElement;
      scope.value = `workspace:${WORKSPACE_ID}`;
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      const permission = container.querySelector(
        '[data-testid="enterprise-admin-grant-workspace.content.read"]',
      ) as HTMLInputElement;
      permission.click();
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="enterprise-admin-save-grants"]') as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(grantUpdates).toHaveLength(1);
    expect(grantUpdates[0].grants).toEqual([
      {
        action: "workspace.content.read",
        selector: { kind: "workspace", workspaceIds: [WORKSPACE_ID] },
      },
    ]);
    expect(container.textContent).toContain("Permissions saved.");

    act(() => {
      const profile = container.querySelector(
        '[data-testid="enterprise-admin-browser-profile"]',
      ) as HTMLSelectElement;
      profile.value = PROFILE_ID;
      profile.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="enterprise-admin-bind-profile"]') as HTMLElement
      ).click();
      await Promise.resolve();
    });
    expect(browserBindings).toHaveLength(1);
    expect(browserBindings[0].browserProfileId).toBe(PROFILE_ID);
    expect(container.textContent).toContain("Browser profile bound.");
  });

  it("shows a retry action when the account directory is unavailable", async () => {
    const listPrincipals = vi.fn(async () => Promise.reject(new Error("offline")));
    await act(async () => {
      root.render(
        <EnterpriseAdminControls
          principalPort={{ listPrincipals }}
          bossStore={createBossStore()}
          generation="generation-1"
          currentPrincipalId={ADMIN_ID}
          organizationId={ORGANIZATION_ID}
          createGrantEditor={() => {
            throw new Error("no principal should be selected");
          }}
          canViewPrincipals
          canViewGrants
          canManageGrants
          canViewProfiles={false}
          canBindProfiles={false}
          createRequestId={() => "directory-1"}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Could not load enterprise accounts.");
    expect(container.textContent).toContain("Retry");
    expect(listPrincipals).toHaveBeenCalledOnce();
  });
});
