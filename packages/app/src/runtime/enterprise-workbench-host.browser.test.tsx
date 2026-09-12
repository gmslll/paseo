import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnterpriseWorkbenchHost } from "./enterprise-workbench-host";

const mocks = vi.hoisted(() => ({
  discoverEnterpriseManagement: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    discoverEnterpriseManagement: mocks.discoverEnterpriseManagement,
  }),
  useHostEnterpriseIdentityLifecycle: () => ({
    readSnapshot: () => ({ state: "signed_out", target: "enterprise_host" }),
  }),
  useHostEnterpriseIdentitySnapshot: () => ({ state: "signed_out", target: "enterprise_host" }),
  useHostRuntimeClient: () => null,
  useHostRuntimeSnapshot: () => ({ activeConnection: null, clientGeneration: 0 }),
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

describe("EnterpriseWorkbenchHost", () => {
  it("shows account login after discovering a disconnected managed node", async () => {
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
