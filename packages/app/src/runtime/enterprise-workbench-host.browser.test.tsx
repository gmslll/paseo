import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseUnsignedAccessGate, EnterpriseWorkbenchHost } from "./enterprise-workbench-host";

const mocks = vi.hoisted(() => ({
  discoverEnterpriseManagement: vi.fn(),
  identitySnapshot: {
    state: "signed_out" as const,
    target: "legacy_passthrough" as "legacy_passthrough" | "enterprise_host",
  },
  lifecycle: { readSnapshot: () => mocks.identitySnapshot },
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    discoverEnterpriseManagement: mocks.discoverEnterpriseManagement,
  }),
  useHostEnterpriseIdentityLifecycle: () => mocks.lifecycle,
  useHostEnterpriseIdentitySnapshot: () => mocks.identitySnapshot,
  useHostRuntimeClient: () => null,
  useHosts: () => [{ serverId: "srv_managed" }],
}));

vi.mock("@/runtime/enterprise-workbench-assembly", () => ({
  createBrowserProfileProjectionHydrator: () => async () => undefined,
  isEnterpriseBrowserProfilesEnabled: () => false,
  isEnterpriseIdentityEnabled: () => false,
  isEnterpriseWorkbenchSignedIn: () => false,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: Record<string, never> }) => unknown) =>
    selector({ sessions: {} }),
}));

vi.mock("@/stores/enterprise/boss-resource-store", () => ({
  createBossResourceStore: () => {
    throw new Error("boss store should remain unavailable while disconnected");
  },
}));

vi.mock("@/stores/enterprise/pat-login-form-model", () => ({
  createPatLoginFormModel: () => ({}),
}));

vi.mock("@/components/enterprise/enterprise-identity-ui", () => ({
  EnterprisePasswordLoginForm: () => "password-login",
  EnterprisePatLoginForm: () => "pat-login",
}));

vi.mock("@/screens/enterprise/enterprise-workbench-screen", () => ({
  EnterpriseWorkbenchContainer: () => "enterprise-workbench",
}));

vi.mock("@/screens/enterprise/enterprise-ui-port", () => ({
  createEnterpriseUiBundle: () => {
    throw new Error("enterprise bundle should remain unavailable while disconnected");
  },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.identitySnapshot.state = "signed_out";
  mocks.identitySnapshot.target = "legacy_passthrough";
  mocks.discoverEnterpriseManagement.mockResolvedValue({
    mode: "managed",
    managementBaseUrl: "https://management.test:17443",
    nodeId: "nod_aaaaaaaaaaaaaaaa",
    paseoServerId: "srv_managed",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("EnterpriseUnsignedAccessGate", () => {
  it("does not render host children while managed-node discovery is pending", async () => {
    mocks.discoverEnterpriseManagement.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      root.render(
        <EnterpriseUnsignedAccessGate serverId="srv_managed">
          open-project
        </EnterpriseUnsignedAccessGate>,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toBe("");
  });

  it("shows account login for a managed node that still looks like legacy passthrough", async () => {
    await act(async () => {
      root.render(
        <EnterpriseUnsignedAccessGate serverId="srv_managed">
          open-project
        </EnterpriseUnsignedAccessGate>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toBe("password-login");
  });
});

describe("EnterpriseWorkbenchHost", () => {
  it("shows account login after discovering a disconnected managed node", async () => {
    mocks.identitySnapshot.target = "enterprise_host";
    await act(async () => {
      root.render(<EnterpriseWorkbenchHost serverId="srv_managed" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.discoverEnterpriseManagement).toHaveBeenCalledWith(
      "srv_managed",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toBe("password-login");
  });
});
