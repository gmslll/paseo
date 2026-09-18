import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EnterpriseWorkbenchContainer,
  type EnterpriseWorkbenchContainerProps,
} from "./enterprise-workbench-screen";

vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: (value: unknown) => value } }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("@/components/ui/status-badge", () => ({ StatusBadge: () => null }));
vi.mock("@/components/enterprise/enterprise-identity-ui", () => ({
  EnterprisePatLoginForm: () => <div data-testid="pat-login">login</div>,
  EnterpriseCapabilityGate: ({ children }: { children: React.ReactNode }) => children,
  EnterpriseIdentityNavigation: () => null,
  EnterpriseResourceStatus: () => null,
}));

describe("EnterpriseWorkbenchContainer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mounts signed-out lifecycle as PAT login without exposing credentials", () => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const snapshot = Object.freeze({ state: "signed_out", target: "enterprise_host" });
    const lifecycle = {
      readSnapshot: () => snapshot,
      subscribe: (listener: (snapshot: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      authenticateEnterpriseHost: vi.fn(),
      logoutCurrent: vi.fn(),
      logoutAll: vi.fn(),
    } as never;
    const props = {
      serverId: "server-a",
      lifecycle,
      daemonClient: { requestEnterprise: vi.fn() } as never,
      contentReaders: {
        workspace: vi.fn(),
        agent: vi.fn(),
        browserProfile: vi.fn(),
        appSlot: vi.fn(),
      },
      capability: { enterpriseIdentityV1: true },
      patModel: {} as never,
      bossStore: {} as never,
      legacyContent: <span>legacy</span>,
    } as unknown as EnterpriseWorkbenchContainerProps<string, unknown>;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<EnterpriseWorkbenchContainer {...props} />));
    expect(host.textContent).toContain("login");
    expect(JSON.stringify(props)).not.toContain("token");
    act(() => root.unmount());
    host.remove();
    expect(listeners.size).toBe(0);
  });
});
