import { describe, expect, it, vi } from "vitest";
import { type PrincipalScopeKey } from "./daemon-client.js";
import {
  createProcessCredentialVault,
  MemoryCredentialVault,
  MemoryEnterpriseIdentityLifecycle,
} from "./enterprise-identity-lifecycle.js";

const projection = {
  principalType: "human" as const,
  principalId: "usr_aaaaaaaaaaaaaaaa",
  organizationId: "org_aaaaaaaaaaaaaaaa",
  nodeId: "nod_aaaaaaaaaaaaaaaa",
  paseoServerId: "server-a",
  displayName: "Alice",
  grantVersion: "grant-v1",
  navigation: ["home"],
  allowedOperations: ["workspace.metadata.read"],
};
const scope: PrincipalScopeKey = {
  organizationId: projection.organizationId,
  nodeId: projection.nodeId,
  paseoServerId: projection.paseoServerId,
  principalId: projection.principalId,
};
const ports = () => {
  const events: string[] = [];
  return {
    events,
    teardown: {
      stopNetworkAndSubscriptions: async () => {
        events.push("stop");
      },
      disposeRuntimeAndCachePartition: async () => {
        events.push("dispose");
      },
      destroyDaemonClient: async () => {
        events.push("destroy");
      },
      startNewClient: async () => {
        events.push("start");
      },
      hydrateScope: async () => {
        events.push("hydrate");
      },
    },
    remoteLogout: {
      logoutAll: async () => {
        events.push("remoteLogout");
      },
    },
  };
};
const result = (teardownAttempt: () => Promise<void> = async () => {}) => ({
  projection,
  sessionBindingKey: "binding-a",
  teardownAttempt,
});

