/* oxlint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop, react/button-has-type, react/display-name */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPatLoginFormModel } from "@/stores/enterprise/pat-login-form-model";
import {
  EnterpriseCapabilityGate,
  EnterpriseIdentityNavigation,
  EnterprisePatLoginForm,
  EnterpriseResourceStatus,
} from "./enterprise-identity-ui";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { lg: 8, xl: 12, full: 999 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500" },
    colors: {
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      surface3: "#333",
      statusSuccess: "#0a0",
      statusWarning: "#a60",
      statusDanger: "#c00",
      palette: { red: { 300: "#f66" } },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
  // eslint-disable-next-line react/display-name
  FormTextInput: React.forwardRef(
    (
      {
        onChangeText,
        testID,
        editable,
        secureTextEntry,
        ...props
      }: {
        onChangeText?: (value: string) => void;
        testID?: string;
        editable?: boolean;
        secureTextEntry?: boolean;
      } & React.InputHTMLAttributes<HTMLInputElement>,
      ref,
    ) => {
      const inputRef = React.useRef<HTMLInputElement>(null);
      React.useImperativeHandle(ref, () => ({
        reset: () => {
          if (inputRef.current) inputRef.current.value = "";
        },
        replaceText: (value: string) => {
          if (inputRef.current) inputRef.current.value = value;
        },
      }));
      return (
        <input
          {...props}
          ref={inputRef}
          data-testid={testID}
          disabled={editable === false}
          onChange={(event) => onChangeText?.(event.currentTarget.value)}
          type={secureTextEntry ? "password" : "text"}
        />
      );
    },
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    loading,
    onPress,
    testID,
    ...props
  }: {
    children: React.ReactNode;
    loading?: boolean;
    onPress?: () => void;
    testID?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} data-testid={testID} disabled={props.disabled || loading} onClick={onPress}>
      {children}
    </button>
  ),
}));

const identity = {
  principalType: "human" as const,
  principalId: "usr_0123456789abcdef",
  organizationId: "org_0123456789abcdef",
  nodeId: "nod_0123456789abcdef",
  paseoServerId: "server-a",
  displayName: "Avery",
  grantVersion: "grant-v1",
  navigation: ["organization", "future_navigation", "identity"],
  allowedOperations: ["organization.resources.view", "future.operation"],
};

const baseResource = {
  resource: {
    organizationId: "org_0123456789abcdef",
    nodeId: "nod_0123456789abcdef",
    resourceKind: "agent" as const,
    localResourceId: "agt_0123456789abcdef",
  },
  label: "Agent one",
  allowedOperations: [],
};

type TestResourceStatus =
  | "ready"
  | "resource_waiting"
  | "login_required"
  | "mfa_required"
  | "risk_control"
  | "disabled";

