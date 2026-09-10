import { describe, expect, test, vi } from "vitest";
import { createEnterpriseIdentityDispatcher } from "./handlers.js";
import type { EnterpriseDispatchContext } from "../../session/enterprise-dispatcher.js";

const context = {
  sessionId: "sess",
  clientId: "client",
  credentialId: "cred",
  sessionBindingGeneration: "gen",
  enterpriseContext: {
    principal: {
      organizationId: "org_aaaaaaaaaaaaaaaa",
      principalType: "human",
      principalId: "usr_aaaaaaaaaaaaaaaa",
      credentialId: "cred",
      grantVersion: "grant",
      grants: [],
    },
    node: { nodeId: "nod_aaaaaaaaaaaaaaaa", paseoServerId: "srv", mode: "standalone" },
    sessionBindingGeneration: "gen",
  },
} as EnterpriseDispatchContext;

describe("enterprise identity handlers", () => {
  test("returns canonical current identity", async () => {
    const dispatcher = createEnterpriseIdentityDispatcher({
      listPrincipals: vi.fn(async () => []),
      logoutAll: vi.fn(async () => false),
    });
    const result = await dispatcher.handle({
      sessionContext: context,
      message: { type: "enterprise.identity.get_current.request", requestId: "r1" },
    });
    expect(result).toMatchObject({ type: "enterprise.identity.get_current.response" });
  });

  test("delegates list and logout to W1 dependencies", async () => {
    const list = vi.fn(async () => []);
    const logout = vi.fn(async () => true);
    const dispatcher = createEnterpriseIdentityDispatcher({
      listPrincipals: list,
      logoutAll: logout,
    });
    await dispatcher.handle({
      sessionContext: context,
      message: { type: "enterprise.identity.list_principals.request", requestId: "r2" },
    });
    await dispatcher.handle({
      sessionContext: context,
      message: { type: "enterprise.identity.logout_all.request", requestId: "r3" },
    });
    expect(list).toHaveBeenCalledWith(context);
    expect(logout).toHaveBeenCalledWith(context);
  });
});