describe("enterprise identity lifecycle", () => {
  it("keeps process credential vault secrets non-enumerable and isolated", () => {
    const vault = createProcessCredentialVault();
    const handle = vault.put("server-a", "pat");
    expect(Object.keys(vault)).toEqual([]);
    expect(JSON.stringify(vault)).toBe("{}");
    expect(vault.read("server-a", handle)).toBe("pat");
    vault.delete("server-a", handle);
    expect(vault.read("server-a", handle)).toBeNull();
  });

  it("gates legacy and unavailable enterprise bootstrap and exposes a frozen projection", async () => {
    const p = ports();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    expect(
      (await lifecycle.bootstrap({ target: "legacy_passthrough", enterpriseIdentityV1: false }))
        .state,
    ).toBe("signed_out");
    expect(
      (await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: false })).state,
    ).toBe("unavailable");
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    const snapshot = await lifecycle.authenticateEnterpriseHost({
      serverId: "server-a",
      token: "pat",
    });
    expect(snapshot.state).toBe("signed_in");
    expect(snapshot.scope).toEqual(scope);
    expect(JSON.stringify(snapshot)).not.toContain("pat");
    expect(Object.isFrozen(snapshot.projection)).toBe(true);
    expect(Object.isFrozen(snapshot.projection?.navigation)).toBe(true);
  });

  it("owns authenticated file requests and rejects revoke or generation races", async () => {
    const p = ports();
    const vault = new MemoryCredentialVault();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      vault,
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    const signedIn = await lifecycle.authenticateEnterpriseHost({
      serverId: "server-a",
      token: "pat",
    });
    const transport = {
      request: vi.fn(
        async (input: { authorization: string }) =>
          new Response(input.authorization, { status: 200 }),
      ),
    };
    const request = lifecycle.createEnterpriseFileRequest({
      serverId: "server-a",
      transport,
    });
    const response = await request({
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "src/main.ts",
      scopeGeneration: signedIn.generation!,
    });
    expect(await response.text()).toBe("Bearer pat");
    expect(transport.request).toHaveBeenCalledTimes(1);

    await lifecycle.credentialRevoked({
      serverId: "server-a",
      generation: signedIn.generation!,
      sessionBindingKey: signedIn.sessionBindingKey!,
    });
    await expect(
      request({
        serverId: "server-a",
        workspaceId: "wks_aaaaaaaaaaaaaaaa",
        relativePath: "src/main.ts",
        scopeGeneration: signedIn.generation!,
      }),
    ).rejects.toThrow("no longer current");
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that arrives after the lifecycle generation changes", async () => {
    const p = ports();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    const signedIn = await lifecycle.authenticateEnterpriseHost({
      serverId: "server-a",
      token: "pat",
    });
    let resolveTransport!: (response: Response) => void;
    const transport = {
      request: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveTransport = resolve;
          }),
      ),
    };
    const request = lifecycle.createEnterpriseFileRequest({ serverId: "server-a", transport });
    const pending = request({
      serverId: "server-a",
      workspaceId: "wks_aaaaaaaaaaaaaaaa",
      relativePath: "src/main.ts",
      scopeGeneration: signedIn.generation!,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await lifecycle.credentialRevoked({
      serverId: "server-a",
      generation: signedIn.generation!,
      sessionBindingKey: signedIn.sessionBindingKey!,
    });
    resolveTransport(new Response("late", { status: 200 }));
    await expect(pending).rejects.toThrow("no longer current");
  });

  it("runs replacement teardown before auth and compensates late abort exactly once", async () => {
    const p = ports();
    let resolveAuth!: (r: ReturnType<typeof result>) => void;
    let compensations = 0;
    const remote = new Promise<ReturnType<typeof result>>((resolve) => {
      resolveAuth = resolve;
    });
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => remote,
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    const auth = lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const logout = lifecycle.logoutCurrent("server-a");
    resolveAuth(
      result(async () => {
        compensations++;
      }),
    );
    await expect(auth).rejects.toThrow("Aborted");
    await logout;
    expect(compensations).toBe(1);
    expect(p.events.slice(0, 3)).toEqual(["stop", "dispose", "destroy"]);
  });

  it("runs all teardown stages and fails closed", async () => {
    const calls: string[] = [];
    const teardown = {
      stopNetworkAndSubscriptions: async () => {
        calls.push("stop");
        throw new Error("stop");
      },
      disposeRuntimeAndCachePartition: async () => {
        calls.push("dispose");
        throw new Error("dispose");
      },
      destroyDaemonClient: async () => {
        calls.push("destroy");
        throw new Error("destroy");
      },
      startNewClient: async () => {
        calls.push("start");
      },
      hydrateScope: async () => {
        calls.push("hydrate");
      },
    };
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      teardown,
      { logoutAll: async () => {} },
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await expect(
      lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" }),
    ).rejects.toThrow("teardown failed");
    expect(calls).toEqual(["stop", "dispose", "destroy"]);
    expect(lifecycle.readSnapshot().state).toBe("unavailable");
  });

  it("keeps signed in on remote logout-all failure and refreshes same principal scope", async () => {
    const p = ports();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      p.teardown,
      {
        logoutAll: async () => {
          throw new Error("remote");
        },
      },
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    await expect(lifecycle.logoutAll()).rejects.toThrow("remote");
    expect(lifecycle.readSnapshot().state).toBe("signed_in");
    const current = lifecycle.readSnapshot();
    await lifecycle.scopeRefreshed({
      serverId: "server-a",
      generation: current.generation!,
      sessionBindingKey: current.sessionBindingKey!,
      projection: { ...projection, grantVersion: "grant-v2" },
    });
    expect(lifecycle.readSnapshot().state).toBe("signed_in");
    expect(lifecycle.readSnapshot().sessionBindingKey).toBe("binding-a");
  });

  it("rejects wrong server and isolates listener failures", async () => {
    const p = ports();
    let compensated = 0;
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => ({
        ...result(async () => {
          compensated++;
        }),
        projection: { ...projection, paseoServerId: "server-b" },
      }),
      p.teardown,
      p.remoteLogout,
    );
    lifecycle.subscribe(() => {
      throw new Error("listener");
    });
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await expect(
      lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" }),
    ).rejects.toThrow();
    expect(compensated).toBe(1);
    expect(lifecycle.readSnapshot().state).toBe("unavailable");
  });

  it("rejects pre-aborted auth without touching the signed-in session", async () => {
    const p = ports();
    let calls = 0;
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => {
        calls++;
        return result();
      },
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    const before = lifecycle.readSnapshot();
    const signal = AbortSignal.abort();
    await expect(
      lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "new", signal }),
    ).rejects.toThrow("Aborted");
    expect(calls).toBe(1);
    expect(lifecycle.readSnapshot()).toEqual(before);
  });

  it("ignores a wrong-server revoke while another authentication is pending", async () => {
    const p = ports();
    let resolveAuth!: (value: ReturnType<typeof result>) => void;
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    const auth = lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await lifecycle.credentialRevoked({
      serverId: "server-b",
      generation: "old" as never,
      sessionBindingKey: "old",
    });
    resolveAuth(result());
    await auth;
    expect(lifecycle.readSnapshot().state).toBe("signed_in");
  });

  it("snapshots correlated events before a blocked transition and rejects stale binding", async () => {
    const p = ports();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    const current = lifecycle.readSnapshot();
    const event = {
      serverId: "server-a",
      generation: current.generation!,
      sessionBindingKey: current.sessionBindingKey!,
      projection,
    };
    const promise = lifecycle.scopeRefreshed(event);
    event.serverId = "server-b";
    event.sessionBindingKey = "mutated";
    await promise;
    expect(lifecycle.readSnapshot().state).toBe("signed_in");
  });

  it("fails closed when refresh credential read throws", async () => {
    const p = ports();
    const vault = new MemoryCredentialVault();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      vault,
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    vault.read = () => {
      throw new Error("read");
    };
    const current = lifecycle.readSnapshot();
    await lifecycle.scopeRefreshed({
      serverId: "server-a",
      generation: current.generation!,
      sessionBindingKey: current.sessionBindingKey!,
      projection,
    });
    expect(lifecycle.readSnapshot().state).toBe("unavailable");
  });

  it.each(["malformed", "blank-binding", "throwing-projection"])(
    "compensates %s auth result exactly once",
    async (kind) => {
      const p = ports();
      let compensated = 0;
      let raw: ReturnType<typeof result>;
      if (kind === "blank-binding") {
        raw = {
          ...result(async () => {
            compensated++;
          }),
          sessionBindingKey: "",
        };
      } else if (kind === "throwing-projection") {
        raw = {
          sessionBindingKey: "binding",
          teardownAttempt: async () => {
            compensated++;
          },
          get projection() {
            throw new Error("projection");
          },
        } as unknown as ReturnType<typeof result>;
      } else {
        raw = {
          ...result(async () => {
            compensated++;
          }),
          projection: { ...projection, principalId: "bad" },
        };
      }
      const lifecycle = new MemoryEnterpriseIdentityLifecycle(
        new MemoryCredentialVault(),
        async () => raw,
        p.teardown,
        p.remoteLogout,
      );
      await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
      await expect(
        lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" }),
      ).rejects.toThrow();
      expect(compensated).toBe(1);
    },
  );

  it("compensates malformed refresh result exactly once", async () => {
    const p = ports();
    let calls = 0;
    let compensated = 0;
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => {
        calls++;
        return calls === 1
          ? result()
          : {
              ...result(async () => {
                compensated++;
              }),
              sessionBindingKey: "",
              projection,
            };
      },
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    const current = lifecycle.readSnapshot();
    await expect(
      lifecycle.scopeRefreshed({
        serverId: "server-a",
        generation: current.generation!,
        sessionBindingKey: current.sessionBindingKey!,
        projection: { ...projection, grantVersion: "grant-v2" },
      }),
    ).rejects.toThrow();
    expect(compensated).toBe(1);
  });

  it("reads a changing teardownAttempt getter exactly once", async () => {
    const p = ports();
    let reads = 0;
    let compensated = 0;
    const raw = {
      projection,
      sessionBindingKey: "binding-a",
      get teardownAttempt() {
        reads++;
        return async () => {
          compensated++;
        };
      },
    } as unknown as ReturnType<typeof result>;
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => raw,
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    expect(reads).toBe(1);
    expect(compensated).toBe(0);
  });

  it.each(["put", "start", "hydrate"])(
    "compensates authentication when %s fails",
    async (stage) => {
      const p = ports();
      const vault = new MemoryCredentialVault();
      const originalPut = vault.put.bind(vault);
      if (stage === "put")
        vault.put = () => {
          throw new Error("put");
        };
      if (stage === "start")
        p.teardown.startNewClient = async () => {
          throw new Error("start");
        };
      if (stage === "hydrate")
        p.teardown.hydrateScope = async () => {
          throw new Error("hydrate");
        };
      let compensated = 0;
      const lifecycle = new MemoryEnterpriseIdentityLifecycle(
        vault,
        async () =>
          result(async () => {
            compensated++;
          }),
        p.teardown,
        p.remoteLogout,
      );
      await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
      await expect(
        lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" }),
      ).rejects.toThrow();
      expect(compensated).toBe(1);
      if (stage === "put") vault.put = originalPut;
      expect(lifecycle.readSnapshot().state).toBe("unavailable");
    },
  );

  it("does not reuse a credential across a cross-principal refresh and completes logout-all locally", async () => {
    const p = ports();
    const lifecycle = new MemoryEnterpriseIdentityLifecycle(
      new MemoryCredentialVault(),
      async () => result(),
      p.teardown,
      p.remoteLogout,
    );
    await lifecycle.bootstrap({ target: "enterprise_host", enterpriseIdentityV1: true });
    await lifecycle.authenticateEnterpriseHost({ serverId: "server-a", token: "pat" });
    const current = lifecycle.readSnapshot();
    await lifecycle.scopeRefreshed({
      serverId: "server-a",
      generation: current.generation!,
      sessionBindingKey: current.sessionBindingKey!,
      projection: { ...projection, principalId: "usr_bbbbbbbbbbbbbbbb" },
    });
    expect(lifecycle.readSnapshot().state).toBe("unavailable");
    expect(lifecycle.readSnapshot().scope).toBeUndefined();
  });
});