function statusLabel(status: TestResourceStatus) {
  switch (status) {
    case "ready":
      return "Ready";
    case "resource_waiting":
      return "Waiting";
    case "login_required":
      return "Login required";
    case "mfa_required":
      return "MFA required";
    case "risk_control":
      return "Risk control";
    case "disabled":
      return "Disabled";
  }
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

describe("enterprise identity UI", () => {
  it("keeps legacy passthrough and fails closed for an unavailable enterprise capability", () => {
    act(() =>
      root.render(
        <EnterpriseCapabilityGate
          capability={{ enterpriseIdentityV1: false }}
          target="legacy_passthrough"
          legacyContent={<span>legacy</span>}
        >
          <span>enterprise</span>
        </EnterpriseCapabilityGate>,
      ),
    );
    expect(container.textContent).toBe("legacy");

    act(() =>
      root.render(
        <EnterpriseCapabilityGate
          capability={{ enterpriseIdentityV1: "yes", secret: "do-not-render" }}
          target="enterprise_host"
          legacyContent={<span>legacy</span>}
        >
          <span>enterprise</span>
        </EnterpriseCapabilityGate>,
      ),
    );
    expect(container.textContent).toContain("Enterprise sign-in unavailable");
    expect(container.textContent).not.toContain("do-not-render");

    act(() =>
      root.render(
        <EnterpriseCapabilityGate
          capability={{ enterpriseIdentityV1: true }}
          target="enterprise_host"
          legacyContent={<span>legacy</span>}
        >
          <span>enterprise</span>
        </EnterpriseCapabilityGate>,
      ),
    );
    expect(container.textContent).toBe("enterprise");

    act(() =>
      root.render(
        <EnterpriseCapabilityGate
          capability={null}
          target="enterprise_host"
          legacyContent={<span>legacy</span>}
        >
          <span>enterprise</span>
        </EnterpriseCapabilityGate>,
      ),
    );
    expect(container.textContent).not.toBe("legacy");
  });

  it("renders only the projected navigation and identity fields", () => {
    const onNavigate = vi.fn();
    act(() =>
      root.render(<EnterpriseIdentityNavigation projection={identity} onNavigate={onNavigate} />),
    );
    expect(container.textContent).toContain("Avery");
    expect(container.textContent).toContain("organization");
    expect(container.textContent).toContain("identity");
    expect(container.textContent).not.toContain("future_navigation");
    expect(container.textContent).not.toContain("future.operation");
    (container.querySelector('[data-testid="enterprise-nav-organization"]') as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledWith("organization");
    act(() =>
      root.render(
        <EnterpriseIdentityNavigation projection={{ ...identity, principalType: "future" }} />,
      ),
    );
    expect(container.textContent).toBe("");
  });

  it("shows only the safe queue position and stable reason copy", () => {
    act(() =>
      root.render(
        <EnterpriseResourceStatus
          projection={{
            ...baseResource,
            status: "resource_waiting",
            reasonCode: "capacity_wait",
            queue: {
              queuedAt: "2026-09-10T00:00:00.000Z",
              position: 2,
              holderPrincipalId: "secret",
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Position 2");
    expect(container.textContent).toContain("Waiting for resource capacity.");
    expect(container.textContent).not.toContain("capacity_wait");
    expect(container.textContent).not.toContain("secret");
  });

  it.each([
    "ready",
    "resource_waiting",
    "login_required",
    "mfa_required",
    "risk_control",
    "disabled",
  ] as const)("renders the controlled %s resource state without holder data", (status) => {
    act(() =>
      root.render(
        <EnterpriseResourceStatus
          projection={{
            ...baseResource,
            status,
            holderPrincipalId: "secret-holder",
            futureField: "secret-future",
          }}
        />,
      ),
    );
    expect(container.textContent).toContain(statusLabel(status));
    expect(container.textContent).not.toContain("secret-holder");
    expect(container.textContent).not.toContain("secret-future");
  });

  it("locks the PAT submit button while the model is pending and never renders the token", async () => {
    const model = createPatLoginFormModel();
    let resolve!: (value: { ok: true; value: string }) => void;
    const authenticated = vi.fn((value: string) => {
      expect(value).toBe("signed-in");
      expect(model.getSnapshot().hasToken).toBe(false);
      expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    });
    const authenticate = vi.fn(
      () => new Promise<{ ok: true; value: string }>((r) => (resolve = r)),
    );
    act(() =>
      root.render(
        <EnterprisePatLoginForm
          model={model}
          authenticate={authenticate}
          onAuthenticated={authenticated}
        />,
      ),
    );
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "pat-secret",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button =
      container.querySelector('[data-testid="enterprise-pat-submit"] button') ??
      container.querySelector('[data-testid="enterprise-pat-submit"]');
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLElement).click();
      (button as HTMLElement).click();
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("pat-secret");
    await act(async () => {
      resolve({ ok: true, value: "signed-in" });
      await Promise.resolve();
    });
    expect(model.getSnapshot()).toEqual({ status: "idle", hasToken: false, canSubmit: false });
    expect((input as HTMLInputElement).value).toBe("");
    expect(authenticated).toHaveBeenCalledOnce();
  });

  it("closes and aborts before invoking cancel, suppressing late auth", async () => {
    const model = createPatLoginFormModel();
    model.setToken("pat-secret");
    let resolve!: (value: { ok: true; value: string }) => void;
    let signal!: AbortSignal;
    const authenticated = vi.fn();
    const onCancel = vi.fn(() => {
      expect(signal.aborted).toBe(true);
      expect(model.getSnapshot()).toEqual({ status: "closed", hasToken: false, canSubmit: false });
      expect((container.querySelector("input") as HTMLInputElement).value).toBe("");
    });
    const authenticate = vi.fn((_token: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<{ ok: true; value: string }>((r) => (resolve = r));
    });
    act(() =>
      root.render(
        <EnterprisePatLoginForm
          model={model}
          authenticate={authenticate}
          onAuthenticated={authenticated}
          onCancel={onCancel}
        />,
      ),
    );
    await act(async () => {
      (container.querySelector('[data-testid="enterprise-pat-submit"]') as HTMLElement).click();
      await Promise.resolve();
    });
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "pat-secret";
    act(() =>
      (container.querySelector('[data-testid="enterprise-pat-cancel"]') as HTMLElement).click(),
    );
    expect(signal.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    await act(async () => {
      resolve({ ok: true, value: "late" });
      await Promise.resolve();
    });
    expect(authenticated).not.toHaveBeenCalled();
    expect(JSON.stringify(model.getSnapshot())).not.toContain("pat-secret");
  });

  it("closes and clears an in-flight form on unmount", async () => {
    const model = createPatLoginFormModel();
    model.setToken("pat-secret");
    let signal!: AbortSignal;
    const authenticate = vi.fn((_token: string, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return new Promise<{ ok: true; value: string }>(() => undefined);
    });
    act(() => root.render(<EnterprisePatLoginForm model={model} authenticate={authenticate} />));
    await act(async () => {
      (container.querySelector('[data-testid="enterprise-pat-submit"]') as HTMLElement).click();
      await Promise.resolve();
    });
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    expect(model.getSnapshot()).toEqual({ status: "closed", hasToken: false, canSubmit: false });
  });

  it("shows controlled failure copy and never leaks a reason canary", async () => {
    const model = createPatLoginFormModel();
    model.setToken("pat-secret");
    const authenticate = vi.fn(async () => ({ ok: false as const, reasonCode: "secret-canary" }));
    act(() => root.render(<EnterprisePatLoginForm model={model} authenticate={authenticate} />));
    await act(async () => {
      (container.querySelector('[data-testid="enterprise-pat-submit"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Enterprise sign-in is unavailable.");
    expect(container.textContent).not.toContain("secret-canary");
  });

  it("shows the fixed invalid-token copy", async () => {
    const model = createPatLoginFormModel();
    model.setToken("pat-secret");
    const authenticate = vi.fn(async () => ({
      ok: false as const,
      reasonCode: "identity.invalid_token",
    }));
    act(() => root.render(<EnterprisePatLoginForm model={model} authenticate={authenticate} />));
    await act(async () => {
      (container.querySelector('[data-testid="enterprise-pat-submit"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("The token was rejected.");
    expect(container.textContent).not.toContain("identity.invalid_token");
  });

  it("uses the first parsed identity snapshot even when a later proxy read changes", () => {
    let navigationReads = 0;
    const changing = new Proxy(identity, {
      get(target, property, receiver) {
        if (property === "navigation") {
          navigationReads += 1;
          if (navigationReads > 1) throw new Error("late projection read");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const onNavigate = vi.fn();
    act(() =>
      root.render(<EnterpriseIdentityNavigation projection={changing} onNavigate={onNavigate} />),
    );
    expect(container.textContent).toContain("organization");
    (container.querySelector('[data-testid="enterprise-nav-organization"]') as HTMLElement).click();
    expect(onNavigate).toHaveBeenCalledWith("organization");
  });

  it.each([
    { resource: { ...baseResource.resource, resourceKind: "unknown" }, status: "ready" },
    { ...baseResource, status: "unknown" },
    { ...baseResource, status: "resource_waiting", queue: { queuedAt: 42 } },
  ])("fails closed for malformed resource projections %#", (projection) => {
    act(() => root.render(<EnterpriseResourceStatus projection={projection} />));
    expect(container.textContent).toBe("");
  });
});
