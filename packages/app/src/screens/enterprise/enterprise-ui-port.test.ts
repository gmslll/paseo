import { describe, expect, it } from "vitest";
import { createEnterpriseUiBundle, type EnterpriseUiBundleOptions } from "./enterprise-ui-port";
import type {
  EnterpriseIdentityLifecycle,
  EnterpriseIdentitySnapshot,
} from "@getpaseo/client/internal/enterprise-identity-lifecycle";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const generation = "generation-1";
const signedOut: EnterpriseIdentitySnapshot = Object.freeze({
  state: "signed_out",
  target: "enterprise_host",
});

function makeLifecycle(): {
  lifecycle: EnterpriseIdentityLifecycle;
  calls: string[];
  setSnapshot: (next: EnterpriseIdentitySnapshot) => void;
} {
  let snapshot: EnterpriseIdentitySnapshot = signedOut;
  const listeners = new Set<(value: EnterpriseIdentitySnapshot) => void>();
  const calls: string[] = [];
  const lifecycle = {
    bootstrap: async () => snapshot,
    readSnapshot: () => snapshot,
    subscribe: (listener: (value: EnterpriseIdentitySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    authenticateEnterpriseHost: async ({ token }: { token: string }) => {
      calls.push(`authenticate:${token}`);
      snapshot = Object.freeze({
        state: "signed_in" as const,
        target: "enterprise_host" as const,
        generation: generation as never,
        sessionBindingKey: "binding-1",
        projection: { paseoServerId: "server-a" } as never,
      });
      for (const listener of listeners) listener(snapshot);
      return snapshot;
    },
    logoutCurrent: async (serverId: string) => {
      calls.push(`logoutCurrent:${serverId}`);
    },
    logoutEnterpriseHost: async () => undefined,
    logoutAll: async () => {
      calls.push("logoutAll");
    },
    credentialRevoked: async () => undefined,
    principalChanged: async () => undefined,
    scopeRefreshed: async () => {
      calls.push("scopeRefreshed");
    },
    createEnterpriseFileRequest: () => {
      throw new Error("not used by W6 UI adapter");
    },
  } as unknown as EnterpriseIdentityLifecycle;
  return {
    lifecycle,
    calls,
    setSnapshot: (next) => {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
  };
}

function makeOptions(
  lifecycle: EnterpriseIdentityLifecycle,
  requestEnterprise: DaemonClient["requestEnterprise"],
): EnterpriseUiBundleOptions<string, unknown> {
  return {
    lifecycle,
    daemonClient: { requestEnterprise } as DaemonClient,
    serverId: "server-a",
    contentReaders: {
      workspace: async (input) => ({
        requestId: input.requestId,
        resource: input.resource,
        content: null,
      }),
      agent: async (input) => ({
        requestId: input.requestId,
        resource: input.resource,
        content: null,
      }),
      browserProfile: async (input) => ({
        requestId: input.requestId,
        resource: input.resource,
        content: null,
      }),
      appSlot: async (input) => ({
        requestId: input.requestId,
        resource: input.resource,
        content: null,
      }),
    },
  };
}

describe("createEnterpriseUiBundle", () => {
  it("routes PAT only to lifecycle and exposes logout without retaining token", async () => {
    const { lifecycle, calls } = makeLifecycle();
    const bundle = createEnterpriseUiBundle(makeOptions(lifecycle, async () => ({}) as never));
    const result = await bundle.uiPort.authenticatePat({
      serverId: "server-a",
      token: "pat-secret-canary",
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    await bundle.uiPort.logoutCurrent();
    await bundle.uiPort.logoutAll();
    expect(calls).toEqual([
      "authenticate:pat-secret-canary",
      "logoutCurrent:server-a",
      "logoutAll",
    ]);
    expect(JSON.stringify(bundle)).not.toContain("pat-secret-canary");
  });

  it("gates RPC ports on the current lifecycle generation and sends typed enterprise requests", async () => {
    const { lifecycle } = makeLifecycle();
    const requests: Array<{ type: string; payload: Readonly<Record<string, unknown>> }> = [];
    const bundle = createEnterpriseUiBundle(
      makeOptions(lifecycle, async (type, payload) => {
        requests.push({ type, payload: payload ?? {} });
        return {};
      }),
    );
    await bundle.uiPort.authenticatePat({
      serverId: "server-a",
      token: "opaque",
      signal: new AbortController().signal,
    });
    const response = await bundle.resourcePort.listOrganizationResources({
      requestId: "request-1",
      sessionGeneration: generation,
      signal: new AbortController().signal,
    });
    expect(response).toEqual({});
    expect(requests[0]).toEqual({
      type: "enterprise.organization.list_resources.request",
      payload: { requestId: "request-1" },
    });
    await expect(bundle.uiPort.refreshScope(generation)).rejects.toThrow(
      "identity.invalid_response",
    );
    await expect(
      bundle.browserPort.listProfiles({
        workspaceId: "workspace-1",
        requestId: "request-2",
        sessionGeneration: "other",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("identity.generation_changed");
  });

  it("fails closed when browser capability or hydration seam is absent", async () => {
    const { lifecycle } = makeLifecycle();
    const calls: unknown[] = [];
    const bundle = createEnterpriseUiBundle({
      ...makeOptions(lifecycle, async (...args) => {
        calls.push(args);
        return {};
      }),
      browserProfilesEnabled: (() => undefined) as unknown as () => boolean,
    });
    await bundle.uiPort.authenticatePat({
      serverId: "server-a",
      token: "opaque",
      signal: new AbortController().signal,
    });
    await expect(
      bundle.browserPort.listProfiles({
        workspaceId: "workspace-1",
        requestId: "request-3",
        sessionGeneration: generation,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("feature_unavailable");
    expect(calls).toHaveLength(0);
  });
});
